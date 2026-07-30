## 14. 版本、快照与飞书治理

```text
FeishuSourceRevision
→ RuleSetVersion
→ DerivedProjectionRef
→ SeriesRevision
→ SkuRevision
→ ModelRevision
→ ConfigurationSnapshot
```

ConfigurationSnapshot至少冻结：

- modelId和上游Revision；
- RuleSetVersion、Part revision、weightBandId、functionTemplateRef与匹配输入指纹；
- ReductionStackingPolicyVersion；
- PatchSetHash；
- finalPanelValues；
- technologyIds、attributeAffixIds、passiveAffixIds；
- SKU继承屏蔽/增加/局部词条副本意图、有效词条集合hash、推荐品质、人工实际品质及覆盖理由/状态；
- 属性叠加轨迹，包括源词条、有序operation、归一化方向与幅度、BaseValue、B、R、PercentAdjusted、固定值增减合计、FinalBeforeBoundary、ParameterDefinition引用、规则源单元格/revision及输入输出hash；
- 被动技能设计Payload；
- 品质、兼容和校验报告；
- `SkuAffixValueAssessment`及Model对其冻结SKU revision的只读引用、`PerformanceSummarySnapshot`（可为`AVAILABLE`摘要与定义引用，或`UNAVAILABLE/definition_missing`）、PricingPolicy版本、自动价格、定价Trace和价格WARNING确认引用；
- 发布人和发布时间。

上游变化生成UpgradeCandidate，不原地覆盖Snapshot。

Snapshot的“下载审计归档”与“正式导出”是两种不同动作：

- `download_snapshot_audit_archive`只按内容寻址读取并打包已经冻结的原始Snapshot payload、当时保存的Trace/证据/hash与完整性Issue；不得重算、补版本、生成新配置表或声称结果可重放。即使历史Snapshot缺少策略版本，只要冻结payload与自身hash仍可验证，就允许此只读下载，并在归档Manifest标记`replayStatus=UNVERIFIABLE_POLICY_REFERENCE`。
- `export_snapshot`、`config.export.preview`和`config.export.commit`属于正式导出链。Snapshot存在不可重放、策略引用缺失、Trace/hash不一致或其他完整性BLOCKER时全部阻断，不能以审计归档能力绕过。
- 恢复可验证策略引用不得原地修改旧Snapshot。必须从可验证输入创建新的ModelRevision，完整重算并发布新的ConfigurationSnapshot；旧Snapshot和其审计归档保持不变。

历史Snapshot缺少策略引用时产生`SNAPSHOT_REPLAY_POLICY_MISSING`（不可waive的`BLOCKER / EXPORT`）；它不阻止`view_snapshot`或`download_snapshot_audit_archive`，因为二者不是正式导出Gate。冻结payload自身hash已损坏时另按Snapshot完整性BLOCKER处理，审计归档也不得伪造成功。

> **2026-07-25 权威表迁移（#149 / 读取协议 #143）**：权威规则源工作簿已从 `YsEKw…`（wiki，18 张合并表）迁移到 `WQ8wstS4ch29E2tAKnVcoh5KnJg`（sheets，竿/轮/线独立子表）——主工作簿 URL 已于本节更新为 WQ8w。两套拓扑不同（合并表 vs 分表），概念 ↔ sheet_id 映射见 `docs/audits/feishu-source-to-v3-mapping.md`。下方 sheet_id 清单（`d6e928`/`vviXo0`/`FqD4j7`/`edyFx9`…）与详细接入契约（五维块布局 竿3–18/轮21–36/线39–54、revision 观测 `2302`/`2352`/`4226`…）仍基于 **YsEKw 历史快照**，保留作审计证据；WQ8w 分表接入契约的重写由 #143 跟踪。**目标：工作簿来源可配置**（UI 飞书导入区支持输入链接 + 历史下拉，不硬编码单一表），由独立 issue 跟踪。

飞书电子表格是唯一通用规则源。当前指定主工作簿为[《钓具设计工作簿》](https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4ch29E2tAKnVcoh5KnJg?from=from_copylink)（WQ8w，竿/轮/线分表）；`?sheet=` 只表示打开时定位，同步边界是链接解析后的整个工作簿，不是单个工作表。2026-07-25 迁移后首次接入基线为 revision `338`；迁移前主工作簿为 YsEKw（wiki），历史 revision `2302`/`2352` 仅作审计证据保留于本节下方。两者都只是可审计的历史观测值，不是永久版本常量；每次显式拉取必须重新取得revision并形成新的`FeishuSourceRevision`。

当前工作簿关键稳定工作表标识为：`01_重量模板/d6e928`、`02_钓法类型/rgFPUu`、`02.5_钓法模板/m3eQCg`、`03_类型材质/fATowU`、`04_功能定位/vviXo0`、`04_词条/zrVOxd`、`05_技术/RdZv0J`、`06_系列/9nE3Rx`、`07_品质评分/FqD4j7`、`08_价格计算/u87sRh`、`10_校验规则/KZv4o2`、`11_组合SKU/eXV1dI`、`13_上传发布/M17p0j`、`14_Rods/hekdpO`、`15_Reels/oUp48w`、`16_Lines/YTYwgS`、`17_Item/VFxDxt`、`Patch台账/edyFx9`。这是 revision `4226` 的已观测拓扑；工作表名称是人类文案，接入器以`sheet_id`识别并校验期望名称，改名产生warning，不把同名新表静默当成原表。

`01_重量模板`是竿、轮、线各自的重量段标杆，不能把其中“钓具大类”误作钓法。`02_钓法类型`的不可变`fishing_*`行提供钓法系数，钓法与类型仍是两个独立规则层。导入器以稳定ID和表头逻辑列定位：先对重量段标杆应用钓法系数，再叠加独立钓法层Patch，形成可审查的钓法模板；不得通过显示名、行号、块顺序或`02.5`反向猜测绑定。`02.5_钓法模板/m3eQCg`只是人工审核后可写回的结果与证据，不是当前规则的权威输入。任何缺失稳定ID、未知列语义、基准revision冲突或回读不一致都必须阻断激活并保留已有发布版本。

五维图的 W 重量段采用 Issue #13 已确认的正式策略：`W1 微物 [0,1.5)`、`W2 小型 [1.5,4)`、`W3 中型 [4,10)`、`W4 大型 [10,20)`、`W5 巨物 [20,80)`、`W6 超巨物 [80,+∞)`。边界值进入后一档。定义必须冻结完整策略 payload、版本和 hash；后续来源读取只能生成新版本，绝不改写既有定义或 Snapshot。

每块 ordinal 必须恰为`1..16`，machineId 必须分别为`wtpl_rod_0001..0016`、`wtpl_reel_0001..0016`、`wtpl_line_0001..0016`且三块全局唯一，sync 固定为`BOUND`。相邻拉力区间必须无缝相接（前一max等于后一min）且`max>min`；六个grade的行数必须严格为`1/2/4/4/3/2`。任何 ordinal、机器ID、sync、部位、区间连续性或grade计数偏离均为来源结构错误并fail-closed。

规范化 W policy 固定为`policyId="weight-band:five-axis-d6e928"`、`version="weight-band:five-axis-d6e928@<sourceRevision>"`、六个稳定`W1..W6`和上述按源推导的上界，使用严格 schema、JCS、UTF-8 SHA-256计算`contentHash`。拉取必须把完整规范化payload和hash冻结进该准确`FeishuSourceRevision`；缺范围、表头/行/机器字段、部位、ordinal、区间、grade连续性、开放尾段、三方一致性或revision/hash任一不一致均fail-closed，不能发布新正式五维定义。正式定义必须同时引用同一`sourceRevision`和该hash，正式发布命令必须从冻结的`FeishuSourceRevision`复核二者；不得由调用方手填hash或以代码示例策略冒充飞书证据。新revision只能形成新定义、目录修订和后续Snapshot；旧定义、目录、VertexSet和ConfigurationSnapshot永久保留，既有历史Snapshot不得因重新拉取而重算或补写。

`04_功能定位/vviXo0`每个功能行必须有不可变`FunctionProfile ID（勿改）`。它是FunctionProfile父级身份；`func_*`仅是强度行身份。相同父ID的显示名必须一致，非泛用组必须恰好各有一次强度1、2、3；泛用组允许仅有强度1，保留源数据而不得补造强度。缺父ID、重复强度或不完整非泛用组必须fail-closed，绝不由名称、`名称|级别`、行号或排序归组。revision 4226 的机器区域含竿/轮/线三块、空隔行与重复表头（`d6e928 A1:AE54`、`rgFPUu A1:AB12`、`m3eQCg A1:AB83`、`fATowU A1:AE20`、`vviXo0 A1:AG63`）；每块都必须独立按表头解析。

对`02.5`的可选写回最终必须使用准备、写入、回读验证、激活四阶段：prepare冻结输入内容哈希、源revision baseline和幂等键；write只写经人工审核的拟写单元格；readback验证稳定ID、值与revision；activation仅在完整回读后标记`REMOTE_CHANGES_AVAILABLE`。部分失败必须保留准备证据并要求重新拉取，不能声称已激活或自动覆盖历史Snapshot。当前版本尚未提供可从应用调用并跨重启恢复的`02.5`专用写回命令；本轮对飞书revision `4226→4227`的人工写入与技术回读仅是迁移证据，不得被界面或实现宣称为该持久化工作流已经上线。

规则工作表必须使用不可变`ruleId/entityId`和稳定`parameterKey`，机器区域不得依赖行号、名称或合并单元格。revision `2869`的当前规则源拓扑已将词条和技术调整为`04_词条`、`05_技术`，且不再包含独立“性能定位”工作表。`04_词条/zrVOxd`的稳定ID扫描与组合矩阵别名绑定必须以同一`FeishuSourceRevision.sheets`中经验证的`grid rowCount`作为读取上界（分别读取`B1:C<rowCount>`与`B2:F<rowCount>`）；不得固定末行。缺失、非安全整数、过小行数或不足六列的grid元数据必须fail-closed，不能截断为旧范围或猜测别名。接入器必须按最新显式拉取的workbook revision核对sheet_id与机器ID，保留既有ID；任何缺ID新行进入`NEW_SOURCE_ROW`等待人工确认。历史revision中的性能定位ID不得擅自迁移、删除、复用或继续作为新Series/Model输入；名称只用于历史显示、搜索和迁移候选，不用于长期对象关联。新的`PerformanceSummary`从已结算配置派生，不接管或复用这些历史ID。

`09_甘特图/wxORcd`按工作簿使用说明是开发计划表，不是产品界面的“钓具系列甘特图”数据源，也不新增领域实体。`11_组合SKU`、`12_打包竿组`和`14_Rods`至`17_Item`当前作为历史样例、映射参考或飞书侧暂存输出，不能反向覆盖Tackle Forger中的Series、SKU、Model与Snapshot真相。飞书工作簿当前也没有完整GoodsBasic/StoreBuy目标页；因此本节的飞书数据进出不替代第25节的本机配置Git仓库导出。正式发布仍从冻结Snapshot写入本地tackle/item/store工作簿，并强制生成GoodsBasic和StoreBuy。

通用修正的生效链固定为：

```text
工具内RuleSourceChangeDraft
→ 人工确认写回飞书电子表格
→ 技术回读验证
→ REMOTE_CHANGES_AVAILABLE
→ 用户显式“拉取”
→ FeishuSourceRevision + RuleSet草稿
→ 校验
→ 用户显式发布RuleSetVersion
→ 下游重算并判断DerivationLayerPatch是否吸收
```

