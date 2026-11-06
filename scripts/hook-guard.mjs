#!/usr/bin/env node
/**
 * Fast-path (< 2ms) PreToolUse Main-Worktree Lease Guard (`hooks.json`).
 *
 * If no workspace holds an active `.team/lease.json`, immediately emits `{"decision":"allow"}`.
 * While an `orca-team` task actively holds the Main-Worktree Exclusive Lease, blocks raw
 * conflicting `orca` worktree/worker mutations so the active task branch cannot be trampled.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function allow() {
  process.stdout.write('{"decision":"allow"}\n');
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({ decision: 'deny', reason })}\n`);
  process.exit(0);
}

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  rawInput += chunk;
});

process.stdin.on('end', () => {
  let payload;
  try {
    payload = rawInput.trim() ? JSON.parse(rawInput) : null;
  } catch {
    allow();
    return;
  }

  const workspaces = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [];
  let activeLease = null;

  for (const ws of workspaces) {
    if (typeof ws !== 'string' || !ws) continue;
    const leasePath = join(ws, '.team', 'lease.json');
    if (!existsSync(leasePath)) continue;
    try {
      const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
      if (!lease || !lease.taskId) continue;
      const statePath = join(ws, '.team', 'state.json');
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        const holder = state?.tasks?.[lease.taskId];
        if (holder && ['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(holder.status)) {
          activeLease = { ...lease, status: holder.status };
          break;
        }
      } else {
        activeLease = { ...lease, status: 'RUNNING' };
        break;
      }
    } catch {
      // Never brick normal work if a stale file is unreadable
    }
  }

  if (!activeLease) {
    allow();
    return;
  }

  const toolName = String(payload?.toolCall?.name ?? '');
  const args = payload?.toolCall?.args ?? payload?.toolCall?.arguments ?? {};

  if (toolName === 'call_mcp_tool') {
    const serverName = String(args.ServerName ?? args.serverName ?? '');
    const innerTool = String(args.ToolName ?? args.toolName ?? '');
    const innerArgs = args.Arguments ?? args.arguments ?? {};

    if (serverName === 'orca') {
      if (
        innerTool === 'orca_agent_launch' ||
        innerTool === 'orca_worktree_create' ||
        innerTool === 'orca_worktree_manage' ||
        (innerTool === 'orca_orchestration_worker' && innerArgs?.action === 'start')
      ) {
        deny(
          `[orca-team] 主工作树独占租约正被在途任务 (${activeLease.taskId}, branch=${activeLease.checkedOutBranch}, status=${activeLease.status}) 持有。` +
            `请勿直接调用 ${innerTool} 干扰工作树；请使用 team_board / team_approve / team_interrupt 管理在途任务。`
        );
        return;
      }
    }
    allow();
    return;
  }

  if (
    toolName === 'mcp_orca_agent_launch' ||
    toolName === 'mcp_orca_worktree_create' ||
    toolName === 'mcp_orca_worktree_manage' ||
    (toolName === 'mcp_orca_orchestration_worker' && args?.action === 'start')
  ) {
    deny(
      `[orca-team] 主工作树独占租约正被在途任务 (${activeLease.taskId}, branch=${activeLease.checkedOutBranch}) 持有。` +
        `请通过 team_* 工具操作，避免破坏在途分支现场。`
    );
    return;
  }

  allow();
});
