# AUD-005 应用权威、历史工作区与旧配方入口 ADR 草案

> 状态：`PROPOSED / PARTIALLY DECIDED`
>
> 提案日期：2026-07-23
>
> 现状证据基线：`review/current-state-2026-07-22`提交`6cf90401f7a3a06e5a8492918c06f4ab5829da40`
>
> 权威语义：[`tackle-forger-development-spec-v3.md`](../tackle-forger-development-spec-v3.md)

仓库README、CI和R730部署配置已经共同确定“根Vinext v3是当前唯一权威实现，历史workspace只用于追溯”的基线。本文件把该既有结论整理为收敛方案，但不据此删除入口或历史数据。旧入口只读化由`AUD-005`作为可执行工程项管理；分部位约束的领域语义已经由[`AUD-026 PartConstraintSet语义ADR`](./aud-026-part-constraint-semantics-adr.md)确认，后续实现仍由`AUD-026`独立验收。

## 1. 待决策问题

仓库当前同时包含三组容易被误认为同一产品主线的实现：

1. 根目录`app/*`、`lib/*`和`tests/*`组成的Vinext应用，已经承载v3的Series → SKU Drawer → Purchasable Model → ConfigurationSnapshot流程、命令边界、SQLite持久化和R730部署入口；
2. `apps/web`与`packages/{domain,db,excel,ui}`组成的pnpm/Next.js历史workspace，仍可独立构建，但使用不同的数据模型、演示登录、本地浏览器状态和旧Excel拓扑；
3. 根应用内部仍同时暴露旧`SeriesRecipe`、旧`Candidate`、`OfficialSku`和明细页，以及v3的Series/SKU/Model工作台。

根v3作为唯一可写产品入口已由现有仓库约定决定。仍需确认的是历史实现最终采用何种归档形态。旧配方中的竿/轮/线约束已确认迁入版本化`PartConstraintSet`并由`CandidateSearchRecipe`按稳定revision引用；具体组件只在候选结果和Model的`componentSelections`中保存。

## 2. 不可突破的v3约束

无论选择哪个方案，均必须满足下列边界：

- v3规范是唯一产品与领域权威；历史文档和历史代码不能反向定义语义。
- Series是产品家族，SKU是离散目标拉力的钓具抽屉，Model才是实际选择和购买对象。
- `CandidateSearchRecipe`只负责候选枚举、过滤和排序，不得成为长期产品身份。
- 钓法和类型是两个规则层；重量规格采用最近派生模板，不连续插值。
- 品质映射保持C/绿、B/蓝、A/紫、S/橙；`functionIntensity`不是品质。
- 已发布`ConfigurationSnapshot`不可被上游规则、迁移或回滚静默重算。
- 历史Candidate、Recipe、OfficialSku和Trace需要保留、迁移和可追踪，不能通过删除历史状态简化实现。
- 被动技能只保存、计分和展示，不在本工具内执行模拟器逻辑。
- 仍未确定的领域语义必须保持可配置，并在实现前由用户确认。

## 3. 已核实的当前事实

### 3.1 根应用已经是实际v3主线

- 根`package.json`以`vinext dev/build/start`作为运行脚本，Node基线为22.16；根CI使用npm完成类型检查、lint和测试。
- 根`app/page.tsx`进入统一Workbench；v3页面读写`seriesDefinitions`、`skuDrawers`、`purchasableModels`、`configurationSnapshots`和`candidateSearchRecipes`。
- `/api/series`负责创建正式Series/SKU，`/api/series-gantt`提供服务端投影；R730的systemd服务从仓库根执行`npm run start`。
- `lib/legacy-product-migration.ts`已经提供OfficialSku到Series/SKU/Model/Snapshot的确定性迁移，并保留稳定ID、来源绑定和冻结快照。

这些事实说明根应用不是演示壳，而是当前最接近v3规范、真实持久化和生产部署约束的实现。

### 3.2 历史workspace不是根v3应用的等价模块