写回不等于拉取，拉取不等于发布。Series、SKU、Model、FinalReview Patch和ProjectionPin是产品特例，不得未经归纳直接写入通用规则表。DerivationLayerPatch只有在新规则版本重算后完全覆盖其语义时才进入ABSORBED；部分覆盖保持PARTIALLY_ABSORBED。已发布Snapshot只产生UpgradeCandidate。

### 14.1 Patch权威账本与飞书Patch台账

所有保存过的Patch必须进入工具内统一、持久化、版本化的`PatchLedger`。`PatchLedger`是Patch的运行时权威来源；重新拉取、重新演绎、重新生成、对象改名、服务重启、换浏览器或换电脑均不得使Patch静默丢失。生成时按稳定对象ID、Patch作用域和基线revision加载有效Patch：基线兼容则确定性重放，基线变化则进入`REBASE_REQUIRED`，禁止跳过或按名称猜测对象。

主飞书工作簿应增加单一`Patch台账`工作表，作为全部Patch的人工可见镜像、协作界面和额外审计副本。该工作表不是通用规则表，也不是Patch的唯一运行时来源；飞书行号、显示名称、排序和合并单元格不得参与关联。Patch组由带类型的`tuple(workspaceId, patchId, patchRevision)`定位，每条镜像明细按`tuple(workspaceId, patchId, patchRevision, operationId)`幂等同步；飞书变化必须显式拉取后才能进入工具。已被ConfigurationSnapshot引用的Patch revision不可原地修改，只能创建新revision。

`Patch台账`采用“一条Patch操作一行”：同一工作区内同一Patch修改多个属性时，多行共享`workspaceId + patchId`。前三个机器字段固定为`scopeType`、`layerType`和`subjectEntityId`，第四个机器字段固定为受控`workspaceId`；至少还应包含`patchId`、`patchRevision`、`operationId`、`operationIndex`、`subjectName`、`parentEntityId`、`parameterKey`、`operation`、`operand`、`before`、`after`、`baseRuleSetVersion`、`baseObjectRevision`、`reason`、`evidence`、`patchState`、`mirrorSyncState`、`attentionStates`、创建/审核身份与时间、`supersedesPatchId`、`ruleProposalId`和`snapshotRefs`。名称只供显示和搜索，禁止用单一`status`混合业务与同步状态。

个体Patch必须进入统一汇总分析，但不得自动成为通用规则。工具按作用层、属性、钓法、类型、功能定位、重量段、修改方向和重复频率识别稳定模式；经人工归纳、跨对象影响预览和确认后，才可生成`RuleSourceChangeDraft`并写回对应通用规则页。新RuleSetVersion发布并重算后，原Patch分别进入`ABSORBED`、`PARTIALLY_ABSORBED`、继续`ACTIVE`或`REBASE_REQUIRED`，不得因规则提案或写回而提前删除。

接口必须区分Patch创建、Patch审核、Patch台账写入、Patch台账拉取、镜像检查、缺行修复、按本地权威重建、远端schema修复、Patch主体迁移、规则提案创建、通用规则写回和RuleSet发布等Capability。OPEN-010只定义这些动作的安全边界，不决定人员授权；Capability分配和职责分离必须引用第20.2节当前发布的`separation-of-duties/open009-v2`，未来也只能由新的`separationOfDutiesPolicy`版本改变。当前策略下所有已登录公司用户获得全部已启用Capability，是OPEN-009的结论，不得复制为OPEN-010常量。

人工备注、复核意见和“建议提升为共享规则”必须通过Tackle Forger提交；飞书`Patch台账`对人工只读，仅服务身份执行远端写入。审计记录实际业务发起人的稳定飞书用户ID和时间，不能以服务身份替代业务操作者。同步失败保留本地权威记录、幂等键和远端回读结果，可安全重试。

验收至少覆盖：重新生成后已批准Patch被重放；对象改名后仍按ID关联；基线变化进入rebase而非消失；多属性Patch按同一patchId形成多行；重复同步不重复追加；飞书排序或改名不改变关联；Snapshot引用的Patch不能原地改写；个体Patch未经人工归纳不能写入通用规则；新规则只吸收完全覆盖的Patch；飞书同步失败不影响本地Patch可恢复性。
### 14.2 Patch状态、操作顺序、镜像同步与迁移契约

Patch业务生命周期与飞书镜像同步状态必须正交保存，禁止用一个`status`混合表达：

```ts
type PatchState = "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "ACTIVE"
  | "REBASE_REQUIRED" | "ABSORBED" | "PARTIALLY_ABSORBED"
  | "WITHDRAWN" | "SUPERSEDED";
type PatchMirrorSyncState = "NOT_SYNCED" | "PENDING" | "WRITING" | "SYNCED"
  | "REMOTE_CHANGED" | "CONFLICT" | "WRITE_FAILED";

interface PatchOperationRecord {
  workspaceId: string;
  patchId: string; patchRevision: number;
  operationId: string; operationIndex: number;
  parameterKey: string; operation: "set" | "add" | "multiply" | "clear";
  operand: unknown; before: unknown; after: unknown;
}
```

`PatchOperationRecord`是账本、Snapshot和飞书镜像的规范明细。`clear`行的`operand`固定为`null`；飞书导入遇到`remove`时先转换为`clear`再计算幂等键。飞书出现`min/max`不得直接进入ACTIVE revision：只有能从冻结基底验证before/after的记录才可规范化为`set`，并保留原始意图证据；否则整组进入`REBASE_REQUIRED`或迁移复核。

`operationId`在Patch内稳定且不可复用，飞书镜像明细的幂等键为带类型的`tuple(workspaceId, patchId, patchRevision, operationId)`。`operationIndex`是确定性执行顺序，不得使用数据库自然顺序、飞书行号或当前排序；同一参数存在多个操作时也必须按它执行。Patch revision是组级事务边界：审核、批准、撤回、rebase、重放、吸收和Snapshot引用均针对完整revision；只有全部必需操作有效时才可重放。镜像部分写入成功不得把整组标为`SYNCED`。

飞书删除、清空、隐藏、移动或过滤镜像行不构成删除Patch的命令，不得级联改变本地账本、业务状态或Snapshot。缺失行产生`PATCH_MIRROR_ROW_MISSING`，允许按幂等键补写。飞书中未知`patchId`、重复明细键、受控审计字段被改写或明细组不完整时必须隔离问题行并产生`ValidationIssue(source="patch")`；不得按名称自动认领。协作记录使用独立追加事件区：备注、复核意见、共享规则建议及其接受、拒绝、撤回和更正均创建新事件；旧事件不可修改或删除。事件并发与重试遵循第14.4节的原子compare-and-append契约。

`PatchLedger`必须有独立`schemaVersion`和顺序迁移。迁移保留未知字段和原始Payload，重复执行幂等；迁移前后至少校验Patch revision数量、操作顺序、PatchSetHash、代表性最终值和Trace语义。无法无损迁移的记录保留原值并进入人工复核，不得删除。对象归档、缺失、合并或迁移后无法按稳定ID解析的Patch进入`ORPHANED`注意状态，保留原`subjectEntityId`和历史引用，禁止按名称重新绑定。

ConfigurationSnapshot必须冻结带类型的有序Patch引用集合`tuple(workspaceId, patchId, patchRevision, orderedOperationIds)`及`PatchSetHash`；每条引用的`workspaceId`必须与Snapshot所属工作区相同，缺失或不一致时禁止创建Snapshot。新契约的`patchSetHashContractVersion`当前固定为`patch-set-workspace-jcs-sha256-v1`，`PatchSetHash = lowerHex(SHA-256(UTF-8(JCS({ patchSetHashContractVersion, patchRefs }))))`；其中`patchRefs`按权威Patch执行顺序保存上述四字段，`orderedOperationIds`按`operationIndex`顺序保存，不得省略`workspaceId`或改用拼接字符串。任何输入或算法变化必须发布新的`patchSetHashContractVersion`，禁止复用旧版本名。被引用revision及其操作顺序不可原地修改；镜像行变化、Patch吸收、rebase和数据库迁移均不得改变历史Snapshot。已经发布的旧Snapshot继续保留其原引用结构、hash契约版本与`PatchSetHash`，不得为补入`workspaceId`而回写或重算；迁移只能显式记录旧hash版本，新契约结果必须创建新Snapshot。同步命令和补偿重试记录独立`idempotencyKey`、expected remote revision、逐操作结果和回读证据；超时先回读，部分失败可安全续传但不可产生半组生效状态。

新增验收：Given同一参数含set/add/multiply，When多次重放，Then严格按operationIndex得到同一结果；Given三行镜像只写成两行，When同步结束，Then组状态不是SYNCED且Patch仍可从本地完整重放；Given人工删除镜像行，When显式拉取，Then本地Patch和Snapshot不变并产生PATCH_MIRROR_ROW_MISSING；Given旧schema迁移两次，When比较结果，Then无重复revision且PatchSetHash、最终值和Trace语义一致；Given两个工作区复用相同Patch/revision/operation ID，When创建新Snapshot，Then冻结引用中的`workspaceId`不同且`PatchSetHash`不同；Given旧Snapshot使用旧hash契约，When账本迁移，Then其引用结构、hash版本和PatchSetHash保持不变；Given对象缺失且存在同名新对象，When加载，ThenPatch进入ORPHANED而不重绑；GivenSnapshot引用revision 1，When产生revision 2或改变镜像，Then旧Snapshot的有序引用与hash不变。

### 14.3 工作区 Revision 分层保留、归档与裁剪

本节定义工作区操作恢复历史的保留政策；它不改变本章前述领域 revision、Patch 或发布快照的不可变语义。正式决策与容量依据见 `audits/aud-009-workspace-revision-retention-adr.md`。

#### 14.3.1 对象边界

- `workspace revision` 是一次成功保存后完整 `WorkspaceState` 的操作恢复点，用于回看或恢复整个工作区。它不是防篡改事件账本，可以在满足本节全部条件后从在线存储裁剪。
- `ConfigurationSnapshot` 是 Model 发布时冻结的领域发布产物，Snapshot ID 与 payload/hash 永久绑定。它不属于 workspace revision 保留集合，也不得因为 workspace revision 裁剪而删除、重算、重排、覆盖或改写。
- 领域审计、Patch revision、Calculation Trace 和发布记录同样不属于 workspace revision 裁剪对象。裁剪流程不得改变它们的内容、稳定引用、哈希、顺序或可追溯性。
- `WorkspaceState.revisions` 中的摘要、普通 revision 列表 API 的分页/条数上限和完整 `workspace_revisions` 不是同一对象。显示最近 100 条不等于只物理保留 100 条。

#### 14.3.2 在线保留政策

SQLite 与 D1 必须在线保留以下两个集合的并集：

1. retention run 冻结的 UTC cutoff 起最近 90 天内创建的全部完整 workspace revision；
2. 无论创建时间如何，按 revision 稳定降序选出的最新 100 个完整 workspace revision。

当前 `workspace_state.revision` 必须始终受保护，不得因时间戳或并发观测异常进入候选。恰好位于 cutoff 的 revision 属于保留集合。revision 可以不连续；同一时间戳不得导致不稳定选择，数量集合以稳定 revision 顺序决定。每个 retention run 必须一次性冻结 cutoff、策略版本、输入集合和幂等键；相同输入与策略必须得到相同的保留集合。

无法解析、为空或位于未来的 `created_at` 必须 fail-closed：保留对应 revision，产生可观测的 `ValidationIssue` 或等价运维告警，不得猜测时间后删除。`retentionDays`、`minimumRevisions` 或策略版本缺失、非法、未知时也必须保留全部 revision；不得使用页面默认值、旧版本值或隐藏回退值继续裁剪。

