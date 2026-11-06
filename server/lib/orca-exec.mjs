import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGitLayoutSync } from './git-safe.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_TEAM_COORDINATOR_TITLE = 'Orca Team Coordinator';

export function resolveOrcaExecutable() {
  if (process.env.ORCA_CLI_PATH && existsSync(process.env.ORCA_CLI_PATH)) {
    return process.env.ORCA_CLI_PATH;
  }

  const exeName = process.platform === 'win32' ? 'orca.exe' : 'orca';

  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ||
      join(process.env.USERPROFILE || process.env.HOME || homedir(), 'AppData', 'Local');
    const winDefault = join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe');
    if (existsSync(winDefault)) {
      return winDefault;
    }
  } else if (process.platform === 'darwin') {
    const macDefault = '/Applications/Orca.app/Contents/Resources/bin/orca';
    if (existsSync(macDefault)) {
      return macDefault;
    }
  } else {
    for (const candidate of ['/usr/local/bin/orca', '/usr/bin/orca']) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const siblingBin = resolve(__dirname, '..', '..', '..', 'resources', 'bin', exeName);
  if (existsSync(siblingBin)) {
    return siblingBin;
  }

  return exeName;
}

export function buildCleanOrcaEnv() {
  const env = { ...process.env };
  delete env.ORCA_AGENT_SESSION_ID;
  delete env.ORCA_AGENT_SESSION_SPAWN_TOKEN;
  delete env.ORCA_STRUCTURED_SESSION;
  delete env.ORCA_TERMINAL_HANDLE;
  delete env.ORCA_PANE_KEY;
  return env;
}

