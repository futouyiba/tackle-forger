# Tackle Forger 产品设计完成交付 v3

> 状态：开发可执行  
> 领域权威：`docs/tackle-forger-development-spec-v3.md`  
> 交互权威：本文；不得改变 v3 领域语义  
> 视觉方向：`docs/ux/tackle-forger-ux-design-v1.md` 与 `docs/ux/prototype-v1/`  
> 审查日期：2026-07-20
> 最后对齐v3：2026-07-22

## 0. 核心边界

**“钓具系列甘特图”是界面心智模型，不是新增领域实体；“AI评估与建议”是带证据的辅助层，不是新的规则裁决层。**

固定语义：有限结构标杆只由基础拉力模板×Method×Type×FunctionProfile组成；在相同身份内按拉力比例距离取最近且不插值，Affinity不参与匹配；`functionIntensity`、Performance、Material、Quality和词条均在匹配后处理；C/绿、B/蓝、A/紫、S/橙；SKU是抽屉，Model是实际选择/购买对象；Technology不重复叠加成员属性；被动只保存、计分、展示；已发布Snapshot永不被静默替换。

```mermaid
flowchart LR
  G["钓具系列甘特图"] --> S["Series"]
  S --> K["SKU 抽屉（离散重量）"]
  K --> M["Model（购买对象）"]
  M --> P["发布检查"]
  P --> F["ConfigurationSnapshot（冻结）"]
  F --> E["导出 tackle/item/store"]
  E --> V["TOML 关联校验"]
  U["上游变化"] --> C["UpgradeCandidate"]
  C -->|人工批准并重新发布| F2["新 Snapshot"]
  C -.不得重写.-> F
```

## 1. 页面与全局交互

| 一级入口 | 主对象 | 主任务 |
| --- | --- | --- |
| 钓具系列甘特图 | Series、SKU 摘要 | 查询、规划、下钻 |
| SKU 抽屉 | SKU、Model 列表 | 管理一个离散重量下的 Model |
| Model 管理 | Model Revision | 属性、Trace、兼容、五维、Patch |
| 发布管理 | Model、SnapshotBuild | 发布检查、冻结、升级候选 |
| 配置表交付 | SnapshotBatch、环境×渠道目标 | 预览、写入、关联校验 |

采用高密度数据驾驶舱。左侧稳定一级导航；顶部面包屑与全局搜索；主区优先矩阵、表格和差异；右侧 520–640px 推入层按“1 常用概览 → 2 五维与适配 → 3 来源与版本”渐进披露，并保留独立的“Patch / Rebase”和“AI评估与建议”入口。常用概览默认展示对象身份、离散目标拉力、调性/硬度、长度、发布/冻结面、品质定价和四套独立裁决；五维层才展开三种比较模式；来源层展示完整Trace。所有写按钮消费后端 `ActionAvailability`，前端不从角色、颜色或状态猜动作。

## 2. 钓具系列甘特图

查询直接使用 v3 `SeriesGanttQuery`：

- 同字段 OR、不同字段 AND；文本只搜有权查看的 ID、名称、别名。
- 支持Collection、Method、Type、品质、功能、部位、生命周期、注意状态、Issue、升级候选、精确targetPullKg、RuleSetVersion。
- 筛选和排序写入 URL；刷新保留滚动和选择。对象不可见时退回最近可见父级。
- 纵轴是版本化重量分段；横轴先按 C/B/A/S，再按启用 Type。
- Series 覆盖块只连接真实离散 SKU 节点。固定提示：**覆盖范围只表达系列规划跨度，不代表连续插值。**
- 点击 Series 只更新底部摘要；点击 SKU 只进入 SKU 上下文；只有点击 Model 行才打开右侧预览。单 Model 也不得跳级。
- 展开 Series 后 SKU 按精确重量升序；展开 SKU 后 Model 使用服务端游标。
- 聚合返回直接生命周期、全部注意状态、后代计数、可见 Model 数、硬阻断、warning、升级候选。无权知总数时省略总数。
- 主状态优先级：硬冲突 > rebase > 待复核 > warning > 待发布 > 升级候选 > 已发布 > 草稿；副状态与计数保留。
- 矩阵空白和重量分段不创建 SKU；只能通过“添加重量规格”输入精确重量并预览最近模板。