Vercel Blob 是受控例外：它仅作非权威评审存储，最多保留 100 个 workspace revision。Blob 不是生产恢复、长期归档或审计权威源；任何导入或迁移都必须披露源 Blob 当时只可能提供尚存的最多 100 个 revision，不得声称复原已裁掉历史。若 Blob 将来升级为权威或生产后端，必须先满足与 SQLite/D1 等价的保留、归档、恢复和裁剪证据要求。

#### 14.3.3 分期与用户主动归档

归档与裁剪不属于一期跑通主流程的完成门槛：

- 一期不实现归档按钮、自动归档或 workspace revision 裁剪。SQLite/D1 继续保留全部已有完整 revision；缺少归档配置不得阻止登录、规则、Series/SKU/Model、Snapshot、导出和其他非删除流程。
- 一期可以保留只读容量诊断、整库灾备和告警，但不得把诊断、备份或“已超过 90 天”解释为删除授权。自动裁剪必须关闭。
- 二期归档由当前已登录工具用户主动执行，典型操作者是数值策划或系统策划。系统不得在后台代替用户选择归档时机或本机保存位置。
- 二期优先验证最简交互：用户点击“归档”→浏览器立即打开保存窗口→用户在工作 PC 上选择文件名与位置→工具流式写入单一归档包→回读或计算 manifest/hash→明确显示成功或失败。归档包不得包含飞书令牌、登录会话、应用密钥或其他凭据。
- 正式 Chromium + HTTPS 入口优先使用 `showSaveFilePicker()` 与 `FileSystemWritableFileStream`；调用必须来自用户手势，并先取得文件句柄再生成或写入大体积内容。API 不可用时可以评估普通文件下载作为降级，但降级也必须生成同等 manifest/hash，且不得宣称已经写入用户未选择的位置。
- 用户取消、权限拒绝、写入中断、浏览器不支持、包体超限或校验失败时，不产生“已归档”记录，也不允许裁剪。若二期无法以可接受复杂度验证本机保存与恢复，归档和裁剪继续延期，系统保持全量在线保留。

单一归档包的格式、大小上限、是否压缩/加密、恢复入口和保留周期由二期实现 Issue 明确；不得为了提前实现裁剪而把这些决策塞回一期。

#### 14.3.4 允许删除的必要条件

revision 位于“最近 90 天”与“最新 100 个”并集之外，只表示它具备裁剪候选资格。只有二期或更晚、且同时满足以下条件才允许删除；任一条件失败时必须 fail-closed，保留全部候选并保持自动裁剪关闭：

1. 归档由当前已登录工具用户显式触发，操作者身份、用户选择的目标和导出结果已有审计记录；系统没有静默后台归档。
2. 每个候选 revision 已完成可验证归档；归档 manifest、内容 SHA-256、数量与范围验证通过，并能从裁剪证据反向定位完整内容。
3. 当前权威数据库已有独立备份，manifest 已验证，并在隔离路径完成恢复与完整性检查；备份及恢复验证标识可供 retention run 引用。
4. 已执行只读 dry-run，报告冻结 cutoff、当前数量、最旧/最新 revision、保留与候选集合、异常时间戳、预计释放字节和不可变对象校验结果。
5. tombstone 与 retention run 可以在删除前可靠持久化；任何归档、证据写入、删除、事务或回读验证失败都不得产生无证据删除。
6. 首次生产裁剪已获得明确维护窗口与删除授权，并先在隔离副本通过裁剪、幂等重跑、恢复和回滚验收。自动裁剪必须另行启用；上述能力和证据完成前保持关闭。

配置非法、归档不可验证、备份不可验证、恢复未验证、不可变对象校验失败或裁剪证据不完整时，必须产生可观测错误并禁止删除。任何实现都不得为了容量压力自动缩短 90 天窗口、降低最新 100 个下限或绕过归档。

#### 14.3.5 确定性、幂等与审计证据

- 正常工作区保存与 retention run 必须使用两个独立事务边界。保存事务只负责验证 `baseRevision`、更新当前态、插入新 revision 并提交；只有保存已经成功提交后，才允许通过独立显式命令或任务启动 retention run。即使由保存动作请求后续 retention，也不得在保存提交前执行任何归档预检、证据写入或删除。
- SQLite retention run 必须在自己的事务中原子写入 run/tombstone 证据并执行获准删除；任一预检、归档、证据、删除、回读或提交失败只回滚 retention 事务，保留全部候选、记录可观测告警且不得回滚已经成功的工作区保存。revision 冲突路径不得启动 retention。D1 必须提供等价事务分离与原子性，或可证明不会产生半完成删除的边界。
- 每个被裁剪 revision 必须先写入 tombstone，至少记录 revision、author、message、created_at、完整状态 SHA-256、pruned_at、策略版本、retention run ID、归档 manifest ID 和已验证备份/恢复标识。tombstone 证明受控删除，但不替代归档内容。
- 每次 retention run 至少记录幂等键、策略版本、冻结 cutoff、输入/保留/候选数量及集合哈希、异常集合、归档证据、备份恢复证据、操作者、开始/结束时间和结果。
- 相同策略、输入和幂等键重复运行不得重复删除、重复归档或生成重复 tombstone。部分失败重试必须先回读现有证据，再从可证明的状态继续。
- 删除前后必须验证当前 `WorkspaceState`、全部已发布 `ConfigurationSnapshot.contentHash`、领域审计、Patch、Trace 和发布记录保持逐字节或结构等价；任何差异都阻止提交。
- 已裁剪 revision 的精确读取必须返回“按策略裁剪”的明确结果，并提供可授权访问的 tombstone/归档引用；不得与“从未存在”或“数据损坏”混为一类。

#### 14.3.6 备份、归档与恢复边界

每日整库备份是灾难恢复点，不自动等于长期 revision 归档。在线保留期、备份保留期和归档保留期是三个独立策略，不能互相替代。恢复必须停服，把已验证副本恢复到新文件并保留原数据库作审计副本；不得为查看单条历史而覆盖生产数据库。包含飞书会话的整包备份不得直接延长为长期审计归档；二期本地归档包必须排除凭据并与会话副本隔离，压缩/加密、共享和访问方式由二期实现 Issue 评估，不阻塞一期。
### 14.3.7 工作区整包保存边界（Issue #96）

`PUT /api/state`是带`baseRevision`、授权和幂等命令包装的**普通工作区编辑**入口，采用默认允许：`templates`、`notes`、规则编辑器输入以及未来新增的普通顶层工作区字段都可以整包保存。服务端必须保留未知普通字段；不得因未把新字段加入 allowlist 返回422。`WorkspaceState.schemaVersion`、`revisions`和`importedAt`分别是迁移版本、保存事务恢复摘要和数据源发布回读元数据，不是客户端可编辑聚合：服务端在比较和持久化前必须以当前权威值投影它，避免第二标签页携带陈旧摘要阻断普通保存，同时绝不接受客户端降级schema、伪造历史或伪造导入时间。保存中的`baseRevision`失配仍返回409，且不写入部分状态、revision、审计或幂等结果。

默认允许不等于可绕过领域命令。以下现有权威聚合只能由括号中的命令或动作写入，嵌套修改也算修改；一个请求同时包含普通字段和任一受治理字段时必须**整体422**，不得部分保存：

| 受治理字段 | 原因 | 唯一写入动作/边界 |
| --- | --- | --- |
| `seriesPartRevisions`、`skuDrawers`、`purchasableModels`、`projectAffixDefinitions`、`skuLocalAffixCopies`、`derivedProjections`、`projectionMatches` | Part/SKU/Model身份、词条定义/局部副本和派生链 | v23使用`update_part_configuration`、`preview_weight_band_skus`（只读）、`create_sku`、SKU词条意图动作、`create_project_affix`、`set_sku_actual_quality`及允许的Model领域ActionCode/规则重算；`update_series_core_affixes`、`change_sku_target_pull`只服务Schema v9/v22历史兼容，不得创建或修改v23对象 |
| `seriesDefinitions` | `create_series`只创建不存在的Series；当前没有可更新既有v23 Series普通字段的领域动作 | 项目工作簿只保存server ref/hash；不得把“新建”与“编辑既有Series”混成同一Excel projection，未来提供明确update动作前不可导入 |
| `functionProfiles` | 当前是由canonical source派生的live聚合，没有独立且安全的successor动作 | 项目工作簿只保存server ref；不得以历史`ACTIVE`或缺少`status`的payload绕过生命周期边界，增删改全部阻断 |
| `v23AffixDefinitions` | `create_project_affix`只为新affix创建revision 1；既有affix ID或伪造next revision会409 | 项目工作簿只保存server ref/hash；不得承诺或模拟尚不存在的next-revision动作 |
| `v23TechnologyDefinitions` | 新Technology可在create payload声明`itemPartId`；但`update_technology`明确禁止既有definition改变部位 | `itemPartId`必须列入record schema的`exactFields`：create时按closed payload接受，匹配到既有definition后必须与服务端值exact-equal，跨部位修改整体阻断 |
| `qualityProfiles` | C/绿、B/蓝、A/紫、S/橙是固定品质映射，不是普通可编辑配置 | server-owned invariant必须恰好包含`quality_c_green/C/绿/1/enabled`、`quality_b_blue/B/蓝/2/enabled`、`quality_a_purple/A/紫/3/enabled`、`quality_s_orange/S/橙/4/enabled`；缺失、重复、换色/换字母/换rank或禁用均为contract drift |
| `partConstraintSets` | 含迁移field trace/evidence的`rawPayload`，且既有revision不可变 | 只由服务器在`POST /api/series`等明确领域流程中校验来源并物化新约束revision；原始证据只保留于服务器，项目工作簿不得携带或回写 |
| `candidateSearchRecipes` | v3 §6.5 的精确revision引用；既有revision不可变 | 当前没有修改既有revision的领域命令；只读保留，Recipe专用版本化命令尚未提供 |
| `v23SeriesPartHeads`、`v23SkuDrawerHeads`、`v23TechnologyHeads` | 指向当前单调revision的服务端head pointer，不是可任意回指的业务字段 | 只能由创建新Part/SKU revision或`update_technology`的既有领域命令随事务推进；technology head必须精确推进为current+1，不得从Excel指定历史revision、伪造next revision或直接换头 |
| `patchLedger`、`patchReviewBatches`、`patchValidationWaivers`、`patchValidationWaiverDecisions` | Patch revision、审核和waiver证据 | Patch create/review/rebase/mirror及waiver ActionCode |
| `projectionPatches` | 遗留 ProjectionPatch 的迁移/审计源；不得作为现行Patch命令旁路 | 当前只读保留，迁移流程处理；不得经整包保存删除、篡改或重放 |
| `configurationSnapshots`、`ruleSetVersions`、`reductionStackingPolicyVersions`、`performanceSummaryDefinitions`、`pricingPolicyVersions`、`fiveAxisViewDefinitions`、`fiveAxisVertexSets`、`workspacePolicies`、`candidateRuns`、`candidateMaterializations` | 已发布或不可变的版本、候选和冻结历史 | 相应发布、候选生成或物化命令；Snapshot只读/发布边界。ReductionStackingPolicyVersion必须由`POST /api/feishu-workbook`的显式工作簿拉取/RuleSet发布流产生；PerformanceSummaryDefinition当前只读，专用版本化发布命令尚未提供 |
| `canonicalRuleSourceDrafts`、`weightTemplatePolicyDrafts` | 显式拉取生成的内容哈希、行级来源和重量模板证据；RuleSet 草稿与发布必须精确引用它们 | `POST /api/feishu-workbook`的`pull`，随后`create_ruleset_draft` / `publish_ruleset`；不得伪造、覆盖或绕过拉取证据 |
| `configIdGovernance` | 永不复用的ID reservation ledger与策略/审计 | `config.id.*` ActionCode |
| `feishuWorkbooks`、`feishuSourceRevisions`、`sourceIdentityMigrationReports`、`dataSourceImports`、`dataSourceBindings`、`dataSourceWritebacks`、`importedAt` | 外部源回读、迁移和回写证据、远端record/field映射、写回基线与导入时间 | 显式检查/拉取、发布或回写动作；Binding和`importedAt`只能由`publish_data_source`或`commit_data_source_writeback`的回读重建 |
| `aiRuleSourceChangeDrafts`、`aiArtifactProvenanceSyncRecords` | AI草稿的命令哈希、人工确认、永久来源同步和幂等恢复证据 | `POST /api/ai/assessments/:assessmentId/drafts`创建/恢复草稿与来源同步；AI规则源草稿只能再经`POST /api/ai/rule-source-change-drafts/confirm`人工确认 |
| `qualityValuePolicyDrafts`、`pricingPolicyDrafts`、`upgradeCandidates`、`ruleChangeProposals`、`aiAssessments`、`identityAuditLog`、`commandIdempotencyRecords`、`governanceAuditLog`、`migrationReviewItems`、`revisions` | 服务器生成的规则草稿、升级、审计、幂等、迁移复核和工作区恢复证据 | 对应领域动作或成功的服务器保存事务；两类policy draft必须由飞书来源revision、sheet身份与input hash经服务器校验后派生，项目工作簿不得伪造provenance或直接创建；迁移复核证据当前只读，只能通过新的迁移流程处理 |
| `recipes`、`candidates`、`officialSkus`、`detailOverrides` | 只读旧产品历史及其Trace | 查看、导出或显式迁移；不可由整包保存覆盖 |

