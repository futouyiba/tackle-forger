# Tackle Forger 动态表现 Backlog v1

> 对应需求：`docs/ux/tackle-forger-motion-experience-requirements-v1.md`
> 最后对齐 v3：2026-07-23
> 状态来源：GitHub Issues 与关联 Project；本文只定义初始拆分，不维护活动状态
> 基线 commit：`2ebd35915e495ee4acb1874392996833e0e41f05`

## 1. 拆分原则

- 每个 Issue 提供独立、可演示、可验证的用户价值；
- 动效表现与领域计算解耦，领域结果永远先于表现；
- 基础能力先行，具体流程可以并行，但共享状态契约不得重复实现；
- 可访问性、跳过和恢复不是收尾装饰，必须进入基础契约；
- 不把现有领域实现缺口藏进动效 Issue；依赖已有 Issue 时显式阻断或使用真实可用子集。

## 2. 建议 Epic

### MOTION-EPIC：让生成、结算与冻结逻辑可见

**目标**

在不改变 v3 领域语义的前提下，把飞书显式拉取、生成阶段、属性来源、发布阻断和 Snapshot 冻结变成高速、可理解、可跳过、可追溯的动态体验。

**完成定义**

- MOTION-01 至 MOTION-07 全部完成；
- 使用真实 Trace 和真实业务状态；
- 正常/边界/冲突/恢复/权限/历史冻结验收通过；
- 目标 Chromium 环境完成性能与可访问性验证；
- 与无动效路径的结果、Issue、revision 和 hash 一致。

## 3. Backlog 总览与优先级

| 顺序 | ID | 工作包 | 优先级 | 依赖 | 可并行 |
| ---: | --- | --- | --- | --- | --- |
| 1 | MOTION-01 | 建立动效状态、token 与无副作用播放内核 | P0 | 无 | 否，后续共同基础 |
| 2 | MOTION-02 | 显式呈现飞书拉取与规则集生成编排 | P0 | MOTION-01、现有 #66 的可用数据链 | 可与 03 后半并行 |
| 3 | MOTION-03 | 实现 Trace 驱动的属性高速结算 | P0 | MOTION-01、真实 Trace；相关领域能力见 #41/#45 | 可与 02 并行 |
| 4 | MOTION-04 | 增加候选生成与阻断/恢复动态反馈 | P1 | MOTION-01、候选运行状态 | 可与 05 并行 |
| 5 | MOTION-05 | 增加 Snapshot 冻结与 UpgradeCandidate 差量表现 | P1 | MOTION-01、真实 SnapshotBuild | 可与 04 并行 |
| 6 | MOTION-06 | 完成减少动态、键盘、缩放与读屏支持 | P0 发布门槛 | MOTION-02 至 05 | 部分持续并行 |
| 7 | MOTION-07 | 建立视觉回归、性能与因果理解验收 | P0 发布门槛 | MOTION-02 至 06 | 否，最终整合 |

## 4. Issue 草案

### MOTION-01：建立动效状态、token 与无副作用播放内核

**用户价值**

所有动态流程使用同一套播放、暂停、跳过、重播和减少动态行为，用户不会在不同页面遇到互相冲突的控制。

**范围**

- 定义 `MotionPresentationModel`，从权威业务状态和 Trace 构建演出步骤；
- 分离业务状态与演出状态；
- 建立统一 token：时长、缓动、位移、强调、层级和 reduced-motion；
- 实现播放、暂停、继续、直接看结果、重播、取消；
- 重播不得重新调用命令、外部服务或持久化；
- 页面卸载、路由切换和输入 revision 变化时安全取消；
- 提供 React 测试工具或可注入时钟，避免依赖真实等待。

**不包含**

- 具体飞书、结算或 Snapshot 视觉；
- 新领域公式；
- 引入第三方动画库。

**验收**

- Given 同一业务结果，When 正常播放、跳过和 reduced-motion，Then 三条路径得到相同最终视图与证据；
- Given 播放中业务 revision 变化，When 旧序列尝试继续，Then 序列取消且不能提交任何业务状态；
- Given 用户重播，Then 网络写请求和持久化写入数量不增加；
- 假时钟覆盖正常、暂停、取消、跳过和恢复。

**建议标签**

`work: product-code`、`area: ux`、`priority: p0`

---

### MOTION-02：显式呈现飞书拉取与规则集生成编排

**用户价值**

用户能直观看懂“飞书规则源 → 显式拉取 → 校验 → RuleSet 草稿 → 显式发布 → 生成”的真实链路，不会误以为打开页面就自动同步或发布。

**范围**

- 初始态改为“待连接/待拉取”，删除未操作前的“同步中”；
- 展示工作簿身份、源 revision 和稳定 sheet 校验；
- 按真实状态编排拉取、校验、草稿、发布和生成阶段；
- `REMOTE_CHANGES_AVAILABLE`、`WAITING_FOR_REVIEW`、`BLOCKED`、`FAILED`、`SUPERSEDED` 使用独立收束；
- 写回、拉取、发布保持三个独立动作；
- 已完成阶段沉淀 revision/hash 证据；
- 支持暂停、跳过表现和重播表现。

