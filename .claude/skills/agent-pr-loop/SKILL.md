---
name: agent-pr-loop
description: 主 agent 已直接实现代码后，把 PR 走完「独立审核 → 主 agent 修 → 当前 head CI → 全门禁通过即合并」的闭环。当用户说「审完合并」「复审后合并」「合并收尾」「搞定这个 PR」「把当前 PR 跑完」时启用，尤其是应由 Codex 推断当前 PR 而不要求用户给出编号时。
---

## 工作模式（主 agent 实现 + 按需审核）

本仓库工作模式（见项目 CLAUDE.md「Agent 工作模式」与记忆 [[workflow-main-implements-review-on-demand]]）：**实现、修改、调查由主 agent 直接做，不 spawn 实现 agent。本 skill 只负责审核 + CI + 合并闭环。**

主 agent 实现并 push head 后，需要独立审核时有两条路（可选其一或并行）：
1. **输出审核清单**（见下）→ 用户粘到常驻审核 agent 窗口（省 install + 上下文重建，推荐用于敏捷迭代）；
2. **spawn 独立审核 agent**（opus，只读，可用 isolation:worktree 从 origin/main 干净读取避免本地落后）审当前 head。

## 审核清单格式（主 agent 实现完后输出，可粘贴）

```
审查 PR #<N>（仓库 <owner/repo>，<head 分支> → <base>）。
head: <完整 SHA>，base: <base 完整 SHA>。对应 Issue #<M>。

你是独立 reviewer（opus），只读，不写代码/不 push/不 approve。
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

1. 审核者报告绑定精确 head SHA 的发现（按严重度排序）。
2. **主 agent 直接修复**（不 spawn），跑 typecheck/lint/test，push 新 head（普通 push，不 rebase+force-push）。
3. 等新 head 的 PR CI。
4. 审核者对精确新 head 增量复审。
5. 重复至 `Agent-Review: PASS` 或达上限（默认 3 轮，超限上报用户）。
6. **head 一变，旧 PASS / CI / 审核 disposition 一律作废**，复审针对精确新 head。

## 选定 PR

1. 给了显式 PR 编号或 URL 就用它。
2. 否则，查询当前仓库检出分支对应的 PR。
3. 否则，用当前 Issue 或近期任务上下文显式关联的唯一 open PR。
4. 若仍多于一个候选，最多展示三个候选让用户选择。不要猜。

## GitHub 当邮箱与事实来源

Agent 进程可能无法跨会话存活（压缩、/model 切换、进程退出）：每条改变处置的结论——发现、已验证修复、push、CI 结果、最终审核 signal——都必须**绑定精确 head/base SHA 发布到 GitHub**（PR comment 或 review），不能只存在临时消息里。中断后恢复从 GitHub（PR head、reviews、checks、threads）重建，绝不依赖记忆或陈旧本地上下文。

## 就绪与合并门禁

仅当某一精确 head/base 对同时满足以下全部条件，才宣布 PR 就绪并合并：
- 已同步到最新预期集成 base，且工作树干净；
- 完成仓库要求的本地验证（typecheck/lint/test）并有精确结果；
- 每个必需的 PR CI 任务在其当前 run/attempt 上成功；过期、缺失、pending 或失败的一律阻断；
- 没有未解决的可执行 review 线程；
- 有一份绑定该精确 head/base 对的实质性独立审核，含 `Agent-Review: PASS`；
- PR 处于 open、非草稿、可合并，满足分支保护。

自动合并是常规完成路径；闭环给出全部信息后不要再问冗余确认。用户当回合可覆盖（「只审不合并」「不合并」）。

仅当命中显式人工关卡时才暂停请求人工决策：未决产品语义/范围、破坏性或不可逆数据变更、安全/授权边界、合并触发部署/发布、必需验证不可用、依赖或合并顺序不明、重试上限耗尽。不把普通代码质量或泛泛「再谨慎些」标成关卡。

## 避免 rebase + force-push

本仓库 `check-committed-whitespace` 在 push 事件用 `before-SHA` 跑 `git diff --check before..after`；force-push 会让 `before-SHA` 变孤儿 → `fatal: bad object` → 行尾 check 误报失败（实测于 #122）。整合 main 一律用 `gh pr update-branch` 或新增提交，**不要 rebase 后 force-push**（除非该分支从未推送过）。
