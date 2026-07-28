## 9. 兼容规则与Affinity Score

### 9.1 硬兼容

硬兼容回答“能否成立”，结果为allow、deny或require。覆盖：

- Method × Type；
- Type × Weight；
- Type × Function；
- LineMaterial × Weight/Function；
- Model × Component；
- Rod × Reel × Line闭环。

deny永远阻止发布；require缺失时阻止或要求补足条件。

### 9.2 软Affinity Score

软兼容回答“在合法组合中有多适配”，不改变属性、不覆盖deny。

分值：

| 值 | 含义 |
| --- | --- |
| +3 | 强协同 |
| +2 | 明显适配 |
| +1 | 略有帮助 |
| 0 | 中性 |
| -1 | 略有冲突 |
| -2 | 不推荐但允许 |
| -3 | 强冲突但仍合法，复核需理由；不等同deny |

按轴分组：

```text
method_type
type_pull_tier
type_function
material_function
quality_specialization
model_component
```

每个轴只采用最具体、优先级最高的一条规则：

```text
AffinityScore = Σ(axisScore × axisWeight) / Σ(axisWeight)
```

界面必须同时显示各轴贡献和自然语言理由，不能只显示总分。

## 10. 参数、属性平衡预算与公式

### 10.1 参数元数据

```ts
interface ParameterDefinition {
  key: string;
  label: string;
  itemPartId: string;
  unit: string;
  precision: number;
  benefitMode: "higher_better" | "lower_better" | "target_range" | "contextual";
  balanceWeight: number;
  normalizationScale: number;
  allowedOperations: string[];
  targetRange?: { min: number; max: number };
}
```

自重属于lower_better：增重是代价，减重是优势。长度、传动比和调性通常是contextual。

### 10.2 通用规则操作

模板与定位层继续支持：

```text
add | multiply | set | min | max | formula
```

所有操作记录before、operand、after、layer和source。

### 10.3 属性平衡预算

乘法规则的归一化贡献：

```text
impact = directionSign × balanceWeight × ln(after / before)
```

加法规则：

```text
impact = directionSign × balanceWeight × (after - before) / normalizationScale
```

Function必须有优势和代价；Quality、属性词条和Technology成员可以有有限净增益。Series/SKU/Model/FinalReview Patch必须纳入其作用对象或发布批次的整体人工复核证据，并受已发布参数最终合法范围约束，不使用独立数值偏移上限；人工可以一次确认一批对象及其Patch，不要求逐Patch单独审批。`PerformanceSummary`只汇总已结算结果，不提供额外预算或净增益。

执行Pareto检查：同重量、同品质和同价格预算下，如果一个组合所有关键属性都不差且至少一项更好，则产生支配警告。

## 11. 词条与技术

### 11.1 词条分类

```text
category: attribute | passive
generationPolicy: normal | technology_only | style_only
```

属性词条改变面板。被动技能只保存、计分、展示和导出，不进入面板计算，也不在本工具执行。

### 11.2 技术

Technology是Affix组合包，负责：

- 组织词条；
- 名称和叙事；
- 稀有来源和生成限制；
- 与Function/Series的兼容；
- 总价值评分和品质要求。

Technology不得再次提供与所含Affix重复的属性规则。

Technology表示具体工艺实现，只通过成员Affix贡献属性和价值分。属性词条和Technology成员必须声明`semanticContributionKey`；同一语义默认不得重复生效，只有显式`stackingPolicy=stack`且通过校验时才可叠加。Technology本身只组织成员，不重复贡献属性或价值分。`PerformanceSummary`在这些贡献与最终属性结算完成后按版本化统计定义派生，只描述结果，不反向提供规则、分值、兼容或定价输入。

### 11.2.1 性能定位摘要

`PerformanceSummary`是Series/Model的只读派生投影，至少保存：

