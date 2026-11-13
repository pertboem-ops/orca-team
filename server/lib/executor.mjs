import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  relayApprovalDecision,
  TeamApprovalError,
  verifyApprovalSafety
} from './approval-relay.mjs';
import { execGitSafe, findGitLayoutSync, inspectGitWorkspace } from './git-safe.mjs';
import {
  clearWorkspaceLease,
  ensureTeamDirs,
  getTeamPaths,
  mergeOrDiscardTaskBranch,
  prepareWorkspaceAndAcquireLease,
  reacquireLeaseForSteer,
  readWorkspaceLease,
  TeamIsolationError
} from './isolation.mjs';
import {
  ensureTeamCoordinator,
  execOrca,
  spawnTeamWorker,
  stopAndReleaseTeamWorker
} from './orca-exec.mjs';
import { loadTeamRolesConfig, probeCliEnvironment } from './probe.mjs';
import {
  appendTeamEvent,
  listOrphanTeamBranches,
  loadOrRebuildTeamState,
  reconcileWorkspace
} from './reconciler.mjs';
import {
  buildBoardRoutingSummary,
  resolveRoleRoute,
  TeamRoutingError
} from './router.mjs';

export class TeamExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TeamExecutionError';
    this.code = code;
    this.details = details;
  }
}

export function resolveWorkspaceRoot(args = {}) {
  const raw = args.workspaceRoot || args.workspacePath || process.cwd();
  const abs = resolve(raw);
  const layout = findGitLayoutSync(abs);
  return layout.isGitRepo && layout.gitRoot ? layout.gitRoot : abs;
}

function clampWaitSeconds(rawWait) {
  const cfg = loadTeamRolesConfig();
  const maxW = cfg.maxWaitSeconds ?? 55;
  const defW = cfg.defaultWaitSeconds ?? 20;
  if (rawWait === undefined || rawWait === null) return defW;
  const n = Number(rawWait);
  if (!Number.isFinite(n)) return defW;
  return Math.max(0, Math.min(maxW, Math.floor(n)));
}

function makeTaskId(type) {
  const now = new Date();
  const ymd = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('');
  const rand = randomBytes(3).toString('hex');
  const safeType = String(type || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return `${safeType}-${ymd}-${rand}`;
}

export function buildWorkerBriefing({
  taskId,
  attempt,
  title,
  taskSpec,
  files = [],
  route,
  branch,
  baseBranch,
  baseSha,
  targetTask = null,
  reportFilePath,
  steerContext = null
}) {
  const lines = [
    `# [Orca Team 任务简报] ${title}`,
    `- 任务 ID: \`${taskId}\` (Attempt #${attempt})`,
    `- 工程角色: ${route.roleTitle} (\`${route.roleId}\`, mode=\`${route.mode}\`)`,
    `- 执行引擎: \`${route.cli}\` (model=\`${route.model || 'cli-default'}\`, family=\`${route.actualProviderFamily}\`)`
  ];

  if (route.mode === 'readonly') {
    lines.push(
      '',
      '## 【硬性只读边界纪律（必须遵守）】',
      `1. 你当前担任**严格只读**角色（\`${route.roleId}\`）。除将你的完整报告写入 \`${reportFilePath}\` 之外，**严禁修改、创建或删除工作区中的任何文件**，严禁执行 \`git commit\` / \`git checkout\` / \`git reset\`。`,
      '2. 若违规修改工作树，网关将立即标记 `READONLY_ROLE_DIRTIED_TREE` 风险并强制还原所有改动。'
    );
    if (targetTask) {
      lines.push(
        `3. 本次审查目标写任务: \`${targetTask.taskId}\`（分支: \`${targetTask.branch || 'N/A'}\`，基线: \`${targetTask.baseSha || 'N/A'}\`，最新提交: \`${targetTask.headSha || 'HEAD'}\`）。`,
        `   请直接运行 \`git -c core.hooksPath= -c core.fsmonitor=false diff ${targetTask.baseSha}..${targetTask.headSha || targetTask.branch}\` 独立核查真实代码变更，切勿轻信前序自述。`
      );
    }
  } else {
    lines.push(
      '',
      '## 【受控写分支与安全纪律（必须遵守）】',
      `1. 网关已为你独占检出任务分支 \`${branch}\`（基线 \`${baseBranch}@${baseSha?.slice(0, 8) || 'HEAD'}\`，零拷贝复用当前目录依赖）。`,
      '2. 请仅在当前分支内完成代码编写与测试验证；**严禁执行 `git checkout` 切换分支**，严禁修改 `.git/config`、`.git/hooks/**` 或遗留 `.tmp`/`.bak`/`.log` 调试垃圾文件。',
      '3. 若遇到架构歧义或需高危变更授权，请通过 Orca Orchestration 邮箱发出 `question` / `escalation` 请求主控裁决。'
    );
  }

  if (Array.isArray(files) && files.length > 0) {
    lines.push('', '## 重点关联文件路径', ...files.map((f) => `- \`${f}\``));
  }

  if (steerContext) {
    lines.push(
      '',
      `## 前序回合客观状态（Attempt #${attempt - 1} -> 冷启动续接 Attempt #${attempt}）`,
      `- 前序已改动文件: ${steerContext.changedFiles?.length ? steerContext.changedFiles.map((f) => `\`${f}\``).join(', ') : '(无)'}`,
      steerContext.diffStat ? `\`\`\`text\n${steerContext.diffStat}\n\`\`\`` : '',
      steerContext.previousExcerpt ? `- 前序报告摘要: ${steerContext.previousExcerpt}` : '',
      '',
      '## 本轮追加返工/指导指令 (`team_steer`)',
      steerContext.instruction
    );
  } else {
    lines.push('', '## 任务目标与具体要求', taskSpec);
  }

  lines.push(
    '',
    '## 无损交付规范',
    `完成工作后，请务必将完整结构化报告（含核心变更/审查发现、验证命令与结果、残余风险）直接写入文件：\`${reportFilePath}\`，然后正常结束回合。`
  );

  return lines.filter((l) => l !== null && l !== undefined).join('\n');
}

