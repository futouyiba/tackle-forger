# 钓具配置工坊：词条范围、叠加规则与技术组合决策补充 002

> 日期：2026-07-20  
> 状态：设计边界已确认，部分公式一致性待确认  
> 主设计文档：[`2026-07-20-template-series-generation-system-design-v2.md`](./2026-07-20-template-series-generation-system-design-v2.md)  
> 前一决策：[`2026-07-20-design-decisions-method-quality-affinity-sku-passive.md`](./2026-07-20-design-decisions-method-quality-affinity-sku-passive.md)

本文依据最新词条分类、具体属性词条和被动技能示意，重新界定Tackle Forger在当前阶段对词条的职责。

本文正式覆盖前一决策文档中“被动技能必须由本工具验证模拟器实现后才能发布”的结论。

## 1. 当前工具的正式边界

Tackle Forger当前负责：

- 定义和维护原子词条；
- 区分属性型词条和被动技能词条；
- 计算属性型词条对面板数值的影响；
- 管理技术由哪些词条组成；
- 计算词条价值评分和装备品质；
- 管理稀有度、生成限制、系列贯通词条和型号词条；
- 展示被动技能的结构化设计说明和玩家文案；
- 把属性、词条和被动说明冻结进配置快照；
- 导出给后续游戏系统使用的数据。

Tackle Forger当前不负责：

- 执行被动技能；
- 解析或运行被动技能公式；
- 校验游戏事件、触发器和运行时状态是否真实存在；
- 进行搏鱼、抛投、诱鱼或环境模拟；
- 估算被动技能在真实玩法中的触发频率；
- 根据模拟结果自动调整价值评分。

因此，当前工具是“词条与配置生产系统”，不是“词条运行时”或“钓鱼模拟器”。

## 2. 词条分类

### 2.1 属性型词条

属性型词条直接改变装备面板或最终配置中的数值。

示例：

- 竿拉力+8%；
- 竿拉力固定+2kgf；
- 杆自重-8%；
- 轮绕线量+15%；
- 线直径-5%；
- 感度固定+1级；
- 广谱挂饵新增一种可用饵类型。

属性型词条是原子单位。技术、系列和型号只能引用词条，不应把同一数值效果复制到多个位置。

### 2.2 被动技能词条

被动技能不改变常驻面板值，而是描述在条件、事件或持续状态下发生的效果。

示例：

- 抗冲击；
- 满弓稳线；
- 过载泄力；
- 暗水隐蔽；
- 锋利初刺；
- 风浪稳像；
- 鲜活爆发；
- 匀速泳姿。

在当前工具中，被动技能按结构化设计资料保存和展示，但其`effectLogic`是文本或外部协议内容，不参与本工具计算。

### 2.3 风格与技术内专用词条

风格词条和技术内专用词条不是新的作用类别，而是生成政策：

```text
category: attribute | passive
generationPolicy: normal | technology_only | style_only
```

- `technology_only`：只能作为技术的一部分出现，不进入普通随机词条池；
- `style_only`：用于装备风格差异，通常价值评分为0，固定按少见处理；
- `normal`：可以进入常规词条池。

## 3. 技术与词条的关系

### 3.1 技术是词条组合包

一个技术可以包含多个原子词条：

```text
技术：C40X碳纤
部位：竿
方向：搏鱼
含金量：高强
包含词条：
- 拉力强化
- 省力转竿
```

```text
技术：Zaion
部位：竿
方向：搏鱼
含金量：顶级
包含词条：
- 省力转竿
- 海水防护
```

建议模型：

```ts
interface TechnologyDefinition {
  id: string;
  name: string;
  itemPartId: string;
  seriesTagIds: string[];
  purposeTagIds: string[];
  contentTier: "standard" | "advanced" | "top";
  affixIds: string[];
  requiredQualityIds: string[];
  compatibilityRuleIds: string[];
  description: string;
  enabled: boolean;
}
```

### 3.2 禁止双重加成

如果技术已经通过词条提供“拉力强化”，技术本身不能再次直接增加拉力。