## 3. 稳定身份、面包屑和权限

路由与命令携带 `EntityRef { entityType, entityId, revisionId? }`。ID 终身稳定、不复用；重命名、改重量、更换默认 Model 不改 ID。父链固定：

```text
Collection（可缺省） → Series → SKU 抽屉 → Model → 冻结快照
```

SKU 显示“精确重量 + SKU 抽屉”；Model 显示型号并标明“实际选择/购买对象”；Snapshot 显示版本、冻结时间和 hash。无权父级使用允许披露的占位，不泄露名称、状态、数量。read/edit/review/publish 分别判断；按钮显示服务端 disabledReason 和 requiredCapabilities。一期飞书登录后仍返回能力字段，三期只替换权限策略。职责分离由 `separationOfDutiesPolicy` 决定。

## 4. 生成 Model 候选

入口位于 Series/SKU 上下文，不是一级实体。生成前确认：

- Series、SKU精确targetPullKg、最近结构标杆；
- CandidateSearchRecipe/Revision、RuleSetVersion、Patch Revision；
- 搜索空间、启用modelVariantKey、每SKU数量、最低Affinity、warning接受、排序版本、截断；
- 明示“硬 deny/缺 require 会被排除，Affinity 只排序”。

结果按 SKU 分组、组内使用后端稳定 rank；前端和 AI 不得二次改序。候选展示 fingerprint、rankReasons、模板距离、硬兼容、Affinity 分轴、不变量偏离、warning 和 Trace。顶部展示枚举总数、合法数、排除分组、截断、输入 hash、耗时。

默认对每个`SKU × enabledModelVariantKey`自动物化排名最高的合法候选：唯一命中旧Model时创建新revision，无命中新建Model，多重/歧义命中则跳过并报Issue，内容不变不创建空revision。用户通过范围、路线、数量、阈值或REVIEW_ON_CHANGE限制批量行为，也可显式改选/放弃。候选run保留审计；“放弃本次结果”不删除Series/SKU/Model/Trace。运行中Revision改变则superseded；失败或超时按requestId/idempotencyKey恢复。同输入、规则和算法必须同序，不使用常规random seed。

## 5. 属性来源 Trace

前端只消费内核产生的 `CalculationTraceEntry`。每步必须显示 subjectRef、parameterKey、sequence、layer、sourceRef、sourceVersion、ruleSetVersion、before、operation、operand、after、unit、effect、warningIssueIds、ActionLink、inputHash/outputHash。

属性矩阵展示来源层摘要；“来源 N”打开按 sequence 排列的 Trace。公式展开 formulaId/version 和结构化操作数；no_effect 显示“本层无贡献”，不得伪造 +0；Technology 只展示成员 Affix 的贡献。warning 跳统一 Issue。Snapshot Trace 只读；重放 hash 不符产生 `TRACE_REPLAY_MISMATCH` 并阻止发布。

## 6. 可配置五维图

前端只消费版本化 `FiveAxisViewDefinition`。恰好五轴，但 axisId、名称、顺序、输入、变换、顶点、聚合、缺值、档位都不得写死。图旁显示 definition/version、fiveAxisRuleVersion、fishWeightGradeId、vertexSetHash、刻度和“查看来源”。定义、鱼重基准或 hash 不同的曲线不得叠加。

右侧层提供三个视图：

1. **Model / Series**：当前 Model 与明确 Series 基准。
2. **竿轮线匹配**：Rod/Reel/Line 同图，可开关 Model 短板汇总，共享 Model 鱼重基准。
3. **同部位比较**：比较篮中 2–5 个同部位对象，共用一个鱼重基准；上限配置化。

“加入比较”写入页面级比较篮；混入不同部位时阻止并提供“新建比较组”。轮/线无参考竿时抛投为 not_applicable；指定参考竿后为 context_inherited，不参与排名。