async function launchPreparedTask({
  workspaceRoot,
  state,
  taskDraft,
  attempt = 1,
  steerContext = null,
  signal
}) {
  const probe = await probeCliEnvironment({ workspaceRoot, signal });
  const targetTask =
    taskDraft.targetTaskId && state.tasks?.[taskDraft.targetTaskId]
      ? state.tasks[taskDraft.targetTaskId]
      : null;
  const reuseTask =
    taskDraft.reuseBranchOfTaskId && state.tasks?.[taskDraft.reuseBranchOfTaskId]
      ? state.tasks[taskDraft.reuseBranchOfTaskId]
      : null;

  if (taskDraft.type === 'review' && taskDraft.targetTaskId && !targetTask) {
    throw new TeamExecutionError(
      'TEAM_TARGET_TASK_NOT_FOUND',
      `审查目标任务 "${taskDraft.targetTaskId}" 不存在。`
    );
  }
  if (taskDraft.reuseBranchOfTaskId && !reuseTask) {
    throw new TeamExecutionError(
      'TEAM_REUSE_TASK_NOT_FOUND',
      `拟复用分支的目标任务 "${taskDraft.reuseBranchOfTaskId}" 不存在。`
    );
  }

  const route = resolveRoleRoute({
    type: taskDraft.type,
    hard: Boolean(taskDraft.hard),
    targetTask,
    state,
    probe,
    workspaceRoot
  });

  // Acquire Main-Worktree Exclusive Lease + Pre-Git SHA-256 baseline + checkout
  let iso;
  if (attempt > 1) {
    const existingTask = state.tasks[taskDraft.taskId];
    const reacquired = await reacquireLeaseForSteer({
      workspaceRoot,
      task: existingTask,
      nextAttempt: attempt,
      signal
    });
    iso = {
      baseBranch: existingTask.baseBranch,
      baseSha: existingTask.baseSha,
      branch: existingTask.branch,
      checkedOutBranch: reacquired.checkedOutBranch,
      checkedOutSha: reacquired.checkedOutSha,
      reusedExistingBranch: Boolean(existingTask.reusedExistingBranch)
    };
  } else {
    iso = await prepareWorkspaceAndAcquireLease({
      workspaceRoot,
      taskId: taskDraft.taskId,
      attempt: 1,
      roleId: route.roleId,
      mode: route.mode,
      targetTask,
      reuseTask,
      signal
    });
  }

  // Provision Orca Coordinator + Run; release lease cleanly if Orca fails to spawn!
  let orcaContext;
  const paths = ensureTeamDirs(workspaceRoot);
  const reportFilePath = join(paths.reportsDir, `${taskDraft.taskId}-a${attempt}.md`);

  try {
    orcaContext = await ensureTeamCoordinator(workspaceRoot, {
      existingOrca: state.orca,
      signal
    });
    state = appendTeamEvent(workspaceRoot, {
      type: 'orca_context_bound',
      payload: orcaContext
    }).state;

    if (attempt === 1) {
      state = appendTeamEvent(workspaceRoot, {
        type: 'task_created',
        taskId: taskDraft.taskId,
        payload: {
          taskId: taskDraft.taskId,
          rootBaselineTaskId: iso.rootBaselineTaskId || taskDraft.taskId,
          status: 'PENDING',
          title: taskDraft.title,
          task: taskDraft.task,
          type: taskDraft.type,
          hard: Boolean(taskDraft.hard),
          files: taskDraft.files || [],
          targetTaskId: taskDraft.targetTaskId || null,
          reuseBranchOfTaskId: taskDraft.reuseBranchOfTaskId || null,
          idempotencyKey: taskDraft.idempotencyKey || null,
          role: route.roleId,
          mode: route.mode,
          baseBranch: iso.baseBranch,
          baseSha: iso.baseSha,
          branch: iso.branch,
          reusedExistingBranch: iso.reusedExistingBranch,
          createdAt: new Date().toISOString()
        }
      }).state;
    }

    const briefingText = buildWorkerBriefing({
      taskId: taskDraft.taskId,
      attempt,
      title: taskDraft.title,
      taskSpec: taskDraft.task,
      files: taskDraft.files || [],
      route,
      branch: iso.branch,
      baseBranch: iso.baseBranch,
      baseSha: iso.baseSha,
      targetTask,
      reportFilePath,
      steerContext
    });

    const spawnRes = await spawnTeamWorker({
      orcaContext,
      taskTitle: `[Team ${route.roleId}] ${taskDraft.title} (${taskDraft.taskId} a${attempt})`,
      briefingText,
      cli: route.cli,
      model: route.requestedModelFlag,
      effort: route.effort,
      passModelFlag: route.passModelFlag,
      passEffortFlag: route.passEffortFlag,
      cwd: workspaceRoot,
      signal
    });

    if (!spawnRes.ok) {
      throw new TeamExecutionError(
        'TEAM_ORCA_WORKER_START_FAILED',
        `拉起 Orca Worker (${route.cli}) 失败：${spawnRes.error}`
      );
    }

    const attemptRecord = {
      attempt,
      cli: route.cli,
      model: route.model,
      effort: route.effort,
      actualProviderFamily: route.actualProviderFamily,
      familyConfidence: route.familyConfidence,
      degradedFrom: route.degradedFrom,
      orcaDispatchId: spawnRes.dispatchId,
      orcaTaskId: spawnRes.orcaTaskId,
      reportFilePath,
      startedAt: new Date().toISOString()
    };

    state = appendTeamEvent(workspaceRoot, {
      type: attempt > 1 ? 'task_steered' : 'task_started',
      taskId: taskDraft.taskId,
      payload: {
        attempt,
        role: route.roleId,
        mode: route.mode,
        cli: route.cli,
        model: route.model,
        effort: route.effort,
        actualProviderFamily: route.actualProviderFamily,
        familyConfidence: route.familyConfidence,
        degradedFrom: route.degradedFrom,
        crossFamilyVerifiedAgainst: route.crossFamilyVerifiedAgainst,
        orcaDispatchId: spawnRes.dispatchId,
        orcaTaskId: spawnRes.orcaTaskId,
        reportFilePath,
        attemptRecord
      }
    }).state;

    return state;
  } catch (err) {
    // Roll back branch checkout to `baseBranch` and release lease on startup failure
    if (iso?.baseBranch && iso.baseBranch !== 'HEAD') {
      await execGitSafe(['checkout', iso.baseBranch], { cwd: workspaceRoot, signal });
      if (attempt === 1 && iso.branch && !iso.reusedExistingBranch) {
        await execGitSafe(['branch', '-D', iso.branch], { cwd: workspaceRoot, signal });
      }
    }
    clearWorkspaceLease(workspaceRoot, taskDraft.taskId);
    throw err;
  }
}