- `apps/web`单独使用Next.js和pnpm workspace依赖；页面仍从`mock-data.ts`读取旧对象，并出现“组合SKU”、旧品质及旧评分语义。
- 它的登录由浏览器`localStorage`中的演示账号完成，页面编辑状态也主要由`usePersistentState`写入`localStorage`，没有复用根应用的飞书身份和SQLite命令边界。
- `packages/db`定义`combinationSkus`、密码哈希和旧规则结构，缺少完整的v3 Series/SKU Drawer/Model/ConfigurationSnapshot/RRuleSet/Patch身份链。
- `packages/excel`使用旧工作簿sheet拓扑；`apps/web`导入接口仅解析和汇总工作簿，未形成根v3状态的正式导入事务。
- CI现在会独立验证该workspace的安装、类型、lint、测试和构建。这证明它仍可构建，不证明它具有v3语义等价性或可作为生产替代品。

因此，直接把`apps/web`切为生产入口会产生数据、权限、规则和部署语义的整体倒退。

### 3.3 根应用仍存在双流程

- 主导航仍提供“系列配方”，旧页面编辑`SeriesRecipe`的扁平字段，并调用旧`generateCandidatesForRecipe`生成旧`Candidate`。
- 同一“Model候选”页面既承载v3甘特与实体链，也在折叠区展示旧Candidate；“正式SKU”和“杆轮线明细”仍可编辑旧`officialSkus`与明细覆盖。
- `SeriesRecipe.partConstraints`已在schema v14中为rod/reel/line生成，但迁移只是把旧扁平模板、类型和词条复制到三个部位并标注待复核。
- 当前旧配方UI没有编辑`partConstraints`，旧候选引擎不消费它；迁移到`CandidateSearchRecipe`时也只读取旧扁平字段。
- v3候选运行时当前只消费页面预先填写的`ModelVariantInput.componentSelections`，尚未依据分部位搜索约束枚举组件并把实际入选结果写入候选输出。

这使同一用户能在两个含义不同的“配方/候选/SKU”链路上写数据，是`AUD-005`尚不能关闭的主要原因。

### 3.4 部署入口也需要收敛

- R730生产手册和systemd均指向根应用，生产构建步骤为`npm run build`，启动为`npm run start`。
- Cloudflare Worker/Vite配置也包装根Vinext应用，可作为受控预览或未来部署适配层，但目前不是R730生产事实。
- `vercel.json`仍显式使用`next build`，而根脚本的权威构建器是`vinext build`；这会造成评审入口与生产入口漂移。
- `apps/web`自身也能执行`next build/start`，但目前没有证据表明R730或正式数据指向它。

部署收敛必须同时命名“代码入口、构建命令、数据后端、运行环境”，不能只写“部署根目录”。

## 4. 方案比较

| 方案 | 描述 | 优点 | 主要代价与风险 | 结论 |
| --- | --- | --- | --- | --- |
| A. 根v3唯一权威；历史workspace只读归档/迁移来源 | 只有根`app/lib`可以承载正式写入和部署；`apps/web/packages`保留为可验证的历史参考与数据迁移来源，不进入生产导航 | 与当前v3实现、SQLite、飞书身份、R730手册和快照冻结规则一致；迁移面最小；可逐步封存旧入口 | 需要完成旧页面降级、已确认分部位约束的实现、迁移工具和部署配置收敛 | **推荐，待用户确认** |
| B. 以`apps/web/packages`取代根应用 | 将workspace发展为唯一主线，把根v3能力迁入packages与Next应用后再切换 | 长期可能得到更传统的monorepo边界；共享包理论上便于多前端复用 | 现有workspace缺少v3实体链、真实身份、持久化、治理与测试；需要几乎重写并双向迁移，当前切换会倒退 | 当前不采用；若未来重启，需另立迁移ADR和完整等价验收 |
| C. 两套UI长期并行，共享抽取后的领域/API | 根应用与`apps/web`服务不同用户群，统一调用新抽出的canonical API/packages | 可保留不同交互体验；理论上减少一次性UI迁移 | 当前没有已确认的双产品需求；在共享层完成前存在双写、权限分叉、版本漂移和两套部署；成本最高 | 只有用户确认存在长期双入口业务需求时才评估 |
| D. 立即删除历史workspace和旧根页面 | 一次性移除所有旧代码和入口 | 表面上最快消除歧义 | 违反历史数据保留、迁移与可追踪要求；也失去旧Excel/DB/页面语义的取证来源 | 不可接受 |

## 5. 既有权威结论的正式化文本

根据README、CI和R730部署事实，按方案A继续收敛，并将既有结论正式写为：

