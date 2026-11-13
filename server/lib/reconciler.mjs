import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  buildAndSaveTaskReference,
  readWorkerAgentReport,
  writeAtomicJsonFile
} from './facts-snapshot.mjs';
import { execGitSafe, findGitLayoutSync } from './git-safe.mjs';
import {
  clearWorkspaceLease,
  ensureTeamDirs,
  getTeamPaths,
  readWorkspaceLease,
  settleWorkspaceAndReleaseLease
} from './isolation.mjs';
import { execOrca, releaseTeamWorker } from './orca-exec.mjs';
import { inspectLiveCliRouting } from './probe.mjs';

function createEmptyProjection() {
  return {
    schemaVersion: 2,
    eventCount: 0,
    updatedAt: null,
    orca: null,
    tasks: {},
    taskOrder: []
  };
}

export function readTeamEvents(workspaceRoot) {
  const { eventsPath } = getTeamPaths(workspaceRoot);
  if (!existsSync(eventsPath)) return [];
  const raw = readFileSync(eventsPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed partial trailing line if interrupted mid-crash
    }
  }
  return events;
}

export function applyEventToState(state, evt) {
  state.eventCount = (state.eventCount || 0) + 1;
  state.updatedAt = evt.timestamp || new Date().toISOString();
  const p = evt.payload || {};

  if (evt.type === 'orca_context_bound') {
    state.orca = { ...(state.orca || {}), ...p };
    return state;
  }

  const taskId = evt.taskId || p.taskId;
  if (!taskId) return state;

  if (!state.tasks[taskId]) {
    state.tasks[taskId] = {
      taskId,
      status: 'QUEUED',
      attempt: 0,
      writerFamilies: [],
      attempts: [],
      approvals: [],
      risk: []
    };
    state.taskOrder.push(taskId);
  }

  const t = state.tasks[taskId];

  switch (evt.type) {
    case 'task_queued':
    case 'task_created': {
      Object.assign(t, p);
      t.writerFamilies = Array.isArray(p.writerFamilies) ? [...p.writerFamilies] : t.writerFamilies || [];
      t.attempts = Array.isArray(p.attempts) ? [...p.attempts] : t.attempts || [];
      t.approvals = Array.isArray(p.approvals) ? [...p.approvals] : t.approvals || [];
      break;
    }
    case 'task_started':
    case 'task_steered': {
      Object.assign(t, p, { status: 'RUNNING', pendingApproval: null });
      if (p.attemptRecord) {
        t.attempts = [...(t.attempts || []), p.attemptRecord];
      }
      if (t.mode === 'write' && p.actualProviderFamily) {
        const famSet = new Set(t.writerFamilies || []);
        famSet.add(p.actualProviderFamily);
        t.writerFamilies = [...famSet];
      }
      break;
    }
    case 'task_awaiting_approval': {
      t.status = 'AWAITING_APPROVAL';
      t.pendingApproval = p.pendingApproval;
      break;
    }
    case 'task_approval_resolved': {
      t.status = 'RUNNING';
      t.approvals = [...(t.approvals || []), p.approvalRecord];
      t.pendingApproval = null;
      break;
    }
    case 'task_reported': {
      Object.assign(t, p, { status: 'REPORTED', pendingApproval: null });
      break;
    }
    case 'task_merged': {
      Object.assign(t, p, { status: 'MERGED', pendingApproval: null });
      break;
    }
    case 'task_discarded': {
      Object.assign(t, p, { status: 'DISCARDED', pendingApproval: null });
      break;
    }
    case 'task_aborted': {
      Object.assign(t, p, { status: 'ABORTED', pendingApproval: null });
      break;
    }
    case 'task_orphaned': {
      Object.assign(t, p, { status: 'ORPHANED' });
      break;
    }
    default: {
      Object.assign(t, p);
    }
  }

  return state;
}

/**
 * Load `.team/state.json` if fresh and intact; otherwise deterministically rebuild it
 * by replaying `.team/events.jsonl` (single source of truth).
 */
export function loadOrRebuildTeamState(workspaceRoot) {
  const { statePath } = getTeamPaths(workspaceRoot);
  const events = readTeamEvents(workspaceRoot);

  if (events.length === 0) {
    return createEmptyProjection();
  }

  if (existsSync(statePath)) {
    try {
      const cached = JSON.parse(readFileSync(statePath, 'utf8'));
      if (cached && cached.schemaVersion === 2 && cached.eventCount === events.length && cached.tasks) {
        return cached;
      }
    } catch {
      // Fall through and rebuild automatically from `events.jsonl`!
    }
  }

  const rebuilt = createEmptyProjection();
  for (const evt of events) {
    applyEventToState(rebuilt, evt);
  }
  ensureTeamDirs(workspaceRoot);
  writeAtomicJsonFile(statePath, rebuilt);
  return rebuilt;
}

