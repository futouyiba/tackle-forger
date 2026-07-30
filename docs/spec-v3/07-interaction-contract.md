## 24. 交互与后端统一需求契约

本节把第23节和UX定稿转成开发可直接实现的领域/API契约。“钓具系列甘特图”只是Series、SKU Drawer和Model的查询/导航投影，不新增领域实体；“AI评估与建议”只是带证据的辅助层，不新增规则裁决层。

### 24.1 共同底座

```ts
interface EntityRef {
  workspaceId: string;
  entityType: "collection" | "series" | "part" | "sku_drawer" | "model"
    | "configuration_snapshot" | "model_candidate" | "adjustment_patch"
    | "upgrade_candidate" | "rule_source_change_draft" | "config_id_bundle"
    | "config_id_policy" | "config_target_catalog" | "config_target_scan_manifest"
    | "config_export_package";
  entityId: string;
  revisionId: string;
}
interface ActionAvailability {
  action: ActionCode;
  enabled: boolean;
  requiredCapabilities: CapabilityCode[];
  disabledReasonCode?: string;
  disabledReasonText?: string;
}
type LocalActionCode =
  | "open_local_excel"
  | "create_local_temporary_workspace"
  | "edit_local_session"
  | "clear_local_session";
interface LocalActionAvailability {
  contractVersion: "anonymous-local-actions/open009-v2";
  action: LocalActionCode;
  enabled: boolean;
  disabledReasonCode?: string;
  disabledReasonText?: string;
}
type CapabilityCode =
  | "series.read" | "series.edit" | "series.approve"
  | "part.read" | "part.edit"
  | "sku.read" | "sku.edit"
  | "affix.read" | "affix.create" | "affix.edit"
  | "model.read" | "model.edit" | "model.review" | "model.publish"
  | "candidate.generate" | "candidate.materialize" | "candidate.override_selection" | "candidate.dismiss"
  | "model.patch.create" | "model.patch.review" | "patch.rebase"
  | "patch.mirror.write" | "patch.mirror.pull" | "patch.mirror.inspect"
  | "patch.mirror.repair" | "patch.mirror.rebuild_from_local" | "patch.mirror.schema.repair"
  | "patch.subject.migrate"
  | "snapshot.read" | "snapshot.audit_archive.download" | "snapshot.export"
  | "ai.evaluate" | "ai.patch_draft.create" | "ai.rule_source_change_draft.create" | "ai.provider_policy.manage"
  | "feishu.rule_change.confirm_write" | "feishu.source.pull" | "ruleset.publish"
  | "config.id.reserve" | "config.id.policy.publish" | "config.id.legacy_import" | "config.id.ledger.correct"
  | "config.target.scan" | "config.target.scan.approve" | "config.target.catalog.publish"
  | "config.export.preview" | "config.export.commit"
  | "project.workbook.preview" | "project.workbook.commit" | "project.workbook.export"
  | "validation.warning.acknowledge" | "pricing.warning.acknowledge"
  | "validation.waiver.request" | "validation.waiver.approve"
  | "validation.recompute" | "rules.source_change_draft.create"
  | "rules.five_axis.publish" | "workspace.policy.manage";

type ActionCode =
  | "open_series" | "open_sku" | "preview_model"
  | "select_weight_band" | "create_sku" | "create_project_affix"
  | "add_sku_affix" | "remove_inherited_affix" | "restore_inherited_affix" | "copy_sku_local_affix"
  | "edit" | "review" | "publish" | "generate_candidates"
  | "materialize_candidates" | "override_candidate_selection" | "dismiss_candidate_run"
  | "create_patch" | "review_patch" | "rebase_patch"
  | "view_snapshot" | "download_snapshot_audit_archive" | "export_snapshot"
  | "write_patch_mirror" | "pull_patch_mirror"
  | "inspect_patch_mirror" | "repair_patch_mirror"
  | "rebuild_patch_mirror_from_local" | "fix_patch_mirror_schema"
  | "migrate_patch_subject"
  | "run_ai_assessment" | "create_ai_patch_draft" | "create_ai_feishu_draft" | "manage_ai_provider_policy"
  | "confirm_feishu_write" | "pull_feishu_source" | "publish_ruleset"
  | "reserve_config_id_bundle" | "publish_config_id_policy"
  | "import_legacy_config_id" | "correct_config_id_ledger_metadata"
  | "scan_config_target" | "approve_config_target_scan" | "publish_config_target_catalog"
  | "preview_config_export" | "commit_config_export"
  | "preview_project_workbook_import" | "commit_project_workbook_import" | "export_project_workbook"
  | "acknowledge_validation_warning" | "acknowledge_price_warning"
  | "request_validation_waiver" | "approve_validation_waiver"
  | "recompute_validation" | "create_rule_source_change_draft"
  | "publish_five_axis_definition" | "manage_workspace_policy";

```

配置身份治理、本节校验处置与Patch Rebase写动作固定映射为：

| ActionCode | requiredCapabilities |
| --- | --- |
| `reserve_config_id_bundle` | `config.id.reserve` |
| `publish_config_id_policy` | `config.id.policy.publish` |
| `import_legacy_config_id` | `config.id.legacy_import` |
| `correct_config_id_ledger_metadata` | `config.id.ledger.correct` |
| `scan_config_target` | `config.target.scan` |
| `approve_config_target_scan` | `config.target.scan.approve` |
| `publish_config_target_catalog` | `config.target.catalog.publish` |
| `preview_config_export` | `config.export.preview` |
| `commit_config_export` | `config.export.commit` |
| `preview_project_workbook_import` | `project.workbook.preview` |
| `commit_project_workbook_import` | `project.workbook.commit` |
| `export_project_workbook` | `project.workbook.export` |
| `acknowledge_validation_warning` | `validation.warning.acknowledge` |
| `request_validation_waiver` | `validation.waiver.request` |
| `approve_validation_waiver` | `validation.waiver.approve` |
| `recompute_validation` | `validation.recompute` |
| `create_rule_source_change_draft` | `rules.source_change_draft.create` |
| `rebase_patch` | `patch.rebase` |

读接口必须按当前对象、策略版本和操作者返回这些`ActionAvailability`；命令端再次校验Capability和`separationOfDutiesPolicy`。发布策略还必须校验其目标目录/Manifest覆盖，浏览器目录授权不能替代任何服务端权限。

`LocalActionAvailability`是`open009-2026-07-27-v2`发布的纯本地动作契约，由当前应用版本作为不可变客户端契约随静态资源一同提供，不依赖服务端、用户对象或网络响应，因此服务不可用时仍可确定性计算。它只可控制同一标签页浏览器内存中的本地Excel副本与临时态，不携带Capability、`EntityRef`或`commandPayloadRef`，也不得映射、升级或提交为任何`ActionCode`。只要动作会读取共享状态、调用服务器Action、修改导入源文件、写入SQLite、日志、IndexedDB/localStorage、发布、正式导出或触发外部副作用，就不属于`LocalActionCode`，必须使用服务端返回的`ActionAvailability`并在命令端重新鉴权。客户端可以按会话内存状态计算本地动作是否可用，但不能据此推断任何服务端动作；匿名本地运行时尚未实现前，不得用本契约声称功能已可用。