```ts
interface PerformanceSummary {
  subjectId: string;
  subjectRevisionId: string;
  definitionId: string;
  definitionVersion: string;
  labels: Array<{
    key: string;              // 例如 cast_plus、weight_minus、rod_power_plus
    label: string;            // 例如 抛投+、重量-、竿度+
    direction: "positive" | "negative" | "neutral" | "contextual";
    magnitude?: number;
    evidenceRefs: string[];   // Technology、Affix、最终属性与Trace引用
  }>;
  inputHash: string;
}

type PerformanceSummarySnapshot =
  | {
      status: "AVAILABLE";
      summary: PerformanceSummary;
      definitionRef: { definitionId: string; definitionVersion: string };
    }
  | {
      status: "UNAVAILABLE";
      reason: "definition_missing";
      summary?: never;
      definitionRef?: never;
    };
```

派生输入只能是已结算的Technology成员、去重Affix、最终属性及其Trace。定义版本决定统计键、阈值和展示文案；缺定义时仅不展示性能摘要，不得阻止属性、品质、定价或发布。此时发布证据与Snapshot必须冻结`PerformanceSummarySnapshot(status=UNAVAILABLE, reason=definition_missing)`，`summary`和`definitionRef`均不出现；不得把缺失伪装为空标签集合、默认定义或配置不完整。定义可用时冻结`AVAILABLE`分支及明确的定义引用。摘要变化不反写Series/Model配置，不触发重新匹配，也不新增价值分。相同输入与定义版本必须产生相同标签、顺序和inputHash。Series摘要可汇总其Model结果，但必须显示样本与聚合方法，不能伪装成Series配置字段。

验收：Given没有可用的`PerformanceSummaryDefinition`，When发布Model，Then发布不被阻断，Snapshot冻结`UNAVAILABLE/definition_missing`且不包含summary或definitionRef；Given随后发布定义，When生成UpgradeCandidate并发布新Snapshot，Then新Snapshot冻结`AVAILABLE`摘要与定义版本，旧Snapshot保持不变。

历史`PerformanceProfile/performanceId`不得自动映射为摘要标签；只读历史页面可以原样显示“旧性能定位”，迁移诊断必须与新`PerformanceSummary`明确区分。

### 11.2.2 项目词条、SKU局部副本与有效集合

项目级`AffixDefinition`、SKU局部`LocalAffixCopy`与`AffixRef`是三种不同对象；只有ID/名称的占位对象不得冒充完整定义。项目级定义保存完整业务字段和revision；局部副本在复制时冻结来源ID/revision与完整可编辑Payload，修改仅影响该SKU；引用只指向稳定ID/revision。

```text
effectiveSkuEntries
= part.defaultEntries
- sku.removedInheritedEntryIds
+ sku.addedEntryIds
+ sku.localEntryCopies
+ 展开(part.technologyIds + sku.technologyIds)的成员
```

实现先解析完整定义，再按稳定词条ID去重；同一词条被直接引用与Technology成员重复引用时只生效一次。SKU可以增加已有项目词条、屏蔽/恢复继承词条、复制为局部副本后修改，并挂载SKU Technology。Part更新后已有SKU自动重算，但其增加、屏蔽和局部副本意图保持。词条选择区的“新增词条”由用户主动创建完整项目级定义，不允许系统根据数值差额自动生成。

### 11.3 属性词条叠加

属性词条先规范化为以下DTO。正式存储、RuleSet、ModelRevision、Snapshot和运行时只接受规范operation；旧operation名只允许出现在导入证据中：

```ts
type AffixDirection = "increase" | "decrease";
type ScalarParameterValue = number | string | boolean;

type CanonicalAttributeAffixEffect =
  | {
      operation: "percent_adjust" | "flat_adjust";
      direction: AffixDirection;
      magnitude: number; // 有限、非负；-0规范化为+0
    }
  | {
      operation: "clamp_add";
      direction: AffixDirection;
      magnitude: number; // 有限、非负
      clampMin: number;
      clampMax: number;
    }
  | { operation: "enum_add"; value: string }
  | { operation: "set"; value: ScalarParameterValue };

interface CanonicalAttributeAffixOperation {
  operationId: string;
  operationIndex: number;
  parameterKey: string;
  effect: CanonicalAttributeAffixEffect;
  sourceAffixId: string;
  sourceAffixRevision: string;
}
```

