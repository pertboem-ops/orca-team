#!/usr/bin/env node
/**
 * Orca Team MCP Server (`team-mcp.mjs`).
 *
 * Controlled 9-tool engineering team gateway for Google Antigravity + stablyai/orca.
 * Supports BOTH newline-delimited JSON-RPC 2.0 (Antigravity default) and Content-Length framing.
 * Zero external npm dependencies (Node >= 20 built-ins only).
 */

import { resolve } from 'node:path';
import { executeTeamTool } from './lib/executor.mjs';

const SERVER_NAME = 'team-mcp';
const SERVER_VERSION = '0.2.0';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INSTRUCTIONS = [
  'Orca Team 受控多角色工程团队协同网关（9 工具面）：',
  '1. 派发任务仅需通过 `team_delegate` / `team_delegate_batch` 声明 `type` 与 `hard`，由网关按本机 5-CLI 实时探针确定性路由并自动维护主工作树独占租约。',
  '2. 验收与合入必须以 `.team/references/<taskId>.json` 中的客观 `facts` 与规则 `risk[]` 为准，绝不盲信子 Agent 自述（`untrusted-self-report`）。',
  '3. 对核心编码改动合入前，应调用 `team_delegate(type="review", targetTaskId=...)` 执行跨模型家族异源审查（网关强制 fail-closed 避让全部写 attempt 家族）。',
  '4. 命中 `CRITICAL_GIT_OR_ENV_TAMPERED` 或 `HIGH_RISK_FILE_MODIFIED` 时，必须先 `team_inspect` 逐行审查，严禁盲批放行。'
].join('\n');