export function appendTeamEvent(workspaceRoot, { type, taskId = null, payload = {} }) {
  const paths = ensureTeamDirs(workspaceRoot);
  const state = loadOrRebuildTeamState(workspaceRoot);
  const evt = {
    seq: (state.eventCount || 0) + 1,
    timestamp: new Date().toISOString(),
    type,
    ...(taskId ? { taskId } : {}),
    payload
  };
  appendFileSync(paths.eventsPath, `${JSON.stringify(evt)}\n`, 'utf8');
  applyEventToState(state, evt);
  writeAtomicJsonFile(paths.statePath, state);
  return { event: evt, state };
}

function findActiveTaskByDispatchOrOrcaTask(state, { dispatchId, orcaTaskId }) {
  const tasks = Object.values(state.tasks || {});
  if (dispatchId) {
    const byDisp = tasks.find((t) => t.orcaDispatchId === dispatchId);
    if (byDisp) return byDisp;
  }
  if (orcaTaskId) {
    const byTask = tasks.find((t) => t.orcaTaskId === orcaTaskId);
    if (byTask) return byTask;
  }
  return null;
}

async function finalizeSettledWorkerTask({
  workspaceRoot,
  state,
  task,
  mailBody = '',
  workerExitError = null,
  signal
}) {
  const agentReport = await readWorkerAgentReport({
    reportFilePath: task.reportFilePath,
    dispatchId: task.orcaDispatchId,
    mailBody,
    cwd: workspaceRoot,
    signal
  });

  // Immediately release the Orca worker terminal so zero zombie terminals linger!
  if (task.orcaDispatchId) {
    await releaseTeamWorker(task.orcaDispatchId, { cwd: workspaceRoot, signal });
  }

  // Post-Settle Config-Sandwich TOCTOU Check (`t1`, Red-Team `锋` R1/R2 Deep Fix):
  // If this worker used a `config-inferred` CLI (`pi`/`kimi`/`dsh`/`opencode`), re-read the live
  // local config at `t1`. If the user or a script mutated the local CLI config during the run,
  // downgrade `familyConfidence` to `'unknown'` and poison `writerFamilies` with `'unknown'` so
  // cross-family review fails closed instead of trusting a stale `t0` guess!
  let configDriftedDuringRun = null;
  let effectiveFamilyConfidence = task.familyConfidence;
  let effectiveWriterFamilies = Array.isArray(task.writerFamilies) ? [...task.writerFamilies] : [];

  if (task.familyConfidence === 'config-inferred' && task.cli) {
    const postLive = inspectLiveCliRouting(task.cli, null, workspaceRoot);
    if (
      postLive.actualProviderFamily !== task.actualProviderFamily ||
      postLive.model !== task.model
    ) {
      configDriftedDuringRun = {
        cli: task.cli,
        atDispatch: {
          model: task.model || null,
          actualProviderFamily: task.actualProviderFamily || 'unknown'
        },
        atSettle: {
          model: postLive.model || null,
          actualProviderFamily: postLive.actualProviderFamily || 'unknown'
        }
      };
      effectiveFamilyConfidence = 'unknown';
      if (task.mode === 'write') {
        const unionSet = new Set([
          ...effectiveWriterFamilies,
          task.actualProviderFamily,
          postLive.actualProviderFamily,
          'unknown'
        ]);
        unionSet.delete(null);
        unionSet.delete(undefined);
        unionSet.delete('');
        effectiveWriterFamilies = [...unionSet];
      }
    }
  }

  const targetTaskForReview =
    task.targetTaskId && state.tasks?.[task.targetTaskId] ? state.tasks[task.targetTaskId] : null;

  const settledGit = await settleWorkspaceAndReleaseLease({
    workspaceRoot,
    task,
    targetTaskForReview,
    signal
  });

  const hasUnmergeableExecutableTamper = Boolean(
    settledGit.fpDiff?.hasExecutableTamper || task.hasUnmergeableExecutableTamper
  );

  const effectiveTaskView = {
    ...task,
    familyConfidence: effectiveFamilyConfidence,
    writerFamilies: effectiveWriterFamilies,
    hasUnmergeableExecutableTamper
  };

  const { referencePath, compactSummary, reference } = buildAndSaveTaskReference({
    workspaceRoot,
    task: effectiveTaskView,
    fpDiff: settledGit.fpDiff,
    quarantinedExecutableTamper: settledGit.quarantinedExecutableTamper,
    gatewaySnapshot: settledGit.gatewaySnapshot,
    configDriftedDuringRun,
    changedFiles: settledGit.changedFiles,
    diffStat: settledGit.diffStat,
    untrackedFiles: settledGit.untrackedFiles,
    ignoredArtifacts: settledGit.ignoredArtifacts,
    readonlyDirtiedFiles: settledGit.readonlyDirtiedFiles,
    readonlyDirtyPatch: settledGit.readonlyDirtyPatch,
    reviewedTarget: settledGit.reviewedTarget,
    headSha: settledGit.headSha,
    workerExitError,
    agentReport
  });

  const { state: nextState } = appendTeamEvent(workspaceRoot, {
    type: 'task_reported',
    taskId: task.taskId,
    payload: {
      headSha: settledGit.headSha,
      familyConfidence: effectiveFamilyConfidence,
      writerFamilies: effectiveWriterFamilies,
      hasUnmergeableExecutableTamper,
      risk: reference.risk,
      referencePath,
      compactSummary,
      reportedAt: new Date().toISOString()
    }
  });

  return nextState;
}

