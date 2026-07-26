---
name: agent-pr-loop
description: coordinator 已组织实现并形成 PR head 后，把 PR 走完「稳定 head → CI 与 tier 审核并行 → 汇总批量修复 → 集成证据」的闭环，并在实际发生合并时执行安全回读。当用户说「审完合并」「复审后合并」「合并收尾」「搞定这个 PR」「把当前 PR 跑完」时启用，尤其是应由 Codex 推断当前 PR 而不要求用户给出编号时。
---

## 定位

本 skill 在项目 `CLAUDE.md`「Agent 工作模式」定义的工作模式下运作；实施容量由 coordinator 按任务决定，此处不另行固定。**本 skill 负责审核、CI、集成证据和实际合并后的安全回读，但不规定 Agent 是否执行合并。**

TaskBrief 的`reviewTier: fast | standard | strict`只决定审核边界与强度，`riskProfile`与`riskDimensions`仍是风险事实权威。`unknown_high_risk`，或持久化数据、历史快照、并发、授权、外部副作用任一风险维度为真时必须选择`strict`；其他情况由coordinator动态选择。`fast`不要求独立Reviewer或review receipt；`standard`只在最终稳定PR head做一次独立审核，禁止本地先审一次再在PR重复；`strict`允许coordinator安排提前审核、多个正交范围和必要复审。需要或选择审核时，coordinator按任务风险、范围、可用能力与资源决定审核者数量、专长、模型、推理强度和串并行安排，不写死人数或模型。每个独立审核范围都只读、基于证据，并绑定当前精确head/base；所有发现由coordinator处置后才可整合唯一最终审核信号。独立审核有两条路（可选其一或并行）：
1. **输出审核清单**（见下）→ 用户粘到常驻审核 agent 窗口（省 install + 上下文重建，推荐用于敏捷迭代）；
2. **spawn 独立审核 agent**（只读；模型与推理强度在 spawn 时按当前可用性与任务动态选定，须足够强以保证审核有效，可用 isolation:worktree 从 origin/main 干净读取避免本地落后）审当前 head。

## 审核清单格式（coordinator 形成 head 后输出，可粘贴）

```
审查 PR #<N>（仓库 <owner/repo>，<head 分支> → <base>）。
head: <完整 SHA>，base: <base 完整 SHA>。对应 Issue #<M>。

你是独立 reviewer（只读；模型由 spawn 方按当前可用性选定，须足够强），不写代码/不 push/不 approve。
用 gh pr diff <N> / gh pr view <N> 看改动；必要时 gh api ...?ref=<head> 取文件（勿信本地落后 checkout）。
必读：<AGENTS.md/CLAUDE.md/docs/README.md/v3 规范 相关节> + Issue #<M>。
重点核实：<本次重点 1–5 项>。

通过则用 gh pr review <N> --comment 发含以下字段的 review：
Agent-Review-Version: v1
Reviewer-Role: independent-review-agent
Head-SHA: <完整>
Base-SHA: <完整>
Verdict: PASS
Agent-Review: PASS
有 high/critical 可执行发现则报告，不发 PASS。
```

## 审核闭环

1. coordinator一次性处置当前已知发现，安排最小必要的批量修复容量，跑适用的typecheck/lint/test，形成稳定候选head。
2. push候选head（普通push，不rebase+force-push），并回读确认本地、远端分支与GitHub PR head一致。
3. 回读成功后立即并行启动该head的GitHub PR CI与tier要求的所有独立审核范围；`fast`可没有审核分支，`standard`在这里进入独立审核边界，`strict`启动coordinator选定的范围。
4. 等CI与审核两边都结束，不把审核串行排在CI之后，也不把CI串行排在审核之后。
5. coordinator一次性汇总CI失败、审核发现、PR评论和thread状态；需要修复时把兼容修复合成下一批，再从第1步继续。
6. 重复至tier与仓库门禁要求的审核信号、CI和对话处置均满足，或达上限（默认3轮，超限上报用户）。
7. **head 一变，旧 PASS / CI / 审核 disposition 一律作废**；只对精确新head复审。多个reviewer仍只形成一个coordinator整合后的最终信号，不创建按人数计的长期receipt。

## 选定 PR

1. 给了显式 PR 编号或 URL 就用它。
2. 否则，查询当前仓库检出分支对应的 PR。
3. 否则，用当前 Issue 或近期任务上下文显式关联的唯一 open PR。
4. 若仍多于一个候选，最多展示三个候选让用户选择。不要猜。

## GitHub 当邮箱与事实来源

Agent 进程可能无法跨会话存活（压缩、/model 切换、进程退出）：每条改变处置的结论——发现、已验证修复、push、CI 结果、最终审核 signal——都必须**绑定精确 head/base SHA 发布到 GitHub**（PR comment 或 review），不能只存在临时消息里。中断后恢复从 GitHub（PR head、reviews、checks、threads）重建，绝不依赖记忆或陈旧本地上下文。

## 集成证据与合并门禁

> 合并门禁的**权威规则见 `AGENTS.md`「GitHub合并门禁」与 `.github/merge-gates.md`**（CI provenance、run-name、governance:check-pr、`Agent-Review: PASS` 信号、高风险分类等）。下文仅是本 skill 的操作摘要，冲突时以 AGENTS.md 为准。

仅当某一精确 head/base 对同时满足以下全部条件，才认为集成证据完整：
- 已同步到最新预期集成 base，且工作树干净；
- 完成仓库要求的本地验证（typecheck/lint/test）并有精确结果；
- 每个必需的 PR CI 任务在其当前 run/attempt 上成功；过期、缺失、pending 或失败的一律阻断；
- 没有未解决的可执行 review 线程；
- tier或仓库/平台门禁要求的独立审核证据（若有）绑定该精确head/base对，并含`Agent-Review: PASS`；
- PR 处于 open、非草稿、可合并，满足分支保护。


仅当命中显式人工关卡时才暂停请求人工决策：未决产品语义/范围、破坏性或不可逆数据变更、安全/授权边界、合并触发部署/发布、必需验证不可用、依赖或合并顺序不明、重试上限耗尽。不把普通代码质量或泛泛「再谨慎些」标成关卡。

## 避免 rebase + force-push

本仓库 `check-committed-whitespace` 在 push 事件用 `before-SHA` 跑 `git diff --check before..after`；force-push 会让 `before-SHA` 变孤儿 → `fatal: bad object` → 行尾 check 误报失败（实测于 #122）。整合 main 一律用 `gh pr update-branch` 或新增提交，**不要 rebase 后 force-push**（除非该分支从未推送过）。