> Tackle Forger的唯一可写产品与领域实现为仓库根Vinext v3应用。正式生产部署、评审部署和数据写入均必须以根应用、根npm锁文件和根v3状态模型为准。`apps/web`与`packages/*`定义为历史workspace，只用于只读参考、兼容性测试和经审计的数据迁移；它们不构成第二个生产入口，也不能定义新领域语义。根应用中的旧SeriesRecipe/Candidate/OfficialSku页面在完成可逆迁移后转为只读历史入口，最终从默认导航移除，但原始记录和Trace继续保存。

分部位约束已经由AUD-026决策确认：建立版本化`PartConstraintSet`，由`CandidateSearchRecipe`通过稳定revision引用；template、material、required affix和optional affix pool按rod/reel/line参与候选搜索，具体组件只在候选结果和Model的`componentSelections`中保存。Series Type保持系列级语义，分部位`typeIds`只有在组件注册表提供明确、版本化的部位分类时才生效。完整语义、旧数据复核与Snapshot冻结规则见[`AUD-026 PartConstraintSet语义ADR`](./aud-026-part-constraint-semantics-adr.md)。`SeriesRecipe`本身仍不应恢复为正式产品身份。

## 6. 分阶段迁移计划

### 阶段0：决策与清点

- 用户确认方案、负责人、目标时间和历史入口保留期限。
- 固定根应用为唯一生产部署目标；记录当前生产revision、数据库备份和所有入口URL。
- 统计每类旧对象数量、未发布草稿、来源revision、引用关系和孤儿ID；只读检查，不改变数据。
- 依据AUD-026 ADR逐项清点`partConstraints`中template/type/material/required/optional affix的来源、未知引用和复核状态，区分“搜索约束”与“实际Model部件选择”。

退出条件：根v3权威基线已记录；分部位语义以AUD-026 ADR为书面结论。`AUD-026`不再因领域选择而`BLOCKED`，但数据模型、迁移、runtime、UI和测试仍未完成，也不阻塞`AUD-005`推进可逆的旧入口只读化和迁移诊断。

### 阶段1：入口去歧义，不迁移数据

- 根导航把旧“系列配方”“正式SKU”“杆轮线明细”归入清晰标注的“历史数据”区，默认只读；v3 Series/SKU/Model成为唯一默认创建入口。
- `?page=recipes`、`?page=skus`等既有深链继续可解析，但先显示历史状态、迁移状态和前往v3对象的链接，不能悄悄把旧写操作解释为v3写操作。
- 旧Candidate折叠区改为明确的历史运行记录；“Model候选”一词只用于v3候选。
- `apps/web`不出现在生产导航、反向代理或评审入口；仓库README与启动说明保持其“历史workspace”标记。

回滚点：此阶段只改变发现性与权限门面，可由入口特性开关恢复展示；不得删除对象。

### 阶段2：建立可版本化的分部位约束

- 新增canonical、版本化且不可变的`PartConstraintSet`，由`CandidateSearchRecipe`通过稳定revision引用，而不是复制可变对象。
- rod/reel/line分别保存template、type、material、required affix、optional affix pool；未选择与“允许全部”必须有不同表示。
- runtime把搜索约束应用于相应部位的候选枚举；实际入选的部件必须落入候选结果的`componentSelections`，物化后进入Model并写入生成Trace。
- UI必须分别展示和编辑竿、轮、线约束，显示命中/排除原因，不能继续只编辑扁平字段。
- 冲突或无法解析的ID必须阻止正式物化并产生可操作诊断；不得静默放宽为“全部允许”。

回滚点：新字段和表只能采用向前兼容的加法schema。旧版本可忽略新字段但不能覆盖它们；一旦产生新格式写入，不允许反向压平回旧字段。

### 阶段3：幂等数据迁移

- `SeriesRecipe`迁为`CandidateSearchRecipe`加分部位约束引用；保留`sourceLegacyRecipeId`、原始payload、迁移revision和诊断。
- 旧Candidate作为历史候选运行与审计材料保存；可链接到新CandidateRun/ModelCandidate，但不自动升级为可购买Model。
- OfficialSku继续经现有确定性迁移生成Series/SKU Drawer/Purchasable Model/ConfigurationSnapshot；重复执行必须返回同一稳定身份，不产生副本。
- 已发布Snapshot只复用冻结内容和hash；发现不一致时停止迁移并人工处理，禁止重算覆盖。
- 明细覆盖只有在可证明语义等价时才转换为分层Model Patch；否则保留为只读legacy detail并记录未迁移原因。
- 来自`apps/web`浏览器状态、旧Excel或未来旧Postgres的数据只能通过显式导出—检查—导入包进入根应用，不能直接合库或双写。