Series 基准只允许 explicit_model、approved_model_median、projection_reference 三种后端策略；必须显示 baselineRef/aggregateRef、Revision、样本数和理由。失效时不静默回退。

状态：direct 实线；context_inherited 虚线/链接标；not_applicable 不画 0；missing 显示补齐动作；error 阻断且不画 0。雷达图下必须有原始值、归一化比值、正式分、comparisonScore、overflow、相对差、来源状态和 Trace 的数值表。

## 7. AI 评估与建议

`AIRecommendation` 卡片至少显示 recommendationId/assessmentId、scopeRefs、标题摘要、EvidenceRef、assumptions、未覆盖信息、影响属性 before/proposedAfter、建议动作、generatedAt、inputHash、RuleSetVersion、fiveAxisRuleVersion、提示模板和模型记录策略、fresh/stale 状态。

固定护栏：**辅助建议 · 不影响系统校验**。硬兼容、Affinity、系列不变量、AI建议是四个独立区块。AI只允许`preview_only`、`create_model_patch_draft`、`create_rule_source_change_draft`。

### 7.1 转 Model Patch 草稿

1. 确认目标 Model ID/Revision 和建议中的属性子集；不能改成 Series/SKU Patch。
2. 展示 before、operation/operand、确定性 after、五维/Issue/Affinity/不变量差异。
3. 必填人工理由；保存 draft，记录 AI 来源、创建人和人工改动，再走正常审核。

recommendation stale、Model 变化、已有未决 set、非法 operation、目标冻结时禁用并提供刷新/rebase/复制新 Revision。保存失败保留表单与幂等键。

### 7.2 转飞书规则修改草稿

AI只创建`RuleSourceChangeDraft(LOCAL_DRAFT)`。人工确认稳定规则ID/参数键/sourceRevision、变更、证据、跨Series/SKU/Model影响、新增/解决error、样例差异、预计UpgradeCandidate和覆盖率。固定`publishedSnapshotsChanged = 0`。

sourceRevision变化进入NEEDS_REBASE，显示旧值/远端新值/草稿值。人工确认写回后必须技术回读；写回成功只进入REMOTE_CHANGES_AVAILABLE。用户再显式拉取、校验和发布RuleSetVersion。AI不得确认写回、拉取或发布。一期不接飞书审批；三期职责分离另行配置。

## 8. ValidationIssue 与 ActionLink

| 来源 | 阻断语义 | 典型动作 |
| --- | --- | --- |
| hard_compatibility | error/deny 必阻断，不可 waive | 满足 require、改 Patch/规则 |
| affinity | 非阻断，不抵消硬规则 | 查看分轴、优化候选 |
| series_invariant | 按不变量定义 | 恢复不变量、允许时申请例外 |
| patch/publish/export | 按 gate/severity | rebase、重算、确认 warning、重试 |
| ai_guardrail | 不裁决规则 | 查看证据、重新评估 |

页面按 gate 分区，再按 blocking/severity 排序。Issue 展示 code、title、message、影响对象/属性、证据、状态和 ActionLink。fingerprint 用于重算去重；已解决仍保留审计。deny/error 不提供 waive。动作 disabledReason 可见；执行前后端再次鉴权和重验 Revision。

## 9. Rebase、UpgradeCandidate 与 Snapshot

Rebase 同屏显示旧基础、新基础、现有 Patch、预计结果、冲突原因、Issue。set 基线变化、参数删除/重命名、边界/公式/兼容变化必须人工 rebase；add/multiply 可自动重放，但最多回到 pending_review。rebase 生成新 Patch Revision。

UpgradeCandidate 只描述“升级会怎样”。批准不改变旧 Snapshot；显式发布才创建新 Snapshot。

冻结 Snapshot 可查看、导出、审计、复制新 Revision、生成升级候选；不可原地编辑、重算、rebase、换 hash、删除引用、被 AI 或上游覆盖。失败 SnapshotBuild 可幂等重试，不产生半快照。

## 10. 状态与文案

