## 1. 产品目标与范围

Tackle Forger是一套内部钓具配置生产工作台，负责：

```text
飞书规则源
→ 已发布规则集
→ 多维派生模板
→ 产品族与严格系列
→ SKU重量抽屉
→ 具体Model
→ 配置快照
```

### 1.1 当前负责

- 参数、重量模板、钓法、类型、功能、品质规则与性能摘要派生；
- 属性词条、被动技能词条和技术组合；
- 最近派生模板匹配；
- 兼容、属性平衡、系列不变量和杆轮线闭环；
- Series、SKU和Model的人工Patch；
- 品质评分、稀有度和配置发布；
- 飞书同步、版本、冲突、回写建议和历史复现。

### 1.2 当前不负责

- 被动技能运行；
- 钓鱼、抛投、诱鱼和环境模拟；
- 玩家背包、交易、库存和经济执行；
- 动态战斗平衡热更新；
- 美术资源生产。

本工具可以为这些系统导出数据，但不承担其运行时正确性。

## 2. 权威术语与层级

```mermaid
flowchart LR
    A["Weight Template"] --> B["Method Profile"]
    B --> C["Type Profile"]
    C --> D["Function Profile"]
    D --> E["Structural Benchmark"]
    E --> F["Series"]
    F --> G["SKU Drawer / targetPullKg"]
    G --> H["Nearest Structural Match"]
    H --> I["Intensity + Material + Patch + Affix"]
    I --> J["Purchasable Model"]
    J --> P["Derived Performance Summary"]
    P --> K["Configuration Snapshot"]
```

| 对象 | 权威定义 |
| --- | --- |
| WeightTemplate | 某重量段的中性面板基准 |
| MethodProfile | 路亚、浮钓等玩法系数与约束 |
| TypeProfile | 纺车+直柄、水滴+枪柄等结构套系 |
| FunctionProfile | 泛用、远投、障碍强攻等玩法方向 |
| functionIntensity | 同一功能方向的专精强度1/2/3 |
| PerformanceSummary | Series/Model完成Technology、词条与最终属性结算后派生的只读性能定位摘要，例如抛投+、重量-、竿度+；不是配置输入或数值贡献层 |
| QualityProfile | C/绿、B/蓝、A/紫、S/橙的系列品质身份；本身不直接修改面板 |
| StructuralBenchmark / DerivedProjection | 仅由基础拉力模板×钓法×类型×功能定位演绎出的只读结构标杆 |
| Collection | 营销产品族，可包含多个严格Series |
| Series | 钓法、类型、核心功能和核心词条稳定的系列；性能定位由配置结果派生，不是Series身份字段 |
| SKU | 玩家看到的钓具抽屉，对应一个离散targetPullKg；界面可显示为重量规格 |
| Model | SKU抽屉中的具体可购买型号 |
| ConfigurationSnapshot | Model发布时冻结的最终配置 |
| Technology | 多个原子词条的命名组合包 |
| Affix | 属性或被动技能的原子单位 |
| Patch | 对继承结果的局部、可追踪调整 |

## 3. 标准生成顺序

### 3.1 模板与定位层

```text
WeightTemplate
→ MethodProfile
→ Method-layer Patch
→ TypeProfile
→ Method×Type Patch
→ FunctionProfile
→ Function-layer Patch
→ StructuralBenchmark / DerivedProjection
```

钓法和类型保持两个数据与规则层。工作台可以把它们放在同一个“玩法与结构”操作步骤中，但执行轨迹必须分开。

真正依赖Method × Type的特殊修正使用条件规则：

```text
WHEN methodId = lure AND typeId = baitcast
APPLY rules = [...]
```

系统可以按需物化和缓存“拉力模板×钓法×类型×功能定位”的有限结构标杆，但缓存不是人工源数据。`functionIntensity`、Quality、Material、词条和Technology均不进入结构标杆维度，也不参与最近模板搜索；`PerformanceSummary`在商品配置完成后才派生，更不得作为搜索输入。

### 3.2 商品层

```text
StructuralBenchmark最近匹配
→ functionIntensity显式贡献
→ Material策略
→ SeriesPatch
→ SkuPatch
→ ModelPatch
→ Affix/Technology结算
→ FinalReviewPatch
→ 最终边界校验
→ PerformanceSummary只读派生
→ ConfigurationSnapshot
```

Patch作用域越靠后，影响范围越小，优先级越高。

### 3.3 自动推进与阶段检查点