`project-workbook/v1`只使用三个服务端动作：`preview_project_workbook_import`解析并保存绑定工作区revision与各类hash的只读计划；`commit_project_workbook_import`只消费该计划的不可篡改payload引用与幂等键，并在执行时重新鉴权、重验计划后原子提交和回读；`export_project_workbook`从单一一致性revision生成机器Manifest与派生可读Sheet。三个动作分别要求`project.workbook.preview`、`project.workbook.commit`与`project.workbook.export`，互不蕴含；这三组ActionCode→Capability由`project-workbook-v1-root-manifest.json`逐项机器绑定，缺失、互换或复用Capability均为contract drift。预览返回`enabled=true`不能授权提交；导出文件不能作为客户端命令payload绕过服务端计划。直接提交工作簿、替换plan hash、跨工作区使用plan、计划过期或当前revision变化都必须拒绝；可解析的可变冲突按第15.1节`REPLAN_REHASH_AND_REAUTHORIZE`生成新计划，身份/冻结/引用/schema/工作区冲突不生成可提交payload。

预览解析必须先按根清单逐列验证Excel原始cell type；机器列仅接受非空文本并执行其`type/required/format`约束，不能让Excel数字精度、日期转换、布尔值、error cell或公式参与身份、revision、hash、JSON或opaque ref解析。普通payload number只要求RFC 8785可表示且有限；identity、revision、record key与safe-integer文本继续要求安全整数，`Infinity/NaN`一律拒绝。所有`display-text`入口必须共享同一closed helper，输入本身已是LF/NFC才接受：LF合法，CRLF、lone CR、非NFC别名、未配对surrogate与禁止控制字符均拒绝，禁止先normalize再放行。根清单、workbook schema与machine content三类hash必须从closed workbook context按各自唯一声明输入重算，不能只接受64位hex；machine content唯一编码为`RFC8785_ORDERED_SHEET_ROW_PAIR_ARRAY_V1`的有序`[[sheetName,rows],...]`，禁止对象、拼接、stream或重排替代；缺少上下文、表集合变化或任一Manifest/机器行篡改都先于计划生成而失败。preserved行必须取得由服务端按workspace/revision/root/key回读的closed expected context；candidate与trusted rows先按root/key去重并要求完整集合及schema逐项exact，再对canonical payload与content hash作固定长度比较及exact-equal。trusted遗漏、candidate额外、重复identity或错workspace/base均在`ROOT_SUMMARY`与machine hash验收前拒绝，MERGE/REPLACE都不能删除冻结行；candidate自重算不得冒充可信expected。`__TF_SERVER_REFS`是排除于语义hash但必须独立验证的transport sheet：每行按`project-workbook-server-ref-transport/v1`绑定workspace、base revision、root与classification，token只从这些公开身份字段确定生成，不得从raw/preserved/readback或敏感payload派生；伪造、错workspace/revision、缺根或重复根均阻断。15个importable root的successor目录必须把transport boundary与semantic mutation authority分开；`PUT /api/state`只描述运输，不授权任意字段替换。schema-derived来源扫描对`methodProfiles/itemTypeProfiles`的可信来源记录执行全字段exact；templates仍由`TEMPLATE_EDITOR_PATCH_LAYER`编辑普通字段但来源三元组exact；modifier/layer/affix的来源rule只冻结其来源三元组并禁止伪造或删除，普通规则仍由各自编辑器修改。缺失、partial、unknown或未来新增但未分类的source/provenance selector都在生成计划前拒绝。`affixScorePolicy`直接参与正式评分却没有工作簿安全successor，必须保持`server_owned`并拒绝工作簿增删改；engine scoring语义不变。`functionProfiles`是canonical source派生live聚合且没有独立安全successor，连同`compatibilityRules/affinityRules/purchasableModels/v3Affixes/technologies/qualityBands/ruleGraphs`均不得由工作簿生成create/update/delete；历史`ACTIVE`或无`status`形状不进入错误的lifecycle selector。固定品质继续只认C绿、B蓝、A紫、S橙。OPEN-002要求`seriesShowcases.performanceId`只作历史兼容：新记录不得携带，既有历史值只能exact-preserve，原本缺少时不得新增；该兼容条件不改变其他字段的既有编辑器或终态全冻结语义。`parameters`既有key不得通过工作簿重命名；`v23TechnologyDefinitions`新建必须使用清单化`create_technology` projection：稳定ID此前不存在、revision固定1，contentHash按生产`v23TechnologyContentHash`同一RFC 8785输入重算；create/update都必须输出含`expectedWorkspaceRevision`和完整production payload `inputHash`的closed action mapping，可直接进入`executeV23DomainAction`，既有revision不得原地改payload，update只由领域动作派生current+1。对existing importable记录，terminal lifecycle selector从record schema字段自动发现：selector字段始终exact，missing/unknown status拒绝；approved/published/superseded/deprecated/archived/frozen或存在合法`publishedAt`时整条allowed payload exact，不能用工作簿原地改写终态；当前只扫描真实可导入生命周期根`skuDrawers`与`seriesShowcases`。`forbidden`根只有固定遗漏标记，服务端不得把原始敏感内容或其可猜hash写入工作簿；diagnostic行必须内嵌closed canonical subject payload并独立重算subject key，即使subject ref为`null`也可验证。每个issue另以完整非派生closed envelope生成`issue_fingerprint`，主键加入该fingerprint：同subject/code的不同issue保留，完全重复issue拒绝，伪fingerprint拒绝；severity只接受`INFO/WARNING/ERROR/BLOCKER`。diagnostic message/severity只用于展示，不参与项目语义等价或提交计划hash。

预览还必须逐行验证`ROOT_SUMMARY`的93-root完整矩阵：分类与根清单一致，current/preserved/diagnostic根的record count和closed root hash可由对应记录重算，server-owned/forbidden根的record count严格为`0`且hash严格为`null`。匹配既有importable记录时，全部schema真实`identityFields`与`revisionFields`无论是否另列于`exactFields`都必须typed exact-equal；`$singleton`仅是固定行key sentinel，不读取payload field。单字段、复合、nested或optional path缺失、number/string替换或值漂移均阻断，新建记录不执行existing比较。所有非root primary-key component统一按Unicode scalar/code point逐个比较，共享前缀较短者在前；不得依赖JavaScript UTF-16 code-unit关系运算。

Series、Part、SKU、Model的ID终身稳定且不复用；改名和更换默认Model不改ID。SKU改换Part或weightBandId必须遵守第6.6节；派生拉力不是身份字段。Revision只增不改；已批准/已发布revision不可原地改写。Snapshot ID与payload/hash永久绑定。前端不得从角色名、状态或颜色猜服务端动作；读接口返回`ActionAvailability[]`，写接口再次鉴权，纯本地动作只消费上述`LocalActionAvailability`。