**依赖**

- MOTION-01；
- 复用现有 Issue #66“统一飞书拉取、工作台展示与规则计算数据链”的权威状态，不在本 Issue 重造数据链；
- 真实租户端到端验收仍归 #73。

**验收**

- Given 用户尚未操作，Then 页面只显示待拉取，不显示同步中；
- Given 拉取成功但 RuleSet 未发布，Then 编排停在草稿/待发布，不进入已发布成功态；
- Given revision 在拉取中变化，Then 显示 `SUPERSEDED` 并提供重新拉取动作；
- Given 写回完成，Then 只显示 `REMOTE_CHANGES_AVAILABLE`，仍要求显式拉取；
- 真实错误、权限和会话恢复路径有自动化与浏览器证据。

**建议标签**

`work: product-code`、`area: feishu`、`area: ux`、`priority: p0`

---

### MOTION-03：实现 Trace 驱动的属性高速结算

**用户价值**

用户在约 2.4 秒内看懂一个属性由哪些来源、按什么顺序、以何种正负影响组成，同时可以立即查看完整证据。

**范围**

- 从真实 `CalculationTraceEntry` 构建稳定步骤；
- 展示初值、来源、before/operation/operand/after、delta、链路进度、最终值和边界；
- 固定焦点顺序：来源 → 飞卡 → delta → 主数字 → 解释/证据；
- 将 Combo 改为中性“链路 N/M”；
- 区分正向、负向、Patch、`no_effect`、边界和舍入；
- 最后一项增加 220–280ms 结果锁定；
- 同屏飞卡最多两张，关键文字达到字号门槛；
- Technology 只展示成员 Affix；被动词条不改变主数字；
- 支持暂停、直接看结果和重播。

**依赖**

- MOTION-01；
- 使用当前真实 Trace；若某类 Trace 尚未满足 v3，则显式依赖 #41（双向词条结算）与 #45（Patch 规范操作），不得在 UI 补算。

**验收**

- 8 项标准用例在 2.25–2.45 秒完成，硬上限 2.5 秒；
- 每个显示步骤与真实 sequence、before/after 和 hash 一致；
- `no_effect` 不显示伪造 `+0`；
- 负修正和边界不表现为奖励 Combo；
- 跳过和重播不改变领域结果或产生写操作；
- Trace hash 不一致时停止成功收束并显示阻断；
- 覆盖正常、负项、Patch、边界、Technology 去重、被动词条和错误 Trace。

**建议标签**

`work: product-code`、`area: trace`、`area: ux`、`priority: p0`

---

### MOTION-04：增加候选生成与阻断/恢复动态反馈

**用户价值**

用户不仅看到“正在生成”，还能理解候选如何被枚举、排除、排序和物化，以及为什么生成停止。

**范围**

- 展示枚举总数、合法数、排除原因、截断、input hash 和耗时；
- 硬兼容、Affinity、Series 不变量保持独立视觉区块；
- 高 Affinity 但硬 deny 的候选明确进入排除；
- 自动物化只对权威最高合法候选触发；
- 0 结果、歧义对应、Revision 变化、超时和恢复分别处理；
- Method、Type、Function 和最近匹配保持分层 Trace；
- 独立 SKU 不使用连续插值式视觉连接。

**依赖**

- MOTION-01；
- 候选数据契约与真实运行状态；
- 分部位候选约束若未完成，依赖 #50，不在动效层伪造。

**验收**

- Given 高 Affinity 候选命中硬 deny，Then 它只进入排除且不能出现成功物化效果；
- Given 运行中 revision 变化，Then 当前运行变为 `SUPERSEDED`；
- Given 无合法候选，Then 以可恢复空结果结束，不播放完成奖励；
- 相同输入、规则和排序版本产生相同显示顺序。

**建议标签**

`work: product-code`、`area: candidates`、`area: ux`、`priority: p1`

---

### MOTION-05：增加 Snapshot 冻结与 UpgradeCandidate 差量表现

**用户价值**

用户能明确区分“当前结果”“已冻结历史”和“可选升级”，并建立对不可变发布证据的信任。

**范围**

- SnapshotBuild 成功并取得 snapshotId/hash 后才播放冻结收束；
- 展示 Snapshot、RuleSet、PatchSetHash、发布人与时间；
- 失败和幂等重试不产生半冻结或重复成功；
- UpgradeCandidate 以旧 Snapshot 保持不变、新候选并列的方式表现；
- 批准候选不等于发布新 Snapshot；
- 历史 Snapshot 重播只读取冻结 payload。

**依赖**

- MOTION-01；
- SnapshotBuild、UpgradeCandidate 和不可变读取契约真实可用。

**验收**

