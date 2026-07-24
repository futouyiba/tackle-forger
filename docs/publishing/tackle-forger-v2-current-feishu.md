<title>钓具批量生成器设计文档 v2（产品理解版）</title>

| 版本 | 内容 | 编辑人 | 时间 |
|-|-|-|-|
| V1.0 | 创建文档 | 宋甫 | 20260720 |
| v1.1 | 对齐 v3 权威语义并补充图示 | 宋甫 | 20260723 |
| v1.2 | 重构问题驱动叙事与治理逻辑 | 宋甫 | 20260723 |

<callout emoji="📖" background-color="light-blue" border-color="blue">
<p><b>文档定位：</b>本文面向产品理解、方案沟通和跨团队协作，重点解释“为什么系统不得不这样设计”。它不是新的规则源；字段、状态、公式、开放事项和验收标准始终以<a href="https://pisn3u3ony2.feishu.cn/docx/YUTfdigY2opH9wxPVcGcOGXIn1f">《Tackle Forger 产品与领域开发规范 v3》</a>为唯一权威。</p>
</callout>

# 1. 为什么它不能只是一个计算器

如果目标只是把一组规则计算一次，那么一个无状态页面已经足够：输入条件、得到结果、复制出去。但真实生产不是一次计算。设计人员会连续编辑多个Series、SKU和Model，保留人工判断，处理规则更新，与他人协作，并把结果正式发布到游戏配置。

系统的复杂度不是一次性设计出来的，而是生产过程中的风险逐层逼出来的。

