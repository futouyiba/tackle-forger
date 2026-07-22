# 工程问题台账

> 本台账记录工程风险、验证空洞和架构决策，不覆盖产品与领域规范。
> 首次建立：2026-07-22
> 来源审查：[`current-state-review-2026-07-22.md`](./current-state-review-2026-07-22.md)
> 最近复核：[`remote-branches-review-2026-07-22.md`](./remote-branches-review-2026-07-22.md)

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
| AUD-005 | Medium | BLOCKED | 根 Vinext 应用与`apps/web`/`packages/*` workspace两套架构并存，旧`SeriesRecipe`页面与按`itemPartId`区分竿/轮/线的v3 Series流程也同时可见，正式权威实现和迁移关系未确定。v14虽已增加竿/轮/线约束迁移，但当前运行时与页面尚未消费该字段。 | 根`app/`、`lib/`；`apps/web`；`packages/*`；`be1cf696`；`partConstraints`当前只出现于类型、迁移和测试 | 架构决策记录明确source of truth、迁移/共存边界和部署目标；正式配方运行时及页面消费分部位约束；旧入口被迁移、只读归档或移除，用户不再把旧扁平配方误认为v3正式Series。 |
| AUD-006 | Medium | OPEN | 新 pnpm workspace 尚未安装依赖并完成验证。 | `corepack pnpm -r typecheck` 报缺少 `drizzle-orm`、`exceljs`、`decimal.js`、`vitest` | 使用锁文件安装后，workspace 的 typecheck、test、build 全部通过；记录命令和结果。 |
| AUD-008 | Medium | OPEN | R730 systemd 只允许写 `/opt/tackle-forger/data`，而 `.env.example` 默认使用相对 `.data/*`；直接复制默认配置会写入只读发布目录。 | `deploy/tackle-forger.service`；`.env.example`；`docs/deployment/r730-production.md` | 提供生产环境模板或启动前 fail-fast 校验；按文档部署时所有可变文件均位于持久数据根。 |
| AUD-009 | Medium | BLOCKED | SQLite `workspace_revisions` 表永久保存完整 JSON，和 Blob/列表 100 条策略不一致，容量与归档政策未决定。 | `lib/sqlite-storage.ts:108-147` | 明确永久审计或有限保留策略；若有限保留则事务内清理；若永久保留则文档化容量、归档和备份规划。 |
| AUD-010 | Low | OPEN | 甘特图 UI 仍直接对完整客户端状态执行查询，未消费 `/api/series-gantt` 的对象可见性、游标和 stale-revision 机制。 | `app/SeriesGanttWorkbenchV3.tsx:783-800`；`app/api/series-gantt/route.ts` | 主列表通过服务端 API 加载；409 游标恢复、权限过滤和按需子对象加载有测试。 |
| AUD-011 | High | OPEN | 通用可信代理模式依赖部署层剥离并重写身份头；示例 Nginx 未显式清除客户端 `x-feishu-*` 和 `x-tf-proxy-secret`。 | `lib/auth.ts:49-72`；`deploy/nginx-tackle-forger.conf.example` | Nginx 明确清空外部身份头，仅由受信上游设置；部署测试或文档明确网关拓扑；默认继续关闭该模式。 |
| AUD-013 | Medium | OPEN | 当前 Node 引擎下限 `>=22.13.0` 可能低于备份脚本使用的稳定 `node:sqlite backup` API 要求。 | `package.json:4-6`；`scripts/backup-workspace.ts` | 核实实际 Node API 最低版本并提升 engines/部署文档，或改用兼容实现；在最低支持版本运行备份测试。 |
| AUD-014 | Medium | OPEN | 备份脚本当前备份 SQLite 和导入文件，但没有包括 Feishu 会话存储。 | `scripts/backup-workspace.ts`；`lib/auth-store.ts` | 明确会话是否需要灾备；若需要，备份并验证权限/恢复；若不需要，文档化用户需重新登录的恢复行为。 |
| AUD-015 | Low | OPEN | 客户端生产构建有超过 500 kB 的 chunk。 | `npm test`/`vinext build` 输出 | 记录 bundle 分析；按工作台模块动态拆分或将权威计算迁到服务端；警告消失或有明确预算。 |
| AUD-016 | Low | OPEN | `BLOCKER` 甘特筛选值与现有 legacy `ValidationIssue.level` 不一致，筛选可能永远无结果。 | `lib/series-gantt-query.ts`；`lib/types.ts` | 明确 severity 映射；BLOCKER 可由正式 Issue 契约产生或从筛选中移除；增加筛选测试。 |
| AUD-017 | Low | OPEN | `applyLayeredPatches` 的 set 冲突键未包含 `scopeId`，多实体批量调用时可能误报冲突。 | `lib/patch-engine.ts` | 冲突键包含实体作用域，或 API 明确禁止混合实体并断言；增加多 scopeId 测试。 |
| AUD-018 | Low | IN_PROGRESS | 审计Markdown尾随空格已由`ba2111c2`清理，`git diff --check origin/main...HEAD`及本次复核时的工作树检查均通过；但仓库尚无`.gitattributes`，跨Windows/macOS的CRLF/LF策略仍未固化。 | `ba2111c2`；仓库根缺少`.gitattributes`；复核补充文档 | 添加或明确确认`.gitattributes`行尾策略；在Windows与macOS各验证一次；`git diff --check`持续无错误。 |
| AUD-019 | Low | OPEN | 根应用和 workspace 使用 npm、pnpm 两套安装/锁文件，常用验证入口尚未统一。 | `package-lock.json`、`pnpm-lock.yaml`、根 `package.json`、workspace package | README/CLAUDE.md 明确每套命令；CI 分别验证；避免一次安装隐式改写另一锁文件。 |
| AUD-020 | Low | OPEN | `.claude/scheduled_tasks.lock` 被主线追踪，属于工具运行状态还是项目配置尚不明确。 | `.claude/scheduled_tasks.lock` | 确认是否应版本化；若为会话运行状态则移除并忽略，若为项目配置则说明用途。 |
| AUD-021 | Medium | OPEN | Feishu 回写已可回读恢复远端写入，但远端成功后本地审计保存冲突仍需人工重新拉取。 | `app/api/data-sources/route.ts:179-200` | 持久化写入意图/幂等记录，或提供自动对账命令；模拟远端成功、本地保存失败并可安全恢复。 |
| AUD-022 | Low | OPEN | Feishu 主工作簿 wiki token/share URL 仍作为代码常量，工作簿迁移需要代码变更。 | `lib/feishu-workbook.ts` | 决定是否属于有意的 canonical config-as-code；若否，迁到受验证配置并保留稳定 sheet 注册表。 |
| AUD-023 | High | OPEN | `FiveAxisViewDefinition`没有独立发布状态，`publishConfigurationSnapshot`对五维预览只校验`modelId`；未发布或过期的OPEN-005种子定义仍可能进入新正式Snapshot。 | `lib/types.ts:781-798`；`lib/publishing.ts:138-143,193-195`；v3 §20 OPEN-005、§24.6 | 五维定义具有不可变revision与发布状态；`new_formal`只接受已发布定义且预览的definition/version/rule/vertex hash完整一致；未发布或过期定义产生PUBLISH门禁Issue；历史Snapshot不变；覆盖正常、未发布、过期和历史兼容测试。 |
| AUD-024 | Medium | OPEN | 后端核心契约仍以`targetWeightKg`承载SKU目标拉力，`ProjectionMatch`和查询接口同时保留新旧字段；历史兼容字段尚未收敛到迁移读取边界。 | `lib/types.ts:596-613,737-751`；`lib/projection-matcher.ts:21-35,237-248`；`lib/interaction-contracts.ts:494-540`；v3 §5.3 | 新写入、领域对象和API统一使用`targetPullKg/derivedPullKg/matchedStructuralPullKg/modelFinalPullKg`；`targetWeightKg`仅由迁移适配器读取；顺序迁移保留历史Payload与Snapshot hash；覆盖旧数据迁移、API契约和确定性匹配测试。 |

