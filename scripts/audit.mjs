#!/usr/bin/env node
/**
 * Offline `.team/` ledger integrity, projection consistency, lease health,
 * and orphan `team/*` branch auditor (`npm run audit -- --workspace <dir>`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTeamPaths, readWorkspaceLease } from '../server/lib/isolation.mjs';
import {
  applyEventToState,
  listOrphanTeamBranches,
  readTeamEvents
} from '../server/lib/reconciler.mjs';

export async function auditWorkspaceTeamLedger(workspaceRoot) {
  const absRoot = resolve(workspaceRoot);
  const paths = getTeamPaths(absRoot);
  const errors = [];
  const warnings = [];

  if (!existsSync(paths.teamDir)) {
    return {
      ok: true,
      workspaceRoot: absRoot,
      initialized: false,
      eventsCount: 0,
      tasksCount: 0,
      orphanBranches: [],
      errors: [],
      warnings: []
    };
  }

  const events = readTeamEvents(absRoot);
  const replayed = {
    schemaVersion: 2,
    eventCount: 0,
    updatedAt: null,
    orca: null,
    tasks: {},
    taskOrder: []
  };

  let prevSeq = 0;
  for (const evt of events) {
    if (evt.seq !== prevSeq + 1) {
      errors.push(`Event sequence gap/mismatch: expected seq=${prevSeq + 1}, got seq=${evt.seq}`);
    }
    prevSeq = evt.seq || prevSeq + 1;
    applyEventToState(replayed, evt);
  }

  if (existsSync(paths.statePath)) {
    try {
      const cached = JSON.parse(readFileSync(paths.statePath, 'utf8'));
      if (cached.eventCount !== events.length) {
        warnings.push(
          `state.json eventCount (${cached.eventCount}) lags events.jsonl (${events.length}); will auto-rebuild on next tool call.`
        );
      }
    } catch (err) {
      warnings.push(`state.json is malformed (${err.message}); will auto-rebuild from events.jsonl.`);
    }
  }

  const lease = readWorkspaceLease(absRoot);
  if (lease?.taskId) {
    const holder = replayed.tasks[lease.taskId];
    if (!holder) {
      errors.push(`Active lease points to unknown taskId "${lease.taskId}".`);
    } else if (!['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(holder.status)) {
      warnings.push(
        `Stale lease held by settled task "${lease.taskId}" (status=${holder.status}); will clear on next reconcile.`
      );
    }
  }

  for (const task of Object.values(replayed.tasks)) {
    if (['REPORTED', 'MERGED'].includes(task.status)) {
      if (!task.referencePath || !existsSync(task.referencePath)) {
        errors.push(`Task "${task.taskId}" (${task.status}) is missing reference snapshot file.`);
      } else {
        try {
          const ref = JSON.parse(readFileSync(task.referencePath, 'utf8'));
          if (ref.schemaVersion !== 2) {
            errors.push(`Reference for "${task.taskId}" has invalid schemaVersion=${ref.schemaVersion}.`);
          }
          if (ref.agentReport?.trustLevel !== 'untrusted-self-report') {
            errors.push(`Reference for "${task.taskId}" missing untrusted-self-report marker.`);
          }
        } catch (err) {
          errors.push(`Reference JSON for "${task.taskId}" is corrupt: ${err.message}`);
        }
      }
    }
  }

  const orphanBranches = await listOrphanTeamBranches(absRoot, replayed);
  if (orphanBranches.length > 0) {
    warnings.push(`Detected ${orphanBranches.length} unreferenced team/* branch(es): ${orphanBranches.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    workspaceRoot: absRoot,
    initialized: true,
    eventsCount: events.length,
    tasksCount: Object.keys(replayed.tasks).length,
    activeLease: lease,
    orphanBranches,
    errors,
    warnings
  };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase().endsWith('audit.mjs')) {
  const argv = process.argv.slice(2);
  let targetWs = process.cwd();
  const wsIdx = argv.indexOf('--workspace');
  if (wsIdx !== -1 && argv[wsIdx + 1]) {
    targetWs = argv[wsIdx + 1];
  }
  const report = await auditWorkspaceTeamLedger(targetWs);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
