---
name: team-workflow
description: 使用 orca-team 受控工程团队网关调度 5 大专职工程角色（architect / coder-fast / coder-pro / reviewer / tester）协同完成架构拆解、编码实现、跨家族异源审查、测试验证及 orca-cabinet 内阁议定书施工落地。
---

# Orca Team 工程团队协同工作流指南 (`orca-team` v0.2)

`orca-team` 是面向 Google Antigravity + `stablyai/orca` 的受控多角色工程协同网关，与 `orca-cabinet` 组成**「前店（异构内阁议事定策）+ 后厂（工程团队受控施工）」**双插件闭环。

## 一、核心角色与确定性路由表 (`type × hard`)

| 任务类型 (`type`) | `hard: false` (常规档) | `hard: true` (攻坚档) | 权限与主树隔离契约 |
| :--- | :--- | :--- | :--- |
| `architecture` | `architect` (`pi` → `kimi` → `gpt-oss-120b`) | `architect` (`kimi` → `claude-opus-5-5` → `pi`) | 严格只读 · 主树独占租约（违规脏树打标自动复原） |
| `feature` | `coder-fast` (`pi` → `claude-sonnet-5-5` → `dsh`) | `coder-pro` (`claude-opus-5-5` → `kimi` → `pi`) | 受控写 · `team/<taskId>` 分支，`REPORTED` 固化并回基释放锁 |
| `bugfix` | `coder-fast` (`pi` → `claude-sonnet-5-5` → `dsh`) | `coder-pro` (`claude-opus-5-5` → `kimi` → `pi`) | 受控写 · `team/<taskId>` 分支，`REPORTED` 固化并回基释放锁 |
| `refactor` | `coder-fast` (`pi` → `claude-sonnet-5-5` → `dsh`) | `coder-pro` (`claude-opus-5-5` → `kimi` → `pi`) | 受控写 · `team/<taskId>` 分支，`REPORTED` 固化并回基释放锁 |
| `review` | `reviewer` (`gpt-oss-120b` → `dsh` → `kimi` → `sonnet`) | `reviewer` (`sonnet` → `gpt-oss-120b` → `kimi` → `dsh`) | 严格只读 · **强制跳过 `targetTaskId` 全部写模型家族（Fail-Closed）** |
| `test` | `tester` (`dsh` → `gpt-oss-120b` → `pi`) | `tester` (`claude-sonnet-5-5` → `kimi` → `dsh`) | 受控写 · 独立分支或 `reuseBranchOfTaskId` 续写补测 |

## 二、标准五步受控工程施工 SOP

1. **承接内阁议定书（可选，`team_from_protocol`）**：
   - 当刚完成 `orca-cabinet` 审议结案时，调用 `team_from_protocol({ workspaceRoot, cabinetSessionId: "latest" })`。
   - 网关自动解析 `.cabinet/index.jsonl` 与 `.cabinet/runs/<runKey>/protocol.json`（强制校验 `schemaVersion === 2`），在 `.team/workflow-inputs/protocol-<runKey>.md` 落盘共享决议上下文，并返回带推荐 `(type, hard)` 的结构化待委派草案数组。
2. **受控派发与有界等待（`team_delegate` / `team_delegate_batch`）**：
   - 单任务调用 `team_delegate({ workspaceRoot, title, task, type, hard })`；多步串联任务可调用 `team_delegate_batch({ workspaceRoot, tasks })`（最多 4 项，在主树独占租约下按 FIFO 自动推进）。
   - 网关在派发前捕获 `.git/config`、`.git/hooks/**`、`.env*`、`.npmrc` 原始 SHA-256 指纹基线与 `baseSha`，零拷贝检出 `team/<taskId>` 分支复用主目录 `node_modules`，并在 `waitSeconds`（默认 `20s`，上限 `55s`）窗口内等待。
   - 若超时仍为 `RUNNING`，继续调用 `team_board({ workspaceRoot, taskId, waitSeconds: 30 })` 推进等待。
3. **处理挂起提问与反盲批门禁（`team_approve`）**：
   - 若任务进入 `AWAITING_APPROVAL`（Worker 发出 Orca `question` / `escalation` 邮件或触发 `decision_gate`），检查 `pendingApproval`。
   - 若检测到高危文件变动，先调用 `team_inspect({ workspaceRoot, taskId, includeFullDiff: true })` 审查完整 Diff，确认安全后传 `acknowledgeHighRiskDiff: true` 调用 `team_approve`。
4. **跨家族异源审查与冷启动返工（`team_delegate(review)` / `team_steer`）**：
   - 写任务进入 `REPORTED` 后（网关已固化提交至 `team/<taskId>` 并自动切回 `baseBranch` 释放主树锁），调用 `team_delegate({ workspaceRoot, type: "review", targetTaskId, title, task })` 启动跨家族独立代码审查。
   - 若审查指出缺陷或需补充测试：
     - 可调用 `team_steer({ workspaceRoot, taskId, instruction })` 重检出 `team/<taskId>` 携带客观 Diff 冷启动 `attempt + 1` 返工；
     - 或调用 `team_delegate({ workspaceRoot, type: "test", reuseBranchOfTaskId: taskId, title, task })` 委派 `tester` 在同一任务分支补齐单测。
5. **指纹复核合入或一键无痕回滚（`team_merge`）**：
   - 验收通过：`team_merge({ workspaceRoot, taskId, action: "merge", strategy: "no-ff" })`（若 `risk[]` 非空需核查后显式传 `acknowledgeRisks: true`；若含 `CRITICAL_GIT_OR_ENV_TAMPERED` 还需 `acknowledgeCriticalTamper: true`，通常应直接 `discard`）。
   - 废弃回滚：`team_merge({ workspaceRoot, taskId, action: "discard" })`（自动删除 `team/<taskId>` 分支并恢复基线 `.git` 配置）。

## 三、诚实安全边界提示

- `orca-team` 通过前置原始文件 SHA-256 指纹与 `-c core.hooksPath= -c core.fsmonitor=false` 彻底封堵了 `.git/config` / `hooks` RCE 注入与工作树静默篡改合入；
- 但 Orca Worker 运行在宿主当前用户终端下，无 OS 级文件系统沙箱，不拦截 Worker 运行期间对仓库外目录（如 `$HOME`）的直接读写或测试脚本出网副作用。