422必须为每个字段返回稳定字段名、原因类别、所需动作及其路由/ActionCode，UI必须保留未保存输入、将用户定位到对应动作，并提供重试；409必须显示最新revision和不丢失本地输入的恢复路径。该表是`WorkspaceState`整包写入的权威 denylist；新增普通字段不需要修订本表，新增权威聚合或领域命令则必须先同步修订本表、实现和回归。

验收至少覆盖：新增/编辑模板、备注和多个普通字段及未来未知普通字段保存并刷新后仍在；每类表中字段的顶层和嵌套改动拒绝；普通+受治理混合原子拒绝且revision/审计/幂等不变；过期revision、未授权、旧历史和已发布Snapshot冻结；成功、治理拒绝和冲突在真实界面均有可见、可操作反馈。

Technology successor另有不可省略的复合身份门禁：`v23TechnologyDefinitions`是唯一具有`technologyId + revision`复合身份的可导入根，不能因candidate composite key尚未匹配就猜作create。F2必须调用根清单绑定的`validateTechnologySuccessorAction`，以可信workspace/base/current-head/ID存在性/目标revision存在性回读区分create与update：create要求稳定ID及revision 1均不存在；update要求expected head与当前`technologyId + revision + contentHash + itemPartId`完全一致、candidate revision恰为`current + 1`、部位不变且目标revision不存在。两条路径都按生产`v23TechnologyContentHash`的RFC 8785契约重算`contentHash`；stale、缺head、伪hash、重复目标、换部位或错workspace/base均阻断。F2输出的create/update action payload只含生产动作输入，`revision/contentHash`仅校验而不得传入动作；update另携带`expectedTechnologyRevision`。generic exact validator仅保留既有同revision no-op/frozen比较，不得承担successor判定。

### 14.4 Patch台账远端schema、哈希、协作、回读与补偿契约

主工作簿中的唯一`Patch台账`使用稳定 sheet_id（具体值登记在代码 `CANONICAL_FEISHU_SHEET_REGISTRY`）识别。同一工作表包含两个行号互不关联的区域：`A:AK`是“一条Patch操作一行”的机器区，`AL`为空白分隔列，`AM:BA`是“一条协作事件一行”的追加事件区。工作表当前仍为空表；在以下表头、保护边界和联调完成前，真实镜像写入/拉取保持禁用，不得伪造`SYNCED`。

机器区列顺序固定为：

```text
scopeType, layerType, subjectEntityId,
workspaceId,
patchId, patchRevision, operationId, operationIndex,
subjectName, parentEntityId, parameterKey, operation,
operandJson, beforeJson, afterJson,
baseProjectionId, baseRuleSetVersion, baseObjectRevision,
reason, evidenceJson,
patchState, mirrorSyncState, attentionStatesJson,
createdByUserId, createdByDisplayName, createdAt,
reviewedByUserId, reviewedByDisplayName, reviewedAt,
supersedesPatchId, ruleProposalId, snapshotRefsJson,
operationContentHash, patchRevisionHash,
mirrorWriteId, mirrorWrittenAt, ledgerSchemaVersion
```

`scopeType`、`layerType`和`subjectEntityId`固定为前三列，`workspaceId`固定为第四列；四者均为受控机器字段。JSON字段先解析成JSON值，再按本节哈希契约规范化；时间使用UTC ISO-8601。名称只用于展示和搜索，关联必须使用稳定ID。工具按列写入，不整行覆盖；未知附加列原样保留，与机器列重名或破坏必需schema时产生`PATCH_MIRROR_SCHEMA_MISMATCH`。

协作事件区列顺序固定为：

```text
workspaceId, collaborationEventId, patchId, patchRevision, eventType, contentJson,
authorUserId, authorDisplayName, createdAt,
collaborationRevision, expectedCollaborationRevision,
supersedesEventId, relatedRuleProposalId, eventHash, mirrorWriteId
```

首版`eventType`固定为`NOTE_ADDED`、`REVIEW_OPINION_ADDED`、`SHARED_RULE_SUGGESTED`、`SHARED_RULE_SUGGESTION_ACCEPTED`、`SHARED_RULE_SUGGESTION_REJECTED`、`SHARED_RULE_SUGGESTION_WITHDRAWN`和`CORRECTION_ADDED`。`SHARED_RULE_SUGGESTION_ACCEPTED/REJECTED/WITHDRAWN`必须通过`supersedesEventId`引用其目标`SHARED_RULE_SUGGESTED`；目标必须已经存在、属于同一个`tuple(workspaceId: string, patchId: string, patchRevision: integer)`事件流且类型恰为`SHARED_RULE_SUGGESTED`，禁止引用其他状态事件或跨流事件。缺失、错误类型、跨流引用和循环引用均使追加失败并产生协作流冲突。

每条建议按原始`SHARED_RULE_SUGGESTED.collaborationEventId`独立折叠：建议事件创建`OPEN`状态，按`collaborationRevision`只接受第一条合法的`ACCEPTED`、`REJECTED`或`WITHDRAWN`终态事件；同一建议的后续终态事件视为冲突，不覆盖既有结论。`CORRECTION_ADDED`也必须用`supersedesEventId`引用同流既有事件，只补充更正证据而不改变建议终态；需要改变已形成的业务结论时创建新的建议事件。由此，同一Patch revision存在多条建议时也能按目标事件ID确定性折叠，不保存可覆盖旧历史的单一状态单元格。

#### 14.4.1 规范化JSON与SHA-256契约

`operationContentHash`、`patchRevisionHash`、`eventHash`和远端组校验统一使用`patch-mirror-hash/v1`：

1. 哈希输入是RFC 8785 JSON Canonicalization Scheme（JCS）输出的UTF-8字节；摘要算法为SHA-256，输出为64字符小写十六进制，不带`0x`、Base64或换行。
2. JSON对象键按JCS排序，数组保持业务顺序。参与哈希的JSON单元格必须先解析再规范化，禁止直接哈希单元格原始文本；`1`与`1.0`按JCS数值语义归一。
3. 必填字段缺失、重复对象键、非法UTF-8、`undefined`、`NaN`、正负Infinity或不能无损表达为JSON的值均是schema/error，不得用空字符串、`0`或`null`代替。可空字段必须以显式`null`参与哈希，空字符串仍是不同值。
4. ID、枚举、参数键和普通字符串按原始Unicode码点参与JCS，不做trim、大小写折叠、Unicode再归一化或本地化；时间必须先规范为UTC ISO-8601毫秒精度的`YYYY-MM-DDTHH:mm:ss.SSSZ`。
5. 每个`ledgerSchemaVersion`必须固定映射到一个哈希契约版本。改变算法、规范化方式、参与字段或排序即发布新契约版本；不得静默重写历史Snapshot、Patch revision或既有审计证据。

`operationContentHash`的规范输入对象固定包含：

```text
hashContractVersion,
workspaceId,
scopeType, layerType, subjectEntityId,
patchId, patchRevision, operationId, operationIndex,
parentEntityId, parameterKey, operation,
operand, before, after,
baseProjectionId, baseRuleSetVersion, baseObjectRevision,
reason, evidence,
createdByUserId, createdAt,
supersedesPatchId
```

其中`operand/before/after/evidence`使用解析后的JSON值。以下字段不参与`operationContentHash`：展示字段`subjectName/createdByDisplayName/reviewedByDisplayName`；可随流程变化的`patchState/mirrorSyncState/attentionStatesJson/reviewedByUserId/reviewedAt/ruleProposalId/snapshotRefsJson`；传输字段`mirrorWriteId/mirrorWrittenAt`；`ledgerSchemaVersion`；以及所有哈希字段本身。这些排除字段仍必须逐列与本地权威值核对，受控字段被改写仍产生`PATCH_MIRROR_TAMPERED`，不得因为“不参与内容哈希”而忽略。

`patchRevisionHash`的规范输入对象固定为`hashContractVersion + workspaceId + patchId + patchRevision + operations[]`。`operations[]`只包含`operationId/operationIndex/operationContentHash`，先按数值`operationIndex`升序，再按`operationId`的UTF-8字节序升序；同一revision内重复`operationId`或重复`operationIndex`均为冲突。飞书行号、当前排序、空白分隔行、显示字段、同步状态和镜像写入元数据不得参与组哈希。`expectedRemoteGroupHash`就是本地权威revision的`patchRevisionHash`；远端回读后按相同规则重算，禁止信任远端单元格中自报的组哈希。

`eventHash`的规范输入对象固定包含`hashContractVersion/workspaceId/collaborationEventId/patchId/patchRevision/eventType/content/authorUserId/createdAt/collaborationRevision/expectedCollaborationRevision/supersedesEventId/relatedRuleProposalId`。`content`使用解析后的JSON值；`authorDisplayName`、`mirrorWriteId`和`eventHash`本身不参与。事件回读必须按`workspaceId + collaborationEventId`验证唯一性、按同工作区同Patch revision内的`collaborationRevision`验证连续性并重算哈希；远端行序不参与事件哈希或事件流顺序。

远端回读必须先验证每行的`workspaceId`存在且类型正确。具有合法`workspaceId`但不属于当前工作区的行不在本次同步范围内，必须原样跳过，不产生当前工作区的Issue、冲突或阻断；缺失或类型错误的`workspaceId`无法安全归属，产生`PATCH_MIRROR_SCHEMA_MISMATCH`并隔离该行。完成工作区过滤后，再以`tuple(workspaceId, patchId, patchRevision, operationId)`重建机器明细身份、以`tuple(workspaceId, patchId, patchRevision)`重建组和协作流；纳入当前工作区的同一组中，全部机器行、事件行和本地命令必须具有相同`workspaceId`，不一致时产生`PATCH_MIRROR_HASH_MISMATCH`并隔离异常行。不得从连接器默认工作区、Patch ID、工作簿或其他行推断或补齐`workspaceId`。

#### 14.4.2 幂等、组级事务与镜像同步

明细幂等键和组级事务边界在数据库内必须使用带类型的真正复合唯一键，不得拼接为无边界字符串；同步命令跨系统需要标量键时，使用JCS对象摘要：