function hasQueuedTasks(state) {
  return (state?.taskOrder || []).some((id) => state?.tasks?.[id]?.status === 'QUEUED');
}

async function promoteNextQueuedTaskIfIdle(workspaceRoot, signal) {
  if (readWorkspaceLease(workspaceRoot)) return loadOrRebuildTeamState(workspaceRoot);
  const state = loadOrRebuildTeamState(workspaceRoot);
  const nextQueuedId = (state.taskOrder || []).find((id) => state.tasks?.[id]?.status === 'QUEUED');
  if (!nextQueuedId) return state;

  const queuedTask = state.tasks[nextQueuedId];
  return await launchPreparedTask({
    workspaceRoot,
    state,
    taskDraft: queuedTask,
    attempt: 1,
    signal
  });
}

async function waitForTasksProgress(
  workspaceRoot,
  { targetTaskIds, waitSeconds, includeOrphanBranches = false, signal }
) {
  const sliceCapMs =
    process.env.ORCA_TEAM_POLL_SLICE_MS !== undefined
      ? Number(process.env.ORCA_TEAM_POLL_SLICE_MS)
      : 4_000;

  const deadline = Date.now() + waitSeconds * 1000;
  let reconciled = await reconcileWorkspace(workspaceRoot, {
    waitMs: 0,
    includeOrphanBranches,
    signal
  });
  if (!reconciled.lease && hasQueuedTasks(reconciled.state)) {
    await promoteNextQueuedTaskIfIdle(workspaceRoot, signal);
    reconciled = await reconcileWorkspace(workspaceRoot, {
      waitMs: 0,
      includeOrphanBranches,
      signal
    });
  }

  const isSettledOrActionable = (st) =>
    targetTaskIds.every((id) => {
      const t = st.tasks?.[id];
      return (
        t &&
        ['REPORTED', 'AWAITING_APPROVAL', 'MERGED', 'DISCARDED', 'ABORTED', 'ORPHANED'].includes(
          t.status
        )
      );
    });

  while (Date.now() < deadline && !isSettledOrActionable(reconciled.state)) {
    if (signal?.aborted) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const waitChunk = Math.min(remainingMs, Math.max(150, sliceCapMs));
    reconciled = await reconcileWorkspace(workspaceRoot, {
      waitMs: waitChunk,
      includeOrphanBranches,
      signal
    });
    if (!reconciled.lease && hasQueuedTasks(reconciled.state)) {
      await promoteNextQueuedTaskIfIdle(workspaceRoot, signal);
      reconciled = await reconcileWorkspace(workspaceRoot, {
        waitMs: 0,
        includeOrphanBranches,
        signal
      });
    }
  }

  return reconciled;
}

