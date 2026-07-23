# OPEN-007 价值分、派生性能定位与定价执行语义 ADR

> 状态：`ACCEPTED`
> 决策日期：2026-07-23
> 决策来源：产品负责人在 Codex 主任务及后续逐项批注中的明确确认
> 关联 Issue：[#9](https://github.com/futouyiba/tackle-forger/issues/9)、[#10](https://github.com/futouyiba/tackle-forger/issues/10)
> 权威落点：`docs/tackle-forger-development-spec-v3.md`

## 1. 决策

### 1.1 价值分与性能定位

价值分固定为：

```text
baseAffixScore
= Σ去重后的有效词条.valueScore
+ Σ同部位、无序词条对的combinationScore

finalValueScore
= baseAffixScore × FunctionProfile.scoreFactor
```

Technology只展开成员词条；成员词条与组合分按普通规则进入`baseAffixScore`，Technology本身不再贡献一次分值。

性能定位不是独立配置输入、评分乘数、属性贡献层或Series硬身份。它是在Series/Model完成Technology、词条与最终属性结算后生成的只读`PerformanceSummary`，例如“抛投+、重量-、竿度+”。该摘要只用于展示、筛选和解释，不得反向改变候选生成、结构标杆匹配、属性、品质、兼容、Affinity、定价或Snapshot中的确定性值。

缺少`PerformanceSummaryDefinition`时保持非阻断：发布证据和Snapshot冻结`UNAVAILABLE/definition_missing`，摘要与定义引用均为空；不得伪造默认摘要或把该缺失升级为发布配置不完整。定义可用时才冻结`AVAILABLE`摘要及其定义版本。

历史`PerformanceProfile`、`performanceId`、性能规则和评分字段保留为迁移证据与历史Snapshot引用；新规范化revision不得继续写入这些字段。迁移不得按名称把历史性能对象猜测为Technology或Affix。

### 1.2 品质100分

S/橙品质区间为`[65,100]`。评分100合法并命中S；大于100产生`QUALITY_SCORE_OUT_OF_RANGE`并阻止正式发布。不得把越界值夹取为99或100，也不得外推价格系数。

当前飞书源若仍把S写为`[65,100)`，属于已知的过期源契约。导入器必须保留源值并产生规则源待更新Issue；在新源revision与本决策一致前，不得把旧Draft冒充为新的正式策略。

### 1.3 舍入、最低价与购买价输入

所有中间计算保持未舍入精度：

```text
repairPriceRaw = 完整维修价公式
purchasePriceRaw = repairPriceRaw × 购买系数 ÷ 零整比
repairPrice = significant_digits_floor(repairPriceRaw, 3)
purchasePriceRounded = significant_digits_floor(purchasePriceRaw, 3)
purchasePrice = max(purchasePriceRounded, 100)
```

购买价必须使用未舍入维修价。维修价和购买价只在各自最终输出阶段分别执行三位有效数字向下取整。最低价格100只作用于最终购买价，并在购买价舍入后应用；不得作用于维修价或再次作用于多个对象的汇总价。

### 1.4 300,000,000超限确认

价格上限改为软性确认阈值，不是裁剪上限：

- 比较对象是`purchasePriceRaw`；
- 超过300,000,000产生`PRICE_UPPER_THRESHOLD_CONFIRMATION_REQUIRED`；
- Issue为`WARNING`，命中`PUBLISH` Gate；
- 未确认时要求用户二次确认；确认后保留实际舍入购买价，不`BLOCK`、不报`ERROR`、不`CLAMP`；
- 确认使用`ACKNOWLEDGED`，不是`WAIVED`。

确认记录至少冻结Issue fingerprint、Model revision、PricingPolicyVersion、inputHash、未舍入/舍入/最终价格、阈值、确认人、确认时间和理由。输入、Model revision、PricingPolicyVersion、价格或fingerprint任一变化，旧确认转为`STALE`，不得自动沿用。ConfigurationSnapshot和导出证据必须冻结超限标记及确认引用。

该PUBLISH WARNING的fingerprint包含Model revision、PricingPolicyVersion、inputHash、`purchasePriceRaw/purchasePriceRounded/purchasePrice`和阈值，不包含环境或渠道。只有独立EXPORT schema/关系BLOCKER的fingerprint包含`environmentId + channelKey`。其`ActionLink.action`直接返回统一`ActionCode=acknowledge_price_warning`并绑定类型化、不可篡改payload；不得以通用`acknowledge_warning`替代正式命令。

如果目标配置字段、Excel schema或游戏编译器不能表示实际价格，这是独立的`config_relationship`或`data_integrity` `BLOCKER`；二次确认不能绕过不可表示、溢出或损坏数据风险。

## 2. 执行顺序

```text
词条/Technology展开与去重
→ 组合分
→ FunctionProfile.scoreFactor
→ 品质区间校验
→ 结构源重量段与PricingBasket查表
→ repairPriceRaw
→ purchasePriceRaw
→ 检查超限确认阈值
→ 分别舍入维修价与购买价
→ 对购买价应用最低价100
→ 冻结Trace、Issue/确认与价格
```

`PerformanceSummary`在词条、Technology与最终属性结算完成后派生，但不插入上述计算链。

## 3. 当前实现差距

截至基线`3cb6609c237c0c23d108bf305124e24f18980fa8`：

- 质量内核仍允许`performanceScoringEnabled/performanceScoreFactor`并输出`performance_factor` Trace；
- Series、候选生成、规则内核、Affinity和UI仍把Performance当作显式输入；
- PricingMoneyPolicy仍使用`roundingStage/minimumPriceScope/overflowMode`，不能完整表达两个独立输出和购买价的未舍入输入；
- 超限运行时仍只有`error/clamp`，尚无基于fingerprint的WARNING确认记录；
- 现有`warningConfirmations`按code保存理由，不能满足revision、策略与inputHash变化后的失效要求；
- 当前飞书revision `2869`仍可能包含S上界旧写法和旧说明文本。

因此本ADR与v3修订只关闭产品语义选择，不宣称运行时已经完成。父Issue #9负责后续schema、迁移、领域计算、确认记录、发布/导出和UI实现；在实现、源表更新和新策略发布完成前，现有新PricingPolicyVersion仍保持`NON_FORMAL`或禁止发布。

## 4. 迁移与冻结要求

- 使用顺序workspace schema迁移，不删除未知字段或原始Payload；重复迁移幂等。
- 已发布PricingPolicyVersion、ConfigurationSnapshot、价格、Trace和确认记录不可原地改写。
- 历史性能输入只读保留；人工迁移生成新的规范化revision，不覆盖原记录。
- 旧`overflowMode=error/clamp`只解释对应旧策略版本；不得静默转换成新确认语义。
- 旧确认不得只凭相同code迁移为有效确认。

## 5. 必测场景

- 评分100命中S，100以上阻止正式发布且不夹取。
- Technology成员与直接词条按affixId去重，性能摘要不重复计分。
- 相同词条/组合与功能系数产生确定相同的价值分和Trace。
- 维修价和购买价分别最终舍入；购买价使用未舍入维修价。
- 购买价舍入后低于100时提升到100，维修价不应用最低价。
- `purchasePriceRaw`超过300,000,000时产生WARNING；确认后保留真实价格和标记。
- Model revision、策略、inputHash或价格变化使旧确认STALE。
- PUBLISH价格确认fingerprint不随环境/渠道拆分；独立EXPORT BLOCKER按环境×渠道区分。
- ActionLink直接返回`acknowledge_price_warning`及不可篡改payload，篡改或过期引用被拒绝。
- 缺少PerformanceSummaryDefinition时发布仍成功并冻结`UNAVAILABLE/definition_missing`。
- 下游整数容量不足时即使已确认超限WARNING仍由独立BLOCKER阻止导出。
- 旧策略、旧Snapshot与旧确认在迁移前后hash和语义不变。

## 6. 回滚

若后续实现发生问题，回滚只能停止新策略发布和超限确认入口，并恢复到旧契约的只读兼容适配器。不得把新记录转换回旧`error/clamp`语义，不得删除确认审计，也不得重写任何已发布策略或Snapshot。
