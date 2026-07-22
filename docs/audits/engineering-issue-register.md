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
| AUD-001 | High | OPEN | `PUT /api/state` 接受完整 `WorkspaceState`，只检查 `workspace.save`，可绕过 Series、Patch、RuleSet、Pricing 等领域命令校验。 | `app/api/state/route.ts:21`；`app/Workbench.tsx` 的整包保存 | 服务端拒绝未通过对应领域命令产生的受治理状态变化；增加已认证越权 PUT 路由测试。 |
| AUD-002 | Medium | OPEN | `POST /api/series` 已验证必填字段、规划区间、Series ID、Type与Method/ItemPart兼容及已发布RuleSet，但JSON仍主要依赖TypeScript断言，尚未完整验证 `functionIntensity`、Quality、Method、Function、Collection、Performance等运行时枚举与引用。 | `app/api/series/route.ts:24-39,76-120` | 非法枚举和不存在引用返回4xx；现有Type/Method/ItemPart校验保持通过；补充所有剩余引用及route-level测试。 |
| AUD-003 | Medium | OPEN | Series/SKU 创建没有命令级 `idempotencyKey` 和结果恢复；响应丢失后无法可靠取得第一次结果。 | `app/SeriesGanttWorkbenchV3.tsx:946-1008`；`app/api/series/route.ts:161-163` | 相同幂等键与相同输入返回原创建结果；相同键不同输入冲突；并发不会创建重复业务身份。 |
| AUD-004 | Medium | OPEN | 离散拉力解析静默丢弃非法 token，例如 `1.5, abc, -3, 8.2` 被接受为两个合法值。 | `app/api/series/route.ts:41-50`；客户端同名解析函数 | 返回非法 token 和重复项；存在非法输入时阻止创建；边界与格式测试覆盖。 |
| AUD-005 | Medium | BLOCKED | 根 Vinext 应用与`apps/web`/`packages/*` workspace两套架构并存，旧`SeriesRecipe`页面与按`itemPartId`区分竿/轮/线的v3 Series流程也同时可见，正式权威实现和迁移关系未确定。v14虽已增加竿/轮/线约束迁移，但当前运行时与页面尚未消费该字段。 | 根`app/`、`lib/`；`apps/web`；`packages/*`；`be1cf696`；`partConstraints`当前只出现于类型、迁移和测试 | 架构决策记录明确source of truth、迁移/共存边界和部署目标；正式配方运行时及页面消费分部位约束；旧入口被迁移、只读归档或移除，用户不再把旧扁平配方误认为v3正式Series。 |
| AUD-006 | Medium | OPEN | 新 pnpm workspace 尚未安装依赖并完成验证。 | `corepack pnpm -r typecheck` 报缺少 `drizzle-orm`、`exceljs`、`decimal.js`、`vitest` | 使用锁文件安装后，workspace 的 typecheck、test、build 全部通过；记录命令和结果。 |
| AUD-007 | Medium | OPEN | 导入文件审计使用 `user.email`，Feishu 身份 email 通常为空，`uploaded_by` 丢失。 | `app/api/import-file/route.ts`；`lib/auth.ts` | 保存稳定 `tenantKey/openId` 或至少 `user.name || user.email`；测试验证非空审计身份。 |
| AUD-009 | Medium | BLOCKED | SQLite `workspace_revisions` 表永久保存完整 JSON，和 Blob/列表 100 条策略不一致，容量与归档政策未决定。 | `lib/sqlite-storage.ts:108-147` | 明确永久审计或有限保留策略；若有限保留则事务内清理；若永久保留则文档化容量、归档和备份规划。 |
| AUD-010 | Low | OPEN | 甘特图 UI 仍直接对完整客户端状态执行查询，未消费 `/api/series-gantt` 的对象可见性、游标和 stale-revision 机制。 | `app/SeriesGanttWorkbenchV3.tsx:783-800`；`app/api/series-gantt/route.ts` | 主列表通过服务端 API 加载；409 游标恢复、权限过滤和按需子对象加载有测试。 |
| AUD-015 | Low | OPEN | 客户端生产构建有超过 500 kB 的 chunk。 | `npm test`/`vinext build` 输出 | 记录 bundle 分析；按工作台模块动态拆分或将权威计算迁到服务端；警告消失或有明确预算。 |
| AUD-018 | Low | IN_PROGRESS | 审计Markdown尾随空格已由`ba2111c2`清理，仓库现已增加`.gitattributes`，统一文本LF并为PowerShell/批处理保留CRLF；macOS工作树的`git diff --check`通过，仍缺Windows检出验证。 | `ba2111c2`；`.gitattributes`；本分支验证记录 | 在Windows验证检出后的PowerShell/批处理为CRLF、其余文本为LF；`git diff --check`持续无错误。 |
| AUD-019 | Low | OPEN | 根应用和 workspace 使用 npm、pnpm 两套安装/锁文件，常用验证入口尚未统一。 | `package-lock.json`、`pnpm-lock.yaml`、根 `package.json`、workspace package | README/CLAUDE.md 明确每套命令；CI 分别验证；避免一次安装隐式改写另一锁文件。 |
| AUD-021 | Medium | OPEN | Feishu 回写已可回读恢复远端写入，但远端成功后本地审计保存冲突仍需人工重新拉取。 | `app/api/data-sources/route.ts:179-200` | 持久化写入意图/幂等记录，或提供自动对账命令；模拟远端成功、本地保存失败并可安全恢复。 |
| AUD-022 | Low | OPEN | Feishu 主工作簿 wiki token/share URL 仍作为代码常量，工作簿迁移需要代码变更。 | `lib/feishu-workbook.ts` | 决定是否属于有意的 canonical config-as-code；若否，迁到受验证配置并保留稳定 sheet 注册表。 |
| AUD-024 | Medium | OPEN | 后端核心契约仍以`targetWeightKg`承载SKU目标拉力，`ProjectionMatch`和查询接口同时保留新旧字段；历史兼容字段尚未收敛到迁移读取边界。 | `lib/types.ts:596-613,737-751`；`lib/projection-matcher.ts:21-35,237-248`；`lib/interaction-contracts.ts:494-540`；v3 §5.3 | 新写入、领域对象和API统一使用`targetPullKg/derivedPullKg/matchedStructuralPullKg/modelFinalPullKg`；`targetWeightKg`仅由迁移适配器读取；顺序迁移保留历史Payload与Snapshot hash；覆盖旧数据迁移、API契约和确定性匹配测试。 |
| AUD-025 | Low | OPEN | 默认`npm test`脚本没有执行`tests/feishu-writeback.test.ts`；该文件单独执行通过，但后续回写恢复回归不会被默认门禁捕获。 | `package.json:15`；`tests/feishu-writeback.test.ts`；本次复核的单独测试证据 | 默认本地与CI测试入口自动覆盖全部正式测试文件，包含飞书回写5个场景；新增测试文件无需手工维护长名单或有自动完整性检查；记录完整通过数量。 |