export function formatTaskPublicView(task) {
  if (!task) return null;
  if (task.status === 'REPORTED' && task.compactSummary) {
    return task.compactSummary;
  }
  return {
    taskId: task.taskId,
    status: task.status,
    title: task.title,
    type: task.type,
    hard: Boolean(task.hard),
    role: task.role || null,
    mode: task.mode || null,
    attempt: task.attempt || 0,
    cli: task.cli || null,
    model: task.model || null,
    actualProviderFamily: task.actualProviderFamily || null,
    familyConfidence: task.familyConfidence || null,
    writerFamilies: task.writerFamilies || [],
    crossFamilyVerifiedAgainst: task.crossFamilyVerifiedAgainst || [],
    degradedFrom: task.degradedFrom || null,
    branch: task.branch || null,
    baseBranch: task.baseBranch || null,
    baseSha: task.baseSha || null,
    headSha: task.headSha || null,
    pendingApproval: task.pendingApproval || null,
    risk: task.risk || [],
    referencePath: task.referencePath || null
  };
}

function inferActionTaskType(action) {
  const owner = String(action.owner || '').toLowerCase();
  const item = String(action.item || '').toLowerCase();

  if (owner.includes('architect') || owner.includes('架构')) {
    return { type: 'architecture', hard: false };
  }
  if (owner.includes('reviewer') || owner.includes('审')) {
    return { type: 'review', hard: true };
  }
  if (owner.includes('test') || owner.includes('测')) {
    return { type: 'test', hard: false };
  }
  if (owner.includes('coder-pro') || item.includes('状态机') || item.includes('指纹') || item.includes('重构')) {
    return { type: 'feature', hard: true };
  }
  if (owner.includes('coder')) {
    return { type: 'feature', hard: false };
  }
  if (item.includes('测试') || item.includes('smoke') || item.includes('verify')) {
    return { type: 'test', hard: false };
  }
  if (item.includes('文档') || item.includes('设计方案')) {
    return { type: 'architecture', hard: false };
  }
  return { type: 'feature', hard: false };
}

function resolveCabinetProtocolFile(workspaceRoot, cabinetSessionId) {
  const cabDir = join(workspaceRoot, '.cabinet');
  if (!existsSync(cabDir)) {
    throw new TeamExecutionError(
      'TEAM_CABINET_DIR_NOT_FOUND',
      `当前工作区 "${workspaceRoot}" 下不存在 .cabinet 目录，请先运行 orca-cabinet 完成议事结案。`
    );
  }

  let sessionKey = cabinetSessionId && cabinetSessionId !== 'latest' ? String(cabinetSessionId).trim() : null;

  if (!sessionKey) {
    const indexJsonl = join(cabDir, 'index.jsonl');
    if (existsSync(indexJsonl)) {
      const lines = readFileSync(indexJsonl, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const rec = JSON.parse(lines[i]);
          if (rec?.session || rec?.runKey) {
            sessionKey = rec.session || rec.runKey;
            break;
          }
        } catch {}
      }
    }
    if (!sessionKey && existsSync(join(cabDir, 'runs'))) {
      const dirs = readdirSync(join(cabDir, 'runs')).sort();
      for (let i = dirs.length - 1; i >= 0; i -= 1) {
        if (existsSync(join(cabDir, 'runs', dirs[i], 'protocol.json'))) {
          sessionKey = dirs[i];
          break;
        }
      }
    }
  }

  if (!sessionKey) {
    throw new TeamExecutionError(
      'TEAM_PROTOCOL_NOT_FOUND',
      `未在 "${cabDir}" 中找到任何已归档的内阁议定书 (protocol.json)。`
    );
  }

  const candidates = [
    join(cabDir, 'runs', sessionKey, 'protocol.json'),
    join(cabDir, sessionKey, 'protocol.json')
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return { sessionKey, protocolPath: p };
    }
  }

  throw new TeamExecutionError(
    'TEAM_PROTOCOL_NOT_FOUND',
    `未找到内阁场次 "${sessionKey}" 的议定书文件（已检查 .cabinet/runs/${sessionKey}/protocol.json）。`
  );
}

