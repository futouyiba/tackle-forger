# AUD-026 分部位约束、候选搜索与 Model 组件选择语义 ADR

> 状态：`ACCEPTED`
>
> 决策日期：2026-07-23
>
> 父问题：[`AUD-026 / #3`](https://github.com/futouyiba/tackle-forger/issues/3)
>
> 文档治理：[`DOC / #6`](https://github.com/futouyiba/tackle-forger/issues/6)
>
> 权威语义：[`tackle-forger-development-spec-v3.md`](../tackle-forger-development-spec-v3.md)

## 1. 决策

建立版本化、不可变的`PartConstraintSet`。`CandidateSearchRecipe`必须通过稳定的`constraintSetId + revision`引用它，不得复制一个可变的“当前约束”。`PartConstraintSet`按rod、reel、line分别保存组件候选的搜索约束；`CandidateSearchRecipe`只负责在冻结输入下枚举、过滤和排序候选。

`Model.componentSelections`保存最终实际选中的具体组件引用。搜索约束不是组件选择，不能直接写入Model；候选结果也不是Model。只有执行显式物化命令、重新校验权限与冻结revision并通过确定性校验后，候选中选定的竿、轮、线才能写入新的Model草稿revision。

Series的`TypeProfile`继续表达系列级Method × Type结构语义。本ADR不创建分部位type分类。只有组件注册表明确发布了某一部位的版本化type分类时，`PartConstraintSet.typeIds`才可作为该部位搜索约束；否则该字段只能保留和展示，不能参与权威过滤、自动批准或自动发布。

## 2. 领域对象与不可变引用

`PartConstraintSet`至少具有以下身份与版本语义：

- `constraintSetId`是终身稳定且不复用的对象身份；
- `revision`标识一次不可变内容版本，修改任一部位、字段、来源或复核结论都创建新revision；
- 内容哈希、创建身份、创建时间、来源revision和迁移诊断属于该revision的审计证据；
- rod、reel、line分别保存约束和复核状态，一个部位可以是`CONFIRMED`，另一个仍为`NEEDS_REVIEW`；
- `CandidateSearchRecipe`冻结并引用精确的`constraintSetId + revision`；运行时禁止把引用解析为后来发布的“最新revision”；
- 已被CandidateRun、Model物化记录或ConfigurationSnapshot证据引用的revision不得原地改写或删除。

规范引用形态为：

```text
CandidateSearchRecipe revision
  → PartConstraintSet(constraintSetId, revision)
    → rod constraints
    → reel constraints
    → line constraints
```

`PartConstraintSet`不是Series、SKU、Model或组件注册表。它只声明候选搜索约束，不拥有具体组件，也不改变Series Type、Quality、Function或Performance身份。

## 3. 字段所有权

| 字段 | 权威所有者 | 语义 | 禁止行为 |
| --- | --- | --- | --- |
| `templateIds` | `PartConstraintSet`的单一部位约束 | 限制该部位候选组件可引用的模板；按稳定模板ID匹配 | 当作具体组件ID写入Model，或跨部位复用后宣称已经确认 |
| `materialIds` | `PartConstraintSet`的单一部位约束 | 限制该部位候选组件可引用的材质；按组件注册表的版本化材质引用匹配 | 缺少注册表元数据时按名称猜测或静默放宽 |
| `requiredAffixIds` | `PartConstraintSet`的单一部位约束 | 候选组件必须满足的该部位词条条件；任一引用未知或无法验证时fail-closed | 把required降为排序偏好，或把其他部位词条算作满足 |
| `optionalAffixPoolIds` | `PartConstraintSet`的单一部位约束 | 候选扩展和版本化排序可使用的该部位词条池；不等于必需条件或已选词条 | 自动写入组件/Model，或使用未版本化隐式权重改变顺序 |
| `typeIds` | 有条件的`PartConstraintSet`单一部位约束 | 仅当组件注册表明确提供该部位的版本化type分类时生效 | 复用Series Type充当组件分类，或擅自定义当前不存在的部位type |
| `componentSelections` | 候选结果与Model | 指向本次候选实际选定的具体组件；物化后写入`Model.componentSelections` | 存入`PartConstraintSet`/`CandidateSearchRecipe`，或从搜索约束机械合成 |

`optionalAffixPoolIds`对候选扩展或排序的具体算法必须由冻结的排序定义和Trace解释；本ADR不规定永久权重。它不能绕过硬Compatibility、required条件或部位边界。

## 4. 候选搜索与物化

一次权威候选运行固定执行：

```text
冻结Series/SKU/CandidateSearchRecipe/PartConstraintSet/组件注册表/RuleSet/Patch revision
→ 按rod/reel/line分别枚举组件
→ 应用template、material、required affix和有效的部位type硬过滤
→ 使用optional affix pool及已发布排序定义扩展或排序
→ 组合具体rod/reel/line组件
→ 执行杆轮线闭环硬兼容、Affinity、Series不变量和稳定排序
→ 产出包含componentSelections的不可变候选结果
→ 显式物化并重新鉴权、重验revision
→ 创建或更新Model草稿revision
```

规则如下：

- `CandidateSearchRecipe`拥有搜索范围、阈值、检查点和排序引用；它不拥有具体组件选择；
- 每项过滤和排序必须记录部位、字段、`PartConstraintSet` revision、注册表revision、命中/排除原因和未知引用；
- 0结果、未知ID、缺失分类、跨部位引用和required冲突都必须返回可操作诊断，不得退化为“允许全部”；
- 候选只是一轮搜索的不可变审计结果，不具有商品身份、购买身份或发布资格；
- 物化是候选到Model的唯一边界；只有候选中具体的`componentSelections`能进入Model；
- 自动物化也必须重新检查`candidate.materialize`权限、输入revision、硬兼容和发布前置条件；
- 未物化候选被丢弃、过期或superseded时，不产生Model变更。

## 5. 旧数据治理

schema v13→v14把同一套旧扁平`templateIds`、`structureIds`、`requiredAffixIds`和`optionalAffixPoolIds`复制到rod、reel、line，并把三个部位的`materialIds`置空。该迁移只建立兼容保留载体，不证明相同模板、类型或词条对三个部位都有效，也不是已经确认的领域语义。

后续迁移必须遵守：

1. 原始legacy payload、来源对象ID、来源revision、迁移器版本、迁移时间和逐字段诊断原样保留；旧载体没有revision时明确记录“缺失”诊断，不得生成一个伪造revision；
2. 未知ID和未知字段不得丢弃、改名或按显示名绑定，必须原样进入保留payload与诊断；
3. rod、reel、line分别产生复核状态，允许独立处于`NEEDS_REVIEW`；
4. 被复制的旧字段默认全部为`NEEDS_REVIEW`，不得因数组非空、三个部位内容相同或迁移成功而自动转为`CONFIRMED`；
5. `NEEDS_REVIEW`数据可以在迁移预览和UI中保留、展示和人工比较，但不能作为权威自动过滤/排序结果支持自动批准或自动发布；非正式试算必须显式标记，不能生成可发布Model；
6. 未确认字段不得静默猜测、按名称补全、跨部位借用或放宽为“允许全部”；
7. 人工确认以原迁移记录为来源，创建新的规范化`PartConstraintSet` revision；不得覆盖、删除或把原迁移记录改写成“已经确认”；
8. 相同输入和迁移器版本重复运行必须得到相同保留记录、诊断、状态和稳定ID，不重复追加revision或复核项；
9. 任何冲突或无法解析项都fail-closed，只阻止受影响的新批准/发布路径，不删除历史只读数据。

## 6. ConfigurationSnapshot冻结

已发布`ConfigurationSnapshot`的payload、组件选择、引用revision和content hash永久冻结。`PartConstraintSet`迁移、人工确认、新revision、组件注册表更新、候选重跑或上游规则变化均不得原地修改、补写或重算历史Snapshot。

如果新约束意味着已发布Model存在更优或不同组件，只能生成UpgradeCandidate；用户完成新的候选搜索、物化、复核和发布后创建新的Snapshot。迁移发现历史Snapshot与当前注册表不一致时保留原内容并产生诊断，不能“修复”旧hash。

## 7. UI约束

候选搜索、迁移复核和Model预览必须把rod、reel、line分栏展示。每个部位至少显示：

- `PartConstraintSet`身份与revision；
- template、material、required affix、optional affix pool，以及有条件的type约束；
- 每个字段的来源对象、来源revision和`CONFIRMED`/`NEEDS_REVIEW`状态；
- 未知ID、未知字段、迁移诊断和不可用原因；
- 候选命中/排除/排序原因；
- 最终候选与Model的具体`componentSelections`，并与搜索约束视觉分离。

UI不得只显示合并后的扁平集合，不得用Series Type冒充部位type，也不得用颜色或“迁移成功”文案暗示未复核数据已经确认。存在任何受影响的`NEEDS_REVIEW`时，自动批准和自动发布动作必须由服务端返回禁用原因。

## 8. 测试与验收

- 正常：三个部位分别命中各自模板、材质和required词条，optional池影响扩展/稳定排序，物化后具体组件只落入Model；
- 边界：空约束、单一ID、未知ID、未知字段、禁用组件、缺少部位type分类、0候选和最大候选数均有确定结果；
- 冲突：跨部位词条、required缺失、type分类revision不匹配、硬Compatibility deny和复核状态冲突均fail-closed并输出部位级原因；
- 所有权：搜索约束不能被序列化成`componentSelections`，候选未物化不创建/更新Model；
- 迁移：v13→v14复制被识别为保留载体，三个部位独立`NEEDS_REVIEW`，未知数据保留，重复迁移幂等；
- 人工确认：确认产生新规范化revision，原payload、来源revision和迁移诊断保持不变；
- UI：rod/reel/line、约束来源、复核状态、排除原因和最终组件选择分别可见；
- Snapshot：迁移、确认、重跑和注册表更新前后，历史Snapshot payload与hash逐字节不变。

## 9. 非目标与后续实现

本ADR不修改运行时代码、schema、迁移器、组件注册表、生产数据或历史Snapshot，也不定义当前不存在的组件type分类。文档完成不等于AUD-026实现完成。

后续应拆分数据模型、迁移、候选runtime、Model物化、UI和测试任务；每项独立引用父Issue #3与文档治理Issue #6，并以本ADR和v3规范为验收依据。