## 问题关系与去重

- `AUD-001/002/003/004/007`分别拥有自己的route-level测试验收；原总括测试问题`AUD-012`已标记为`SUPERSEDED`，不再独立计入开放问题。
- `AUD-005`是两套架构权威边界的父决策；“系列配方未拆分竿轮线”是旧`SeriesRecipe`仍可见造成的用户侧表现，归入`AUD-005`，不再新增重复AUD。`be1cf696`只解决v14迁移载体并记为`AUD-R010`，没有解决页面消费和架构权威边界。`AUD-006`与`AUD-019`分别记录验证前置条件和包管理/CI入口，在`AUD-005`关闭前保持独立，但关闭时必须共同复核是否应`RESOLVED`或`SUPERSEDED`。
- `AUD-R003`只证明Series创建主路径已进入服务端命令；通用整包保存绕过继续由`AUD-001`管理。
- `AUD-R006`只证明飞书远端写前/写后回读恢复已经实现；远端成功后的本地审计冲突继续由`AUD-021`管理，默认测试入口遗漏由`AUD-025`管理。
- `AUD-R007`证明R730持久化、迁移、备份和运行手册的基础能力已存在；本轮进一步关闭部署路径、Node下限和会话灾备的`AUD-008/013/014`，revision保留政策仍由`AUD-009`管理。

## 已取代问题

| ID | 状态 | 原问题 | 取代关系 |
| --- | --- | --- | --- |
| AUD-012 | SUPERSEDED | 导入、Series、state等关键API缺少route-level正常、权限、冲突和恶意JSON测试。 | 测试验收已经分别归入`AUD-001/002/003/004/007`；关闭各具体问题时必须同时提交对应路由测试，不再维护重复总括项。 |

## 已解决问题