`percent_bonus`、`reduction_diminishing`、`flat_bonus`和`flat_reduction`是旧导入别名，不是与`direction + magnitude`并存的第二套正式字段。映射固定为：

| 旧输入 | 规范结果 | 冲突行为 |
| --- | --- | --- |
| `percent_bonus`且值非负 | `percent_adjust + increase + magnitude=value` | 值为负时隔离整条Affix revision并产生`AFFIX_DIRECTION_CONFLICT` |
| `reduction_diminishing`或旧`reduction`且值非负 | `percent_adjust + decrease + magnitude=value` | 值为负时同上 |
| `flat_bonus`且值非负 | `flat_adjust + increase + magnitude=value` | 值为负时同上 |
| `flat_reduction`且值非负 | `flat_adjust + decrease + magnitude=value` | 值为负时同上 |
| 只有“百分比/固定值”类别与有符号旧值、没有方向字段 | 正数映射`increase`，负数映射`decrease`，幅度取绝对值；`-0`映射`increase + 0` | 必须保留原值、原字段与映射证据 |
| 同时存在旧operation、新`direction`或新`magnitude` | 仅在三者表达完全相同语义时接受 | 任一方向不一致、`magnitude < 0`或值不等价时产生`AFFIX_DIRECTION_CONFLICT`，不得猜测优先级 |

`AFFIX_DIRECTION_CONFLICT`为不可waive的`ERROR / REVIEW`；问题记录隔离而不参与预览、计分或发布，修复后创建新Affix revision，原始Payload永久保留。固定增加和固定降低也必须使用非负`magnitude`，不得依赖数值符号表达方向。

#### 每个参数的确定执行顺序

数值参数的完整Affix阶段固定为：

1. 读取`ModelPatch`完成后的传入值；按`sourceAffixId`无符号UTF-8字节升序、`sourceAffixRevision`无符号UTF-8字节升序、`operationIndex`数值升序、`operationId`无符号UTF-8字节升序排序并验证全部operation。
2. `set`在百分比阶段之前建立`BaseValue`；没有`set`时使用传入值。一个参数命中多个`set`时产生`AFFIX_SET_CONFLICT`并隔离该参数结果；`set`绝不在结算末尾覆盖其他词条。
3. 分别稳定累加`percent_adjust/increase`为`B`、`percent_adjust/decrease`为`R`，再执行`BaseValue × (1+B)/(1+R)`。
4. 分别稳定累加`flat_adjust/increase`与`flat_adjust/decrease`，一次执行固定增加减固定降低。固定值永远在百分比之后。
5. 按上述稳定顺序逐条执行`clamp_add`：先按方向增加或降低非负幅度，再立即应用该operation自己的`[clampMin, clampMax]`。因此`clamp_add`位于普通固定值之后、全局ParameterDefinition边界之前；局部边界非法或互相矛盾时阻断，不静默交换端点。
6. 输出`AffixOutput`后执行`FinalReviewPatch`，再且只再执行一次已发布`ParameterDefinition`的全局边界、精度与舍入。operation是否合法、类型/单位是否匹配在第1步预检，但不得提前应用最终边界。

枚举参数只允许可选的单个`set`建立基底，再按相同稳定顺序执行`enum_add`，经过`FinalReviewPatch`后由`ParameterDefinition`验证枚举集合；数值operation与枚举operation混用产生`AFFIX_OPERATION_TYPE_CONFLICT`。`FinalReviewPatch`不改变上述Affix内部顺序，ParameterDefinition也不得在它之前把值提前夹入最终边界。

属性百分比统一使用`bidirectional_ratio`双向比例规则。对同一参数，先分别汇总百分比增加与百分比降低，再结算固定值：