最终属性来源应为：

```text
基础模板与定位层
→ 技术展开为词条集合
→ 词条统一叠加
→ 型号Patch
→ 最终面板
```

技术的职责是：

- 组织词条；
- 限制生成；
- 提供名称、叙事和稀有来源；
- 参与兼容与系列概念检查。

技术不再拥有与其词条重复的数值规则。

### 3.3 性能定位与技术

性能定位回答“希望强化哪个工艺方向”，技术回答“使用哪一组具体词条实现这个方向”。

推荐关系：

```text
Performance Profile
→ 推荐或限制Technology
→ Technology展开Affix
→ Affix产生数值与品质
```

如果现有性能定位系数已经承担了完整属性增益，则需要明确选择一种模式：

```text
performanceSourceMode:
- profile_coefficients
- technology_affixes
```

同一装备不能同时对同一参数应用“性能定位系数”和“技术内同义词条”，除非设计者明确把两者定义为不同来源，并通过属性平衡预算校验。

长期推荐以`technology_affixes`作为正式商品模式；`profile_coefficients`保留给没有分配具体技术时的候选预览。

## 4. 属性词条的统一叠加

### 4.1 正向百分比与固定值

同一属性的全部百分比加成先合并，随后添加固定值：

```text
FinalValue = BaseValue × (1 + ΣPercentBonus) + ΣFlatBonus
```

例如：

```text
基础拉力 = 10kgf
词条A = +8%
词条B = +12%
词条C = 固定+2kgf

最终拉力 = 10 × (1 + 0.08 + 0.12) + 2
         = 14kgf
```

百分比加成之间是加算，不是连续乘算。

### 4.2 降低型属性

针对“能量消耗降低”“耐久下降速度降低”“威胁性降低”等越低越好的参数，源设计给出了递减收益公式：

```text
FinalValue = BaseValue / (1 + ΣReductionBonus) + ΣFlatDelta
```

例如降低20%和降低30%：

```text
FinalValue = BaseValue / (1 + 0.20 + 0.30)
           = BaseValue / 1.50
```

该方式可以避免多个减益词条线性叠加到0或负数。

### 4.3 当前公式不一致

源表中的单个降低型词条示例大量使用：

```text
FinalValue = BaseValue × (1 - r)
```

但总叠加规则使用：

```text
FinalValue = BaseValue / (1 + Σr)
```

即使只有一个10%减免，两者也不同：

- 线性减法：`Base × 0.90`；
- 递减收益：`Base / 1.10 ≈ Base × 0.9091`。

系统不能同时把二者都视为正式计算语义。

建议：

1. 把源表顶部的总叠加规则视为正式语义；
2. 具体词条中的`×(1-r)`保留为玩家文案或旧公式参考；
3. 工具使用统一的`reduction_diminishing`运算；
4. 导入时发现降低型词条仍写`×(1-r)`，显示“公式展示与正式叠加语义不同”的提示；
5. 在正式实现前由数值设计者最终确认一次。

### 4.4 其他操作类型

| operation | 用途 | 示例 |
| --- | --- | --- |
| percent_bonus | 正向百分比加算 | 拉力+8% |
| flat_bonus | 固定值加算 | 拉力+2kgf |
| reduction_diminishing | 递减型降低 | 能量消耗降低10% |
| flat_reduction | 固定减值 | 抛投系数点-300 |
| clamp_add | 加值后限制范围 | 抗海水等级+1 |
| enum_add | 向集合增加枚举 | 新增一种适配饵类型 |
| set | 明确覆盖 | 特殊设计锁定值 |

面板公式应由`operation`生成，不把自由文本公式作为计算来源。

## 5. 属性词条数据结构

```ts
interface AttributeAffixDefinition {
  id: string;
  name: string;
  category: "attribute";
  itemPartId: string;
  parameterKey: string;
  operation:
    | "percent_bonus"
    | "flat_bonus"
    | "reduction_diminishing"
    | "flat_reduction"
    | "clamp_add"
    | "enum_add"
    | "set";
  value: number | string;
  unit: string;
  valueScore: number;
  rarityId: string;
  generationPolicy: "normal" | "technology_only" | "style_only";
  formulaPreview: string;
  playerDescription: string;
  enabled: boolean;
}
```