所有生成阶段默认`AUTO_CONTINUE`，不把人工选择设计成阻断式必经步骤。工作区可以为每个阶段配置`AUTO_CONTINUE`或`REVIEW_ON_CHANGE`，单次运行可临时覆盖：

1. 基础模板×Method；
2. 基础模板×Method×Type；
3. 基础模板×Method×Type×FunctionProfile；
4. 目标拉力最近标杆匹配；
5. SKU组装；
6. Model候选与自动物化；
7. 最终Model配置；
8. 发布与导出。

`REVIEW_ON_CHANGE`只在新inputHash首次计算后暂停；相同inputHash不重复要求确认。任何硬阻断都必须停止。阶段状态为`NOT_RUN/RUNNING/CURRENT/WAITING_FOR_REVIEW/DIRTY/BLOCKED/FAILED/SUPERSEDED`。上游变化只把真正依赖的下游草稿标为DIRTY：自动阶段重算，复核阶段重算后等待；已发布Snapshot永不DIRTY，只生成UpgradeCandidate。

## 4. 品质与功能专精

### 4.1 品质唯一映射

| 内部ID建议 | 字母 | 颜色 | rank |
| --- | --- | --- | --- |
| quality_c_green | C | 绿 | 1 |
| quality_b_blue | B | 蓝 | 2 |
| quality_a_purple | A | 紫 | 3 |
| quality_s_orange | S | 橙 | 4 |

字母和颜色是同一个QualityProfile的两个展示字段。不得再使用“金”作为S品质的当前名称；历史快照可以保留旧文案。

### 4.2 功能方向与强度

FunctionProfile是并列类别，不是等级。例如：

- 泛用；
- 远投；
- 精细感知；
- 快速操控；
- 障碍强攻；
- 大饵动力；
- 持久征服。

`functionIntensity`表示专精强度：

| 值 | 展示 | 含义 |
| --- | --- | --- |
| 1 | 轻度专精 | 接近中性，优势和代价较轻 |
| 2 | 标准专精 | 功能表达明确 |
| 3 | 极致专精 | 优势最大，代价也最大 |

Quality表示完成度，functionIntensity表示偏科程度，二者独立。

Series固定FunctionProfile；`functionIntensity`遵循版本化的固定值或重量曲线策略。每个`FunctionProfile × level × parameter`都必须显式定义`postMatchContributions`，不得假设统一线性倍率。它在结构标杆匹配完成后应用，数值变化不得触发重新匹配。

## 5. DerivedProjection与最近匹配

### 5.1 派生键

```text
weightTemplateId
+ methodId
+ typeId
+ functionProfileId
+ ruleSetVersion
```

StructuralBenchmark按需计算并缓存，不预先持久化其他近乎无限的词条/Technology组合。缓存只存结果、来源版本和哈希，不成为人工编辑源。

### 5.2 目标拉力匹配

“重量段/重量规格”是面向设计人员的历史界面文案，权威计算语义是拉力段/目标拉力。匹配不插值，顺序固定为：

1. itemPart、Method、Type、FunctionProfile完全相同；
2. 排除硬不兼容标杆；
3. 在已经交叉演绎完成的结构标杆中比较比例距离；
4. 距离相同时优先选择`derivedPullKg`较高者；
5. 再按版本化`templatePriority`；
6. 最后按稳定模板ID排序。

```text
pullDistance = abs(ln(targetPullKg / derivedPullKg))
```

不得使用范围包含、Affinity、最终属性距离或随机数参与结构标杆选择。1.5kg和1.8kg可以命中同一标杆，但仍是两个独立SKU。词条、Quality、Material和后置Patch改变最终拉力时，不重新选择结构标杆；派生`PerformanceSummary`只观察最终结果，也不触发重新匹配。

### 5.3 匹配记录

```ts
interface ProjectionMatch {
  projectionMatchId: string;
  projectionMatchRevisionId: string;
  itemPartId: string;
  targetPullKg: number;
  matchedStructuralPullKg: number;
  projectionId: string;
  projectionRevisionId: string;
  weightTemplateId: string;
  ruleSetVersion: string;
  pullDistance: number;
  reasons: string[];
  alternatives: string[];
  projectionPinId?: string;
}
```

后端统一使用`targetPullKg/derivedPullKg/matchedStructuralPullKg/modelFinalPullKg`。历史`targetWeightKg`只通过迁移适配读取，不得删除历史字段。普通Patch不得反向影响模板选择；人工固定选择使用独立`ProjectionPin`，不是Patch。