```text
B = ΣPercentIncreaseMagnitude
R = ΣPercentReductionMagnitude
PercentAdjusted = BaseValue × (1 + B) / (1 + R)
FinalBeforeBoundary = PercentAdjusted + ΣFlatBonus - ΣFlatReduction
AffixOutput = applyClampAddInStableOrder(FinalBeforeBoundary)
PostReviewValue = applyFinalReviewPatch(AffixOutput)
FinalValue = applyParameterDefinition(PostReviewValue)
```

`applyParameterDefinition`表示在FinalReviewPatch之后，按该参数已发布的`ParameterDefinition`执行最终边界和精度规则；规则声明的舍入前结果必须进入Trace。规范operation只有`percent_adjust/flat_adjust/clamp_add/enum_add/set`；旧别名不得继续写入新数据。

自由文本公式只用于说明，正式计算由operation和ParameterDefinition驱动。

### 11.4 双向百分比公式：OPEN-001决策已确认，待发布策略版本

2026-07-23用户确认全局使用`bidirectional_ratio`，不允许按参数、部位、词条族或单条词条切换叠加模式。未来若确需特殊语义，必须定义新的operation和策略版本，不能给现有百分比操作增加局部开关。

#### 表示、文案与归一化

- 正式数据把方向保存为`increase | decrease`，幅度保存为非负有限数；禁止把负数混入降低池或用数值符号同时表达方向。
- 玩家文案保持简洁，例如“加20%”或“减30%”，不要求展示内部公式。
- 旧数据中的有符号百分比只允许在导入阶段归一化为方向与非负幅度，并保留原值、归一化结果和迁移证据；不得在正式计算时临时猜测符号语义。
- `0%`合法，不产生Issue；Trace记录该项但标记为无数值影响。

#### 数值边界

- `B`和`R`都可以等于或超过`1`，不设置全局总和上限，也不因总和达到100%而额外clamp；每个词条幅度仍必须落在其已发布版本声明的范围内。
- 百分比操作只允许用于非负`BaseValue`。`BaseValue = 0`合法，百分比阶段结果仍为0，随后固定值可以改变结果；允许负基底的参数必须在`ParameterDefinition`中禁用百分比operation。
- 不可解析值、`NaN`、正负无穷和超出词条声明范围的幅度非法。计算溢出、得到非有限值，或理论结果非0却因数值精度下溢为精确0时，结果不可被信任并拒绝继续。
- 有限且在声明范围内的极值合法。边界和舍入由`ParameterDefinition`负责，不在本叠加策略中另设精度或截断；Trace必须保存舍入前结果。

#### Severity、Gate与waiver

| 条件 | Severity | Gate | waiver |
| --- | --- | --- | --- |
| `0%`、`B ≥ 1`或`R ≥ 1`、有限且在声明范围内的极值 | 无Issue | 无 | 不适用 |
| 单条幅度超出已发布词条范围 | `ERROR` | `REVIEW` | 不允许 |
| 对负`BaseValue`应用百分比operation | `ERROR` | `REVIEW` | 不允许 |
| 不可解析、`NaN`或无穷输入 | `BLOCKER` | `REVIEW` | 不允许 |
| 溢出、非有限结果或理论结果非0却因数值精度下溢为精确0 | `BLOCKER` | `REVIEW` | 不允许 |
| 缺少已发布`ReductionStackingPolicyVersion` | `BLOCKER` | `PUBLISH` | 不允许 |

缺少已发布策略版本时可以生成明确标记为非正式的草稿预览，但禁止发布新的Model或ConfigurationSnapshot。本规则产生的所有`ERROR`和`BLOCKER`均不可waive。

#### 确定性数值模型

`ReductionStackingPolicyVersion`必须冻结以下数值契约，当前策略固定使用`ieee754-binary64-v1`：