工具根据ParameterDefinition限制可用operation。例如：

- 自重只允许percent_bonus或reduction_diminishing对应的重量增减语义；
- 抗海水等级只允许clamp_add；
- 适配饵类型只允许enum_add；
- 拉力允许percent_bonus和flat_bonus；
- 抛投技术系数使用系数点flat_bonus/flat_reduction。

## 6. 被动技能数据结构

当前工具保存设计资料，不执行逻辑：

```ts
interface PassiveAffixDefinition {
  id: string;
  name: string;
  category: "passive";
  itemPartId: string;
  triggerType: string;
  triggerConditionText: string;
  effectTargetText: string;
  effectLogicText: string;
  exampleParametersText: string;
  durationText: string;
  cooldownResetText: string;
  stackingRuleText: string;
  valueScore: number;
  rarityId: string;
  generationPolicy: "normal" | "technology_only";
  playerDescription: string;
  externalSpecId?: string;
  notes: string;
  enabled: boolean;
}
```

其中：

- `effectLogicText`仅用于设计说明和导出；
- `triggerType`当前可以使用自由枚举，不要求对应运行时事件；
- `externalSpecId`为未来对接模拟器预留，但当前可以为空；
- 被动技能参与价值评分、稀有度、技术组成和品质计算；
- 被动技能不进入面板属性计算。

## 7. 品质与价值评分

### 7.1 已确认品质档位

| 品质 | 颜色 | 最低词条分值 |
| --- | --- | --- |
| S | 橙 | 35 |
| A | 紫 | 20 |
| B | 蓝 | 5 |
| C | 绿 | 0 |

建议基础公式：

```text
AffixValueScore = ΣAttributeAffix.valueScore + ΣPassiveAffix.valueScore
```

负分技术内专用词条参与总分，用于表达增重、抛投妥协等代价。

品质映射：

```text
score >= 35 → S/橙
score >= 20 → A/紫
score >= 5  → B/蓝
score >= 0  → C/绿
```

总分低于0时建议阻止普通商品发布，除非它属于明确的测试或特殊剧情物品。

### 7.2 价值评分不等于属性预算

词条价值评分决定品质门槛；属性平衡预算判断数值是否形成全优解。

二者不能合并：

- 一个高价值被动可能不改变面板；
- 一个负分增重词条可能是强技术所需代价；
- 风格词条可以价值为0，但仍改变装备手感和适配；
- 高品质不代表没有缺点。

## 8. 稀有度与生成政策

### 8.1 标准稀有度

建议统一为：

```text
common       普通
uncommon     少见
rare         稀有
ultra_rare   超稀有
epic         史诗
```

### 8.2 特殊映射

- 技术内专用词条在展示和价值约束中按超稀有处理；
- 风格词条按少见处理；
- “专属技术”和“技术内专用”建议统一为`technology_only`；
- 稀有度决定生成池和出现频率，不直接替代valueScore。

## 9. 部位注册表

源词条已经覆盖：

- 竿；
- 轮；
- 线；
- 钩；
- 漂；
- 真饵；
- 拟饵。

当前工程的ItemKind仅包含rod、reel、line。为了避免未来再次迁移，建议把固定联合类型升级为注册表：

```ts
interface ItemPartDefinition {
  id: string;
  name: string;
  category: string;
  parameterKeys: string[];
  enabledInCurrentTool: boolean;
  displayOrder: number;
}
```

首版可以只启用rod、reel、line，但数据库和导入器允许保存其他部位定义。未启用部位不进入系列和型号生成。

## 10. 工具内工作流

### 10.1 词条库

词条库分两个标签：

1. 属性型词条；
2. 被动技能词条。

属性型编辑器显示：

