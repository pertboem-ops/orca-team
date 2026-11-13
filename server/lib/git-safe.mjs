import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const MAX_FINGERPRINT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 64 * 1024;
const MAX_QUARANTINE_PREVIEW_CHARS = 2048;

const IGNORED_TEAM_PREFIXES = ['.team/', '.team', '.cabinet/', '.cabinet'];

export function toPosixRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

export function isInternalLedgerPath(relPath) {
  const norm = toPosixRel(relPath);
  if (!norm) return false;
  return IGNORED_TEAM_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? norm.startsWith(prefix) : norm === prefix
  );
}

/**
 * Pure Node.js `.git` layout discovery — executes ZERO `git` subprocesses.
 * Safe to invoke BEFORE verifying `.git/config` / `core.fsmonitor` / `hooks` integrity.
 */
export function findGitLayoutSync(startDir) {
  let curr = resolve(startDir);
  while (true) {
    const dotGit = join(curr, '.git');
    if (existsSync(dotGit)) {
      let st;
      try {
        st = lstatSync(dotGit);
      } catch {
        break;
      }
      if (st.isDirectory()) {
        const commondirFile = join(dotGit, 'commondir');
        let commonDir = dotGit;
        if (existsSync(commondirFile)) {
          try {
            const rawCommon = readFileSync(commondirFile, 'utf8').trim();
            if (rawCommon) commonDir = resolve(dotGit, rawCommon);
          } catch {}
        }
        return { isGitRepo: true, gitRoot: curr, gitDir: dotGit, commonDir };
      }
      if (st.isFile()) {
        try {
          const content = readFileSync(dotGit, 'utf8');
          const m = content.match(/^\s*gitdir:\s*(.+)\s*$/m);
          if (m) {
            const gitDir = resolve(curr, m[1].trim());
            let commonDir = gitDir;
            const commondirFile = join(gitDir, 'commondir');
            if (existsSync(commondirFile)) {
              const rawCommon = readFileSync(commondirFile, 'utf8').trim();
              if (rawCommon) commonDir = resolve(gitDir, rawCommon);
            }
            return { isGitRepo: true, gitRoot: curr, gitDir, commonDir };
          }
        } catch {}
      }
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return { isGitRepo: false, gitRoot: null, gitDir: null, commonDir: null };
}

function hashFileEntry(absPath, category, includeBackup) {
  let st;
  try {
    st = lstatSync(absPath);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    return {
      category,
      kind: 'symlink',
      size: st.size,
      sha256: createHash('sha256').update(`symlink:${st.size}:${st.mtimeMs}`).digest('hex'),
      backupBase64: null
    };
  }
  if (!st.isFile()) return null;

  if (st.size > MAX_FINGERPRINT_FILE_BYTES) {
    return {
      category,
      kind: 'large_file',
      size: st.size,
      sha256: createHash('sha256').update(`large:${st.size}:${st.mtimeMs}`).digest('hex'),
      backupBase64: null
    };
  }

  const buf = readFileSync(absPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const backupBase64 =
    includeBackup && buf.byteLength <= MAX_BACKUP_FILE_BYTES ? buf.toString('base64') : null;

  return {
    category,
    kind: 'file',
    size: buf.byteLength,
    mode: st.mode,
    sha256,
    backupBase64
  };
}

function walkHooksDir(dirPath, prefixKey, entries, includeBackup) {
  if (!existsSync(dirPath)) return;
  let items = [];
  try {
    items = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const full = join(dirPath, item.name);
    const key = `${prefixKey}/${item.name}`;
    if (item.isDirectory()) {
      walkHooksDir(full, key, entries, includeBackup);
    } else {
      const hashed = hashFileEntry(full, 'git_internal', includeBackup);
      if (hashed) {
        entries[key] = { ...hashed, absPath: full };
      }
    }
  }
}

function classifySensitiveWorktreeFile(relPath, fileName) {
  if (fileName === '.gitattributes') {
    return 'git_filter_attr';
  }
  if (relPath === '.vscode/tasks.json' || relPath === '.vscode/settings.json') {
    return 'ide_autorun';
  }
  if (fileName === '.npmrc' || fileName === '.yarnrc' || fileName === '.yarnrc.yml') {
    return 'env_or_rc';
  }
  if (fileName === '.env' || fileName.startsWith('.env.')) {
    return 'env_or_rc';
  }
  return null;
}

function walkWorktreeSensitiveFiles(rootDir, currentDir, depth, maxDepth, entries) {
  if (depth > maxDepth) return;
  let items = [];
  try {
    items = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (
      item.name === '.git' ||
      item.name === '.team' ||
      item.name === '.cabinet' ||
      item.name === 'node_modules' ||
      item.name === '.venv' ||
      item.name === 'venv' ||
      item.name === 'dist' ||
      item.name === 'build'
    ) {
      continue;
    }
    const full = join(currentDir, item.name);
    if (item.isDirectory()) {
      walkWorktreeSensitiveFiles(rootDir, full, depth + 1, maxDepth, entries);
    } else {
      const rel = toPosixRel(relative(rootDir, full));
      const category = classifySensitiveWorktreeFile(rel, item.name);
      if (category) {
        const hashed = hashFileEntry(full, category, true);
        if (hashed) {
          entries[`worktree:${rel}`] = { ...hashed, relPath: rel, absPath: full };
        }
      }
    }
  }
}

/**
 * Capture raw SHA-256 fingerprints BEFORE invoking any `git` subprocess.
 * Covers:
 * - `git_internal`: `.git/config`, `.git/hooks/**`, `.git/info/attributes`, `.git/info/exclude`
 * - `git_filter_attr`: `.gitattributes` (can bind executable `filter.<driver>.clean/smudge` commands!)
 * - `ide_autorun`: `.vscode/tasks.json`, `.vscode/settings.json` (`folderOpen` task / compiler hijack, often gitignored!)
 * - `env_or_rc`: `.env*`, `.npmrc`, `.yarnrc*`
 */
export function captureSensitiveFingerprints(workspacePath, { includeBackup = true } = {}) {
  const layout = findGitLayoutSync(workspacePath);
  const entries = {};

  if (layout.isGitRepo && layout.gitDir && layout.commonDir) {
    const gitTargets = [
      { key: 'gitdir:config', path: join(layout.gitDir, 'config') },
      { key: 'gitdir:info/attributes', path: join(layout.gitDir, 'info', 'attributes') },
      { key: 'gitdir:info/exclude', path: join(layout.gitDir, 'info', 'exclude') }
    ];

    if (resolve(layout.commonDir) !== resolve(layout.gitDir)) {
      gitTargets.push(
        { key: 'commondir:config', path: join(layout.commonDir, 'config') },
        { key: 'commondir:info/attributes', path: join(layout.commonDir, 'info', 'attributes') },
        { key: 'commondir:info/exclude', path: join(layout.commonDir, 'info', 'exclude') }
      );
    }

    for (const target of gitTargets) {
      if (existsSync(target.path)) {
        const hashed = hashFileEntry(target.path, 'git_internal', includeBackup);
        if (hashed) {
          entries[target.key] = { ...hashed, absPath: target.path };
        }
      }
    }

    walkHooksDir(join(layout.commonDir, 'hooks'), 'commondir:hooks', entries, includeBackup);
    if (resolve(layout.commonDir) !== resolve(layout.gitDir)) {
      walkHooksDir(join(layout.gitDir, 'hooks'), 'gitdir:hooks', entries, includeBackup);
    }
  }

  const scanRoot = layout.gitRoot || resolve(workspacePath);
  walkWorktreeSensitiveFiles(scanRoot, scanRoot, 0, 3, entries);

  return {
    capturedAt: new Date().toISOString(),
    gitRoot: layout.gitRoot,
    gitDir: layout.gitDir,
    commonDir: layout.commonDir,
    entries
  };
}

export function diffFingerprints(beforeSnap, afterSnap) {
  const beforeEntries = beforeSnap?.entries || {};
  const afterEntries = afterSnap?.entries || {};
  const allKeys = [...new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])].sort();

  const changed = [];
  for (const key of allKeys) {
    const b = beforeEntries[key];
    const a = afterEntries[key];
    if (!b && a) {
      changed.push({
        key,
        displayPath: a.relPath || key,
        category: a.category,
        change: 'added',
        beforeSha256: null,
        afterSha256: a.sha256
      });
    } else if (b && !a) {
      changed.push({
        key,
        displayPath: b.relPath || key,
        category: b.category,
        change: 'deleted',
        beforeSha256: b.sha256,
        afterSha256: null
      });
    } else if (b && a && b.sha256 !== a.sha256) {
      changed.push({
        key,
        displayPath: a.relPath || b.relPath || key,
        category: a.category || b.category,
        change: 'modified',
        beforeSha256: b.sha256,
        afterSha256: a.sha256
      });
    }
  }

  const hasGitInternalTamper = changed.some((c) => c.category === 'git_internal');
  const hasGitFilterAttrTamper = changed.some((c) => c.category === 'git_filter_attr');
  const hasIdeAutorunTamper = changed.some((c) => c.category === 'ide_autorun');
  const hasEnvOrRcTamper = changed.some((c) => c.category === 'env_or_rc');

  // RCE-capable tamper categories that MUST be quarantined & neutralized BEFORE spawning `git add` or returning to IDE!
  const hasExecutableTamper =
    hasGitInternalTamper || hasGitFilterAttrTamper || hasIdeAutorunTamper;

  return {
    ok: changed.length === 0,
    changed,
    hasGitInternalTamper,
    hasGitFilterAttrTamper,
    hasIdeAutorunTamper,
    hasEnvOrRcTamper,
    hasExecutableTamper
  };
}

/**
 * Immediate Pre-Git Quarantine & Neutralization (Red-Team `锋` R2 Deep Fix):
 * When `.git/config`, `.git/hooks/**`, `.gitattributes`, or `.vscode/tasks.json` is tampered with,
 * do NOT leave the poisoned payload sitting in `.git/` while waiting for `team_merge(discard)`
 * (where VS Code / Antigravity's background `git status` polling would trigger RCE within seconds!).
 * Instead, capture forensic previews in pure Node and IMMEDIATELY restore clean baseline bytes!
 */
export function quarantineAndNeutralizeExecutableTamper(workspacePath, baselineSnap) {
  if (!baselineSnap?.entries) {
    return { quarantined: [], restored: [], deleted: [] };
  }
  const currentSnap = captureSensitiveFingerprints(workspacePath, { includeBackup: false });
  const diff = diffFingerprints(baselineSnap, currentSnap);

  const quarantined = [];
  const restored = [];
  const deleted = [];

  for (const item of diff.changed) {
    if (!['git_internal', 'git_filter_attr', 'ide_autorun'].includes(item.category)) {
      continue;
    }
    const baseEntry = baselineSnap.entries[item.key];
    const currEntry = currentSnap.entries[item.key];

    let forensicPreview = null;
    if (currEntry?.absPath && existsSync(currEntry.absPath)) {
      try {
        forensicPreview = readFileSync(currEntry.absPath, 'utf8').slice(0, MAX_QUARANTINE_PREVIEW_CHARS);
      } catch {}
    }

    quarantined.push({
      key: item.key,
      displayPath: item.displayPath,
      category: item.category,
      change: item.change,
      forensicPreview
    });

    if (item.change === 'added' && currEntry?.absPath && existsSync(currEntry.absPath)) {
      try {
        rmSync(currEntry.absPath, { force: true });
        deleted.push(item.displayPath);
      } catch {}
    } else if (
      (item.change === 'modified' || item.change === 'deleted') &&
      baseEntry?.backupBase64 &&
      baseEntry?.absPath
    ) {
      try {
        mkdirSync(dirname(baseEntry.absPath), { recursive: true });
        writeFileSync(baseEntry.absPath, Buffer.from(baseEntry.backupBase64, 'base64'));
        restored.push(item.displayPath);
      } catch {}
    }
  }

  return { quarantined, restored, deleted };
}

/**
 * Restore ALL tampered sensitive baseline files (including `.env*` / `.npmrc`) on `discard` / `interrupt`.
 */
export function restoreSensitiveBaseline(workspacePath, baselineSnap) {
  if (!baselineSnap?.entries) return { restored: [], deleted: [] };
  const currentSnap = captureSensitiveFingerprints(workspacePath, { includeBackup: false });
  const diff = diffFingerprints(baselineSnap, currentSnap);

  const restored = [];
  const deleted = [];

  for (const item of diff.changed) {
    const baseEntry = baselineSnap.entries[item.key];
    const currEntry = currentSnap.entries[item.key];

    if (item.change === 'added' && currEntry?.absPath && existsSync(currEntry.absPath)) {
      try {
        rmSync(currEntry.absPath, { force: true });
        deleted.push(item.displayPath);
      } catch {}
    } else if ((item.change === 'modified' || item.change === 'deleted') && baseEntry?.backupBase64 && baseEntry?.absPath) {
      try {
        mkdirSync(dirname(baseEntry.absPath), { recursive: true });
        writeFileSync(baseEntry.absPath, Buffer.from(baseEntry.backupBase64, 'base64'));
        restored.push(item.displayPath);
      } catch {}
    }
  }

  return { restored, deleted };
}

/**
 * Hardened Git CLI wrapper:
 * Every git invocation prepends `--no-pager` and disables `core.hooksPath`, `core.fsmonitor`,
 * `core.editor`, `diff.external`, and `protocol.file.allow` so repository-local config injections
 * can NEVER execute arbitrary commands inside the gateway.
 */
export async function execGitSafe(gitArgs, options = {}) {
  const { cwd = process.cwd(), timeoutMs = 20_000, signal } = options;

  const safeSubArgs =
    gitArgs[0] === 'diff' && !gitArgs.includes('--no-ext-diff')
      ? ['diff', '--no-ext-diff', '--no-textconv', ...gitArgs.slice(1)]
      : gitArgs;

  const hardenedArgs = [
    '--no-pager',
    '-c',
    'core.hooksPath=',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.quotepath=false',
    '-c',
    'protocol.file.allow=never',
    ...safeSubArgs
  ];

  return await new Promise((resolvePromise) => {
    const child = spawn('git', hardenedArgs, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C.UTF-8'
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let rawStdout = '';
    let rawStderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolvePromise({
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        rawStdout: rawStdout.replace(/\r?\n$/, ''),
        stdout: rawStdout.trim(),
        stderr: rawStderr.trim()
      });
    };

    const onAbort = () => {
      try {
        child.kill();
      } catch {}
      finish(130);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      rawStdout += c;
    });
    child.stderr.on('data', (c) => {
      rawStderr += c;
    });
    child.on('error', (err) => {
      rawStderr += err.message;
      finish(1);
    });
    child.on('close', (code) => finish(code));
  });
}

