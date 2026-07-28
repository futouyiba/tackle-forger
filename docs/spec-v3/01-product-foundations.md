## 1. 产品目标与范围

Tackle Forger是一套内部钓具配置生产工作台，负责：

```text
飞书规则源
→ 已发布规则集
→ 多维派生模板
→ 产品族、Series与独立Part
→ 重量段下的SKU抽屉
→ 具体Model
→ 配置快照
```

### 1.1 当前负责

- 参数、重量模板、钓法、类型、功能、品质规则与性能摘要派生；
- 属性词条、被动技能词条和技术组合；
- 以重量段和Part配置唯一定位04.5功能模板；
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
    F --> G["Series Part + WeightBand"]
    G --> H["Unique 04.5 Match"]
    H --> I["Effective SKU Entries"]
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
| Series | 组织1～3个互不重复竿/轮/线Part的系列容器；不统一保存钓法、功能定位或目标拉力 |
| Part | Series内独立编辑的竿、轮或线配置；拥有钓法、材质类型、功能定位/强度、统一词条与Technology |
| WeightBand | 01.x提供的离散目录项、区间、显示顺序与甘特坐标；不是SKU最终拉力基准 |
| FunctionTemplate04_5 | 按Part配置与weightBandId唯一匹配的04.5.0/1/2功能模板行，是SKU数值基准 |
| SKU | 玩家看到的钓具抽屉；属于一个Part和一个weightBandId，同一Part同一重量段可以有多个SKU |
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
Part配置
→ 用户选择01.x重量段
→ 04.5功能模板唯一匹配
→ Part统一词条与Technology继承
→ SKU增加/屏蔽/局部副本与SKU Technology
→ SKU有效词条结算
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
4. 重量段选择与04.5唯一匹配；
5. SKU预览与显式新增；
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

Part固定FunctionProfile并显式保存`functionIntensity`。目标态中二者都是04.5唯一匹配键的一部分；任何变化都必须重新匹配并重算该Part的已有SKU，无法唯一匹配时SKU进入失效态。旧结构标杆流程中的`postMatchContributions`只用于历史v9/v22读取与旧Snapshot重放，不得反向定义新SKU主流程。

## 5. 重量段、04.5功能模板与目标态SKU派生

### 5.1 目标态唯一匹配键

```text
partType
+ weightBandId
+ fishingMethod
+ materialType
+ functionProfile
+ functionIntensity
```

系统必须用上述六个输入精确定位对应部位的`04.5.0/04.5.1/04.5.2`功能模板行。零匹配和多匹配均fail-closed；不得加入旧`typeId`、`targetPullKg`、最近距离、区间包含或名称猜测来消歧。源表旧字段如何映射为这六个键属于v23实现迁移事项，不能改变本节目标语义。

### 5.2 01.x与SKU预览

01.x只提供重量段稳定ID、区间、显示顺序及甘特图坐标。用户点击重量段后，系统先执行5.1唯一匹配；成功后进入该Part、该重量段的SKU预览，先列出现有SKU并提供“新增SKU”。点击重量段本身不得静默创建或修改任何数据。同一Part、同一重量段允许多个SKU。

用户不直接填写`targetPullKg/targetKgf`或最终拉力。SKU最终拉力只由唯一04.5基准与`effectiveSkuEntries`中的属性操作确定性派生，不进行连续插值，也不通过最终值输入框补差。

### 5.3 匹配记录与失效

```ts
interface FunctionTemplateMatch {
  functionTemplateRef: { templateId: string; revisionId: string; contentHash: string };
  partId: string;
  weightBandId: string;
  inputFingerprint: string;
  status: "VALID" | "INVALID_NO_MATCH" | "INVALID_AMBIGUOUS";
  matchedKey: {
    partType: string; weightBandId: string; fishingMethod: string;
    materialType: string; functionProfile: string; functionIntensity: number;
  };
}
```

SKU持久化`weightBandId`、稳定`functionTemplateRef`和完整输入指纹。Part上游配置变化后，已有SKU重新匹配并重算；零/多匹配时保留SKU与用户局部意图，将其标为失效并阻止批准/发布，不得猜测模板。

### 5.4 历史兼容

Schema v9的`targetPullKg/ProjectionMatch/ProjectionPin`是历史迁移输入；当前主线Schema v22仍实现直接拉力与最近标杆流程。二者都只服务历史读取、迁移证据和旧Snapshot重放。目标实现必须新增Schema v23及顺序迁移，不能原地改变v9或v22语义，也不能重算既有Snapshot。
