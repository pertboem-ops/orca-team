import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isJunkUntrackedFile, writeAtomicJsonFile } from './facts-snapshot.mjs';
import {
  captureSensitiveFingerprints,
  diffFingerprints,
  execGitSafe,
  inspectGitWorkspace,
  quarantineAndNeutralizeExecutableTamper,
  restoreSensitiveBaseline
} from './git-safe.mjs';

export class TeamIsolationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TeamIsolationError';
    this.code = code;
    this.details = details;
  }
}

export function getTeamPaths(workspaceRoot) {
  const root = resolve(workspaceRoot);
  const teamDir = join(root, '.team');
  return {
    workspaceRoot: root,
    teamDir,
    eventsPath: join(teamDir, 'events.jsonl'),
    statePath: join(teamDir, 'state.json'),
    leasePath: join(teamDir, 'lease.json'),
    baselinesDir: join(teamDir, 'baselines'),
    reportsDir: join(teamDir, 'reports'),
    referencesDir: join(teamDir, 'references'),
    workflowInputsDir: join(teamDir, 'workflow-inputs')
  };
}

export function ensureTeamDirs(workspaceRoot) {
  const paths = getTeamPaths(workspaceRoot);
  mkdirSync(paths.teamDir, { recursive: true });
  mkdirSync(paths.baselinesDir, { recursive: true });
  mkdirSync(paths.reportsDir, { recursive: true });
  mkdirSync(paths.referencesDir, { recursive: true });
  mkdirSync(paths.workflowInputsDir, { recursive: true });
  return paths;
}