- Given SnapshotBuild 失败，Then 不显示冻结成功且没有半快照；
- Given 上游规则变化，Then 旧 Snapshot 视觉和 hash 保持不变，只新增 UpgradeCandidate；
- Given 用户批准候选但未发布，Then 仍不显示新 Snapshot 已冻结；
- Given 幂等重试，Then 只产生一个完成证据。

**建议标签**

`work: product-code`、`area: snapshot`、`area: ux`、`priority: p1`

---

### MOTION-06：完成减少动态、键盘、缩放与读屏支持

**用户价值**

动态体验不会排除对运动敏感、低视力、键盘或屏幕阅读器用户，也不会强迫高频用户等待。

**范围**

- `prefers-reduced-motion` 与产品内偏好；
- reduced-motion 默认直接展示结果，提供可选逐项查看；
- 播放、暂停、跳过、重播、Trace、Issue 完整键盘操作；
- 200%/400% 缩放与窄视口重排；
- live region 只汇报关键阶段和最终结果，不逐帧刷屏；
- 状态不只靠颜色；
- 字号、焦点可见性和对比度达标。

**依赖**

- MOTION-02 至 MOTION-05 的交互入口；
- 可以从 MOTION-01 开始持续并行实现基础能力。

**验收**

- reduced-motion 下不存在自动飞入、弹跳或 260ms 连续替换；
- 键盘完成播放控制、跳过、Trace 和 Issue 导航；
- 200%/400% 缩放不遮挡主数字、控制与关键证据；
- 屏幕阅读器不会朗读每一帧数值；
- 正、负、Patch、检查在灰阶下仍能区分。

**建议标签**

`work: product-code`、`area: accessibility`、`area: ux`、`priority: p0`

---

### MOTION-07：建立视觉回归、性能与因果理解验收

**用户价值**

动效在真实工作环境中既流畅又能帮助理解，后续修改不会悄悄破坏因果、可访问性或冻结语义。

**范围**

- 建立开始、中段、最终、阻断、reduced-motion 的确定性视觉证据；
- 使用假时钟或可控进度捕获稳定截图；
- 记录目标 Chromium 设备性能；
- 验证跳过/重播无额外写请求；
- 验证有动效与无动效结果、Issue、revision、hash 一致；
- 进行至少 5 人的轻量因果理解测试；
- 把结论写入 QA 文档，不用截图证明后端冻结或权限正确。

**依赖**

- MOTION-02 至 MOTION-06；
- 真实飞书租户验收继续由 #73 承担，本 Issue 只消费其可用环境。

**验收**

- 视觉证据覆盖所有关键状态且可稳定重跑；
- 常规办公 Chromium 环境无持续明显卡顿；
- 5 人中至少 4 人能说出显式拉取不等于发布；
- 5 人中至少 4 人能指出最后一次属性变化的来源与 delta；
- 自动化证明跳过和重播不会增加外部写入；
- 发布报告列出精确命令、结果和未执行检查。

**建议标签**

`work: engineering`、`area: qa`、`area: ux`、`priority: p0`

## 5. 建议排期

### Milestone A：可复用基础与第一记忆点

- MOTION-01
- MOTION-03
- MOTION-06 的基础部分

交付结果：真实 Trace 驱动的属性高速结算，可暂停、跳过、重播和减少动态。这是性价比最高、最容易形成产品记忆点的一组。

### Milestone B：把完整生成逻辑浮到水面

- MOTION-02
- MOTION-04

交付结果：从飞书显式拉取到候选物化的真实阶段链，失败和阻断不再藏在静态状态中。

### Milestone C：发布信任与上线门槛

- MOTION-05
- MOTION-06 完整验收
- MOTION-07

交付结果：Snapshot 冻结、升级候选、可访问性、性能和可用性证据闭环。

## 6. 与现有开放 Issue 的边界

| 现有 Issue | 关系 |
| --- | --- |
| #66 统一飞书拉取、工作台展示与规则计算数据链 | MOTION-02 消费其权威状态，不重造数据链 |
| #73 内网部署、飞书登录与权威工作簿端到端验收 | 提供真实环境验收；动效 Issue 不代替连接与权限验收 |
| #41 `bidirectional_ratio` | MOTION-03 展示真实 Trace，不在前端补公式 |
| #45 Patch 规范操作与迁移 | MOTION-03 展示规范 Patch，不在前端猜旧操作 |
| #50 分部位候选约束 | MOTION-04 消费其候选结果，不用动画补齐领域约束 |
| #53/#54 五维定义与比较 UI | 当前不阻断主结算；若后续为五维变化加动画，应作为独立扩展 Issue |
| #57 飞书 Patch 台账镜像与恢复 | 不纳入首期主动画；未来可复用 MOTION-01 的阶段反馈 |

## 7. 下一步

在 GitHub 中先创建一个 Epic 和 MOTION-01、MOTION-03、MOTION-06 三个 Milestone A Issue；确认标签、Project 字段和负责人后，再批量创建其余 Issue。创建时以本文件为初始描述，但后续活动状态只在 GitHub 维护。
