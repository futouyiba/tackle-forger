# Tackle Forger 设计与开发文档入口

## 文档权威层级

所有新功能、重构、数据迁移和测试必须遵循以下层级：

1. [`tackle-forger-development-spec-v3.md`](./tackle-forger-development-spec-v3.md)：唯一权威产品与领域规范。
2. [`ux/tackle-forger-product-design-completion-v3.md`](./ux/tackle-forger-product-design-completion-v3.md)：规范性的UI消费契约，只能表达v3，不能改变领域语义。
3. [`handoffs/tackle-forger-v3-implementation-handoff.md`](./handoffs/tackle-forger-v3-implementation-handoff.md)：实现导航、工作包和交付证据，不另立业务规则。
4. [`handoffs/tackle-forger-requirements-handoff-2026-07-21.md`](./handoffs/tackle-forger-requirements-handoff-2026-07-21.md)：本轮已确认需求、飞书源表整改结果和开发执行边界的集中交接；只摘录v3，不覆盖v3。
5. [`ux/tackle-forger-ux-design-v1.md`](./ux/tackle-forger-ux-design-v1.md)与`ux/prototype-v1/*`：页面组织、视觉和交互证据。

第2至5级文档必须在文首记录最后对齐的v3日期或版本。它们若与v3冲突，冲突段立即视为过期说明，不能继续作为开发验收依据；修复时应修改消费文档，不为了迎合旧文档反向改写v3。

若代码、旧文档、工作簿示例和权威规范发生冲突：

1. 用户最新明确决定优先；
2. 随后更新权威规范；
3. 实现以更新后的权威规范为准；
4. 不得通过挑选旧文档中的结论绕过权威规范。

## 实现事实、配置映射与运行手册

以下文档不加入领域权威层级，但属于明确维护的工程文档；不得与“历史材料”混放：

| 文档 | 状态 | 作用与更新要求 |
| --- | --- | --- |
| [`ux/tackle-forger-v3-implementation-gap-matrix-2026-07-22.md`](./ux/tackle-forger-v3-implementation-gap-matrix-2026-07-22.md) | 当前实现审计 | 记录代码事实、缺口、外部阻断和产品反馈归并；已经实现的能力不重复登记为缺失。必须写明审计commit完整hash与精确时间；代码变化后应重新验证而不是沿用“同日通过” |
| [`config-export-mapping-guide.md`](./config-export-mapping-guide.md) | 配置映射契约 | 记录`config.toml`、workbook/sheet、枚举引用、环境/渠道目录和恢复型写入边界；从属于v3第25节，示例ID不是生产策略 |
| [`deployment/r730-production.md`](./deployment/r730-production.md) | 生产运行手册 | Dell R730部署、持久化、备份、验收与回滚；不定义领域规则 |
| [`deployment/feishu-enterprise-login.md`](./deployment/feishu-enterprise-login.md) | 身份运行手册 | 飞书OAuth、会话和代理安全边界；不替代Capability契约 |

这四类文档的维护顺序是：先修订v3中的产品/领域结论，再同步UI与handoff，再更新映射/运行手册，最后用差距矩阵记录实际实现和验证证据。差距矩阵中的“已实现”必须能定位到当前代码/测试；发现并存旧契约时标记“部分实现”，不能用计划中的目标契约冒充实现事实。

## 原型证据治理

`ux/prototype-v1/`是视觉和主路径证据，不是领域/API权威。目录中的Markdown审查与QA文档必须在文首记录`最后对齐v3`；若只验证静态原型，必须明确哪些后端、权限、持久化、迁移和恢复能力未由截图证明。原型源代码中的示例字段、状态和文案不得反向覆盖v3。

## 历史文档

以下文档只用于理解设计演进，不再作为开发依据：

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| `2026-07-20-template-series-generation-system-design-v2.md` | 历史 | 初始系统设计，仍含已被推翻的品质、SKU和被动模拟器结论 |
| `2026-07-20-design-decisions-method-quality-affinity-sku-passive.md` | 历史 | 决策补充001；其中模拟器结论已被补充002覆盖 |
| `2026-07-20-design-decisions-affix-scope-stacking-and-technology.md` | 历史 | 决策补充002；内容已合入v3权威规范 |
| `../crystal/2026-07-17-tackle-forger-rule-system-v1.md` | 历史 | 当前代码架构和早期规则系统结晶 |

说明性、非规范文档：

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| `tackle-forger-design-evolution.md` | 说明 | 解释设计演进，不定义当前行为 |
| `tackle-forger-design-evolution-illustrated.md` | 说明 | 演进文档的图文版，不作为验收规范 |
| `tackle-forger-design-evolution-feishu.xml` | 发布副本 | 飞书发布格式，内容以Markdown源文档和v3为准 |
| `tackle-forger-design-evolution-and-product-design-feishu-v2.xml` | 发布副本 | 历史飞书交付副本，不作为开发输入 |

## 工程审计与问题管理

工程审计记录实现风险、验证结果和架构决策需求，不定义产品或领域语义；与v3冲突时始终以v3为准。

自2026-07-23起，GitHub Issues和关联Project是工程问题状态、负责人、依赖和验收条件的唯一可变来源。仓库内审计文档保留为不可改写的调查、决策与验证证据；不得继续在Markdown中维护第二套任务状态。

- [`audits/current-state-review-2026-07-22.md`](./audits/current-state-review-2026-07-22.md)：2026-07-22代码、Git、测试和架构状态快照。
- [`audits/current-state-review-follow-up-2026-07-22.md`](./audits/current-state-review-follow-up-2026-07-22.md)：对首轮快照的去重复核、当前工作区差异与新增问题映射。
- [`audits/remote-branches-review-2026-07-22.md`](./audits/remote-branches-review-2026-07-22.md)：拉取全部远端分支后的修复复审、测试证据及问题状态变化。
- [`audits/engineering-issue-register.md`](./audits/engineering-issue-register.md)：GitHub治理启用前的历史工程问题台账快照；不再维护活动状态。
- [`audits/aud-005-architecture-decision-proposal.md`](./audits/aud-005-architecture-decision-proposal.md)：根v3、历史workspace与旧配方入口的收敛方案和迁移边界；分部位语义以AUD-026 ADR为准。
- [`audits/aud-009-workspace-revision-retention-adr.md`](./audits/aud-009-workspace-revision-retention-adr.md)：工作区revision保留、容量、归档和恢复策略的待决策ADR。
- [`audits/aud-026-part-constraint-semantics-adr.md`](./audits/aud-026-part-constraint-semantics-adr.md)：`PartConstraintSet`、候选搜索、具体组件选择、旧数据复核与Snapshot冻结的已接受正式决策。

修复提交和PR应引用对应GitHub Issue并在Issue/PR中记录提交SHA、验证命令和测试证据。历史审查快照和台账原则上不改写；需要新的调查证据时新增审查或ADR，并在GitHub Issue关联。

## Agent开始开发前

1. 完整阅读v3权威规范。
2. 检查规范第20节“未决事项登记表”，不得擅自固定未确认语义或绕过外部规则源阻断。
3. 对照“当前实现迁移”确认本次工作属于哪个阶段。
4. 保持历史发布配置不可变。
5. 为新增规则提供计算轨迹、校验和回归测试。
6. 特别注意：钓具系列甘特图不是新增领域实体；AI评估与建议不是规则裁决层。
