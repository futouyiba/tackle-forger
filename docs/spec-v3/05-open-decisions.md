## 19. Agent交付检查表

开发Agent提交前必须确认：

- [ ] 已阅读本规范和开放决策；
- [ ] 没有引用历史文档中的冲突结论；
- [ ] 没有把派生结果作为人工源数据修改；
- [ ] 没有对重量做插值；
- [ ] 没有混淆Quality和functionIntensity；
- [ ] 没有混淆SKU和Model；
- [ ] 没有让Technology和Affix重复加成；
- [ ] 没有在本工具实现被动技能运行时；
- [ ] 新行为有轨迹、校验和测试；
- [ ] 发布快照保持不可变；
- [ ] 数据迁移保留历史兼容；
- [ ] 未确认公式通过配置表达，没有散落硬编码。

## 20. 未决事项登记表

本节是唯一产品语义、规则源阻断和公司策略缺口登记表。“开放”不表示实现可以留空。每个未决项都必须有可确定执行的未决行为：使用明确的草稿/种子配置、显示状态和Issue，并在指定关口fail-closed；不得使用隐藏默认值。部署凭据、某台机器的目录绑定和某次服务不可用等环境状态不属于产品决策，记录在“当前实现差距矩阵”，不得伪装成OPEN项。

| ID | 类型 | 状态 | 当前可执行边界 | 未决时的必须行为 | 关闭证据/决策责任 |
| --- | --- | --- | --- | --- | --- |
| OPEN-001 降低型词条叠加 | 产品决策 / 规则源待迁移 | `DECIDED_PENDING_POLICY_VERSION` | 全局唯一使用`bidirectional_ratio`，完整顺序为`set → 百分比 → 固定值 → clamp_add → FinalReviewPatch → ParameterDefinition`；不得按参数或词条族切换 | 权威主工作簿尚无机器可读策略行，或没有已发布`ReductionStackingPolicyVersion`时，只允许明确标记的非正式预览，产生不可waive的PUBLISH BLOCKER并禁止新Model和Snapshot发布 | 2026-07-23用户确认；外部工作簿revision `17173`仅作决策证据；将规则迁入主工作簿`04_词条`（词条表）的稳定机器区域，显式拉取、校验、发布策略版本并通过公式、边界、数值域、迁移和冻结回归后才能改为`RESOLVED` |
| OPEN-002 性能定位派生语义 | 已决产品结论 | `DECIDED_IMPLEMENTATION_PENDING` | 新契约只产生只读`PerformanceSummary`；旧`PerformanceProfile/performanceId`只读保留 | 新revision不得把Performance作为配置、贡献层、评分乘数、兼容或定价输入；运行时迁移完成前不得把旧路径冒充新契约 | 2026-07-23用户决定与`open-007-pricing-semantics-adr.md`；实现由GitHub Issue #9跟踪 |
| OPEN-003 扩展部位启用 | 延后产品决策 | `DEFERRED_UI_DISABLED` | 当前及已排定范围只启用竿、轮、线；SKU仅包含竿、轮、线 | 钩、漂、真饵和拟饵仅保留注册表与历史数据兼容；只读UI、草稿、生成、发布、Snapshot和所有环境/渠道导出全部关闭 | 2026-07-23产品确认“当前完全延期，未来另做产品设计”；存在可校验的已发布`enabledItemPartPolicy`前不得标记`RESOLVED`，未来任一部位启动前仍须另建产品设计Issue |
| OPEN-004 Patch属性偏移阈值 | 规则策略缺口 | `RESOLVED` | 已发布`patch-offset/open004-v1`：不设置独立偏移阈值；Patch立即参与草稿试算，正式结果前必须纳入Series/SKU/Model或发布批次的整体人工复核证据；按当前关口各离散对象的累计最终值和已发布参数合法范围校验 | 缺少或损坏已发布`PatchOffsetPolicyVersion`时仍产生`PATCH_OFFSET_POLICY_MISSING`或完整性BLOCKER；范围越界ERROR只有取得匹配当前Gate的Waiver后才能继续，且仅当Gate为EXPORT时额外要求精确匹配目标环境×渠道；完整性BLOCKER永不可waive | 2026-07-23用户确认决策；Workspace schema v16发布并校验策略版本；Issue #32覆盖批量复核、多重量、Gate/渠道Waiver、rebase、迁移和Snapshot/ExportManifest冻结回归 |
| OPEN-005 五维图定义 | 产品决策 | `DECIDED_PENDING_DEFINITION_VERSION` | 第21、22、24.6和25.3节已记录2026-07-23确认的正式语义、哈希、投影引用及候选差量/事务契约；实现仍须从版本化定义读取，不得写死在UI/数据库 | 旧五维定义即使原记录为`PUBLISHED`也只允许历史Snapshot只读重放；在符合OPEN-005的新定义进入`FORMAL_CURRENT`前，新正式Snapshot必须fail-closed | 决策证据为GitHub Issue #13及2026-07-23用户确认；完成第21.7节迁移、发布可校验的新`FiveAxisViewDefinition`并通过门禁回归后改为`RESOLVED` |
| OPEN-006 AI供应方与数据出网 | 安全/产品决策 | `RESOLVED` | 使用`ai-provider/open006-v1`：Fancy Hub、`ai-request/v1`严格Schema、动态模型修订、字段级保留和分层限额 | 本决策只解除产品策略阻断；真实连接器在Issue #25完成、测试并启用前继续禁用，不得发送真实数据 | 2026-07-23用户确认本节策略；AI无批准、写回或发布能力，无需另设三方会签 |
| OPEN-007 定价决策落地与源表一致性 | 已决产品结论/外部规则源落实 | `DECIDED_SOURCE_UPDATE_REQUIRED` | 旧实现可继续输出明确标记的`NON_FORMAL`试算；新契约按第20.1节执行 | 飞书机器源、新schema、迁移、确认记录和发布/导出尚未全部落实前，禁止把旧Draft发布成符合新契约的PricingPolicyVersion | 2026-07-23用户决定与`open-007-pricing-semantics-adr.md`；源表负责人更新机器源，GitHub Issue #9完成实现 |
| OPEN-008 ConfigIdPolicy区间与命名 | 公司策略（已确认） | `DECIDED_PENDING_POLICY_VERSION` | 按本节确认规则实现策略版本、ledger、权威目标目录/扫描Manifest、历史导入、正式动作治理租约/受保护ref CAS和冲突预检 | `ConfigIdPolicyVersion`尚未发布，或其引用的`ConfigTargetCatalogVersion`中任一必需目标没有获批扫描Manifest时，不得正式预留ID、历史ID正式导入或正式导出；正式预留、历史ID正式导入和正式导出任一无法取得`ConfigTargetGovernanceLease`、无法对authoritative ref执行expected-old-OID CAS或返回`CONFIG_TARGET_SERIALIZATION_UNAVAILABLE`时必须fail-closed。策略发布只复验Manifest/ref/hash，不要求治理租约；禁止用“最大值+1”、示例ID、用户临时绑定或单一渠道扫描代替 | 配置治理负责人发布策略版本；权威目录和获批Manifest覆盖完整；reservation、历史导入、正式导出和分裂命中验收通过；治理租约的物理ref别名竞争、单调fencing token、受保护ref CAS、stale token与`CONFIG_TARGET_SERIALIZATION_UNAVAILABLE`失败验收通过 |
| OPEN-009 工作流治理策略 | 产品/安全决策 | `RESOLVED` | 使用第20.2节当前`open009-2026-07-27-v2`统一策略；匿名仅使用浏览器内存本地态，所有共享/服务端动作仍须飞书认证；已认证用户拥有全部已启用业务Capability；AI一期禁用，二期连接器仍需独立实现准入 | 历史`open009-2026-07-23-v1`不得重解释；不接飞书审批、不在本工具实行职责分离；OPEN-006安全配置只由部署管理员修改；关键写操作使用工作区单写锁与单调fencing token，普通操作记录保留1年 | 2026-07-23首次确认、2026-07-27发布入口边界v2；策略正文见第20.2节，运行时仍待独立实现与验收 |
| OPEN-010 飞书Patch台账远端契约 | 外部规则源阻断 | `BLOCKED_ON_SOURCE_SCHEMA` | 已确认`Patch台账`、`A:AK`机器区、`AM:BA`协作事件区、哈希/并发/幂等/补偿/rebase契约；权限引用`separation-of-duties/open009-v2`；不触达飞书的契约实现/测试可继续，但本地PatchLedger、协作事件流、旧版写入/拉取及未实现动作均不得标记为符合或可用 | 本地`PatchOperationRecord`、PatchLedger schema/migration及operation/revision/Snapshot哈希完成`workspaceId`与JCS契约升级前，镜像链路保持禁用；不可变协作事件存储、事务内compare-and-append、`collaborationRevision`/幂等/冲突/`supersedesEventId`校验和action availability完成前，协作写入保持禁用；远端表头、保护边界和连接器联调完成前，真实写入/拉取保持禁用；旧版写入/拉取完成远端schema、IssueCode及ActionCode/Capability升级前保持禁用；`inspect_patch_mirror`、`repair_patch_mirror`、`rebuild_patch_mirror_from_local`、`fix_patch_mirror_schema`、`migrate_patch_subject`的服务端定义、Capability门禁和测试完成前，对应动作也保持禁用；不得伪造SYNCED | 先以版本化迁移补齐本地工作区归属和新哈希，同时保持既有revision、Snapshot引用及历史哈希证据不可变；实现本地协作事件原子追加、先本地提交后镜像及重复重试/双客户端冲突回归；按第14.4节物化远端schema并完成写入、回读、缺行、篡改、hash、跨工作区隔离和并发联调；升级写入/拉取并实现、测试全部镜像/迁移ActionCode、Capability映射、二次确认和审计证据；连接器及运行时实现使用独立Issue/PR跟踪 |
| OPEN-011 工作区revision归档与裁剪启用 | 二期实施/公司策略缺口 | `BLOCKED_BEFORE_PRUNING` | 已批准“最近90天与最新100个的并集”在线保留政策；一期SQLite/D1继续全量保留，人工与自动裁剪均关闭；二期只可在独立Issue范围内实现和验证归档、恢复与只读dry-run | 归档包格式/大小/压缩/加密、恢复入口、归档保留期、RTO/RPO、团队共享与访问控制、维护窗口、删除授权或自动裁剪启用标准任一未确定或证据不可验证时，不得删除任何revision；非删除主流程不得因此被阻断 | 父Issue [#1](https://github.com/futouyiba/tackle-forger/issues/1)；发布覆盖全部实施参数的版本化`WorkspaceRevisionRetentionPolicyVersion`，完成目标浏览器归档与manifest/hash回读、隔离恢复和完整性/Snapshot hash验证，取得首次生产裁剪授权并通过回滚验收；自动裁剪另需独立启用授权 |

`DECIDED_IMPLEMENTATION_PENDING`和`DECIDED_SOURCE_UPDATE_REQUIRED`表示产品选择已经完成，不得继续向用户重复提问，但运行时或外部规则源尚不能宣称完成。状态只有在决策证据进入权威规范、对应策略版本可校验且实现验收通过后才改为`RESOLVED`。代码、原型、测试种子或某次人工输入都不能单独关闭整项工作。

### OPEN-001：降低型词条叠加

2026-07-23用户确认OPEN-001采用全局唯一的`bidirectional_ratio`策略。设`B`为同一属性全部百分比增加幅度之和，`R`为全部百分比降低幅度之和：

```text
PercentAdjusted = BaseValue × (1 + B) / (1 + R)
FinalBeforeBoundary = PercentAdjusted + ΣFlatBonus - ΣFlatReduction
AffixOutput = applyClampAddInStableOrder(FinalBeforeBoundary)
PostReviewValue = applyFinalReviewPatch(AffixOutput)
FinalValue = applyParameterDefinition(PostReviewValue)
```

该模式适用于全局所有属性百分比词条；不允许按参数、部位、词条族或单条词条覆盖。正式数据使用`increase | decrease + 非负有限幅度`，旧有符号值只在导入时归一化并留证。`0%`、`BaseValue=0`、`B ≥ 1`或`R ≥ 1`和有限合法极值允许；负Base使用百分比、单条幅度越界、非法数值、溢出、非有限结果和理论结果非0却因数值精度下溢为0按第11.4节阻断，且本规则所有ERROR/BLOCKER均不可waive。ParameterDefinition决定参数边界、精度和舍入，Trace保存舍入前值。

`ReductionStackingPolicyVersion`必须冻结公式、规范DTO、旧字段映射、operation完整阶段顺序、`ieee754-binary64-v1`数值域、稳定排序与左折叠累加、roundTiesToEven、位型序列化、精确异常影子、异常分类、`ParameterDefinition`引用与执行点、规则源revision及机器规则证据；具体合法范围、精度和最终业务舍入仍由被引用的`ParameterDefinition`版本冻结。ModelRevision和ConfigurationSnapshot必须冻结实际策略版本及第14节所列详细Trace。已发布策略版本不可原地修改，历史版本保持只读和可重放。

新策略版本使受影响草稿进入`DIRTY`并通过显式重算创建新revision，不得覆盖旧revision。已发布Snapshot保持不变，只生成UpgradeCandidate；人工确认后才能从新的ModelRevision发布新Snapshot。缺少策略版本的历史Snapshot保留冻结值、证据与hash，不猜测或绑定当前策略：允许查看和下载第14节定义的原样审计归档，但`export_snapshot`及配置预览/提交必须被不可重放BLOCKER阻断；需要正式导出或新Snapshot时，必须在已发布策略下创建新的ModelRevision并发布新Snapshot。

飞书规则源更新不自动激活。第14节指定的《钓具设计工作簿》仍是唯一运行时通用规则源，不为OPEN-001增加第二工作簿注册。2026-07-23回读的[《FG数值设计v3-总表》](https://pisn3u3ony2.feishu.cn/wiki/WgnfwNhjCi1VfkkU282chGBGn3b?sheet=oJO4Gi)revision `17173`及`钓具词条规则!B20:B21,B24,E24`只证明用户决策和原始公式，不得生成`FeishuSourceRevision`或发布策略。主工作簿`04_词条`（词条表）尚不存在对应机器规则，因此当前必须产生`REDUCTION_POLICY_SOURCE_MISSING`（不可waive的`BLOCKER / PUBLISH`）。

规则负责人必须把本节公式、规范DTO版本、旧字段映射版本、完整operation顺序和数值模型版本写入主工作簿的稳定机器区域。每条机器规则以`spreadsheetToken + sheet_id + ruleId + parameterKey`唯一定位；`ruleId`与`parameterKey`必须不可变且不得用行号、名称或合并单元格替代。完成写入与技术回读后，生效链固定为：用户显式拉取主工作簿→生成新FeishuSourceRevision→校验稳定键与完整策略字段→发布ReductionStackingPolicyVersion和RuleSetVersion→显式重算。在此链闭合前不得把revision `17173`伪装成运行时规则revision。

运行时、迁移器、校验器和回归测试的后续落地由GitHub Issue #41独立跟踪，不纳入本次决策规范PR。

### OPEN-002：性能定位派生语义（已决，待实现）

性能定位固定为只读`PerformanceSummary`：在Series/Model完成Technology、词条和最终属性结算后，按版本化统计定义输出“抛投+、重量-、竿度+”等标签、指标与证据。它不是Series核心字段、候选搜索输入、独立贡献层、评分乘数、硬不变量、兼容规则或Affinity轴，也不得反向改变价格。历史`PerformanceProfile/performanceId`只读保留并进入迁移复核；新规范化revision不再写入。未来若要让性能定位重新成为可编辑输入，必须作为新的产品变更重新修订本规范，不能借旧字段恢复。

### OPEN-003：扩展部位启用时间

2026-07-23产品决策：钩、漂、真饵和拟饵当前完全延期，未安排首批或后续启用顺序。此前讨论中的任何拟饵、钩、漂、真饵预排顺序均不生效。本次只收敛“当前是否启用”的产品决策，不为未来产品形态预设答案，也不代表仓库已经发布可校验的`enabledItemPartPolicy`版本；因此OPEN-003继续保持`DEFERRED_UI_DISABLED`，不能标记`RESOLVED`。Issue #17可在决策写入权威规范后关闭，但运行时策略的实现与发布必须由后续独立Issue提供证据。

当前确定边界：

- 注册表和迁移层可以保留四类部位的稳定ID、原始Payload和历史引用；不得删除、改名重绑或因未启用而丢弃历史数据。
- 不提供四类部位的产品只读入口、编辑草稿、候选生成、人工发布、Snapshot创建或配置导出。注册表中存在记录不等于已启用。
- 四类部位不进入现有`Collection/Series/SKU/Model`谱系。现有SKU只包含竿、轮、线；不得把部位专属规格伪装成`targetPullKg`，也不得进入最近结构模板匹配、钓具系列甘特图或现有Model候选生成。
- 当前不为四类部位定义参数模板、Method/Type、硬兼容、Affinity、Affix/Technology、品质、定价或配置映射，不得从竿轮线复制规则或补默认值。
- 所有角色均不获得四类部位的草稿、生成、发布或导出动作；dev、test及所有渠道均无先行启用。现有导出不得因注册表或历史数据存在而新增、修改或删除相关配置行。
- 竿、轮、线的生成、发布、ConfigurationSnapshot和导出行为保持不变。已发布Snapshot不得因本决策或未来扩展部位设计而被重算、改写或删除。

未来若启动任一部位，必须先为该部位建立独立产品设计Issue，至少确认：业务身份与生命周期、是否为购买或消耗对象、对象谱系、规则与数据源、UI工作流、权限、发布冻结、配置映射、先行环境/渠道、停止条件、回退方案，以及正常、边界、冲突、恢复和历史冻结验收。产品设计完成后，再按可独立交付范围建立实现Issue和PR；不得直接以OPEN-003作为实现授权。

当前验收：正常情况下主流程只显示并处理竿、轮、线；边界情况下注册表或历史迁移发现扩展部位只保留数据，不开启入口；收到扩展部位的草稿、生成、发布或导出请求时明确返回“部位未启用”，不得降级套用其他部位规则；发生迁移或禁用恢复时保留原始记录和稳定引用；任何恢复操作都不得改变既有Snapshot内容与hash。

### OPEN-011：工作区revision归档与裁剪启用

AUD-009已批准在线保留集合和一期全量保留边界，但归档、恢复、删除授权与自动裁剪启用仍是父Issue [#1](https://github.com/futouyiba/tackle-forger/issues/1)下的二期未决工作。当前可执行行为固定为：SQLite/D1保留全部完整workspace revision，不提供或调用人工/自动裁剪；Blob继续仅作最多100条的非权威评审存储；归档、恢复或裁剪异常全部fail-closed。第14.3节定义的是未来实现必须满足的安全约束，不代表对应能力已经存在或获准启用。

关闭本项至少需要同一个已发布`WorkspaceRevisionRetentionPolicyVersion`明确归档包格式与schema版本、包体上限、压缩/加密、归档保留期、恢复入口、RTO/RPO、团队共享与访问控制、容量/告警阈值、维护窗口、删除授权和自动裁剪启用标准；随后以目标Chromium环境完成归档写入与manifest/hash回读、隔离恢复、数据库完整性和不可变Snapshot/Patch/Trace hash验证，在隔离副本完成dry-run、首次裁剪、幂等重跑与回滚验收。首次生产裁剪必须另有明确授权；自动裁剪只能在首次生产裁剪及观察期通过后取得独立启用授权。任一参数、策略版本、恢复证据或授权缺失时，本项保持阻断且不删除数据。

### OPEN-004：Patch属性偏移阈值

2026-07-23用户确认OPEN-004采用“最终范围校验 + 整体批次人工复核”，不设置Series、SKU、Model或FinalReview作用域的独立绝对偏移、相对比例、方向性偏移或warning/review/block数值档位。Patch创建或修改后立即参与隔离的草稿试算，供设计人员查看整体属性、五维、兼容、不变量与范围校验；它不得仅因进入试算而影响已批准对象、正式配置或历史Snapshot。正式结果前，Patch必须作为对应Series/SKU/Model对象批次或发布批次整体结果的一部分被人工确认，但不要求逐Patch单独审批。2026-07-23对主飞书工作簿（YsEKw 历史观测 revision `3259`）的只读核对显示，`10_校验规则`（校验规则表）当前按部位类型、重量段和参数，以米、克、线径、传动比等业务原始单位表达最终合法范围，没有Patch偏移阈值列；该revision只是决策证据，不是永久运行常量。Workspace schema v16已发布并校验`patch-offset/open004-v1`，旧阈值只保留在迁移复核证据中且不参与运行，因此本项状态为`RESOLVED`。

#### 作用域、粒度与策略版本

本策略适用于`SeriesPatch`、`SkuPatch`、`ModelPatch`和`FinalReviewPatch`。Patch数值大小不决定是否需要被人工确认，Quality不参与范围选择或容差分档；但“需要被人工确认”不等于每个Patch revision都要单独执行一次审批动作。人工复核的操作单位可以是Series/SKU/Model对象批次或Snapshot发布批次，一次决定可以确认当前页面明确列出的多个对象及其完整Patch集合。

每次整体复核必须冻结批次作用域、对象revision、按顺序排列的`tuple(workspaceId, patchId, patchRevision, orderedOperationIds)`、`PatchSetHash`、累计最终值、范围校验与Issue引用、复核人和时间；Patch引用与hash输入遵循第14.2节同一工作区绑定和版本化契约。每个被覆盖的Patch revision都保存或可反查该复核证据。批次未列出的Patch不得借用该结论；复核后新增、修改、rebase或替换Patch，或者任何参与计算的输入发生变化时，受影响对象的旧复核证据立即`STALE`并重新进入整体复核。没有变化的其他对象无需因为同批中某个对象变化而逐一重审。

运行时仍必须引用已发布的版本化`PatchOffsetPolicyVersion`，以便确定性重放、审计和Snapshot冻结。该策略的规范语义固定为：

```text
mode = FINAL_RANGE_WITH_MANDATORY_REVIEW
offsetThresholds = NONE
rangeEndpoints = INCLUSIVE
```

策略版本只记录和冻结上述行为及其适用范围，不得重新引入未经权威规范确认的隐藏数值阈值。缺少有效策略版本时产生`PATCH_OFFSET_POLICY_MISSING`：草稿可以试算，依赖该策略的批准和发布保持阻断。

最终范围必须从当前已发布RuleSetVersion中按稳定规则解析。SKU和Model使用其真实离散SKU、ProjectionMatch及对应源重量段形成校验上下文；具体选择维度由相应参数约束定义，名称和Quality不得作为隐式关联键。

Series没有单一`weightBandId`。SeriesPatch必须展开为以下离散校验上下文，分别累计到Series层并逐一校验：

- 已存在SKU时，对Series下每个真实离散SKU分别使用其精确`targetPullKg`、ProjectionMatch和命中的源重量段；
- SKU尚未物化时，对Series声明的每个离散`targetPullKg`分别执行权威最近标杆匹配，并使用各自Projection和源重量段；
- 禁止选择一个代表性、默认或最重/最轻`weightBandId`代替整个Series，也禁止从最小/最大跨度推断连续中间重量。

每个范围校验Issue必须定位到唯一离散上下文，至少记录`scopeType`、`itemPartId`、`parameterKey`、标准单位、对象及revision、`skuRef`或尚未物化的精确`targetPullKg`、`projectionId`、命中的`weightBandId`、约束规则引用和版本。Series关口只有在全部离散上下文分别通过、确认WARNING或取得各自有效Waiver后才能通过；一个重量的结果不得覆盖或抵消另一个重量的Issue。

#### 计量、端点与累计

范围判断使用当前关口按确定性顺序累计后的最终属性值，不计算相对基底的绝对偏移、比例偏移或方向性幅度。所有数值先按`ParameterDefinition`归一到标准单位，再与最终合法范围比较；Patch仍保存before、operation、operand、after和完整Trace，用于解释与重放，但这些偏移不生成数值等级。

合法区间两端都包含：

```text
valid = min <= finalValue && finalValue <= max
```

等于下限或上限时合法；严格小于下限或严格大于上限时越界。范围内不因接近边界产生额外WARNING。Patch偏移本身不产生WARNING；WARNING只来自飞书或其他已发布规则明确配置的条件警告，并按第13、24节要求确认。

多个Patch及同一Patch内的多个操作严格按权威层级和`operationIndex`累计。范围校验针对当前关口完成后的累计值，不针对每个中间数值单独判定；操作本身存在类型、单位、允许操作或重放错误时仍立即产生完整性Issue。Series批准对每个真实或待物化的离散重量分别计算到Series层，不能依赖未来SKU或Model修正；SKU和Model关口分别计算到当前层；Model发布按第3.2节的完整顺序计算到FinalReviewPatch后再执行最终范围校验。

例如合法范围为`[8,12]kg`，基底为`10kg`，同一确定性链依次执行`+5kg`和`-3kg`，当前关口累计结果为`12kg`，范围校验通过；若Series关口结束时仍为`15kg`，则该关口产生范围越界Issue。

#### Severity、Gate与“保留意见通过”

累计最终值超出合法范围时产生：

```text
code = PATCH_FINAL_VALUE_OUT_OF_RANGE
source = patch
severity = ERROR
state = OPEN
gate = 当前命中的 REVIEW、PUBLISH 或 EXPORT
```

OPEN状态阻断命中的关口。只有以下条件全部满足时，该ERROR允许按版本化`WaiverPolicyVersion`由具备`validation.waiver.approve`能力的人工执行“保留意见通过”：

- `ParameterDefinition`、标准单位和允许操作完整；
- 基底对象、RuleSetVersion和revision完整；
- Patch操作合法，before、operation、operand、after可以确定性重放；
- Trace、input/output hash和PatchSetHash一致；
- 最终合法范围能够从已发布规则唯一解析；
- 唯一问题是累计最终值超出合法范围。

通过后Severity仍为`ERROR`，State变为`WAIVED`，界面固定显示“保留意见通过”，不得降级为WARNING或伪装成`ACKNOWLEDGED`。`ValidationWaiver.gate`保持单值；任何单份Waiver都不得跨REVIEW、PUBLISH和EXPORT复用，也不得从一个环境×渠道自动沿用到另一个导出目标。

一次人工“保留意见通过”可以作为一个原子`ValidationWaiverDecision`，批量批准当前页面明确列出的多份独立Waiver：REVIEW一份、PUBLISH一份，以及每个已选择环境×渠道各一份EXPORT Waiver。每份Waiver都必须引用自己的Issue fingerprint，并精确记录单一Gate；EXPORT Waiver还必须精确记录`environmentId + channelKey`。事务中任一目标在批准前重验失败时整组不生效，不得产生半组放行状态。后续新增环境、渠道或未包含的Gate必须重新请求人工决定，不能从既有REVIEW/PUBLISH/其他渠道Waiver派生或自动放行。

每份Waiver至少冻结`waiverDecisionId`、对象revision、`parameterKey`、实际值、合法范围、标准单位、RuleSetVersion、范围规则版本、Patch策略版本、PatchSetHash、理由、审批人、审批时间、单一Gate、环境与渠道（EXPORT时必填）及证据引用。Waiver不修改飞书合法范围，不自动适用于其他离散重量、对象或revision。ConfigurationSnapshot冻结命中REVIEW/PUBLISH的Issue与Waiver引用；每个ExportManifest只冻结与该环境×渠道精确匹配的EXPORT Issue、Waiver及共同`waiverDecisionId`，使越界配置在导出后仍可追溯。

以下情况说明结果本身不可信，必须产生不可waive的`BLOCKER`：参数定义或必需版本缺失；单位或类型不兼容；基底引用断裂；规则缺失、重复或冲突；操作不被允许；出现NaN或无穷值；无法确定性重放；before/after、Trace或hash不一致。BLOCKER永远不能通过“保留意见通过”放行。

#### 基底变化、Rebase与STALE

任何基底revision、RuleSetVersion、Patch、参数范围、对象revision或计算输入变化，旧ValidationIssue、人工复核结论和Waiver立即变为`STALE`，不得自动沿用：

- `add/multiply`在参数、类型和单位仍兼容时可以在新基底上确定性重放，但Patch最多回到`PENDING_REVIEW`；
- `set`在基底变化后进入`REBASE_REQUIRED`，由人工重新确认意图；
- `clear`在目标仍表示可继承覆盖时可以重放并重新复核；参数删除、重命名或必填性变化时进入`REBASE_REQUIRED`；
- `FinalReviewPatch`在任何上游变化后必须重新复核；
- 不能安全重放的Patch进入`REBASE_REQUIRED`或产生BLOCKER，不得静默跳过。

已发布ConfigurationSnapshot永远不被重算或改写；上游变化只生成UpgradeCandidate。旧“保留意见通过”不能自动沿用到新基底或新对象revision。

#### 迁移、Trace与Snapshot冻结

本策略生效后：

- 历史ConfigurationSnapshot、Patch引用、校验证据和hash保持不变；
- `DRAFT`、`PENDING_REVIEW`及尚未进入Snapshot的`APPROVED` Patch，在下一个批准或发布关口按新策略重新校验；
- 已被历史Snapshot引用的Patch revision不原地改写；用于生成新对象revision或新Snapshot时必须重新校验、复核并重新办理所需Waiver；
- 新Snapshot冻结Patch策略版本、参数范围规则版本、ValidationIssue、Waiver、有序Patch引用、PatchSetHash和累计Trace；
- ExportManifest冻结“保留意见通过”标记及其引用，避免越界配置脱离审批上下文；
- 策略、规则或账本迁移不得改变历史Snapshot内容或hash。

验收至少覆盖：Patch新增后立即影响草稿预览但不改变已批准对象、正式配置或历史Snapshot；一次整体复核可以确认多个Series/SKU/Model及其完整Patch集合，每个Patch revision均可追溯到同一批次证据且无需逐Patch操作；批次外Patch不能借用结论，批次内某对象Patch变化只使受影响对象的覆盖关系STALE；最终值等于上下端点时通过；中间值越界但当前关口累计最终值合法时通过；Series所有真实SKU和未物化`targetPullKg`分别命中自己的Projection/重量段且任一失败都会阻断Series关口；累计最终值越界且未获Waiver时阻断；一次人工决定原子创建单Gate及逐环境×渠道Waiver且不能跨Gate/渠道复用；新增导出目标要求新Waiver；范围越界ERROR取得匹配当前Gate的“保留意见通过”后可以发布或导出且保留标记，EXPORT还必须精确匹配目标环境×渠道；不可重放或规则解析失败时产生不可waive BLOCKER；基底变化后旧复核与Waiver变为STALE；新策略和新Patch不改变任何历史Snapshot内容或hash。上述回归由Issue #32及`tests/patch-offset-policy.test.ts`持续执行；任何后续策略版本仍必须满足同一门槛。

### OPEN-008：ConfigIdPolicy数字区间与命名规则

本项的公司治理语义已经确认，但在对应`ConfigIdPolicyVersion`发布，且其引用的`ConfigTargetCatalogVersion`中每个必需环境×渠道都有获批只读扫描Manifest前，状态保持`DECIDED_PENDING_POLICY_VERSION`，正式预留和配置提交继续fail-closed。TOML枚举固定通过可读`configNameKey`唯一解析数字ID，本项不得重新改为按数字ID直接配置。

#### 对象区间与作用域

每次为Model预留一个按部位分区的稳定`ConfigIdBundle`。Tackle与Item共享基础ID；GoodsBasic和StoreBuy由同一个基础ID确定性派生，不各自漂移游标。

| 稳定`rangeId` | 部位 | Tackle / Item共享ID | GoodsBasic ID | StoreBuy ID |
| --- | --- | --- | --- | --- |
| `rod_301800001_301899999` | 竿 `rod` | `301800001–301899999` | `10301800001–10301899999` | `30301800001–30301899999` |
| `reel_302800001_302899999` | 轮 `reel` | `302800001–302899999` | `10302800001–10302899999` | `30302800001–30302899999` |
| `line_303800001_303899999` | 线 `line` | `303800001–303899999` | `10303800001–10303899999` | `30303800001–30303899999` |

GoodsBasic ID按十进制字符串`"10" + baseId`派生，StoreBuy ID按`"30" + baseId`派生；禁止把前缀当成运行时可变渠道码。所有末三位为`000`的编号保留，不进入普通分配。区间为公司专属区间；外部未知对象一旦占用其中编号，必须登记为永久占用而不是覆盖。

`rangeId`是allocation pool的永久身份，不属于策略版本命名空间。后续`ConfigIdPolicyVersion`引用同一`rangeId`时，其部位、上下界、保留规则和派生规则必须逐字节等价；任何语义变化或扩容都必须创建新的`rangeId`。新`rangeId`的基础ID和派生ID空间不得与任何历史或当前`rangeId`重叠，重叠策略版本禁止发布。ledger游标、占用唯一约束和容量统计均跨策略版本绑定`rangeId`，`policyVersionId`只记录本次分配采用的审计规则，不得创建新游标或重置高水位。

同一个Model跨Snapshot、`dev`、`test`、`online`、`release`以及各渠道沿用同一套Bundle。环境和渠道不是ID命名空间，不能为同一个Model重复分配。首批人工导出环境为`dev/test/online/release`，各自绑定用户选择的本地Git worktree；每个环境的`1001`写入根目录`xlsx`，其他渠道绑定用户明确选择的目录。工具只负责生成、校验和写入人工导出目标，不负责后续Git合并、发布或部署。

“所有启用目标”只以配置治理负责人发布的`ConfigTargetCatalogVersion`为权威集合，不从用户本机绑定数量、`config_system.toml`或目录扫描结果反推。目录中的每个条目至少冻结`environmentId`、`channelKey`、仓库身份、分支/引用规则、仓库内逻辑目录、`config.toml`路径、是否为正式必需目标和目录版本审批信息；本机绝对路径与目录句柄不进入目录版本。用户可以自由选择本机worktree完成绑定，但绑定只满足访问授权，不能创建、启用或豁免正式目标。

每个必需条目必须有获批`ConfigTargetScanManifest`，至少记录目录版本、环境、渠道、仓库、authoritative ref名称、扫描时解析到的不可变commit、逻辑目录、`config.toml` hash、各workbook/sheet/hash、扫描器与规则版本、所验证`rangeId`集合、问题清单、结果hash、扫描人与复核人及时间。`ConfigIdPolicyVersion`必须冻结引用一个目录版本和覆盖其全部必需条目的Manifest集合；缺失、重复、失败、commit不可解析、Manifest所验区间不一致或未经`config.target.scan.approve`复核时禁止发布。目录新增或变更目标时发布新目录版本；新目标在新Manifest和引用它的新策略版本生效前只能做`NON_FORMAL`预览，不能正式预留或提交。工具仍不读取、修改或治理`config_system.toml`；权威目录由配置治理流程显式维护。

获批Manifest不是永久豁免。发布策略、每次正式预留、历史ID正式导入、生成正式人工搬运包和本地正式提交前，都必须重新解析目录条目的当前authoritative ref，并逐项验证当前commit、该commit中的`config.toml` hash和所有受管workbook hash与策略冻结的Manifest完全一致；远端不可读、ref不存在、commit变化、文件缺失或任一hash变化均产生`CONFIG_TARGET_SCAN_MANIFEST_STALE`并禁止动作。策略发布只执行本段的Manifest/ref/hash复验，不取得`ConfigTargetGovernanceLease`，也不以受保护ref CAS可用性作为发布门禁；治理租约范围只包括下文的正式预留、历史ID正式导入和正式导出。正式导出还必须验证本地worktree HEAD、逻辑目录、`config.toml`和workbook基线hash与同一Manifest一致，不能用“远端一致但本地脏”或“本地一致但远端已推进”绕过。

两次读取authoritative ref不是跨Git与ledger数据库的串行化机制。任何正式预留、历史ID正式导入或正式导出必须先取得配置目标治理协调器签发的独占`ConfigTargetGovernanceLease`，并在租约保护下完成Manifest复验和业务提交：

```ts
interface ConfigTargetGovernanceLease {
  leaseId: string;
  fencingToken: string; // 无前导零的正数BIGINT十进制字符串
  operationId: string;
  catalogVersionId: string;
  manifestSetHash: string;
  physicalRefs: {
    repositoryId: string; authoritativeRef: string; expectedCommitOid: string;
    targetEntryIds: string[];
  }[];
  targets: {
    targetEntryId: string; repositoryId: string; authoritativeRef: string;
    expectedCommitOid: string; configTomlHash: string; workbookSetHash: string;
  }[];
  state: "ACTIVE" | "COMMITTING" | "COMMITTED" | "ABORTED" | "RECOVERY_REQUIRED";
  expiresAt: string;
}
```

- 租约的锁身份是物理Git ref二元组`(repositoryId, authoritativeRef)`，不是逻辑`targetEntryId`。协调器先展开全部目标条目，再按该二元组去重；同一组所有别名必须解析并声明完全相同的`expectedCommitOid`，否则返回`CONFIG_TARGET_REF_ALIAS_CONFLICT`且不得取得任何租约或写入ledger。组内`targetEntryIds`按稳定顺序冻结作审计，各条目仍分别保留自己的逻辑目录和文件hash。
- 协调器对去重后的全部物理ref按`repositoryId`、`authoritativeRef`的逐字节稳定全序一次取得锁；任何只覆盖其中一个逻辑别名的操作也必须竞争同一个物理ref锁。协调器分配严格单调且永不复用的`fencingToken`，并冻结目录版本、Manifest集合hash、每个物理ref的expected commit OID和每个逻辑条目的文件hash；租约过期只能发放更高token，不能让旧操作继续提交。
- 每个authoritative ref必须由受保护写入协议治理，例如配置仓库写入网关、pre-receive检查或等价服务。任何推进ref的写入都必须携带当前治理租约与token，并以expected old OID执行CAS；`ACTIVE/COMMITTING`的读保护租约存在时，冲突写入必须等待或失败，过期token和old OID不匹配必须拒绝。仅靠分支命名、客户端约定或操作前读取不合格。
- 业务命令取得租约后重新解析全部物理ref和各别名的文件hash。数据库提交前，协调器必须以`leaseId + fencingToken + physicalRefs[{repositoryId, authoritativeRef, expectedCommitOid}]`原子CAS把租约从`ACTIVE`推进为`COMMITTING`；这一步与受保护ref写入共用同一协调状态，因此CAS成功后ref不能在业务事务提交前推进。数据库事务在实际提交点再次验证token仍为每个物理ref的最新值，并把`leaseId + fencingToken + manifestSetHash`写入ledger、导入或导出证据。
- 数据库提交成功后才把租约标记`COMMITTED`并释放；提交结果未知时进入`RECOVERY_REQUIRED`，先按`operationId/idempotencyKey`回读ledger和协调状态，禁止直接重放或让更高token越过。业务回滚则标记`ABORTED`且不得留下ID占用。
- 任一配置仓库ref无法接入受保护写入协议、协调器不可达、token连续性无法证明或ref写入存在绕过路径时，返回`CONFIG_TARGET_SERIALIZATION_UNAVAILABLE`并禁止正式动作。正式人工搬运包只标记`FORMAL_PACKAGE_DOWNLOADED_NOT_APPLIED`，其中冻结expected old OID；下游真正推进ref时仍须重新取得治理租约并执行CAS，下载本身不能占有长期租约或证明已经应用。

验收必须覆盖别名竞争：Given两个环境×渠道条目具有不同`targetEntryId`但共享同一`repositoryId + authoritativeRef`，When两个正式动作并发申请租约，Then它们竞争同一个物理ref锁且最多一个进入`ACTIVE/COMMITTING`；Given同组别名声明不同expected OID，When申请租约，Then返回`CONFIG_TARGET_REF_ALIAS_CONFLICT`，不发放token、不写ledger。只有逻辑目录不同而物理ref和OID相同的别名可以共存，其文件hash仍逐条复验。

Manifest失效后，旧`ConfigIdPolicyVersion`只保留历史审计用途，不再允许新预留或任何正式包/落盘；必须从当前authoritative ref重新扫描、复核Manifest并发布引用新Manifest的新策略版本。一次正式提交会改变workbook hash，因此提交结果必须记录post-write文件hash；待现有外部发布系统形成新的不可变commit后，再从该commit扫描和复核。在新Manifest进入新策略版本前，旧策略不得用于下一批正式预留或提交。已成功预留的Bundle仍永久保留，后续目标若外部占用同一ID则产生`RESERVED_ID_EXTERNAL_COLLISION`并隔离，不自动换号、复用或覆盖。

#### `configNameKey`格式与唯一性

| 对象 | 格式 |
| --- | --- |
| Tackle / Item | `tf_<part>_<stableModelKey>` |
| GoodsBasic | `store_tf_<part>_<stableModelKey>` |
| StoreBuy | `buy_tf_<part>_<stableModelKey>` |

`stableModelKey`是Model revision上的显式稳定字段，不从显示名、中文拼音、数据库ID或时间戳自动生成。没有该字段的Model必须先通过普通Model编辑创建新revision，再由用户基于该revision发起预留；界面可以给建议，但建议不构成保存或预留。规范化算法固定为：只移除首尾ASCII空白`U+0009–U+000D/U+0020`，再把ASCII`A–Z`映射为`a–z`，不做Unicode转写、字符替换、下划线折叠或截断。规范化结果必须满足`^[a-z][a-z0-9_]{0,39}$`，因此非空且长度为1–40字符；否则返回`STABLE_MODEL_KEY_INVALID`。

`part`只能是`rod/reel/line`。按表中模板拼接后的完整`configNameKey`最长64字符且必须满足`^[a-z][a-z0-9_]*$`。禁止随机后缀、静默截断和按环境/渠道加后缀。`stableModelKey`在正式预留前可以修改；名称与Bundle成功预留后一起冻结。业务需要改名或让新旧版本共存时创建新Model和新Bundle。

名称在每个逻辑表内唯一；`part + stableModelKey`在受管Model中唯一，且`ABANDONED`、`DEPRECATED`、`LEGACY_IMPORTED`、`EXTERNAL_OCCUPIED`等永久占用状态仍参加名称冲突检查。Tackle与Item的同名同ID配对是唯一允许的跨表重复；对任一TOML合法枚举目标集合，同名必须唯一解析到同一个数字ID。同名不同ID、同ID不同名或同名解析到多个数字ID均为阻断冲突。名称唯一性检查、Model唯一Bundle检查、四个对象ID占用、ledger记录和`rangeId`游标推进必须在同一个数据库事务内完成；并发重名只有一个请求成功，失败方返回`CONFIG_NAME_KEY_CONFLICT`并由用户选择新key，系统不得自动追加后缀。

#### Reservation ledger、生命周期与权限

全公司只使用服务端权威reservation ledger。普通设计用户可以预览候选；动作`reserve_config_id_bundle`要求`config.id.reserve`，其命令至少携带`modelId + expectedModelRevisionId + part + expectedNormalizedStableModelKey + policyVersionId + expectedManifestSetHash + idempotencyKey`。命令先取得覆盖策略全部必需目标的`ConfigTargetGovernanceLease`并完成Manifest复验；随后数据库事务必须先锁定Model head row，验证当前head revision等于`expectedModelRevisionId`、其part和规范化key等于命令期望值且尚无Bundle；任一不一致返回`MODEL_REVISION_CONFLICT`并且不锁游标、不写ledger。验证通过后才按策略声明顺序锁定稳定`rangeId`游标，跳过保留号，并以ledger中基础ID、两个派生ID、名称和Model的数据库唯一约束作为最终防线；禁止扫描Excel最大值后加一，也禁止回填ledger空洞。

同一事务必须在实际提交点验证治理租约仍为`COMMITTING`、token仍是全部目标的最新值且`manifestSetHash`与命令一致，完成名称与ID占用、ledger和幂等记录写入，创建冻结`stableModelKey + configIdBundleRef`的后继Model revision，并以条件更新推进Model head。事务失败不留下预留或半个Model revision，事务成功后永久占用并返回`reservedAgainstModelRevisionId + resultingModelRevisionId + ConfigIdBundle + leaseId + fencingToken`。Bundle存在后的所有Model revision必须原样继承冻结key与Bundle；任何修改key、part或Bundle引用的命令均拒绝。

幂等记录与Bundle在同一事务提交。命令先查幂等记录：相同完整payload的`modelId + idempotencyKey`重试必须返回第一次已提交的原Bundle、原/新Model revision和原审计结果，不重新执行当前revision或Manifest校验，也不推进游标；数据库已提交但响应丢失也遵守此规则。同一idempotencyKey携带不同Model、expected revision或规范化输入时返回`IDEMPOTENCY_KEY_REUSED`；同一Model已存在兼容Bundle时返回该Bundle，不再分配，输入与冻结身份冲突时返回`MODEL_CONFIG_IDENTITY_CONFLICT`。

- 成功预留但未使用的Bundle标记`ABANDONED`；已经导出后退役的Bundle标记`DEPRECATED`。二者都计入占用且永不复用，不提供管理员释放入口。
- 迁移和修订不得改变既有ID或名称。需要线上新旧并存时创建新Model；仅替换当前配置时仍更新原Bundle对应行，历史Snapshot保持不可变。
- `config.export.commit`只授权生成正式人工搬运包或写入用户已选择并授权的本地worktree。预留、导入、策略发布、Manifest复核和提交是否允许同一操作者，完全由当前有效`separationOfDutiesPolicy`决定；本节不为一期或1.5期写死豁免或强制分离。
- 配置治理负责人分别通过`config.id.policy.publish`、`config.target.catalog.publish`、`config.target.scan.approve`发布策略/目标目录和复核Manifest；历史纳管使用`config.id.legacy_import`，ledger元数据纠错使用`config.id.ledger.correct`。纠错不得删除已成功预留记录、推进或回退游标、释放编号、修改冻结ID/name或将编号转给另一Model。
- 审计至少记录操作者、时间、原因、Model、完整Bundle、原状态/新状态、策略版本、目标环境×渠道和关联revision/Snapshot。

容量按每个部位`rangeId`的可分配编号计算，`ABANDONED`、`DEPRECATED`和外部占用均计入。达到80%产生预警；达到95%产生严重预警并要求准备扩容，但已有区间尚未耗尽时继续分配；只有该部位全部可分配编号耗尽时才阻止该部位的新预留，既有Bundle的更新和导出不受影响。扩容只能通过新`ConfigIdPolicyVersion`追加新`rangeId`，不迁移旧ID、不重排或重建原游标、不回收历史空洞。

#### Upsert、分裂命中与多目标行为

每个环境×渠道独立读取实际目标表并以`ID + configNameKey`联合判断：

- ID和名称均未命中时新增；二者命中同一行时只更新工具负责的列；
- 只命中ID、只命中名称、二者命中不同行、同ID不同名、同名不同ID，或Tackle/Item/GoodsBasic/StoreBuy任一对象部分缺失，均视为分裂命中并阻止该目标；
- 不自动改名、换ID、补占未知行、合并重复行或删除历史行；冲突必须返回文件、sheet、行、ID、名称和可执行复核动作；
- 默认只隔离发生冲突的环境×渠道，其他已通过预检的目标可以继续；用户仍可在确认页选择“任一失败则全部不写”。

#### 历史与未知ID导入

首次接管和新增渠道时先生成只读扫描报告，不写Excel、不预留ID、不写ledger。人工复核只能选择：关联现有Model、登记`LEGACY_IMPORTED`、登记`EXTERNAL_OCCUPIED`、保持`EXTERNAL_UNKNOWN`不纳管。

- Tackle、Item、GoodsBasic、StoreBuy关系一致且业务归属明确的历史对象可登记`LEGACY_IMPORTED`，保留原ID和原名称。历史名称即使不满足新模板也按祖父条款保留，但不能成为新对象的命名模板。
- 归属无法证明且位于专属区间外的对象保持`EXTERNAL_UNKNOWN`，工具不得覆盖；位于本策略专属区间内的未知对象登记`EXTERNAL_OCCUPIED`并永久占用。
- 重复名称、重复ID、对象断链、部分命中、跨环境不一致或跨渠道不一致必须隔离到实际目标，未经人工选择不得自动推断。
- 文档示例、测试夹具、下载文件名和某次扫描结果都不是正式占用证据；正式导入必须记录源仓库、环境、渠道、commit、workbook、sheet和行。

`import_legacy_config_id`是正式写动作，不得把人工复核按钮直接转换为ledger记录。命令至少携带`scanFindingId + expectedReviewRevisionId + reviewDecision + modelId? + expectedModelRevisionId? + policyVersionId + catalogVersionId + expectedManifestSetHash + targetEntryId + expectedSourceCommitOid + workbook/sheet/row + expectedSourceRowHash + idempotencyKey`。执行固定为：先按完整payload查幂等记录；取得覆盖相关目标及策略全部必需目标的`ConfigTargetGovernanceLease`；从冻结commit重新读取源行并验证Manifest set、row hash和finding仍一致；再在一个数据库事务中锁定scan finding/review head、可选Model head和ledger唯一键，在实际提交点重验租约token，原子写入复核决定、`LEGACY_IMPORTED`/`EXTERNAL_OCCUPIED`占用或Model关联、幂等记录与审计。`EXTERNAL_UNKNOWN`不写占用ledger，但复核决定本身仍按相同revision和幂等契约持久化。

相同完整payload与idempotencyKey在响应丢失后重试必须返回第一次结果；同一key不同payload返回`IDEMPOTENCY_KEY_REUSED`。两个复核人对同一finding使用不同key并发决定时只允许命中expected review revision的一个事务成功，另一方返回`LEGACY_IMPORT_REVIEW_CONFLICT`且不得留下第二份占用；Manifest、source commit、源行hash或Model revision任一变化返回对应stale/conflict且不写ledger。基础ID、派生ID、名称、Model和finding的唯一约束是最终防线；任何冲突都保留扫描证据进入人工复核，不自动覆盖、合并或改号。

2026-07-23对内网`common/configs`的`dev@79b3ac1a`、`test@fe6b5f40`、`online@5c03518b`、`release@a2f4aa5c`四个分支中1001渠道的`tackle.xlsx`、`item.xlsx`、`store.xlsx`进行了只读实表扫描：上述候选区间占用数为0；同时发现`301200101 / rod_spinning01_1`等现行对象、`3015007 / rod_spinning05_worn`等历史短ID，以及`reel_spin208_7`重复名称，证明不能从最大值或名称形态推断治理状态。该扫描只用于支持区间决策；非1001渠道尚须逐一扫描，扫描完成和策略版本发布前不得正式启用分配。

验收至少覆盖：

- Given 两个并发请求争用同一部位游标，When 事务预留，Then 只产生两个不同且完整的Bundle，失败重试不留下半Bundle；
- Given v1已从某`rangeId`分配Bundle且v2继续引用同一`rangeId`，When v2首次分配，Then 继承原游标和全ledger占用，不重新发放v1的任何基础或派生ID；
- Given 预留事务已经提交但响应丢失，When 以相同`modelId + idempotencyKey`重试，Then 返回原Bundle且游标、占用数和审计记录不增加；
- Given 两个Model并发预留相同`part + stableModelKey`，When 提交，Then 仅一个事务成功，另一方得到`CONFIG_NAME_KEY_CONFLICT`且没有自动后缀或半Bundle；
- Given Model revision A的key为`alpha`且预留命令携带A，When 并发编辑先把Model head推进到revision B/key=`beta`，Then 预留返回`MODEL_REVISION_CONFLICT`且不消耗编号；Given 预留先锁定A并成功，Then 后续编辑不能改变冻结key或Bundle；
- Given 候选基础ID末三位为`000`，When 分配，Then 跳过该编号及其GoodsBasic/StoreBuy派生ID；
- Given 预留事务失败，Then 不产生占用；Given 事务成功后Model放弃，Then 标记`ABANDONED`且后续永不复用；
- Given 部位容量达到80%、95%和100%，Then 分别返回预警、严重预警但继续分配、仅阻止该部位新预留；
- Given 目录版本列出四个必需目标但只有三个获批Manifest，When 发布ConfigIdPolicyVersion，Then 返回缺失目标并阻止发布；Given 用户另外绑定一个未入目录的渠道，Then 该绑定不能补足门禁或执行正式提交；
- Given Manifest获批后任一authoritative ref推进且新workbook占用候选ID，When 请求预留，Then 返回`CONFIG_TARGET_SCAN_MANIFEST_STALE`，不推进游标、不写ledger，并要求重新扫描、复核和发布策略；
- Given 预留已完成最后一次ref读取但尚未提交ledger，When 外部写入尝试推进同一authoritative ref，Then 受保护协议必须拒绝或等待该写入；若ref已在租约CAS前推进则预留回滚，任何执行顺序都不得同时留下冲突ref与永久Bundle；
- Given 配置仓库允许绕过协调器直接推进authoritative ref，When 请求正式预留、历史导入或正式导出，Then 返回`CONFIG_TARGET_SERIALIZATION_UNAVAILABLE`且不写ledger、不生成可应用正式结果；
- Given 远端ref仍与Manifest一致但本地worktree的`config.toml`或workbook已修改，When 请求正式提交，Then 阻止写入且不允许用本地文件覆盖Manifest基线；
- Given 一批正式写入成功并改变workbook hash，When 使用原策略请求下一批预留或正式提交，Then 原策略因Manifest基线过期被拒绝，直到新commit完成扫描、复核并由新策略引用；
- Given `dev/1001`同ID不同名而`test/1001`完整命中同一行，When 多目标提交，Then 默认只隔离`dev/1001`并允许`test/1001`继续；
- Given 首次扫描发现专属区间内未知ID，When 尚未人工复核，Then Excel与ledger均不写；When 选择外部占用，Then 登记`EXTERNAL_OCCUPIED`并永久占用。
- Given 两名复核人基于同一finding并发提交不同历史导入决定，When 两个事务执行，Then 只有expected review revision匹配的一方成功，另一方返回`LEGACY_IMPORT_REVIEW_CONFLICT`且无重复占用；Given 成功响应丢失，When 使用相同幂等键重试，Then 返回原结果且ledger与审计不增加；Given Manifest或源行hash已变化，Then 导入失败且不登记`EXTERNAL_OCCUPIED`。

### 20.1 价值分自动定价与PricingPolicy

本节语义已经由2026-07-23用户决定，决策证据见`docs/audits/open-007-pricing-semantics-adr.md`。`OPEN-007`继续跟踪飞书机器源、schema、迁移和运行时落地，不再表示产品执行语义未决，也不得继续要求用户在阻断、封顶或性能乘数之间重复选择。

定价权威来源是主工作簿`07_品质评分`（品质评分表）与`08_价格计算`（价格计算表）的联合策略：品质评分表提供品质区间和品质内最小/最大价格系数；价格计算表提供业务公式、评分插值、重量段查表、零整比、货币、舍入和价格边界。两页必须按同一`FeishuSourceRevision`导入为一个`PricingPolicyDraft`，禁止跨revision拼接。

```text
维修价格(part)
= 维修消耗速度(pricingWeightBandId)
× 部位占比(part, pricingWeightBandId)
× 维修系数(part, Type)
× 全损时间(part, pricingWeightBandId)
× 评分插值系数(finalValueScore, Quality, PricingPolicyVersion)

购买价格(part)
= 维修价格(part)
× 购买系数(part, Type)
÷ 零整比(part, pricingWeightBandId, PricingPolicyVersion)
```

`维修系数`和`购买系数`来自`02_类型材质`（类型材质表）；当前竿、轮、线种子值均为`1`，仍须按普通版本化输入处理，不能在代码中省略。`pricingWeightBandId`默认取Model最近结构标杆所引用的源重量段ID，必须进入Trace，禁止按最终拉力重新做第二套隐式分段。定价查表直接按`pricingWeightBandId`与`partId`唯一定位，不再经过任何品质分组中间层；品质差异完全由各自的评分插值系数区间体现。

领域品质仍固定为`C/绿、B/蓝、A/紫、S/橙`；导入器必须通过版本化`QualityPricingMapping`显式记录每个品质在`07_品质评分`中的来源单元格，并对缺失或重复映射阻断。A与S即使落在同一重量段、同一部位，也通过各自的价格系数区间继续形成不同价格。

当前表中的业务公式是说明文本，查表参数是静态单元格值，不是可执行单元格公式。工具必须将其导入为`PricingPolicyDraft`后在领域内核中确定性计算，不依赖浏览器打开表格或飞书公式重算。每项定价Trace至少记录源revision、sheet_id、单元格/行键、输入值、查表命中、乘除步骤、未舍入值、舍入结果和警告。

YsEKw 历史观测 revision `2869`已经显式提供以下数值输入；其中与本节新决定冲突的说明文本只作为历史源证据，必须由后续飞书revision修订：

- 评分系数在所选品质区间内线性插值：`Lerp(minPriceFactor, maxPriceFactor, (finalValueScore-minScore)/(maxScore-minScore))`；
- 各重量段、部位的维修消耗速度、部位占比、全损时间和零整比；
- 货币单位为金币；数值源声明“三位有效数字向下取整”、最低价格100和价格阈值300,000,000；具体执行顺序、作用域和阈值确认动作按本节已决契约解释；
- 定价重量段策略为`MATCHED_STRUCTURAL_SOURCE_BAND`，沿用结构标杆命中的源重量段，不做连续插值。

“三位有效数字向下取整”的数值变换定义为：`step=10^(floor(log10(rawPrice))-2)`，`rounded=floor(rawPrice/step)*step`。执行顺序固定为：

```text
repairPriceRaw = 完整维修价公式
purchasePriceRaw = repairPriceRaw × 购买系数 ÷ 零整比
repairPrice = significant_digits_floor(repairPriceRaw, 3)
purchasePriceRounded = significant_digits_floor(purchasePriceRaw, 3)
purchasePrice = max(purchasePriceRounded, 100)
```

所有中间步骤保持未舍入精度；购买价必须使用`repairPriceRaw`，不得使用已经舍入的维修价。维修价与购买价只在各自最终输出阶段分别舍入。最低价格100只作用于购买价，并在购买价舍入后应用；不作用于维修价，也不对多个购买对象的汇总价再次应用。

新`PricingExecutionPolicy`至少显式表达：

```ts
interface PricingExecutionPolicy {
  repairRoundingStage: "final_repair_output";
  purchaseBasis: "unrounded_repair";
  purchaseRoundingStage: "final_purchase_output";
  rounding: "significant_digits_floor";
  significantDigits: 3;
  minimumPrice: 100;
  minimumPriceScope: "purchase_output_after_rounding";
  upperConfirmationThreshold: 300_000_000;
  upperThresholdBasis: "unrounded_purchase";
  upperThresholdAction: "require_acknowledgement";
}

interface PricingWarningAcknowledgement {
  acknowledgementId: string;
  issueId: string;
  issueFingerprint: string;
  modelRef: EntityRef;
  pricingPolicyVersion: string;
  inputHash: string;
  purchasePriceRaw: number;
  purchasePriceRounded: number;
  purchasePrice: number;
  threshold: 300_000_000;
  acknowledgedBy: string;
  acknowledgedAt: string;
  reason: string;
  state: "ACKNOWLEDGED" | "STALE";
}
```

旧`roundingStage/minimumPriceScope/overflowMode`只作为旧schema兼容输入保留。它们不能完整表达维修/购买双输出、购买价输入基底与软确认语义；迁移必须保留原Payload和旧策略版本，不得把旧`error/clamp`静默解释成新确认行为。

`purchasePriceRaw > 300_000_000`时产生统一`ValidationIssue`：`code=PRICE_UPPER_THRESHOLD_CONFIRMATION_REQUIRED`、`source=pricing`、`severity=WARNING`、`gate=PUBLISH`。它不是ERROR、BLOCKER或CLAMP：OPEN时要求用户在发布前二次确认；确认后状态为`ACKNOWLEDGED`，保留实际`purchasePrice`和`priceUpperThresholdExceeded=true`继续生成Snapshot及后续导出。确认是warning acknowledgement，不是waiver。

确认记录至少冻结Issue fingerprint、Model revision、PricingPolicyVersion、inputHash、`purchasePriceRaw/purchasePriceRounded/purchasePrice`、阈值、确认人、时间和理由。输入、Model revision、PricingPolicyVersion、任一价格或fingerprint变化后旧Issue/确认转为`STALE`，不得按相同code自动沿用。确认动作必须由服务端返回`acknowledge_price_warning`，要求`pricing.warning.acknowledge`能力，并在提交时重验Issue仍为OPEN且fingerprint一致。Snapshot冻结超限标记与确认引用；导出同一冻结Snapshot时验证引用和数值一致，不重复要求确认。若目标配置字段、Excel schema或游戏编译器无法表示实际价格，则另产生`source=config_relationship|data_integrity`、`severity=BLOCKER`、`gate=EXPORT`的不可确认问题；二次确认不能绕过数据表示能力。

PricingPolicyDraft只有在以下校验全部通过后才能发布：品质区间互斥且无空洞，S包含100且大于100报错；每个Quality恰有一条品质定价映射和一组价格系数；所有启用重量段×部位均能唯一查表；分母大于0；部位占比合法；不读取Performance评分输入；`PricingExecutionPolicy`完整且来源revision可追踪。飞书机器源、schema与运行时尚未落实本节新契约时，可以继续生成带`NON_FORMAL`标记的旧实现试算，但不得将其发布为符合新契约的PricingPolicyVersion。此前已经发布且输入版本完整的旧PricingPolicyVersion仍只服务其历史Snapshot，不重算。

正常路径：同revision导入07/08→校验并发布PricingPolicyVersion→以Model最终价值分和结构源重量段计算两个Raw价格→检查软确认阈值→分别舍入→对购买价应用最低价→确认必要WARNING→写入Snapshot和Store预览。边界：S的100合法而大于100报错；零整比不得为0；最低价只作用于舍入后的购买价；阈值比较使用未舍入购买价。冲突：跨revision、重复映射、缺查表、过期源边界或执行策略缺失阻止新策略发布。恢复：修复飞书后显式拉取并生成新Draft，旧PricingPolicyVersion、确认和已发布Snapshot不变。权限：规则拉取、策略发布、价格超限确认、Model发布和配置导出分别鉴权。

验收：Given B品质最终评分30、价格系数区间0.8至1.2，When插值，Then评分插值系数为1.0；Given A与S同重量段同部位，When计算，Then共享同一组查表基准但分别使用自己的价格系数区间；Given`repairPriceRaw=1234`且购买换算为1.5，When计算并分别舍入，Then维修价为1230、购买价使用未舍入维修价得到1850而不是1840；Given购买价舍入结果80，When应用最低价，Then最终购买价100且维修价不变；Given`purchasePriceRaw`超过300,000,000，When未确认，Then返回可执行确认的WARNING；When确认，Then保留实际价格与超限标记继续；Given随后Model revision或inputHash变化，Then旧确认STALE；Given目标字段无法表示该价格，Then独立EXPORT BLOCKER仍阻止写入。

### 20.2 OPEN-009：AI与发布工作流治理策略

OPEN-009于2026-07-23首次关闭，原统一策略版本`open009-2026-07-23-v1`冻结“公司飞书登录是产品入口门槛”的历史语义，不得原地改写。2026-07-27确认匿名本地会话与可选飞书登录后，发布后继统一策略版本`open009-2026-07-27-v2`；v2只替换入口与匿名本地能力边界，其余AI、发布、职责分离和操作记录结论继续继承本节明确引用的既有子策略版本。任何审计、Action或历史产物必须继续按其冻结的统一策略版本解析，不能把v1解释成v2。本节只定义Tackle Forger内部治理，不启用AI、不选择AI供应方、不接飞书审批，也不改变ConfigurationSnapshot不可变、显式拉取、确定性校验和配置关系校验。OPEN-006关闭后仍须通过独立实现Issue完成连接器准入，不能仅凭策略决策启用AI。

#### 20.2.1 分期与责任边界

一期允许内网可达的任何用户直接进入本地会话；飞书 OAuth 不再是产品入口门槛。未登录用户只能在浏览器内处理本地 Excel 或临时工作区，刷新即失，不能读取、保存、发布、导出正式产物、写回飞书或触发任何共享/外部副作用。需要共享工作区、飞书规则源或正式动作时，页面提供可选飞书登录；服务端仍按动作返回并校验 Capability。AI保持禁用；除 OPEN-006 的`ai.provider_policy.manage`仅授予部署管理员外，已认证用户拥有全部当前已启用业务 Capability；不设置其他业务角色、对象级权限、职责分离、代理人或应用内成员管理。飞书规则写回不接审批，关键写操作使用工作区单写锁。

1.5期只扩展OPEN-008确定的正式配置治理、目标Manifest和本地导出能力，继续沿用一期的全员统一Capability与无职责分离策略。

二期只有在OPEN-006关闭后才允许启用AI连接器。启用后继续采用全员统一权限，所有已登录用户均可运行AI、采纳建议和创建AI草稿。AI仍只能提供解释、建议和草稿，不能裁决规则、覆盖校验、直接写回飞书或发布产物。

当前规划中的三期不再引入细粒度RBAC、业务审核角色、职责分离或飞书审批。如果未来出现明确合规要求、团队规模变化或实际事故证据，必须另立Issue并发布新策略版本，不得静默改变本节结论。

Tackle Forger中的“发布”只表示发布内部RuleSetVersion、冻结ConfigurationSnapshot或把Excel配置提交到本机config Git工作区，不表示游戏配置已经正式上线。JSON编译、上传和正式发布的审核属于下游配置发布流程。

#### 20.2.2 `aiRefreshPolicy`

策略版本为`ai-refresh/open009-v1`。批量限制是该策略引用的独立已发布配置`ai-batch-limits/open009-v1`，当前值固定为：

```json
{
  "policyVersion": "ai-batch-limits/open009-v1",
  "maxAssessmentsPerBatch": 20,
  "maxConcurrentAssessmentsPerWorkspace": 8,
  "softConcurrentAssessmentsPerUser": 1,
  "softConcurrentAssessmentsPerWorkspace": 4,
  "softPerAssessmentWarningMs": 60000,
  "batchHardTimeoutMs": 600000,
  "maxEstimatedInputTokensPerBatch": 200000,
  "maxEstimatedOutputTokensPerBatch": 40000,
  "maxEstimatedCostMicroUsdPerBatch": 1000000
}
```

- 输入对象Revision、Patch、RuleSetVersion、五维定义或顶点、证据内容哈希、promptTemplateVersion或promptTemplateHash等参与`inputHash`的内容变化时，旧评估立即自动标记为`stale`；标记状态本身不得调用AI。
- 系统不得自动、定时或无人值守重新评估。已登录用户可以显式重跑单个评估，也可以明确选择范围后批量刷新。
- 批量刷新必须命中第23.6节的批量硬准入上限，并逐项保存结果；不得用后台全量扫描替代用户选择。交互软提示不能替代或越过批量准入、provider容量与租户费用硬上限。
- `maxAssessmentsPerBatch`在对象范围展开、权限过滤和按`scopeRef + revisionId`去重后计算；只允许`1..20`项，超过上限整体拒绝，不静默截断或拆成无人确认的后续批次。
- 并发硬上限按工作区计算，包含同一工作区所有批次和单次重跑；工作区达到8个在途请求时拒绝新派发。每用户1个、工作区4个和单项60秒只触发软提示、排队或用户中断选项，不会单独取消调用；Fancy Hub/provider实际硬上限更低时优先适用。
- 输入/输出token预算使用请求前确定性估算；连接器必须把输出上限传给供应方。费用统一按版本化供应方价格表换算为micro-USD，`1000000`表示每批最多1.00美元。价格版本缺失、币种无法换算、token或费用无法估算时禁止批量刷新；估算超过任一预算时整批在首次AI调用前拒绝。
- 批次达到10分钟硬期限后取消尚未派发项；已派发项按provider硬超时或实际结果逐项保存，不能继续启动新调用。不得用后台全量扫描替代用户选择。
- `ai-batch-limits`配置缺失、无已发布版本、字段非整数/非正数或版本不受支持时，服务端返回`AI_BATCH_LIMIT_POLICY_MISSING_OR_INVALID`并禁用批量刷新；页面默认值不得代替。未来改变任一数值必须发布新策略版本并把版本写入AssessmentBatch审计。
- `stale`评估保持只读，不能继续转换为Model Patch或RuleSourceChangeDraft。
- 三期仍不默认增加定时刷新；未来如需定时刷新，必须发布新策略版本。

#### 20.2.3 `aiModelRecordPolicy`

策略版本为`ai-model-record/open009-v1`。每次AI调用至少生成供应方与不可变模型描述、promptTemplateVersion、promptTemplateHash、调用人、作用域对象及Revision、input/output hash、证据引用、字段白名单与脱敏策略版本、请求时间、耗时、用量、费用、结果状态、建议、未覆盖信息、假设和采纳状态。保存时必须按第23.6节的字段级矩阵分层，不能把所有字段统称为“调用元数据”。

- provider、modelId、不可变modelRevisionDescriptor、promptTemplateVersion、promptTemplateHash、调用人、作用域引用、input/output hash、策略版本、时间、耗时、用量、费用和结果状态属于操作元数据，保留3年。
- 实际发送的白名单输入、完整提示、原始输出和请求级别名映射属于加密原始内容，保留180天。
- 结构化Finding、Recommendation、assumptions、uncoveredInformation、EvidenceRef和采纳/忽略反馈属于未采纳语义内容，保留1年。
- 被人工采纳的建议只把assessmentId、实际模型描述、选中建议、证据内容哈希、人工修改差异及其生成的Patch或规则草稿稳定引用随对应产物永久保留，不永久保留整份原始请求或回答。
- provider、上游训练/留存/地域、字段白名单、密钥禁发和Fancy Hub网关留存按第23.6节的`ai-provider/open006-v1`执行；OPEN-009不另设供应方约束。
- 飞书令牌、应用密钥和其他认证材料或密钥绝对禁止进入AI请求或记录；姓名等身份字段当前不进默认白名单，但不作为永久绝对禁区。

#### 20.2.4 `aiReviewPolicy`

策略版本为`ai-review/open009-v1`：

- 仅查看AI解释、比较或调整方向无需审批，也不影响批准、发布或导出资格。
- 将建议转换为Model Patch草稿或RuleSourceChangeDraft前，用户必须显式查看依据、假设、未覆盖信息和确定性差异预览。
- 输入已经`stale`、证据不足、目标Revision变化或建议与硬校验冲突时禁止转换草稿。
- 草稿保存前必须重新执行确定性计算与校验；AI输出不能改变硬兼容、ValidationIssue、Affinity、品质分或Snapshot值。
- AI只能创建草稿，不能创建approved Patch、确认飞书写回、执行拉取或发布产物。
- 同一名已登录用户可以完成采纳、复核和后续业务动作，但每一步必须是独立显式操作并分别记录。
- 批量采纳必须逐项展示作用域和差异；阻断、Revision不一致或作用域不一致的条目必须单独处理。

#### 20.2.5 `separationOfDutiesPolicy`与Capability

当前策略版本为`separation-of-duties/open009-v2`，模式固定为`disabled_in_tackle_forger`。历史`separation-of-duties/open009-v1`继续表示“只有符合内网与公司飞书登录条件的用户才进入产品、登录后全员统一Capability”，不得用于授权匿名本地能力：

- 一期、1.5期、二期和当前规划三期均不要求经办人与审核人、发布人或导出人为不同人员。
- 不设置Operator、Publisher、Auditor等业务角色，也不建设请假代理、临时授权、代审批或应用内成员管理。
- 内网匿名会话仅拥有不读写共享状态的本地临时能力；已认证用户统一获得全部当前已启用业务 Capability；未启用模块的 Capability 仍由功能开关关闭。第23.6节的 provider、模型降级、字段白名单、保留和软运行参数属于部署安全配置，只允许部署管理员修改，不属于全员业务 Capability。
- 服务端继续返回并校验Capability，前端不得绕过服务端或根据角色名猜动作；保留Capability适配器，以便未来通过新策略版本改变策略而不修改业务命令契约。
- 人员离职或需要停权时，在飞书账号、部署访问名单或服务端会话层撤销，并使现有会话失效。

#### 20.2.6 飞书审批与规则生效

一期、1.5期、二期和当前规划三期均不接飞书审批。规则修改继续使用以下链路：

```text
本地草稿
→ 影响预览
→ 人工确认写回
→ 技术回读验证
→ REMOTE_CHANGES_AVAILABLE
→ 用户显式拉取
→ RuleSet草稿校验
→ 用户显式发布RuleSetVersion
```

写回不等于拉取，拉取不等于发布。AI只能生成本地草稿，不能执行链路中的后续动作。

#### 20.2.7 工作区单写锁、失败恢复与轻量操作记录

系统不建设超级权限、强制解锁或复杂紧急流程。飞书规则写回与恢复、显式拉取、RuleSetVersion发布、Snapshot批次确认、配置文件正式写入与恢复等会改变共享发布状态的关键操作，必须取得工作区级单写锁。

工作区级单写锁是一期、1.5期、二期和三期的现行强制契约。资源级锁、依赖图推广、单节点拆锁或多节点协调只属于尚未排期的交付Phase 4规划，见[`architecture/future-concurrency-evolution-phase-4.md`](../architecture/future-concurrency-evolution-phase-4.md)。该规划不能作为提前缩小锁范围的依据；Phase 4真正启用前必须另立实现Issue，先更新本规范和策略版本，并完成入口门槛、迁移、故障注入、观察窗口与回退验证。

- 锁由系统自动取得和释放，不要求用户手工管理。持锁期间其他用户仍可读取、查看差异和执行不落盘的预览或AI评估，但不能保存状态变更。
- 前端必须显示锁持有人、正在执行的动作、开始时间和被禁用动作的原因。
- 每次取得或重新取得锁，数据库必须在同一事务中为该工作区分配严格单调递增、永不复用的正数64位有符号`BIGINT fencingToken`，并创建含`workspaceId/leaseId/holderUserId/action/fencingToken/acquiredAt/expiresAt`的租约。API、JSON、outbox和操作记录统一把token编码为无前导零的十进制字符串，禁止经过JavaScript `number`；比较时按数据库整数值而非字符串字典序。释放、超时、失败和数据库恢复都不得回退计数器或再次发放旧token；计数器达到`9223372036854775807`或无法证明其连续性时必须fail-closed并禁止新写入。
- 所有服务端共享状态变更、持久化事务、服务端可达副作用命令、恢复命令和最终成功证据都必须携带`leaseId + fencingToken`。服务端存储在实际写入点比较token是否仍等于该工作区最新授予值；仅检查“调用方看起来仍持锁”、只检查leaseId或只在请求开始时检查均不合格。旧token返回`STALE_FENCING_TOKEN`，不得提交服务端业务状态或标记成功。
- 飞书等服务端可达但不能原生校验token的外部副作用不得由请求线程直接执行，必须进入按工作区串行的持久化fenced outbox。worker在每项副作用开始前重验最新token；同一目标的低token结果处于超时/未知状态时，必须先按幂等键回读并确认结果或进入人工恢复，禁止更高token命令越过。服务端outbox不包含第25.2节的浏览器本地配置文件写入或下载变更包，也不得保存或索取浏览器IndexedDB中的目录句柄或本机绝对路径。
- 服务端外部调用返回后、写入成功证据前再次校验token。若调用期间租约过期且新token已经发放，旧操作只能向协调器报告未知结果，不能用旧token写入任何业务状态或成功证据；协调器必须以当前有效token追加`SUPERSEDED/RECOVERY_REQUIRED`回读证据并完成回读/补偿，再允许更高token继续。
- 浏览器本地配置写入由持有`FileSystemDirectoryHandle`的页面按第25.2至25.5节执行，不能由服务端worker代写，也不能声称fencing token能撤销或阻止已经交给本机文件系统的写操作。取得租约只授权本次正式写入并限定服务端成功证据：页面在开始写入、每个文件写入前及报告最终结果前向服务端重验`leaseId + fencingToken`，但文件一致性仍必须依靠基线hash/mtime、备份、恢复Manifest、逐文件回读和恢复事务。
- 浏览器本地写入期间若租约失效或出现更高token，即使部分字节已经落盘，旧客户端也不得提交成功证据。任一配置导出租约在没有已验证终态时过期、断线或取消，服务端必须先把`workspaceId + bindingId + environmentId + channelKey`对应逻辑目标置为`recoveryState=RECOVERY_REQUIRED`并记录`reason=EXTERNAL_FILE_CONFLICT`；不能因为客户端未回报就假定文件未变。后续只允许持有当前token的恢复操作先确认目录授权，必要时重新绑定，并回读全部目标文件，按Manifest恢复或前向协调且记录新hash；恢复完成前阻止该目标新的正式写入。
- 操作成功、失败或取消后自动释放；浏览器断开或服务异常时，通过心跳和短期租约自动过期，防止永久锁死。租约过期只允许发放更高token，不代表旧操作可以继续提交。
- 不提供绕过硬校验、Revision冲突、显式拉取、Snapshot不可变或配置关系校验的紧急通道。失败写入继续通过幂等键、回读、备份和恢复Manifest处理。

本工具只建设用于故障定位、恢复和结果复现的轻量“操作记录”，不建设独立合规审计系统。飞书写回/回读/拉取、RuleSet与Snapshot发布、AI调用与草稿转换、单写锁、配置写入/恢复、功能开关和会话撤销的成功、失败和取消都应记录。每条至少保存飞书用户稳定ID与显示名、时间、动作、对象与Revision、请求或幂等ID、必要的before/after hash、结果和错误原因。

普通操作记录保留1年，到期自动清理。RuleSet、Snapshot、Patch和导出Manifest中用于复现结果的来源关系随产物永久保留；AI原始内容和AI元数据分别按180天和3年策略保存。操作记录不能在界面修改或删除；当前不接外部审计平台，也不建设复杂审计报表。

#### 20.2.8 最低验收

- inputHash变化只把旧评估标记为stale，不触发AI调用；stale评估不能转草稿。
- 批量刷新必须由用户选择范围并受数量、并发和费用限制；没有无人值守刷新。
- 原始AI内容到期删除，但已采纳建议的assessmentId、人工差异和产物来源仍可追溯。
- AI建议与硬校验冲突时，硬校验保持不变且草稿转换被阻止。
- 任一已登录公司用户可以执行已启用业务动作；一期AI关闭时不能通过直接API绕过功能开关，普通用户也不能修改OPEN-006部署安全配置。
- 一期、1.5期、二期和当前规划三期均不存在飞书审批依赖，同一用户可以连续完成规则链路中的显式动作。
- 两名用户同时尝试关键写操作时只有一人取得锁，另一人仍可读取并看到明确的持锁提示。
- Given A持有token 41并在服务端可达的远端写入中卡住，When 租约过期且B取得token 42，Then A恢复后的任何服务端状态提交都返回`STALE_FENCING_TOKEN`；B不能越过A的未知远端结果，必须先完成幂等回读/恢复，最终同一目标不会出现A在B之后生效。
- Given 浏览器A用token 41写完第一份配置文件后断线且租约无已验证终态地过期，When 服务端处理过期并由B取得恢复token 42，Then 目标已是`recoveryState=RECOVERY_REQUIRED, reason=EXTERNAL_FILE_CONFLICT`且A不能再提交成功证据；B必须先确认或重新请求目录授权、逐文件回读并按Manifest恢复或前向协调，不能把本机写入伪装为outbox已隔离。
- 持锁客户端断开后租约可以自动过期并发放更高fencing token；服务端副作用通过幂等回读恢复，浏览器本地文件通过hash/mtime、逐文件回读和Manifest恢复，均不得伪装重复成功。
- 普通操作记录到期清理不改变历史Snapshot、Patch、RuleSet或导出Manifest的复现关系。