```text
detailKey = tuple(workspaceId: string, patchId: string, patchRevision: integer, operationId: string)
groupKey = tuple(workspaceId: string, patchId: string, patchRevision: integer)
syncIdempotencyKey = sha256Hex(JCS({
  "keyType": "patch-mirror-sync/v1",
  "workspaceId": workspaceId,
  "patchId": patchId,
  "patchRevision": patchRevision,
  "patchRevisionHash": patchRevisionHash
}))
```

上述JCS对象中的`workspaceId/patchId/patchRevisionHash`必须是JSON string，`patchRevision`必须是JSON integer。若存储或协议要求把`detailKey/groupKey`表示成单一字符串，必须分别对包含`keyType="patch-mirror-detail/v1"`或`keyType="patch-mirror-group/v1"`的JCS对象计算SHA-256；两类对象都必须显式包含`workspaceId/patchId/patchRevision`，明细对象再包含`operationId`，并保留上述JSON类型。禁止使用分隔符约定、隐式`toString()`或裸值连接。键字段缺失或类型不符直接报schema错误，不做字符串强制转换。

同一工作区同Patch revision的所有远端明细共享一个`mirrorWriteId`。同步固定执行：读取本地完整组→按`workspaceId + patchId + patchRevision`写前回读远端→校验`expectedRemoteGroupHash`→续写缺失明细→回读完整组→校验`workspaceId`、操作数量、明细键、`operationIndex`、行哈希和整组哈希。全部一致后才可标记`SYNCED`。相同明细键但内容哈希不同视为冲突，不得自动覆盖；修改业务内容必须创建新Patch revision或完成rebase。

#### 14.4.3 协作事件原子compare-and-append

`collaborationRevision`的作用域固定为复合键`tuple(workspaceId: string, patchId: string, patchRevision: integer)`对应的一条本地协作事件流；不同Patch revision互不共享计数，禁止用裸字符串连接表示流键。revision从`1`开始严格递增，首个追加命令使用`expectedCollaborationRevision=0`。`collaborationRevision`由服务端分配，客户端和飞书均不得自行选择、回退或填补。

追加命令必须携带`collaborationEventId`、`expectedCollaborationRevision`和独立`idempotencyKey`，并在本地`PatchLedger`事务中原子执行：锁定事件流头→按幂等键恢复既有结果→比较expected与当前head→分配`head + 1`→持久化不可变事件及新head。只有本地提交成功后才异步镜像到飞书；远端追加成功与否不改变本地事件已经成立的事实，也不能由飞书分配revision。

- expected等于当前head时追加成功；同一幂等键重试且Payload/hash相同必须返回原结果，不得重复事件。
- 同一幂等键或`collaborationEventId`对应不同Payload/hash时返回幂等冲突并保留双方证据，不得覆盖。
- expected落后于当前head时不得追加，返回`COLLABORATION_REVISION_CONFLICT`、当前head以及从expected之后新增事件的ID/hash摘要；服务端不得替用户自动改写expected。
- 客户端收到revision冲突后必须重新读取并折叠最新事件流，展示并保留用户尚未提交的内容；用户确认后以新的`collaborationEventId`、新的`idempotencyKey`和最新expected重新提交。若请求超时或结果不确定，必须先按旧幂等键或eventId查询结果，不能直接创建重试事件。
- 远端回读发现revision重复、间隙、eventId重复或eventHash不符时进入`CONFLICT`并隔离异常行；不得重排、补造或覆盖本地事件。远端缺失的已知事件按eventId幂等补写。

#### 14.4.4 远端异常、恢复与Capability

`ValidationIssue(source="patch")`的远端异常契约为：

| code | Severity / Gate | 必须行为与Action |
| --- | --- | --- |
| `PATCH_MIRROR_UNKNOWN_PATCH` | `ERROR / NONE` | 隔离未知行、展示证据；禁止按名称认领或自动导入 |
| `PATCH_MIRROR_DUPLICATE_KEY` | `ERROR / NONE` | 整组进入`CONFLICT`；比较重复行，显式按本地权威重建 |
| `PATCH_MIRROR_TAMPERED` | `BLOCKER / NONE` | 保存篡改证据；禁止自动覆盖，显式确认后重建镜像 |
| `PATCH_MIRROR_ROW_MISSING` | `ERROR / NONE` | 整组退出`SYNCED`；按幂等键补写 |
| `PATCH_MIRROR_GROUP_INCOMPLETE` | `ERROR / NONE` | 整组不可同步生效；续传缺失操作 |
| `PATCH_MIRROR_WRITE_PARTIAL` | `ERROR / NONE` | 先回读实际结果，再安全重试 |
| `PATCH_MIRROR_SCHEMA_MISMATCH` | `BLOCKER / NONE` | 停止远端同步；修复schema后重新回读 |
| `PATCH_MIRROR_HASH_MISMATCH` | `BLOCKER / NONE` | 保存本地与远端规范Payload及摘要；禁止自动覆盖 |
| `PATCH_COLLABORATION_STREAM_CONFLICT` | `ERROR / NONE` | 隔离重复、间隙或hash异常事件；按本地事件流补偿 |
| `PATCH_SUBJECT_ORPHANED` | `ERROR / REVIEW` | 保留原ID与历史引用；阻止批准并约束后续发布；恢复稳定引用或人工迁移，禁止按名称重绑 |
| `PATCH_SUBJECT_MIGRATION_INVALID_TARGET` | `ERROR / REVIEW` | 不创建新revision；保留ORPHANED源revision并重新选择同工作区的兼容稳定引用 |
| `PATCH_SUBJECT_MIGRATION_CONFLICT` | `ERROR / REVIEW` | 不创建分叉revision；返回当前head与已提交迁移证据，重读后由用户显式重试 |

镜像Issue的`gate=NONE`表示不阻断本地Patch重放和既有Snapshot，但对应镜像组不能显示`SYNCED`。`PATCH_SUBJECT_ORPHANED`使用`gate=REVIEW`阻止批准，并按统一Gate语义约束后续发布；重放不是Gate，服务端必须另外把该Patch的重放、rebase和普通编辑`ActionAvailability`设为禁用，只保留查看证据与`migrate_patch_subject`恢复动作，后者要求`patch.subject.migrate` Capability。既有Snapshot不受影响。行排序或移动不影响关联；隐藏和过滤行仍必须读取；删除或清空按缺行处理。

镜像动作必须分别声明ActionCode与Capability：`write_patch_mirror`要求`patch.mirror.write`，`pull_patch_mirror`要求`patch.mirror.pull`，`inspect_patch_mirror`要求`patch.mirror.inspect`，`repair_patch_mirror`要求`patch.mirror.repair`，`rebuild_patch_mirror_from_local`要求`patch.mirror.rebuild_from_local`，`fix_patch_mirror_schema`要求`patch.mirror.schema.repair`，`migrate_patch_subject`要求`patch.subject.migrate`。`repair_patch_mirror`不得覆盖内容冲突；`rebuild_patch_mirror_from_local`、`fix_patch_mirror_schema`和`migrate_patch_subject`必须二次确认、记录before/after证据并在执行时重新鉴权。当前由`separation-of-duties/open009-v2`分配这些Capability；OPEN-010不得自行扩大授权。

“拉取”只执行镜像核对、已知协作事件同步和冲突发现，绝不以飞书机器区覆盖本地Patch、删除本地Patch或修改Snapshot。写入超时或部分失败必须先回读；保留已经成功且哈希一致的行，整组进入`WRITE_FAILED`，重试只续写缺失操作。重复、篡改或哈希冲突必须保存远端原始证据；只有用户显式执行“按本地权威重建镜像”后才可修复，并再次完整回读。补偿失败不得回滚或改变本地Patch。

飞书同步不得自动rebase。基线变化只使本地Patch进入`REBASE_REQUIRED`：`add`、`multiply`及目标仍合法的`clear`可以确定性重放，但新revision最多进入`PENDING_REVIEW`；`set`必须人工复核；参数删除、重命名、类型或单位变化以及不再表示继承覆盖的`clear`必须人工rebase。rebase创建新的`patchRevision`；可对应的操作沿用`operationId`，新增操作使用新ID。rebase期间基线再次变化则本次结果作废并基于最新基线重来。原revision、有序操作、Snapshot引用和PatchSetHash永久保留。

#### 14.4.5 Patch主体迁移与不可变revision

`patch.subject.migrate`固定采用“创建新Patch revision”，不建立会让旧revision改指向的可变别名或独立覆盖绑定。命令必须携带`workspaceId`、`patchId`、`sourcePatchRevision`、`expectedHeadPatchRevision`、`expectedSubjectEntityId`、`targetSubjectEntityId`、目标对象revision、理由和`idempotencyKey`。服务端只允许迁移当前head且处于`ORPHANED`注意状态的revision；目标必须属于同一工作区，并与scope、layer、对象类型、父链和参数类型/单位兼容，禁止按名称推断目标。

```ts
interface PatchSubjectMigrationResult {
  migrationId: string;
  workspaceId: string;
  patchId: string;
  sourcePatchRevision: number;
  sourceSubjectEntityId: string;
  sourcePatchRevisionHash: string;
  targetSubjectEntityId: string;
  targetObjectRevision: string;
  newPatchRevision: number;
  newPatchState: "PENDING_REVIEW" | "REBASE_REQUIRED";
  newPatchRevisionHash: string;
  idempotencyKey: string;
  migrationCommandHash: string;
  migratedByUserId: string;
  migratedAt: string;
}
```

`PatchSubjectMigrationResult`与对应新revision在同一事务中创建，一旦提交即不可变；成功响应不得返回或暗示“原revision已换绑”。

命令在本地`PatchLedger`事务中锁定Patch head，重验`expectedHeadPatchRevision + expectedSubjectEntityId`，然后以严格单调的新`patchRevision`复制有序操作，可对应的操作沿用`operationId/operationIndex`，将新revision的`subjectEntityId`改为显式目标，并重算全部`operationContentHash`与`patchRevisionHash`。冻结基底完全兼容且确定性重放通过时，新revision最多进入`PENDING_REVIEW`；基底、参数或继承语义变化时进入`REBASE_REQUIRED`，不得自动`APPROVED/ACTIVE`。新revision以`NOT_SYNCED`开始，后续镜像写入只能追加新组，不得覆盖旧远端行。

源revision的`subjectEntityId`、父链、有序操作、业务状态、哈希、远端镜像行和审计证据永久不变；已有ConfigurationSnapshot继续引用源revision和原主体，其有序Patch引用、PatchSetHash、Trace和Snapshot hash不得跟随迁移。新revision保存源revision、原/目标稳定引用、执行人、时间、理由、迁移命令hash和验证结果作为不可变迁移证据。

同一`idempotencyKey`与相同命令Payload/hash重试必须返回同一新revision；同一键对应不同Payload/hash返回幂等冲突。两个迁移命令并发指向同一或不同目标时，只有第一个能在expected head上提交；其余返回`PATCH_SUBJECT_MIGRATION_CONFLICT`、当前head与已提交迁移证据，不得创建分叉revision或自动改写目标。

联调准入至少覆盖：首次整组写入与回读；相同命令重复执行不重复追加；两个工作区使用相同`patchId + patchRevision + operationId`时，远端行、内容/组哈希和协作流仍完全隔离；当前工作区回读时，其他工作区具有合法`workspaceId`的行被原样跳过且不产生Issue、冲突或阻断；缺少、类型错误或遭篡改而无法安全归属的`workspaceId`行不能归属任何本地组；三行只写成两行时不标记`SYNCED`并可续传；请求超时但远端已写入时先回读而不重复追加；删除一行后产生缺行Issue并补写；重复键、未知ID、机器字段篡改、hash不符和schema缺失正确隔离；两个客户端同时追加协作事件时只有一个expectedRevision成功，冲突方可在重读后显式重试；主体迁移重试不重复建revision，两个并发目标只有一个成功，旧revision、原主体引用和历史Snapshot全部不变；基线变化生成新revision且历史Snapshot不变。

