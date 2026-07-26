# Tackle Forger v3 渐进式规范入口

本目录是 v3 产品与领域规范的唯一权威来源。根文件
[`../tackle-forger-development-spec-v3.md`](../tackle-forger-development-spec-v3.md)
是由这些模块按固定顺序生成的兼容镜像，供历史链接和人工整卷阅读使用，不得单独编辑。

## Agent 读取协议

1. 每个任务先读本页、[`00-authority.md`](./00-authority.md)和[`05-open-decisions.md`](./05-open-decisions.md)。
2. 根据任务目标选择下面一个或多个路由；读取路由对应模块中的相关章节。
3. 检查相关章节直接引用的跨模块章节，并补读这些依赖。
4. 把实际读取章节记录到 TaskBrief；不得只读摘要后推断正文语义。
5. 只有任务范围未知、跨域影响广泛，或修改本规范的结构/权威关系时才读全部模块。

## 路由鉴别

| 任务信号 | 必读模块 |
| --- | --- |
| 生成、模板、最近匹配 | 00、01、02、03、05 |
| Collection、Series、SKU、Model | 00、01、02、03、05 |
| Patch、重放、飞书Patch台账 | 00、02、03、04、05 |
| 兼容、Affinity | 00、01、02、03、05 |
| 数值、词条、品质、定价 | 00、03、04、05 |
| 持久化、Snapshot、历史冻结 | 00、03、04、05 |
| 数据迁移 | 00、02、03、04、05 |
| 飞书规则源、同步、回写 | 00、03、04、05、07 |
| 五维图、比较、甘特图、AI建议 | 00、05、06、07、08 |
| UI工作台与交互契约 | 00、01、02、05、06、07 |
| 身份、权限、外部写入 | 00、04、05、07、08 |
| 部署、配置导出 | 00、04、05、08 |
| Agent流程或治理文档 | 00、05 |

## 模块目录

| 编号 | 文件 | 内容 |
| --- | --- | --- |
| 00 | [`00-authority.md`](./00-authority.md) | 权威、固定原则与禁止事项 |
| 01 | [`01-product-foundations.md`](./01-product-foundations.md) | §1–5 产品范围、术语、生成顺序与结构匹配 |
| 02 | [`02-product-model.md`](./02-product-model.md) | §6–8 产品层级与Patch |
| 03 | [`03-rules-and-validation.md`](./03-rules-and-validation.md) | §9–13 兼容、数值、词条、品质与校验 |
| 04 | [`04-persistence-and-lifecycle.md`](./04-persistence-and-lifecycle.md) | §14–18 版本、快照、飞书、工作区与回归 |
| 05 | [`05-open-decisions.md`](./05-open-decisions.md) | §19–20 Agent检查表与OPEN登记表 |
| 06 | [`06-visualization-and-ai.md`](./06-visualization-and-ai.md) | §21–23 五维图、比较、甘特图与AI |
| 07 | [`07-interaction-contract.md`](./07-interaction-contract.md) | §24 前后端统一需求契约 |
| 08 | [`08-deployment-and-export.md`](./08-deployment-and-export.md) | §25 内网部署、身份与配置交付 |

`manifest.json`记录模块顺序、章节、内容哈希和机器可读路由。