Technology 的F2 projection必须先以可信workspace/base及current-head回读调用清单绑定的successor validator：稳定ID不存在且revision=1才映射`create_technology`；可信head精确匹配、candidate revision=current+1、itemPartId不变且目标revision不存在才映射`update_technology`。两者还必须以`expectedAffixStateSha256`绑定服务端完整可信当前`v23AffixDefinitions`集合，并在projection前等价重放生产`validateV23TechnologyDefinition`：member非空、stable ID唯一、每个ref三元组唯一解析、enabled、同Part且无dedupe语义贡献冲突。仓库没有独立affix head表，禁止为工作簿另造head权威；集合hash或请求期望值漂移即stale并阻断。两者都重算生产`v23TechnologyContentHash`，action payload不得携带candidate `revision/contentHash`，update只增加`expectedTechnologyRevision`。closed action wrapper必须把`actionCode + actionPayload`直接映射到生产`executeV23DomainAction`；payload必须携带与request及trusted base逐值相同的`expectedWorkspaceRevision`，并按生产`v23ActionInputHash`对除`inputHash`外的完整payload计算RFC 8785 SHA-256。缺head、stale、重复target、缺失或伪造revision/hash、hash后payload变化、成员无效、换部位或错workspace/base全部拒绝，generic composite-key比较不能替代该判定。

### 24.2 R1：钓具系列甘特图

```ts
interface SeriesGanttQuery {
  text?: string;
  collectionIds?: string[]; partTypes?: string[]; fishingMethods?: string[];
  materialTypes?: string[]; functionProfiles?: string[]; actualQualityIds?: string[];
  lifecycleStates?: LifecycleState[]; attentionStates?: AttentionState[];
  issueSeverities?: ValidationSeverity[]; hasUpgradeCandidate?: boolean;
  weightBandIds?: string[];
  ruleSetVersion?: string;
  sort: "series_name" | "weight_span" | "attention" | "recently_changed";
  cursor?: string; pageSize: number;
}
interface GanttNodeAggregate {
  directLifecycle: LifecycleState;
  directAttention: AttentionState[];
  descendantStateCounts: Record<string, number>;
  modelCountTotal: number; modelCountMatched: number;
  blockingIssueCount: number; warningCount: number;
  upgradeCandidateCount: number; hasMoreChildren: boolean;
}
```

- 主矩阵纵轴使用01.x重量段显示顺序；横轴按Part组织，可附实际品质筛选，但品质不是Series统一身份。
- 每个Part把已选重量段按01.x顺序拆成一个或多个连续集合；相邻段合并矩形，缺段拆分，竿/轮/线不得跨部件合并。
- 覆盖块只表达展示连续性，不合并SKU数据。点击块后先选择具体weightBandId，再显示该段现有SKU和“新增SKU”。
- 同字段OR、不同字段AND；文本搜索当前工作区中的ID、名称、别名。
- 默认加载矩阵Series摘要；选中/展开Series覆盖块时，在底部摘要按重量升序加载真实SKU；展开SKU摘要时按展示顺序加载Model，使用服务端游标。
- 聚合区分总数和当前查询命中数；`modelCountMatched`只表达筛选结果，不表达对象权限或安全裁剪。
- 主状态优先级：硬冲突 > rebase > 待复核 > 警告 > 待发布 > 升级候选 > 已发布 > 草稿；全部计数保留。
- 点击Series/Part覆盖块只更新摘要；点击具体重量段执行只读`select_weight_band`并预览，只有用户显式执行`create_sku`才持久化。
- 矩阵空白、连续矩形和重量段标签均不创建SKU。
- 项目工作簿不能替代`create_sku`：其中出现服务端不存在的`skuDrawers`记录必须阻断；对既有SKU只允许修改`targetPullKg`，身份、revision、Series归属、Model/Patch引用、展示顺序、状态与时间字段均保持exact-equal。

正常路径：筛选矩阵，选中Series覆盖块，在底部摘要展开SKU与Model并打开预览。
边界：单SKU仍有一个真实节点；无SKU草稿Series显示未覆盖占位，不绘制虚假跨度。
冲突：翻页ETag变化使游标失效，不静默拼接新旧聚合。
恢复：保留筛选、矩阵滚动和选中Series刷新；节点移除则回最近仍存在的父级。

权限：按第20.2节使用全员统一的已启用Capability和功能开关；R1不得实现对象级过滤、对象级总数隐藏或部分谱系披露。功能未启用或Capability不可用时，服务端返回禁用原因且写接口再次鉴权。
验收：Given同一Part选择01.x第1、2、4段，When查看甘特图，Then第1/2段合并、第4段独立；When点击合并块，Then必须再选择第1或第2段后才显示该段SKU，且没有自动创建。

### 24.2.1 Part编辑、重量段SKU预览与词条动作

```ts
interface PartDraft {
  partId: string;
  partType: "rod" | "reel" | "line";
  fishingMethod: string;
  materialType: string;
  functionProfile: string;
  functionIntensity: number;
  defaultEntryIds: string[];
  technologyIds: string[];
}

interface WeightBandSkuPreview {
  partRef: EntityRef;
  weightBandId: string;
  match: FunctionTemplateMatch;
  existingSkuRefs: EntityRef[];
  createSkuAction: ActionAvailability;
}
```

Series编辑区同时展示1～3个Part卡片，每张卡独立编辑全部字段。保存Part后，服务端对其已有SKU重新匹配和重算；零/多匹配返回失效SKU列表而不猜测。SKU词条区分别提供增加已有词条、屏蔽/恢复继承词条、复制为局部副本后修改、挂载Technology，以及“新增词条”完整编辑浮窗。所有写动作绑定expected revision、输入hash和幂等键；“新增词条”创建项目级完整定义，不创建占位引用。

### 24.3 R2：稳定标识、面包屑和权限

```ts
interface BreadcrumbItem {
  ref: EntityRef; label: string;
  objectLabel: "Collection" | "Series" | "Part" | "SKU 抽屉" | "Model" | "冻结快照";
  current: boolean; navigable: boolean; unavailableReason?: string;
}
```

Schema v23谱系固定为`Collection? → Series → Part → SKU Drawer → Model → ConfigurationSnapshot`。SKU显示重量段与“SKU抽屉”，Model显示型号与“Model”。Collection可缺省，其他父链不可缺失；v9/v22历史对象没有Part父级时按冻结旧谱系只读回放，不补造Part。跨父级移动是受审计迁移命令并重验不变量。只删除未引用草稿；其余只能废弃。从Snapshot返回Model默认定位快照对应revision。对象关联使用稳定entityId、revisionId、业务代码与GenerationBinding；name只能用于展示、检索和人工候选提示，不能作为唯一关联键。

正常路径：逐层导航且身份标签稳定。
边界：无Collection从Series开始；多Snapshot显式选版本。
冲突：父链与不变量不一致产生数据完整性error。
恢复：返回有效父级/迁移审计/修复引用，不自动猜父级。
权限：read/edit/review/publish继续映射为独立Capability和`ActionAvailability`，但当前策略把全部已启用Capability统一授予所有已登录公司用户，不按对象、父级或业务角色裁剪。
验收：Given 已登录公司用户深链接打开Model或Snapshot，When 服务端解析对象，Then 返回完整稳定父链；写动作只因功能开关、领域关口、revision或当前Capability未启用而禁用，并显示服务端原因，不产生“仅披露部分父链”的对象级权限分支。

### 24.4 R3：“生成 Model 候选”

```ts
interface CandidateGenerationRequest {
  requestId: string; seriesRef: EntityRef; skuRefs: EntityRef[];
  recipeRef: EntityRef; recipeInput: Record<string, unknown>;
  enabledVariantKeys: string[]; perSkuLimit: number;
  minimumAffinity?: number; acceptWarnings: boolean;
  sortDefinitionVersion: string;
  inputHash: string; idempotencyKey: string;
}
interface ModelCandidate {
  candidateId: string; runId: string; skuRef: EntityRef;
  candidateFingerprint: string;
  functionTemplateRef: string;
  functionTemplateInputFingerprint: string;
  proposedConfiguration: Record<string, unknown>;
  hardCompatibility: HardCompatibilityResult; affinity: AffinityBreakdown;
  invariantIssues: ValidationIssue[]; rank: number; rankReasons: string[];
  state: "generated" | "shortlisted" | "selected" | "discarded" | "expired" | "superseded";
}
```