| 后端码 | 文案 | 类型 |
| --- | --- | --- |
| ACTIVE | 有效 | lifecycle |
| DEPRECATED | 已废弃 | lifecycle |
| ARCHIVED | 已归档 | lifecycle |
| DRAFT | 草稿 | revision |
| PENDING_REVIEW | 待复核 | revision |
| CHANGES_REQUESTED | 需修改 | revision |
| APPROVED | 已批准 | revision |
| READY_TO_PUBLISH | 待发布 | publication |
| PUBLISHED | 已发布 | publication |
| PUBLISH_FAILED | 发布失败 | publication |
| REBASE_REQUIRED | Patch 需要 rebase | attention |
| HAS_UPGRADE_CANDIDATE | 有升级候选 | attention |
| SOURCE_STALE | 规则源已过期 | attention |
| IMPORT_CONFLICT | 导入冲突 | attention |
| EXPORT_RELATION_BROKEN | 配置关联断裂 | attention |
| HARD_CONFLICT | 硬冲突 | derived primary |
| REVIEW_REQUIRED | 待复核 | derived primary |
| WARNING | 有警告 | validation / derived primary |

前端同时接收Lifecycle、Revision、Validation、Publication、Attention[]和Primary。“已发布 + 有升级候选”同时显示；Primary只决定主标签。未知码显示未知状态并只读降级。“已冻结”仅属于Snapshot。文案不决定权限。

## 11. 内网、登录和配置表交付

部署在公司内网 Dell R730。飞书登录建立公司会话；令牌/密钥不得进入前端日志、AI 输入或导出。一期保留能力与审计但用统一公司策略；二期启用 AI；三期细化权限。登录失败提供重试、错误编号、管理员入口；会话过期保留表单，重登后重验 Revision。

配置表交付分两步：

1. 先通过SnapshotBatch一次确认多个Model：复用未变化Snapshot、为合格revision新建Snapshot、跳过阻断项。再选择一个或多个明确的环境×渠道目标；1001固定写入各环境的`xlsx`，其他渠道由用户显式选择目录。目录句柄保存在浏览器IndexedDB，服务端不保存绝对路径。固定导出tackle/item/GoodsBasic/StoreBuy；先预览新增/修改、主键冲突和格式变化，再逐目标确认。正式写入只读取冻结Snapshot，并使用恢复型写入策略。
2. 读取该环境根`config.toml`的tables、workbook/sheet、enums；强制增量校验本次变更及其引用闭包。每个断链生成`ValidationIssue(gate=EXPORT)`，带环境、渠道、文件、sheet、Excel行、字段、原值、目标表、规则和动作。全库检查由用户主动触发。

一个目标失败不伪装全成功；默认继续写入其他合格目标，失败项保留预览和恢复Manifest。工具不读取`config_system.toml`，不执行Git命令。StoreBuy新增`enabled`上架开关：新行默认false，更新普通属性保留目标原值。

价值分自动定价不再使用未在v3登记的`OPEN-PRICING-001`编号。主飞书工作簿revision `2869`中，`07_品质评分/FqD4j7`已提供品质区间、Quality→PricingBasket映射和价格系数区间，`08_价格计算/u87sRh`已提供评分线性插值、重量段查表、零整比、金币和三位有效数字向下取整。当前精确阻断项是：`QUALITY_SCORE_BOUNDARY_CONFLICT`（S品质100分边界）、`QUALITY_SCORE_SOURCE_MISSING`（性能评分来源），以及缺少`roundingStage`、`minimumPriceScope`和`overflowMode`。界面可展示带`NON_FORMAL`标记的价格试算、来源revision和逐步Trace；上述Issue未解决时，新PricingPolicyVersion、依赖它的Model发布、Snapshot和Store导出均必须精确阻断，不提供手填价格兜底。

## 12. 六面验收矩阵

