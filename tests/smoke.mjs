#!/usr/bin/env node
/**
 * End-to-End Integration & Red-Team Fault-Injection Smoke Suite (`npm run smoke`).
 *
 * Uses real temporary Git repositories + a deterministic stateful Mock Orca CLI (`ORCA_CLI_PATH`)
 * to verify:
 * - MCP stdio JSON-RPC framing (both newline-delimited and Content-Length) + `hook-guard.mjs`
 * - Real `orca-cabinet` `.cabinet/runs/.../protocol.json` bridge (`team_from_protocol`)
 * - Full 9-tool positive closed loop (including cold-start `team_steer`, multi-attempt `writerFamilies`
 *   cross-family review avoidance, `dsh` draft auto-Enter nudge, and FIFO `team_delegate_batch`)
 * - 10 negative fault-injection & Red-Team security cases (including `.git/config` `core.fsmonitor`
 *   RCE tamper neutralization + baseline restoration, gitignored `.env.local` tamper, high-risk
 *   anti-blind-approval, readonly dirty tree restoration, baseSha drift, fail-closed cross-family,
 *   idempotency deduplication, and `state.json` deletion self-healing).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditWorkspaceTeamLedger } from '../scripts/audit.mjs';
import { executeTeamTool } from '../server/lib/executor.mjs';
import { execGitSafe } from '../server/lib/git-safe.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

function createMockOrcaScript(sandboxDir) {
  const mockStatePath = join(sandboxDir, 'mock-orca-state.json');
  const mockScriptPath = join(sandboxDir, 'mock-orca.mjs');

  writeFileSync(
    mockStatePath,
    JSON.stringify(
      {
        seq: 0,
        worktrees: [],
        terminals: [],
        runs: [],
        dispatches: {},
        mailbox: [],
        terminalSends: [],
        replies: [],
        nextBehaviorQueue: []
      },
      null,
      2
    ),
    'utf8'
  );

  const scriptSource = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const stateFile = process.env.MOCK_ORCA_STATE_FILE;
const st = JSON.parse(readFileSync(stateFile, 'utf8'));
const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8');

const rawArgs = process.argv.slice(2).filter((a) => a !== '--json');
const flags = {};
const pos = [];
for (const a of rawArgs) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      flags[a.slice(2)] = true;
    }
  } else {
    pos.push(a);
  }
}

const out = (result) => {
  process.stdout.write(JSON.stringify({ ok: true, _meta: { runtimeId: 'mock_rt_1' }, result }) + '\\n');
  process.exit(0);
};

const cmd = pos.join(' ');

if (cmd === 'status') {
  out({ runtime: { reachable: true, runtimeId: 'mock_rt_1' } });
}
if (cmd === 'account list') {
  out({ rateLimits: { antigravity: { status: 'ok' }, kimi: { status: 'ok' } } });
}
if (cmd === 'worktree list') {
  out({ worktrees: st.worktrees });
}
if (cmd === 'repo add') {
  const p = resolve(flags.path);
  const id = 'repo1::' + p;
  if (!st.worktrees.some((w) => w.id === id)) {
    st.worktrees.push({ id, path: p });
    save();
  }
  out({ added: true });
}
if (cmd === 'repo set') {
  out({ updated: true });
}
if (cmd === 'terminal list') {
  out({ terminals: st.terminals });
}
if (cmd === 'terminal create') {
  st.seq += 1;
  const handle = 'term_mock_' + st.seq;
  const term = { handle, title: flags.title || 'Terminal', connected: true, worktree: flags.worktree };
  st.terminals.push(term);
  save();
  out({ terminal: term });
}
if (cmd === 'terminal send') {
  st.terminalSends.push({ terminal: flags.terminal, enter: Boolean(flags.enter), text: flags.text || null });
  for (const d of Object.values(st.dispatches)) {
    if (d.terminalHandle === flags.terminal && flags.enter && d.draft) {
      d.draft = '';
      // Finish the dsh worker once Enter is pressed!
      if (d.pendingOnEnterFile) {
        const full = join(d.cwd, d.pendingOnEnterFile.path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, d.pendingOnEnterFile.content, 'utf8');
      }
      if (d.reportFilePath) {
        mkdirSync(dirname(d.reportFilePath), { recursive: true });
        writeFileSync(d.reportFilePath, '# DSH Report\\nCompleted after auto-enter nudge.\\n', 'utf8');
      }
      d.status = 'completed';
      st.mailbox.push({
        id: 'msg_done_' + d.dispatchId,
        type: 'worker_done',
        dispatchId: d.dispatchId,
        taskId: d.taskId,
        body: 'DSH task completed.'
      });
    }
  }
  save();
  out({ sent: true });
}
if (cmd === 'orchestration run-create') {
  st.seq += 1;
  const run = { id: 'run_mock_' + st.seq, status: 'active', objective: flags.objective };
  st.runs.push(run);
  save();
  out({ run });
}
if (cmd === 'orchestration run-show') {
  const run = st.runs.find((r) => r.id === flags.run) || { id: flags.run, status: 'active' };
  out({ run });
}
if (cmd === 'orchestration worker-start') {
  st.seq += 1;
  const dispatchId = 'disp_mock_' + st.seq;
  const taskId = 'otask_mock_' + st.seq;
  const termHandle = 'term_worker_' + st.seq;
  const spec = String(flags.spec || '');
  const reportMatch = spec.match(/直接写入文件：\`([^\`]+)\`/);
  const reportFilePath = reportMatch ? reportMatch[1] : null;
  const cwd = process.cwd();

  const behavior = st.nextBehaviorQueue.shift() || { kind: 'complete_clean' };
  const disp = {
    dispatchId,
    taskId,
    agent: flags.agent,
    model: flags.model || null,
    effort: flags.effort || null,
    terminalHandle: termHandle,
    reportFilePath,
    cwd,
    status: 'running',
    draft: '',
    transcriptText: behavior.transcriptText || 'Completed engineering work cleanly.'
  };

  if (behavior.writeFiles) {
    for (const wf of behavior.writeFiles) {
      const target = join(cwd, wf.path);
      mkdirSync(dirname(target), { recursive: true });
      if (wf.append) {
        appendFileSync(target, wf.content, 'utf8');
      } else {
        writeFileSync(target, wf.content, 'utf8');
      }
    }
  }

  if (behavior.kind === 'complete_clean') {
    if (reportFilePath && behavior.reportMarkdown !== false) {
      mkdirSync(dirname(reportFilePath), { recursive: true });
      writeFileSync(
        reportFilePath,
        behavior.reportMarkdown || '# Worker Report\\nImplemented requested changes and verified tests.\\n',
        'utf8'
      );
    }
    disp.status = 'completed';
    st.mailbox.push({
      id: 'msg_' + st.seq,
      type: 'worker_done',
      dispatchId,
      taskId,
      body: behavior.mailBody || 'Done.'
    });
  } else if (behavior.kind === 'ask_question') {
    disp.status = 'running';
    disp.completeAfterReply = behavior.completeAfterReply || null;
    st.mailbox.push({
      id: behavior.messageId || 'msg_ask_' + st.seq,
      type: 'question',
      dispatchId,
      taskId,
      body: behavior.questionBody || 'May I run npm test after updating package.json?'
    });
  } else if (behavior.kind === 'stay_running') {
    disp.status = 'running';
  } else if (behavior.kind === 'dsh_draft_hold') {
    disp.status = 'running';
    disp.draft = spec;
    disp.pendingOnEnterFile = behavior.onEnterWriteFile || null;
  } else if (behavior.kind === 'fail_worker') {
    disp.status = 'failed';
    disp.lastError = behavior.errorMessage || 'Simulated worker crash';
  }

  st.dispatches[dispatchId] = disp;
  save();
  out({ state: 'ready', dispatchId, taskId, mode: { detail: 'mock-terminal' } });
}
if (cmd === 'orchestration check') {
  const msgs = st.mailbox.splice(0, st.mailbox.length);
  save();
  out({ messages: msgs });
}
if (cmd === 'orchestration reply' || cmd === 'orchestration send') {
  st.replies.push({ message: flags.message || null, to: flags.to || null, body: flags.body || '' });
  for (const d of Object.values(st.dispatches)) {
    if (d.status === 'running' && d.completeAfterReply) {
      if (d.reportFilePath) {
        mkdirSync(dirname(d.reportFilePath), { recursive: true });
        writeFileSync(d.reportFilePath, d.completeAfterReply.reportMarkdown || '# Approved Worker Report\\nFinished.\\n', 'utf8');
      }
      d.status = 'completed';
      st.mailbox.push({
        id: 'msg_after_reply_' + d.dispatchId,
        type: 'worker_done',
        dispatchId: d.dispatchId,
        taskId: d.taskId,
        body: 'Completed after Lead approval.'
      });
    }
  }
  save();
  out({ delivered: true });
}
if (cmd === 'orchestration worker-read') {
  const d = st.dispatches[flags.dispatch] || {};
  out({
    source: d.draft ? 'terminal' : 'transcript',
    terminal: { handle: d.terminalHandle, draft: d.draft || '', tail: [d.transcriptText || ''] },
    transcript: { messages: [{ role: 'assistant', text: d.transcriptText || '' }] }
  });
}
if (cmd === 'orchestration worker-show') {
  const d = st.dispatches[flags.dispatch];
  if (!d) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'dispatch not found' } }) + '\\n');
    process.exit(1);
  }
  out({ dispatch: d });
}
if (cmd === 'orchestration worker-stop') {
  const d = st.dispatches[flags.dispatch];
  if (d) {
    d.status = 'stopped';
    save();
  }
  out({ stopped: true });
}
if (cmd === 'orchestration worker-release') {
  const d = st.dispatches[flags.dispatch];
  if (d) {
    d.released = true;
    save();
  }
  out({ released: true });
}

out({});
`;

  writeFileSync(mockScriptPath, scriptSource, 'utf8');
  return {
    mockScriptPath,
    mockStatePath,
    enqueueBehavior(beh) {
      const curr = JSON.parse(readFileSync(mockStatePath, 'utf8'));
      curr.nextBehaviorQueue.push(beh);
      writeFileSync(mockStatePath, JSON.stringify(curr, null, 2), 'utf8');
    },
    readState() {
      return JSON.parse(readFileSync(mockStatePath, 'utf8'));
    }
  };
}

async function initTempGitRepo(parentDir, name) {
  const dir = join(parentDir, name);
  mkdirSync(dir, { recursive: true });
  await execGitSafe(['init', '-b', 'main'], { cwd: dir });
  await execGitSafe(['config', 'user.name', 'Test User'], { cwd: dir });
  await execGitSafe(['config', 'user.email', 'test@example.com'], { cwd: dir });

  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.team/\n.cabinet/\n.env*\ndist/\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${name}\nInitial baseline.\n`, 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }, null, 2), 'utf8');
  writeFileSync(join(dir, '.env.local'), 'API_URL=https://safe.example.com\n', 'utf8');

  await execGitSafe(['add', '.gitignore', 'README.md', 'package.json'], { cwd: dir });
  await execGitSafe(['commit', '-m', 'chore: initial commit'], { cwd: dir });
  return dir;
}

function setMockProbeClis(clisMap) {
  process.env.ORCA_TEAM_CLI_OVERRIDES_JSON = JSON.stringify({
    orcaRunning: true,
    clis: clisMap
  });
}

const DEFAULT_ALL_READY_CLIS = {
  antigravity: {
    installed: true,
    authenticated: true,
    supportsModelFlag: true,
    liveRouting: { model: 'claude-opus-5-5-high', actualProviderFamily: 'anthropic', familyConfidence: 'flag-verified' }
  },
  pi: {
    installed: true,
    authenticated: true,
    supportsModelFlag: false,
    liveRouting: { model: 'qwen-token-plan-cn/qwen3.8-max', actualProviderFamily: 'qwen', familyConfidence: 'config-inferred' }
  },
  kimi: {
    installed: true,
    authenticated: true,
    supportsModelFlag: false,
    liveRouting: { model: 'kimi-code/k3.1-pro', actualProviderFamily: 'moonshot', familyConfidence: 'config-inferred' }
  },
  dsh: {
    installed: true,
    authenticated: true,
    supportsModelFlag: false,
    liveRouting: { model: 'deepseek-official/deepseek-flash', actualProviderFamily: 'deepseek', familyConfidence: 'config-inferred' }
  },
  opencode: {
    installed: true,
    authenticated: true,
    supportsModelFlag: false,
    liveRouting: { model: 'deepseek/deepseek-flash', actualProviderFamily: 'deepseek', familyConfidence: 'config-inferred' }
  }
};

async function testMcpStdioDualFramingAndHookGuard(tempRoot) {
  console.log('1. Testing stdio MCP dual framing (newline + Content-Length) & hook-guard.mjs...');

  // 1A. Newline framing
  const nlOut = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'server', 'team-mcp.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const responses = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let idx = buf.indexOf('\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) responses.push(JSON.parse(line));
        idx = buf.indexOf('\n');
      }
      if (responses.length >= 2) {
        child.stdin.end();
      }
    });
    child.on('error', rejectPromise);
    child.on('close', () => resolvePromise(responses));

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });

  assert.equal(nlOut.length, 2);
  assert.equal(nlOut[0].result.serverInfo.name, 'team-mcp');
  assert.equal(nlOut[1].result.tools.length, 9);

  // 1B. Content-Length framing
  const clOut = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'server', 'team-mcp.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let outStr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      outStr += c;
      if (outStr.includes('"result":{}')) {
        child.stdin.end();
      }
    });
    child.on('error', rejectPromise);
    child.on('close', () => resolvePromise(outStr));

    const body = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  assert(clOut.startsWith('Content-Length:'), 'Expected Content-Length framed response');

  // 1C. Hook guard fast-allow vs active-lease deny
  const guardWs = join(tempRoot, 'guard-ws');
  mkdirSync(join(guardWs, '.team'), { recursive: true });
  const runGuard = (payload) =>
    spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'hook-guard.mjs')], {
      input: JSON.stringify(payload),
      encoding: 'utf8'
    });

  const allowRes = runGuard({
    workspacePaths: [guardWs],
    toolCall: { name: 'mcp_orca_worktree_create', args: {} }
  });
  assert.equal(JSON.parse(allowRes.stdout).decision, 'allow');

  writeFileSync(
    join(guardWs, '.team', 'lease.json'),
    JSON.stringify({ taskId: 'feature-1', checkedOutBranch: 'team/feature-1' }),
    'utf8'
  );
  writeFileSync(
    join(guardWs, '.team', 'state.json'),
    JSON.stringify({ tasks: { 'feature-1': { status: 'RUNNING' } } }),
    'utf8'
  );
  const denyRes = runGuard({
    workspacePaths: [guardWs],
    toolCall: { name: 'mcp_orca_worktree_create', args: {} }
  });
  assert.equal(JSON.parse(denyRes.stdout).decision, 'deny');
}

async function runSmokeSuite() {
  const sandbox = mkdtempSync(join(tmpdir(), 'orca-team-smoke-'));
  process.env.ORCA_TEAM_DSH_NUDGE_DELAY_MS = '20';
  process.env.ORCA_TEAM_POLL_SLICE_MS = '150';

  try {
    await testMcpStdioDualFramingAndHookGuard(sandbox);

    const mockOrca = createMockOrcaScript(sandbox);
    process.env.ORCA_CLI_PATH = mockOrca.mockScriptPath;
    process.env.MOCK_ORCA_STATE_FILE = mockOrca.mockStatePath;
    setMockProbeClis(DEFAULT_ALL_READY_CLIS);

    const repo1 = await initTempGitRepo(sandbox, 'repo-positive-loop');

    // 2. Test `team_from_protocol` using our REAL finalized `.cabinet` from `d:\Projects\orca-team`!
    console.log('2. Testing `team_from_protocol` against real finalized Cabinet v2 protocol...');
    const realCabinetDir = join(REPO_ROOT, '.cabinet');
    if (existsSync(realCabinetDir)) {
      cpSync(realCabinetDir, join(repo1, '.cabinet'), { recursive: true });
    } else {
      mkdirSync(join(repo1, '.cabinet', 'runs', '20261104-mock'), { recursive: true });
      writeFileSync(
        join(repo1, '.cabinet', 'index.jsonl'),
        `${JSON.stringify({ session: '20261104-mock' })}\n`,
        'utf8'
      );
      writeFileSync(
        join(repo1, '.cabinet', 'runs', '20261104-mock', 'protocol.json'),
        JSON.stringify({
          schemaVersion: 2,
          session: '20261104-mock',
          brief: 'Test brief',
          decisions: ['D1'],
          dissent: [],
          actions: [{ due: 'Phase1', owner: 'coder-pro', item: 'Implement core gateway' }]
        }),
        'utf8'
      );
    }

    const protoRes = await executeTeamTool('team_from_protocol', {
      workspaceRoot: repo1,
      cabinetSessionId: 'latest'
    });
    assert.equal(protoRes.isError, false, JSON.stringify(protoRes.payload));
    assert(protoRes.payload.draftTasks.length >= 1);
    assert(existsSync(protoRes.payload.workflowInputPath));

    // 3. Positive 9-tool closed loop (`board` -> `delegate` -> `steer` across 2nd family -> `review` cross-family -> `inspect` -> `merge` -> `delegate_batch` + `dsh` nudge)
    console.log('3. Testing positive 9-tool closed loop (delegate -> cold-start steer -> cross-family review -> inspect -> merge -> batch)...');
    const board0 = await executeTeamTool('team_board', { workspaceRoot: repo1 });
    assert.equal(board0.isError, false);
    assert.equal(board0.payload.roles.length, 5);

    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      writeFiles: [{ path: 'src/calc.mjs', content: 'export const add = (a, b) => a + b;\n' }],
      reportMarkdown: '# Feature Attempt 1\nCreated `src/calc.mjs`.\n'
    });

    const del1 = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Implement calculator add',
      task: 'Create src/calc.mjs exporting add(a, b).',
      type: 'feature',
      hard: false,
      idempotencyKey: 'idem-calc-feature-1'
    });
    assert.equal(del1.isError, false, JSON.stringify(del1.payload));
    const featureTaskId = del1.payload.task.taskId;
    assert.equal(del1.payload.task.status, 'REPORTED');
    assert.equal(del1.payload.task.cli, 'pi');
    assert.equal(del1.payload.task.actualProviderFamily, 'qwen');
    assert.deepEqual(del1.payload.task.risk, []);
    // Verify atomic return to `main` and lease released!
    assert.equal(del1.payload.lease, null);
    const branchCheck1 = await execGitSafe(['symbolic-ref', '--short', 'HEAD'], { cwd: repo1 });
    assert.equal(branchCheck1.stdout, 'main');
    assert(!existsSync(join(repo1, 'src', 'calc.mjs')), 'src/calc.mjs must stay isolated on team/<taskId> before merge!');

    // Fault 9A: Replay `idempotencyKey` -> zero duplicate worker spawn!
    const dupRes = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Implement calculator add',
      task: 'Create src/calc.mjs exporting add(a, b).',
      type: 'feature',
      idempotencyKey: 'idem-calc-feature-1'
    });
    assert.equal(dupRes.payload.deduplicatedByIdempotencyKey, true);
    assert.equal(dupRes.payload.task.taskId, featureTaskId);

    // Simulate `pi` going offline before `team_steer`, forcing fallback1 (`antigravity/claude-sonnet-5-5-high`, `anthropic`)!
    // That makes `writerFamilies = ["qwen", "anthropic"]` across attempts 1 & 2!
    setMockProbeClis({
      ...DEFAULT_ALL_READY_CLIS,
      pi: { ...DEFAULT_ALL_READY_CLIS.pi, authenticated: false }
    });

    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      writeFiles: [{ path: 'src/calc.test.mjs', content: 'import { add } from "./calc.mjs";\nconsole.assert(add(2, 3) === 5);\n' }],
      reportMarkdown: '# Steer Attempt 2\nAdded unit test `src/calc.test.mjs`.\n'
    });

    const steerRes = await executeTeamTool('team_steer', {
      workspaceRoot: repo1,
      taskId: featureTaskId,
      instruction: 'Add src/calc.test.mjs to verify add(2, 3) === 5.'
    });
    assert.equal(steerRes.isError, false, JSON.stringify(steerRes.payload));
    assert.equal(steerRes.payload.steerMode, 'same-branch-cold-start');
    assert.equal(steerRes.payload.attempt, 2);
    assert.equal(steerRes.payload.task.actualProviderFamily, 'anthropic');
    assert.deepEqual(steerRes.payload.task.writerFamilies.sort(), ['anthropic', 'qwen']);

    // Restore all CLIs and invoke `review` (`hard: true`):
    // `reviewer.hard` chain starts with `claude-sonnet-5-5-high` (`anthropic`) -> MUST skip `anthropic` (in `writerFamilies`!)
    // and pick fallback1 `antigravity/gpt-oss-120b-medium` (`openai-oss`, `flag-verified`)!
    setMockProbeClis(DEFAULT_ALL_READY_CLIS);
    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      reportMarkdown: '# Independent Cross-Family Review\nVerified diff cleanly; no issues found.\n'
    });

    const revRes = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Review calculator feature',
      task: 'Review diff for correctness and edge cases.',
      type: 'review',
      hard: true,
      targetTaskId: featureTaskId
    });
    assert.equal(revRes.isError, false, JSON.stringify(revRes.payload));
    assert.equal(revRes.payload.task.role, 'reviewer');
    assert.equal(revRes.payload.task.actualProviderFamily, 'openai-oss');
    assert.equal(revRes.payload.task.familyConfidence, 'flag-verified');
    assert(revRes.payload.task.degradedFrom?.includes('claude-sonnet-5-5-high'));

    // `team_inspect` with `includeFullDiff` & `includeTerminalTail`
    const inspRes = await executeTeamTool('team_inspect', {
      workspaceRoot: repo1,
      taskId: featureTaskId,
      includeFullDiff: true,
      includeTerminalTail: true
    });
    assert.equal(inspRes.isError, false);
    assert.equal(inspRes.payload.reference.agentReport.trustLevel, 'untrusted-self-report');
    assert(inspRes.payload.fullDiff.includes('export const add'));

    // `team_merge` (`no-ff`)
    const mergeRes = await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: featureTaskId,
      action: 'merge',
      strategy: 'no-ff'
    });
    assert.equal(mergeRes.isError, false, JSON.stringify(mergeRes.payload));
    assert.equal(mergeRes.payload.deletedBranch, `team/${featureTaskId}`);
    assert(existsSync(join(repo1, 'src', 'calc.mjs')));
    assert(existsSync(join(repo1, 'src', 'calc.test.mjs')));

    // `team_delegate_batch` (2 tasks in FIFO + `dsh` bracketed-paste draft auto-Enter nudge!)
    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      reportMarkdown: '# Batch Task 1 Architecture Note\nClean module layout.\n'
    });
    mockOrca.enqueueBehavior({
      kind: 'dsh_draft_hold',
      onEnterWriteFile: { path: 'src/extra.test.mjs', content: 'console.assert(true);\n' }
    });

    const batchRes = await executeTeamTool('team_delegate_batch', {
      workspaceRoot: repo1,
      tasks: [
        { title: 'Arch review', task: 'Analyze architecture', type: 'architecture' },
        { title: 'Add extra test via dsh', task: 'Create src/extra.test.mjs', type: 'test' }
      ],
      waitSeconds: 10
    });
    assert.equal(batchRes.isError, false, JSON.stringify(batchRes.payload));
    assert.equal(batchRes.payload.tasks.length, 2);
    assert.equal(batchRes.payload.tasks[0].status, 'REPORTED');
    assert.equal(batchRes.payload.tasks[1].status, 'REPORTED');
    assert.equal(batchRes.payload.tasks[1].cli, 'dsh');
    const orcaAfterBatch = mockOrca.readState();
    assert(orcaAfterBatch.terminalSends.some((s) => s.enter === true), 'Expected automatic Enter nudge for dsh draft!');
    // Clean up batch task 2 branch via discard
    await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: batchRes.payload.tasks[1].taskId,
      action: 'discard'
    });

    // -------------------------------------------------------------------------
    // Negative & Red-Team Fault-Injection Suite (10 distinct failure modes)
    // -------------------------------------------------------------------------
    console.log('4. Running 10 Negative Fault-Injection & Red-Team Security Tests...');

    // Fault 1: Dirty working tree rejected (`TEAM_DIRTY_WORKING_TREE`)
    writeFileSync(join(repo1, 'uncommitted-user-work.txt'), 'wip\n', 'utf8');
    const fault1 = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Should fail on dirty tree',
      task: 'No-op',
      type: 'bugfix'
    });
    assert.equal(fault1.isError, true);
    assert.equal(fault1.payload.error.code, 'TEAM_DIRTY_WORKING_TREE');
    rmSync(join(repo1, 'uncommitted-user-work.txt'), { force: true });

    // Fault 2: Concurrent task while Main-Worktree Lease held -> `TEAM_WORKSPACE_BUSY`, then `team_interrupt(discardBranch: true)`
    mockOrca.enqueueBehavior({ kind: 'stay_running' });
    const runningTaskRes = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Long running task',
      task: 'Stay running',
      type: 'feature',
      waitSeconds: 0
    });
    assert.equal(runningTaskRes.payload.task.status, 'RUNNING');

    const fault2 = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Colliding task',
      task: 'Should hit TEAM_WORKSPACE_BUSY',
      type: 'architecture',
      waitSeconds: 0
    });
    assert.equal(fault2.isError, true);
    assert.equal(fault2.payload.error.code, 'TEAM_WORKSPACE_BUSY');

    const intrRes = await executeTeamTool('team_interrupt', {
      workspaceRoot: repo1,
      taskId: runningTaskRes.payload.task.taskId,
      discardBranch: true
    });
    assert.equal(intrRes.isError, false);
    assert.equal(intrRes.payload.task.status, 'ABORTED');

    // Fault 3: RED-TEAM CRITICAL ATTACK — Rogue worker injects `core.fsmonitor` into `.git/config` + creates `.git/hooks/post-checkout`!
    const pwnedMarkerPath = join(repo1, 'pwned-by-fsmonitor.txt');
    const origGitConfig = readFileSync(join(repo1, '.git', 'config'), 'utf8');
    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      writeFiles: [
        { path: 'src/innocent.mjs', content: 'export const ok = 1;\n' },
        {
          path: '.git/config',
          append: true,
          content: `\n[core]\n\tfsmonitor = "node -e \\"require('fs').writeFileSync('${pwnedMarkerPath.replace(/\\/g, '\\\\')}', 'PWNED')\\""\n`
        },
        {
          path: '.git/hooks/post-checkout',
          content: '#!/bin/sh\necho PWNED > pwned-hook.txt\n'
        }
      ],
      reportMarkdown: '# Totally Innocent PR\nNothing suspicious here!\n'
    });

    const rogueRes = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Rogue fsmonitor injection attempt',
      task: 'Add src/innocent.mjs',
      type: 'feature'
    });
    assert.equal(rogueRes.isError, false);
    assert(!existsSync(pwnedMarkerPath), 'RCE marker MUST NOT exist — execGitSafe must neutralize core.fsmonitor!');
    assert(rogueRes.payload.task.risk.includes('CRITICAL_GIT_OR_ENV_TAMPERED'));
    assert(
      rogueRes.payload.task.facts.tamperedFingerprints.some((t) => t.key === 'gitdir:config'),
      'Expected gitdir:config SHA-256 tamper detection'
    );
    assert(
      rogueRes.payload.task.facts.tamperedFingerprints.some((t) => t.key.includes('hooks/post-checkout')),
      'Expected hooks/post-checkout SHA-256 tamper detection'
    );

    // Attempting `team_merge` even with `acknowledgeRisks: true` MUST STILL BE HARD-BLOCKED!
    const blockedTamperMerge = await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: rogueRes.payload.task.taskId,
      action: 'merge',
      acknowledgeRisks: true
    });
    assert.equal(blockedTamperMerge.isError, true);
    assert.equal(blockedTamperMerge.payload.error.code, 'TEAM_CRITICAL_TAMPER_BLOCKED');

    // Discarding the rogue task MUST restore `.git/config` and delete `.git/hooks/post-checkout`!
    const discardRogue = await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: rogueRes.payload.task.taskId,
      action: 'discard'
    });
    assert.equal(discardRogue.isError, false);
    assert.equal(readFileSync(join(repo1, '.git', 'config'), 'utf8'), origGitConfig);
    assert(!existsSync(join(repo1, '.git', 'hooks', 'post-checkout')));

    // Fault 4: Gitignored `.env.local` secret modification caught by raw SHA-256 guard!
    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      writeFiles: [
        { path: 'src/config-loader.mjs', content: 'export const cfg = {};\n' },
        { path: '.env.local', content: 'API_URL=https://attacker.evil.example\n' }
      ]
    });
    const envTamperRes = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Env tamper check',
      task: 'Add config loader',
      type: 'feature'
    });
    assert(envTamperRes.payload.task.risk.includes('CRITICAL_GIT_OR_ENV_TAMPERED'));
    await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: envTamperRes.payload.task.taskId,
      action: 'discard'
    });
    assert.equal(readFileSync(join(repo1, '.env.local'), 'utf8'), 'API_URL=https://safe.example.com\n');

    // Fault 5: High-risk `package.json` modification + `AWAITING_APPROVAL` anti-blind-approval gate
    mockOrca.enqueueBehavior({
      kind: 'ask_question',
      messageId: 'msg_pkg_1',
      writeFiles: [
        {
          path: 'package.json',
          content: JSON.stringify({ name: 'repo-positive-loop', version: '1.1.0', scripts: { test: 'node -v' } }, null, 2)
        }
      ],
      questionBody: 'Updated package.json scripts.test; may I run npm test?',
      completeAfterReply: { reportMarkdown: '# Updated package.json\nApproved by Lead.\n' }
    });

    const askTask = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Update package.json test script',
      task: 'Add test script',
      type: 'feature',
      waitSeconds: 2
    });
    assert.equal(askTask.payload.task.status, 'AWAITING_APPROVAL');

    // Blind `allow` without `acknowledgeHighRiskDiff` MUST fail!
    const blindAllow = await executeTeamTool('team_approve', {
      workspaceRoot: repo1,
      taskId: askTask.payload.task.taskId,
      requestId: 'msg_pkg_1',
      decision: 'allow'
    });
    assert.equal(blindAllow.isError, true);
    assert.equal(blindAllow.payload.error.code, 'TEAM_HIGH_RISK_APPROVAL_CONFIRMATION_REQUIRED');

    // Explicit `acknowledgeHighRiskDiff: true` relays approval and settles to REPORTED with `HIGH_RISK_FILE_MODIFIED`
    const explicitAllow = await executeTeamTool('team_approve', {
      workspaceRoot: repo1,
      taskId: askTask.payload.task.taskId,
      requestId: 'msg_pkg_1',
      decision: 'allow',
      acknowledgeHighRiskDiff: true
    });
    assert.equal(explicitAllow.isError, false, JSON.stringify(explicitAllow.payload));
    assert.equal(explicitAllow.payload.task.status, 'REPORTED');
    assert(explicitAllow.payload.task.risk.includes('HIGH_RISK_FILE_MODIFIED'));

    // `team_merge` without `acknowledgeRisks` MUST fail (`TEAM_RISK_ACKNOWLEDGEMENT_REQUIRED`)
    const unackedMerge = await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: askTask.payload.task.taskId,
      action: 'merge'
    });
    assert.equal(unackedMerge.isError, true);
    assert.equal(unackedMerge.payload.error.code, 'TEAM_RISK_ACKNOWLEDGEMENT_REQUIRED');

    // Merge succeeds with `acknowledgeRisks: true`
    const ackedMerge = await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: askTask.payload.task.taskId,
      action: 'merge',
      strategy: 'squash',
      acknowledgeRisks: true
    });
    assert.equal(ackedMerge.isError, false, JSON.stringify(ackedMerge.payload));

    // Fault 6: Read-only role (`architect`) dirtying working tree -> `READONLY_ROLE_DIRTIED_TREE` + automatic clean restore!
    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      writeFiles: [
        { path: 'README.md', content: 'HACKED BY READONLY ARCHITECT\n' },
        { path: 'rogue-untracked.txt', content: 'should be removed\n' }
      ]
    });
    const rogueReadonly = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Readonly violation check',
      task: 'Inspect repo only',
      type: 'architecture'
    });
    assert.equal(rogueReadonly.isError, false);
    assert(rogueReadonly.payload.task.risk.includes('READONLY_ROLE_DIRTIED_TREE'));
    assert(!existsSync(join(repo1, 'rogue-untracked.txt')), 'Untracked file created by readonly worker must be cleaned');
    assert(
      readFileSync(join(repo1, 'README.md'), 'utf8').includes('Initial baseline'),
      'Modified tracked file must be restored to clean HEAD'
    );

    // Fault 7 & Fault 10: `IGNORED_ARTIFACTS_LEFT` + `UNTRACKED_ARTIFACTS_LEFT` + `TEAM_BASE_BRANCH_DRIFTED`
    mockOrca.enqueueBehavior({
      kind: 'complete_clean',
      writeFiles: [
        { path: 'src/drift-target.mjs', content: 'export const x = 42;\n' },
        { path: 'debug-trace.tmp', content: 'junk log\n' },
        { path: 'dist/bundle.js', content: '// gitignored build artifact\n' }
      ]
    });
    const driftTask = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Drift & artifact detection task',
      task: 'Create drift-target.mjs',
      type: 'feature'
    });
    assert(driftTask.payload.task.risk.includes('UNTRACKED_ARTIFACTS_LEFT'));
    assert(driftTask.payload.task.risk.includes('IGNORED_ARTIFACTS_LEFT'));

    // Advance `main` externally so `baseSha` drifts!
    writeFileSync(join(repo1, 'external-hotfix.txt'), 'hotfix\n', 'utf8');
    await execGitSafe(['add', 'external-hotfix.txt'], { cwd: repo1 });
    await execGitSafe(['commit', '-m', 'fix: external commit on main'], { cwd: repo1 });

    const driftMerge = await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: driftTask.payload.task.taskId,
      action: 'merge',
      acknowledgeRisks: true
    });
    assert.equal(driftMerge.isError, true);
    assert.equal(driftMerge.payload.error.code, 'TEAM_BASE_BRANCH_DRIFTED');

    // Fault 8: Fail-closed cross-family review (`TEAM_CROSS_FAMILY_UNAVAILABLE`) when all non-qwen CLIs are offline
    setMockProbeClis({
      antigravity: { ...DEFAULT_ALL_READY_CLIS.antigravity, authenticated: false },
      pi: DEFAULT_ALL_READY_CLIS.pi, // `qwen` — same family as `driftTask`!
      kimi: { ...DEFAULT_ALL_READY_CLIS.kimi, authenticated: false },
      dsh: { ...DEFAULT_ALL_READY_CLIS.dsh, authenticated: false },
      opencode: { ...DEFAULT_ALL_READY_CLIS.opencode, authenticated: false }
    });
    const failClosedReview = await executeTeamTool('team_delegate', {
      workspaceRoot: repo1,
      title: 'Should fail-closed on cross-family check',
      task: 'Review driftTask',
      type: 'review',
      targetTaskId: driftTask.payload.task.taskId
    });
    assert.equal(failClosedReview.isError, true);
    assert.equal(failClosedReview.payload.error.code, 'TEAM_CROSS_FAMILY_UNAVAILABLE');

    // Discard `driftTask` cleanly
    setMockProbeClis(DEFAULT_ALL_READY_CLIS);
    await executeTeamTool('team_merge', {
      workspaceRoot: repo1,
      taskId: driftTask.payload.task.taskId,
      action: 'discard'
    });

    // Fault 9B: Delete `.team/state.json` and verify automatic self-healing from `.team/events.jsonl` + offline `audit.mjs`!
    rmSync(join(repo1, '.team', 'state.json'), { force: true });
    const boardAfterDelete = await executeTeamTool('team_board', { workspaceRoot: repo1 });
    assert.equal(boardAfterDelete.isError, false);
    assert(boardAfterDelete.payload.tasks.length >= 6);
    assert(existsSync(join(repo1, '.team', 'state.json')), 'state.json must be rebuilt automatically');

    const auditReport = await auditWorkspaceTeamLedger(repo1);
    assert.equal(auditReport.ok, true, JSON.stringify(auditReport));
    assert.equal(auditReport.orphanBranches.length, 0);

    console.log('\n[SMOKE PASSED] All positive 9-tool workflows, real Cabinet protocol bridge, and 10 fault-injection checks succeeded.');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

await runSmokeSuite();
