# `orca-team` — 基于 `stablyai/orca` 的 Antigravity 受控工程团队协同网关 (`v0.2.1`)

`orca-team` 是面向 Google Antigravity IDE/CLI 的零外部依赖多角色工程团队协同插件，对标升级自 [`Git-Yi-Zhou/paseo-team`](https://github.com/Git-Yi-Zhou/paseo-team)，并经 [`pertboem-ops/orca-cabinet`](https://github.com/pertboem-ops/orca-cabinet) 四模型异构内阁（`anthropic` × `moonshot` × `qwen` × `deepseek`）两轮红蓝攻防审议定稿。

它与 `orca-cabinet` 共同组成**「前店（内阁议事定策）+ 后厂（工程团队受控施工）」**双插件闭环：
- **前店 (`orca-cabinet`)**：针对高选错代价决策召开异构内阁独立立论与交叉质询，归档防伪议定书 `.cabinet/runs/<runKey>/protocol.json`；
- **后厂 (`orca-team`)**：通过 `team_from_protocol` 一键读取议定书，将 `actions[]` 委派给 5 大专职工程角色，在主工作树独占租约、前置原始文件指纹防篡改、跨家族写审异源门禁与三栏上下文防火墙保护下完成编码、审查、测试与受控合入。

---

## 核心特性（`v0.2` 内阁审议定稿架构）

1. **5 大工程角色确定性路由 + 三级自动降级（5 款本机异构 CLI）**：
   - 内置 `architect`（只读）、`coder-fast`（受控写）、`coder-pro`（攻坚写）、`reviewer`（只读·强制异源）、`tester`（受控写）；
   - 适配本机实证的 `antigravity`（`--model`/`--effort` 强传参）+ `kimi` (`moonshot`) + `pi` (`qwen`) + `dsh` (`deepseek`) + `opencode` 异构池，单 CLI 离线或未登录时自动沿 `primary → fallback1 → fallback2` 无缝降级。
2. **证据分级的分支谱系写审异源门禁（Fail-Closed + `t0/t1` 双端配置夹击校验）**：
   - 在派发前 `t0` 与结算时 `t1` 双端鲜读 CLI 本地配置（防运行期配置篡改 TOCTOU 漂移），记录 `actualProviderFamily`、`familyConfidence` 与 `reviewIndependenceGrade`；
   - 自动聚合共享分支谱系（含 `reuseBranchOfTaskId` 与多轮 `team_steer`）全生命周期 `writerFamilies` 并集，`reviewer` 强制跳过所有写模型家族及 `unknown`，无可用异源候选时直接 `TEAM_CROSS_FAMILY_UNAVAILABLE` 阻断。
3. **前置原始文件 SHA-256 即时隔离防线 + 免疫型 Git 封装**：
   - 沿分支根基线（`rootFingerprints`）在调用**任何** `git` 子进程前，使用 Node 原生 `fs` + `crypto` 对 `.git/config`、`.git/hooks/**`、`.git/info/*`、`.gitattributes`、`.vscode/{tasks,settings}.json`、`.env*`、`.npmrc` 做 SHA-256 指纹比对；
   - 一旦检测到可执行级篡改（如 `core.fsmonitor` 注入），在 `REPORTED` 瞬间即由纯 Node 留存取证片段并**当场还原洁净字节**（防宿主 IDE 后台 `git status` 秒级引爆 RCE），且永久封锁合入（`TEAM_EXECUTABLE_TAMPER_UNMERGEABLE`）；网关所有 `git` 命令强制前置 `-c core.hooksPath= -c core.fsmonitor=false`。
4. **主工作树全角色独占租约 + `REPORTED` 原子回基 + 冷启动 `steer`**：
   - 100% 零拷贝复用主目录 `node_modules` / `.venv`，Windows 下秒跑单测；
   - Worker 结束进入 `REPORTED` 时立即 `worker-release` 销毁终端防僵尸驻留，将分支改动快照固化至 `team/<taskId>` 后原子切回 `baseBranch` 释放主树租约，无缝解锁后续 `reviewer` 检出审查与 `team_steer` 冷启动返工。
5. **客观事实驱动的三栏上下文防火墙**：
   - 严格分离客观 `facts`（Diff 统计、指纹异变、未跟踪/被忽略残留）、零 Token 规则 `risk[]` 与不可信自述 `agentReport` (`trustLevel: "untrusted-self-report"`)，向主控返回精简摘要，按需通过 `team_inspect` 深钻。
6. **诚实安全边界披露**：
   - Orca Worker 运行于宿主用户终端下，无 OS 级沙箱；网关提供强合并前审计门禁与 Orca 邮箱/Gate 转发（`approval-relay`），但不宣称对仓库外路径写入或测试期出网副作用作事前物理拦截。

---

## 9 个受控 MCP 工具一览

| 工具名 | 职责说明 |
| :--- | :--- |
| `team_board` | 查看 5 角色实时路由与 CLI 探针状态、主树租约与任务面板；或传 `taskId` + `waitSeconds` 有界等待进展 |
| `team_delegate` | 按 `(type, hard)` 确定性派发单任务（含 `idempotencyKey` 幂等去重、前置指纹基线与 `waitSeconds` 短等待） |
| `team_delegate_batch` | 批量登记最多 4 个子任务，在主树独占租约下按 FIFO 自动串联推进 |
| `team_approve` | 回复处理挂起的 Orca `question`/`escalation` 邮件与 `decision_gate`（含高危文件反盲批拦截） |
| `team_steer` | 对 `REPORTED` 任务重检出 `team/<taskId>` 携带前序客观 Diff 冷启动 `attempt + 1` 返工（或向运行中任务发信） |
| `team_inspect` | 纯本地零延迟深钻 `.team/references/<taskId>.json` 全量三栏快照、完整 `git diff` 与终端尾部日志 |
| `team_interrupt` | 终止运行中或挂起的任务、释放终端与主树租约，支持 `discardBranch: true` 回滚清理 |
| `team_merge` | 防漂移合入（`no-ff` / `squash` / `cherry-pick`）或无痕丢弃（`discard`，自动恢复基线 `.git` 配置并删分支） |
| `team_from_protocol` | 读取 `.cabinet/runs/<runKey>/protocol.json`（支持 `"latest"`），生成共享决议施工单与推荐派发草案 |

---

## 快速安装与验证

要求：Node.js `>= 20.0.0`、Git，以及本机已安装 [`stablyai/orca`](https://github.com/stablyai/orca)。

```bash
# 1. 静态门禁校验（清单白名单、语法、9 工具 Schema、多家族降级链不变量）
npm run verify

# 2. 端到端冒烟与故障注入回归测试（正向全闭环 + >=8 条红队攻击/异常注入用例）
npm run smoke

# 3. 挂载至本机 Antigravity 插件目录（自动注册 ~/.gemini/config/plugins.json + Windows Junction）
npm run link-plugin

# 4. 离线审计指定工作区的 .team/ 事件账本与租约状态
npm run audit -- --workspace .
```

卸载插件挂载：

```bash
npm run unlink-plugin
```
