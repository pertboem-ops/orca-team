import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execOrca } from './orca-exec.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROLES_CONFIG_PATH = resolve(__dirname, '..', '..', 'config', 'team-roles.json');

let cachedRolesConfig = null;
let cachedRolesMtimeMs = -1;

const PROBE_TTL_MS = 5 * 60 * 1000;
let cachedProbe = null;
let cachedProbeAt = 0;

/**
 * Dynamic `mtimeMs` loader so `config/team-roles.json` edits take effect immediately
 * without ever restarting/killing the stdio MCP server process.
 */
export function loadTeamRolesConfig() {
  const customPath = process.env.ORCA_TEAM_ROLES_CONFIG_PATH || ROLES_CONFIG_PATH;
  const st = statSync(customPath);
  if (cachedRolesConfig && st.mtimeMs === cachedRolesMtimeMs && customPath === ROLES_CONFIG_PATH) {
    return cachedRolesConfig;
  }
  const parsed = JSON.parse(readFileSync(customPath, 'utf8'));
  if (customPath === ROLES_CONFIG_PATH) {
    cachedRolesConfig = parsed;
    cachedRolesMtimeMs = st.mtimeMs;
  }
  return parsed;
}

export function inferModelFamilyFromId(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'unknown';
  const raw = modelId.trim().toLowerCase();
  if (!raw) return 'unknown';

  const tail = raw.includes('/') ? raw.split('/').pop() : raw;

  if (tail.includes('claude') || tail.includes('sonnet') || tail.includes('opus') || tail.includes('haiku')) {
    return 'anthropic';
  }
  if (tail.includes('qwen') || tail.includes('qwq')) {
    return 'qwen';
  }
  if (tail.includes('kimi') || /^k\d+(\.\d+)?/i.test(tail) || tail.includes('moonshot')) {
    return 'moonshot';
  }
  if (tail.includes('deepseek')) {
    return 'deepseek';
  }
  if (tail.includes('glm') || tail.includes('chatglm') || tail.includes('zhipu')) {
    return 'zhipu';
  }
  if (tail.includes('gpt-oss')) {
    return 'openai-oss';
  }
  if (tail.startsWith('gpt-') || /^o[134](-|$)/.test(tail) || tail.includes('codex')) {
    return 'openai';
  }
  if (tail.includes('gemini')) {
    return 'gemini';
  }
  if (tail.includes('minimax') || tail.includes('abab')) {
    return 'minimax';
  }
  return 'unknown';
}

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getCliTestOverrides() {
  const raw = process.env.ORCA_TEAM_CLI_OVERRIDES_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Real-time CLI config reader (invoked BOTH at pre-dispatch `t0` AND at post-settle `t1`
 * to form a TOCTOU config-sandwich check per Red-Team `锋` R2 critique!).
 */
export function inspectLiveCliRouting(cli, explicitModel = null, workspaceRoot = null) {
  const testOverrides = getCliTestOverrides();
  if (testOverrides?.clis?.[cli]?.liveRouting) {
    const ov = testOverrides.clis[cli].liveRouting;
    const chosenModel = explicitModel || ov.model || null;
    const family =
      explicitModel && testOverrides.clis[cli].supportsModelFlag !== false
        ? inferModelFamilyFromId(explicitModel)
        : ov.actualProviderFamily || inferModelFamilyFromId(chosenModel);
    return {
      model: chosenModel,
      actualProviderFamily: family || 'unknown',
      familyConfidence: ov.familyConfidence || (explicitModel ? 'flag-verified' : 'config-inferred')
    };
  }

  const rolesCfg = loadTeamRolesConfig();
  const cap = rolesCfg.cliCapabilities?.[cli] || {
    supportsModelFlag: false,
    supportsEffortFlag: false,
    defaultFamilyConfidence: 'unknown'
  };

  if (cap.supportsModelFlag && explicitModel) {
    const fam = inferModelFamilyFromId(explicitModel);
    return {
      model: explicitModel,
      actualProviderFamily: fam,
      familyConfidence: fam !== 'unknown' ? 'flag-verified' : 'unknown'
    };
  }

  const home = process.env.USERPROFILE || process.env.HOME || homedir();

  if (cli === 'pi') {
    const piSettings = readJsonSafe(join(home, '.pi', 'agent', 'settings.json'));
    const fullModel =
      piSettings?.defaultProvider && piSettings?.defaultModel
        ? `${piSettings.defaultProvider}/${piSettings.defaultModel}`
        : piSettings?.defaultModel || null;
    const fam = inferModelFamilyFromId(fullModel);
    return {
      model: fullModel,
      actualProviderFamily: fam,
      familyConfidence: fam !== 'unknown' ? 'config-inferred' : 'unknown'
    };
  }

  if (cli === 'kimi') {
    const configCandidates = [
      join(home, '.kimi-code', 'config.toml'),
      join(home, '.kimi', 'config.toml')
    ];
    for (const cfgPath of configCandidates) {
      if (!existsSync(cfgPath)) continue;
      try {
        const txt = readFileSync(cfgPath, 'utf8');
        const m = txt.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
        if (m && m[1]) {
          const modelId = m[1].trim();
          const fam = inferModelFamilyFromId(modelId);
          return {
            model: modelId,
            actualProviderFamily: fam !== 'unknown' ? fam : 'moonshot',
            familyConfidence: 'config-inferred'
          };
        }
      } catch {}
    }
    return { model: null, actualProviderFamily: 'unknown', familyConfidence: 'unknown' };
  }

  if (cli === 'dsh') {
    // Verified against real `~/.dsh` layout (`profiles/dsh-tui/package.json` + `cordis.patch.yml` + `llm-deepseek`)
    const dshDir = join(home, '.dsh');
    if (!existsSync(dshDir)) {
      return { model: null, actualProviderFamily: 'unknown', familyConfidence: 'unknown' };
    }
    const profilePkg = readJsonSafe(join(dshDir, 'profiles', 'dsh-tui', 'package.json'));
    const bundles = profilePkg?.dsh?.profile?.bundles || [];
    const hasOfficialDeepseekBase =
      bundles.includes('@deepseek-ai/dsh-base') || existsSync(join(dshDir, 'llm-deepseek'));

    // Check if user patched in any non-deepseek LLM plugin in cordis.patch.yml
    const patchPaths = [
      join(dshDir, 'cordis.patch.yml'),
      join(dshDir, 'profiles', 'dsh-tui', 'cordis.patch.yml')
    ];
    for (const p of patchPaths) {
      if (!existsSync(p)) continue;
      try {
        const patchTxt = readFileSync(p, 'utf8').toLowerCase();
        if (
          patchTxt.includes('anthropic') ||
          patchTxt.includes('openai') ||
          patchTxt.includes('qwen') ||
          patchTxt.includes('moonshot')
        ) {
          return { model: 'dsh-custom-patched', actualProviderFamily: 'unknown', familyConfidence: 'unknown' };
        }
      } catch {}
    }

    if (hasOfficialDeepseekBase) {
      return {
        model: 'deepseek-official/dsh-default',
        actualProviderFamily: 'deepseek',
        familyConfidence: 'config-inferred'
      };
    }
    return { model: null, actualProviderFamily: 'unknown', familyConfidence: 'unknown' };
  }

  if (cli === 'opencode') {
    const candidates = [];
    if (workspaceRoot) {
      candidates.push(join(resolve(workspaceRoot), 'opencode.json'));
    }
    candidates.push(join(home, '.config', 'opencode', 'opencode.json'));
    for (const p of candidates) {
      const parsed = readJsonSafe(p);
      if (parsed?.model) {
        const fam = inferModelFamilyFromId(parsed.model);
        return {
          model: parsed.model,
          actualProviderFamily: fam,
          familyConfidence: fam !== 'unknown' ? 'config-inferred' : 'unknown'
        };
      }
    }
    const stateModel = readJsonSafe(join(home, '.local', 'state', 'opencode', 'model.json'));
    const recentFirst = Array.isArray(stateModel?.recent) ? stateModel.recent[0] : null;
    if (recentFirst?.providerID && recentFirst?.modelID) {
      const full = `${recentFirst.providerID}/${recentFirst.modelID}`;
      const fam = inferModelFamilyFromId(full);
      return {
        model: full,
        actualProviderFamily: fam,
        familyConfidence: fam !== 'unknown' ? 'config-inferred' : 'unknown'
      };
    }
    return { model: null, actualProviderFamily: 'unknown', familyConfidence: 'unknown' };
  }

  if (cli === 'claude') {
    return {
      model: explicitModel || 'claude-default',
      actualProviderFamily: 'anthropic',
      familyConfidence: explicitModel ? 'flag-verified' : 'config-inferred'
    };
  }

  if (cli === 'codex') {
    return {
      model: explicitModel || 'codex-default',
      actualProviderFamily: 'openai',
      familyConfidence: explicitModel ? 'flag-verified' : 'config-inferred'
    };
  }

  return { model: explicitModel, actualProviderFamily: 'unknown', familyConfidence: 'unknown' };
}

function findExecutableOnPath(candidates) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const extraDirs =
    process.platform === 'win32'
      ? [
          'C:\\nodejs',
          join(home, 'AppData', 'Local', 'Programs', 'Antigravity', 'bin'),
          join(home, '.kimi-code', 'bin'),
          join(home, '.local', 'bin')
        ]
      : [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];

  for (const dir of [...dirs, ...extraDirs]) {
    for (const name of candidates) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function stripAnsi(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

async function runCmdCapture(commandLine, timeoutMs = 8_000) {
  return await new Promise((resolvePromise) => {
    const child = spawn(commandLine, {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 1, stdout: '', stderr: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout: stripAnsi(stdout).trim(),
        stderr: stripAnsi(stderr).trim()
      });
    });
  });
}

export async function probeCliEnvironment({ forceRefresh = false, workspaceRoot = null, signal } = {}) {
  const testOverrides = getCliTestOverrides();
  if (testOverrides?.clis) {
    const clis = {};
    for (const [cliName, spec] of Object.entries(testOverrides.clis)) {
      const live = inspectLiveCliRouting(cliName, null, workspaceRoot);
      clis[cliName] = {
        installed: spec.installed !== false,
        authenticated: spec.authenticated !== false,
        status: spec.authenticated === false ? 'unavailable' : 'ok',
        defaultModel: live.model,
        actualProviderFamily: live.actualProviderFamily,
        familyConfidence: live.familyConfidence
      };
    }
    return {
      probedAt: new Date().toISOString(),
      orcaRunning: testOverrides.orcaRunning !== false,
      cached: false,
      clis
    };
  }

  const now = Date.now();
  if (!forceRefresh && cachedProbe && now - cachedProbeAt < PROBE_TTL_MS) {
    return { ...cachedProbe, cached: true };
  }

  const home = process.env.USERPROFILE || process.env.HOME || homedir();

  let orcaAccounts = null;
  let orcaRunning = false;
  try {
    const statusRes = await execOrca(['status'], { timeoutMs: 4_000, signal });
    if (statusRes.exitCode === 0 && statusRes.parsed?.result?.runtime?.reachable === true) {
      orcaRunning = true;
      const acctRes = await execOrca(['account', 'list'], { timeoutMs: 6_000, signal });
      if (acctRes.exitCode === 0 && acctRes.parsed?.ok) {
        orcaAccounts = acctRes.parsed.result;
      }
    }
  } catch {
    orcaRunning = false;
  }

  const rateLimits = orcaAccounts?.rateLimits ?? {};

  const agyBin = findExecutableOnPath(process.platform === 'win32' ? ['agy.cmd', 'agy.exe'] : ['agy']);
  const opencodeBin = findExecutableOnPath(
    process.platform === 'win32' ? ['opencode.cmd', 'opencode.exe'] : ['opencode']
  );
  const piBin = findExecutableOnPath(process.platform === 'win32' ? ['pi.cmd', 'pi.exe'] : ['pi']);
  const dshBin = findExecutableOnPath(process.platform === 'win32' ? ['dsh-tui.cmd', 'dsh.cmd'] : ['dsh-tui', 'dsh']);
  const kimiBin = findExecutableOnPath(process.platform === 'win32' ? ['kimi.exe', 'kimi.cmd'] : ['kimi']);
  const claudeBin = findExecutableOnPath(process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude']);
  const codexBin = findExecutableOnPath(process.platform === 'win32' ? ['codex.cmd', 'codex.exe'] : ['codex']);

  let opencodeProviders = [];
  if (opencodeBin) {
    const quotedCmd = opencodeBin.includes(' ') ? `"${opencodeBin}" auth list` : `${opencodeBin} auth list`;
    const authOut = await runCmdCapture(quotedCmd, 8_000);
    if (authOut.exitCode === 0 && authOut.stdout) {
      opencodeProviders = authOut.stdout
        .split(/\r?\n/)
        .map((l) => l.replace(/^[│┌└├●◆◇\s]+/g, '').trim())
        .filter(
          (l) =>
            l &&
            !l.toLowerCase().startsWith('credentials') &&
            !/^\d+\s+credentials?$/i.test(l) &&
            (/\b(stored|api|oauth|env)\b/i.test(l) || l.includes('Plan') || l.includes('OpenCode'))
        );
    }
  }

  const piSettings = readJsonSafe(join(home, '.pi', 'agent', 'settings.json'));
  const piAuthExists = existsSync(join(home, '.pi', 'agent', 'auth.json'));
  const dshCredsExists = existsSync(join(home, '.dsh', '.credentials.yaml')) || existsSync(join(home, '.dsh'));
  const kimiLocalConfigExists =
    existsSync(join(home, '.kimi-code', 'config.toml')) || existsSync(join(home, '.kimi', 'config.toml'));
  const kimiLocalCredsExists =
    existsSync(join(home, '.kimi-code', 'credentials')) || existsSync(join(home, '.kimi', 'credentials'));

  const piLive = inspectLiveCliRouting('pi', null, workspaceRoot);
  const kimiLive = inspectLiveCliRouting('kimi', null, workspaceRoot);
  const dshLive = inspectLiveCliRouting('dsh', null, workspaceRoot);
  const opencodeLive = inspectLiveCliRouting('opencode', null, workspaceRoot);

  const agyRate = rateLimits.antigravity;
  const agyReady = Boolean(agyBin) && (!orcaRunning || agyRate?.status === 'ok' || !agyRate);
  const opencodeReady =
    Boolean(opencodeBin) &&
    (opencodeProviders.length > 0 || (orcaAccounts?.opencode?.accounts?.length ?? 0) > 0);
  const kimiReady =
    Boolean(kimiBin) &&
    (rateLimits.kimi?.status === 'ok' || Boolean(kimiLocalConfigExists && (kimiLocalCredsExists || kimiLive.model)));
  const piReady = Boolean(piBin) && (piAuthExists || Boolean(piSettings?.defaultProvider));
  const dshReady = Boolean(dshBin) && dshCredsExists && dshLive.actualProviderFamily !== 'unknown';
  const claudeReady = Boolean(claudeBin) && rateLimits.claude?.status === 'ok';
  const codexReady =
    Boolean(codexBin) &&
    (rateLimits.codex?.status === 'ok' || Boolean(orcaAccounts?.codex?.systemDefault?.hasAuth));

  const clis = {
    antigravity: {
      installed: Boolean(agyBin),
      binary: agyBin,
      authenticated: agyReady,
      status: agyReady ? 'ok' : agyBin ? 'unverified_or_logged_out' : 'not_installed'
    },
    kimi: {
      installed: Boolean(kimiBin),
      binary: kimiBin,
      authenticated: kimiReady,
      status: kimiReady ? 'ok' : kimiBin ? 'unavailable' : 'not_installed',
      defaultModel: kimiLive.model,
      actualProviderFamily: kimiLive.actualProviderFamily,
      familyConfidence: kimiLive.familyConfidence
    },
    pi: {
      installed: Boolean(piBin),
      binary: piBin,
      authenticated: piReady,
      status: piReady ? 'ok' : piBin ? 'unconfigured' : 'not_installed',
      defaultModel: piLive.model,
      actualProviderFamily: piLive.actualProviderFamily,
      familyConfidence: piLive.familyConfidence
    },
    dsh: {
      installed: Boolean(dshBin),
      binary: dshBin,
      authenticated: dshReady,
      status: dshReady ? 'ok' : dshBin ? 'unconfigured' : 'not_installed',
      defaultModel: dshLive.model,
      actualProviderFamily: dshLive.actualProviderFamily,
      familyConfidence: dshLive.familyConfidence
    },
    opencode: {
      installed: Boolean(opencodeBin),
      binary: opencodeBin,
      authenticated: opencodeReady,
      status: opencodeReady ? 'ok' : opencodeBin ? 'missing_credentials' : 'not_installed',
      defaultModel: opencodeLive.model,
      actualProviderFamily: opencodeLive.actualProviderFamily,
      familyConfidence: opencodeLive.familyConfidence,
      providers: opencodeProviders
    },
    claude: {
      installed: Boolean(claudeBin),
      binary: claudeBin,
      authenticated: claudeReady,
      status: claudeReady ? 'ok' : claudeBin ? 'unavailable' : 'not_installed'
    },
    codex: {
      installed: Boolean(codexBin),
      binary: codexBin,
      authenticated: codexReady,
      status: codexReady ? 'ok' : codexBin ? 'unavailable' : 'not_installed'
    }
  };

  cachedProbe = {
    probedAt: new Date(now).toISOString(),
    orcaRunning,
    clis
  };
  cachedProbeAt = now;
  return { ...cachedProbe, cached: false };
}
