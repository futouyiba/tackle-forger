## 6. Collection、Series、SKU与Model

```text
Collection
└─ Series
   ├─ Part（1～3，竿/轮/线各最多一个）
   │  └─ WeightBand
   │     └─ SKU Drawer（可多个）
   │        └─ Model
   └─ Part…
```

### 6.1 Collection

Collection承担品牌、视觉和营销叙事，可以跨类型或功能。例如“青芦”可以同时包含直柄泛用、枪柄操控和枪柄障碍Series。

### 6.2 Series

Series包含1～3个Part，竿、轮、线为任意非空组合且每种部件最多一个。Series只保存产品族、展示、排序与跨Part关系；不再统一保存钓法、功能定位、功能强度或目标拉力。

每个Part独立保存`partType`、`fishingMethod`、`materialType`、`functionProfile`、`functionIntensity`、统一`defaultEntryIds`、`technologyIds`、已选择`weightBandIds`及自身revision/输入指纹。

### 6.3 SKU Drawer

SKU是玩家界面的钓具抽屉或商品卡片入口，属于一个Part和一个`weightBandId`。同一Part、同一重量段允许多个SKU；稳定SKU ID而非派生拉力承担身份。点击重量段只打开预览，不创建SKU。

SKU保存：

- seriesId、partId、weightBandId；
- 稳定`functionTemplateRef`、完整输入指纹与有效/失效状态；
- `removedInheritedEntryIds`、`addedEntryIds`、`localEntryCopies`、`technologyIds`；
- 推荐品质、人工实际品质及覆盖理由/状态；
- skuPatchIds；
- modelIds；
- defaultModelId；
- 展示顺序与校验摘要。

SKU不是购买对象，不保存玩家实例状态。

### 6.4 Model

Model是玩家实际选择和购买的具体型号，保存：

- action、hardness、length；
- 竿、轮、线等组件选择；
- technologyIds和affixIds；
- modelPatchIds；
- 自动定价结果、解锁和商品策略引用；
- configurationSnapshotId。

Model从SKU只读继承最终拉力；ModelPatch和任何最终值输入不得对拉力执行`set/add/multiply/clear`。Model仍可按ParameterDefinition修改调性、硬度、长度等允许规格。

领域内Model是实际选择和购买对象。当前配置表没有Snapshot版本字段，因此不得宣称游戏侧购买记录已经支持`modelId + snapshotId`；Snapshot仅在Tackle Forger内部保证发布和导出的可追溯性。

### 6.5 PartConstraintSet、CandidateSearchRecipe与组件选择

`PartConstraintSet`是版本化、不可变的候选搜索约束对象。它使用非空稳定`constraintSetId`和从1开始、严格单调的安全整数`revision`标识；修改任一字段、来源或复核结论都创建新revision。非法身份或revision必须在迁移、精确引用解析和新revision构造边界fail-closed。`CandidateSearchRecipe`必须冻结并引用精确的`constraintSetId + revision + contentHash`，同时冻结本轮可枚举组件的`componentRegistryId + revision + contentHash`；不得在运行时解析为后来发布的“最新revision”。候选生成请求只提交不可变的Recipe引用，服务端必须从该Recipe revision解析约束集与组件注册表。规范请求不得再接收可由调用方任意组合的独立`partConstraintSetRef`或注册表引用。

`PartConstraintSet`按rod、reel、line分别保存约束。每个部位独立记录来源、来源revision、内容哈希、迁移诊断和`CONFIRMED/NEEDS_REVIEW`状态；一个部位确认不代表另外两个部位自动确认。字段语义固定为：

| 字段 | 权威语义 |
| --- | --- |
| `templateIds` | 该部位候选组件的模板搜索约束；按稳定模板ID匹配，不是具体组件选择 |
| `materialIds` | 该部位候选组件的材质搜索约束；缺少版本化注册表元数据时不得按名称猜测 |
| `requiredAffixIds` | 候选必须满足的该部位词条条件；未知或无法验证时fail-closed |
| `optionalAffixPoolIds` | 候选扩展或版本化排序使用的该部位词条池；不等于必需词条或已选词条 |
| `typeIds` | 默认不是通用分部位字段；只有组件注册表明确提供该部位的版本化type分类时才可生效 |
| `componentSelections` | 候选结果与Model中的具体组件引用，不属于`PartConstraintSet`或`CandidateSearchRecipe` |

Series的`typeId/TypeProfile`继续表达系列级Method × Type结构语义。不得把Series Type复制为分部位type分类，也不得由本规范擅自定义当前不存在的组件type。组件注册表没有明确分类时，遗留`typeIds`只能保留、展示并进入`NEEDS_REVIEW`，不得参与权威过滤、自动批准或自动发布。

`CandidateSearchRecipe`只拥有搜索范围、阈值、检查点、排序定义和`PartConstraintSet` revision引用。它按部位枚举、过滤和排序组件，但不拥有具体组件选择。每项过滤和排序必须记录部位、约束字段、约束revision、组件注册表revision及命中/排除原因；未知ID、跨部位引用、缺失分类或required冲突不得静默放宽为“允许全部”。

