# 工程问题台账

> 本台账记录工程风险、验证空洞和架构决策，不覆盖产品与领域规范。  
> 首次建立：2026-07-22  
> 来源审查：[`current-state-review-2026-07-22.md`](./current-state-review-2026-07-22.md)

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `OPEN` | 已验证存在，尚未开始处理 |
| `IN_PROGRESS` | 已有明确处理分支或提交，但验收条件未全部满足 |
| `BLOCKED` | 需要用户、产品、架构或外部系统决策 |
| `RESOLVED` | 验收条件全部满足并已记录验证证据 |
| `ACCEPTED_RISK` | 明确接受且记录理由、边界和复查时间 |
| `SUPERSEDED` | 被另一个问题或架构决策取代 |

## 严重性定义

| 严重性 | 含义 |
| --- | --- |
| `Critical` | 可导致敏感数据泄漏、不可恢复数据破坏或生产全面不可用 |
| `High` | 可绕过关键领域/权限边界，或造成严重持久状态错误 |
| `Medium` | 在特定输入或部署条件下造成错误、审计缺失或恢复困难 |
| `Low` | 可维护性、性能、文档或潜在扩展风险 |

## 开放问题

| ID | 严重性 | 状态 | 问题 | 主要证据 | 验收条件 |
| --- | --- | --- | --- | --- | --- |
| AUD-001 | High | OPEN | `PUT /api/state` 接受完整 `WorkspaceState`，只检查 `workspace.save`，可绕过 Series、Patch、RuleSet、Pricing 等领域命令校验。 | `app/api/state/route.ts:21`；`app/Workbench.tsx` 的整包保存 | 服务端拒绝未通过对应领域命令产生的受治理状态变化；增加已认证越权 PUT 路由测试。 |
| AUD-002 | Medium | OPEN | `POST /api/series` 的 JSON 只经过 TypeScript 断言，未验证 `functionIntensity`、Quality、Method、Function、Collection、Performance 等运行时引用。 | `app/api/series/route.ts:24-39,76-120` | 非法枚举和不存在引用返回 4xx；合法请求测试通过；新增 route-level 测试。 |
| AUD-003 | Medium | OPEN | Series/SKU 创建没有命令级 `idempotencyKey` 和结果恢复；响应丢失后无法可靠取得第一次结果。 | `app/SeriesGanttWorkbenchV3.tsx:946-1008`；`app/api/series/route.ts:161-163` | 相同幂等键与相同输入返回原创建结果；相同键不同输入冲突；并发不会创建重复业务身份。 |
| AUD-004 | Medium | OPEN | 离散拉力解析静默丢弃非法 token，例如 `1.5, abc, -3, 8.2` 被接受为两个合法值。 | `app/api/series/route.ts:41-50`；客户端同名解析函数 | 返回非法 token 和重复项；存在非法输入时阻止创建；边界与格式测试覆盖。 |
| AUD-005 | Medium | BLOCKED | 根 Vinext 应用与 `apps/web`/`packages/*` workspace 两套架构并存，正式权威实现和迁移关系未确定。 | 根 `app/`、`lib/`；`apps/web`；`packages/*` | 架构决策记录明确 source of truth、迁移/共存边界、部署目标和停止重复实现规则。 |
| AUD-006 | Medium | OPEN | 新 pnpm workspace 尚未安装依赖并完成验证。 | `corepack pnpm -r typecheck` 报缺少 `drizzle-orm`、`exceljs`、`decimal.js`、`vitest` | 使用锁文件安装后，workspace 的 typecheck、test、build 全部通过；记录命令和结果。 |
| AUD-007 | Medium | OPEN | 导入文件审计使用 `user.email`，Feishu 身份 email 通常为空，`uploaded_by` 丢失。 | `app/api/import-file/route.ts`；`lib/auth.ts` | 保存稳定 `tenantKey/openId` 或至少 `user.name || user.email`；测试验证非空审计身份。 |
| AUD-008 | Medium | OPEN | R730 systemd 只允许写 `/opt/tackle-forger/data`，而 `.env.example` 默认使用相对 `.data/*`；直接复制默认配置会写入只读发布目录。 | `deploy/tackle-forger.service`；`.env.example`；`docs/deployment/r730-production.md` | 提供生产环境模板或启动前 fail-fast 校验；按文档部署时所有可变文件均位于持久数据根。 |
| AUD-009 | Medium | BLOCKED | SQLite `workspace_revisions` 表永久保存完整 JSON，和 Blob/列表 100 条策略不一致，容量与归档政策未决定。 | `lib/sqlite-storage.ts:108-147` | 明确永久审计或有限保留策略；若有限保留则事务内清理；若永久保留则文档化容量、归档和备份规划。 |
| AUD-010 | Low | OPEN | 甘特图 UI 仍直接对完整客户端状态执行查询，未消费 `/api/series-gantt` 的对象可见性、游标和 stale-revision 机制。 | `app/SeriesGanttWorkbenchV3.tsx:783-800`；`app/api/series-gantt/route.ts` | 主列表通过服务端 API 加载；409 游标恢复、权限过滤和按需子对象加载有测试。 |
| AUD-011 | High | OPEN | 通用可信代理模式依赖部署层剥离并重写身份头；示例 Nginx 未显式清除客户端 `x-feishu-*` 和 `x-tf-proxy-secret`。 | `lib/auth.ts:49-72`；`deploy/nginx-tackle-forger.conf.example` | Nginx 明确清空外部身份头，仅由受信上游设置；部署测试或文档明确网关拓扑；默认继续关闭该模式。 |
| AUD-012 | Medium | OPEN | 导入/Series/state 等关键 API 缺少 route-level 正常、权限、冲突和恶意 JSON 测试。 | `tests/auth.test.ts` 主要覆盖未登录；无 `/api/series` 专用测试 | 至少覆盖 `/api/state` 越权状态变更、`/api/series` 枚举/引用/并发、`/api/import-file` 审计身份。 |
| AUD-013 | Medium | OPEN | 当前 Node 引擎下限 `>=22.13.0` 可能低于备份脚本使用的稳定 `node:sqlite backup` API 要求。 | `package.json:4-6`；`scripts/backup-workspace.ts` | 核实实际 Node API 最低版本并提升 engines/部署文档，或改用兼容实现；在最低支持版本运行备份测试。 |
| AUD-014 | Medium | OPEN | 备份脚本当前备份 SQLite 和导入文件，但没有包括 Feishu 会话存储。 | `scripts/backup-workspace.ts`；`lib/auth-store.ts` | 明确会话是否需要灾备；若需要，备份并验证权限/恢复；若不需要，文档化用户需重新登录的恢复行为。 |
| AUD-015 | Low | OPEN | 客户端生产构建有超过 500 kB 的 chunk。 | `npm test`/`vinext build` 输出 | 记录 bundle 分析；按工作台模块动态拆分或将权威计算迁到服务端；警告消失或有明确预算。 |
| AUD-016 | Low | OPEN | `BLOCKER` 甘特筛选值与现有 legacy `ValidationIssue.level` 不一致，筛选可能永远无结果。 | `lib/series-gantt-query.ts`；`lib/types.ts` | 明确 severity 映射；BLOCKER 可由正式 Issue 契约产生或从筛选中移除；增加筛选测试。 |
| AUD-017 | Low | OPEN | `applyLayeredPatches` 的 set 冲突键未包含 `scopeId`，多实体批量调用时可能误报冲突。 | `lib/patch-engine.ts` | 冲突键包含实体作用域，或 API 明确禁止混合实体并断言；增加多 scopeId 测试。 |
| AUD-018 | Low | OPEN | 文档存在尾随空格，仓库行尾策略仍可能产生 CRLF/LF 噪声。 | `git diff --check origin/main...HEAD` 的文档提示 | 清理尾随空格；添加/确认 `.gitattributes`；`git diff --check` 无错误。 |
| AUD-019 | Low | OPEN | 根应用和 workspace 使用 npm、pnpm 两套安装/锁文件，常用验证入口尚未统一。 | `package-lock.json`、`pnpm-lock.yaml`、根 `package.json`、workspace package | README/CLAUDE.md 明确每套命令；CI 分别验证；避免一次安装隐式改写另一锁文件。 |
| AUD-020 | Low | OPEN | `.claude/scheduled_tasks.lock` 被主线追踪，属于工具运行状态还是项目配置尚不明确。 | `.claude/scheduled_tasks.lock` | 确认是否应版本化；若为会话运行状态则移除并忽略，若为项目配置则说明用途。 |
| AUD-021 | Medium | OPEN | Feishu 回写已可回读恢复远端写入，但远端成功后本地审计保存冲突仍需人工重新拉取。 | `app/api/data-sources/route.ts:179-200` | 持久化写入意图/幂等记录，或提供自动对账命令；模拟远端成功、本地保存失败并可安全恢复。 |
| AUD-022 | Low | OPEN | Feishu 主工作簿 wiki token/share URL 仍作为代码常量，工作簿迁移需要代码变更。 | `lib/feishu-workbook.ts` | 决定是否属于有意的 canonical config-as-code；若否，迁到受验证配置并保留稳定 sheet 注册表。 |