回滚点：迁移使用新revision与迁移日志，保留原对象。回滚只能把读取指针切回旧视图或撤销未发布的新对象，不能删除原数据或改写已发布Snapshot。

### 阶段4：正式切流

- 禁止创建或更新旧SeriesRecipe/Candidate/OfficialSku；所有新写入走根v3命令边界。
- 默认导航移除旧入口，既有深链进入只读归档页或稳定重定向页；重定向必须保留可审计的旧ID。
- 收敛部署：R730只构建和启动根应用；Vercel评审入口改用与根脚本一致的构建命令；Cloudflare适配若继续保留，明确标注为评审/实验环境。
- 历史workspace继续由独立CI验证，直至用户决定冻结到tag、移入archive目录或停止日常依赖升级。

回滚点：可回滚根应用artifact，但不能把`apps/web`当作灾备生产入口。数据库回滚遵循R730手册：停服后从验证备份恢复到新文件，并保留原库作审计副本。

### 阶段5：归档与可选提炼

- 经过约定观察期且旧对象全部完成迁移分类后，可冻结历史workspace；是否移动目录或只保留tag由用户决定。
- 可从历史packages中提炼仍有价值的纯函数或Excel解析器，但每个提炼项必须先通过v3语义测试，不能因包名为`domain`就自动视为权威。
- 旧根页面的运行代码只有在数据仍可通过归档查看器访问、Trace完整且回滚观察期结束后才能删除。

## 7. 数据兼容矩阵

| 旧来源 | v3目标/处理 | 必须保留 | 禁止行为 |
| --- | --- | --- | --- |
| `SeriesRecipe`扁平字段 | 迁移输入；生成`CandidateSearchRecipe`及部位级`NEEDS_REVIEW`保留记录 | 原ID、原payload、来源revision、诊断 | 继续作为Series或Model身份；把机械复制宣称为已确认语义 |
| `SeriesRecipe.partConstraints` | rod/reel/line逐项审核后迁入版本化约束 | 未解析ID、人工复核状态 | 将同一扁平集合无条件解释为三个部位的有效结论 |
| 旧`Candidate` | 只读候选运行/审计记录，可建立新对象链接 | 输入、输出、排序、规则revision、Trace | 自动视为可购买Model |
| `OfficialSku` | 现有迁移生成SKU Drawer、Model和冻结Snapshot | 稳定绑定、历史状态、hash | 把SKU当Model；重复迁移生成副本 |
| 旧明细覆盖 | 等价时迁为Model Patch，否则只读保留 | patch层级、来源、原因 | 覆盖派生模板或已发布Snapshot |
| `apps/web` localStorage/mock数据 | 显式导出包，经schema校验和人工确认后导入 | 来源环境、导出时间、schema版本 | 直接读浏览器状态作为正式库；双写 |
| `packages/db`旧Postgres结构 | 单向ETL候选来源，需另行映射 | 原主键和审计副本 | 把旧表直接挂到根API |
| 已发布`ConfigurationSnapshot` | 原样保留并按hash验证 | 内容、hash、发布revision、绑定 | 上游重算、迁移重写、普通代码回滚覆盖 |

## 8. 页面与部署入口的目标状态

| 入口 | 接受方案A后的目标 | 兼容处理 |
| --- | --- | --- |
| 根`/?page=v3flow`及v3 Series/SKU/Model工作台 | 唯一正式创建、选择、购买对象与发布入口 | 保持稳定ID深链 |
| 根`/?page=recipes` | 历史配方查看与迁移诊断 | 观察期内保留深链；禁止新建/修改后可转归档页 |
| 根旧Candidate区域 | 历史运行查看器 | 与v3候选明确分栏、不同名称和状态标识 |
| 根`/?page=skus`及旧明细页 | OfficialSku/override历史查看器 | 提供迁移后Series/SKU/Model链接，不执行双写 |
| `apps/web` | 仓库内只读历史workspace | 不挂生产域名；CI只证明可构建与可取证 |
| R730 | 根Vinext + SQLite + 飞书身份的唯一生产入口 | systemd继续执行根`npm run start` |
| Vercel | 根应用评审入口 | 构建命令与根`npm run build`一致；不作为持久化生产 |
| Cloudflare Worker | 明确命名的预览/实验适配层，或移除 | 未获单独批准前不宣称生产目标 |