v23输入冻结Series/Part/SKU/Recipe/RuleSet/Patch revision及SKU的04.5引用/输入指纹。deny/缺require只进排除统计。权威排序为版本化字典序：配方键→warning数→Affinity降序→fingerprint；04.5已经由六键唯一定位，不得再以拉力距离消歧，AI不得改写。结果含排除分组、枚举总数、截断、版本、hash、耗时。CandidateRun是不可变审计产物，候选不是Model。v9/v22历史CandidateRun继续冻结并读取`projectionMatchRef`与旧排序版本，不迁写为v23形状。

默认行为是自动物化：对每个`SKU × enabledModelVariantKey`选取排名最高的合法候选并创建或更新一个Model草稿revision。用户可通过范围、重量、启用路线、每SKU数量、最低Affinity、warning接受和`REVIEW_ON_CHANGE`检查点克制批量生成。若`skuId + modelVariantKey`唯一命中旧Model，则创建新revision；无命中新建；多重或歧义命中则跳过并报Issue，禁止按name猜测。内容hash未变化时不创建空revision。同输入、版本与算法必须产生相同结果和顺序，正常流程不使用random seed。

正常路径：预览输入、生成、确定性排序并自动创建/更新Model草稿。
边界：0结果显示排除统计；截断明确提示。
冲突：运行中revision变化则superseded且不可选择。
恢复：复制最新输入重跑；凭requestId恢复/重试。
权限：generate与materialize分离，自动物化也必须由服务端重新鉴权。
验收：Given 高Affinity候选命中deny，When 完成，Then 只在排除统计；合法低分候选仍可展示。

### 24.5 R4：统一Trace

```ts
interface CalculationTraceEntry {
  traceEntryId: string; subjectRef: EntityRef; parameterKey: string; sequence: number;
  layer: "weight_template" | "method" | "type" | "function"
    | "quality" | "boundary" | "attribute_affix" | "technology_affix"
    | "series_patch" | "sku_patch" | "model_patch" | "final_review_patch"
    | "rule_suppression" | "projection_pin";
  sourceRef: EntityRef | { sourceType: string; sourceId: string };
  sourceVersion: string; ruleSetVersion: string;
  before: unknown; operation: string; operand: unknown; after: unknown; unit?: string;
  effect: "benefit" | "cost" | "neutral" | "contextual";
  warningIssueIds: string[]; actions: ActionLink[];
  inputHash: string; outputHash: string;
}
```

Trace由内核按sequence产生/重放；`sequence`是单次确定性计算Trace中的全局且唯一的执行序号，跨subject和parameter共享同一序列，持久化和查询不得按对象分组后重新编号；作用域投影可以保留原序号并出现间隙。前端不重算。formula携带formulaId/version和结构化操作数。Technology只记录成员Affix贡献。`PerformanceSummary`拥有独立的派生证据，不伪装成修改属性的Trace层。无贡献层返回no_effect摘要，不伪造执行。警告引用Issue，动作来自服务端。Snapshot冻结Trace或内容寻址引用/hash。

展示例外（MOTION-03）：当且仅当同一冻结`CalculationTraceEntry`的`before`和`after`都是有限数，前端可以临时显示`after - before`作为视觉 delta。该值不得持久化，不得进入任何领域结果、hash、重放、Snapshot、校验或动作决定，也不得用于补全或解释规则语义。非数值值以及`set/clear/min/max/no_effect`等语义操作必须原样显示`before/operation/operand/after`，不得伪造数值 delta。

正常路径：逐层查看来源和四段数值。
边界：枚举/区间/非数值set使用类型化值；缺单位不猜。
冲突：重放hash不符产生`TRACE_REPLAY_MISMATCH`并阻止发布。
恢复：同版本重放；源缺失保留payload进入归档修复。
权限：可看脱敏贡献但无权来源跳转禁用。
验收：Given 多层修改一个属性，When 打开Trace，Then 顺序、版本、before/operation/operand/after、警告、动作均由后端返回。


### 24.6 R5：五维图

```ts
interface FiveAxisAxisDefinition {
  axisId: string; label: string; order: number;
  sourceParameterKeys: string[]; applicablePartIds: string[];
  direction: "higher_better" | "lower_better" | "target_range" | "contextual";
  transformId: string; vertexSelectorId: string;
  componentAggregationId: "per_component_no_aggregate";
  missingPolicy: "error" | "unavailable" | "ignore_not_applicable";
}
interface FiveAxisViewDefinition {
  definitionId: string; version: string;
  semanticContractVersion: "five-axis/open005-2026-07-23/v1";
  hashInputSchemaVersion: "five-axis-hash-input/v1";
  projectionReferenceSelectorVersion:
    | "projection-reference/current-sku-frozen-match/v1"
    | "projection-reference/v23-function-template-frozen/v1";
  axes: [FiveAxisAxisDefinition, FiveAxisAxisDefinition, FiveAxisAxisDefinition, FiveAxisAxisDefinition, FiveAxisAxisDefinition];
  weightBandPolicyVersion: string;
  displayBandConfigId: string;
  seriesBaselinePolicy: {
    mode: "projection_reference";
    selectorVersion:
      | "projection-reference/current-sku-frozen-match/v1"
      | "projection-reference/v23-function-template-frozen/v1";
  };
  comparisonPolicy: {
    minimumItems: 2;
    maximumItems: number;
    mixedItemPartsAllowed: true;
    referenceRodMode: "first_rod_by_comparison_order";
    outerRingScore: 100; visualOverflowCap: null;
  };
}
```

线上Schema必须把`maximumItems`校验为大于等于`minimumItems`的整数，不得在API类型中声明为字面量`5`。当前已确认定义实例为`minimumItems = 2, maximumItems = 5`；服务端对该定义强制上限5。未来只能通过新`FiveAxisViewDefinition.version`发布其他合法整数，历史定义、Snapshot和评审记录仍保留5。`publicationState=PUBLISHED`不是正式适用性的充分条件；新正式Snapshot还必须按第21.7节验证三项契约版本并解析到唯一`FORMAL_CURRENT`处置。v23正式定义的两个selector字段必须逐字相同且为`projection-reference/v23-function-template-frozen/v1`；旧selector只允许历史v9/v22 Snapshot。

正式视图恰好五轴，顺序为拉力、耐久、抛投、感度、操控；定义仍通过版本发布和引用，不得散落硬编码。同图共享definition、W重量段、`weightBandPolicyVersion`和`vertexSetHash`。每点返回direct/context_inherited/not_applicable/missing/error、原始值、未封顶比例、comparisonScore、officialDisplayScore、Trace和来源。not_applicable不画0，分母非正永远error。Series基准按第21.3节唯一选择器返回锚点、selectorVersion、`projectionReferenceSetHash`及竿轮线三个逐部位状态；v23返回`partId + weightBandId + functionTemplateRef/revision + 输入指纹`，v9/v22历史回放返回projectionMatch/projection ID与revision。两种形状不得混装，均禁止聚合、按查询顺序择一或静默回退。

