# 当前工程状态审查（2026-07-22）

> 文档类型：工程审计快照，不是产品或领域规范。
> 权威产品语义仍以 [`../tackle-forger-development-spec-v3.md`](../tackle-forger-development-spec-v3.md) 为准。
> 审查分支：`review/current-state-2026-07-22`
> 审查提交：`d792aff2`
> 对比主线：`origin/main` at `a393c547`

## 1. 审查范围

本次审查覆盖：

- 根目录 Vinext/Next.js 工作台；
- v3 规则内核、Patch Ledger、Series/SKU/Model/Snapshot 链路；
- Feishu OAuth、规则工作簿与数据源回写；
- SQLite、Vercel Blob 和历史兼容存储代码；
- R730 部署、备份与迁移脚本；
- 最新合入的 `apps/web`、`packages/*` pnpm workspace；
- 当前分支相对最新 `origin/main` 的 Git 状态。

本次没有修改产品语义，也没有修复审查发现；问题统一登记在 [`engineering-issue-register.md`](./engineering-issue-register.md)。

## 2. 已执行的 Git 操作

1. 当前工作目录确认成 `E:/DocsHDD/tackleForger`，不是临时 `.claude/worktrees`。
2. 创建审查分支 `review/current-state-2026-07-22`，避免继续直接在 `main` 上操作。
3. 执行 `git fetch --all --prune`。
4. 将最新 `origin/main` 合并到审查分支。
5. 解决 `package.json` 单一文本冲突，保留根 Vinext 脚本、workspace 目录 ESLint 排除和 `db:generate`。
6. 生成合并提交 `d792aff2`。
7. 未执行 push。

当前另有独立 worktree：

```text
E:/DocsHDD/tackleForger/.claude/worktrees/v3-work
branch: worktree-v3-work
HEAD: 03d010c9
```

该 worktree 未被本次合并、修改或删除。

## 3. 验证结果

### 3.1 根 Vinext 应用

以下命令均通过：

```text
npm run typecheck
npm run lint
npm test
```

完整测试结果：

- TypeScript/Node 测试：186 通过，0 失败；
- rendered HTML 测试：1 通过，0 失败；
- Vinext 生产构建成功；
- API 构建包含 `/api/series`、`/api/series-gantt`、Feishu、state、revisions 等路由。

非阻断警告：

- 客户端仍有压缩后超过 500 kB 的 chunk；
- Vinext 暂时无法静态分类部分动态 API；
- 测试环境检测到代理变量。

### 3.2 pnpm workspace

最新主线引入：

```text
apps/web
packages/domain
packages/db
packages/excel
packages/ui
```

直接执行 `pnpm` 时系统没有全局命令；使用 Corepack 后版本为 `10.13.1`。执行：

```text
corepack pnpm -r typecheck
```

未完成验证，原因是 workspace 依赖尚未安装：

- `drizzle-orm`；
- `exceljs`；
- `decimal.js`；
- `vitest`；
- 各 workspace 本地 `node_modules`。

这属于“验证前置条件未满足”，不是已经证明的代码测试失败。本次未擅自执行 `pnpm install`，以免在审查提交中混入安装产物或锁文件变化。

## 4. 已验证解决的历史问题

### 4.1 Patch 与 Affix 执行顺序

`lib/rule-kernel.ts` 现按以下顺序执行：

```text
SeriesPatch
→ SkuPatch
→ ModelPatch
→ Affix/Technology
→ FinalReviewPatch
→ Validation
```

已与 v3 规范对齐，并有非交换操作测试。

### 4.2 结构投影匹配上下文

`lib/compatibility.ts` 已提供结构匹配专用上下文和规则过滤：

- `structuralCompatibilityContext`；
- `isStructuralCompatibilitySelector`；
- `evaluateStructuralHardCompatibility`。

Quality、Performance、functionIntensity、Material、重量范围、组件和标签不再参与结构标杆选择。

### 4.3 Series 服务端创建命令

已新增 `POST /api/series`：

- 服务端重新认证；
- 检查 `create_series → series.edit`；
- 选择已发布 RuleSet；
- 执行结构匹配和离散 SKU 物化；
- 按工作区 revision 保存。

客户端已改为调用该命令，不再自行完成主要创建计算。

### 4.4 Vercel 构建副作用

`vercel.json` 不再通过脚本原地删除 `package.json` 的 `type` 字段。

### 4.5 旧认证代码

未使用且安全边界较弱的 `app/chatgpt-auth.ts` 已删除。

### 4.6 Feishu 数据源回写恢复

`commitFeishuWriteback` 已实现：

- 写前回读幂等判断；
- 写后回读验证；
- 写入报错后的回读恢复；
- `written/alreadyApplied/recovered/failed` 明确状态；
- 逐记录证据。

### 4.7 R730 正式存储路径

已增加：

- SQLite 工作区存储；
- Blob 到 SQLite 迁移脚本；
- 数据库和导入文件备份脚本；
- systemd、Nginx 和备份 timer 示例；
- R730 部署文档。

SQLite 的保存冲突、历史冻结、导入和原子文件落盘已有测试。

## 5. 当前主要风险摘要

完整状态、证据和验收条件见问题台账。当前最高优先级包括：

1. `PUT /api/state` 仍可通过整包状态提交绕过领域命令校验；
2. `POST /api/series` 缺少完整运行时枚举和引用验证；
3. Series/SKU 创建缺少命令级幂等恢复；
4. 非法离散拉力 token 被静默忽略；
5. 新合入的第二套 `apps/web`/`packages/*` 架构尚未确定权威地位；
6. 新 workspace 尚未安装依赖并完成构建、类型检查和测试；
7. 导入文件审计人使用空 Feishu email；
8. R730 service 的可写目录依赖运维覆盖相对默认路径；
9. SQLite revision 永久保留策略尚未明确；
10. 甘特图 UI 仍没有消费服务端分页和可见性 API。

## 6. 架构状态

仓库现在同时包含两套应用结构：

### 根应用

```text
app/
lib/
worker/
Vinext + Vite + Next App Router
```

该实现包含当前完整 v3 工作台，已通过完整根测试。

### 新 workspace

```text
apps/web
packages/domain
packages/db
packages/excel
packages/ui
```

这是另一套 Next.js + 分包架构。目前尚未证明它与根应用之间的迁移、替代或共存关系。

必须明确其中之一：

- 根应用继续是正式实现，workspace 仅实验；
- workspace 是下一代正式实现，建立分阶段迁移计划；
- 两者服务不同目标，并明确数据和功能边界。

在决策前，不应同时在两套应用中实现相同业务功能，否则会形成语义漂移和双倍维护成本。

## 7. 后续审查和关闭规则

- 所有开放问题使用 `AUD-xxx` ID 管理；
- 修复提交必须引用对应 ID；
- 关闭问题时记录提交 SHA、验证命令和测试名称；
- `RESOLVED` 仅表示验收条件全部满足；
- 无法近期修复但明确接受的风险使用 `ACCEPTED_RISK`，并记录接受理由与复查日期；
- 新审查不得改写本文件的历史事实，应新增审查快照或在问题台账中更新状态。
