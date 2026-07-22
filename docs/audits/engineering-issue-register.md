# 工程问题台账

> 本台账记录工程风险、验证空洞和架构决策，不覆盖产品与领域规范。
> 首次建立：2026-07-22
> 来源审查：[`current-state-review-2026-07-22.md`](./current-state-review-2026-07-22.md)
> 最近复核：[`remote-branches-review-2026-07-22.md`](./remote-branches-review-2026-07-22.md)
> 当前汇总：3个有效未关闭问题（1个`OPEN`、0个`IN_PROGRESS`、2个`BLOCKED`），32个`RESOLVED`，1个`SUPERSEDED`。

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
| AUD-005 | Medium | OPEN | 根Vinext v3已由README、CI和R730部署配置确认为唯一权威实现，但根应用仍把旧`SeriesRecipe`、旧Candidate、`OfficialSku`和明细覆盖作为可编辑入口，并允许通用整包保存继续写`recipes`，用户仍可能误把历史流程当作v3正式流程。 | `README.md`；`.github/workflows/ci.yml`；`deploy/tackle-forger.service`；`app/Workbench.tsx`；`lib/api-command-boundaries.ts`；[`AUD-005 收敛方案`](./aud-005-architecture-decision-proposal.md) | 旧入口改为明确的只读历史查看与迁移诊断；既有深链和原始payload/Trace保留；旧集合不再通过页面或整包保存新增/修改；v3 Series/SKU/Model成为唯一正式写入流程；部署与评审入口均指向根v3构建。 |
| AUD-009 | Medium | BLOCKED | SQLite与D1永久保存完整工作区revision，普通列表只显示最近100条；Blob则物理裁为最近100条。三种后端的历史读取、容量与归档语义不一致，正式保留政策尚未决定。 | `lib/sqlite-storage.ts`建表/插入/列表；`lib/storage.ts`的D1插入与Blob `.slice(0, 100)`；[`AUD-009 数据保留 ADR 草案`](./aud-009-workspace-revision-retention-adr.md)；只读诊断与备份manifest证据见`lib/sqlite-revision-diagnostics.ts`、`tests/sqlite-revision-diagnostics.test.ts` | 非破坏性容量/时间诊断已经落地；仍须由产品/运维/审计责任人确认永久、固定条数或时间+数量混合策略，以及Blob例外和长期归档责任。未确认前不得实现自动清理，问题保持`BLOCKED`。 |
| AUD-026 | Medium | BLOCKED | `SeriesRecipe.partConstraints`已承载rod/reel/line分部位字段，但迁移复制的是旧扁平语义，旧生成器和UI均未消费；哪些字段属于`CandidateSearchRecipe`搜索约束、哪些必须落入Model `componentSelections`尚未确认。 | `lib/types.ts`；`lib/migrations.ts`；`lib/engine.ts`；`app/Workbench.tsx`；[`AUD-005 收敛方案`](./aud-005-architecture-decision-proposal.md) | 明确版本化分部位约束的语义归属和旧字段映射；未确认项保持可配置/待复核；runtime与UI按rod/reel/line分别消费并输出Trace；实际入选部件进入Model构建输入；迁移幂等且不改写已发布Snapshot。 |

## 问题关系与去重

- `AUD-001/002/003/004/007`已分别通过route-level测试关闭；原总括测试问题`AUD-012`保持`SUPERSEDED`，不重复计入已解决数量。
- 根v3的source of truth与生产部署目标已由README、CI和R730配置确定，不再作为阻断项。`AUD-005`只管理旧可写入口的只读归档、兼容跳转和部署收敛；分部位约束的未决领域映射拆为`AUD-026`，避免把可直接执行的工程工作和必须确认的语义混在同一个`BLOCKED`项中。
- “系列配方未拆分竿轮线”不是再新增一份重复反馈：其中“旧扁平页面仍可编辑”归`AUD-005`，“竿/轮/线约束如何进入候选与Model”归`AUD-026`。`be1cf696`只解决v14迁移载体并记为`AUD-R010`，没有解决runtime/UI消费。
- `AUD-R003`证明Series创建主路径已进入服务端命令；通用整包保存绕过已由`AUD-001`的默认拒绝边界关闭。
- `AUD-R006`证明飞书远端写前/写后回读恢复已经实现；默认测试入口遗漏已由`AUD-025`关闭；`AUD-021`进一步增加持久化写入意图、revision冲突自动对账和整次请求幂等恢复。
- `AUD-R007`证明R730持久化、迁移、备份和运行手册的基础能力已存在；部署路径、Node下限和会话灾备已由`AUD-008/013/014`关闭，revision保留政策仍由`AUD-009`管理。