## 15. 工作台信息架构

1. 数据源与参数注册表；
2. 模板与规则实验室；
3. 兼容规则与Affinity；
4. 派生模板浏览器；
5. Collection/Series设计器；
6. SKU重量跨度与抽屉；
7. Model和配置明细；
8. 属性词条库；
9. 被动技能库；
10. Technology编辑器；
11. 审阅、发布、版本和规则学习。

每一级预览固定展示：来源、before、operation、operand、after、优势/代价、兼容解释、Patch和校验状态。

被动技能只显示设计字段、分值、稀有度、技术来源和玩家文案。

“数据源与参数注册表”中的飞书分享链接入口服务于**数据导入**（重量段模板或流派/定位系数的拉取、预览、发布与回写），与第14节的canonical规则源工作簿互不冲突：用户在数据交换页粘贴并从历史选择的是飞书多维表格（`/base/`）分享链接，经显式“识别链接”解析后仍须按现有治理分别执行预览、冲突检查、人工确认发布与回写，绝不自动发布或绕过stable ID。历史只保存shareUrl、显示名、数据类型和最近使用时间，不保存任何应用密钥、appToken凭据或个人身份信息；该入口不得用于改写canonical规则源工作簿指向。

### 15.1 项目数据Excel往返

Excel只是当前项目数据的导入/导出载体，不决定记录的编辑资格或计算资格。内置xlsx/JS快照仅是新项目默认基础数据与发布构建输入；用户导入、UI新增和内置记录遵循相同领域规则，不再区分“权威/自定义”资格。项目工作簿不得承担跨工作区克隆、恢复、正式配置交付、凭据传递或外部绑定迁移。

一期项目往返契约固定为`project-workbook/v1`。机器权威是版本化根清单`docs/spec-v3/project-workbook-v1-root-manifest.json`，其完整UTF-8内容由`docs/spec-v3/manifest.json`以SHA-256绑定。清单从当前`WorkspaceState`提取93个顶层根，并要求每个根恰好属于下列一类；新增、遗漏、重复或未知分类均使契约检查失败：

| 分类 | 当前根数 | 工作簿语义 |
| --- | ---: | --- |
| `importable_current` | 15 | 可按机器清单逐根绑定的真实production successor导入的当前可变项目数据；每个根必须命中closed record schema，逐记录校验稳定ID、revision、引用与不变量。 |
| `preserved_frozen` | 23 | 为同工作区无损往返携带的安全冻结版本、历史或治理证据；只允许服务端导出的opaque canonical payload与hash exact-equal，不得新增解释、改写或删除。`performanceProfiles`及旧`recipes/candidates/officialSkus/detailOverrides`亦属于只读历史。 |
| `server_owned` | 30 | 工作区身份、schema、Config ID治理、Patch台账、固定品质映射、既有Series与v23 affix命令边界、Part/SKU/Technology head pointer、含raw迁移证据的约束集、飞书来源派生policy draft、含legacy raw payload的定价版本、外部拉取草稿、幂等与审计等服务端权威；还包括canonical source派生且无独立安全successor的`functionProfiles`、直接参与正式评分却没有安全工作簿successor的`affixScorePolicy`，以及没有已证明successor领域动作的`compatibilityRules/affinityRules/purchasableModels/v3Affixes/technologies/qualityBands/ruleGraphs`。工作簿只绑定服务端生成的非敏感opaque reference，不能携带可回写payload。 |
| `forbidden` | 15 | 飞书token/工作簿/源revision、AI规则源外部目标、数据源/配置导出、未知原始迁移payload等外部绑定、敏感证据或正式交付配置；不得进入工作簿机器payload，出现即阻断。 |
| `export_only_diagnostic` | 10 | 可读且已闭合/脱敏的诊断投影；导入时不生成写操作，不能覆盖服务端重算结果。 |

清单中的`lineEndings: LF`应用于所有递归JSON string value与object key：先拒绝未配对surrogate，再把CRLF与lone CR统一为LF，然后执行NFC、规范化后key collision检查、排序与hash；输入含非LF换行的JSON因此不是canonical表示，不能以旧CR/CRLF hash重放。

`machineContentHashEncoding`固定为`RFC8785_ORDERED_SHEET_ROW_PAIR_ARRAY_V1`，其唯一preimage是RFC 8785编码的`[[sheetName, rows], ...]`：sheet顺序逐字取`machineContentHashInput`；Manifest项只包含除`machine_content_sha256`自身外的closed字段对象；其余每行是按该Sheet closed列名表达的文本cell对象，行先按根清单顺序、再按主键Unicode scalar/code point逐个数值比较并拒绝重复主键；共享前缀较短者在前，补充平面字符不得按UTF-16 surrogate code unit误排到BMP私用区之前。`__TF_SERVER_REFS`是必需但独立验证的transport sheet，明确排除于语义preimage；不得以按sheet对象、字符串拼接、流式串联、重排sheet/row或另一include/exclude集合产生替代hash。

`ROOT_SUMMARY`必须恰好包含根清单顺序中的93个根且每根一次，classification必须与机器分类逐字一致。其`root_content_sha256`格式为closed `lowercase-sha256-or-null`：`importable_current`、`preserved_frozen`与`export_only_diagnostic`必须从该根closed记录数组重算lowercase SHA-256并让`record_count`一致；`server_owned`与`forbidden`的`record_count`必须固定为文本`0`且hash必须为文本`null`，不得从raw、unknown、preserved或敏感内容派生摘要。该表仍是派生可读表，不进入machine semantic hash。

机器工作簿schema完整内嵌于根清单，Sheet集合与顺序固定为`__TF_MANIFEST`、`__TF_CURRENT`、`__TF_PRESERVED`、`__TF_SERVER_REFS`、`__TF_FORBIDDEN`、`__TF_DIAGNOSTICS`、`README`、`ROOT_SUMMARY`；每张表的列、类型、必填性、格式、主键和基数均为closed schema。所有机器单元格必须是非空Excel文本；安全整数、十进制、lowercase 64-hex hash、RFC 8785 JSON、显式`null`和opaque ref各有独立格式，数字/日期/布尔/error/formula单元格一律拒绝。普通closed payload中的JSON number只要求RFC 8785可表示且有限，允许小数、`1e20`及超过`Number.MAX_SAFE_INTEGER`的有限双精度值；identity、revision、record key与safe-integer文本仍必须是安全整数，二者不得共用一刀切validator。`display-text`输入本身必须已经是LF与NFC canonical：LF合法，CRLF、lone CR、非NFC别名、未配对surrogate和禁止控制字符均在显示前拒绝，不能先normalize再接受。`record_key`必须以closed projected/opaque payload为唯一身份来源：逐identity field path深取值，按真实类型校验NFC文本或安全整数并与每个key component exact-equal；singleton只接受固定`$singleton`。checker还必须直接从`recordSchemas[*].identityFields == ["$singleton"]`和`preservedRootCatalog[*].singleton == true`派生两张记录表的singleton根，并要求每个根恰好一行；非singleton继续允许零行或多行，不得维护另一份硬编码singleton清单。mixed union variant必须由payload所含字段与该variant identity fields唯一证明，调用方标签不能指定或覆盖variant。`record_revision`自身是RFC 8785 scalar JSON：数值revision写成安全整数`1`，字符串revision写成JSON string`"v1"`，缺失revision才写`null`；因此`null`、`"null"`、`1`、`"1"`互不等价。checker必须按root/union variant从真实revision field解析number/string及optional语义，并要求row revision与payload字段以及record key中相同identity字段逐值一致。`record_content_sha256`不能只校验64位小写hex：checker必须取得完整closed row envelope，先复用同一套root、schema ID、typed key、typed revision与canonical payload验证，再按`recordHashInput`顺序构造`[[\"root\", root], [\"record_schema_id\", schemaId], [\"record_key\", parsedKey], [\"record_revision\", parsedRevision], [\"canonical_payload\", parsedPayload]]`的RFC 8785 JSON并计算SHA-256，最后作定长exact compare；任一字段或hash漂移均阻断。`__TF_MANIFEST`唯一行精确绑定`contract_version + workspace_id + base_workspace_revision + root_manifest_sha256 + workbook_schema_sha256 + exporter_version + machine_content_sha256`；三种hash都必须取得closed workbook context并按根清单声明的唯一输入重算：根清单hash覆盖当前清单UTF-8 bytes，schema hash覆盖`workbookSchemaHashInput`逐项有序二元组，machine content hash覆盖除自身hash格外的Manifest字段及四张语义机器表；缺context、include/exclude漂移、字段/行/schema篡改均阻断。`__TF_CURRENT`只承载15个可导入根，统一record envelope为`root + record_schema_id + record_key + record_revision + record_content_sha256 + payload_json`；机器清单为每个根逐项固定schema ID、稳定identity fields、revision fields、hash fields、exact-equal fields和允许的递归payload投影。`payload_json`不只检查RFC 8785表示，还必须按该root的hash-bound TypeScript递归图验证required/optional字段、nested object/array/union、标量类型与closed unknown-field边界；caller variant不能替换payload自行证明的variant。显式`Record<string, T>`只在`T`仍为封闭已知类型时允许动态NFC键；`unknown`、`any`或未声明index value不得进入importable projection，只能存在于`OPAQUE_SERVER_EXPORT_ONLY_EXACT_COMPARE_NO_CLIENT_CONSTRUCTION`冻结边界。`WorkspaceState.notes`的唯一payload表示是RFC 8785 JSON string（包括允许空字符串），不得再接受`{\"value\":...}`对象包装；同一schema ID因此只有一种canonical hash输入。版本化定义的revision/version必须进入复合record key。任何`unknown`、`any`、`Record<string, unknown>`或`unknown[]`路径若未被明确排除并由服务端重派生即拒绝；例如`skuDrawers.validationSummary/projectionMatch/fiveAxisProjectionReferences`不进入可导入投影。固定品质映射、既有Series、v23 affix revision、Part/SKU/Technology head pointer、含raw迁移证据的constraint set以及必须验证飞书provenance的policy draft均归`server_owned`，不得借closed JSON外观进入可导入或preserved payload。没有真实production route及原子successor语义的版本化根同样必须`server_owned`；界面直接改`WorkspaceState`或仅在ActionCode目录出现名字不构成安全动作证明。若F1不能从被hash绑定的声明生成并验证closed解析器，或没有能把projection翻译成既有安全领域命令的路径，该根不得导出或导入，不能回退为开放JSON。

当前15个可导入根由机器化`importableSuccessorCatalog`逐根证明；每项必须分别声明transport boundary、§14.3.7语义修改权威与规范依据，`PUT /api/state`本身不能冒充字段可变性的证明。`skuDrawers`与`v23TechnologyDefinitions`绑定既有领域命令；其余根分别绑定规则设置、部件、profile、Affinity、集合、参数、模板Patch层、modifier、layer、affix、Series展示或工作区备注编辑权威。`affixScorePolicy`虽由正式评分引擎直接消费，但没有独立安全successor，因此归`server_owned`；工作簿新增、修改或删除全部拒绝，既有engine scoring语义不变。

