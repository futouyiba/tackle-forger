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

- [`audits/current-state-review-2026-07-22.md`](./audits/current-state-review-2026-07-22.md)：2026-07-22代码、Git、测试和架构状态快照。
- [`audits/engineering-issue-register.md`](./audits/engineering-issue-register.md)：持续维护的工程问题台账，包含严重性、状态、证据和关闭条件。

修复提交应引用对应`AUD-xxx`，关闭问题时在台账中记录提交SHA、验证命令和测试证据。历史审查快照原则上不改写；状态变化更新台账或新增审查快照。

## Agent开始开发前

1. 完整阅读v3权威规范。
2. 检查规范中的“开放决策”，不得擅自固定未确认语义。
3. 对照“当前实现迁移”确认本次工作属于哪个阶段。
4. 保持历史发布配置不可变。
5. 为新增规则提供计算轨迹、校验和回归测试。
6. 特别注意：钓具系列甘特图不是新增领域实体；AI评估与建议不是规则裁决层。
