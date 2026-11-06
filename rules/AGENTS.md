# Orca Team 工程团队协同调度纪律 (Team Lead Rules)

在非内阁议事的日常工程研发与决议施工落地任务中，当你需要委派 Orca 子 Agent 舰队执行架构拆解、编码实现、异源代码审查或测试编写时，应优先使用 `orca-team` 提供的 **9 个受控高阶工具**（`team_board`, `team_delegate`, `team_delegate_batch`, `team_approve`, `team_steer`, `team_inspect`, `team_interrupt`, `team_merge`, `team_from_protocol`），切勿裸调底层 `orca_*` 工具直接派发工程写任务：

## 1. 铁律一：确定性角色路由与主工作树独占保护
- 调用 `team_delegate` 时，仅需声明 `type`（`architecture` / `feature` / `bugfix` / `refactor` / `review` / `test`）与 `hard`（`true` / `false`），由网关按本机 5 款异构 CLI 实时就绪态确定性路由至 5 大角色（`architect` / `coder-fast` / `coder-pro` / `reviewer` / `tester`）。
- 派发前主工作区必须保持 `git status --porcelain` 干净（`.team/` 与 `.cabinet/` 元数据除外）；所有角色共享主工作树独占租约（零拷贝复用 `node_modules` / `.venv`），`REPORTED` 时自动固化至 `team/<taskId>` 并原子切回 `baseBranch` 释放租约。

## 2. 铁律二：认准三栏防火墙中的客观事实（`facts` + `risk[]`）与前置指纹防线
- 子 Agent 完成后，网关先于任何 `git` 命令执行纯 Node SHA-256 敏感文件指纹复核（`.git/config`、`.git/hooks/**`、`.env*`、`.npmrc` 等），随后生成 `.team/references/<taskId>.json` 三栏快照：
  - **`facts`**：网关直接从原始文件指纹比对、`git diff --stat` 与 `git status --porcelain` 采集的客观事实；
  - **`risk[]`**：网关基于规则自动计算的确定性风险标签（如 `CRITICAL_GIT_OR_ENV_TAMPERED`、`HIGH_RISK_FILE_MODIFIED`、`READONLY_ROLE_DIRTIED_TREE`、`UNTRACKED_ARTIFACTS_LEFT`、`IGNORED_ARTIFACTS_LEFT`）；
  - **`agentReport`**：子 Agent 主观自述（强制标记为 `untrusted-self-report`，仅供参考）。
- **主控验收与合入必须以 `facts` 和 `risk[]` 为唯一准绳**，绝不盲信子 Agent 自述。

## 3. 铁律三：反盲批与篡改硬拦截（`team_approve` / `team_merge`）
- 若任务命中 `CRITICAL_GIT_OR_ENV_TAMPERED`（例如 `.git/config`、`hooks` 或 `.env` 被篡改），**严禁盲目放行或合入**！必须立即调用 `team_inspect` 彻查篡改明细，确认系攻击或误改后调用 `team_merge({ taskId, action: "discard" })` 回滚恢复基线。
- 若命中 `HIGH_RISK_FILE_MODIFIED`（如修改了 `package.json`、lockfile、CI 配置），必须先调用 `team_inspect({ taskId, includeFullDiff: true })` 逐行核查 Diff 无脚本注入后，方可携带 `acknowledgeHighRiskDiff: true`（`team_approve`）或 `acknowledgeRisks: true`（`team_merge`）显式放行。

## 4. 铁律四：写审异源对冲与防漂移合入
- 对核心编码/重构任务处于 `REPORTED` 后，应调用 `team_delegate({ type: "review", targetTaskId, title, task })` 发起异源代码审查（网关自动跳过该分支全部写 `attempt` 的模型家族，确保跨家族独立互审）。
- 审查发现小问题时，调用 `team_steer({ taskId, instruction })` 在同一 `team/<taskId>` 分支携带客观 Diff 冷启动返工；验收通过后调用 `team_merge({ taskId, action: "merge", strategy: "no-ff" })` 受控合入并自动清理临时分支。