export function pushFlag(argv, name, value) {
  if (value === undefined || value === null || value === false || value === '') {
    return;
  }
  if (value === true) {
    argv.push(`--${name}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== undefined && item !== null && item !== '') {
        argv.push(`--${name}=${String(item)}`);
      }
    }
    return;
  }
  argv.push(`--${name}=${String(value)}`);
}

export function normalizeWorktreeRef(wt) {
  if (!wt || typeof wt !== 'string') return wt;
  if (
    !wt.startsWith('id:') &&
    !wt.startsWith('path:') &&
    !wt.startsWith('name:') &&
    !wt.startsWith('branch:') &&
    !wt.startsWith('folder:') &&
    !wt.startsWith('worktree:') &&
    wt !== 'active' &&
    wt !== 'current' &&
    wt !== 'new-child' &&
    wt !== 'new-top-level' &&
    wt.includes('::')
  ) {
    return `id:${wt}`;
  }
  return wt;
}

function filterKeepaliveStderr(stderr) {
  if (!stderr) return '';
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('{') && (trimmed.includes('"_keepalive"') || trimmed.includes('"_heartbeat"'))) {
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();
}

export async function execOrca(commandArgs, options = {}) {
  const {
    json = true,
    timeoutMs = 60_000,
    cwd = process.cwd(),
    signal,
    stdinText
  } = options;

  const orcaBin = resolveOrcaExecutable();
  const finalArgs = [...commandArgs];
  if (json && !finalArgs.includes('--json') && !finalArgs.includes('--version') && !finalArgs.includes('--help')) {
    finalArgs.push('--json');
  }

  const isJsScript = /\.(mjs|cjs|js)$/i.test(orcaBin);
  const spawnBin = isJsScript ? process.execPath : orcaBin;
  const spawnArgs = isJsScript ? [orcaBin, ...finalArgs] : finalArgs;

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      env: buildCleanOrcaEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolvePromise(outcome);
    };

    const onAbort = () => {
      try {
        child.kill();
      } catch {}
      finish({
        exitCode: 130,
        aborted: true,
        timedOut: false,
        stdout,
        stderr,
        parsed: null
      });
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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      rejectPromise(new Error(`Failed to spawn Orca CLI at "${orcaBin}": ${err.message}`));
    });

    child.on('close', (code) => {
      const trimmedOut = stdout.trim();
      let parsed = null;
      if (json && trimmedOut.length > 0) {
        try {
          parsed = JSON.parse(trimmedOut);
        } catch {
          parsed = null;
        }
      }
      finish({
        exitCode: code ?? (timedOut ? 124 : 1),
        aborted: false,
        timedOut,
        stdout: trimmedOut,
        stderr: filterKeepaliveStderr(stderr),
        parsed
      });
    });

    if (typeof stdinText === 'string') {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function normalizePathForCompare(p) {
  if (!p) return '';
  const resolved = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function findMatchingWorktree(worktrees, candidatePaths) {
  if (!Array.isArray(worktrees)) return null;
  const targets = new Set(candidatePaths.filter(Boolean).map(normalizePathForCompare));
  for (const wt of worktrees) {
    const wtPath =
      wt?.path ||
      wt?.worktreePath ||
      (typeof wt?.id === 'string' && wt.id.includes('::') ? wt.id.split('::')[1] : '');
    if (wtPath && targets.has(normalizePathForCompare(wtPath))) {
      return wt;
    }
  }
  return null;
}

/**
 * Ensure Orca runtime is reachable. On Windows, never spawn `orca open` with piped stdio
 * (Electron inherits pipes and hangs forever); always use `detached: true, stdio: 'ignore'`
 * and poll `orca status`.
 */
export async function ensureOrcaReady({ launchIfStopped = true, signal } = {}) {
  const statusRes = await execOrca(['status'], { timeoutMs: 8_000, signal });
  const isReachable =
    statusRes.exitCode === 0 &&
    statusRes.parsed?.ok === true &&
    statusRes.parsed?.result?.runtime?.reachable === true;

  if (isReachable) {
    return {
      ready: true,
      launched: false,
      runtimeId: statusRes.parsed?._meta?.runtimeId ?? statusRes.parsed?.result?.runtime?.runtimeId ?? null,
      status: statusRes.parsed.result
    };
  }

  if (!launchIfStopped) {
    return {
      ready: false,
      launched: false,
      error: statusRes.parsed?.error?.message || statusRes.stderr || 'Orca runtime is not running.'
    };
  }

  const orcaBin = resolveOrcaExecutable();
  const isJsScript = /\.(mjs|cjs|js)$/i.test(orcaBin);
  const spawnBin = isJsScript ? process.execPath : orcaBin;
  const spawnArgs = isJsScript ? [orcaBin, 'serve', '--no-pairing'] : ['open'];

  try {
    const launcher = spawn(spawnBin, spawnArgs, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: buildCleanOrcaEnv()
    });
    launcher.unref();
  } catch (err) {
    throw new Error(`Orca runtime could not be started: ${err instanceof Error ? err.message : String(err)}`);
  }

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Aborted while waiting for Orca runtime to start.');
    }
    await new Promise((r) => setTimeout(r, 1200));
    const pollRes = await execOrca(['status'], { timeoutMs: 5_000, signal });
    if (
      pollRes.exitCode === 0 &&
      pollRes.parsed?.ok === true &&
      pollRes.parsed?.result?.runtime?.reachable === true
    ) {
      return {
        ready: true,
        launched: true,
        runtimeId: pollRes.parsed?._meta?.runtimeId ?? pollRes.parsed?.result?.runtime?.runtimeId ?? null,
        status: pollRes.parsed.result
      };
    }
  }
  throw new Error('Orca runtime could not be started within 45s timeout.');
}

export async function ensureTeamCoordinator(workspacePath, { existingOrca = null, signal } = {}) {
  const absWorkspace = resolve(workspacePath);
  const readyInfo = await ensureOrcaReady({ launchIfStopped: true, signal });
  const layout = findGitLayoutSync(absWorkspace);
  const targetRepoPath = layout.gitRoot || absWorkspace;

  let wtListRes = await execOrca(['worktree', 'list', '--limit=100'], { cwd: absWorkspace, signal });
  let worktrees = wtListRes.parsed?.result?.worktrees ?? [];
  let match = findMatchingWorktree(worktrees, [absWorkspace, targetRepoPath]);

  if (!match) {
    await execOrca(['repo', 'add', `--path=${targetRepoPath}`], { cwd: absWorkspace, signal });
    await execOrca(
      ['repo', 'set', `--repo=path:${targetRepoPath}`, '--external-worktree-visibility=show'],
      { cwd: absWorkspace, signal }
    );
    wtListRes = await execOrca(['worktree', 'list', '--limit=100'], { cwd: absWorkspace, signal });
    worktrees = wtListRes.parsed?.result?.worktrees ?? [];
    match = findMatchingWorktree(worktrees, [absWorkspace, targetRepoPath]);
  }

  const worktreeSelector = normalizeWorktreeRef(match?.id ? `id:${match.id}` : `path:${targetRepoPath}`);
  const worktreePath = match?.path || targetRepoPath;

  const listRes = await execOrca(['terminal', 'list', `--worktree=${worktreeSelector}`], {
    cwd: absWorkspace,
    signal
  });
  const terminals = listRes.parsed?.result?.terminals ?? [];

  let coordinatorHandle = null;
  if (
    existingOrca?.coordinatorHandle &&
    terminals.some((t) => t.connected && t.handle === existingOrca.coordinatorHandle)
  ) {
    coordinatorHandle = existingOrca.coordinatorHandle;
  } else {
    const existing = terminals.find((t) => t.connected && t.title === DEFAULT_TEAM_COORDINATOR_TITLE && t.handle);
    if (existing) {
      coordinatorHandle = existing.handle;
    } else {
      const createRes = await execOrca(
        ['terminal', 'create', `--worktree=${worktreeSelector}`, `--title=${DEFAULT_TEAM_COORDINATOR_TITLE}`],
        { cwd: absWorkspace, signal }
      );
      coordinatorHandle = createRes.parsed?.result?.terminal?.handle ?? null;
      if (!coordinatorHandle) {
        const detail = createRes.parsed?.error?.message || createRes.stderr || createRes.stdout || 'Unknown error';
        throw new Error(`Failed to provision ${DEFAULT_TEAM_COORDINATOR_TITLE} in ${worktreeSelector}: ${detail}`);
      }
    }
  }

  let orcaRunId = existingOrca?.orcaRunId ?? null;
  if (orcaRunId) {
    const runShowRes = await execOrca(['orchestration', 'run-show', `--run=${orcaRunId}`], {
      cwd: absWorkspace,
      timeoutMs: 8_000,
      signal
    });
    const runStatus = runShowRes.parsed?.result?.run?.status;
    if (runShowRes.exitCode !== 0 || runStatus === 'cancelled' || runStatus === 'completed') {
      orcaRunId = null;
    }
  }

  if (!orcaRunId) {
    const runRes = await execOrca(
      [
        'orchestration',
        'run-create',
        `--objective=[Orca Team] Controlled engineering gateway for ${targetRepoPath}`,
        `--from=${coordinatorHandle}`
      ],
      { cwd: absWorkspace, signal }
    );
    orcaRunId = runRes.parsed?.result?.run?.id ?? null;
    if (!orcaRunId) {
      const detail = runRes.parsed?.error?.message || runRes.stderr || runRes.stdout || 'Unknown error';
      throw new Error(`Failed to create Orca Orchestration Run: ${detail}`);
    }
  }

  return {
    orcaRuntimeId: readyInfo.runtimeId,
    worktreeSelector,
    worktreeId: match?.id ?? null,
    worktreePath,
    coordinatorHandle,
    orcaRunId
  };
}

/**
 * `dsh-tui v0.16.1` holds large (>4KB) bracketed-paste briefings in `terminal.draft`
 * waiting for an explicit Enter keystroke. Detect and nudge once automatically.
 */
export async function nudgeDshDraftIfNeeded({ dispatchId, cwd, signal }) {
  const delayMs =
    process.env.ORCA_TEAM_DSH_NUDGE_DELAY_MS !== undefined
      ? Number(process.env.ORCA_TEAM_DSH_NUDGE_DELAY_MS)
      : 2200;

  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (signal?.aborted) return { nudged: false };

  const readRes = await execOrca(
    ['orchestration', 'worker-read', `--dispatch=${dispatchId}`, '--source=auto', '--limit=5'],
    { cwd, timeoutMs: 8_000, signal }
  );
  const draft = readRes.parsed?.result?.terminal?.draft;
  if (typeof draft !== 'string' || draft.trim().length === 0) {
    return { nudged: false };
  }

  const showRes = await execOrca(['orchestration', 'worker-show', `--dispatch=${dispatchId}`], {
    cwd,
    timeoutMs: 8_000,
    signal
  });
  const dispatchObj = showRes.parsed?.result?.dispatch || {};
  const terminalHandle =
    dispatchObj.terminalHandle ||
    dispatchObj.handle ||
    readRes.parsed?.result?.terminal?.handle ||
    null;

  if (!terminalHandle) {
    return { nudged: false, reason: 'missing_terminal_handle' };
  }

  const sendRes = await execOrca(['terminal', 'send', `--terminal=${terminalHandle}`, '--enter'], {
    cwd,
    timeoutMs: 8_000,
    signal
  });
  return { nudged: sendRes.exitCode === 0, terminalHandle };
}

export async function spawnTeamWorker({
  orcaContext,
  taskTitle,
  briefingText,
  cli,
  model,
  effort,
  passModelFlag,
  passEffortFlag,
  cwd,
  signal
}) {
  const argv = ['orchestration', 'worker-start'];
  pushFlag(argv, 'spec', briefingText);
  pushFlag(argv, 'task-title', taskTitle);
  pushFlag(argv, 'worktree', orcaContext.worktreeSelector || 'current');
  pushFlag(argv, 'agent', cli);
  if (passModelFlag && model) {
    pushFlag(argv, 'model', model);
  }
  if (passEffortFlag && effort) {
    pushFlag(argv, 'effort', effort);
  }
  pushFlag(argv, 'run', orcaContext.orcaRunId);
  pushFlag(argv, 'from', orcaContext.coordinatorHandle);

  const res = await execOrca(argv, {
    cwd: orcaContext.worktreePath || cwd,
    timeoutMs: 90_000,
    signal
  });

  const val = res.parsed?.result;
  const dispatchId = val?.dispatchId ?? null;
  const orcaTaskId = val?.taskId ?? null;
  const ready = res.exitCode === 0 && val?.state === 'ready' && Boolean(dispatchId);

  if (!ready) {
    return {
      ok: false,
      dispatchId: null,
      orcaTaskId: null,
      error: val?.lastError || res.parsed?.error?.message || res.stderr || res.stdout || `exit ${res.exitCode}`
    };
  }

  let dshNudge = null;
  if (cli === 'dsh') {
    dshNudge = await nudgeDshDraftIfNeeded({
      dispatchId,
      cwd: orcaContext.worktreePath || cwd,
      signal
    });
  }

  return {
    ok: true,
    dispatchId,
    orcaTaskId,
    modeDetail: val?.mode?.detail || 'terminal-worker',
    dshNudge
  };
}

export async function releaseTeamWorker(dispatchId, { cwd, signal } = {}) {
  if (!dispatchId) return { ok: true, skipped: true };
  const res = await execOrca(['orchestration', 'worker-release', `--dispatch=${dispatchId}`], {
    cwd,
    timeoutMs: 12_000,
    signal
  });
  return { ok: res.exitCode === 0, raw: res.parsed };
}

export async function stopAndReleaseTeamWorker(dispatchId, { cwd, signal } = {}) {
  if (!dispatchId) return { ok: true, skipped: true };
  await execOrca(['orchestration', 'worker-stop', `--dispatch=${dispatchId}`], {
    cwd,
    timeoutMs: 12_000,
    signal
  });
  const rel = await releaseTeamWorker(dispatchId, { cwd, signal });
  return { ok: true, released: rel.ok };
}