<whiteboard type="mermaid">
flowchart TD
    subgraph S1[先让工作可持续]
        direction LR
        A["从一次规则计算
变成连续生产"] --> B{"关闭、崩溃或重启后
还能继续吗？"}
        B -->|不能| C["数据库保存状态
Revision保留恢复点"]
    end
    subgraph S2[再让决定可解释]
        direction LR
        D{"只看最终值
能解释修改吗？"} -->|不能| E["Patch台账记录决定
Trace记录计算过程"]
        E --> F["基础变化后
仍能安全重算"]
    end
    subgraph S3[最后让协作与发布可信]
        direction LR
        G{"并发、规则变化和
外部写入会出错吗？"} -->|会| H["并发门禁、幂等回读
Snapshot冻结"]
        H --> I["预览、备份与恢复
形成可信工作台"]
    end
    S1 -->|继续追问| S2
    S2 -->|继续追问| S3
</whiteboard>

| 真实失败 | 直接损失 | 因此必须具备 |
|-|-|-|
| 浏览器关闭、崩溃或服务重启 | 已编辑内容全部丢失，需要重做 | 持久化数据库 |
| 只保留最终数值 | 不知道谁为什么修改，也不能安全重算 | Patch、Trace与台账 |
| 两个页面或两次请求同时写入 | 修改被静默覆盖，或者重复写入 | Revision、并发检查与幂等 |
| 上游规则更新后直接重算已发布结果 | 线上配置失去历史真实性 | 不可变Snapshot |
| 飞书或配置文件只写入一部分 | 远端、本地与发布记录互相矛盾 | 回读验证、备份与恢复 |

所以，Tackle Forger首先解决的不是“怎样把公式做得更复杂”，而是“怎样让一次次设计工作可以保存、解释、协作、发布和恢复”。

# 2. 为什么必须保存工作状态

## 2.1 数据库首先防止工作丢失

设计人员在工作区里保存的不只是几个输入框，还包括对象选择、人工Patch、复核状态、冲突处理、规则版本、发布准备和失败恢复信息。如果这些内容只存在于浏览器内存中，关闭页面、标签页崩溃、网络中断或服务重启后，用户就必须重新编辑一遍。

数据库的首要产品价值不是“查询方便”，而是：

> 已经完成的工作不会因为运行环境中断而消失，用户可以从上一次成功保存的位置继续。

## 2.2 只保存最新状态仍然不够

如果数据库永远覆盖同一行，误操作和错误保存之后仍然无法返回过去。因此工作区还需要Revision：每次成功保存形成一个新的恢复点，当前状态指向最新Revision，而旧Revision保留用于回看和恢复。

<whiteboard type="mermaid">
flowchart TD
    A["打开工作区
读取 Revision 12"] --> B["编辑后提交
baseRevision=12"]
    B --> C{"服务端当前仍是
Revision 12？"}
    C -->|是| D[创建 Revision 13]
    C -->|否| E["返回冲突
保留本地编辑"]
    D --> F["关闭或崩溃后
从 Revision 13 继续"]
    E --> G["重读最新状态
显式处理差异"]
</whiteboard>

Revision解决“整个工作区回到哪里”，但它不负责解释某一项属性为什么被修改。这个问题需要更细粒度的Patch台账。

# 3. 为什么需要台账

数据库可以保存“现在拉力是12kg”，却无法仅凭这个结果回答：原来是多少、谁改的、为什么改、影响哪个范围、基于哪个规则版本，以及基础规则更新后能否继续成立。

台账保存的不是又一份最终值，而是一项完整的修改决定。

<whiteboard type="mermaid">
flowchart TD
    A[基础结果 10kg] --> B[ModelPatch：add 2kg]
    B --> C[最终结果 12kg]
    B --> D[作用对象与范围]
    B --> E[修改原因与证据]
    B --> F[作者与时间]
    B --> G[基线 Revision]
    B --> H[操作顺序与状态]
</whiteboard>

## 3.1 Patch保存修改意图

人工修改不能直接覆盖派生模板，否则系统会失去“规则本来如此”和“某个对象的人工例外”之间的区别。规范Patch使用四种操作：

| 操作 | 保存的意图 | 基线变化后的处理 |
|-|-|-|
| `set` | 我明确要这个绝对值 | 必须人工复核 |
| `add` | 我希望在继承结果上增加固定量 | 类型、单位兼容时可重放，之后待复核 |
| `multiply` | 我希望按比例调整继承结果 | 类型、单位兼容时可重放，之后待复核 |
| `clear` | 我撤销本层覆盖，重新使用继承值 | 继承语义仍成立时可重放 |

Patch按Series、SKU、Model和最终复核分层。越靠后的Patch作用范围越小、优先级越高。每个操作拥有稳定ID和明确顺序，不能依赖数据库自然顺序或飞书行号。

## 3.2 Trace与台账解决不同问题

PatchLedger保存“设计人员决定怎样改”；Trace保存“系统实际上怎样算”。二者结合后，最终结果才能被解释和重放。

<whiteboard type="mermaid">
flowchart TD
    A["PatchLedger
保存修改决定"] --> C[确定性计算内核]
    B["RuleSetVersion
保存规则基线"] --> C
    C --> D["Calculation Trace
保存实际执行过程"]
    D --> E[最终面板]
    E --> F[ConfigurationSnapshot]
    F -. "冻结引用" .-> A
    F -. "冻结引用" .-> B
    F -. "冻结证据" .-> D
</whiteboard>

飞书《Patch台账》是便于人查看、协作和审计的镜像，不是运行时主库。即使飞书行被排序、隐藏、删除或暂时不可用，本地PatchLedger中的权威记录也不能丢失，更不能反过来用名称猜测关联对象。

# 4. 为什么必须管理并发

并发不只是“很多人同时点击保存”。旧页面、请求重试、远端超时、批量任务和关键发布操作都可能形成并发。

| 并发场景 | 不控制的后果 | 当前最小机制 |
|-|-|-|
| 两个页面基于同一旧Revision保存 | 后保存者静默覆盖前一人的修改 | 乐观并发：比较`baseRevision` |
| 同一关键发布操作同时执行 | RuleSet、Snapshot或配置状态交叉 | 短期工作区单写租约 |
| 请求超时但远端其实成功 | 重试后产生重复行或重复事件 | 幂等键与结果查询 |
| 飞书或文件写入期间源内容变化 | 新结果覆盖未知的新版本 | 写前基线Revision或Hash |
| 多文件只写入一部分 | 形成半套配置 | 备份、逐文件回读和恢复Manifest |

<whiteboard type="mermaid">
flowchart TD
    A[普通工作区保存] --> B[比较 baseRevision]
    B --> C[无冲突：创建新Revision]
    B --> D[有冲突：重读并显式处理]

    E[关键共享写操作] --> F[取得短期单写租约]
    F --> G[执行时再次校验有效性]

    H[飞书或本机文件写入] --> I[冻结基线与幂等键]
    I --> J[写入后回读验证]
    J --> K[成功留证或进入恢复]
</whiteboard>

## 4.1 为什么当前采用相对简单的方式

当前系统没有建设实时共同编辑，也没有试图让数据库、飞书和本机文件加入一个不存在的分布式事务。普通编辑使用乐观并发，关键共享写操作短期串行，外部副作用使用幂等、回读和恢复。

这是当前更合适的最小方案，因为：

- 同一对象的高频同时编辑不是主要工作形态；
- 编辑过程可能很长，长期占用悲观锁会阻塞其他人；
- 飞书和浏览器本机文件无法参与数据库事务；
- 当前首要风险是静默覆盖、重复写入和半完成结果，而不是自动合并所有冲突。

只有当同一对象持续发生高频冲突、明确需要实时协同编辑、后台任务长期与人工操作竞争，或者人工处理冲突的成本已经显著高于复杂并发系统时，才有充分理由升级方案。

# 5. 三种权威事实为什么必须分开

系统同时面对共享规则、正在进行的工作和正式发布结果。三者的生命周期不同，不能由同一份可变数据承担。

<whiteboard type="mermaid">
flowchart TD
    A["飞书规则源
大家共同遵循什么"] --> B["RuleSetVersion
本次计算使用什么"]
    B --> C["工作区数据库
现在正在设计什么"]
    C --> D["PatchLedger
人工为什么这样改"]
    D --> E["ConfigurationSnapshot
最终发布过什么"]

    F["Workspace Revision
崩溃恢复与历史回看"] -. "保护" .-> C
    G["Calculation Trace
结果如何得出"] -. "解释" .-> D
</whiteboard>

| 权威层 | 保存的事实 | 是否可继续变化 |
|-|-|-|
| 飞书规则源与RuleSetVersion | 团队共享规则及其已发布版本 | 源可以修订；旧版本保持可追溯 |
| 工作区数据库与PatchLedger | 草稿、人工判断和当前生产过程 | 通过新Revision继续演进 |
| ConfigurationSnapshot | 某个Model正式发布时的完整结果 | 创建后不可变 |

写回飞书不等于工具已经拉取，拉取不等于新规则已经发布。规则只有经过显式拉取、校验和发布RuleSetVersion后，才进入新的计算基线。

# 6. 系统怎样从规则生成具体钓具

治理机制解释清楚后，再看领域生成流程。这里的核心不是把所有维度“交叉相乘”，而是让每一层回答一种不同问题，并留下独立轨迹。

<whiteboard type="mermaid">
flowchart TD
    A["WeightTemplate
中性重量基准"] --> B["MethodProfile
玩法环境"]
    B --> C["TypeProfile
结构机制"]
    C --> D["FunctionProfile
主动强化与代价"]
    D --> E["StructuralBenchmark
只读结构标杆"]
    E --> F[最近标杆匹配]
    F --> G[商品层结算]
    G --> H["PerformanceSummary
只读结果摘要"]
    H --> I[ConfigurationSnapshot]
</whiteboard>

## 6.1 为什么属性不是一条固定倍率曲线

固定倍率隐含“所有重量段都保持同一形状”。实际设计中的长度、调性、硬度、饵重范围和自重可能出现平台、拐点或反向变化，更高拉力也不必然意味着更长的竿。

因此，稳定比例关系使用显式`add`或`multiply`；离散规格、边界和条件关系按重量段、类型与场景明确表达。系统使用最近派生模板，不做连续插值。

## 6.2 为什么钓法与类型分层

钓法回答“处于什么玩法环境”，类型回答“采用什么结构机制”，功能定位回答“主动强化什么、牺牲什么”。它们可以在界面同一步操作，但数据、规则和Trace必须分开。真正依赖Method与Type组合的特例使用条件规则，不复制整套组合模板。

## 6.3 Collection、Series、SKU与Model不能混用

<whiteboard type="mermaid">
flowchart TD
    A["Collection
品牌与营销产品族"] --> B["Series
稳定概念与不变量"]
    B --> C1["SKU 1.5kg
重量抽屉"]
    B --> C2["SKU 3.5kg
重量抽屉"]
    C1 --> D1["Model
快调短竿"]
    C1 --> D2["Model
慢调长竿"]
    C2 --> D3["Model
标准路线"]
    D1 --> E[Snapshot]
    D2 --> E
    D3 --> E
</whiteboard>

| 对象 | 产品含义 |
|-|-|
| Collection | 品牌、视觉和营销产品族 |
| Series | 固定钓法、类型、品质、核心功能和核心词条身份 |
| SKU | 对应一个离散`targetPullKg`的钓具抽屉，不是购买对象 |
| Model | 玩家实际选择和购买的具体型号 |

1.5kg和1.8kg可以命中同一结构标杆，但仍是两个独立SKU。SKU一旦拥有已发布后代Snapshot，就不能原地改变重量身份；新重量必须创建新SKU。

# 7. 商品层怎样结算和判断

结构标杆匹配完成后，商品层按固定顺序完成配置。Performance不是输入或加成层，而是在最终属性结算后生成的只读摘要。

<whiteboard type="mermaid">
flowchart TD
    A[最近 StructuralBenchmark] --> B[functionIntensity]
    B --> C[Material策略]
    C --> D[SeriesPatch]
    D --> E[SkuPatch]
    E --> F[ModelPatch]
    F --> G[Affix / Technology结算]
    G --> H[FinalReviewPatch]
    H --> I[最终边界校验]
    I --> J["PerformanceSummary
只读派生"]
    J --> K[ConfigurationSnapshot]
</whiteboard>

`functionIntensity`表示同一功能方向的专精强度，不是品质。Quality表示系列完成度，唯一映射为C/绿、B/蓝、A/紫、S/橙。价值分只验证已选择的Quality是否合理，不自动改变Quality；PerformanceSummary也不参与评分、兼容、定价或模板匹配。

## 7.1 四套判断不能互相覆盖

<whiteboard type="mermaid">
flowchart TD
    A[待审对象] --> B{"硬兼容
能不能成立"}
    B -->|deny或缺require| X[阻止对应关口]
    B -->|通过| C["Affinity
合法组合中有多适配"]
    B -->|通过| D["Series不变量
是否仍属于同一系列"]
    B -->|通过| E["发布检查
证据是否完整可信"]
    C --> F[建议和排序，不越权]
    D --> G[身份破坏时阻断]
    E --> H[证据完整后发布]
</whiteboard>

硬兼容、Affinity、Series不变量和发布检查分别回答不同问题。高Affinity不能覆盖deny；AI建议也不能降低任何确定性问题。

## 7.2 Technology与被动技能的边界

Technology只是多个原子Affix的命名组合包，不得与成员Affix重复提供同名属性加成或价值分。属性Affix修改面板并计分；被动技能只保存、计分、展示和导出，不在本工具中执行、模拟或验证运行逻辑。

# 8. 为什么发布结果必须冻结

草稿和规则会持续变化，但已经交付的配置必须能证明“当时发布的到底是什么”。因此ConfigurationSnapshot在创建时冻结RuleSetVersion、对象Revision、投影引用、有序Patch引用与Hash、最终面板、词条、品质、定价、校验、Trace、发布人和时间。

<whiteboard type="mermaid">
stateDiagram-v2
    [*] --> ModelDraft
    ModelDraft --> SnapshotBuild: 校验通过并确认
    SnapshotBuild --> FrozenSnapshot: 构建成功
    SnapshotBuild --> BuildFailed: 构建失败
    BuildFailed --> SnapshotBuild: 幂等重试
    FrozenSnapshot --> UpgradeCandidate: 上游发生变化
    UpgradeCandidate --> NewSnapshot: 人工批准并重新发布
    FrozenSnapshot --> FrozenSnapshot: 历史内容与Hash不变
</whiteboard>

规则更新、Patch新Revision、对象改名、镜像变化、rebase和数据迁移都不能改写旧Snapshot。上游变化只能产生UpgradeCandidate，经过人工确认后发布新的Snapshot。

# 9. 为什么外部写入必须可验证和恢复

## 9.1 飞书规则变更不是一次写入

<whiteboard type="mermaid">
sequenceDiagram
    participant U as 用户
    participant T as Tackle Forger
    participant F as 飞书规则源
    U->>T: 确认规则修改草稿
    T->>F: 带源Revision与幂等键写回
    T->>F: 回读验证
    F-->>T: REMOTE_CHANGES_AVAILABLE
    U->>T: 显式拉取
    T->>T: 生成RuleSet草稿并校验
    U->>T: 显式发布RuleSetVersion
    T-->>U: 草稿重算或产生升级候选
</whiteboard>

写回不等于拉取，拉取不等于发布。Patch镜像只有在完整回读并验证数量、身份、顺序和Hash之后才能标记`SYNCED`。当前远端契约使用`A:AK`机器区、`AL`空白分隔列和`AM:BA`协作事件区；在本地账本迁移、远端表头、保护边界和连接器联调全部完成前，真实镜像链路保持禁用。

## 9.2 配置文件无法跨文件原子提交

浏览器不能保证`tackle.xlsx`、`item.xlsx`和`store.xlsx`同时原子替换。因此正式导出必须采用恢复型事务。

<whiteboard type="mermaid">
flowchart TD
    subgraph P[准备与门禁]
        direction LR
        A["选择 Snapshot 与目标
生成三表差异预览"] --> B[关系与 Schema 校验]
        B --> C{"基线 Hash / mtime
仍然一致？"}
        C -->|否| D["阻止写入
重新预览"]
    end
    subgraph W[受控写入]
        direction LR
        E[人工确认] --> F["生成备份与
恢复 Manifest"]
        F --> G[逐文件写入]
    end
    subgraph V[验证与恢复]
        direction LR
        H[逐文件回读验证] --> I{全部成功？}
        I -->|是| J[记录成功证据]
        I -->|否| K[按 Manifest 恢复]
    end
    P -->|基线一致| W
    W -->|写入完成| V
</whiteboard>

工具只修改用户明确选择的环境与渠道目录，不扫描或治理渠道，也不解析`config_system.toml`。一期只允许明显标记的`NON_FORMAL`预览；正式ID预留和配置提交必须等待已发布ConfigIdPolicy、目标目录、扫描Manifest和治理串行化能力全部可用。

# 10. 产品视图和AI为什么不能成为第二套规则

五维图、系列甘特图和AI用于降低理解与操作成本，但都不能反向改变领域真相。

- 五维图是最终Model面板的只读派生预览。竿、轮、线分别绘制，不生成“最弱环节汇总线”；正式五轴为拉力、耐久、抛投、感度、操控。
- 钓具系列甘特图只是Series、离散SKU和Model状态的规划投影。覆盖条表示规划跨度，只有SKU节点代表真实重量，不能从条带推导连续插值。
- AI可以解释证据、比较候选并创建Patch或规则修改草稿，但不能裁决硬兼容、确认Warning、写回飞书或发布RuleSet与Snapshot。

AI供应方与数据出网策略已经确定为公司内网Fancy Hub和严格白名单请求。真实连接器在实现、测试和启用前继续关闭；AI不可用时，模板、生成、校验、Patch、发布和历史复现必须正常工作。

# 11. 怎样理解“当前开放事项”

产品理解文档不应把所有未完成工作都称为“开放产品问题”。当前事项应分成三类：

| 类别 | 含义 | 当前项目 |
|-|-|-|
| 已决定，等待策略版本或实现 | 产品不需要重复选择，只需要按既定结论落地 | OPEN-001、002、005、007、008 |
| 明确延期或分期治理 | 当前范围保持关闭或全量保留，后续通过独立产品设计、策略和实施证据启用 | OPEN-003、011 |
| 外部契约或联调阻断 | 可以继续不触达外部系统的开发，但不能宣称链路可用 | OPEN-010 |

OPEN-004、OPEN-006和OPEN-009已经完成产品决策，不再作为开放讨论项。完整状态、关闭证据和未决时的执行边界只在v3第20节维护，本文不复制第二套活动台账。

对于产品同学，真正需要关注的不是OPEN编号本身，而是：

- 现在是否有用户需要作出的产品选择；
- 决策未完成时，系统允许做什么、必须阻止什么；
- 延期能力是否会影响当前主流程；
- 已决定事项是否仍被错误地当成开放问题反复讨论。

# 12. 阅读结论

Tackle Forger不是一个替人填表的计算器。它把共享规则、可恢复编辑、人工修改意图、确定性计算、并发保护、可信校验和不可变发布放在同一条生产线上。

每增加一个机制，都必须能指出它防止了哪一种真实失败；如果一个机制无法说明“不加会损失什么”，就应该重新审视它是否有必要。当前方案只覆盖已经出现或可以明确预见的风险，不为想象中的未来复杂度提前建设系统。