正常路径：以最终拉力确定W段，按发布定义计算三条部件曲线与三条Series结构投影参考线，并提供数值表。
边界：某部位无结构投影时只省略对应参考线；轮线无参考竿时抛投为not_applicable；均不得画全0。
冲突：规则版本、顶点hash或投影引用锚点不兼容时拒绝伪装为同一Series基准；legacy-only定义不得服务新正式Snapshot。
恢复：发布唯一`FORMAL_CURRENT`定义、有效顶点集合或重新选择显式基准Snapshot；历史Snapshot仍用冻结版本。
权限：发布定义需rules.five_axis.publish；临时比较不改变Series或Snapshot。
验收：Given两件装备来自不同W段，When选择共同W段比较，Then二者使用同一顶点集合；Given comparisonScore为123.7，When绘图，Then节点伸出100分外圈而officialDisplayScore仍为100；Given v23同Part同段有多个SKU，When读取Model Snapshot，Then只使用该Snapshot冻结的partId、weightBandId、functionTemplateRef与后继选择器，不读取其他SKU；历史v9/v22 Snapshot继续按冻结ProjectionMatch重放且hash不变。

### 24.7 R6：AIRecommendation

```ts
interface EvidenceRef {
  evidenceType: "trace" | "validation_issue" | "hard_compatibility" | "affinity_axis"
    | "series_invariant" | "five_axis" | "rule" | "snapshot" | "user_note";
  refId: string; revisionId?: string; anchor?: string; contentHash: string; excerpt?: string;
}
interface AIRecommendation {
  recommendationId: string; assessmentId: string; scopeRefs: EntityRef[];
  title: string; summary: string; evidence: EvidenceRef[];
  assumptions: string[]; uncoveredInformation: string[];
  impactedParameters: { subjectRef: EntityRef; parameterKey: string; before: unknown; proposedAfter?: unknown; unit?: string }[];
  suggestedAction: "preview_only" | "create_model_patch_draft" | "create_rule_source_change_draft";
  suggestedPatch?: SuggestedPatchPayload;
  generatedAt: string; inputHash: string; ruleSetVersion: string;
  fiveAxisRuleVersion?: string; promptTemplateVersion: string; promptTemplateHash: string;
  modelDescriptor: AIModelDescriptorV1;
  state: "fresh" | "stale" | "accepted" | "dismissed" | "superseded";
}
```

每条建议至少一个证据；推测进assumptions。影响对象/属性显式；无作用域只能preview_only。任一输入revision、Patch、规则、五维定义、证据hash、promptTemplateVersion或promptTemplateHash变化即stale。AI不进入面板、品质、Affinity、Issue裁决、Snapshot值。刷新、模型版本记录、审核权限保持策略化。

正常路径：白名单数据生成带证据建议。
边界：证据不足只返回未覆盖信息。
冲突：AI与确定性校验冲突时以后者为准并显示护栏。
恢复：重新评估；旧建议只读且不可转草稿。
权限：evaluate、patch draft、Feishu draft独立；AI只读调用者有权数据。
验收：Given AI建议降低硬冲突，When 展示，Then 硬冲突不变且建议无覆盖动作。

### 24.8 R7：AI转Model Patch草稿

命令含recommendationId、assessmentInputHash、targetModelRef、selectedChanges、userReason、idempotencyKey。目标只能是未冻结Model。确认页展示作用域、before、operation/operand、确定性after、五维/Issue/Affinity/不变量差异；后四者由内核重算。保存draft并记录AI来源、创建人、理由与人工改动差异。stale、revision变化、非法operation、冻结时禁用。

正常路径：确认差异后建草稿并人工审核。
边界：部分参数移除时要求剔除，不静默忽略。
冲突：已有未决set进入合并/rebase。
恢复：保留表单，刷新before重算再确认。
权限：model.patch.create与review仍是独立Capability和审计动作，但当前统一策略允许同一用户连续执行。

验收：Given 建议后Model变化，When 创建，Then 阻止旧before并要求确认新差异。

### 24.9 R8：AI转飞书规则修改草稿

```ts
interface RuleSourceChangeDraft {
  changeDraftId: string;
  originRecommendationId?: string;
  sourceObjectRefs: EntityRef[];
  targetRuleRef: {
    spreadsheetToken: string;
    sheetId: string;
    stableRuleId: string;
    parameterKey: string;
    sourceRevision: string;
  };
  proposedChange: Record<string, unknown>;
  evidenceRefs: EvidenceRef[];
  impactPreview: {
    evaluatedRuleSetVersion: string;
    affectedSeries: number;
    affectedSkus: number;
    affectedModels: number;
    newErrors: number;
    resolvedErrors: number;
    sampleDiffRefs: string[];
    publishedSnapshotsChanged: 0;
    upgradeCandidatesExpected: number;
  };
  state: "LOCAL_DRAFT" | "IMPACT_PREVIEW_READY" | "NEEDS_REBASE"
    | "CONFIRMED" | "WRITING" | "WRITE_VERIFIED" | "WRITE_FAILED"
    | "REMOTE_CHANGES_AVAILABLE" | "PULLED" | "ABSORBED"
    | "PARTIALLY_ABSORBED" | "SUPERSEDED";
  idempotencyKey: string;
}
```

飞书电子表格是唯一规则源，一期、1.5期、二期和当前规划三期均不引入飞书审批。AI只能生成`LOCAL_DRAFT`，不能确认写入、执行写入、拉取或发布RuleSet。人工确认后直接写回飞书表格，并立即技术回读验证；写回成功只表示远端有变化，绝不自动激活规则。用户必须显式点击“拉取”，生成FeishuSourceRevision和RuleSet草稿，通过校验后再显式发布RuleSetVersion。

影响预览使用沙盒RuleSet，Snapshot变化恒为0，潜在变化转UpgradeCandidate。写入前比较sourceRevision，变化则进入`NEEDS_REBASE`。写入超时先回读目标单元格和写回日志，以幂等键确认是否已经成功，禁止重复追加。

正常路径：本地草稿→影响预览→人工确认写回→回读验证→远端变化可拉取→显式拉取→发布RuleSetVersion→重算吸收。
边界：无法完整重算时显示覆盖率，抽样不冒充完整。
冲突：源revision变化进入NEEDS_REBASE；部分参数吸收时保持PARTIALLY_ABSORBED。
恢复：WRITE_FAILED保留草稿、幂等键和回读结果，可安全重试；不删除DerivationLayerPatch。
权限：AI草稿、确认写回、拉取、RuleSet发布分别鉴权和记录；当前统一策略允许同一用户连续执行，不额外增加审核策略。

验收：Given 写回请求超时但远端单元格已更新，When 回读恢复，Then 进入WRITE_VERIFIED而不重复写；未点击拉取前运行规则版本保持不变。

### 24.10 R9：ValidationIssue与ActionLink