// Pure scalar JSON Schema types ONLY (no array union types like `["string", "null"]`)
export const TOOLS = [
  {
    name: 'team_board',
    description:
      'Inspect the 5 engineering roles routing table, live CLI readiness probe, active Main-Worktree lease, orphan `team/*` branches, and all task summaries; or pass `taskId` + `waitSeconds` (0..55) to wait boundedly for a running task to settle.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        taskId: {
          type: 'string',
          description: 'Optional specific taskId to poll/inspect.'
        },
        waitSeconds: {
          type: 'integer',
          description: 'Bounded wait window in seconds when polling `taskId` (0 to 55, default: 0).'
        },
        forceProbeRefresh: {
          type: 'boolean',
          description: 'Force refresh of the 5-minute cached CLI readiness probe.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'team_delegate',
    description:
      'Deterministically route and dispatch an engineering task by `(type, hard)` under the Main-Worktree Exclusive Lease, capturing pre-Git SHA-256 sensitive file fingerprints, checking out `team/<taskId>` for write roles, and waiting up to `waitSeconds` (default 20s) for completion.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        title: {
          type: 'string',
          description: 'Concise task title.'
        },
        task: {
          type: 'string',
          description: 'Detailed engineering specification, acceptance criteria, and verification commands.'
        },
        type: {
          type: 'string',
          enum: ['architecture', 'feature', 'bugfix', 'refactor', 'review', 'test'],
          description: 'Task category mapped deterministically to one of the 5 roles.'
        },
        hard: {
          type: 'boolean',
          description: 'Set true for complex/high-stakes tasks to route to higher-capability tier.'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of relevant file paths to highlight in the worker briefing.'
        },
        targetTaskId: {
          type: 'string',
          description: 'For `type: "review"`: the write taskId to review (enforces fail-closed cross-family review and checks out its branch).'
        },
        reuseBranchOfTaskId: {
          type: 'string',
          description: 'For `type: "test"` or follow-up write work: reuse an existing REPORTED task branch `team/<id>`.'
        },
        idempotencyKey: {
          type: 'string',
          description: 'Optional caller idempotency key to prevent duplicate worker spawns on retry.'
        },
        waitSeconds: {
          type: 'integer',
          description: 'Bounded short-wait window in seconds (0 to 55, default: 20).'
        }
      },
      required: ['title', 'task', 'type'],
      additionalProperties: false
    }
  },
  {
    name: 'team_delegate_batch',
    description:
      'Validate and enqueue up to 4 tasks (`maxBatchSize = 4`), advancing them sequentially in FIFO order under the Main-Worktree Exclusive Lease within the bounded `waitSeconds` window.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        tasks: {
          type: 'array',
          description: '1 to 4 task specifications to execute in FIFO order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              task: { type: 'string' },
              type: {
                type: 'string',
                enum: ['architecture', 'feature', 'bugfix', 'refactor', 'review', 'test']
              },
              hard: { type: 'boolean' },
              files: { type: 'array', items: { type: 'string' } },
              targetTaskId: { type: 'string' },
              reuseBranchOfTaskId: { type: 'string' },
              idempotencyKey: { type: 'string' }
            },
            required: ['title', 'task', 'type'],
            additionalProperties: false
          }
        },
        waitSeconds: {
          type: 'integer',
          description: 'Bounded total wait window in seconds (0 to 55, default: 20).'
        }
      },
      required: ['tasks'],
      additionalProperties: false
    }
  },
  {
    name: 'team_approve',
    description:
      'Respond (`allow` or `deny`) to a pending Orca `question` / `escalation` mail or `decision_gate` on an `AWAITING_APPROVAL` task. Enforces raw SHA-256 tamper & high-risk file anti-blind-approval checks before `allow`.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        taskId: {
          type: 'string',
          description: 'Task ID currently in `AWAITING_APPROVAL`.'
        },
        requestId: {
          type: 'string',
          description: 'Pending approval `requestId` from `task.pendingApproval`.'
        },
        decision: {
          type: 'string',
          enum: ['allow', 'deny'],
          description: 'Approval decision.'
        },
        reason: {
          type: 'string',
          description: 'Optional guidance or denial reason sent back to the worker.'
        },
        acknowledgeHighRiskDiff: {
          type: 'boolean',
          description: 'Required when `decision === "allow"` and high-risk files (`package.json`, lockfiles, CI, etc.) were modified.'
        },
        acknowledgeCriticalTamper: {
          type: 'boolean',
          description: 'Required ONLY if `.git` / `.env*` / `.npmrc` raw SHA-256 fingerprint changes were intentionally inspected and approved.'
        },
        waitSeconds: {
          type: 'integer',
          description: 'Bounded wait window after relaying approval (0 to 55, default: 20).'
        }
      },
      required: ['taskId', 'requestId', 'decision'],
      additionalProperties: false
    }
  },
  {
    name: 'team_steer',
    description:
      'Send follow-up rework instructions to a `REPORTED` task (re-acquiring the Main-Worktree lease, checking out `team/<taskId>`, and cold-starting `attempt + 1` with objective `diffStat` context) or message an in-flight `RUNNING` worker.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        taskId: {
          type: 'string',
          description: 'Target taskId to steer.'
        },
        instruction: {
          type: 'string',
          description: 'Concrete rework or follow-up instruction.'
        },
        waitSeconds: {
          type: 'integer',
          description: 'Bounded wait window in seconds (0 to 55, default: 20).'
        }
      },
      required: ['taskId', 'instruction'],
      additionalProperties: false
    }
  },
  {
    name: 'team_inspect',
    description:
      'Zero-reconcile local deep-dive into `.team/references/<taskId>.json` (full 3-column firewall snapshot, untrusted full `agentReport`, optional full `git diff`, and optional Orca worker transcript/terminal tail).',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        taskId: {
          type: 'string',
          description: 'Task ID to inspect.'
        },
        includeFullDiff: {
          type: 'boolean',
          description: 'If true, includes the full `git diff baseSha..headSha` (capped at 64KB).'
        },
        includeTerminalTail: {
          type: 'boolean',
          description: 'If true, queries `orca orchestration worker-read` for transcript/terminal tail.'
        }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'team_interrupt',
    description:
      'Stop and release an active Orca worker, return to `baseBranch`, release the Main-Worktree lease, and optionally delete `team/<taskId>` & restore sensitive `.git` baseline (`discardBranch: true`).',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        taskId: {
          type: 'string',
          description: 'Task ID to interrupt.'
        },
        discardBranch: {
          type: 'boolean',
          description: 'If true, deletes `team/<taskId>` and restores any tampered sensitive baseline files.'
        }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'team_merge',
    description:
      'Controlled merge (`action: "merge"`, supporting `no-ff`, `squash`, `cherry-pick`) or clean rollback (`action: "discard"`) of a `REPORTED` task branch. Enforces pre-Git SHA-256 fingerprint verification, `baseSha` drift guard, and explicit risk acknowledgement.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory.'
        },
        taskId: {
          type: 'string',
          description: 'Task ID to merge or discard.'
        },
        action: {
          type: 'string',
          enum: ['merge', 'discard'],
          description: 'Merge into `baseBranch` or discard `team/<taskId>` cleanly.'
        },
        strategy: {
          type: 'string',
          enum: ['no-ff', 'squash', 'cherry-pick'],
          description: 'Git merge strategy when `action === "merge"` (default: `no-ff`).'
        },
        acknowledgeRisks: {
          type: 'boolean',
          description: 'Required when `action === "merge"` and `task.risk[]` is non-empty.'
        },
        acknowledgeCriticalTamper: {
          type: 'boolean',
          description: 'Required in addition to `acknowledgeRisks` ONLY when `CRITICAL_GIT_OR_ENV_TAMPERED` was inspected and confirmed benign.'
        }
      },
      required: ['taskId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'team_from_protocol',
    description:
      'Bridge from `orca-cabinet`: read `.cabinet/runs/<runKey>/protocol.json` (pass `"latest"` or omit `cabinetSessionId` to auto-resolve the newest finalized session from `.cabinet/index.jsonl`), validate `schemaVersion === 2`, write `.team/workflow-inputs/protocol-<runKey>.md`, and return structured task drafts.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path of the target Git workspace directory containing `.cabinet/`.'
        },
        cabinetSessionId: {
          type: 'string',
          description: 'Optional Cabinet session `runKey` or `"latest"` (default: `"latest"`).'
        }
      },
      additionalProperties: false
    }
  }
];