`__TF_PRESERVED`只承载清单允许且不含敏感/raw evidence的冻结根；其record envelope固定包含`root + record_schema_id + record_key + record_revision + record_content_sha256 + opaque_canonical_payload_json`，并使用与current相同的完整行哈希重算规则。F0验证器还必须另取服务端按`workspace_id + base_workspace_revision + root + record_key`回读的closed expected context；在接受任何`ROOT_SUMMARY` count/hash或machine content hash之前，candidate与trusted rows必须先按`root + record_key`形成无重复集合，并对每项`record_schema_id`逐项exact，集合必须完全相等。trusted non-singleton遗漏、candidate额外行、重复identity、错root/key/schema/workspace/base revision均拒绝；`MERGE_BY_STABLE_ID`与`REPLACE_PROJECT`都不得把缺少冻结行解释为删除。缺expected、schema/revision/payload/hash漂移同样拒绝。candidate自行重算的hash不是可信expected；payload以固定长度SHA-256比较并再作canonical text exact-equal，content hash以固定长度比较。F1尚未取得真实服务端readback时只能保留此接口契约，不得返回伪成功。每个冻结根必须绑定版本化`record_schema_id`；mixed union的每个variant分别绑定稳定schema ID，且schema ID必须由closed payload唯一证明，调用方标签或另一variant的schema ID不能覆盖。清单逐根以实际WorkspaceState元素`typeRef`声明records、variant-records或whole-root singleton载体，nullable scalar不得压缩为非nullable类型：`currentFiveAxisDispositionCatalogRevisionId`必须绑定`string | null`，canonical payload只接受JSON string或`null`。checker必须从`WorkspaceState.<root>`属性本身解析数组元素/标量alias，解析跨文件type-only import到真实声明文件，并要求目录`typeRef`逐字匹配；不能因另一个interface恰好含同名key/hash字段而接受错绑。随后再把record key、revision与hash的每条field path机器校验到对应interface。union必须从WorkspaceState实际元素alias出发枚举全部variant且分别给出可实现的字段规则；例如旧五维vertex用`definitionId + definitionVersion + fishWeightGradeId + fiveAxisRuleVersion`，新vertex用`vertexSetId`，不能假设两个variant共享不存在的字段。冻结payload的全部递归TypeScript类型图及其跨文件依赖必须由精确authority source hash与递归图hash共同绑定；漏列、额外列、外部依赖变化或任一可达嵌套声明变化均为schema drift。图中既有`unknown`、`any`或raw动态值只允许处于`OPAQUE_SERVER_EXPORT_ONLY_EXACT_COMPARE_NO_CLIENT_CONSTRUCTION`边界：`opaque_canonical_payload_json`只能由服务器导出并exact-compare，客户端不得构造、解释、导入、写回或生成移除操作。`__TF_SERVER_REFS`逐root绑定`NO_CONTENT_HASH + DETERMINISTIC_IDENTITY_BOUND_NON_SENSITIVE`，`root_content_sha256`固定为文本`null`；transport行按`project-workbook-server-ref-transport/v1`闭合绑定`transport_contract_version + workspace_id + base_workspace_revision + root + classification`，`opaque_server_ref`只能是这些公开身份字段的canonical SHA-256 token，不能读取、包含或派生自raw/preserved/readback/敏感payload。transport sheet不进入`machine_content_sha256`，但每次解析仍必须独立验证版本、工作区、revision、root全集、排序和token；伪造、错工作区、错revision、缺根或重复根全部阻断。`__TF_FORBIDDEN`只保存固定`FORBIDDEN_PAYLOAD_OMITTED`标记，严禁从敏感/可猜内容生成hash或ref。`__TF_DIAGNOSTICS`使用版本化closed字段；10个diagnostic根必须逐根绑定真实WorkspaceState元素`typeRef`与仅含稳定subject identity的安全投影。每行内嵌canonical `subject_payload_json`，`record_key`固定为`[SHA256(RFC8785([[fieldPath,value], ...]))]`并只从同一行的exact closed subject payload重新计算；`issue_fingerprint`从`root + record_key + schema version + subject payload + severity + code + message + subject_ref`的完整非派生closed issue envelope计算SHA-256，随后`diagnostic_evidence_sha256`再覆盖该fingerprint。主键固定为`root + record_key + code + issue_fingerprint`，因此同subject/code的不同issue均保留，完全重复issue因重复主键拒绝；伪fingerprint、错排序、未知根、额外字段、错key、错payload或evidence hash漂移均拒绝。severity闭合集合为`INFO/WARNING/ERROR/BLOCKER`，其他值拒绝。诊断payload绝不生成写/导入操作，message/severity为显示信息，整张diagnostic表排除于项目语义hash，诊断变化不得改变项目等价性。

规范化固定为UTF-8、Unicode NFC、LF、RFC 8785 JCS、有限数值、`-0→0`且blank与null不同；普通payload number保持RFC 8785有限数值语义，只有身份、revision与key上下文额外要求安全整数。任何JSON string或object key都必须先递归拒绝未配对UTF-16 high/low surrogate，合法surrogate pair保持为对应Unicode scalar，再执行NFC。JSON对象在NFC后发生key collision立即拒绝，再按规范化key排序，禁止以原key排序后再改写造成不可重放hash。记录按根清单顺序再按主键Unicode code point排序。`workbook_schema_sha256`精确覆盖清单中的workbook schema、canonicalization、递归record schema权威、逐根record schemas、冻结根载体目录、冻结schema目录、冻结递归type graph权威、terminal lifecycle、transport ref、server-owned固定不变量与93-root分类；record hash覆盖root、schema ID、record key、revision与canonical payload；machine content hash仅覆盖Manifest身份、可导入、冻结与forbidden omission语义机器表，明确排除server ref transport、自身hash单元格、diagnostics及两张派生可读表。语义等价只由规范化machine content SHA-256相等决定；transport完整性是独立且不可跳过的接受边界。

`feishuWorkbooks`、`feishuSourceRevisions`、`aiRuleSourceChangeDrafts`、`dataSources`、含`rawWorkspacePayload/rawSourcePayload/preservedPayload`的迁移根及其他`forbidden`根的payload不得导出；`server_owned`与`forbidden`根如需证明一致，只能绑定服务端生成的非敏感content hash或opaque reference，不得携带`spreadsheetToken`、`wikiToken`、`appToken`、share URL、凭据、未知原始payload或可重放外部句柄。

导入必须显式选择且语义固定：

- `MERGE_BY_STABLE_ID`：只按稳定ID合并。工作簿中缺少当前记录表示`NO_OP`，绝不推断删除；显示名变化不得重写引用ID。
- `REPLACE_PROJECT`：工作簿中缺少当前`importable_current`记录表示`REMOVAL_INTENT`，不是静默忽略。移除只可规划为该实体已有的专用安全删除/废弃命令，并须重新校验生命周期、引用和冻结边界；没有专用安全命令或资格不满足时返回`REMOVAL_NOT_SUPPORTED`并阻断整次提交。`preserved_frozen`、`server_owned`、`forbidden`与`export_only_diagnostic`永远不能借“缺少”表达删除。

即使根属于`importable_current`，匹配既有记录时record schema列出的全部真实`identityFields`与全部`revisionFields`必须自动加入exact比较，再与hash、source provenance、发布时间、其他`exactFields`及适用的conditional exact fields共同验证；`$singleton`只是行identity pseudo sentinel，不得作为payload path取值，也不得与真实identity field混用。来源策略必须从hash-bound TypeScript递归图发现全部`source*`/`provenance*`路径，并为每个命中根显式选择conditional full-exact或authorized layered edit；新增、遗漏、unknown、partial或伪造selector一律fail closed。`methodProfiles/itemTypeProfiles`在可信顶层`sourceRevisionId`存在时全部allowed fields exact，本地无来源形状仍按profile编辑器修改；`templates`要求`sourceRevisionId + sourceSheetId + sourceRow`全有或全无，来源字段自身exact，但§14.3.7继续允许`TEMPLATE_EDITOR_PATCH_LAYER`修改`values`等普通字段。`modifiers/layers/affixes`中的`AdjustmentRule`来源三元组`sourceRevisionId + sourceSheetId + sourceCell`同样全有或全无；既有来源rule不得删除或改写三元组，新建/本地rule不得伪造来源，但其普通规则值继续由各自编辑器修改。单字段、复合及未来nested identity path均按真实声明类型深取值并以canonical typed value比较，missing、number/string替换、identity或revision漂移均阻断；record envelope的key仍必须从candidate payload相同identity重算，因此candidate不能通过换ID逃离已匹配existing记录。新建记录通常只做closed payload校验，不因不存在existing revision而误阻断；但任何携带server-derived revision/hash的importable root必须有清单化create policy，未来新增漏绑立即contract drift。`skuDrawers`的policy为`REJECT`：工作簿不得新建SKU，新增必须显式执行v23 `create_sku`；匹配既有SKU时只有非终态`targetPullKg`可变，其他受支持字段全部exact-equal，且不得改变`v23SkuDrawerRevisions`冻结证据或`v23SkuDrawerHeads`服务端head。`v23TechnologyDefinitions`的新记录使用`DERIVE_AND_VERIFY/create_technology`：必须是此前不存在的`technologyId`、`revision=1`，并按与生产`v23TechnologyContentHash`相同的RFC 8785 SHA-256契约，从`technologyId + revision + itemPartId + name + description + memberAffixRefs + enabled`重算`contentHash`；任一缺字段、伪hash或任意revision均阻断，F2不得旁路该closed create projection。create/update projection输出必须是可直接交给生产`executeV23DomainAction`的closed `actionCode + actionPayload`映射；payload包含与request及trusted base一致的`expectedWorkspaceRevision`，并用生产`v23ActionInputHash`等价契约对除`inputHash`外的完整payload计算RFC 8785 SHA-256。缺失或伪造revision/hash、hash后改变payload、create/update字段错配均阻断。匹配既有`technologyId + revision`后全部payload字段exact-equal，工作簿只表达计划；更新只能由`update_technology`校验当前revision后派生`current + 1`、重算hash并推进server-owned head。`parameters`新记录可声明初始`key`，但既有记录的`id + key`共同exact-equal；参数重命名只能由未来专用迁移原子改写template values、rule parameterKey与formula token引用，项目工作簿不得做跨根字符串替换。`functionProfiles/compatibilityRules/affinityRules/purchasableModels/v3Affixes/technologies/qualityBands/ruleGraphs`均不进入current payload；缺少真实successor动作时，其增删改全部阻断。只有清单允许且不在identity、revision、无条件、条件式或terminal lifecycle exact策略中的字段才可经已有领域动作进入计划。terminal policy不按root写分支，而从每个record schema的`allowedFields`与闭合selector自动发现当前适用根：`status`本身对既有记录始终exact，缺失或不在已知终态/非终态集合即阻断；`approved/published/superseded/deprecated/archived/frozen`及规范大写形式使该记录全部allowed payload exact。`publishedAt`缺失表示非终态且字段仍exact，存在时必须为非空NFC文本并使全部payload exact；一个根同时命中多个selector也阻断。当前扫描只覆盖仍为可导入且真实含生命周期字段的`skuDrawers`与`seriesShowcases`；`functionProfiles`已归`server_owned`，其历史`ACTIVE`或无`status`形状不会进入selector。未来新增含selector字段的importable root会自动进入同一策略并导致manifest派生清单drift，不能漏过。没有安全领域动作的字段或记录返回`REMOVAL_NOT_SUPPORTED`。不得将根分类解释为直接替换`WorkspaceState[root]`。