新候选结果保存本轮实际选中的`componentSelections`，但CandidateRun仍是不可变审计产物，不是商品身份。新Candidate、新建或更新的Model revision和新ConfigurationSnapshot只能写入`referenceKind="VERSIONED_COMPONENT_REF"`的版本化分支；每个具体组件选择必须冻结：部位、稳定`componentId`、不可变`componentRevisionId`、组件内容哈希、精确的组件注册表revision及其内容哈希、来源revision，以及当时用于计算和展示的名称/值快照。组件revision必须确实属于冻结的注册表revision，部位、ID、revision和hash任一不一致、缺失或无法解析时fail-closed。

`componentContentHash`覆盖该组件revision的规范注册表记录；`selectionContentHash`覆盖完整组件引用与`nameSnapshot/valuesSnapshot`。Candidate fingerprint、CandidateRun输入/输出hash、Model revision内容hash和ConfigurationSnapshot content hash都必须覆盖完整`componentSelections`，不能只覆盖组件ID。组件注册表发布新revision只能产生新候选、Model revision或UpgradeCandidate，不得让既有Candidate、Model revision或Snapshot改指“最新组件”。

只有显式物化命令重新鉴权、重验Recipe内冻结的约束集/注册表引用、逐项组件引用与硬兼容后，候选才创建或更新Model草稿revision；未物化、过期、丢弃或superseded的候选不得改变Model。搜索约束不得被机械转换为`componentSelections`。

历史`ModelComponentSelection`若只有`itemPartId/componentId/name/values`，读取/迁移适配器必须将其表达为`referenceKind="LEGACY_UNVERSIONED_COMPONENT_REF"`的判别联合分支，并在`rawPayload`中原样保留旧对象及未知字段；不得按名称或当前注册表补写revision/hash。该判别包装是运行时读模型与迁移诊断，不得回写或改变已发布Snapshot的原始payload/content hash。旧分支只允许历史读取、展示、导出原始证据和人工解析；任何Candidate生成、物化、新Model revision、批准或新Snapshot构建遇到旧分支都必须返回`LEGACY_COMPONENT_REF_NOT_MATERIALIZABLE`并fail-closed。人工解析到精确组件revision后创建使用版本化分支的新Model revision，原记录与旧Snapshot保持不变。

完整决策、旧数据复核与Snapshot冻结规则见[`AUD-026 PartConstraintSet语义ADR`](../audits/aud-026-part-constraint-semantics-adr.md)。

### 6.6 稳定身份、再生成对应与重量段变更

- `entityId`终身稳定；revision不可变；displayName可修改且不得作为唯一关联键。
- 再生成对应顺序固定为：显式目标ID→持久GenerationBinding→外部稳定ID→业务身份键→name/特征仅作为人工提示。
- SKU业务身份不使用派生拉力；以稳定skuId与GenerationBinding为准，检索上下文为`partId + weightBandId`。
- Model可以使用可选`modelVariantKey`表达跨重量的同一路线，例如`short_fast`、`long_slow`；同一SKU内非空variantKey唯一。
- SKU改换Part或weightBandId属于身份迁移：没有已发布后代Snapshot时可保留skuId创建新revision并重新唯一匹配；已有已发布后代时创建新SKU，旧SKU可DEPRECATED。
- 派生最终拉力变化只创建新SKU revision并重算下游草稿；历史Snapshot保持冻结，不以拉力变化改写身份。

### 6.7 参数归属及允许操作

| 参数/对象 | 权威归属 | 自动派生 | 允许人工操作 |
| --- | --- | --- | --- |
| Part钓法、材质、功能定位/强度 | Part | 否 | Part编辑 |
| weightBandId | SKU | 由用户在01.x目录选择 | 显式选择/迁移；点击不创建 |
| functionTemplateRef | SKU | 六键唯一匹配04.5 | 不允许手填或猜测 |
| 有效词条与Technology | SKU | 继承Part并叠加SKU局部意图 | 增加、屏蔽、恢复、局部复制修改 |
| 最终拉力 | SKU | 04.5基准 + 有效词条add/multiply | 禁止直接输入；禁止任意Patch操作 |
| 调性、硬度、长度等具体规格 | Model | 可由模板继承 | 仅按ParameterDefinition允许的ModelPatch操作 |
| 推荐品质 | SKU | 价值评分与08.1区间 | 只读重算 |
| 实际品质 | SKU | 可采纳推荐 | 人工选择并在不一致时保存理由/状态 |

## 7. Series不变量

### 7.1 硬不变量

以下不一致阻止Series批准或Model发布：

- Part数量不在1～3或部件类型重复；
- 任一Part缺钓法、材质、功能定位或强度；
- 任一SKU的04.5匹配为零或多匹配；
- 缺少必需核心词条家族；
- 包含禁用词条家族。

Series的唯一身份是稳定`seriesId`；显示名、营销概念和Part配置变化均不构成独立的“Series概念身份”硬阻断。硬兼容、Affinity、Series不变量和发布检查是四套独立语义。硬兼容失败和发布版本链不完整可以阻止发布，但不得伪装成Series不变量。

