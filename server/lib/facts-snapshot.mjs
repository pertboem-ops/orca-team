import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { toPosixRel } from './git-safe.mjs';
import { execOrca } from './orca-exec.mjs';
import { loadTeamRolesConfig } from './probe.mjs';

function globToRegExp(globPattern) {
  const norm = toPosixRel(globPattern);
  let re = '^';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === '*' && norm[i + 1] === '*') {
      if (norm[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if ('\\.[]{}()+-^$|'.includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re, 'i');
}

export function matchesHighRiskFile(relPath, customPatterns = null) {
  const cfg = loadTeamRolesConfig();
  const patterns = customPatterns || cfg.highRiskPatterns || [];
  const norm = toPosixRel(relPath);
  if (!norm) return false;
  return patterns.some((pat) => globToRegExp(pat).test(norm));
}

export function isJunkUntrackedFile(relPath) {
  const cfg = loadTeamRolesConfig();
  const exts = new Set((cfg.junkUntrackedExtensions || []).map((e) => e.toLowerCase()));
  const norm = toPosixRel(relPath);
  const base = basename(norm).toLowerCase();
  const ext = extname(base).toLowerCase();

  if (base === '.ds_store' || base === 'thumbs.db' || base.startsWith('~') || base.endsWith('~')) {
    return true;
  }
  if (exts.has(ext)) {
    return true;
  }
  if (/^(debug|scratch|temp|tmp)[-_.]/.test(base)) {
    return true;
  }
  return false;
}

/**
 * 3-tier lossless worker report extractor:
 * 1. Dedicated `.team/reports/<taskId>-a<attempt>.md` file written by the worker
 * 2. `orca orchestration worker-read --source=auto` structured transcript / terminal tail
 * 3. `worker_done` / `worker_blocked` mailbox body
 */
export async function readWorkerAgentReport({
  reportFilePath,
  dispatchId,
  mailBody = '',
  cwd,
  signal
}) {
  if (reportFilePath && existsSync(reportFilePath)) {
    try {
      const content = readFileSync(reportFilePath, 'utf8').trim();
      if (content.length >= 10) {
        return {
          trustLevel: 'untrusted-self-report',
          captureSource: 'report_file',
          note: '子 Agent 主观自述仅供参考，合并门禁以 facts 与 risk[] 为唯一准绳',
          excerpt: content.slice(0, 420),
          fullText: content
        };
      }
    } catch {}
  }

  let transcriptText = '';
  if (dispatchId) {
    try {
      const readRes = await execOrca(
        ['orchestration', 'worker-read', `--dispatch=${dispatchId}`, '--source=auto', '--limit=50'],
        { cwd, timeoutMs: 12_000, signal }
      );
      const val = readRes.parsed?.result;
      if (val) {
        if (val.source === 'transcript' && Array.isArray(val.transcript?.messages)) {
          const texts = val.transcript.messages
            .filter((m) => m.role === 'assistant' || !m.role)
            .map((m) => {
              if (typeof m.text === 'string') return m.text;
              if (typeof m.content === 'string') return m.content;
              if (Array.isArray(m.content)) {
                return m.content
                  .map((p) => (typeof p === 'string' ? p : p?.text || ''))
                  .join('\n');
              }
              return '';
            })
            .map((t) => t.trim())
            .filter(Boolean);
          if (texts.length > 0) {
            transcriptText = texts.sort((a, b) => b.length - a.length)[0];
          }
        } else if (Array.isArray(val.terminal?.tail)) {
          transcriptText = val.terminal.tail.join('\n').trim();
        }
      }
    } catch {}
  }

  const trimmedMail = String(mailBody || '').trim();
  let bestText = '';
  let captureSource = 'empty';

  if (transcriptText.length > trimmedMail.length && transcriptText.length >= 20) {
    bestText = transcriptText;
    captureSource = 'worker_transcript';
  } else if (trimmedMail.length > 0) {
    bestText = trimmedMail;
    captureSource = 'worker_mail';
  } else if (transcriptText.length > 0) {
    bestText = transcriptText;
    captureSource = 'worker_transcript';
  }

  return {
    trustLevel: 'untrusted-self-report',
    captureSource,
    note: '子 Agent 主观自述仅供参考，合并门禁以 facts 与 risk[] 为唯一准绳',
    excerpt: bestText.slice(0, 420),
    fullText: bestText
  };
}

export function writeAtomicJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Compute deterministic 3-column firewall reference (`.team/references/<taskId>.json`)
 * and `< 500 token` compact summary for the Team Lead.
 */
export function buildAndSaveTaskReference({
  workspaceRoot,
  task,
  fpDiff,
  changedFiles = [],
  diffStat = '',
  untrackedFiles = [],
  ignoredArtifacts = [],
  readonlyDirtiedFiles = [],
  readonlyDirtyPatch = '',
  reviewedTarget = null,
  headSha = null,
  workerExitError = null,
  agentReport
}) {
  const highRiskSet = new Set();
  for (const f of [...changedFiles, ...untrackedFiles, ...readonlyDirtiedFiles]) {
    if (matchesHighRiskFile(f)) {
      highRiskSet.add(f);
    }
  }
  for (const item of fpDiff?.changed || []) {
    if (item.displayPath) {
      highRiskSet.add(item.displayPath);
    }
  }
  const highRiskModifiedFiles = [...highRiskSet].sort();

  const risk = [];
  if (fpDiff && !fpDiff.ok) {
    risk.push('CRITICAL_GIT_OR_ENV_TAMPERED');
  }
  if (highRiskModifiedFiles.length > 0) {
    risk.push('HIGH_RISK_FILE_MODIFIED');
  }
  if (readonlyDirtiedFiles.length > 0) {
    risk.push('READONLY_ROLE_DIRTIED_TREE');
  }
  if (untrackedFiles.length > 0) {
    risk.push('UNTRACKED_ARTIFACTS_LEFT');
  }
  if (ignoredArtifacts.length > 0) {
    risk.push('IGNORED_ARTIFACTS_LEFT');
  }
  if (task.mode === 'write' && changedFiles.length === 0 && !workerExitError) {
    risk.push('NO_EFFECTIVE_DIFF');
  }
  if (workerExitError) {
    risk.push('WORKER_EXIT_WITH_ERROR');
  }

  const referencePath = join(workspaceRoot, '.team', 'references', `${task.taskId}.json`);
  const reference = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    taskId: task.taskId,
    title: task.title,
    type: task.type,
    hard: Boolean(task.hard),
    idempotencyKey: task.idempotencyKey || null,
    role: task.role,
    mode: task.mode,
    attempt: task.attempt || 1,
    cli: task.cli,
    model: task.model,
    actualProviderFamily: task.actualProviderFamily,
    familyConfidence: task.familyConfidence,
    writerFamilies: task.writerFamilies || [],
    crossFamilyVerifiedAgainst: task.crossFamilyVerifiedAgainst || [],
    degradedFrom: task.degradedFrom || null,
    orcaDispatchId: task.orcaDispatchId || null,
    branch: task.branch || null,
    baseBranch: task.baseBranch || null,
    baseSha: task.baseSha || null,
    headSha: headSha || task.headSha || null,
    facts: {
      diffStat: diffStat || '',
      changedFiles,
      untrackedFiles,
      ignoredArtifacts,
      highRiskModifiedFiles,
      tamperedFingerprints: fpDiff?.changed || [],
      readonlyDirtiedFiles,
      ...(readonlyDirtyPatch ? { readonlyDirtyPatch } : {}),
      ...(reviewedTarget ? { reviewedTarget } : {}),
      approvals: task.approvals || [],
      ...(workerExitError ? { workerExitError } : {})
    },
    risk,
    agentReport: agentReport || {
      trustLevel: 'untrusted-self-report',
      captureSource: 'empty',
      note: '子 Agent 主观自述仅供参考，合并门禁以 facts 与 risk[] 为唯一准绳',
      excerpt: '',
      fullText: ''
    }
  };

  writeAtomicJsonFile(referencePath, reference);

  const compactSummary = {
    taskId: task.taskId,
    status: 'REPORTED',
    title: task.title,
    role: task.role,
    mode: task.mode,
    attempt: task.attempt || 1,
    cli: task.cli,
    model: task.model,
    actualProviderFamily: task.actualProviderFamily,
    familyConfidence: task.familyConfidence,
    writerFamilies: task.writerFamilies || [],
    crossFamilyVerifiedAgainst: task.crossFamilyVerifiedAgainst || [],
    degradedFrom: task.degradedFrom || null,
    branch: task.branch || null,
    baseBranch: task.baseBranch || null,
    baseSha: task.baseSha || null,
    headSha: reference.headSha,
    facts: {
      diffStat: reference.facts.diffStat,
      changedFilesCount: changedFiles.length,
      changedFiles: changedFiles.slice(0, 25),
      untrackedFiles,
      ignoredArtifacts,
      highRiskModifiedFiles,
      tamperedFingerprints: reference.facts.tamperedFingerprints,
      readonlyDirtiedFiles
    },
    risk,
    agentReportExcerpt: {
      trustLevel: 'untrusted-self-report',
      captureSource: reference.agentReport.captureSource,
      excerpt: reference.agentReport.excerpt
    },
    referencePath
  };

  return { reference, referencePath, compactSummary };
}