## 9. 测试与验收条件

### 9.1 决策与入口

- 根v3唯一权威的既有结论在README、CI、部署配置和问题台账中保持一致；若未来变更，必须签署替代ADR。
- 生产域名、R730服务和评审域名均可追溯到根commit、根锁文件和根构建命令。
- 生产页面没有进入`apps/web`的链接或可写入口；旧根入口全部显示历史/只读状态。
- 旧`?page=`深链、收藏链接和实体ID在迁移前后均得到确定的查看、重定向或诊断结果，不出现空白或错误写入。

### 9.2 分部位约束

- 正常路径：rod/reel/line各自约束只影响相应部位，命中候选落入`componentSelections`并出现在Trace。
- 边界：空集合、单一ID、最大候选数、未知ID、禁用对象和版本变化均有确定结果。
- 冲突：required与排除条件冲突、部件类型不兼容、材质缺失时必须失败关闭并给出部位级原因。
- 兼容：只有旧扁平字段的数据可迁移为“待复核”，但不得在无人确认时自动发布Model。
- UI：三个部位分别可见、可编辑、可复核；保存后重新加载不丢revision或未解析项。

### 9.3 数据迁移

- 同一数据集连续迁移两次，对象数量、稳定ID、绑定与Snapshot hash完全一致。
- 正常、空数据、孤儿引用、重复ID、部分迁移、冲突和中断恢复都有自动测试。
- 迁移前后按类型对账；任何丢失、静默丢字段或Snapshot hash变化都阻止切流。
- 旧对象和原始payload仍可只读导出；迁移Trace能从新对象回到旧ID和来源revision。
- API权限测试证明历史集合不能通过整包保存或旧入口绕过只读限制。

### 9.4 发布门禁

- 根应用通过`npm run typecheck`、`npm run lint`、`npm test`和生产构建。
- 历史workspace在归档前继续通过冻结锁文件安装、类型、lint、测试和构建；这项门禁不得被解释为产品等价验收。
- R730预发布环境完成登录、创建Series、离散SKU物化、Model选择、Snapshot发布、备份和恢复演练。
- Vercel/预览构建不得使用与根权威脚本不同的框架命令。

`AUD-005`在旧入口去歧义、旧集合写边界收紧和部署收敛完成后才能转为`RESOLVED`。分部位runtime/UI消费及迁移语义由`AUD-026`独立验收，不能因`AUD-005`关闭而跳过。

## 10. 回滚边界

- **入口改造前后：**可以用特性开关恢复旧页面的可见性，但恢复写权限必须有显式审批；只读归档数据始终保留。
- **迁移只读阶段：**可以切回旧视图或撤销未发布的新对象，迁移schema必须保持加法兼容。
- **产生canonical新写入后：**不得把新分部位约束反向压平成旧字段。旧版本若不能无损读取新schema，只能前向修复，不能直接降级运行。
- **Snapshot边界：**任何代码、schema或数据回滚都不得修改已发布Snapshot；hash异常必须停服调查。
- **生产数据：**代码artifact可以回滚；SQLite不能被旧artifact覆盖。需要恢复时按生产手册从已验证备份恢复到新文件，并保留故障库。
- **部署边界：**历史`apps/web`不是根应用故障时的紧急替代品。若根应用无法发布，应回滚根artifact或停写，不得切到语义不同的workspace。
- **不可逆点：**删除旧运行代码、停止历史workspace CI或清理历史数据，都必须在观察期结束后另获用户批准，不包含在本ADR的默认授权内。

## 11. 需要用户最终确认的项目

AUD-026的分部位约束方向已经确认，不再属于本节待选方案；见[`AUD-026 PartConstraintSet语义ADR`](./aud-026-part-constraint-semantics-adr.md)。AUD-005仍需确认：

1. 旧根入口在只读后保留多久，是否仅管理员可见，还是所有现有用户都可查看？
2. Vercel与Cloudflare入口分别保留为评审环境、实验环境，还是只保留其中一个？
3. 历史workspace最终是原地冻结、移动到archive目录，还是以tag/独立仓库保存？

在这些问题得到明确答复前，可以推进可逆的旧入口只读化、兼容跳转、对象清点、迁移预览和部署差异检查；不执行历史数据删除或不可逆转换。分部位语义按AUD-026 ADR实施，不再作为本节待选方案。