## 已解决问题

| ID | 状态 | 问题 | 解决证据 | 验证 |
| --- | --- | --- | --- | --- |
| AUD-R001 | RESOLVED | Attribute Affix 曾先于 Series/SKU/Model Patch 执行。 | `lib/rule-kernel.ts` 已按 Patch → Affix → FinalReview 顺序执行。 | `tests/v3-rule-kernel.test.ts`；`npm test` 通过。 |
| AUD-R002 | RESOLVED | 商品层兼容字段曾影响结构投影筛选。 | `structuralCompatibilityContext` 和 `evaluateStructuralHardCompatibility`。 | 最近匹配测试通过。 |
| AUD-R003 | RESOLVED | Series 创建主要逻辑曾只在客户端执行。 | 新增 `POST /api/series`，客户端调用服务端命令。 | 构建包含路由；相关领域测试通过。注意整包 state 绕过由 `AUD-001` 单独管理。 |
| AUD-R004 | RESOLVED | Vercel 构建曾原地修改 `package.json`。 | `vercel.json` 改为无源码写入的 `next build`。 | 文件审查。 |
| AUD-R005 | RESOLVED | 未使用的 ChatGPT 请求头认证模块存在误用风险。 | `app/chatgpt-auth.ts` 已删除。 | Git diff。 |
| AUD-R006 | RESOLVED | Feishu 数据源回写缺少写前/写后回读恢复。 | `commitFeishuWriteback` 和 `tests/feishu-writeback.test.ts`。 | 写前幂等、成功核实、错误恢复和失败场景测试。 |
| AUD-R007 | RESOLVED | R730 缺少正式持久存储、备份和部署说明。 | SQLite、迁移/备份脚本、systemd/Nginx、部署文档。 | 根测试与 SQLite 测试通过。残余事项由 `AUD-008/009/013/014` 管理。 |

## 更新记录

| 日期 | 变更 | 提交 |
| --- | --- | --- |
| 2026-07-22 | 建立审查台账，登记 22 个开放问题和 7 个已解决问题。 | 待提交 |