- 输入先以正确舍入到最近值、ties-to-even的算法转换为IEEE 754 binary64；保留原始词法值和转换后的64位大端十六进制位型。`-0`只在方向幅度归一化时转为`+0`，其他参数的有符号零按策略显式处理。
- 禁止使用扩展精度寄存器、fast-math、融合乘加或平台默认decimal替代。每一次加、减、乘、除和局部clamp都以binary64、roundTiesToEven产生并落存中间值后再进入下一步。
- `B`、`R`、固定增加合计和固定降低合计分别按第11.3节的稳定operation顺序做从左到右累加；不得使用数据库顺序、并行reduce、无序哈希容器或运行时自选求和算法。策略版本必须冻结排序键和累加算法版本。
- 每个输入binary64位型同时转换为精确的`significand × 2^exponent`有理数影子，仅用于异常分类。每一步若binary64结果为非有限值，或精确影子的绝对值大于最大有限binary64，产生`AFFIX_NUMERIC_OVERFLOW`；若精确影子非0而对应binary64结果为精确0，产生`AFFIX_NUMERIC_UNDERFLOW_TO_ZERO`。二者均为不可waive的`BLOCKER / REVIEW`。合法的非零次正规值不视为错误。
- 异常检查覆盖每次累加、`1+B`、`1+R`、乘法、除法、固定值结算、每条`clamp_add`及ParameterDefinition执行；任一步失败即停止该参数，不允许后续clamp把非有限中间值“救回”。
- ParameterDefinition的业务精度和舍入只在第11.3节规定的执行点应用，不反向改变B/R或其他中间值。Trace和hash同时包含稳定operation顺序、每步binary64位型、精确异常分类结果及最终业务舍入。

最低测试向量固定为；测试夹具中的词条范围必须显式允许表内幅度，以免范围校验先于数值域断言结束：

| 输入（无固定值，除非另述） | 预期 |
| --- | --- |
| `Base=0x7fefffffffffffff, B=0, R=0` | 保持`0x7fefffffffffffff`，合法 |
| `Base=0x7fefffffffffffff, B=1, R=0` | `AFFIX_NUMERIC_OVERFLOW` |
| `Base=0x0010000000000000, B=0, R=1` | `0x0008000000000000`，合法次正规值 |
| `Base=0x0000000000000001, B=0, R=1` | 理论值`2^-1075`但binary64为0，`AFFIX_NUMERIC_UNDERFLOW_TO_ZERO` |
| `Base=0, flat increase=0x0000000000000001` | 结果`0x0000000000000001`，合法 |
| B池按稳定键依次为`2^53, 1, 1` | 左折叠结果位型`0x4340000000000000`；若实现得到反序累加的`0x4340000000000001`则测试失败 |

跨JavaScript与至少一个服务端目标运行时必须对上述向量、最大有限值、最小正规值、最小/最大次正规值、相邻可表示值、稳定排序和hash做同位型回归；只比较格式化十进制文本不构成通过。

### 11.5 被动技能

当前保存：

- skillId、name、itemPartId；
- triggerType和触发条件说明；
- effectTarget和effectLogic说明；
- 示例参数；
- 持续、冷却、重置和叠加说明；
- valueScore、rarity和玩家文案。

当前不做：

- 解析effectLogic；
- 校验事件存在；
- 运行或模拟技能；
- 验证动态技能冲突。

界面必须显示：“本工具保存设计与配置资料，不执行或验证该被动技能。”

## 12. 品质评分、稀有度与部位

### 12.1 词条价值分、品质推荐与实际品质

```text
baseAffixScore
= Σ去重后的有效词条.valueScore
+ Σ同部位、无序词条对的combinationScore

finalValueScore
= baseAffixScore
× FunctionProfile.scoreFactor
```