## 问题关系与去重

- `AUD-001/002/003/004/007`分别拥有自己的route-level测试验收；原总括测试问题`AUD-012`已标记为`SUPERSEDED`，不再独立计入开放问题。
- `AUD-005`是两套架构权威边界的父决策；“系列配方未拆分竿轮线”是旧`SeriesRecipe`仍可见造成的用户侧表现，归入`AUD-005`，不再新增重复AUD。`be1cf696`只解决v14迁移载体并记为`AUD-R010`，没有解决页面消费和架构权威边界。`AUD-006`与`AUD-019`分别记录验证前置条件和包管理/CI入口，在`AUD-005`关闭前保持独立，但关闭时必须共同复核是否应`RESOLVED`或`SUPERSEDED`。
- `AUD-R003`只证明Series创建主路径已进入服务端命令；通用整包保存绕过继续由`AUD-001`管理。
- `AUD-R006`只证明飞书远端写前/写后回读恢复已经实现；远端成功后的本地审计冲突继续由`AUD-021`管理，默认测试入口遗漏由`AUD-025`管理。
- `AUD-R007`证明R730持久化、迁移、备份和运行手册的基础能力已存在；部署路径、revision保留、Node下限和会话灾备分别由`AUD-008/009/013/014`管理。

## 已取代问题