let useContentLengthFraming = false;
const inFlightControllers = new Map();

function writeRpcPayload(obj) {
  const json = JSON.stringify(obj);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function sendResult(id, result) {
  writeRpcPayload({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  writeRpcPayload({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  // Notifications (no `id`)
  if (!('id' in msg) || msg.id === undefined) {
    if (msg.method === 'notifications/cancelled' && msg.params?.requestId !== undefined) {
      const ctrl = inFlightControllers.get(msg.params.requestId);
      if (ctrl) {
        ctrl.abort();
        inFlightControllers.delete(msg.params.requestId);
      }
    }
    return;
  }

  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-03-26';
      sendResult(id, {
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        },
        instructions: SERVER_INSTRUCTIONS
      });
      return;
    }

    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      if (!toolName || !TOOLS.some((t) => t.name === toolName)) {
        sendError(id, -32602, `Unknown tool: ${String(toolName)}`);
        return;
      }

      const controller = new AbortController();
      inFlightControllers.set(id, controller);
      try {
        const outcome = await executeTeamTool(toolName, toolArgs, controller.signal);
        if (!inFlightControllers.has(id) && controller.signal.aborted) {
          return;
        }
        const text =
          typeof outcome.payload === 'string'
            ? outcome.payload
            : JSON.stringify(outcome.payload, null, 2);
        sendResult(id, {
          content: [{ type: 'text', text }],
          ...(outcome.isError ? { isError: true } : {})
        });
      } finally {
        inFlightControllers.delete(id);
      }
      return;
    }

    if (method === 'resources/list') {
      sendResult(id, { resources: [] });
      return;
    }

    if (method === 'prompts/list') {
      sendResult(id, { prompts: [] });
      return;
    }

    sendError(id, -32601, `Method not found: ${String(method)}`);
  } catch (err) {
    sendError(id, -32603, err instanceof Error ? err.message : 'Internal server error');
  }
}

let stdioStarted = false;

export function startTeamMcpServer() {
  if (stdioStarted) return;
  stdioStarted = true;

  // Redirect accidental console.log calls to stderr when running as stdio server
  console.log = (...args) => console.error('[team-mcp]', ...args);

  let rawBuffer = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    rawBuffer = Buffer.concat([rawBuffer, bufChunk]);

    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');

      // Framing mode A: Content-Length header
      if (/^Content-Length:/i.test(preview)) {
        useContentLengthFraming = true;
        const headerEnd = rawBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const m = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          rawBuffer = rawBuffer.subarray(headerEnd + 4);
          continue;
        }
        const contentLen = Number(m[1]);
        const bodyStart = headerEnd + 4;
        if (rawBuffer.length < bodyStart + contentLen) break;

        const bodyStr = rawBuffer.subarray(bodyStart, bodyStart + contentLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(bodyStart + contentLen);
        try {
          void handleRpcMessage(JSON.parse(bodyStr));
        } catch (err) {
          sendError(null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }

      // Framing mode B: Newline-delimited JSON (Antigravity default)
      const nlIndex = rawBuffer.indexOf(0x0a);
      if (nlIndex === -1) break;
      const lineStr = rawBuffer.subarray(0, nlIndex).toString('utf8').replace(/\r$/, '').trim();
      rawBuffer = rawBuffer.subarray(nlIndex + 1);
      if (!lineStr) continue;
      try {
        void handleRpcMessage(JSON.parse(lineStr));
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  process.stdin.on('end', () => {
    for (const ctrl of inFlightControllers.values()) {
      ctrl.abort();
    }
    inFlightControllers.clear();
    process.exit(0);
  });
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase().endsWith('team-mcp.mjs')) {
  startTeamMcpServer();
}