| ID | 状态 | 问题 | 解决证据 | 验证 |
| --- | --- | --- | --- | --- |
| AUD-008 | RESOLVED | R730默认环境变量曾把可变数据指向只读发布目录。 | `deploy/tackle-forger.env.example`提供与systemd `ReadWritePaths`一致的`/opt/tackle-forger/data/*`绝对路径；运行手册明确禁止生产复制通用相对路径。 | 模板与`deploy/tackle-forger.service`静态核对；`git diff --check`通过。 |
| AUD-011 | RESOLVED | 示例Nginx曾可能转发客户端伪造的可信代理身份头。 | `deploy/nginx-tackle-forger.conf.example`显式清除`X-Feishu-Tenant-Key`、`X-Feishu-Open-Id`、`X-Feishu-Display-Name`和`X-TF-Proxy-Secret`；手册明确直接OAuth拓扑且默认关闭可信代理模式。 | Nginx配置与`lib/auth.ts`读取的全部可信身份头逐项核对。 |
| AUD-013 | RESOLVED | Node引擎下限低于备份脚本所用`node:sqlite backup()`的引入版本。 | `package.json`、`package-lock.json`和开发/部署说明统一提升到Node.js `>=22.16.0`；Node官方v22文档记录`backup()`自22.16.0加入。 | Node.js 22.23.1实际执行备份脚本成功；最低版本要求静态一致性核对。 |
| AUD-014 | RESOLVED | 工作区备份没有包含飞书会话文件。 | `scripts/backup-workspace.ts`把`FEISHU_SESSION_DATA_DIR`复制到备份的`auth`目录，并在manifest记录来源与是否包含；运行手册明确停服恢复及无备份时重新登录。 | 临时SQLite、导入文件与会话目录执行备份，生成`workspace.sqlite`、`files`、`auth`和manifest，备份根权限为`0700`。 |
| AUD-020 | RESOLVED | `.claude/scheduled_tasks.lock`运行态锁文件曾被版本化。 | 文件内容只有`sessionId/pid/acquiredAt`，属于单次工具进程锁；已从Git移除，现有`/.claude/`忽略规则防止再次提交。 | `git check-ignore -v .claude/scheduled_tasks.lock`命中`.gitignore`；工作树显示追踪文件删除。 |
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
| AUD-016 | RESOLVED | `BLOCKER` 甘特筛选值与legacy `ValidationIssue.level`不一致。 | `ValidationIssue.severity`承载规范严重度；缺失时确定性兼容映射legacy level。 | `tests/series-gantt-query.test.ts`覆盖BLOCKER命中与ERROR隔离；类型检查及领域测试通过。 |
| AUD-017 | RESOLVED | `applyLayeredPatches`跨实体批量调用可能误报set冲突。 | 冲突键加入`scopeId`，只在同作用域实体同路径间报告竞争。 | `tests/v3-end-to-end.test.ts`覆盖不同/相同scopeId；领域测试通过。 |
| AUD-023 | RESOLVED | 未发布或过期的`FiveAxisViewDefinition`可能进入新正式Snapshot。 | v15为定义增加revision、发布状态和内容哈希；旧定义无损迁移为未发布；`new_formal`核验定义发布状态、定义哈希及preview definition/rule/vertex/source版本链。 | `tests/five-axis.test.ts`覆盖正常、未发布、篡改、过期和历史Snapshot冻结；`tests/v3-migration.test.ts`覆盖迁移幂等；类型检查及领域测试通过。 |

## 更新记录

| 日期 | 变更 | 提交 |
| --- | --- | --- |
| 2026-07-22 | 建立审查台账，登记 22 个开放问题和 7 个已解决问题。 | `c1a6070d` |
| 2026-07-22 | 复核去重：`AUD-012`转`SUPERSEDED`，`AUD-018`转`IN_PROGRESS`，补录`AUD-023～025`；当前有效未关闭问题24个。 | `034a353` |
| 2026-07-22 | 归并产品反馈：“系列配方未拆分竿轮线”并入`AUD-005`验收，不增加AUD数量；品质、定价、配置导出和交互反馈转由实现差距矩阵及v3/UX权威项管理。 | `034a353` |
| 2026-07-22 | 将v3-work的SQLite条件更新、生产环境禁止内存回退、v14系列配方迁移cherry-pick到审查分支；补全PatchLedger的v14 schema断言；新增`AUD-R008/009`。`AUD-008/009`仍开放。 | `45e8281d` `f0fe8232` `be1cf696` `6c233e5d` |
| 2026-07-22 | 拉取全部远端分支并复审`origin/review/current-state-2026-07-22@fee6c83a`：新增`AUD-R008～R010`，有效未关闭问题仍为24个；完整测试190项、渲染测试1项、飞书回写单测5项及类型检查通过。 | `034a353` |
| 2026-07-22 | 部署与工程治理复核：关闭`AUD-008/011/013/014/020`；`AUD-018`已固化行尾策略但等待Windows检出验证；`AUD-019`因历史pnpm工作区尚未完成独立CI验证继续开放。 | `9a86ee6` |
| 2026-07-22 | 第一批领域契约修复关闭`AUD-016/017/023`；工作区升级到v15并保留旧五维定义和历史Snapshot。`AUD-024`保持开放，等待完整的`targetPullKg`顺序迁移而不做半迁移。 | `b340d45` |