SKU每次有效词条或Part功能定位变化后立即重算最终评分，并按版本化08.1区间生成`recommendedQualityId`。词条本身没有品质字段，只保存价值评分与属性操作。当前目标区间统一为：`C/绿 [0,20)`、`B/蓝 [20,40)`、`A/紫 [40,65)`、`S/橙 [65,100)`；`finalValueScore >= 100`为越界且无推荐，不夹取、不外推。该最新决定取代“100属于S”的旧策略，但历史QualityValuePolicyVersion和既有Snapshot仍按其冻结语义读取，不得原地重解释。

实际品质采用“推荐 + 人工选择”：用户可以采纳推荐，也可以选择其他品质。不一致时必须显著提示，并分别保存推荐结果、人工`selectedQualityId`、覆盖状态和理由。定价读取实际品质；评分Trace保存推荐依据与不一致状态。无推荐时不得自动选择S或沿用旧推荐。

负分技术内专用词条参与总分；被动词条参与价值分但不进入面板。Technology只展开成员词条，不额外贡献一次价值分；同一词条同时被直接选择和Technology引用时只计算一次。`FinalReviewPatch`不改变价值分。实际品质与推荐不一致本身不自动改品质；它按版本化确认策略显示并保存覆盖理由。评分越界、策略缺失或Trace不完整仍阻止新正式发布。

`07_品质评分`还提供竿、轮、线三张词条组合矩阵。组合分按以下契约导入和计算：

- 仅同一部位的有效词条互相组合；每个无序词条对最多计算一次。
- `—`是对角线，不产生组合；空白镜像半区表示“值存于另一半区”，不等于显式`0`；显式`0`是合法规则值。
- 正分、零分和负分均为业务结果，不得用布尔“兼容/不兼容”代替；例如轻量与增重的`-20`属于价值抵消，不是硬兼容deny。
- 若同一无序词条对两侧都填值且不一致、矩阵词条无法按稳定ID解析、或跨部位引用，`QualityValuePolicyDraft`进入`SOURCE_CONFLICT`并阻止发布。
- 矩阵当前以缩写展示；导入器必须先将缩写解析为稳定`affixId`并保存源单元格坐标，运行时不得按缩写或名称关联。

`FunctionProfile.scoreFactor`来自`03_功能定位`（功能定位表）的“评分系数”，按乘法应用。Performance不参与价值分：不得读取`performanceScoreFactor`、不得写入`performance_factor` Trace，也不得用一个“显式乘1”步骤伪装为新规则。历史源表或payload中的性能计分字段只作为迁移证据保留。Technology成员已经按Affix进入基础分与组合分；`PerformanceSummary`只是结算后的派生展示，二者均不得再次计分。

YsEKw历史revision与既有v22策略可能把100归入S；它们只服务历史证据和Snapshot重放。目标v23策略必须发布`[65,100)`并使100无推荐；源表或旧Draft仍宣称100属于S时产生`QUALITY_RANGE_SOURCE_OUTDATED`，不得发布为目标态新策略。

```ts
interface ModelAffixValueAssessment {
  modelRevisionId: string;
  recommendedQualityId: string | null;
  selectedQualityId: string;
  qualityOverrideState: "MATCHED" | "OVERRIDDEN" | "NO_RECOMMENDATION";
  qualityOverrideReason: string | null;
  baseAffixScore: number;
  combinationScore: number;
  functionScoreFactor: number;
  finalValueScore: number;
  affixBreakdown: { sourceAffixId: string; valueScore: number; sourceRef: string }[];
  combinationBreakdown: {
    leftAffixId: string; rightAffixId: string; valueScore: number; sourceRef: string;
  }[];
  qualityRangePolicyVersion: string;
  scoringPolicyVersion: string;
  inSelectedQualityRange: boolean;
  inputHash: string;
}
```

Quality本身不直接修改面板。属性平衡预算判断数值是否全优，价值分判断词条价值是否符合已选品质，二者不得合并。