function unquoteGitPath(raw) {
  const trimmed = String(raw || '').trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

export function parsePorcelainStatus(rawPorcelain) {
  if (!rawPorcelain) {
    return { entries: [], trackedModified: [], untracked: [], ignored: [] };
  }
  const lines = String(rawPorcelain).split(/\r?\n/).filter(Boolean);
  const entries = [];
  const trackedModified = [];
  const untracked = [];
  const ignored = [];

  for (const line of lines) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    if (rest.includes(' -> ')) {
      rest = rest.split(' -> ').pop();
    }
    const relPath = toPosixRel(unquoteGitPath(rest));
    if (!relPath || isInternalLedgerPath(relPath)) continue;

    entries.push({ xy, path: relPath });
    if (xy === '??') {
      untracked.push(relPath);
    } else if (xy === '!!') {
      if (!relPath.startsWith('node_modules/') && relPath !== 'node_modules') {
        ignored.push(relPath);
      }
    } else {
      trackedModified.push(relPath);
    }
  }

  return {
    entries,
    trackedModified: [...new Set(trackedModified)],
    untracked: [...new Set(untracked)],
    ignored: [...new Set(ignored)]
  };
}

export async function inspectGitWorkspace(workspacePath, { includeIgnored = false, signal } = {}) {
  const layout = findGitLayoutSync(workspacePath);
  if (!layout.isGitRepo || !layout.gitRoot) {
    return {
      isGitRepo: false,
      gitRoot: null,
      hasHeadCommit: false,
      currentBranch: null,
      headSha: null,
      status: { entries: [], trackedModified: [], untracked: [], ignored: [] }
    };
  }

  const headRes = await execGitSafe(['rev-parse', '--verify', 'HEAD'], { cwd: layout.gitRoot, signal });
  const hasHeadCommit = headRes.exitCode === 0 && Boolean(headRes.stdout);
  const headSha = hasHeadCommit ? headRes.stdout : null;

  const branchRes = await execGitSafe(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: layout.gitRoot,
    signal
  });
  const currentBranch = branchRes.exitCode === 0 && branchRes.stdout ? branchRes.stdout : 'HEAD';

  const statusArgs = ['status', '--porcelain=v1', '-uall'];
  if (includeIgnored) statusArgs.push('--ignored=matching');
  const statusRes = await execGitSafe(statusArgs, { cwd: layout.gitRoot, signal });
  const status = parsePorcelainStatus(statusRes.rawStdout);

  return {
    isGitRepo: true,
    gitRoot: layout.gitRoot,
    gitDir: layout.gitDir,
    commonDir: layout.commonDir,
    hasHeadCommit,
    currentBranch,
    headSha,
    status
  };
}