```ts
interface ValidationIssue {
  issueId: string; fingerprint: string; code: string;
  source: "hard_compatibility" | "affinity" | "series_invariant" | "patch"
    | "publish" | "data_integrity" | "import" | "five_axis" | "ai_guardrail"
    | "config_identity" | "config_relationship" | "quality" | "pricing";
  severity: "INFO" | "WARNING" | "ERROR" | "BLOCKER";
  gate: "NONE" | "REVIEW" | "PUBLISH" | "EXPORT";
  subjectRef: EntityRef; affectedRefs: EntityRef[]; parameterKeys: string[];
  title: string; message: string; evidenceRefs: EvidenceRef[]; ruleRefs: string[];
  state: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "WAIVED" | "STALE";
  waiverRef?: string;
  actions: ActionLink[];
}
interface ValidationWaiver {
  waiverId: string; waiverDecisionId: string; issueFingerprint: string;
  policyVersion: string; gate: "REVIEW" | "PUBLISH" | "EXPORT";
  environmentId?: string; channelKey?: string;
  scopeRef: EntityRef; reason: string; approvedBy: string; approvedAt: string;
  expiresAt?: string; evidenceRefs: EvidenceRef[];
}
interface ValidationWaiverDecision {
  waiverDecisionId: string; scopeRef: EntityRef; reason: string;
  requestedWaivers: {
    issueFingerprint: string; gate: "REVIEW" | "PUBLISH" | "EXPORT";
    environmentId?: string; channelKey?: string;
  }[];
  approvedBy: string; approvedAt: string; waiverIds: string[];
}
type IssuePresentationActionCode = "navigate" | "view_evidence" | "open_help";
interface ActionCommandPayloadRef {
  payloadRefId: string;
  action: ActionCode;
  subjectRef: EntityRef;
  expectedRevisionId?: string;
  inputHash: string;
  payloadHash: string;
  idempotencyKey: string;
  expiresAt?: string;
}
interface ActionLink {
  actionId: string;
  action: ActionCode | IssuePresentationActionCode;
  label: string; targetRef?: EntityRef; targetRoute?: string; enabled: boolean;
  requiredCapabilities: CapabilityCode[];
  disabledReasonCode?: string; disabledReasonText?: string;
  commandPayloadRef?: ActionCommandPayloadRef;
}
```

四套语义共用壳但source独立；Severity说明问题强度，Gate说明阻断哪个关口，二者不得合并成一个持久化boolean。`NONE`只展示；`REVIEW`要求在批准前处理且约束后续发布；`PUBLISH`阻止创建/发布新Snapshot；`EXPORT`只阻止命中的环境×渠道目标。fingerprint至少由source、code、subject、规则版本和Gate构成；EXPORT fingerprint还必须包含`environmentId + channelKey`，REVIEW/PUBLISH fingerprint不得携带导出目标。`ValidationWaiver.gate`始终是单值；EXPORT Waiver必须同时具有`environmentId`和`channelKey`，REVIEW/PUBLISH Waiver不得携带或匹配导出目标。一次人工决定可以原子创建多份Waiver，但每份只能匹配自己的Issue fingerprint和Gate；仅当Gate为EXPORT时还必须匹配环境×渠道。Waiver不能跨关口复用，EXPORT Waiver也不能跨环境或渠道复用。动作由服务端生成并在执行时重新鉴权。AI数量不计Issue。

`ActionLink.action`必须复用统一`ActionCode`表达任何可执行领域命令；`IssuePresentationActionCode`只能表达导航、查看证据和打开帮助，执行后不得修改数据库、文件、远端系统、Issue状态或操作记录之外的业务状态。确认warning、申请/批准waiver、重新计算校验、创建规则源变更草稿等动作分别使用`acknowledge_validation_warning`、`request_validation_waiver`、`approve_validation_waiver`、`recompute_validation`和`create_rule_source_change_draft`；重试不是独立动作码，必须复用原命令的`ActionCode`、类型化payload和幂等键。

对任何会改变状态的`ActionCode`，`enabled=true`时必须返回不可篡改的`commandPayloadRef`，其`action/subjectRef/inputHash/payloadHash`必须与服务端保存的类型化payload一致。warning确认payload必须绑定Issue fingerprint、expected Issue revision/inputHash和人工理由；waiver payload必须绑定单一Gate及必要的环境×渠道；重算必须绑定待重算对象、expected revision和规则版本；规则源变更草稿必须绑定目标规则、source revision和证据hash；配置身份动作的具体字段遵循OPEN-008和第25节。客户端只提交`actionId + payloadRefId`，不得替换action、subject、expected revision或策略/Manifest引用；服务端执行前重新读取payload、校验hash/有效期、重算`ActionAvailability`并再次鉴权。

旧持久化动作名只用于识别迁移候选，不能直接做字符串替换：`acknowledge_warning`、`request_waiver`、`approve_waiver`、`recompute`和`create_rule_source_change`分别以`acknowledge_validation_warning`、`request_validation_waiver`、`approve_validation_waiver`、`recompute_validation`和`create_rule_source_change_draft`为候选目标。迁移器必须从可信的服务端历史事件、命令记录和版本化对象中完整重建目标ActionCode要求的类型化payload，校验subject、expected revision/input hash、Issue fingerprint、人工理由、Gate、必要的环境×渠道、目标规则/source revision、证据hash及原幂等键，并重新计算`payloadHash`；不得从旧动作名、展示文案、客户端补传值推断或为缺失字段填默认值。

`edit_rule/edit_patch/satisfy_requirement/request_permission`只有在历史证据能证明它们从未修改业务状态且能恢复明确路由时，才转换为`navigate + targetRoute`。`open_rebase`不再是现行`ActionCode`，且只允许迁移为纯导航：仅当可信历史证明该记录从未执行Rebase、只是打开页面并能恢复明确路由时，才转换为`navigate + targetRoute`。任何曾执行或可能执行Rebase、证据不足、语义冲突或无法证明纯导航的`open_rebase`记录都必须以`LEGACY_ACTION_ALIAS_UNRESOLVABLE` fail-closed，不得转换为`rebase_patch`；现行Rebase写命令只能由新`rebase_patch`记录及其完整类型化payload表达。旧`retry`同样只有能恢复原ActionCode、完整原类型化payload和原幂等键时才转换为原动作。

上述任一状态写候选缺少或冲突任一必填字段时，迁移结果固定为`enabled=false`、不生成`commandPayloadRef`并记录`LEGACY_ACTION_ALIAS_UNRESOLVABLE`；直接API执行相同记录也必须以该码拒绝。任何未枚举但历史语义可能具有副作用的旧动作也默认按该码拒绝，直到迁移器为其定义完整的目标ActionCode、可信字段来源和类型化payload校验。新接口、数据库和事件不得继续写入旧别名，也不得保留绕过类型化payload的兼容执行器。

缺Capability、职责分离策略不允许、expected revision过期、Manifest stale或其他关口未满足时，`ActionLink`必须返回`enabled=false + requiredCapabilities + disabledReasonCode + disabledReasonText`且不得携带`commandPayloadRef`；直接伪造命令仍返回403或领域冲突，不能依赖按钮禁用。只读导航类动作可以没有payload。`ActionAvailability`与同一subject上的`ActionLink`对相同`ActionCode`必须给出一致的enabled、requiredCapabilities和禁用原因。

状态语义固定：`OPEN`表示当前有效；`ACKNOWLEDGED`只用于已记录理由的WARNING；`RESOLVED`表示同一输入版本下根因已消失；`STALE`表示输入变化后旧Issue只读留痕；`WAIVED`只用于版本化策略明确允许的ERROR。WARNING确认不得伪装成WAIVED。