- 部位；
- 属性；
- 运算方式；
- 改变量和单位；
- 正式公式预览；
- 面板变化示例；
- 价值评分；
- 稀有度；
- 生成政策。

被动技能编辑器显示：

- 技能ID和名称；
- 部位；
- 触发类型和条件描述；
- 效果对象和逻辑说明；
- 示例参数；
- 持续、冷却和叠加说明；
- 价值评分和稀有度；
- 玩家展示文案。

被动技能页面明确标记：

> 本工具保存设计与配置资料，不执行或验证该被动技能。

### 10.2 技术编辑器

技术编辑器包含：

- 技术名称、部位、系列和方向；
- 含金量；
- 所含属性词条；
- 所含被动技能；
- 总价值评分；
- 预期品质贡献；
- 属性优势和代价；
- 与性能定位的适配；
- 是否存在重复属性来源。

技术本身不直接编辑数值规则，只管理词条集合。

### 10.3 SKU与Model预览

SKU抽屉和Model详情分别展示：

- 原始面板值；
- 属性词条百分比总和；
- 属性词条固定值总和；
- 最终面板值；
- 被动技能列表和完整文案；
- 技术来源；
- 词条总价值评分；
- C/B/A/S品质；
- 负分代价词条。

## 11. 当前工具应执行的校验

### 11.1 属性词条

- 参数和部位存在；
- operation在该参数的允许列表中；
- 数值、单位和精度合法；
- 百分比统一使用万分比或标准小数，不混用；
- 公式预览和operation一致；
- clamp参数有合法上下限；
- enum_add引用合法枚举；
- 技术内专用词条不会进入普通池；
- 负分词条有明确代价说明。

### 11.2 被动技能

当前只校验配置完整性：

- 技能ID唯一；
- 名称、部位、触发说明、效果说明和玩家文案非空；
- valueScore和rarity合法；
- 技术内专用政策正确；
- 同一技术没有重复引用相同被动；
- 玩家文案与设计说明没有明显数值冲突。

当前不校验：

- 触发条件是否能由模拟器执行；
- effectLogicText是否合法代码；
- 持续时间、冷却和叠加在运行时是否正确；
- 技能之间的动态运行冲突。

### 11.3 技术

- 至少包含一个词条；
- 所有词条部位与技术部位兼容；
- 没有重复词条；
- 没有对同一参数进行未解释的重复来源加成；
- 总价值评分和品质要求匹配；
- 强优势技术包含代价或更高品质/价格约束；
- 性能定位与技术方向通过软兼容检查。

## 12. 配置快照与导出

配置快照保存：

```ts
interface AffixSnapshot {
  attributeAffixIds: string[];
  passiveAffixIds: string[];
  technologyIds: string[];
  attributeAggregationTrace: AttributeAggregationTrace[];
  finalPanelValues: Record<string, number | string>;
  passiveDesignPayloads: PassiveAffixDefinition[];
  affixValueScore: number;
  qualityId: string;
}
```

被动技能作为结构化Payload导出，但Tackle Forger不声明它已经被游戏运行时实现。

若未来模拟器需要接入，可以使用独立的外部校验或导入流程；不改变当前工具的发布职责。

## 13. 实现优先级

1. 建立属性/被动二分类和统一稀有度；
2. 实现属性词条的统一叠加内核；
3. 建立ParameterDefinition允许的operation和单位约束；
4. 把技术改造成词条组合包；
5. 实现词条价值评分和C/B/A/S品质映射；
6. 增加被动技能结构化编辑与展示，但不执行逻辑；
7. 扩展ItemPart注册表，为钩、漂和饵预留数据能力；
8. 在SKU抽屉和Model详情中展示技术、面板词条和被动技能。

## 14. 待确认事项

当前唯一会直接影响属性计算内核的待确认项是：

> 降低型属性最终采用`Base × (1-Σr)`，还是采用`Base / (1+Σr)`？

本文推荐采用递减收益的`Base / (1+Σr)`，因为它与源表中的总叠加规则一致，也能避免多个降低词条把消耗或损耗压到0以下。