## 已取代问题

| ID | 状态 | 原问题 | 取代关系 |
| --- | --- | --- | --- |
| AUD-012 | SUPERSEDED | 导入、Series、state等关键API缺少route-level正常、权限、冲突和恶意JSON测试。 | 测试验收已经分别归入`AUD-001/002/003/004/007`；关闭各具体问题时必须同时提交对应路由测试，不再维护重复总括项。 |

## 已解决问题

| ID | 状态 | 问题 | 解决证据 | 验证 |
| --- | --- | --- | --- | --- |
| AUD-018 | RESOLVED | 仓库文本行尾策略曾缺少Windows真实检出验证。 | `.gitattributes`统一普通文本为LF并为PowerShell/批处理保留CRLF；`d30c763`增加独立`windows-latest`门禁。 | GitHub Actions [`CI #1`](https://github.com/futouyiba/tackle-forger/actions/runs/29935463528) 的`Windows line-ending policy`在`fd59fd3`上通过：PowerShell纯CRLF、`package.json`为LF、`git diff --check`通过。 |
| AUD-019 | RESOLVED | 根v3应用与历史workspace使用npm/pnpm两套安装、锁文件和验证入口，曾缺少独立远端门禁。 | `d30c763`同步`pnpm-lock.yaml`、隔离共享Vitest配置，并在README/CLAUDE与CI中明确根npm和历史pnpm两套入口。 | GitHub Actions [`CI #1`](https://github.com/futouyiba/tackle-forger/actions/runs/29935463528) 的`Root v3 app (npm)`与`Historical workspace (pnpm)`在干净检出上全部通过，包括冻结安装、类型、lint、测试和构建。 |
| AUD-024 | RESOLVED | SKU目标拉力、结构派生/命中拉力和Model最终拉力曾混用`targetWeightKg`及重复别名，历史兼容字段未收敛到迁移边界。 | `3ec88dc`将活动领域、候选、兼容、甘特查询/API和UI统一为`targetPullKg/derivedPullKg/matchedStructuralPullKg/modelFinalPullKg`；schema v17仅在v16→v17顺序迁移适配器读取旧字段，归档历史payload，拒绝新旧冲突与非正边界；既有v15→v16飞书回写意图迁移保持独立；冻结ConfigurationSnapshot保持原payload/contentHash，新Snapshot才冻结`modelFinalPullKg`。 | `npm run typecheck`、`npm run lint`、完整`npm test`通过225项TypeScript测试与2项生产构建测试；迁移测试覆盖幂等、payload归档、冲突、边界与Snapshot hash冻结；甘特GET路由和查询契约验证不输出旧字段；确定性最近匹配回归通过；`git diff --check`通过。 |
| AUD-008 | RESOLVED | R730默认环境变量曾把可变数据指向只读发布目录。 | `deploy/tackle-forger.env.example`提供与systemd `ReadWritePaths`一致的`/opt/tackle-forger/data/*`绝对路径；运行手册明确禁止生产复制通用相对路径。 | 模板与`deploy/tackle-forger.service`静态核对；`git diff --check`通过。 |
| AUD-011 | RESOLVED | 示例Nginx曾可能转发客户端伪造的可信代理身份头。 | `deploy/nginx-tackle-forger.conf.example`显式清除`X-Feishu-Tenant-Key`、`X-Feishu-Open-Id`、`X-Feishu-Display-Name`和`X-TF-Proxy-Secret`；手册明确直接OAuth拓扑且默认关闭可信代理模式。 | Nginx配置与`lib/auth.ts`读取的全部可信身份头逐项核对。 |
| AUD-013 | RESOLVED | Node引擎下限低于备份脚本所用`node:sqlite backup()`的引入版本。 | `package.json`、`package-lock.json`和开发/部署说明统一提升到Node.js `>=22.16.0`；Node官方v22文档记录`backup()`自22.16.0加入。 | Node.js 22.23.1实际执行备份脚本成功；最低版本要求静态一致性核对。 |
| AUD-014 | RESOLVED | 工作区备份没有包含飞书会话文件。 | `scripts/backup-workspace.ts`把`FEISHU_SESSION_DATA_DIR`复制到备份的`auth`目录，并在manifest记录来源与是否包含；运行手册明确停服恢复及无备份时重新登录。 | 临时SQLite、导入文件与会话目录执行备份，生成`workspace.sqlite`、`files`、`auth`和manifest，备份根权限为`0700`。 |
| AUD-020 | RESOLVED | `.claude/scheduled_tasks.lock`运行态锁文件曾被版本化。 | 文件内容只有`sessionId/pid/acquiredAt`，属于单次工具进程锁；已从Git移除，现有`/.claude/`忽略规则防止再次提交。 | `git check-ignore -v .claude/scheduled_tasks.lock`命中`.gitignore`；工作树显示追踪文件删除。 |
| AUD-006 | RESOLVED | 历史pnpm workspace缺少可复现安装与完整验证。 | `pnpm-lock.yaml`已与全部6个workspace项目同步；共享Vitest配置隔离根Vinext/Cloudflare插件；冻结安装可复现。 | pnpm 10.33.2下`pnpm install --frozen-lockfile`、5个子项目typecheck/test/build全部通过；domain 3项测试通过，其余无测试包按显式`passWithNoTests`通过。 |
| AUD-001 | RESOLVED | 整包状态保存可绕过领域命令。 | `findGovernedStateChanges`仅允许旧工作台仍直接维护的显式通用配置字段经整包PUT变化；v3产品实体、不可变快照、规则设置、账本、命令记录、审计历史及未来未知字段继续默认拒绝。`PUT /api/state`返回`DOMAIN_COMMAND_REQUIRED`，畸形JSON返回400。 | `tests/api-command-boundaries.test.ts`覆盖旧工作台白名单、v3领域集合、规则设置、账本、快照和未知字段；`tests/api-routes.test.ts`覆盖通用配置正常保存、已认证越权PUT和畸形JSON。 |
| AUD-002 | RESOLVED | Series API缺少完整运行时枚举与引用校验。 | `POST /api/series`显式校验强度、部位、钓法、类型、功能、品质、Collection与Performance存在/启用状态，并保留Type兼容校验。 | `tests/api-routes.test.ts`逐引用4xx覆盖；类型检查及默认`npm test`通过。 |
| AUD-003 | RESOLVED | Series/SKU创建缺少命令幂等与结果恢复。 | 客户端发送稳定命令键；服务端将输入hash与Series结果引用同Workspace revision原子保存，相同输入恢复原Series/SKU，不同输入409，并发仅一次提交成功。 | `tests/api-routes.test.ts`覆盖重放、键冲突、并发冲突及冲突后恢复；默认`npm test`通过。 |
| AUD-004 | RESOLVED | 离散拉力解析静默丢弃非法token与重复项。 | `parseDiscretePulls`保留合法值并单独报告`invalidTokens/duplicateValues`；任一异常均阻止创建。 | `tests/api-command-boundaries.test.ts`与`tests/api-routes.test.ts`覆盖中英文分隔、负数、文本和重复值。 |
| AUD-007 | RESOLVED | 飞书导入审计身份可能为空。 | `stableAuditActor`优先保存`feishu:{tenantKey}:{openId}`，再回退显示名/email，导入与Series命令共用。 | `tests/api-command-boundaries.test.ts`覆盖飞书稳定身份及非空回退。 |
| AUD-025 | RESOLVED | 默认测试入口遗漏飞书回写回归。 | `package.json`改用`tests/*.test.ts`与`tests/*.test.mjs`自动发现正式测试，新文件无需维护长名单。 | 集成态默认`npm test`通过208项TS测试与1项渲染测试，其中飞书回写5项（字段匹配1项、提交恢复4项）均执行。 |
| AUD-021 | RESOLVED | Feishu 远端写成功后，本地审计保存 revision 冲突曾要求人工重新拉取。 | `3398c8e`新增v16持久化`DataSourceWritebackIntent`、稳定幂等键、最新revision自动对账与回读恢复；写回只登记`remoteChangesAvailable`，不刷新binding、不拉取或发布。 | `tests/data-source-writeback-recovery.test.ts`覆盖远端成功后单次冲突自动合并、持续冲突后显式重试只回读不重复追加、失败证据保留与恢复；完整`npm test`通过213项TS测试和1项渲染测试，lint/typecheck通过。 |
| AUD-022 | RESOLVED | Feishu 主工作簿 wiki token/share URL 是否应为可变部署配置未有明确工程判定。 | v3 §14已经明确指定《钓具设计工作簿》为唯一通用规则源，因此`3398c8e`将其确认成有意的canonical config-as-code；迁移必须先修订权威规范并经代码审查，UI复用唯一常量。稳定sheet注册表继续独立校验。 | `validateFeishuWorkbookConfiguration`校验链接/token、整本同步范围、anchor sheet、空值和重复sheet_id；远端仍按sheet_id校验缺失/改名/同名新表；相关测试、完整`npm test`、lint和typecheck通过。 |
| AUD-010 | RESOLVED | 甘特图 UI 曾直接对完整客户端状态执行主列表查询，未消费服务端对象可见性、游标和 stale revision。 | `41781d9`使主列表消费`/api/series-gantt`服务端投影；Series、SKU与Model分别使用revision绑定游标，子对象按父级按需加载；409保留筛选和选中Series锚点后恢复第一页。 | 路由覆盖认证、投影边界、404隐藏父对象和409；查询覆盖权限裁剪、总数防泄漏和父级/revision游标；客户端覆盖409恢复及仅消费可见Model。 |
| AUD-015 | RESOLVED | 客户端生产构建曾有超过500 kB的chunk。 | `f77843a`把六个工作台拆成动态入口；[`bundle-analysis-aud-015.md`](./bundle-analysis-aud-015.md)记录基线和产物证据；未提高warning阈值。 | Workbench chunk从869,491 B降至101,969 B，最大chunk为424,888 B，构建不再报告>500 kB；默认测试强制500,000 B chunk预算、六个动态入口和150,000 B Workbench预算。 |
| AUD-R001 | RESOLVED | Attribute Affix 曾先于 Series/SKU/Model Patch 执行。 | `lib/rule-kernel.ts` 已按 Patch → Affix → FinalReview 顺序执行。 | `tests/v3-rule-kernel.test.ts`；`npm test` 通过。 |
| AUD-R002 | RESOLVED | 商品层兼容字段曾影响结构投影筛选。 | `structuralCompatibilityContext` 和 `evaluateStructuralHardCompatibility`。 | 最近匹配测试通过。 |
| AUD-R003 | RESOLVED | Series 创建主要逻辑曾只在客户端执行。 | 新增 `POST /api/series`，客户端调用服务端命令。 | 构建包含路由；相关领域测试通过；整包state绕过后续已由`AUD-001`关闭。 |
| AUD-R004 | RESOLVED | Vercel 构建曾原地修改 `package.json`。 | `vercel.json` 改为无源码写入的 `next build`。 | 文件审查。 |
| AUD-R005 | RESOLVED | 未使用的 ChatGPT 请求头认证模块存在误用风险。 | `app/chatgpt-auth.ts` 已删除。 | Git diff。 |
| AUD-R006 | RESOLVED | Feishu 数据源回写缺少写前/写后回读恢复。 | `commitFeishuWriteback` 和 `tests/feishu-writeback.test.ts`。 | 5个回写场景已纳入默认`npm test`并通过；本地审计冲突恢复已由`AUD-021`关闭。 |
| AUD-R007 | RESOLVED | R730 缺少正式持久存储、备份和部署说明。 | SQLite、迁移/备份脚本、systemd/Nginx、部署文档。 | 根测试与SQLite测试通过；部署路径、Node下限和会话灾备已关闭，revision保留政策仍由`AUD-009`管理。 |
| AUD-R008 | RESOLVED | 生产环境无持久存储时曾静默回退到进程内内存，重启后丢失团队配置。 | `lib/storage.ts`的`assertEphemeralStorageAllowed`；`f0fe8232`。 | `tests/storage.test.ts`及集成态完整测试通过；systemd路径不一致已由`AUD-008`关闭。 |
| AUD-R009 | RESOLVED | SQLite保存的revision条件更新未命中时曾可能继续写入历史，形成伪revision。 | `lib/sqlite-storage.ts`检查`updated.changes`并回滚；`45e8281d`。 | 持久化、过期`baseRevision`、不新增历史及并发测试通过。revision保留政策仍由`AUD-009`管理。 |
| AUD-R010 | RESOLVED | 旧扁平`SeriesRecipe`缺少可承载竿、轮、线独立约束的迁移结构。 | v14`SeriesRecipe.partConstraints`及v13→v14顺序迁移；`be1cf696`。 | 迁移幂等测试通过并保留旧字段。运行时/UI消费及语义映射继续由`AUD-026`管理。 |
| AUD-016 | RESOLVED | `BLOCKER` 甘特筛选值与legacy `ValidationIssue.level`不一致。 | `ValidationIssue.severity`承载规范严重度；缺失时确定性兼容映射legacy level。 | `tests/series-gantt-query.test.ts`覆盖BLOCKER命中与ERROR隔离；类型检查及领域测试通过。 |
| AUD-017 | RESOLVED | `applyLayeredPatches`跨实体批量调用可能误报set冲突。 | 冲突键加入`scopeId`，只在同作用域实体同路径间报告竞争。 | `tests/v3-end-to-end.test.ts`覆盖不同/相同scopeId；领域测试通过。 |
| AUD-023 | RESOLVED | 未发布或过期的`FiveAxisViewDefinition`可能进入新正式Snapshot。 | v15为定义增加revision、发布状态和内容哈希；新预览冻结定义revision/hash并纳入inputHash；旧定义无损迁移为未发布；`new_formal`核验完整版本链。 | `tests/five-axis.test.ts`覆盖正常、未发布、篡改、同ID版本内容替换、过期及历史Snapshot冻结；`tests/v3-migration.test.ts`覆盖迁移幂等；集成态完整测试通过。 |

## 更新记录

| 日期 | 变更 | 提交 |
| --- | --- | --- |
| 2026-07-22 | 建立审查台账，登记 22 个开放问题和 7 个已解决问题。 | `c1a6070d` |
| 2026-07-22 | 复核去重：`AUD-012`转`SUPERSEDED`，`AUD-018`转`IN_PROGRESS`，补录`AUD-023～025`；当前有效未关闭问题24个。 | `034a353` |
| 2026-07-22 | 归并产品反馈：“系列配方未拆分竿轮线”并入`AUD-005`验收，不增加AUD数量；品质、定价、配置导出和交互反馈转由实现差距矩阵及v3/UX权威项管理。 | `034a353` |
| 2026-07-22 | 将v3-work的SQLite条件更新、生产环境禁止内存回退、v14系列配方迁移cherry-pick到审查分支；补全PatchLedger的v14 schema断言；新增`AUD-R008/009`。`AUD-008/009`仍开放。 | `45e8281d` `f0fe8232` `be1cf696` `6c233e5d` |
| 2026-07-22 | 拉取全部远端分支并复审`origin/review/current-state-2026-07-22@fee6c83a`：新增`AUD-R008～R010`，有效未关闭问题仍为24个；完整测试190项、渲染测试1项、飞书回写单测5项及类型检查通过。 | `034a353` |
| 2026-07-22 | 部署与工程治理复核：关闭`AUD-008/011/013/014/020`；`AUD-018`已固化行尾策略但等待Windows检出验证；`AUD-019`因历史pnpm工作区尚未完成独立CI验证继续开放。 | `9a86ee6` |
| 2026-07-22 | 第一批领域契约修复关闭`AUD-016/017/023`；工作区升级到v15，新五维预览冻结定义revision/hash，且不改写历史Snapshot。`AUD-024`保持开放，等待完整顺序迁移。 | `a35cf72` `d9a2412` |
| 2026-07-22 | API/命令边界第一批修复：关闭`AUD-001～004`、`AUD-007`与`AUD-025`；追加默认拒绝、并发幂等恢复和恶意JSON类型边界。 | `1c0df55` `6d6d660` `44cfc2d` |
| 2026-07-22 | 三个独立worktree修复分支完成主分支集成复核；生产构建、208项TypeScript测试及1项渲染测试通过。有效未关闭问题由24个降为10个。 | `a9472b6` `a35cf72` `d9a2412` `1c0df55` `6d6d660` `44cfc2d` |
| 2026-07-22 | 历史pnpm workspace完成冻结安装、类型检查、测试与生产构建，关闭`AUD-006`；`AUD-018/019`等待新增Windows/双包管理CI首次远端通过。 | `d30c763` |
| 2026-07-22 | 飞书恢复与规则源配置治理：关闭`AUD-021/022`；回写先持久化意图并可跨本地revision冲突自动对账，写回/拉取/发布保持独立；主工作簿按v3 §14确认为canonical config-as-code并增加配置与稳定sheet注册表校验。 | `3398c8e` |
| 2026-07-22 | 集成复核修正`AUD-001`过窄白名单造成的旧工作台保存回归；仅恢复旧工作台显式通用配置字段，v3受治理状态与未知字段继续默认拒绝。 | `81763c3` |
| 2026-07-22 | 甘特主列表接入服务端可见性、revision游标、409恢复及SKU/Model按需加载；六个工作台动态拆分并增加真实构建产物预算，关闭`AUD-010/015`。 | `41781d9` `f77843a` |
| 2026-07-22 | 完成AUD-024目标拉力顺序迁移：活动契约收敛到规范四阶段字段，历史旧字段只在v16→v17迁移适配器读取，冻结Snapshot payload/hash不变；保留v15→v16飞书回写意图迁移。完整测试通过225项TypeScript测试与2项生产构建测试，有效未关闭问题降为4个。 | `3ec88dc` |
| 2026-07-22 | 首次远端CI三项门禁全部通过：根v3 npm、历史pnpm workspace及Windows行尾策略；关闭`AUD-018/019`，有效未关闭问题降为2个，均为待决策的`BLOCKED`项。 | [`CI #1`](https://github.com/futouyiba/tackle-forger/actions/runs/29935463528) |
| 2026-07-23 | 为`AUD-009`补充工作区revision保留ADR草案，比较永久、固定条数与时间+数量混合策略；提出`90天 + 至少100条`候选默认值、事务清理与备份/审计边界。等待责任人决策，问题保持`BLOCKED`。 | 本分支提交 |
| 2026-07-23 | 独立复核纠正`AUD-005`范围：根v3权威和生产目标已确定，旧入口只读化改为可执行的`OPEN`项；分部位约束语义拆为`AUD-026 BLOCKED`。已解决项复核未发现需要重开。 | 本分支提交 |
| 2026-07-23 | 为`AUD-009`落地政策无关的只读SQLite revision诊断：输出容量/时间/数据库与WAL统计，异常fail-closed，备份manifest冻结副本诊断；没有删除、裁剪或改变历史读取语义。保留政策仍待确认。 | 本分支提交 |