需要二次确认的业务阈值使用WARNING，而不是可waive ERROR。`PRICE_UPPER_THRESHOLD_CONFIRMATION_REQUIRED`的PUBLISH fingerprint必须绑定Model revision、PricingPolicyVersion、inputHash、`purchasePriceRaw/purchasePriceRounded/purchasePrice`和阈值，且不得包含`environmentId`或`channelKey`；确认后为`ACKNOWLEDGED`并允许命中的PUBLISH Gate继续。任一绑定输入变化后旧Issue与确认转`STALE`，UI重新展示确认动作。该Issue的`ActionLink.action`直接返回统一`ActionCode`中的`acknowledge_price_warning`，并绑定类型化、不可篡改的`commandPayloadRef`，要求`pricing.warning.acknowledge`能力；不得用通用`acknowledge_warning`代替真实命令。ACKNOWLEDGED只确认用户知晓超限，不得掩盖目标字段不可表示、配置断链或数值溢出等独立EXPORT BLOCKER；后者的fingerprint才包含`environmentId + channelKey`。

`BLOCKER`是绝对不可waive的严重度：用于硬deny/缺失require、Snapshot完整性错误、配置断链、缺少必需版本和不可重放结果等继续执行会产生不可信产物的情况。`ERROR`是否可waive由`WaiverPolicyVersion`按source、code、gate、作用域和有效期决定；默认不可waive，只有服务端返回有效waive动作时UI才展示。Waiver必须独立保存、审计并冻结到批准/发布/导出证据；策略变化、Issue fingerprint变化或Gate变化不会自动沿用旧waiver，EXPORT还在环境×渠道变化时失效。批量决定使用`ValidationWaiverDecision`记录一次人工动作和原子目标集合，不改变每份Waiver的单Gate、单fingerprint语义。

正常路径：校验器产Issue，页面按来源、Severity和Gate分区并执行后端动作。
边界：一根因多对象用主Issue+affectedRefs。
冲突：互斥动作执行前重验。
恢复：失败保留Issue；重试复用原ActionCode和幂等payload，重算使用`recompute_validation`，权限帮助只提供无副作用导航。

权限：可看不等于可修；无权动作说明原因。
验收：Given deny、-3 Affinity、不变量偏离并存，When 返回，Then source、Severity、Gate、State和动作独立，Affinity不能抵消deny；Given策略未允许某ERROR waiver，When渲染动作，Then不显示可执行waive入口；Given 用户缺少`config.id.reserve`，When 返回预留Issue动作，Then `action=reserve_config_id_bundle`、`enabled=false`、列出所需Capability和禁用原因且没有payload；Given 权限和全部门禁恢复，Then 返回同一ActionCode及绑定subject、expected revision和hash的payload引用，篡改payload或revision时服务端拒绝；Given旧`approve_waiver`缺少fingerprint、reason、Gate、expected revision或EXPORT环境×渠道任一字段，When迁移或执行，Then返回`LEGACY_ACTION_ALIAS_UNRESOLVABLE`且没有payload；Given字段完整且来自可信历史，Then重建并校验不可篡改`approve_validation_waiver`payload而不是只改动作名；Given旧`open_rebase`仅有路由证据，Then只映射`navigate`且不能执行Rebase；Given旧`open_rebase`存在写语义证据、语义冲突或无法证明纯导航，Then返回`LEGACY_ACTION_ALIAS_UNRESOLVABLE`且不得转换为`rebase_patch`，现行Rebase写命令只使用新`rebase_patch`记录；Given旧`retry`记录，Then只有恢复原动作、完整payload与原幂等键时才可执行；Remediation联合中不存在任何状态写动作。

### 24.11 R10：Rebase、UpgradeCandidate与Snapshot

```text
Patch revision:
DRAFT → PENDING_REVIEW → APPROVED → ACTIVE
DRAFT/PENDING_REVIEW → WITHDRAWN
任意未发布状态 → SUPERSEDED
基线变化：当前Patch revision → REBASE_REQUIRED
rebase成功：创建新Patch revision，状态为PENDING_REVIEW

UpgradeCandidate:
generated → analyzing → blocked | rebase_required | ready_for_review
ready_for_review → approved → published_as_new_snapshot
generated/ready_for_review → dismissed
任意非终态 + upstream_changed → superseded
```

Patch业务生命周期只使用第14.2节的规范大写`PatchState`；小写状态只允许出现在迁移适配器。`base_changed`是触发原因而不是持久化状态，`rebasing/REBASING`是动作执行进度而不是`PatchState`，不得写入Patch revision、账本、Snapshot引用或飞书镜像。

set基线变化、参数删除/重命名、边界/公式/兼容变化必须rebase。clear在目标仍是可继承覆盖时可以确定性重放；目标删除、重命名或必填性变化时必须rebase。add/multiply自动重放最多创建`PENDING_REVIEW`的新revision。基线变化只使当前revision进入`REBASE_REQUIRED`；rebase必须通过`rebase_patch`动作创建严格递增的新`patchRevision`，不得把原revision从`REBASE_REQUIRED`原地改回`PENDING_REVIEW`。

`rebase_patch`命令至少绑定`patchId + expectedHeadPatchRevision + expectedBaseRuleSetVersion + expectedBaseObjectRevision + targetBaseRuleSetVersion + targetBaseObjectRevision + inputHash + idempotencyKey`。服务端固定按以下事务执行：

1. 重新鉴权并锁定Patch head，重验expected head、当前基线和目标基线；任一不一致返回revision或baseline冲突。
2. 在事务内存中对完整有序操作组计算新before/after、Trace、Issue和hash；未解决冲突、非法操作或任何校验失败时不创建revision。
3. 只有全部操作和证据有效时，原子写入一个新Patch revision、完整操作组、幂等记录和审计；新revision最多为`PENDING_REVIEW`，不得直接成为`APPROVED`或`ACTIVE`。
4. 同一idempotencyKey和完整payload重试返回第一次已提交结果；同一key携带不同payload时拒绝。提交前基线或Patch head再次变化时整个事务回滚，调用方必须基于最新基线重新预览和执行。

失败、超时后无法证明已提交、权限拒绝或并发基线变化均不得留下半revision、半操作组或执行中的持久化业务状态；原Patch revision、有序操作、历史Snapshot、Patch引用、`PatchSetHash`和内容hash保持不变。超时重试必须先按幂等键回读，不得猜测成功或重复追加。

approved/dismissed候选不改旧Snapshot；只有发布命令新建Snapshot。SnapshotBuild可building/failed/ready；ConfigurationSnapshot创建即frozen，只允许查看、下载原样审计归档、在完整性门禁通过时正式导出、审计、复制新修订、生成升级候选，禁止原地编辑/重算/rebase/换hash/删除引用。`download_snapshot_audit_archive`只要求`snapshot.audit_archive.download`并遵守第14节的原样打包语义；`export_snapshot`要求`snapshot.export`，不可重放或缺策略引用的BLOCKER必须阻断它以及后续配置导出。