| ID | 状态 | 原问题 | 取代关系 |
| --- | --- | --- | --- |
| AUD-012 | SUPERSEDED | 导入、Series、state等关键API缺少route-level正常、权限、冲突和恶意JSON测试。 | 测试验收已经分别归入`AUD-001/002/003/004/007`；关闭各具体问题时必须同时提交对应路由测试，不再维护重复总括项。 |

## 已解决问题

| ID | 状态 | 问题 | 解决证据 | 验证 |
| --- | --- | --- | --- | --- |
| AUD-001 | RESOLVED | 整包状态保存可绕过领域命令。 | `findGovernedStateChanges`只允许`notes`经整包PUT变化，其余现有及未来Workspace字段默认拒绝；`PUT /api/state`返回`DOMAIN_COMMAND_REQUIRED`，畸形JSON返回400。 | `tests/api-command-boundaries.test.ts`覆盖新旧领域集合与规则设置；`tests/api-routes.test.ts`覆盖已认证越权PUT和畸形JSON；默认`npm test`通过202项TS测试与1项渲染测试。 |
| AUD-002 | RESOLVED | Series API缺少完整运行时枚举与引用校验。 | `POST /api/series`显式校验强度、部位、钓法、类型、功能、品质、Collection与Performance存在/启用状态，并保留Type兼容校验。 | `tests/api-routes.test.ts`逐引用4xx覆盖；类型检查及默认`npm test`通过。 |
| AUD-003 | RESOLVED | Series/SKU创建缺少命令幂等与结果恢复。 | 客户端发送稳定命令键；服务端将输入hash与Series结果引用同Workspace revision原子保存，相同输入恢复原Series/SKU，不同输入409，并发仅一次提交成功。 | `tests/api-routes.test.ts`覆盖重放、键冲突、并发冲突及冲突后恢复；默认`npm test`通过。 |
| AUD-004 | RESOLVED | 离散拉力解析静默丢弃非法token与重复项。 | `parseDiscretePulls`保留合法值并单独报告`invalidTokens/duplicateValues`；任一异常均阻止创建。 | `tests/api-command-boundaries.test.ts`与`tests/api-routes.test.ts`覆盖中英文分隔、负数、文本和重复值。 |
| AUD-007 | RESOLVED | 飞书导入审计身份可能为空。 | `stableAuditActor`优先保存`feishu:{tenantKey}:{openId}`，再回退显示名/email，导入与Series命令共用。 | `tests/api-command-boundaries.test.ts`覆盖飞书稳定身份及非空回退。 |
| AUD-025 | RESOLVED | 默认测试入口遗漏飞书回写回归。 | `package.json`改用`tests/*.test.ts`与`tests/*.test.mjs`自动发现正式测试，新文件无需维护长名单。 | 默认`npm test`通过202项TS测试与1项渲染测试，其中飞书回写5项（字段匹配1项、提交恢复4项）均执行。 |
| AUD-R001 | RESOLVED | Attribute Affix 曾先于 Series/SKU/Model Patch 执行。 | `lib/rule-kernel.ts` 已按 Patch → Affix → FinalReview 顺序执行。 | `tests/v3-rule-kernel.test.ts`；`npm test` 通过。 |
| AUD-R002 | RESOLVED | 商品层兼容字段曾影响结构投影筛选。 | `structuralCompatibilityContext` 和 `evaluateStructuralHardCompatibility`。 | 最近匹配测试通过。 |
| AUD-R003 | RESOLVED | Series 创建主要逻辑曾只在客户端执行。 | 新增 `POST /api/series`，客户端调用服务端命令。 | 构建包含路由；相关领域测试通过。注意整包 state 绕过由 `AUD-001` 单独管理。 |
| AUD-R004 | RESOLVED | Vercel 构建曾原地修改 `package.json`。 | `vercel.json` 改为无源码写入的 `next build`。 | 文件审查。 |
| AUD-R005 | RESOLVED | 未使用的 ChatGPT 请求头认证模块存在误用风险。 | `app/chatgpt-auth.ts` 已删除。 | Git diff。 |
| AUD-R006 | RESOLVED | Feishu 数据源回写缺少写前/写后回读恢复。 | `commitFeishuWriteback` 和 `tests/feishu-writeback.test.ts`。 | 5个场景单独执行通过；默认`npm test`尚未收录该文件，由`AUD-025`跟踪，不重开本实现问题。 |
| AUD-R007 | RESOLVED | R730 缺少正式持久存储、备份和部署说明。 | SQLite、迁移/备份脚本、systemd/Nginx、部署文档。 | 根测试与 SQLite 测试通过。残余事项由 `AUD-008/009/013/014` 管理。 |
| AUD-R008 | RESOLVED | 生产环境无持久存储时曾静默回退到进程内内存，重启后丢失团队配置。 | `lib/storage.ts`的`assertEphemeralStorageAllowed`；`f0fe8232`。 | `tests/storage.test.ts`；远端复审完整测试通过。systemd路径不一致仍由`AUD-008`管理。 |
| AUD-R009 | RESOLVED | SQLite保存的revision条件更新未命中时曾可能继续写入历史，形成伪revision。 | `lib/sqlite-storage.ts`检查`updated.changes`并回滚；`45e8281d`。 | 持久化、过期`baseRevision`、不新增历史及并发测试通过。revision保留政策仍由`AUD-009`管理。 |
| AUD-R010 | RESOLVED | 旧扁平`SeriesRecipe`缺少可承载竿、轮、线独立约束的迁移结构。 | v14`SeriesRecipe.partConstraints`及v13→v14顺序迁移；`be1cf696`。 | 迁移幂等测试通过并保留旧字段。运行时/UI尚未消费该结构，继续由`AUD-005`管理。 |