校验使用统一`ValidationIssue(source="quality")`，品质不匹配代码为`QUALITY_SCORE_OUT_OF_RANGE`、矩阵冲突为`QUALITY_COMBINATION_CONFLICT`、旧源边界未更新为`QUALITY_RANGE_SOURCE_OUTDATED`。正常路径为配置Part→编辑SKU有效词条/Technology→组合计分→功能系数计分→品质推荐→采纳或人工选择实际品质→定价；边界覆盖区间端点、负分、空词条集、评分100和大于100；冲突保留草稿及Trace。

验收：Given去重词条分15、组合分3、功能系数1.03，When计算，Then最终评分18.54且推荐C，Trace没有Performance乘数；Given轻量与增重同时存在，When组合计分，Then`-20`只计一次；Given评分99.999，When推荐，Then命中S；Given评分100或更高，When推荐，Then无推荐并返回`QUALITY_SCORE_OUT_OF_RANGE`；Given用户选择与推荐不同品质，Then定价使用实际品质且保存覆盖理由，推荐与Trace不丢失。


### 12.2 稀有度

```text
common 普通
uncommon 少见
rare 稀有
ultra_rare 超稀有
epic 史诗
```

- technology_only按超稀有生成政策处理；
- style_only按少见处理；
- rarity控制生成池，不替代valueScore。

### 12.3 部位注册表

领域模型使用ItemPartDefinition，不继续把rod/reel/line写死为不可扩展联合类型。

注册表预留竿、轮、线、钩、漂、真饵和拟饵，但当前产品主流程只启用竿、轮、线。`Collection → Series → Part → SKU → Model → ConfigurationSnapshot`、weightBandId、04.5唯一匹配和钓具系列甘特图均只适用于竿、轮、线；SKU不包含钩、漂、真饵或拟饵。

钩、漂、真饵和拟饵当前完全延期。注册表及迁移层可以保留其稳定ID和历史Payload，仅用于数据不丢失、审计和未来迁移；这不构成产品启用，也不要求提供只读UI。四类部位的专用UI、草稿、生成、发布、Snapshot和导出全部关闭，且不得用竿轮线规则、隐藏默认值或通用占位对象代替尚未完成的产品设计。具体边界见OPEN-003。

## 13. 校验与审批

### 13.1 三个人工关卡

1. 规则源与RuleSetVersion发布；
2. Series及SKU重量规格批准；
3. Model和ConfigurationSnapshot发布。

### 13.2 严重级别

Severity描述问题强度，Gate描述受影响关口，State描述当前处理状态；三者不得互相代替：

| 级别 | 行为 |
| --- | --- |
| `BLOCKER` | 结果无法被信任或命中绝对业务禁令；命中的Gate必阻断且永远不可waive |
| `ERROR` | 必须修复或按版本化WaiverPolicy获得例外；OPEN时阻断命中的Gate，不等于全部ERROR永久不可waive |
| `WARNING` | 不直接越过关口；必须在命中的Gate前`ACKNOWLEDGED`并记录理由，acknowledge不是waive |
| `INFO` | 展示继承、正常取舍和解释，不阻断 |

`BLOCKER`用于硬deny/缺失require、Snapshot或Trace不可重放、必需版本缺失、配置关系断链等继续执行会产生不可信产物的情况。普通可修复字段错误使用`ERROR`。是否允许`ERROR`例外必须由版本化`WaiverPolicyVersion`按`source + code + gate`显式列出；未列出即不可waive。

### 13.3 最低校验集合

- 导入：ID、字段、单位、范围、重复和版本冲突；
- 模板：规则操作、轨迹、边界和预算；
- 兼容：硬规则、条件要求和Affinity解释；
- Series：身份、核心词条、方向签名和重量曲线；
- SKU：最近匹配、共享基底和重复规格；
- Model：部件、技术、词条、Patch和杆轮线闭环；
- 发布：目标Gate无OPEN的BLOCKER/ERROR、warning已确认、版本链完整、快照哈希成功；被策略允许且有效的ERROR waiver必须冻结到发布证据。

被动技能只校验配置完整性和文案一致性，不校验运行时逻辑。