两种模式都只允许目标`workspaceId`与源工作区相同；不提供“另存为”、跨工作区克隆或历史恢复语义。稳定ID已存在但实体类型、父链或不可变身份字段不同是`IDENTITY_CONFLICT`；冻结内容/hash不同是`FROZEN_CONTENT_CONFLICT`；引用不闭合是`REFERENCE_INTEGRITY_CONFLICT`；schema/根清单不兼容是`SCHEMA_CONFLICT`；工作区不同是`WORKSPACE_CONFLICT`。这些冲突均硬阻断，不能由显示名、人工文案或“以Excel为准”覆盖。

预览在只读快照上规范化工作簿并生成完整计划，计划至少绑定`workspaceId + baseWorkspaceRevision + workbookContentHash + rootManifestHash + mode + normalizedOperationsHash`，逐项列出create/update/no-op/removal intent、before/after hash、引用影响、Issue与所需Capability。若提交前仅有可解析的当前可变值或可变revision冲突，旧计划失效并固定执行`REPLAN_REHASH_AND_REAUTHORIZE`：基于最新工作区重新规划、重新计算hash、重新展示差异并重新授权；不得把旧人工确认套到新计划。上述身份、冻结、引用、schema或工作区冲突不进入自动replan，直接阻断。

提交必须消费服务端保存的精确预览计划引用和幂等键，在执行时重新鉴权并重验全部绑定值。任何plan、工作簿、根清单、当前revision、引用或授权变化都不得部分执行。全部领域命令、冻结证据检查、幂等记录和审计在同一事务原子提交；任一失败整体回滚，不留下半导入、半删除或临时持久状态。成功后必须从持久层回读，证明工作区revision严格前进、操作集合与提交计划一致、冻结/服务端/禁止根未变，并生成绑定提交revision与结果hash的结果记录；超时先按幂等键回读，不能猜测成功或重复提交。

导出动作同样在执行时鉴权并从单一一致性工作区revision生成机器Manifest、类型化记录和派生可读Sheet。对同一revision、根清单和导出器版本，规范化机器内容与hash必须确定一致；无并发写入的“导出→同工作区MERGE预览”必须为零写操作，“导出→同工作区REPLACE预览”不得产生删除或冻结差异。项目数据往返与第25节正式配置Git导出是两条独立链路，项目工作簿不得包含或冒充`ConfigExportPackage`、Config ID分配证据、环境凭据或已提交配置文件。

正常路径：导出当前工作区，在同一工作区以`MERGE_BY_STABLE_ID`预览为零写操作；修改一个允许字段后重新预览、确认并原子提交，回读hash一致。

边界：MERGE缺少记录不删除；REPLACE缺少记录只产生removal intent，没有专用安全删除命令时以`REMOVAL_NOT_SUPPORTED`阻断。

冲突：可解析的当前可变冲突要求重新规划、重新hash和重新授权；身份、冻结、引用、schema与工作区冲突硬阻断。

恢复：提交失败或超时按幂等键回读；无法证明完整提交时工作区及冻结历史保持原样，在最新revision上重新预览。

权限：预览、提交和导出分别由第24.1节的服务端动作与Capability控制；预览许可不授权提交，下载文件不授权回写。

后续依赖固定为：F1只实现上述closed workbook parser/canonicalizer与恶意xlsx预算，不做写入；F2只把`__TF_CURRENT`记录翻译为已有领域动作并生成只读计划；F3实现事务提交、幂等与写后回读；F4接入显式预览/冲突解决/确认UI；F5覆盖真实同工作区导出往返、权限、并发、恢复和历史冻结验收。任一阶段不得扩展Sheet、列、root schema、Action映射或payload policy；需要扩展时先发布新的contract/schema版本并更新本节及机器清单。

## 16. 部署基线

目标环境为内网Dell R730，同时运行十多个服务。系统按需计算派生模板，不预生成完整组合，资源需求较低。

建议初始配额：

| 组件 | 常态 | 批量峰值 |
| --- | --- | --- |
| Web/API | 0.5–1 CPU、1GB RAM | 1–2 CPU、2GB RAM |
| 可选Worker | 与Web合并 | 1–2 CPU、1–2GB RAM |
| 数据库 | 单实例R730使用持久SQLite | 显式路径、整库备份、完整性检查与停服恢复 |
| 文件与快照 | 初期数GB | 配置保留和备份策略 |

初期在R730由单个systemd服务进程运行；批量重算影响交互后再拆Worker。无需首版引入容器编排或Redis。

## 17. 当前实现迁移

### 目标Schema v23：重量段SKU与词条派生

审计基线`ae6f782b1272efcf3ccf6feba5f81c4ca8b917bf`中，`CURRENT_WORKSPACE_SCHEMA_VERSION = 22`。Schema v9只是历史迁移输入，v22是当前运行时语义；二者的直接`targetPullKg`、最近标杆与历史payload不得原地改写。目标实现必须新增顺序迁移`22 → 23`，并保证任意旧版本先按既有链迁到22，再进入v23。

v23新增Series Part、`weightBandId`、`functionTemplateRef`/输入指纹、SKU词条局部意图、推荐/实际品质分离及失效状态。迁移必须保留未知字段与原始v9/v22 payload；不能唯一映射04.5的记录进入复核/失效态，不按名称、区间或旧拉力猜测。重复执行迁移无变化；迁移前后历史Snapshot字节、hash、旧策略与引用保持不变。

### 阶段1：兼容基础

- ParameterDefinition增加效用、单位、允许操作；
- 增加MethodProfile、RuleSetVersion和DerivedProjection；
- 旧Candidate.overrides迁移为operation=set的Patch；
- 历史字段保持只读兼容。

### 阶段2：商品身份

- 增加Collection、严格Series、SeriesPart、SkuDrawer和PurchasableModel；
- SeriesRecipe改为CandidateSearchRecipe；
- OfficialSku迁移为SKU抽屉加Model；
- DetailOverride迁移到Model作用域。

### 阶段3：匹配与兼容

- v23实现Part六键04.5唯一匹配与输入指纹；零/多匹配均fail-closed；
- v9/v22历史适配器保留最近Projection匹配，只用于旧payload迁移和Snapshot重放；
- 建立硬CompatibilityRule；
- 实现按轴Affinity Score；
- 增加Series不变量和重量曲线。

### 阶段4：词条与技术

- Affix拆分attribute/passive；
- Technology改为Affix组合包；
- 实现属性词条聚合内核；
- 品质改为C/绿、B/蓝、A/紫、S/橙；
- 增加被动技能结构化编辑，不执行逻辑。

### 阶段5：发布治理

- 发布ConfigurationSnapshot；
- 保留升级候选与历史复现；
- 聚合DerivationLayerPatch形成RuleSourceChangeDraft；
- 人工确认回写飞书、回读验证、显式拉取并发布新RuleSetVersion。

## 18. 必须具备的回归测试

### 18.1 匹配

- 六键精确命中唯一04.5行时进入SKU预览；
- 零匹配和多匹配均fail-closed，且保留已有SKU与局部词条意图；
- 点击重量段不创建SKU，同一Part同一重量段可显式创建多个SKU；
- Part配置变化重新匹配并重算；旧`typeId/targetPullKg`、范围包含、Affinity和最终拉力不参与目标态匹配。

### 18.2 层级与身份

- Method和Type分别留下轨迹；
- Series出现不同Type时阻止批准；
- SKU可包含多个Model；
- 游戏侧购买身份只引用Model；Tackle Forger内部发布、审计和导出链引用Model与Snapshot；
- 历史Snapshot不被重算。
- 缺策略引用的历史Snapshot可查看并下载原样审计归档，但`export_snapshot`、配置预览和提交均被`SNAPSHOT_REPLAY_POLICY_MISSING`阻断；恢复后只能由新ModelRevision发布新Snapshot。

### 18.3 Patch

- add/multiply在新基底重放；
- set在新基底进入复核；
- clear清除本层覆盖而不是写null；旧remove迁移后只留下clear；
- 旧min/max按冻结基底规范化为set，无法无损转换时进入复核；
- 同层多个set或set/clear竞争冲突；
- Series/SKU/Model优先级确定。

### 18.4 兼容

- deny不能被高Affinity覆盖；
- 每个Affinity轴只采用最具体规则；
- Affinity贡献和理由可解释；
- 杆轮线闭环失败阻止发布。

### 18.5 词条

- 纯增加、纯降低、同时包含增加与降低、多个正负方向词条均按`Base × (1+B)/(1+R)`计算，随后再结算固定值；
- 旧operation与有符号值确定性迁移；operation/direction/magnitude冲突隔离为`AFFIX_DIRECTION_CONFLICT`，不猜测优先级；
- `set`在百分比前建立Base，固定增加/降低使用非负幅度，`clamp_add`在普通固定值后按稳定顺序执行，FinalReviewPatch后只执行一次ParameterDefinition最终边界；
- `0%`、`Base=0`、`B ≥ 1`或`R ≥ 1`和有限合法极值均有测试；
- 负Base使用百分比、幅度越界、不可解析、`NaN`、无穷、溢出、非有限结果和理论结果非0却因数值精度下溢为0均按确认的Severity与Gate阻断；
- 最大有限值、最小正规/次正规值、相邻位型、稳定左折叠顺序及跨运行时hash通过第11.4节固定向量；
- 全局不能按参数或词条族切换公式，缺少已发布ReductionStackingPolicyVersion时只能非正式预览；
- 外部工作簿只作决策证据；主工作簿缺稳定机器规则时产生`REDUCTION_POLICY_SOURCE_MISSING`且不得发布策略；
- 策略升级生成新revision与UpgradeCandidate，旧Snapshot和旧策略版本仍可只读重放；
- Technology不会与词条双重加成；
- 被动技能不改变面板；
- 被动技能参与分值和品质；
- technology_only不进入普通池；
- S/A/B/C阈值正确。
- Part统一词条与Technology更新后已有SKU重算，SKU增加/屏蔽/局部副本意图保持；
- 项目定义、局部副本和引用不可互相冒充；Technology与直接引用按稳定ID去重；
- SKU拉力只由04.5基准和有效词条派生，ModelPatch所有拉力操作均被拒绝；
- 99.999推荐S，100及以上无推荐；人工实际品质可与推荐不同并保存覆盖理由，定价使用实际品质。

### 18.6 项目数据与迁移

- Excel完整替换和按稳定ID合并均覆盖正常、冲突、失败恢复和写后回读；
- 导出后无损重新导入，稳定引用不因显示名或行序变化；
- v9与v22夹具迁到v23保留原始payload，无法唯一匹配进入失效/复核；
- `22 → 23`第二次执行无变化，历史ConfigurationSnapshot与hash保持不变。

### 18.7 工作区 Revision 保留

- 一期缺少归档能力时仍可跑通非删除主流程，且 SQLite/D1 不裁剪任何 revision；
- 二期归档必须由当前已登录工具用户显式点击并选择工作 PC 保存位置；数值策划或系统策划只是典型操作者示例，不构成角色门禁；
- 保存窗口取消、权限拒绝、浏览器不支持、写入中断或校验失败不产生归档成功记录，也不触发裁剪；
- 本机归档包排除令牌、会话和密钥，并能用 manifest/hash 验证内容；
- 最近 90 天与最新 100 个的并集确定且边界稳定；
- cutoff、99/100/101 条、非连续 revision 和同一时间戳均有覆盖；
- 非法/空白/未来时间戳、非法配置、归档不可验证或备份/恢复未验证时不删除；
- 同一 retention run 幂等重跑不重复归档、删除或生成 tombstone；
- 保存冲突不得启动 retention；成功保存先独立提交，后续证据写入或裁剪失败只回滚 retention run、保留旧 revision 并告警，不回滚正常保存，也不会产生半完成删除；
- 裁剪前后 ConfigurationSnapshot、领域审计、Patch、Trace 和发布记录保持不变；
- Blob 最多 100 个的非权威边界在导入、读取和迁移报告中准确披露。