### 7.2 方向签名

SeriesSignature描述相对中性基准的方向：

```ts
interface SeriesSignatureAxis {
  parameterGroup: string;
  expectedDirection: "positive" | "negative" | "neutral" | "contextual";
  importance: number;
  tolerance: number;
}
```

例如障碍强攻：拉力+、耐力+、饵重上限+、自重增加（代价）、抛投-。

所有SKU和Model必须维持核心方向，允许幅度不同。

### 7.3 重量曲线

同一Part按01.x显示顺序向更高重量段推进时默认要求：

- 杆、轮、线拉力不下降；
- 安全工作拉力不下降；
- 耐力不下降；
- 饵重上限不下降；
- 推荐线号总体不下降。

长度、传动比、调性和回弹属于contextual参数，不强制单调。

## 8. Patch

```text
DerivedProjection
→ SeriesPatch
→ SkuPatch
→ ModelPatch
→ Affix/Technology
→ FinalReviewPatch
```

```ts
type CanonicalPatchOperation = "set" | "add" | "multiply" | "clear";

interface AdjustmentPatchOperation {
  operationId: string;
  operationIndex: number;
  parameterKey: string;
  operation: CanonicalPatchOperation;
  operand: unknown; // clear固定为null
  before: unknown;
  after: unknown;
}

interface AdjustmentPatch {
  id: string;
  patchRevision: number;
  scopeType: "series" | "sku" | "model" | "final_review";
  scopeId: string;
  operations: AdjustmentPatchOperation[];
  baseProjectionId: string;
  baseRuleSetVersion: string;
  baseObjectRevision: string;
  reason: string;
  author: string;
  state: PatchState;
  mirrorSyncState: PatchMirrorSyncState;
}
```

新建、批准、持久化、重放和飞书镜像统一使用`set/add/multiply/clear`四种规范操作：

| 操作 | 规范语义 |
| --- | --- |
| `set` | 把参数设为类型化operand；基底变化后必须人工复核 |
| `add` | 对数值参数加operand；参数仍存在且类型、单位兼容时可在新基底重放 |
| `multiply` | 对数值参数乘operand；参数仍存在且类型、单位兼容时可在新基底重放 |
| `clear` | 清除当前Patch层提供的覆盖，重新暴露继承值；不是把值设为`null`，operand固定为`null` |

`ProjectionPatchOperation.remove`仅是旧投影Patch/API的兼容输入别名。适配器必须在进入`PatchLedger`前确定性转换为`clear`；新API、账本、Snapshot引用和飞书镜像不得继续写`remove`。

`min/max`仍是模板与通用规则层的合法操作，但不是规范AdjustmentPatch操作。旧Patch或草稿若表达`min/max`，在批准时必须对冻结的`baseRuleSetVersion + baseObjectRevision`求值，并保存为规范`set`操作，同时在原始Payload/证据中保留原操作、边界operand、before和after；基底变化后按`set`进入人工rebase。无法无损求值的记录进入迁移复核，不得动态重放或静默丢弃。参数类型与`ParameterDefinition.allowedOperations`不允许的操作必须产生Issue并禁止批准。

`AdjustmentPatch`用于Series/SKU/Model/FinalReview；共享中间层`DerivationLayerPatch`复用同一操作明细与revision事务契约，但使用稳定阶段选择器和`scopeType=derivation`。`ProjectionPin`和`RuleSuppressionPatch`是独立记录，不伪装成数值操作。业务生命周期统一使用第14.2节的大写`PatchState`，镜像同步使用独立`PatchMirrorSyncState`；旧`draft/approved/superseded`只在迁移适配器中转换。

共享中间层人工修正使用独立`DerivationLayerPatch`，作用于稳定的阶段选择器、源模板、Method、Type或FunctionProfile，不引用易失缓存ID。它可以参与草稿试算，但正式发布前必须完成：回写飞书表格→技术回读验证→用户显式“拉取”→发布新RuleSetVersion→重算确认吸收。Series/SKU/Model Patch与ProjectionPin无需回写飞书即可发布。

重放语义：

- multiply/add在参数仍存在且类型、单位兼容时可在新基底上重放，重放后最多回到`PENDING_REVIEW`；
- set在基底变化后必须人工复核；clear只有在目标仍表示可继承覆盖时可重放，参数删除、重命名或必填性变化时进入`REBASE_REQUIRED`；
- 同作用域同参数多个set，或set与clear互相竞争，是冲突；
- 屏蔽继承规则使用独立RuleSuppressionPatch；
- `FinalReviewPatch`位于词条结算之后，只处理最终复核差异；上游变化后必须重新复核。
- `ProjectionPin`只固定结构模板选择，不冻结模板旧值；源模板删除或失配时进入`REBASE_REQUIRED`，不得静默回退。

“Patch预算”是历史术语。当前统一称为“Patch最终范围校验”；OPEN-004已经确认不设置独立的数值偏移上限，与服务器资源无关。