export async function executeTeamTool(toolName, args = {}, signal) {
  try {
    const workspaceRoot = resolveWorkspaceRoot(args);

    switch (toolName) {
      case 'team_board': {
        const waitSeconds = args.taskId ? clampWaitSeconds(args.waitSeconds ?? 0) : 0;
        let reconciled;
        if (args.taskId && waitSeconds > 0) {
          reconciled = await waitForTasksProgress(workspaceRoot, {
            targetTaskIds: [args.taskId],
            waitSeconds,
            includeOrphanBranches: true,
            signal
          });
        } else {
          reconciled = await reconcileWorkspace(workspaceRoot, {
            waitMs: 0,
            includeOrphanBranches: true,
            signal
          });
          if (!reconciled.lease && hasQueuedTasks(reconciled.state)) {
            await promoteNextQueuedTaskIfIdle(workspaceRoot, signal);
            reconciled = await reconcileWorkspace(workspaceRoot, {
              waitMs: 0,
              includeOrphanBranches: true,
              signal
            });
          }
        }

        if (args.taskId) {
          const t = reconciled.state.tasks?.[args.taskId];
          if (!t) {
            throw new TeamExecutionError('TEAM_TASK_NOT_FOUND', `任务 "${args.taskId}" 不存在。`);
          }
          return {
            isError: false,
            payload: {
              ok: true,
              workspaceRoot,
              lease: reconciled.lease,
              orphanBranches: reconciled.orphanBranches,
              task: formatTaskPublicView(t)
            }
          };
        }

        const probe = await probeCliEnvironment({
          forceRefresh: Boolean(args.forceProbeRefresh),
          workspaceRoot,
          signal
        });
        const roles = buildBoardRoutingSummary(probe, workspaceRoot);
        const allTasks = (reconciled.state.taskOrder || []).map((id) =>
          formatTaskPublicView(reconciled.state.tasks[id])
        );

        return {
          isError: false,
          payload: {
            ok: true,
            workspaceRoot,
            orcaRunning: probe.orcaRunning,
            probedAt: probe.probedAt,
            lease: reconciled.lease,
            orphanBranches: reconciled.orphanBranches,
            roles,
            activeTaskCount: allTasks.filter((t) =>
              ['QUEUED', 'PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(t.status)
            ).length,
            tasks: allTasks
          }
        };
      }

      case 'team_delegate': {
        const waitSeconds = clampWaitSeconds(args.waitSeconds);
        let reconciled = await reconcileWorkspace(workspaceRoot, { waitMs: 0, signal });

        // Idempotency key deduplication
        if (args.idempotencyKey) {
          const existing = Object.values(reconciled.state.tasks || {}).find(
            (t) => t.idempotencyKey === args.idempotencyKey
          );
          if (existing) {
            return {
              isError: false,
              payload: {
                ok: true,
                deduplicatedByIdempotencyKey: true,
                workspaceRoot,
                task: formatTaskPublicView(existing)
              }
            };
          }
        }

        const taskId = makeTaskId(args.type);
        await launchPreparedTask({
          workspaceRoot,
          state: reconciled.state,
          taskDraft: {
            taskId,
            title: args.title,
            task: args.task,
            type: args.type,
            hard: Boolean(args.hard),
            files: args.files || [],
            targetTaskId: args.targetTaskId || null,
            reuseBranchOfTaskId: args.reuseBranchOfTaskId || null,
            idempotencyKey: args.idempotencyKey || null
          },
          attempt: 1,
          signal
        });

        reconciled = await waitForTasksProgress(workspaceRoot, {
          targetTaskIds: [taskId],
          waitSeconds,
          signal
        });

        return {
          isError: false,
          payload: {
            ok: true,
            deduplicatedByIdempotencyKey: false,
            workspaceRoot,
            lease: reconciled.lease,
            task: formatTaskPublicView(reconciled.state.tasks[taskId])
          }
        };
      }

      case 'team_delegate_batch': {
        const cfg = loadTeamRolesConfig();
        const maxBatch = cfg.maxBatchSize ?? 4;
        const inputTasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (inputTasks.length === 0 || inputTasks.length > maxBatch) {
          throw new TeamExecutionError(
            'TEAM_INVALID_BATCH_SIZE',
            `team_delegate_batch 要求 tasks 数量在 1..${maxBatch} 之间（收到 ${inputTasks.length}）。`
          );
        }

        const waitSeconds = clampWaitSeconds(args.waitSeconds);
        let reconciled = await reconcileWorkspace(workspaceRoot, { waitMs: 0, signal });

        if (reconciled.lease) {
          throw new TeamIsolationError(
            'TEAM_WORKSPACE_BUSY',
            `主工作树独占租约正被任务 "${reconciled.lease.taskId}" 持有，无法启动新的批量队列。`,
            { activeLease: reconciled.lease }
          );
        }

        // Pre-validate clean working tree upfront before queuing batch
        const gitState = await inspectGitWorkspace(workspaceRoot, { signal });
        if (!gitState.isGitRepo || !gitState.hasHeadCommit) {
          throw new TeamIsolationError('TEAM_NOT_GIT_REPO', `工作区 "${workspaceRoot}" 不是有效的 Git 仓库。`);
        }
        const dirty = [...gitState.status.trackedModified, ...gitState.status.untracked];
        if (dirty.length > 0) {
          throw new TeamIsolationError(
            'TEAM_DIRTY_WORKING_TREE',
            `批量委派前工作树存在脏文件：${dirty.slice(0, 15).join(', ')}`,
            { dirtyFiles: dirty }
          );
        }

        const probe = await probeCliEnvironment({ workspaceRoot, signal });
        const batchTaskIds = [];

        for (const item of inputTasks) {
          // Validate routing upfront so invalid task types fail immediately
          resolveRoleRoute({
            type: item.type,
            hard: Boolean(item.hard),
            targetTask: item.targetTaskId ? reconciled.state.tasks?.[item.targetTaskId] : null,
            state: reconciled.state,
            probe,
            workspaceRoot
          });

          const taskId = makeTaskId(item.type);
          batchTaskIds.push(taskId);
          reconciled.state = appendTeamEvent(workspaceRoot, {
            type: 'task_queued',
            taskId,
            payload: {
              taskId,
              status: 'QUEUED',
              title: item.title,
              task: item.task,
              type: item.type,
              hard: Boolean(item.hard),
              files: item.files || [],
              targetTaskId: item.targetTaskId || null,
              reuseBranchOfTaskId: item.reuseBranchOfTaskId || null,
              idempotencyKey: item.idempotencyKey || null,
              queuedAt: new Date().toISOString()
            }
          }).state;
        }

        await promoteNextQueuedTaskIfIdle(workspaceRoot, signal);
        reconciled = await waitForTasksProgress(workspaceRoot, {
          targetTaskIds: batchTaskIds,
          waitSeconds,
          signal
        });

        return {
          isError: false,
          payload: {
            ok: true,
            workspaceRoot,
            executionModel: 'main-worktree-exclusive-fifo',
            lease: reconciled.lease,
            tasks: batchTaskIds.map((id) => formatTaskPublicView(reconciled.state.tasks[id]))
          }
        };
      }

      case 'team_approve': {
        const waitSeconds = clampWaitSeconds(args.waitSeconds);
        let reconciled = await reconcileWorkspace(workspaceRoot, { waitMs: 0, signal });
        const task = reconciled.state.tasks?.[args.taskId];
        if (!task) {
          throw new TeamExecutionError('TEAM_TASK_NOT_FOUND', `任务 "${args.taskId}" 不存在。`);
        }

        // Idempotent replay if already approved
        const alreadyHandled = (task.approvals || []).find((a) => a.requestId === args.requestId);
        if (alreadyHandled) {
          return {
            isError: false,
            payload: {
              ok: true,
              idempotentReplay: true,
              approval: alreadyHandled,
              task: formatTaskPublicView(task)
            }
          };
        }

        if (task.status !== 'AWAITING_APPROVAL' || !task.pendingApproval) {
          throw new TeamExecutionError(
            'TEAM_NOT_AWAITING_APPROVAL',
            `任务 "${args.taskId}" 当前状态为 "${task.status}"，不存在待审批请求。`
          );
        }

        if (args.requestId && task.pendingApproval.requestId !== args.requestId) {
          throw new TeamExecutionError(
            'TEAM_APPROVAL_REQUEST_MISMATCH',
            `requestId 不匹配：当前挂起请求为 "${task.pendingApproval.requestId}"，收到 "${args.requestId}"。`
          );
        }

        const safety = await verifyApprovalSafety({
          workspaceRoot,
          task,
          decision: args.decision,
          acknowledgeHighRiskDiff: Boolean(args.acknowledgeHighRiskDiff),
          acknowledgeCriticalTamper: Boolean(args.acknowledgeCriticalTamper),
          signal
        });

        const orcaContext = await ensureTeamCoordinator(workspaceRoot, {
          existingOrca: reconciled.state.orca,
          signal
        });

        const relayRes = await relayApprovalDecision({
          workspaceRoot,
          orcaContext,
          pendingApproval: task.pendingApproval,
          decision: args.decision,
          reason: args.reason || '',
          signal
        });

        const approvalRecord = {
          requestId: task.pendingApproval.requestId,
          decision: args.decision,
          reason: args.reason || '',
          acknowledgeHighRiskDiff: Boolean(args.acknowledgeHighRiskDiff),
          highRiskFilesAtApproval: safety.highRiskFiles,
          channel: relayRes.channel,
          resolvedAt: new Date().toISOString()
        };

        appendTeamEvent(workspaceRoot, {
          type: 'task_approval_resolved',
          taskId: task.taskId,
          payload: { approvalRecord }
        });

        reconciled = await waitForTasksProgress(workspaceRoot, {
          targetTaskIds: [task.taskId],
          waitSeconds,
          signal
        });

        return {
          isError: false,
          payload: {
            ok: true,
            approval: approvalRecord,
            task: formatTaskPublicView(reconciled.state.tasks[task.taskId])
          }
        };
      }

      case 'team_steer': {
        const waitSeconds = clampWaitSeconds(args.waitSeconds);
        let reconciled = await reconcileWorkspace(workspaceRoot, { waitMs: 0, signal });
        const task = reconciled.state.tasks?.[args.taskId];
        if (!task) {
          throw new TeamExecutionError('TEAM_TASK_NOT_FOUND', `任务 "${args.taskId}" 不存在。`);
        }

        if (task.status === 'RUNNING' && task.orcaDispatchId && reconciled.state.orca?.coordinatorHandle) {
          // If still actively running in Orca, deliver follow-up instruction via Orca mailbox
          await execOrca(
            [
              'orchestration',
              'send',
              `--to=dispatch:${task.orcaDispatchId}`,
              `--body=[STEER INSTRUCTION] ${args.instruction}`,
              `--from=${reconciled.state.orca.coordinatorHandle}`
            ],
            { cwd: workspaceRoot, timeoutMs: 12_000, signal }
          );
          reconciled = await waitForTasksProgress(workspaceRoot, {
            targetTaskIds: [task.taskId],
            waitSeconds,
            signal
          });
          return {
            isError: false,
            payload: {
              ok: true,
              steerMode: 'in-flight-mail',
              task: formatTaskPublicView(reconciled.state.tasks[task.taskId])
            }
          };
        }

        if (task.status !== 'REPORTED') {
          throw new TeamExecutionError(
            'TEAM_INVALID_STEER_STATE',
            `任务 "${args.taskId}" 当前状态为 "${task.status}"，仅 RUNNING 或 REPORTED 状态的任务支持 team_steer。`
          );
        }

        const nextAttempt = (task.attempt || 1) + 1;
        let prevRef = null;
        if (task.referencePath && existsSync(task.referencePath)) {
          try {
            prevRef = JSON.parse(readFileSync(task.referencePath, 'utf8'));
          } catch {}
        }

        await launchPreparedTask({
          workspaceRoot,
          state: reconciled.state,
          taskDraft: task,
          attempt: nextAttempt,
          steerContext: {
            instruction: args.instruction,
            changedFiles: prevRef?.facts?.changedFiles || [],
            diffStat: prevRef?.facts?.diffStat || '',
            previousExcerpt: prevRef?.agentReport?.excerpt || ''
          },
          signal
        });

        reconciled = await waitForTasksProgress(workspaceRoot, {
          targetTaskIds: [task.taskId],
          waitSeconds,
          signal
        });

        return {
          isError: false,
          payload: {
            ok: true,
            steerMode: 'same-branch-cold-start',
            attempt: nextAttempt,
            task: formatTaskPublicView(reconciled.state.tasks[task.taskId])
          }
        };
      }

      case 'team_inspect': {
        // Pure local fast path — skips `reconcileWorkspace()` per Cabinet Decision #7!
        const state = loadOrRebuildTeamState(workspaceRoot);
        const task = state.tasks?.[args.taskId];
        if (!task) {
          throw new TeamExecutionError('TEAM_TASK_NOT_FOUND', `任务 "${args.taskId}" 不存在。`);
        }

        const { referencesDir } = getTeamPaths(workspaceRoot);
        const refPath = task.referencePath || join(referencesDir, `${task.taskId}.json`);
        let reference = null;
        if (existsSync(refPath)) {
          try {
            reference = JSON.parse(readFileSync(refPath, 'utf8'));
          } catch {}
        }

        let fullDiff = null;
        if (args.includeFullDiff && task.baseSha) {
          const targetRef = task.headSha || task.branch || 'HEAD';
          const diffRes = await execGitSafe(['diff', `${task.baseSha}..${targetRef}`], {
            cwd: workspaceRoot,
            signal
          });
          if (diffRes.exitCode === 0) {
            fullDiff =
              diffRes.stdout.length > 65_536
                ? `${diffRes.stdout.slice(0, 65_536)}\n...[truncated at 64KB]...`
                : diffRes.stdout;
          }
        }

        let terminalTail = null;
        if (args.includeTerminalTail && task.orcaDispatchId) {
          const readRes = await execOrca(
            ['orchestration', 'worker-read', `--dispatch=${task.orcaDispatchId}`, '--source=auto', '--limit=40'],
            { cwd: workspaceRoot, timeoutMs: 10_000, signal }
          );
          terminalTail = readRes.parsed?.result || null;
        }

        return {
          isError: false,
          payload: {
            ok: true,
            workspaceRoot,
            taskStatus: task.status,
            reference: reference || formatTaskPublicView(task),
            ...(fullDiff !== null ? { fullDiff } : {}),
            ...(terminalTail !== null ? { terminalTail } : {})
          }
        };
      }

      case 'team_interrupt': {
        const reconciled = await reconcileWorkspace(workspaceRoot, { waitMs: 0, signal });
        const task = reconciled.state.tasks?.[args.taskId];
        if (!task) {
          throw new TeamExecutionError('TEAM_TASK_NOT_FOUND', `任务 "${args.taskId}" 不存在。`);
        }

        if (task.orcaDispatchId && ['RUNNING', 'AWAITING_APPROVAL', 'PENDING'].includes(task.status)) {
          await stopAndReleaseTeamWorker(task.orcaDispatchId, { cwd: workspaceRoot, signal });
        }

        let cleanupDetails = null;
        if (args.discardBranch) {
          cleanupDetails = await mergeOrDiscardTaskBranch({
            workspaceRoot,
            task,
            action: 'discard',
            signal
          });
        } else {
          // Ensure we return to `baseBranch` and release lease even if keeping `team/<taskId>` branch
          if (task.baseBranch && task.baseBranch !== 'HEAD') {
            const gitInfo = await inspectGitWorkspace(workspaceRoot, { signal });
            if (gitInfo.isGitRepo && gitInfo.currentBranch !== task.baseBranch) {
              await execGitSafe(['checkout', '-f', task.baseBranch], { cwd: gitInfo.gitRoot, signal });
            }
          }
          clearWorkspaceLease(workspaceRoot, task.taskId);
        }

        const updated = appendTeamEvent(workspaceRoot, {
          type: 'task_aborted',
          taskId: task.taskId,
          payload: {
            discardedBranch: Boolean(args.discardBranch),
            cleanupDetails,
            abortedAt: new Date().toISOString()
          }
        });

        await promoteNextQueuedTaskIfIdle(workspaceRoot, signal);

        return {
          isError: false,
          payload: {
            ok: true,
            workspaceRoot,
            task: formatTaskPublicView(updated.state.tasks[task.taskId]),
            cleanupDetails
          }
        };
      }

      case 'team_merge': {
        const reconciled = await reconcileWorkspace(workspaceRoot, { waitMs: 0, signal });
        const task = reconciled.state.tasks?.[args.taskId];
        if (!task) {
          throw new TeamExecutionError('TEAM_TASK_NOT_FOUND', `任务 "${args.taskId}" 不存在。`);
        }

        const action = args.action || 'merge';
        const strategy = args.strategy || 'no-ff';
        const mergeOutcome = await mergeOrDiscardTaskBranch({
          workspaceRoot,
          task,
          action,
          strategy,
          acknowledgeRisks: Boolean(args.acknowledgeRisks),
          acknowledgeCriticalTamper: Boolean(args.acknowledgeCriticalTamper),
          signal
        });

        const updated = appendTeamEvent(workspaceRoot, {
          type: action === 'discard' ? 'task_discarded' : 'task_merged',
          taskId: task.taskId,
          payload: {
            mergeOutcome,
            completedAt: new Date().toISOString()
          }
        });

        const orphanBranches = await listOrphanTeamBranches(workspaceRoot, updated.state, signal);

        return {
          isError: false,
          payload: {
            ok: true,
            workspaceRoot,
            ...mergeOutcome,
            orphanBranches,
            task: formatTaskPublicView(updated.state.tasks[task.taskId])
          }
        };
      }

      case 'team_from_protocol': {
        // Pure local fast path — reads `.cabinet/runs/<runKey>/protocol.json` directly!
        const { sessionKey, protocolPath } = resolveCabinetProtocolFile(
          workspaceRoot,
          args.cabinetSessionId
        );

        let protocol;
        try {
          protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
        } catch (err) {
          throw new TeamExecutionError(
            'TEAM_INVALID_PROTOCOL_JSON',
            `无法解析议定书 JSON (${protocolPath})：${err.message}`
          );
        }

        if (protocol?.schemaVersion !== 2) {
          throw new TeamExecutionError(
            'TEAM_INVALID_PROTOCOL_SCHEMA',
            `议定书 schemaVersion 校验失败：期望 2，实际收到 ${JSON.stringify(protocol?.schemaVersion)}。`
          );
        }

        if (!Array.isArray(protocol.actions) || protocol.actions.length === 0) {
          throw new TeamExecutionError(
            'TEAM_EMPTY_PROTOCOL_ACTIONS',
            `议定书 "${sessionKey}" 的 actions[] 为空，无法生成工程施工任务草案。`
          );
        }

        const paths = ensureTeamDirs(workspaceRoot);
        const workflowInputPath = join(paths.workflowInputsDir, `protocol-${sessionKey}.md`);

        const mdLines = [
          `# 内阁议定书施工背景单 (\`${sessionKey}\`)`,
          '',
          `- 来源议定书: \`${protocolPath}\``,
          `- 场景 / 档位: \`${protocol.scene || 'coding'}\` / \`${protocol.tier || 'standard'}\``,
          `- 议题: ${protocol.topic || ''}`,
          `- 结案摘要: ${protocol.brief || ''}`,
          '',
          '## 绑定工程裁决 (`decisions[]`)',
          ...(protocol.decisions || []).map((d, i) => `${i + 1}. ${d}`),
          '',
          '## 少数派保留意见与施工注意项 (`dissent[]`)',
          ...((protocol.dissent && protocol.dissent.length > 0)
            ? protocol.dissent.map((d) => `- ${d}`)
            : ['- (无保留意见)']),
          '',
          '## 行动清单 (`actions[]`)',
          ...protocol.actions.map((a, i) => `${i + 1}. **[${a.due}] (${a.owner})** ${a.item}`)
        ];
        writeFileSync(workflowInputPath, `${mdLines.join('\n')}\n`, 'utf8');

        const draftTasks = protocol.actions.map((act, idx) => {
          const inferred = inferActionTaskType(act);
          return {
            index: idx + 1,
            due: act.due,
            ownerHint: act.owner,
            recommendedType: inferred.type,
            recommendedHard: inferred.hard,
            title: `[${act.due}] ${String(act.item).slice(0, 64)}`,
            task: `${act.item}\n\n请严格遵循共享内阁议定书背景单：${workflowInputPath}`,
            files: [workflowInputPath]
          };
        });

        return {
          isError: false,
          payload: {
            ok: true,
            workspaceRoot,
            cabinetSessionId: sessionKey,
            protocolPath,
            workflowInputPath,
            brief: protocol.brief,
            decisionsCount: (protocol.decisions || []).length,
            dissentCount: (protocol.dissent || []).length,
            draftTasks
          }
        };
      }

      default:
        throw new TeamExecutionError('TEAM_UNKNOWN_TOOL', `未知工具: ${toolName}`);
    }
  } catch (err) {
    if (
      err instanceof TeamExecutionError ||
      err instanceof TeamIsolationError ||
      err instanceof TeamRoutingError ||
      err instanceof TeamApprovalError
    ) {
      return {
        isError: true,
        payload: {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details || {}
          }
        }
      };
    }

    return {
      isError: true,
      payload: {
        ok: false,
        error: {
          code: 'TEAM_INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    };
  }
}