正常路径：解决rebase并发布新Snapshot。
边界：语义相同也只关闭候选，不重写hash。
冲突：处理时Patch head或基线再变则本次rebase事务回滚，旧revision保持`REBASE_REQUIRED`，调用方基于最新基线重新预览；UpgradeCandidate按其独立状态机进入superseded。
恢复：rebase按幂等键回读或在最新基线上重试；复制决定到最新候选；失败Build可重试且无半快照。
权限：rebase、审核、发布分开；冻结快照无edit。
验收：Given Patch revision 7因基线变化进入`REBASE_REQUIRED`，When `rebase_patch`重验相同head和基线并成功，Then 原子创建revision 8且状态为`PENDING_REVIEW`，revision 7及其操作/hash保持不变；Given计算、校验或写入任一步失败，Then不存在revision 8或半操作组；Given提交前基线再次变化，Then返回冲突且revision 7、历史Snapshot及`PatchSetHash`不变。Given S1已发布，When 批准升级候选，Then S1/hash不变；再次发布才生成S2。

### 24.12 R11：状态与文案

```ts
type LifecycleState = "ACTIVE" | "DEPRECATED" | "ARCHIVED";
type RevisionState = "DRAFT" | "PENDING_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "SUPERSEDED";
type ValidationState = "NOT_EVALUATED" | "EVALUATING" | "PASSED" | "WARNING" | "BLOCKED" | "ERROR";
type PublicationState = "UNPUBLISHED" | "READY_TO_PUBLISH" | "PUBLISHING" | "PUBLISHED" | "PUBLISH_FAILED";
type AttentionState = "HAS_UPGRADE_CANDIDATE" | "REBASE_REQUIRED" | "SOURCE_STALE"
  | "IMPORT_CONFLICT" | "EXPORT_RELATION_BROKEN";
type PrimaryDisplayState = "HARD_CONFLICT" | "REBASE_REQUIRED" | "REVIEW_REQUIRED"
  | "WARNING" | "READY_TO_PUBLISH" | "HAS_UPGRADE_CANDIDATE" | "PUBLISHED" | "DRAFT";
```

| 后端码 | 文案 |
| --- | --- |
| DRAFT | 草稿 |
| PENDING_REVIEW | 待复核 |
| HARD_CONFLICT | 硬冲突 |
| REBASE_REQUIRED | Patch需要rebase |
| READY_TO_PUBLISH | 待发布 |
| PUBLISHED | 已发布 |
| HAS_UPGRADE_CANDIDATE | 有升级候选 |
| WARNING | 有警告 |
| DEPRECATED | 已废弃 |
| ARCHIVED | 已归档 |
| PUBLISH_FAILED | 发布失败 |

生命周期、revision、校验、发布、注意状态和派生主状态分开；数据库不存UI文案。`IN_REVIEW`不是生命周期，“已计算”只是元数据。主状态按R1优先级，其他状态仍显示。“已冻结”是Snapshot固有属性；一个Model可以同时拥有有效的已发布Snapshot和被阻断的新revision。

正常路径：后端返回Lifecycle、Revision、Validation、Publication和Attention状态，前端按i18n映射。
边界：未知码显示未知状态并只读降级。
冲突：不存在当前revision却返回RevisionState、Publication=PUBLISHED却缺少Snapshot引用等非法组合报完整性error；DRAFT与HAS_UPGRADE_CANDIDATE可以合法并存。
恢复：重新同步或进入审计。
权限：文案不决定动作。
验收：Given 已发布Model有硬冲突修订和升级候选，When 聚合，Then 主标签硬冲突，同时保留已发布、升级候选和各自动作。

### 24.13 R12：版本化策略与完成门槛

`patchOffsetPolicy`的产品语义已经由OPEN-004完成决策并通过`patch-offset/open004-v1`发布：`PatchOffsetPolicyVersion`固定表达`mode=FINAL_RANGE_WITH_MANDATORY_REVIEW`、`offsetThresholds=NONE`和`rangeEndpoints=INCLUSIVE`，不得重新引入独立偏移阈值；状态为`RESOLVED`。`FiveAxisViewDefinition`的OPEN-005语义也已经确认，但仍须完成第21.7节迁移并发布唯一`FORMAL_CURRENT`定义；旧`PUBLISHED`定义不满足该门槛。仍保持开放、版本化且不得固化最终值的策略包括`enabledItemPartPolicy`、`qualityValueRangePolicy`、`PricingPolicy`与未来Performance扩展策略。`PerformanceSummaryDefinition`同样版本化，但只配置如何统计和展示既有结果，不得配置为属性或价值分输入，缺失时按第11.2.1节冻结`UNAVAILABLE/definition_missing`而不构成发布配置不完整。仓库当前没有可校验的已发布`enabledItemPartPolicy`版本，因此按OPEN-003的`DEFERRED_UI_DISABLED`行为fail-closed：产品流程只处理竿、轮、线，钩、漂、真饵和拟饵入口及动作全部关闭；未来策略即使加入这些部位，也必须先满足OPEN-003规定的独立产品设计前置条件，不能仅修改开关。`aiRefreshPolicy`、`aiModelRecordPolicy`、`aiReviewPolicy`和`separationOfDutiesPolicy`首次由第20.2节的`open009-2026-07-23-v1`关闭；匿名本地会话和可选飞书登录由后继`open009-2026-07-27-v2`发布，历史v1不得重解释。所有策略仍以版本保存，未来只能通过新决策和新版本改变。一期、1.5期、二期和当前规划三期均不接飞书审批，当前不在Tackle Forger内实行职责分离。Snapshot冻结语义不是配置项，改变它必须先改权威规范并获用户明确确认。

正常路径：使用已发布策略版本并记录。
边界：配置缺失通常报配置不完整且不用页面默认；`PerformanceSummaryDefinition`是明确例外，缺失时按第11.2.1节冻结`UNAVAILABLE/definition_missing`并保持发布非阻断。历史可只读。
冲突：草稿策略试算标草稿，不混入正式发布。
恢复：回到有效策略或发布新版本，不回写历史快照。
权限：策略编辑、审核和发布仍是独立动作；第20.2节当前允许同一已登录用户连续执行。Agent不得永久固化仍未确认的其他OPEN项。

验收：Given OPEN-004已经完成决策但尚无可校验的已发布`PatchOffsetPolicyVersion`，When 新增Patch，Then Patch立即参与固定`FINAL_RANGE_WITH_MANDATORY_REVIEW`语义的草稿试算，但批准与发布返回`PATCH_OFFSET_POLICY_MISSING`；When 策略版本已发布，Then 人工可以在Series/SKU/Model或发布批次的整体结果页一次确认多个对象及其完整Patch集合，每个Patch revision可追溯到该冻结证据且无需逐Patch审批，只按当前关口各离散对象的累计最终值和包含端点的已发布参数合法范围校验，并覆盖批次变化失效、多离散重量、单Gate及逐环境×渠道Waiver、rebase和历史Snapshot冻结回归。独立偏移阈值不得作为可配置运行策略；迁移和反向测试可以用旧阈值输入验证其被拒绝、隔离或不影响新策略结果。Given缺少`PerformanceSummaryDefinition`，When发布Model，Then不返回配置不完整阻断，而是按第11.2.1节冻结`UNAVAILABLE/definition_missing`。

### 24.14 完成标准

后端必须独立表达身份、revision、状态、Trace、Issue、Action和权限；命令支持幂等、并发检查、审计、恢复；列表区分对象、投影、临时候选；确定性结果可重放且AI不裁决；R1–R12分别自动化覆盖正常、边界、冲突、恢复、权限和Given/When/Then；历史Snapshot内容/hash在所有测试中不变。