## 更新记录

| 日期 | 变更 | 提交 |
| --- | --- | --- |
| 2026-07-22 | 建立审查台账，登记 22 个开放问题和 7 个已解决问题。 | `c1a6070d` |
| 2026-07-22 | 复核去重：`AUD-012`转`SUPERSEDED`，`AUD-018`转`IN_PROGRESS`，补录`AUD-023～025`；当前有效未关闭问题24个。 | `034a353` |
| 2026-07-22 | 归并产品反馈：“系列配方未拆分竿轮线”并入`AUD-005`验收，不增加AUD数量；品质、定价、配置导出和交互反馈转由实现差距矩阵及v3/UX权威项管理。 | `034a353` |
| 2026-07-22 | 将v3-work的SQLite条件更新、生产环境禁止内存回退、v14系列配方迁移cherry-pick到审查分支；补全PatchLedger的v14 schema断言；新增`AUD-R008/009`。`AUD-008/009`仍开放。 | `45e8281d` `f0fe8232` `be1cf696` `6c233e5d` |
| 2026-07-22 | 拉取全部远端分支并复审`origin/review/current-state-2026-07-22@fee6c83a`：新增`AUD-R008～R010`，有效未关闭问题仍为24个；完整测试190项、渲染测试1项、飞书回写单测5项及类型检查通过。 | `034a353` |
| 2026-07-22 | API/命令边界第一批修复：关闭`AUD-001～004`、`AUD-007`与`AUD-025`；默认门禁改为自动发现测试并通过202项TS测试与1项渲染测试。 | `codex/audit-api-boundaries`（本分支提交） |