export async function listOrphanTeamBranches(workspaceRoot, state, signal) {
  const layout = findGitLayoutSync(workspaceRoot);
  if (!layout.isGitRepo || !layout.gitRoot) return [];

  const brRes = await execGitSafe(['branch', '--list', 'team/*', '--format=%(refname:short)'], {
    cwd: layout.gitRoot,
    signal
  });
  if (brRes.exitCode !== 0 || !brRes.stdout) return [];

  const allBranches = brRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const trackedActiveBranches = new Set(
    Object.values(state.tasks || {})
      .filter((t) => !['MERGED', 'DISCARDED'].includes(t.status) && t.branch)
      .map((t) => t.branch)
  );

  return allBranches.filter((b) => !trackedActiveBranches.has(b));
}

/**
 * Lazy 3-way reconciliation (`events.jsonl` x `Orca` x `Git`):
 * Invoked ONLY on state-sensitive entrypoints (`board`, `delegate`, `delegate_batch`,
 * `approve`, `steer`, `merge`, `interrupt`), never on pure local read tools (`inspect`, `from_protocol`).
 * Short-circuits with ZERO subprocess spawns when no tasks are active and `includeOrphanBranches` is false!
 */
export async function reconcileWorkspace(
  workspaceRoot,
  { waitMs = 0, includeOrphanBranches = false, signal } = {}
) {
  let state = loadOrRebuildTeamState(workspaceRoot);
  const activeTasks = Object.values(state.tasks || {}).filter((t) =>
    ['RUNNING', 'AWAITING_APPROVAL', 'PENDING'].includes(t.status)
  );

  if (state.orca?.coordinatorHandle && activeTasks.length > 0) {
    const checkArgs = ['orchestration', 'check', `--for=${state.orca.coordinatorHandle}`, '--ack'];
    if (waitMs > 0) {
      checkArgs.push('--wait', `--timeout-ms=${Math.max(200, Math.min(waitMs, 55_000))}`);
    }

    const checkRes = await execOrca(checkArgs, {
      cwd: workspaceRoot,
      timeoutMs: Math.max(12_000, waitMs + 8_000),
      signal
    });

    const messages =
      checkRes.parsed?.result?.messages ||
      checkRes.parsed?.result?.items ||
      [];

    for (const msg of messages) {
      const msgType = String(msg.type || msg.kind || '').toLowerCase();
      const dispId = msg.dispatchId || msg.fromDispatchId || msg.sender?.dispatchId || null;
      const orcaTaskId = msg.taskId || null;
      const matchedTask = findActiveTaskByDispatchOrOrcaTask(state, {
        dispatchId: dispId,
        orcaTaskId
      });
      if (!matchedTask || !['RUNNING', 'AWAITING_APPROVAL'].includes(matchedTask.status)) {
        continue;
      }

      if (msgType === 'question' || msgType === 'escalation' || msgType === 'decision_gate') {
        const requestId = msg.id || msg.messageId || `req_${Date.now()}`;
        const updated = appendTeamEvent(workspaceRoot, {
          type: 'task_awaiting_approval',
          taskId: matchedTask.taskId,
          payload: {
            pendingApproval: {
              requestId,
              messageId: msg.id || msg.messageId || null,
              gateId: msg.gateId || null,
              dispatchId: matchedTask.orcaDispatchId,
              kind: msgType === 'decision_gate' && msg.gateId ? 'gate' : 'mail',
              messageType: msgType,
              body: msg.body || msg.text || msg.summary || '',
              createdAt: msg.createdAt || new Date().toISOString()
            }
          }
        });
        state = updated.state;
      } else if (msgType === 'worker_done' || msgType === 'worker_blocked' || msgType === 'task_done') {
        const isBlockedErr =
          msgType === 'worker_blocked' ? msg.body || msg.text || 'Worker reported blocked status' : null;
        state = await finalizeSettledWorkerTask({
          workspaceRoot,
          state,
          task: state.tasks[matchedTask.taskId],
          mailBody: msg.body || msg.text || '',
          workerExitError: isBlockedErr,
          signal
        });
      }
    }
  }

  // Fallback inspection via `worker-show` for any task still marked RUNNING / AWAITING_APPROVAL
  const stillRunning = Object.values(state.tasks || {}).filter((t) =>
    ['RUNNING', 'AWAITING_APPROVAL'].includes(t.status)
  );

  for (const task of stillRunning) {
    if (!task.orcaDispatchId) continue;
    const showRes = await execOrca(
      ['orchestration', 'worker-show', `--dispatch=${task.orcaDispatchId}`],
      { cwd: workspaceRoot, timeoutMs: 10_000, signal }
    );

    if (showRes.exitCode !== 0 || showRes.parsed?.ok === false) {
      const errCode = String(showRes.parsed?.error?.code || '').toLowerCase();
      if (errCode.includes('not_found') || showRes.stderr.toLowerCase().includes('not found')) {
        clearWorkspaceLease(workspaceRoot, task.taskId);
        state = appendTeamEvent(workspaceRoot, {
          type: 'task_orphaned',
          taskId: task.taskId,
          payload: {
            orphanReason: 'orca_dispatch_not_found',
            orphanedAt: new Date().toISOString()
          }
        }).state;
      }
      continue;
    }

    const disp = showRes.parsed?.result?.dispatch || showRes.parsed?.result || {};
    const rawStatus = String(disp.status || disp.state || '').toLowerCase();
    const pendingGate = showRes.parsed?.result?.gate || disp.pendingGate || null;

    if (pendingGate && pendingGate.id && task.status !== 'AWAITING_APPROVAL') {
      state = appendTeamEvent(workspaceRoot, {
        type: 'task_awaiting_approval',
        taskId: task.taskId,
        payload: {
          pendingApproval: {
            requestId: pendingGate.id,
            gateId: pendingGate.id,
            messageId: null,
            dispatchId: task.orcaDispatchId,
            kind: 'gate',
            messageType: 'decision_gate',
            body: pendingGate.reason || pendingGate.title || 'Decision gate pending approval',
            createdAt: new Date().toISOString()
          }
        }
      }).state;
      continue;
    }

    if (['completed', 'succeeded', 'done', 'settled'].includes(rawStatus)) {
      state = await finalizeSettledWorkerTask({
        workspaceRoot,
        state,
        task: state.tasks[task.taskId],
        mailBody: disp.summary || '',
        workerExitError: null,
        signal
      });
    } else if (['failed', 'crashed', 'error', 'stopped', 'cancelled', 'aborted'].includes(rawStatus)) {
      state = await finalizeSettledWorkerTask({
        workspaceRoot,
        state,
        task: state.tasks[task.taskId],
        mailBody: disp.summary || '',
        workerExitError: disp.lastError || disp.error || `Worker exited with status "${rawStatus}"`,
        signal
      });
    }
  }

  // Reconcile stale lease if lease holder is no longer active
  const lease = readWorkspaceLease(workspaceRoot);
  if (lease?.taskId) {
    const holder = state.tasks?.[lease.taskId];
    if (!holder || !['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(holder.status)) {
      clearWorkspaceLease(workspaceRoot, lease.taskId);
    }
  }

  const orphanBranches = includeOrphanBranches
    ? await listOrphanTeamBranches(workspaceRoot, state, signal)
    : [];
  return {
    state,
    lease: readWorkspaceLease(workspaceRoot),
    orphanBranches
  };
}