| 编号 | 正常 | 边界 | 冲突 | 恢复 | 权限 | Given/When/Then |
| --- | --- | --- | --- | --- | --- | --- |
| R1 甘特图 | 筛选→Series→SKU→Model | 单/无 SKU | 游标 ETag 失效 | 保留筛选退父级 | 聚合不泄露 | G 1.5/1.8 同模板，W 展开，T 两个独立 SKU |
| R2 身份 | 稳定父链 | 无 Collection/多 Snapshot | 父链不一致 | 审计迁移 | 权限逐动作 | G Model 只读，W 深链，T 写动作给原因 |
| R3 候选 | 冻结输入→自动物化 | 0结果/截断 | Revision变化/歧义对应 | requestId恢复/重跑 | generate/materialize分离 | G高Affinity命中deny，W完成，T只进排除 |
| R4 Trace | 完整顺序来源 | 非数值/no_effect | hash 不符 | 同版本重放 | 来源可脱敏 | G 多层修改，W 查来源，T 显示 before/op/operand/after |
| R5 五维 | 共享定义叠加 | 无基准/不适用 | hash 不同 | 选基准/重算 | 基准与定义发布分离 | G 基准失效，W 预览，T 不静默换基准 |
| R6 AI | 带证据建议 | 证据不足 | 与硬校验冲突 | 重评，旧建议只读 | evaluate/draft 分离 | G AI 要降硬冲突，W 展示，T 冲突不变 |
| R7 AI→Patch | 确认差异建 draft | 部分参数移除 | Model 已变/未决 set | 保留表单并刷新 | create/review 分离 | G Revision 变化，W 创建，T 阻止旧 before |
| R8 AI→飞书 | 草稿→影响→人工确认写回→回读→显式拉取 | 覆盖率不足 | sourceRevision变 | 幂等回读/重试 | AI草稿、写回、拉取、发布分离 | G超时但已写入，W回读恢复，T不重复 |
| R9 Issue | 分区并执行动作 | 一根因多对象 | 互斥动作 | retry/recompute | 可看不等于可修 | G deny/Affinity/不变量并存，W 返回，T 不互抵 |
| R10 冻结 | rebase→新快照 | 语义相同 | 基线再变 | 复制到最新候选 | rebase/review/publish 分离 | G S1 已发布，W 批准升级，T S1 不变 |
| R11 状态 | 三组状态映射 | 未知码只读 | 非法组合 | 重同步/审计 | 文案不授权 | G PUBLISHED+UPGRADE，W 渲染，T 两标签并存 |
| R12 开放配置 | 已发布策略驱动 | 配置缺失 | 草稿混正式 | 回有效版本 | 策略三权分离 | G 阈值未确认，W 实现，T 从配置读取 |
| R13 导出 | 多 profile→校验 | profile 只读 | 主键/TOML 断链 | 保留结果后重跑 | preview/commit 分离 | G test 成功 dev 失败，W 完成，T 分别标状态 |
| R14 登录 | 飞书会话 | AI 关闭 | 会话过期 | 重登并重验 | 一期仍返回 capability | G 会话过期，W 重登，T 表单保留且重验 |

## 13. 保持开放、不得固化

性能定位强度命名/曲线；Patch 偏移阈值；五维轴/公式/档位/比较上限；AI 刷新、模型记录、审核权限；钩/漂/饵开放时间；职责分离；飞书多级会签；正式路径白名单；TOML 引用按 id 或 name。全部使用版本化配置。Snapshot 冻结语义不是配置项，改变它必须先获得用户明确确认并修订 v3。

## 14. 开发顺序

1. EntityRef、Revision、Capability、ActionAvailability、审计。
2. Projection、Patch、Trace、ValidationIssue、硬兼容、Affinity。
3. Series/SKU/Model 查询与甘特图。
4. 候选生成、稳定排序、默认自动物化与批量限制。
5. 五维通用内核与三种视图。
6. Rebase、UpgradeCandidate、发布证据、冻结 Snapshot。
7. 多 ExportProfile 与 TOML 校验。
8. 二期AIRecommendation、Model Patch草稿、RuleSourceChangeDraft。
9. 三期细粒度权限与审批策略。

每个工作包同时交付：正常、边界、冲突、恢复、权限、Given/When/Then；领域测试、API 契约测试、前端状态测试、冻结回归和失败恢复测试。
