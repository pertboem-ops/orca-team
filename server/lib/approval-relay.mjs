import { matchesHighRiskFile } from './facts-snapshot.mjs';
import { captureSensitiveFingerprints, diffFingerprints, execGitSafe, inspectGitWorkspace } from './git-safe.mjs';
import { loadBaselineSnapshot } from './isolation.mjs';
import { execOrca } from './orca-exec.mjs';

export class TeamApprovalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TeamApprovalError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Inspect live uncommitted + branch-committed high-risk diffs AND raw SHA-256 sensitive file fingerprints
 * before allowing `team_approve(decision: "allow")`.
 *
 * Honest scope (`v0.2` Cabinet Decision #1):
 * Relays ONLY Orca mailbox `question` / `escalation` / `decision_gate` and Orca task gates.
 * Does NOT poll `observation.agentWait` and does NOT claim OS-level pre-execution syscall interception.
 */
export async function verifyApprovalSafety({
  workspaceRoot,
  task,
  decision,
  acknowledgeHighRiskDiff = false,
  acknowledgeCriticalTamper = false,
  signal
}) {
  if (decision !== 'allow') {
    return { highRiskFiles: [], tamperedFingerprints: [] };
  }

  // 1. Pre-Git raw SHA-256 fingerprint check
  const baseline = loadBaselineSnapshot(workspaceRoot, task.taskId);
  const currentFp = captureSensitiveFingerprints(workspaceRoot, { includeBackup: false });
  const fpDiff = baseline?.baselineFingerprints
    ? diffFingerprints(baseline.baselineFingerprints, currentFp)
    : { ok: true, changed: [] };

  if (!fpDiff.ok && !acknowledgeCriticalTamper) {
    throw new TeamApprovalError(
      'TEAM_CRITICAL_TAMPER_BLOCKED',
      `反盲批硬拦截：任务 "${task.taskId}" 在请求审批前已篡改敏感配置/钩子文件（${fpDiff.changed.map((c) => c.displayPath).join(', ')}）。请先调用 team_inspect 彻查，严禁盲目放行！`,
      { tamperedFingerprints: fpDiff.changed }
    );
  }

  // 2. Scan live Git changes against `highRiskPatterns`
  const gitState = await inspectGitWorkspace(workspaceRoot, { signal });
  const candidateFiles = new Set([
    ...gitState.status.trackedModified,
    ...gitState.status.untracked
  ]);

  if (gitState.isGitRepo && gitState.gitRoot && task.baseSha) {
    const diffRes = await execGitSafe(['diff', '--name-only', task.baseSha], {
      cwd: gitState.gitRoot,
      signal
    });
    for (const f of diffRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      candidateFiles.add(f);
    }
  }

  const highRiskFiles = [...candidateFiles].filter((f) => matchesHighRiskFile(f)).sort();
  if (highRiskFiles.length > 0 && !acknowledgeHighRiskDiff) {
    throw new TeamApprovalError(
      'TEAM_HIGH_RISK_APPROVAL_CONFIRMATION_REQUIRED',
      `反盲批熔断：子 Agent 在挂起提问前已修改高危敏感文件 [${highRiskFiles.join(', ')}]。请先调用 team_inspect({ taskId: "${task.taskId}", includeFullDiff: true }) 审查完整 Diff，确认无恶意脚本后携带 acknowledgeHighRiskDiff: true 重新调用 team_approve。`,
      { highRiskFiles }
    );
  }

  return {
    highRiskFiles,
    tamperedFingerprints: fpDiff.changed
  };
}

export async function relayApprovalDecision({
  workspaceRoot,
  orcaContext,
  pendingApproval,
  decision,
  reason = '',
  signal
}) {
  const formattedBody =
    decision === 'allow'
      ? `[APPROVED by Team Lead]${reason ? ` ${reason}` : ' Proceed within task boundaries.'}`
      : `[DENIED by Team Lead]${reason ? ` ${reason}` : ' Do not perform this action.'}`;

  if (pendingApproval.kind === 'gate' && pendingApproval.gateId) {
    const gateRes = await execOrca(
      [
        'orchestration',
        'gate-resolve',
        `--gate=${pendingApproval.gateId}`,
        `--decision=${decision === 'allow' ? 'approve' : 'reject'}`,
        ...(reason ? [`--note=${reason}`] : []),
        `--from=${orcaContext.coordinatorHandle}`
      ],
      { cwd: workspaceRoot, timeoutMs: 15_000, signal }
    );
    return {
      ok: gateRes.exitCode === 0,
      channel: 'gate-resolve',
      raw: gateRes.parsed
    };
  }

  if (pendingApproval.messageId) {
    const replyRes = await execOrca(
      [
        'orchestration',
        'reply',
        `--message=${pendingApproval.messageId}`,
        `--body=${formattedBody}`,
        `--from=${orcaContext.coordinatorHandle}`
      ],
      { cwd: workspaceRoot, timeoutMs: 15_000, signal }
    );
    return {
      ok: replyRes.exitCode === 0,
      channel: 'mail-reply',
      raw: replyRes.parsed
    };
  }

  if (pendingApproval.dispatchId) {
    const sendRes = await execOrca(
      [
        'orchestration',
        'send',
        `--to=dispatch:${pendingApproval.dispatchId}`,
        `--body=${formattedBody}`,
        `--from=${orcaContext.coordinatorHandle}`
      ],
      { cwd: workspaceRoot, timeoutMs: 15_000, signal }
    );
    return {
      ok: sendRes.exitCode === 0,
      channel: 'mail-send',
      raw: sendRes.parsed
    };
  }

  throw new TeamApprovalError(
    'TEAM_APPROVAL_CHANNEL_MISSING',
    `挂起请求 "${pendingApproval.requestId}" 缺少有效的 Orca messageId / gateId / dispatchId，无法投递审批回复。`
  );
}