export function readWorkspaceLease(workspaceRoot) {
  const { leasePath } = getTeamPaths(workspaceRoot);
  if (!existsSync(leasePath)) return null;
  try {
    return JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeWorkspaceLease(workspaceRoot, leaseObj) {
  const { leasePath } = ensureTeamDirs(workspaceRoot);
  writeAtomicJsonFile(leasePath, leaseObj);
}

export function clearWorkspaceLease(workspaceRoot, expectedTaskId = null) {
  const { leasePath } = getTeamPaths(workspaceRoot);
  if (!existsSync(leasePath)) return;
  if (expectedTaskId) {
    const curr = readWorkspaceLease(workspaceRoot);
    if (curr && curr.taskId && curr.taskId !== expectedTaskId) {
      return;
    }
  }
  try {
    rmSync(leasePath, { force: true });
  } catch {}
}

export function saveBaselineSnapshot(workspaceRoot, taskId, snapshotData) {
  const { baselinesDir } = ensureTeamDirs(workspaceRoot);
  writeAtomicJsonFile(join(baselinesDir, `${taskId}.json`), snapshotData);
}

export function loadBaselineSnapshot(workspaceRoot, taskId) {
  const { baselinesDir } = getTeamPaths(workspaceRoot);
  const filePath = join(baselinesDir, `${taskId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function branchExistsLocally(gitRoot, branchName, signal) {
  if (!branchName) return false;
  const res = await execGitSafe(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
    cwd: gitRoot,
    signal
  });
  return res.exitCode === 0;
}

/**
 * Acquire Main-Worktree Exclusive Lease for ANY task (write or readonly):
 * 1. Rejects if another active task holds `.team/lease.json` (`TEAM_WORKSPACE_BUSY`)
 * 2. Captures raw SHA-256 sensitive file fingerprints BEFORE running any `git` command
 * 3. Verifies working tree is clean (`TEAM_DIRTY_WORKING_TREE`)
 * 4. Checks out `team/<taskId>` (write), `reuseTask.branch` (write reuse), or `targetTask.branch` (review)
 */
export async function prepareWorkspaceAndAcquireLease({
  workspaceRoot,
  taskId,
  attempt = 1,
  roleId,
  mode,
  targetTask = null,
  reuseTask = null,
  signal
}) {
  const existingLease = readWorkspaceLease(workspaceRoot);
  if (existingLease && existingLease.taskId && existingLease.taskId !== taskId) {
    throw new TeamIsolationError(
      'TEAM_WORKSPACE_BUSY',
      `主工作树独占租约正被在途任务 "${existingLease.taskId}" (role=${existingLease.roleId}, branch=${existingLease.checkedOutBranch}) 持有。请先等待其进入 REPORTED，或调用 team_board / team_interrupt 处理。`,
      { activeLease: existingLease }
    );
  }

  // Step 1: Capture sensitive raw SHA-256 fingerprints BEFORE invoking any `git` command!
  const baselineFingerprints = captureSensitiveFingerprints(workspaceRoot, { includeBackup: true });

  // Step 2: Inspect Git state via hardened `execGitSafe` (`-c core.hooksPath= -c core.fsmonitor=false`)
  const gitState = await inspectGitWorkspace(workspaceRoot, { includeIgnored: true, signal });
  if (!gitState.isGitRepo || !gitState.gitRoot || !gitState.hasHeadCommit) {
    throw new TeamIsolationError(
      'TEAM_NOT_GIT_REPO',
      `工作区 "${workspaceRoot}" 不是包含有效初始提交 (HEAD) 的 Git 仓库，无法建立受控分支保护。`
    );
  }

  const dirtyFiles = [...gitState.status.trackedModified, ...gitState.status.untracked];
  if (dirtyFiles.length > 0) {
    throw new TeamIsolationError(
      'TEAM_DIRTY_WORKING_TREE',
      `委派前工作树存在未提交改动或未跟踪文件（共 ${dirtyFiles.length} 个），网关拒绝切分支以防污染用户现场：${dirtyFiles.slice(0, 15).join(', ')}`,
      { dirtyFiles }
    );
  }

  const gitRoot = gitState.gitRoot;
  let baseBranch = gitState.currentBranch;
  let baseSha = gitState.headSha;
  let taskBranch = null;
  let checkedOutBranch = baseBranch;
  let reusedExistingBranch = false;

  if (mode === 'write') {
    if (reuseTask) {
      if (!reuseTask.branch || !(await branchExistsLocally(gitRoot, reuseTask.branch, signal))) {
        throw new TeamIsolationError(
          'TEAM_REUSE_BRANCH_MISSING',
          `无法复用任务 "${reuseTask.taskId}" 的分支 "${reuseTask.branch || ''}"：本地分支不存在。`
        );
      }
      baseBranch = reuseTask.baseBranch || baseBranch;
      baseSha = reuseTask.baseSha || baseSha;
      taskBranch = reuseTask.branch;
      checkedOutBranch = taskBranch;
      reusedExistingBranch = true;
      const coRes = await execGitSafe(['checkout', taskBranch], { cwd: gitRoot, signal });
      if (coRes.exitCode !== 0) {
        throw new TeamIsolationError('TEAM_GIT_CHECKOUT_FAILED', `切换到复用分支 ${taskBranch} 失败：${coRes.stderr}`);
      }
    } else {
      taskBranch = `team/${taskId}`;
      const existsAlready = await branchExistsLocally(gitRoot, taskBranch, signal);
      const coArgs = existsAlready ? ['checkout', taskBranch] : ['checkout', '-b', taskBranch];
      const coRes = await execGitSafe(coArgs, { cwd: gitRoot, signal });
      if (coRes.exitCode !== 0) {
        throw new TeamIsolationError('TEAM_GIT_CHECKOUT_FAILED', `创建/切换任务分支 ${taskBranch} 失败：${coRes.stderr}`);
      }
      checkedOutBranch = taskBranch;
    }
  } else {
    // Readonly role (`architect` / `reviewer`)
    if (targetTask?.branch && (await branchExistsLocally(gitRoot, targetTask.branch, signal))) {
      const coRes = await execGitSafe(['checkout', targetTask.branch], { cwd: gitRoot, signal });
      if (coRes.exitCode === 0) {
        checkedOutBranch = targetTask.branch;
      }
    }
  }

  const checkedOutHeadRes = await execGitSafe(['rev-parse', 'HEAD'], { cwd: gitRoot, signal });
  const checkedOutSha = checkedOutHeadRes.stdout || baseSha;

  // Root Baseline Fingerprint Inheritance (Red-Team `锋` R2 Deep Fix):
  // Never overwrite `rootFingerprints` with post-checkout dirty/tampered branch state when reusing a branch!
  // Always inherit the clean `baseBranch` root snapshot from the root task of the branch lineage.
  const rootBaselineTaskId = reuseTask
    ? reuseTask.rootBaselineTaskId || reuseTask.taskId
    : targetTask && mode !== 'write'
      ? targetTask.rootBaselineTaskId || targetTask.taskId
      : taskId;
  const inheritedRootRecord =
    rootBaselineTaskId !== taskId ? loadBaselineSnapshot(workspaceRoot, rootBaselineTaskId) : null;
  const rootFingerprints =
    inheritedRootRecord?.rootFingerprints ||
    inheritedRootRecord?.preCheckoutFingerprints ||
    baselineFingerprints;

  const postCheckoutFingerprints = captureSensitiveFingerprints(gitRoot, { includeBackup: true });

  const baselineRecord = {
    taskId,
    rootBaselineTaskId,
    attempt,
    capturedAt: new Date().toISOString(),
    gitRoot,
    baseBranch,
    baseSha,
    taskBranch,
    checkedOutBranch,
    checkedOutSha,
    reusedExistingBranch,
    baselineIgnored: inheritedRootRecord?.baselineIgnored || gitState.status.ignored,
    rootFingerprints,
    baselineFingerprints: mode === 'write' ? rootFingerprints : postCheckoutFingerprints,
    preCheckoutFingerprints: baselineFingerprints
  };
  saveBaselineSnapshot(workspaceRoot, taskId, baselineRecord);

  const leaseObj = {
    taskId,
    rootBaselineTaskId,
    attempt,
    roleId,
    mode,
    gitRoot,
    baseBranch,
    baseSha,
    taskBranch,
    checkedOutBranch,
    checkedOutSha,
    acquiredAt: new Date().toISOString()
  };
  writeWorkspaceLease(workspaceRoot, leaseObj);

  return {
    gitRoot,
    rootBaselineTaskId,
    baseBranch,
    baseSha,
    branch: taskBranch,
    checkedOutBranch,
    checkedOutSha,
    reusedExistingBranch,
    lease: leaseObj
  };
}

/**
 * Re-acquire the Main-Worktree Exclusive Lease and check out `team/<taskId>` for cold-start `team_steer`.
 */
export async function reacquireLeaseForSteer({ workspaceRoot, task, nextAttempt, signal }) {
  if (task.hasUnmergeableExecutableTamper) {
    throw new TeamIsolationError(
      'TEAM_EXECUTABLE_TAMPER_UNMERGEABLE',
      `任务 "${task.taskId}" 前序回合曾篡改可执行级 Git 配置/钩子/过滤规则并已被隔离封存，严禁继续 steer 或 merge，请调用 team_merge(action="discard") 清理分支。`,
      { taskId: task.taskId }
    );
  }

  const existingLease = readWorkspaceLease(workspaceRoot);
  if (existingLease && existingLease.taskId && existingLease.taskId !== task.taskId) {
    throw new TeamIsolationError(
      'TEAM_WORKSPACE_BUSY',
      `主工作树独占租约正被任务 "${existingLease.taskId}" 持有，暂时无法对 "${task.taskId}" 执行 team_steer。`,
      { activeLease: existingLease }
    );
  }

  // Pre-Git fingerprint check against original root baseline
  const prevBaseline = loadBaselineSnapshot(workspaceRoot, task.taskId);
  const rootSnap =
    prevBaseline?.rootFingerprints ||
    prevBaseline?.preCheckoutFingerprints ||
    prevBaseline?.baselineFingerprints ||
    null;
  const preSteerFp = captureSensitiveFingerprints(workspaceRoot, { includeBackup: true });
  if (rootSnap) {
    const gitTamperCheck = diffFingerprints(rootSnap, preSteerFp);
    if (gitTamperCheck.hasExecutableTamper) {
      const quarantined = quarantineAndNeutralizeExecutableTamper(workspaceRoot, rootSnap);
      throw new TeamIsolationError(
        'TEAM_EXECUTABLE_TAMPER_UNMERGEABLE',
        `检测到仓库可执行级配置/钩子在 steer 前处于被篡改状态（已自动隔离还原）：${gitTamperCheck.changed.map((c) => c.displayPath).join(', ')}`,
        { tampered: gitTamperCheck.changed, quarantined }
      );
    }
  }

  const gitState = await inspectGitWorkspace(workspaceRoot, { includeIgnored: true, signal });
  if (!gitState.isGitRepo || !gitState.gitRoot) {
    throw new TeamIsolationError('TEAM_NOT_GIT_REPO', `工作区 "${workspaceRoot}" 不是有效的 Git 仓库。`);
  }

  const dirtyFiles = [...gitState.status.trackedModified, ...gitState.status.untracked];
  if (dirtyFiles.length > 0) {
    throw new TeamIsolationError(
      'TEAM_DIRTY_WORKING_TREE',
      `执行 team_steer 前工作树存在未提交脏文件：${dirtyFiles.slice(0, 15).join(', ')}`,
      { dirtyFiles }
    );
  }

  const gitRoot = gitState.gitRoot;
  let checkedOutBranch = gitState.currentBranch;
  if (task.branch && (await branchExistsLocally(gitRoot, task.branch, signal))) {
    const coRes = await execGitSafe(['checkout', task.branch], { cwd: gitRoot, signal });
    if (coRes.exitCode !== 0) {
      throw new TeamIsolationError('TEAM_GIT_CHECKOUT_FAILED', `检出分支 ${task.branch} 失败：${coRes.stderr}`);
    }
    checkedOutBranch = task.branch;
  }

  const checkedOutHeadRes = await execGitSafe(['rev-parse', 'HEAD'], { cwd: gitRoot, signal });
  const checkedOutSha = checkedOutHeadRes.stdout || task.headSha || task.baseSha;

  // Keep the ORIGINAL `rootFingerprints` from clean `baseBranch` so tampering in earlier attempts is never whitewashed!
  const preservedRoot = rootSnap || preSteerFp;
  const updatedBaseline = {
    taskId: task.taskId,
    rootBaselineTaskId: task.rootBaselineTaskId || prevBaseline?.rootBaselineTaskId || task.taskId,
    attempt: nextAttempt,
    capturedAt: new Date().toISOString(),
    gitRoot,
    baseBranch: task.baseBranch || gitState.currentBranch,
    baseSha: task.baseSha,
    taskBranch: task.branch,
    checkedOutBranch,
    checkedOutSha,
    reusedExistingBranch: Boolean(task.reusedExistingBranch),
    baselineIgnored: prevBaseline?.baselineIgnored || gitState.status.ignored,
    rootFingerprints: preservedRoot,
    baselineFingerprints: preservedRoot,
    preCheckoutFingerprints: prevBaseline?.preCheckoutFingerprints || preSteerFp
  };
  saveBaselineSnapshot(workspaceRoot, task.taskId, updatedBaseline);

  const leaseObj = {
    taskId: task.taskId,
    attempt: nextAttempt,
    roleId: task.role,
    mode: task.mode,
    gitRoot,
    baseBranch: updatedBaseline.baseBranch,
    baseSha: task.baseSha,
    taskBranch: task.branch,
    checkedOutBranch,
    checkedOutSha,
    acquiredAt: new Date().toISOString()
  };
  writeWorkspaceLease(workspaceRoot, leaseObj);

  return { checkedOutBranch, checkedOutSha, lease: leaseObj };
}

/**
 * Atomic `REPORTED` Settlement & Return-to-Base Protocol:
 * 1. BEFORE ANY GIT CALL: verify raw SHA-256 sensitive file fingerprints!
 * 2. For write tasks: snapshot uncommitted changes onto `team/<taskId>` (excluding `.team/`, `.cabinet/`),
 *    compute `changedFiles` & `diffStat` vs `baseSha`, switch back to `baseBranch`, release lease.
 * 3. For readonly tasks: detect any dirty files (`READONLY_ROLE_DIRTIED_TREE`), restore clean `checkedOutSha`,
 *    switch back to `baseBranch`, release lease.
 */
export async function settleWorkspaceAndReleaseLease({
  workspaceRoot,
  task,
  targetTaskForReview = null,
  signal
}) {
  const baseline = loadBaselineSnapshot(workspaceRoot, task.taskId);
  const rootSnap =
    baseline?.rootFingerprints ||
    baseline?.preCheckoutFingerprints ||
    baseline?.baselineFingerprints ||
    null;

  // Step 1: Pure Node raw SHA-256 fingerprint check BEFORE running any `git` command!
  const postFingerprints = captureSensitiveFingerprints(workspaceRoot, { includeBackup: false });
  const fpDiff = rootSnap
    ? diffFingerprints(rootSnap, postFingerprints)
    : {
        ok: true,
        changed: [],
        hasGitInternalTamper: false,
        hasGitFilterAttrTamper: false,
        hasIdeAutorunTamper: false,
        hasEnvOrRcTamper: false,
        hasExecutableTamper: false
      };

  // Step 1B: Immediate Pre-Git Quarantine & Neutralization (Red-Team `锋` R2 Deep Fix):
  // Neutralize `.git/config` (`core.fsmonitor`), `.git/hooks/**`, `.gitattributes` (`filter.*`),
  // and `.vscode/tasks.json` (`folderOpen` autorun) BEFORE any `git` command or background IDE poll!
  let quarantinedExecutableTamper = null;
  if (fpDiff.hasExecutableTamper && rootSnap) {
    quarantinedExecutableTamper = quarantineAndNeutralizeExecutableTamper(workspaceRoot, rootSnap);
  }

  const gitState = await inspectGitWorkspace(workspaceRoot, { includeIgnored: true, signal });
  if (!gitState.isGitRepo || !gitState.gitRoot) {
    clearWorkspaceLease(workspaceRoot, task.taskId);
    return {
      fpDiff,
      quarantinedExecutableTamper,
      gatewaySnapshot: null,
      changedFiles: [],
      diffStat: '',
      untrackedFiles: [],
      ignoredArtifacts: [],
      readonlyDirtiedFiles: [],
      readonlyDirtyPatch: '',
      reviewedTarget: null,
      headSha: task.headSha || task.baseSha || null
    };
  }

  const gitRoot = gitState.gitRoot;
  const baselineIgnoredSet = new Set(baseline?.baselineIgnored || []);
  const ignoredArtifacts = gitState.status.ignored.filter((p) => !baselineIgnoredSet.has(p));
  const baseBranch = task.baseBranch || baseline?.baseBranch || 'main';
  const baseSha = task.baseSha || baseline?.baseSha || gitState.headSha;
  const checkedOutSha = baseline?.checkedOutSha || baseSha;

  if (task.mode === 'write' && task.branch) {
    const workerAlreadyCommitted = gitState.headSha !== checkedOutSha;

    // Detect untracked junk/leftover artifacts BEFORE gateway snapshot commit:
    // - Always flag junk extensions (`.tmp`, `.bak`, `.log`, etc.)
    // - Also flag any untracked `??` files left behind AFTER the worker already made its own commit(s)
    const untrackedFiles = gitState.status.untracked.filter(
      (p) => isJunkUntrackedFile(p) || workerAlreadyCommitted
    );

    let autoCommitted = false;
    let autoCommittedFiles = [];

    // Stage and commit any uncommitted work onto `team/<taskId>` (never `.team` or `.cabinet`)
    if (gitState.status.trackedModified.length > 0 || gitState.status.untracked.length > 0) {
      if (gitState.currentBranch !== task.branch && (await branchExistsLocally(gitRoot, task.branch, signal))) {
        await execGitSafe(['checkout', task.branch], { cwd: gitRoot, signal });
      }
      await execGitSafe(['add', '-A'], { cwd: gitRoot, signal });
      await execGitSafe(
        ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.team', '.cabinet'],
        { cwd: gitRoot, signal }
      );
      const stagedRes = await execGitSafe(['diff', '--cached', '--name-only'], { cwd: gitRoot, signal });
      if (stagedRes.stdout.length > 0) {
        autoCommittedFiles = stagedRes.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const cmRes = await execGitSafe(
          [
            '-c',
            'user.name=Orca Team Gateway',
            '-c',
            'user.email=orca-team@local',
            'commit',
            '-m',
            `chore(team): gateway snapshot for ${task.taskId} attempt ${task.attempt || 1}`
          ],
          { cwd: gitRoot, signal }
        );
        autoCommitted = cmRes.exitCode === 0;
      }
    }

    const gatewaySnapshot = {
      autoCommitted,
      autoCommittedFiles,
      workerCommittedPrior: workerAlreadyCommitted
    };

    const headRes = await execGitSafe(['rev-parse', `refs/heads/${task.branch}`], {
      cwd: gitRoot,
      signal
    });
    const headSha = headRes.exitCode === 0 && headRes.stdout ? headRes.stdout : gitState.headSha;

    const namesRes = await execGitSafe(['diff', '--name-only', `${baseSha}..${headSha}`], {
      cwd: gitRoot,
      signal
    });
    const changedFiles = namesRes.stdout
      ? namesRes.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const statRes = await execGitSafe(['diff', '--stat', `${baseSha}..${headSha}`], {
      cwd: gitRoot,
      signal
    });
    const diffStat = statRes.stdout || '';

    // Atomic return to `baseBranch` and release Main-Worktree Lease!
    if (baseBranch && baseBranch !== 'HEAD') {
      await execGitSafe(['checkout', baseBranch], { cwd: gitRoot, signal });
    }
    clearWorkspaceLease(workspaceRoot, task.taskId);

    return {
      fpDiff,
      quarantinedExecutableTamper,
      gatewaySnapshot,
      changedFiles,
      diffStat,
      untrackedFiles,
      ignoredArtifacts,
      readonlyDirtiedFiles: [],
      readonlyDirtyPatch: '',
      reviewedTarget: null,
      headSha
    };
  }

  // Readonly task (`architect` / `reviewer`)
  const readonlyDirtiedSet = new Set([
    ...gitState.status.trackedModified,
    ...gitState.status.untracked
  ]);

  let readonlyDirtyPatch = '';
  if (gitState.headSha !== checkedOutSha) {
    const rogueNames = await execGitSafe(['diff', '--name-only', `${checkedOutSha}..${gitState.headSha}`], {
      cwd: gitRoot,
      signal
    });
    for (const f of rogueNames.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      readonlyDirtiedSet.add(f);
    }
  }

  const readonlyDirtiedFiles = [...readonlyDirtiedSet];
  if (readonlyDirtiedFiles.length > 0) {
    const patchRes = await execGitSafe(['diff', checkedOutSha], { cwd: gitRoot, signal });
    readonlyDirtyPatch = (patchRes.stdout || '').slice(0, 8192);

    // Restore clean `checkedOutSha` and remove newly created untracked files (safe under exclusive lease!)
    await execGitSafe(['reset', '--hard', checkedOutSha], { cwd: gitRoot, signal });
    for (const rel of gitState.status.untracked) {
      const full = join(gitRoot, rel);
      try {
        rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  }

  if (baseBranch && baseBranch !== 'HEAD' && gitState.currentBranch !== baseBranch) {
    await execGitSafe(['checkout', baseBranch], { cwd: gitRoot, signal });
  }
  clearWorkspaceLease(workspaceRoot, task.taskId);

  const reviewedTarget = targetTaskForReview
    ? {
        taskId: targetTaskForReview.taskId,
        branch: targetTaskForReview.branch,
        baseSha: targetTaskForReview.baseSha,
        headSha: targetTaskForReview.headSha
      }
    : null;

  return {
    fpDiff,
    quarantinedExecutableTamper,
    gatewaySnapshot: null,
    changedFiles: [],
    diffStat: '',
    untrackedFiles: [],
    ignoredArtifacts,
    readonlyDirtiedFiles,
    readonlyDirtyPatch,
    reviewedTarget,
    headSha: checkedOutSha
  };
}

/**
 * Controlled `team_merge` (`action: "merge" | "discard"`, `strategy: "no-ff" | "squash" | "cherry-pick"`).
 */
export async function mergeOrDiscardTaskBranch({
  workspaceRoot,
  task,
  action,
  strategy = 'no-ff',
  acknowledgeRisks = false,
  acknowledgeCriticalTamper = false,
  signal
}) {
  const existingLease = readWorkspaceLease(workspaceRoot);
  if (existingLease && existingLease.taskId && existingLease.taskId !== task.taskId) {
    throw new TeamIsolationError(
      'TEAM_WORKSPACE_BUSY',
      `主工作树独占租约正被任务 "${existingLease.taskId}" 持有，无法执行 team_merge。`,
      { activeLease: existingLease }
    );
  }

  const baseline = loadBaselineSnapshot(workspaceRoot, task.taskId);
  const rootSnap =
    baseline?.rootFingerprints ||
    baseline?.preCheckoutFingerprints ||
    baseline?.baselineFingerprints ||
    null;
  const preMergeFp = captureSensitiveFingerprints(workspaceRoot, { includeBackup: false });
  const fpDiff = rootSnap
    ? diffFingerprints(rootSnap, preMergeFp)
    : {
        ok: true,
        changed: [],
        hasGitInternalTamper: false,
        hasGitFilterAttrTamper: false,
        hasIdeAutorunTamper: false,
        hasEnvOrRcTamper: false,
        hasExecutableTamper: false
      };

  if (fpDiff.hasExecutableTamper && rootSnap) {
    quarantineAndNeutralizeExecutableTamper(workspaceRoot, rootSnap);
  }

  const gitState = await inspectGitWorkspace(workspaceRoot, { signal });
  if (!gitState.isGitRepo || !gitState.gitRoot) {
    throw new TeamIsolationError('TEAM_NOT_GIT_REPO', `工作区 "${workspaceRoot}" 不是有效的 Git 仓库。`);
  }
  const gitRoot = gitState.gitRoot;
  const baseBranch = task.baseBranch || baseline?.baseBranch || 'main';

  if (action === 'discard') {
    const restoredBaseline = rootSnap
      ? restoreSensitiveBaseline(workspaceRoot, rootSnap)
      : { restored: [], deleted: [] };

    if (gitState.status.trackedModified.length > 0 && gitState.currentBranch === task.branch) {
      await execGitSafe(['reset', '--hard', 'HEAD'], { cwd: gitRoot, signal });
    }
    if (baseBranch && baseBranch !== 'HEAD' && gitState.currentBranch !== baseBranch) {
      await execGitSafe(['checkout', baseBranch], { cwd: gitRoot, signal });
    }

    let deletedBranch = null;
    if (
      task.branch &&
      task.branch.startsWith('team/') &&
      !task.reusedExistingBranch &&
      (await branchExistsLocally(gitRoot, task.branch, signal))
    ) {
      const delRes = await execGitSafe(['branch', '-D', task.branch], { cwd: gitRoot, signal });
      if (delRes.exitCode === 0) deletedBranch = task.branch;
    }

    clearWorkspaceLease(workspaceRoot, task.taskId);
    return {
      action: 'discard',
      baseBranch,
      deletedBranch,
      restoredBaseline
    };
  }

  // `action === 'merge'`
  if (task.status !== 'REPORTED') {
    throw new TeamIsolationError(
      'TEAM_INVALID_TASK_STATE',
      `任务 "${task.taskId}" 当前状态为 "${task.status}"，仅处于 REPORTED 状态的写任务允许执行合入。`
    );
  }
  if (task.mode !== 'write' || !task.branch) {
    throw new TeamIsolationError(
      'TEAM_NOT_MERGEABLE_ROLE',
      `任务 "${task.taskId}" (role=${task.role}, mode=${task.mode}) 无独立写分支，无需合入。`
    );
  }

  // Hard Non-Bypassable Block for Executable Tamper (Red-Team `锋` R2 Deep Fix):
  // Any task that tampered with `.git/config`, `.git/hooks/**`, `.gitattributes`, or `.vscode/tasks.json`
  // is permanently tainted and CANNOT be merged even with `acknowledgeCriticalTamper: true`!
  if (task.hasUnmergeableExecutableTamper || fpDiff.hasExecutableTamper) {
    throw new TeamIsolationError(
      'TEAM_EXECUTABLE_TAMPER_UNMERGEABLE',
      `合并门禁绝对封锁：任务 "${task.taskId}" 曾篡改可执行级 Git 内部配置/钩子/过滤器或 IDE 自动运行任务（已被网关隔离封存，详见 facts.quarantinedExecutableTamper）。此类被投毒分支严禁通过确认参数强行合入，唯一合法操作是调用 team_merge({ taskId: "${task.taskId}", action: "discard" }) 彻底销毁！`,
      {
        risk: task.risk,
        hasUnmergeableExecutableTamper: true,
        liveTamperedFingerprints: fpDiff.changed
      }
    );
  }

  const recordedCriticalTamper = Array.isArray(task.risk) && task.risk.includes('CRITICAL_GIT_OR_ENV_TAMPERED');
  if (recordedCriticalTamper || !fpDiff.ok) {
    if (!acknowledgeRisks || !acknowledgeCriticalTamper) {
      throw new TeamIsolationError(
        'TEAM_CRITICAL_TAMPER_BLOCKED',
        `合并门禁硬拦截：任务 "${task.taskId}" 触发 CRITICAL_GIT_OR_ENV_TAMPERED（敏感环境/包管理配置异变：${fpDiff.changed.map((c) => c.displayPath).join(', ') || '见 facts.tamperedFingerprints'}）。请调用 team_inspect 彻查，通常应调用 team_merge(action="discard") 回滚；若确系预期 .env/.npmrc 变更，需同时传 acknowledgeRisks=true 与 acknowledgeCriticalTamper=true。`,
        {
          risk: task.risk,
          liveTamperedFingerprints: fpDiff.changed
        }
      );
    }
  }

  if (Array.isArray(task.risk) && task.risk.length > 0 && !acknowledgeRisks) {
    throw new TeamIsolationError(
      'TEAM_RISK_ACKNOWLEDGEMENT_REQUIRED',
      `合并门禁拦截：任务 "${task.taskId}" 存在非空风险标签 [${task.risk.join(', ')}]。请先调用 team_inspect 核查 Diff，确认安全后显式传 acknowledgeRisks=true 合入。`,
      { risk: task.risk }
    );
  }

  const dirtyFiles = [...gitState.status.trackedModified, ...gitState.status.untracked];
  if (dirtyFiles.length > 0) {
    throw new TeamIsolationError(
      'TEAM_DIRTY_WORKING_TREE',
      `合入前主工作树存在未提交改动：${dirtyFiles.slice(0, 15).join(', ')}`,
      { dirtyFiles }
    );
  }

  if (gitState.currentBranch !== baseBranch) {
    const coRes = await execGitSafe(['checkout', baseBranch], { cwd: gitRoot, signal });
    if (coRes.exitCode !== 0) {
      throw new TeamIsolationError('TEAM_GIT_CHECKOUT_FAILED', `切回基线分支 ${baseBranch} 失败：${coRes.stderr}`);
    }
  }

  const currentBaseHeadRes = await execGitSafe(['rev-parse', 'HEAD'], { cwd: gitRoot, signal });
  const currentBaseHead = currentBaseHeadRes.stdout;
  if (task.baseSha && currentBaseHead !== task.baseSha) {
    throw new TeamIsolationError(
      'TEAM_BASE_BRANCH_DRIFTED',
      `基线漂移拦截：基线分支 "${baseBranch}" 当前 HEAD (${currentBaseHead.slice(0, 8)}) 已偏离任务派发时的 baseSha (${task.baseSha.slice(0, 8)})。请人工变基或重新派发，防止静默覆盖并行提交。`,
      {
        baseBranch,
        expectedBaseSha: task.baseSha,
        actualBaseHead: currentBaseHead
      }
    );
  }

  if (!(await branchExistsLocally(gitRoot, task.branch, signal))) {
    throw new TeamIsolationError(
      'TEAM_TASK_BRANCH_MISSING',
      `待合入分支 "${task.branch}" 在本地不存在。`
    );
  }

  if (strategy === 'squash') {
    const sqRes = await execGitSafe(['merge', '--squash', task.branch], { cwd: gitRoot, signal });
    if (sqRes.exitCode !== 0) {
      await execGitSafe(['reset', '--merge'], { cwd: gitRoot, signal });
      throw new TeamIsolationError('TEAM_GIT_MERGE_FAILED', `squash 合入失败：${sqRes.stderr || sqRes.stdout}`);
    }
    const cmRes = await execGitSafe(
      [
        '-c',
        'user.name=Orca Team Gateway',
        '-c',
        'user.email=orca-team@local',
        'commit',
        '-m',
        `feat(team): ${task.title} (${task.taskId})`
      ],
      { cwd: gitRoot, signal }
    );
    if (cmRes.exitCode !== 0) {
      throw new TeamIsolationError('TEAM_GIT_COMMIT_FAILED', `squash 提交失败：${cmRes.stderr || cmRes.stdout}`);
    }
  } else if (strategy === 'cherry-pick') {
    const revListRes = await execGitSafe(
      ['rev-list', '--reverse', `${task.baseSha}..${task.branch}`],
      { cwd: gitRoot, signal }
    );
    const commits = revListRes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sha of commits) {
      const cpRes = await execGitSafe(
        ['-c', 'user.name=Orca Team Gateway', '-c', 'user.email=orca-team@local', 'cherry-pick', sha],
        { cwd: gitRoot, signal }
      );
      if (cpRes.exitCode !== 0) {
        await execGitSafe(['cherry-pick', '--abort'], { cwd: gitRoot, signal });
        throw new TeamIsolationError('TEAM_GIT_MERGE_FAILED', `cherry-pick ${sha.slice(0, 8)} 失败：${cpRes.stderr}`);
      }
    }
  } else {
    // Default: `no-ff`
    const mgRes = await execGitSafe(
      [
        '-c',
        'user.name=Orca Team Gateway',
        '-c',
        'user.email=orca-team@local',
        'merge',
        '--no-ff',
        '-m',
        `merge(team): ${task.taskId} - ${task.title}`,
        task.branch
      ],
      { cwd: gitRoot, signal }
    );
    if (mgRes.exitCode !== 0) {
      await execGitSafe(['merge', '--abort'], { cwd: gitRoot, signal });
      throw new TeamIsolationError('TEAM_GIT_MERGE_FAILED', `no-ff 合入失败：${mgRes.stderr || mgRes.stdout}`);
    }
  }

  const mergedHeadRes = await execGitSafe(['rev-parse', 'HEAD'], { cwd: gitRoot, signal });
  const mergedHeadSha = mergedHeadRes.stdout;

  let deletedBranch = null;
  const delRes = await execGitSafe(['branch', '-D', task.branch], { cwd: gitRoot, signal });
  if (delRes.exitCode === 0) {
    deletedBranch = task.branch;
  }

  clearWorkspaceLease(workspaceRoot, task.taskId);
  return {
    action: 'merge',
    strategy,
    baseBranch,
    mergedHeadSha,
    deletedBranch
  };
}
