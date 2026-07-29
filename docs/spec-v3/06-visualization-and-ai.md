## 21. Model五维图预览

### 21.1 定位与权威来源

每个装备Model提供版本化、可配置的五维雷达图。2026-07-23经GitHub Issue #13确认，正式五轴及顺序固定为拉力、耐久、抛投、感度、操控，全部统一表达为“越靠外，能力越强”。轴、顺序、输入、变换、顶点、状态、档位和比较规则必须由已发布`FiveAxisViewDefinition`提供，不能作为前端常量。

五维图是最终Model配置的只读派生预览，不是新的人工编辑源，也不得反写面板属性。

业务来源为飞书知识库《装备面板+装备详情》3.3“[五维图属性计算逻辑（钓组实际属性）](https://pisn3u3ony2.feishu.cn/wiki/WUHewtYiaiaw9Jk2raUcSsQan8b#share-V5hsdvk5ZotZ05xhPkKc5Uv0n2f)”。本次读取的飞书文档revision为`3563`；后续修订必须生成新的`fiveAxisRuleVersion`，不得静默改变历史Snapshot。

计算时序：

```text
DerivedProjection
→ Series/SKU/Model Patch
→ Attribute Affix/Technology结算
→ FinalReviewPatch
→ 最终Model面板参数
→ 以modelFinalPullKg确定W重量段
→ FiveAxisPreview
→ ConfigurationSnapshot
```

被动词条不进入五维计算。属性词条和Technology成员词条仅在修改五维底层参数时，通过最终面板参数间接影响五维。

### 21.2 正式五轴输入、方向与变换

| 顺序 | 维度 | 直接适用部位 | 输入 | 能力方向 | W段共享顶点 |
| --- | --- | --- | --- | --- | --- |
| 1 | 拉力 | 竿、轮、线 | `drag` | 越大越强 | 同 W 段合法竿最终值取MAX |
| 2 | 耐久 | 竿、轮、线 | `durability` | 越大越强 | 同 W 段合法竿最终值取MAX |
| 3 | 抛投 | 竿 | `max_cast_distance` | 越大越强 | 同 W 段合法竿最终值取MAX |
| 4 | 感度 | 竿、轮、线 | 有效`sensitivity` | 原始分母越小越强 | 同 W 段合法竿有效值取MIN |
| 5 | 操控 | 竿、轮、线 | `energy_cost_factor` | 原始系数越小越强 | 同 W 段合法竿系数取MIN |

拉力、耐久和抛投的部件比例为：

```text
componentRatio = componentValue / vertexValue
```

感度能力：

```text
effectiveSensitivity = finalComponentPanel[itemPartId].sensitivity
sensitivityAbility = 1 / effectiveSensitivity
```

`finalComponentPanel[itemPartId].sensitivity`是竿、轮、线各自冻结的最终部件面板值，在当前
`ConfigurationSnapshot`中由对应`componentSelections[].values.sensitivity`承载；它已经包含词条、
Technology与全部Patch的结算结果。不得读取可变Model、顶层Model汇总值或原始配置值，也不得再次叠加默认值。

操控能力：

```text
controlAbility = 1 / energy_cost_factor
```

感度和操控的部件比例为：

```text
componentRatio = vertexRawValue / componentRawValue
```

倒数分母和顶点必须大于0；缺失、0或负值产生`error`，不能以0分代替坏数据。

抛投轴中，轮、线在包含竿的钓组或比较组里继承比较组“第一根竿”的抛投比例。第一根按用户加入比较组的稳定顺序确定，不受名称排序、筛选或ID排序影响；调整比较顺序后参考竿随之更新。继承点标记为`context_inherited`，界面必须提示“此抛投值继承自参考竿，仅用于完整展示，不代表轮或线自身具备该抛投属性”。继承点不参与顶点、排名或差值分析。比较组没有竿时，轮、线抛投为`not_applicable`，不得补0或伪造闭合五边形。

### 21.3 W重量段、顶点集合与逐件曲线

五维图引用已发布重量段策略中的六个大重量段W。Model以属性词条、Technology成员和全部Patch结算后的`modelFinalPullKg`归入W段；不得使用`targetPullKg`、最近结构模板重量或结算前拉力。最终拉力跨越区间边界时直接切换W段，不连续插值。

本节的`ADD/REPLACE/REMOVE`候选差量、稳定组锁顺序和数据库单事务要求，是经Issue #13补充确认的强制实现契约，不是可替换的示例架构；但SnapshotBatch仍不构成跨多个互不相关W段的全局五维事务。

顶点集合身份必须同时包含：

```text
weightBandId
+ weightBandPolicyVersion
+ fiveAxisDefinitionId
+ fiveAxisDefinitionVersion
+ fiveAxisRuleVersion
```

同一完整身份的五轴顶点候选池只含竿；轮、线仅使用自身最终直接值绘制曲线，绝不参与顶点。顶点不得从Model的当前可编辑状态、“最新时间”Snapshot或未指明的Revision读取。对既有数据，每个`ACTIVE` Model只读取其`configurationSnapshotId`当时明确指向的唯一当前正式ConfigurationSnapshot；即使存在多个历史Snapshot，也不得按发布时间、最大ID或Model head revision自动改选。

每个顶点候选来源必须冻结：

```text
snapshotId
+ modelId
+ modelRevisionId
+ componentEntityId
+ itemPartId
+ finalPanelHash
+ modelFinalPullKg
+ 有序直接输入(axisId + parameterKey + rawValue + unit + inputHash)
```

来源证据身份与五维语义身份必须分开。`snapshotId`和`modelRevisionId`用于证明候选取自哪个不可变发布版本，但不得因为重新发布了语义相同的Snapshot而改变顶点语义。所有五维哈希输入统一使用版本化规范序列化`five-axis-hash-input/v1`，禁止用字符串拼接、手写分隔符、数据库行序或语言运行时默认对象序列化计算hash。

规范序列化固定为：严格Schema对象→按下述规则规范化数组和数值→[RFC 8785 JSON Canonicalization Scheme（JCS）](https://www.rfc-editor.org/rfc/rfc8785)→无BOM UTF-8字节→SHA-256→小写十六进制。每个hash envelope必须含`schemaVersion="five-axis-hash-input/v1"`与固定`kind`；每层对象均`additionalProperties=false`，字段名、类型与是否可空由该版本Schema固定。字符串必须是有效Unicode，按原始码点进入JSON，不做NFC/NFD转换；JSON字符串边界和转义提供无歧义长度，禁止先拼接原始UTF-8字节。必填字段不得省略；可空字段必须显式写JSON `null`，`null`、空字符串、字符串`"null"`和字段缺失是四种不同输入。未知字段、缺字段、非法Unicode、NaN、正负无穷或类型不符均fail-closed。

进入hash envelope的业务小数统一编码为`CanonicalDecimal` JSON字符串：从领域精确十进制值生成，禁止先转二进制浮点再格式化；不使用指数或前导`+`，整数部分除`0`外无前导零，小数部分删除末尾`0`和无内容的小数点，`-0`规范为`0`。例如`1`、`1.0`和`1e0`在合法解析后均编码为`"1"`。无法从字段声明的精度与单位得到唯一精确十进制表示时拒绝计算，不得舍入后hash。非数值整数继续使用JSON整数，但必须落在Schema声明的安全范围。

数组顺序是hash契约的一部分：`directInputs`先按五轴定义`order`，再按`parameterKey`、`unit`、`inputHash`的无符号UTF-8字节逐分量升序；候选数组按`candidateSemanticKey.modelId`、`componentEntityId`、`itemPartId`逐分量升序；顶点数组按五轴定义`order`升序。JCS只规范对象属性，不重排数组，因此实现必须先完成上述排序。相同排序键但Payload不同、同一候选键重复或同一轴重复时产生完整性错误，不得用数据库顺序打破并列。

顶点候选与顶点集合的四类hash envelope固定为以下闭合集合，任何实现不得增加、删除或重命名参与字段：

```text
candidateSemanticKey = {
  modelId: string,
  componentEntityId: string,
  itemPartId: string
}

candidateSemanticInputHash = H({
  schemaVersion: "five-axis-hash-input/v1",
  kind: "candidate_semantic_input",
  finalPanelHash: string,
  modelFinalPullKg: CanonicalDecimal,
  directInputs: [{
    axisId: string, parameterKey: string,
    rawValue: CanonicalDecimal, unit: string, inputHash: string
  }]
})

candidateSetHash = H({
  schemaVersion: "five-axis-hash-input/v1",
  kind: "candidate_set",
  vertexGroupKey: FiveAxisVertexGroupKey,
  candidates: [{ key: candidateSemanticKey, semanticInputHash: string }]
})

candidateEvidenceHash = H({
  schemaVersion: "five-axis-hash-input/v1",
  kind: "candidate_evidence",
  vertexGroupKey: FiveAxisVertexGroupKey,
  candidates: [{
    key: candidateSemanticKey,
    snapshotId: string,
    modelRevisionId: string,
    semanticInputHash: string
  }]
})

vertexSetHash = H({
  schemaVersion: "five-axis-hash-input/v1",
  kind: "vertex_set",
  vertexGroupKey: FiveAxisVertexGroupKey,
  candidateSetHash: string,
  vertices: [{
    axisId: string,
    vertexRawValue: CanonicalDecimal,
    vertexSelectorId: string,
    vertexSelectorVersion: string
  }]
})
```

其中`H`只能表示上述JCS/UTF-8/SHA-256流程，不是字符串连接。`candidateSetHash`表达会影响五维语义的候选集合，参与`vertexSetHash`；`candidateEvidenceHash`表达当前正式Snapshot指针与来源证据，用于并发检查和审计。仅`snapshotId`或`modelRevisionId`变化、而稳定候选身份、`finalPanelHash`、最终拉力及直接输入完全相同时，`candidateEvidenceHash`可以变化，但`candidateSetHash`和`vertexSetHash`必须保持不变，也不得仅因此为其他已发布Model生成UpgradeCandidate。改变规范序列化、字段、数值编码、排序或hash算法必须发布新的`schemaVersion`，历史Snapshot继续使用其冻结版本。

跨运行时最低测试向量固定如下。下列单行文本就是`candidateSemanticInputHash`的无BOM UTF-8 canonical bytes，不包含行尾换行：

```text
{"directInputs":[{"axisId":"pull","inputHash":"1111111111111111111111111111111111111111111111111111111111111111","parameterKey":"drag","rawValue":"2","unit":"kg"}],"finalPanelHash":"0000000000000000000000000000000000000000000000000000000000000000","kind":"candidate_semantic_input","modelFinalPullKg":"1","schemaVersion":"five-axis-hash-input/v1"}
```

其SHA-256小写十六进制必须为：

```text
29bbd7f7543449ff80ad8e664cac415da4f406e56f78c29620ceda43a5715e7c
```

拼接碰撞回归使用同一`vertexGroupKey={weightBandId:"W1", weightBandPolicyVersion:"wb-v1", fiveAxisDefinitionId:"five-axis:open005-v1", fiveAxisDefinitionVersion:"1", fiveAxisRuleVersion:"rule-v1"}`及由64个`0`字符组成的`semanticInputHash`。候选键`{modelId:"ab", componentEntityId:"c", itemPartId:"d"}`的`candidateSetHash`必须为`82a2ffb028b9077a0b89057efcc1df94bad57f5aa9d063a188d30c2cd3666784`；候选键`{modelId:"a", componentEntityId:"bc", itemPartId:"d"}`必须为`de1ceea2a24c4cf4d7f80c85152340a9cbf60a89090f6705cb3a42c2151bb7cc`。两组旧式裸拼接都可能形成`abcd`，但规范对象和hash必须不同；所有受支持运行时必须逐字节通过这三个固定向量。

普通顶点重建的候选池只包含：

- Model为`ACTIVE`，且上述`configurationSnapshotId`指向真实存在、不可变的正式ConfigurationSnapshot；
- 候选值来自该Snapshot冻结的`modelRevisionId`和最终面板输入，而不是Model的当前草稿；
- 在当前五维定义下输入完整、计算合法的`direct`值；
- 以该Snapshot冻结的`modelFinalPullKg`落入当前W段。

草稿、未发布候选、已废弃、已归档、历史非当前Snapshot和计算错误的数据不得进入普通候选池。轮线继承的抛投值不得进入抛投顶点。

任何会改变候选资格或候选Snapshot指针的动作都必须使用统一的候选差量协议。包括新增Model、替换`configurationSnapshotId`、最终拉力跨W段，以及`ACTIVE ↔ DEPRECATED/ARCHIVED`导致的候选新增或移除。纯Lifecycle命令即使不创建SnapshotBuild，也必须生成`ADD/REPLACE/REMOVE`候选差量并执行同一分组、取锁和事务契约，不得存在只改Lifecycle、延后重建顶点的旁路。`DEPRECATED ↔ ARCHIVED`两侧均不合格，本身不产生候选变化。空系统、新W段或当前完整身份尚无合法顶点时，该流程同时是唯一合法启动路径；不使用隐藏种子顶点、其他W段数值或人工常量。

SnapshotBatch可以跨Series、SKU和W段，但发布批次只是用户确认、进度和结果报告单位，不是全局五维事务边界。顶点构建必须先按上述五个字段的完整身份划分`vertexGroupKey`子组。Series不进入顶点身份；不同Series只有在五个身份字段完全相同时才共享子组。不同W段或任一版本字段不同时必须分组，不得共用顶点集合、`candidateSetHash`、`vertexSetHash`或预览。

事务边界由当前已确认`ready`变更集合的“受影响顶点组依赖图”确定。图节点是全部受影响`vertexGroupKey`；单组`ADD/REPLACE/REMOVE`只触及一个节点；同一Model跨W段或跨定义身份的迁移在旧组与新组之间建立无向边。图的每个连通分量是一个数据库事务边界，必须把当前`ready`集合中触及该分量任一节点的全部跨组迁移和组内变更一起纳入。孤立节点自然形成单组事务；没有共享节点或迁移路径的连通分量分别提交、分别失败并分别重试。禁止按Model逐个提交同一连通分量，也禁止因为同属一个SnapshotBatch就把没有依赖路径的分量合并为全局事务。

原子构建顺序固定为：

1. 发布命令为本批次每个合法`SnapshotBuild`预分配稳定`snapshotId`；幂等重试必须复用原ID。
2. 分别计算每个Model变更前后的候选资格、冻结最终拉力和`vertexGroupKey`，生成`ADD/REPLACE/REMOVE`候选差量。同一组内替换使用`REPLACE`；跨W段或跨定义身份的替换展开为旧组`REMOVE`和新组`ADD`，不得只更新其中一组。
3. 用全部候选差量建立受影响顶点组依赖图并求连通分量；随后按每个分量最小`vertexGroupKey`的稳定顺序处理分量。分量内部按`weightBandId`、`weightBandPolicyVersion`、`fiveAxisDefinitionId`、`fiveAxisDefinitionVersion`、`fiveAxisRuleVersion`的无符号UTF-8字节逐分量字典序取得全部组锁；不得把分量拼成字符串后比较。
4. 在持有分量全部组锁后，读取每个组既有当前正式Snapshot指针集合，再一次性应用该分量的全部候选差量。每个组的目标候选集合中同一Model只能有一个`snapshotId`，不得让被替换或失效的历史Snapshot继续入池；跨组迁移必须同时反映旧组`REMOVE`和新组`ADD`。
5. 只从应用完整分量差量后的最终候选状态，为分量内每个组分别计算有序候选集合、`candidateSetHash`、`candidateEvidenceHash`、各轴顶点、`vertexSetHash`及属于该组的全部SnapshotBuild五维预览。不得让任一SnapshotBuild读取同一分量的中间候选状态。有SnapshotBuild的组在每个必需顶点轴上都必须至少有一个合法`direct`候选，否则返回`FIVE_AXIS_VERTEX_BOOTSTRAP_INCOMPLETE`。
6. 用户确认后，每个连通分量分别使用一个数据库事务，把分量内全部组的顶点结果、全部新ConfigurationSnapshot、Model的`configurationSnapshotId`或Lifecycle条件更新、幂等记录及审计证据全部提交或全部回滚。事务失败不得留下该分量的无顶点Snapshot、无Snapshot顶点、跨组迁移半边或部分更新指针；其他无依赖连通分量已经成功提交的结果不回滚。

例如A从W1迁移到W2、B从W2迁移到W1时，两条迁移共享W1/W2，必须进入同一连通分量；A与B的新Snapshot都只能基于同时应用两条迁移后的最终W1/W2候选集合计算。若另有C在W2内`REPLACE`，C也必须进入该分量事务。只有与W1/W2没有任何共享顶点组或迁移路径的W4变更，才可以独立提交。

候选资格变化和顶点结果必须在同一事务可见。`ACTIVE → DEPRECATED/ARCHIVED`移除最强候选时，必须在同一事务以剩余合法候选重算新顶点，并为受影响的已发布Model生成UpgradeCandidate；不得在Lifecycle已生效后继续把被移除对象用作当前顶点。`DEPRECATED/ARCHIVED → ACTIVE`重新加入其明确指向的正式Snapshot，同样原子发布新顶点结果。

若纯Lifecycle移除使某子组的目标候选集合无法为一个或多个必需轴提供合法顶点，该事务必须把子组当前状态原子记为`UNAVAILABLE_NO_ELIGIBLE_CANDIDATE`，冻结空缺轴、目标候选集合hash和原因，并清除“当前可用顶点”指针；不得回退到被移除候选的旧顶点。这不改写任何历史Snapshot或其冻结顶点，但会阻止该组的新Snapshot发布；后续只能在该组事务中加入合法候选重新启动。如同一组事务已包含SnapshotBuild，缺顶点仍按`FIVE_AXIS_VERTEX_BOOTSTRAP_INCOMPLETE`回滚该组，不得提交不可用状态后再发布Snapshot。

同一完整身份子组的并发构建必须串行化，并同时校验`expectedVertexSetHash`、`expectedCandidateEvidenceHash`与候选Snapshot指针集合；冲突方回滚并基于新集合重算，不得丢失同时发布的更强装备或Lifecycle变更。新五维定义可以对既有Snapshot冻结输入按完整身份分组重建顶点；若新定义需要的输入在旧Snapshot中未冻结，不得从当前Model补读，而应通过新Model revision及其Snapshot启动。

`vertexSetHash`按`five-axis-hash-input/v1`覆盖完整`vertexGroupKey`、`candidateSetHash`、各轴顶点值和顶点选择规则版本；不得包含`snapshotId`、`modelRevisionId`、发布时间或数据库行序。每个顶点版本仍必须冻结完整有序候选源列表、hash序列化版本、`candidateEvidenceHash`和`vertexSetHash`，使审计能够定位具体Snapshot。证据指针变化但五维语义不变时可以生成新的证据revision或`vertexSetId`并复用相同`vertexSetHash`，不得改写历史记录；只有`candidateSetHash`、顶点值、重量段策略、五维定义或五维规则产生语义变化时，才为受影响的已发布Model生成UpgradeCandidate。顺序处理语义未变化的Snapshot升级必须稳定收敛，不能因新`snapshotId`使其他Model反复过期。

竿、轮、线各自计算并绘制五个点，不做部件最小值、平均值、中位数或其他Model聚合。完整钓组中三件装备分别形成闭合五边形；系统不生成“Model最弱环节汇总分”或汇总线。短板只通过曲线差值、直接值排名和解释面板展示。

Series基准固定采用`projection_reference`，不采用显式Model或已批准Model中位数。基准分别读取竿、轮、线对应的`StructuralBenchmark / DerivedProjection`，表达加入functionIntensity、Performance、Material、Affix/Technology和Patch之前的理论结构状态，并输出三条独立参考曲线。参考曲线使用与当前视图相同的W段、五维定义、规则版本和顶点集合，不得聚合；某部位投影不可用时只显示该部位基准不可用，不得自动回退到Model、中位数或其他投影。

目标v23把Series基准锚定到Snapshot冻结的`partId + weightBandId + functionTemplateRef`；不得要求新SKU补造旧ProjectionMatch。现有`projection-reference/current-sku-frozen-match/v1`只服务v9/v22 Snapshot，v23必须发布后继选择器版本并冻结04.5引用、输入指纹与逐Part状态。两种选择器均不得按查询顺序、默认SKU或“最新”引用猜测。

`projection-reference/v23-function-template-frozen/v1`的选择算法固定为：

1. Model详情和钓组模式以待查看Snapshot冻结的`baselineSnapshotId + seriesId + skuId + skuRevisionId`为唯一锚点。选择器只读取该Snapshot内按Part冻结的输入，不读取当前Part/SKU草稿、Series默认SKU、页面上下文或其他SKU。
2. 锚点SKU revision必须冻结其所属`partId + partType + weightBandId + functionTemplateRef + functionTemplateRevisionId + functionTemplateInputFingerprint`。同一Series的基准集合从同一Snapshot中冻结的Part输入构建；竿、轮、线每种零或一个。重复部位、缺少必需字段或SKU/Part父链不一致返回`error`并阻止新正式Snapshot。
3. 对每个存在的Part，按稳定引用精确读取一个04.5 revision，并重新计算其六键输入指纹。引用不存在、revision/hash不符、指纹不符或六键重新解析不是唯一同一行时返回`error`，不得按名称、区间、拉力距离、默认值或其他模板修复。Series未包含的部位返回`missing`；这不是错误，也不得补造Part。
4. `available`参考曲线只使用冻结04.5 revision的基准参数，通过当前FiveAxisViewDefinition的相同轴顺序、transform和W段顶点计算；不得加入Part/SKU词条、Technology、品质、Patch或Model最终值，也不得生成旧ProjectionMatch。三种部位状态和参考曲线固定按竿、轮、线排序。
5. 独立多装备比较只有在用户显式选择已发布`baselineSnapshotId`后才运行该Snapshot对应版本的选择器；未选择时三种部位均为`not_selected`。改变共同W段只改变归一化顶点，不改变锚点、04.5引用或输入指纹。
6. 临时视图和Snapshot都冻结选择器版本、锚点、`partInputs`、逐部位状态与引用字段。选择结果按严格Schema、JCS、无BOM UTF-8和SHA-256小写十六进制计算：

```text
projectionReferenceSetHash = H({
  schemaVersion: "five-axis-hash-input/v1",
  kind: "projection_reference_set",
  selectorVersion: "projection-reference/v23-function-template-frozen/v1",
  anchor: {
    baselineSnapshotId: string,
    seriesId: string,
    skuId: string,
    skuRevisionId: string
  },
  references: [{
    itemPartId: "rod" | "reel" | "line",
    state: "available" | "missing" | "error",
    partId: string | null,
    weightBandId: string | null,
    functionTemplateRef: string | null,
    functionTemplateRevisionId: string | null,
    functionTemplateInputFingerprint: string | null
  }]
})
```

`references`固定按rod、reel、line顺序；`missing`条目的五个引用字段全部为JSON `null`，`error`保留能够安全验证的冻结字段并以错误码另存Trace，错误码不进入本闭集hash。任一锚点、状态或非null引用字段变化都必须改变hash；相同闭集输入必须得到相同hash。发布`FORMAL_CURRENT`前必须提供固定向量，至少覆盖单Part、三Part、缺Part、断裂引用、指纹不符、六键多匹配、相同输入重放和仅`baselineSnapshotId`变化；固定向量未通过时返回`FIVE_AXIS_PROJECTION_REFERENCE_VECTOR_MISMATCH`。

规范固定向量`projection-reference/v23-function-template-frozen/vector-001`冻结如下。Canonical JSON为下列代码块内容本身：单行、无前后空白、无末尾换行、无BOM，按UTF-8字节计算SHA-256；字段顺序已经是JCS输出，不得重新选择示例值：

```json
{"anchor":{"baselineSnapshotId":"snap-001","seriesId":"series-001","skuId":"sku-001","skuRevisionId":"sku-rev-001"},"kind":"projection_reference_set","references":[{"functionTemplateInputFingerprint":"fp-rod-001","functionTemplateRef":"ft-rod-001","functionTemplateRevisionId":"ft-rev-001","itemPartId":"rod","partId":"part-rod-001","state":"available","weightBandId":"W01"},{"functionTemplateInputFingerprint":null,"functionTemplateRef":null,"functionTemplateRevisionId":null,"itemPartId":"reel","partId":null,"state":"missing","weightBandId":null},{"functionTemplateInputFingerprint":null,"functionTemplateRef":null,"functionTemplateRevisionId":null,"itemPartId":"line","partId":null,"state":"missing","weightBandId":null}],"schemaVersion":"five-axis-hash-input/v1","selectorVersion":"projection-reference/v23-function-template-frozen/v1"}
```

期望小写十六进制摘要为`d7221f605b72dfcd97f6d00002d206cf4d308490c3599f64a24d3f239f61d600`。任何实现若不能逐字复现该摘要，不得发布或使用v23 `FORMAL_CURRENT`定义；其余必测向量必须沿用同一闭集Schema和编码规则。

历史`projection-reference/current-sku-frozen-match/v1`的选择算法固定为：

1. Model详情和钓组模式以待查看Snapshot冻结的`seriesId + skuId + skuRevisionId`作为引用锚点；不得读取Model当前草稿、Series默认SKU、页面上下文或查询结果第一项。
2. 该SKU revision必须按`itemPartId`冻结竿、轮、线各零或一个`ProjectionMatch`。每个合法匹配必须显式冻结`projectionMatchId + projectionMatchRevisionId + projectionId + projectionRevisionId`；同一部位出现多个匹配是`FIVE_AXIS_PROJECTION_REFERENCE_AMBIGUOUS`，不得按创建时间、最大revision、距离、W段或数据库顺序择一。
3. 选择器按竿、轮、线稳定部位顺序逐项读取冻结匹配。某部位没有匹配时返回`missing`并只省略该参考曲线；引用断裂、revision或hash不符时返回`error`并阻止新正式Snapshot。不得改用同Series其他离散SKU、同W段其他ProjectionMatch、默认SKU或其他部位投影。
4. 独立多装备比较没有天然Series/SKU锚点。只有用户显式选择一个已发布`baselineSnapshotId`后才显示其三条投影参考线；未选择时三条参考线状态均为`not_selected`，不得自动取第一件装备或当前页面Model。改变共同W段只改变归一化顶点，不改变投影引用锚点。
5. 临时视图和Snapshot都必须保存选择器版本、锚点、逐部位状态及上述四个稳定引用字段。选择结果使用`five-axis-hash-input/v1`的独立闭集envelope计算：

```text
projectionReferenceSetHash = H({
  schemaVersion: "five-axis-hash-input/v1",
  kind: "projection_reference_set",
  selectorVersion: "projection-reference/current-sku-frozen-match/v1",
  anchor: { baselineSnapshotId: string, seriesId: string, skuId: string, skuRevisionId: string },
  references: [{
    itemPartId: string,
    state: "available" | "missing" | "error",
    projectionMatchId: string | null,
    projectionMatchRevisionId: string | null,
    projectionId: string | null,
    projectionRevisionId: string | null
  }]
})
```

`references`固定按竿、轮、线顺序；`missing/error`的不可用引用字段全部显式为JSON `null`。该hash进入五维预览`inputHash`和Snapshot证据，但不进入只描述W段共享顶点语义的`vertexSetHash`。选择器版本、`baselineSnapshotId`、锚点SKU revision、任一projection ID/revision或缺失状态变化时，`projectionReferenceSetHash`和预览`inputHash`必须变化；即使两个基准Snapshot指向同一SKU revision，只要`baselineSnapshotId`不同也必须得到不同hash。旧Snapshot仍使用其冻结引用。

每个点同时保留：

```text
comparisonScore = componentRatio × 100
officialDisplayScore = round(clamp(componentRatio, 0, 1) × 100)
```

`comparisonScore`不封顶、不取整，用于绘图、排名和差异计算。排名只接受合法`direct`点；精确`comparisonScore`相同的点共享同一业务名次。界面需要稳定排列并列项时，按`comparisonOrder`再按稳定`entityId`排列，但该次序只用于展示，不得打破业务并列或产生额外优劣结论。`officialDisplayScore`限制在0至100并四舍五入为整数，用于正式面板、档位和Snapshot。

每个点必须区分以下来源与状态：

- `direct`：合法直接输入，正常绘制并可参与排名；
- `context_inherited`：轮线继承参考竿的抛投点，正常绘制但使用继承样式，不参与排名；
- `not_applicable`：规则上本来不适用，不补0、不排名，也不视为错误；
- `missing`：按规则应有输入但数据缺失，不绘制该点并阻止正式发布；
- `error`：输入、分母、顶点或计算非法，不绘制该点并阻止正式发布。

缺少合法顶点时不得使用隐藏默认值、其他W段顶点或历史无关顶点。

### 21.4 展示档位与源文档歧义

五轴均显示精确正式分。感度、操控额外显示强/中/弱摘要；拉力、耐久和抛投保留分数及原始单位，不用档位替代精确信息。策划工作台的解释面板可以查看原始值、顶点、精确比例、比较分、规则版本和Trace。

飞书revision `3563`把中档上限写为`800`，与0..100比例语义冲突。该值不得硬编码。档位必须是版本化配置，并通过以下校验：

- `0 <= min < max <= 100`；
- 区间没有重叠和空洞；
- 边界归属唯一；
- 非法飞书值产生导入warning并阻止发布该档位配置。

正式档位按`officialDisplayScore`判断：`弱[0,50)`、`中[50,80)`、`强[80,100]`。50属于中，80和100属于强。飞书revision `3563`中的越界值不得进入正式定义。

### 21.5 建议数据结构

```ts
type FiveAxisAxisId = string;

interface FiveAxisMetric {
  axisId: FiveAxisAxisId;
  axisDefinitionVersion: string;
  entityId: string;
  itemPartId: string;
  source: "direct" | "context_inherited" | "not_applicable" | "missing" | "error";
  rawValue: number | null;
  vertexValue: number | null;
  componentRatio: number | null;
  comparisonScore: number | null;
  officialDisplayScore: number | null;
  displayBand?: "strong" | "medium" | "weak";
  trace: CalculationTraceEntry[];
}

interface FiveAxisVertexCandidateSource {
  snapshotId: string;
  modelId: string;
  modelRevisionId: string;
  componentEntityId: string;
  itemPartId: string;
  finalPanelHash: string;
  modelFinalPullKg: number;
  directInputs: {
    axisId: FiveAxisAxisId;
    parameterKey: string;
    rawValue: number;
    unit: string;
    inputHash: string;
  }[];
}

interface FiveAxisVertexGroupKey {
  weightBandId: string;
  weightBandPolicyVersion: string;
  fiveAxisDefinitionId: string;
  fiveAxisDefinitionVersion: string;
  fiveAxisRuleVersion: string;
}

interface FiveAxisVertexGroupResult {
  groupKey: FiveAxisVertexGroupKey;
  hashInputSchemaVersion: string;
  state: "AVAILABLE" | "UNAVAILABLE_NO_ELIGIBLE_CANDIDATE";
  candidateSetHash: string;
  candidateEvidenceHash: string;
  vertexSetHash: string | null;
  missingAxisIds: FiveAxisAxisId[];
}

interface FiveAxisVertexSet {
  vertexSetId: string;
  weightBandId: string;
  weightBandPolicyVersion: string;
  fiveAxisDefinitionId: string;
  fiveAxisDefinitionVersion: string;
  fiveAxisRuleVersion: string;
  hashInputSchemaVersion: string;
  candidateSources: FiveAxisVertexCandidateSource[];
  candidateSetHash: string;
  candidateEvidenceHash: string;
  vertexSetHash: string;
}

interface ModelFiveAxisPreview {
  modelId: string;
  modelFinalPullKg: number;
  weightBandId: string;
  weightBandPolicyVersion: string;
  fiveAxisDefinitionId: string;
  fiveAxisDefinitionVersion: string;
  fiveAxisRuleVersion: string;
  hashInputSchemaVersion: string;
  vertexSetHash: string;
  sourceRevision: string;
  componentSeries: { entityId: string; itemPartId: string; metrics: FiveAxisMetric[] }[];
  projectionReferenceAnchor: {
    baselineSnapshotId: string;
    seriesId: string;
    skuId: string;
    skuRevisionId: string;
    selectorVersion:
      | "projection-reference/current-sku-frozen-match/v1"
      | "projection-reference/v23-function-template-frozen/v1";
    partInputs: {
      partId: string;
      weightBandId: string;
      functionTemplateRef: string;
      functionTemplateRevisionId: string;
      functionTemplateInputFingerprint: string;
    }[];
  };
  projectionReferenceSetHash: string;
  projectionReferenceSeries: {
    itemPartId: string;
    state: "available" | "missing" | "error";
    projectionMatchId: string | null;
    projectionMatchRevisionId: string | null;
    projectionId: string | null;
    projectionRevisionId: string | null;
    partId: string | null;
    weightBandId: string | null;
    functionTemplateRef: string | null;
    functionTemplateRevisionId: string | null;
    functionTemplateInputFingerprint: string | null;
    metrics: FiveAxisMetric[];
  }[];
  inputHash: string;
}
```

同一`projectionReferenceSeries`条目必须由`selectorVersion`决定闭合形状：历史选择器要求四个Projection字段并禁止五个v23字段；v23选择器要求`partId + weightBandId + functionTemplateRef + functionTemplateRevisionId + functionTemplateInputFingerprint`并禁止四个Projection字段。`partInputs`在历史选择器下必须为空，在v23选择器下按稳定Part顺序完整冻结。不得把两种引用混装或用全`null`占位通过校验。

`axisId`由版本化定义提供，不得在前端联合类型、数据库列或图表组件中写死。同一个预览中的每条曲线必须与冻结的`fiveAxisDefinitionId + fiveAxisDefinitionVersion`逐项对应，缺轴按第22节状态语义返回，不能临时补0。

缓存键至少包含：

```text
modelRevision
+ finalPanelHash
+ modelFinalPullKg
+ weightBandPolicyVersion
+ fiveAxisDefinitionId
+ fiveAxisDefinitionVersion
+ hashInputSchemaVersion
+ vertexSetHash
+ projectionReferenceSelectorVersion
+ projectionReferenceSetHash
+ fiveAxisRuleVersion
```

Model最终参数、组件或相关Patch变化后必须重算，包括最终拉力变化导致W段切换。发布Snapshot冻结最终拉力、W段及策略版本、五维定义ID/版本、三条部件曲线、`projectionReferenceAnchor`、逐部位投影引用状态与ID/revision、`projectionReferenceSetHash`、三条结构投影参考曲线、完整有序`FiveAxisVertexCandidateSource`列表、`hashInputSchemaVersion`及`vertexSetHash`、输入哈希、飞书源revision和`fiveAxisRuleVersion`。上游顶点变化只能生成UpgradeCandidate；投影引用变化只影响新预览和UpgradeCandidate，不得改写旧Snapshot。

### 21.6 必测场景

- 拉力、耐久使用同W段共享MAX顶点，竿轮线分别绘制且不聚合；
- 抛投顶点只取竿的direct值，轮线继承第一根竿并显示提示；
- 感度按有效`sensitivity`倒数表达能力，MIN原始值为顶点；
- 操控按`energy_cost_factor`倒数表达能力，MIN原始值为顶点；
- 词条或Patch使最终拉力跨W段时切换共同顶点且不插值；
- 部件超过顶点时正式分显示100，绘图分保持未截断；
- 分母缺失、为0或负数时阻止发布；
- 属性词条或Patch修改底层参数后五维重算；
- 被动词条不影响五维；
- 相同输入与版本产生相同分值和Trace；
- 空系统或新W段首次发布完整Model时，顶点集合与ConfigurationSnapshot同批次原子成功，不需要隐藏种子顶点；
- 首批数据任一必需轴缺少合法direct候选时，顶点集合、Snapshot和Model指针全部不提交；
- 同一Model存在多个历史Snapshot和未发布新revision时，只有`configurationSnapshotId`指向的`snapshotId + modelRevisionId`冻结值进入候选；
- 新五维定义缺少旧Snapshot未冻结的输入时，不得从当前Model草稿补读；
- 幂等重试复用预分配`snapshotId`并产生同一候选集合和hash；仅以新`snapshotId`重新发布语义相同输入时，`candidateEvidenceHash`变化但`candidateSetHash`和`vertexSetHash`不变，且不为其他Model生成UpgradeCandidate；
- 同一W段并发发布发生候选指针、`expectedCandidateEvidenceHash`或`expectedVertexSetHash`冲突时，失败方回滚该组事务并重算；
- SnapshotBatch同时包含两个互不相关W段时，按完整`vertexGroupKey`分别提交两个独立顶点组；一个组失败不回滚另一组，每个Model只使用自己组的`vertexSetHash`；
- A从W1迁移W2且B从W2迁移W1时，W1/W2构成同一连通分量；两条迁移及触及W1/W2的全部组内变更按稳定顺序取锁，在一个数据库事务提交，A/B预览都不读取中间候选状态；
- A从W1迁移W2、B从W2迁移W3时，W1/W2/W3经迁移边形成一个连通分量；无共享节点或迁移路径的W5变更保持独立事务；
- 相同多组输入以不同SnapshotBuild顺序处理时，仍按完整身份确定稳定顺序且不死锁，各组候选集合与hash不变；
- `candidateSemanticKey`中`("ab","c","d")`与`("a","bc","d")`产生不同canonical bytes和hash，不存在元组拼接碰撞；
- `1`、`1.0`、`1e0`和`-0`按规则分别规范为`"1"`、`"1"`、`"1"`和`"0"`；null、空字符串、字段缺失、NaN与无穷值按契约区分或拒绝；
- 相同hash envelope随机重排对象属性和数据库候选返回顺序至少100次，所有受支持运行时在规范排序后产生相同JCS字节与SHA-256；改变数组业务顺序、字段类型、任一值或`schemaVersion`必须改变hash或fail-closed；
- 当前最强`ACTIVE` Model转为`DEPRECATED`或`ARCHIVED`时，同一事务移除候选、选出次强顶点并生成UpgradeCandidate，历史Snapshot不变；
- `DEPRECATED`或`ARCHIVED` Model重新转为`ACTIVE`时，只以其明确`configurationSnapshotId`冻结值重新入池并原子发布新顶点结果；
- 移除候选后必需轴无合法值时，当前子组原子进入`UNAVAILABLE_NO_ELIGIBLE_CANDIDATE`且旧顶点不得继续作为当前顶点；历史Snapshot仍可重放，新发布必须先在该组事务加入合法候选；
- 重量段策略或五维定义版本变化后不得命中旧顶点集合或旧vertexSetHash；
- 同一Series存在多个离散SKU、同一W段存在多个投影时，Model详情只读取其冻结Snapshot锚定SKU revision中逐部位唯一的ProjectionMatch；查询顺序、默认SKU和共同W段变化均不改变引用；
- 独立装备比较未显式选择`baselineSnapshotId`时三条投影参考线均为`not_selected`；选择后冻结selector、`baselineSnapshotId`、锚点SKU revision、projection ID/revision和逐部位缺失状态，任一变化都改变`projectionReferenceSetHash`与预览`inputHash`；两个不同`baselineSnapshotId`即使指向同一SKU revision也必须产生不同hash，历史保存视图继续引用原基准Snapshot；
- 顶点规则变化不改变历史Snapshot；
- `50..800`等越界档位触发导入警告。

### 21.7 既有正式定义迁移与新发布门禁

仓库中已经存在使用旧五轴、`fishWeightGradeId`、`component_min_ratio`、`explicit_model`或`approved_model_median`的定义，并可能带有`publicationState=PUBLISHED`。`PUBLISHED`只描述该历史记录当时的发布事实，不足以证明其符合OPEN-005。本节发布后必须通过独立、不可变且带头指针的目录修订区分用途。处置项本身不原地改写；用途变化通过新的目录修订表达：

```ts
interface FiveAxisDefinitionDisposition {
  definitionId: string;
  definitionVersion: string;
  definitionHash: string;
  effectiveUse: "LEGACY_SNAPSHOT_ONLY" | "FORMAL_CURRENT" | "SUPERSEDED";
  semanticContractVersion: "five-axis/open005-2026-07-23/v1" | null;
  supersededByDefinitionId: string | null;
  supersededByDefinitionVersion: string | null;
  reasonCode: string;
}

interface FiveAxisDefinitionDispositionCatalogRevision {
  catalogRevisionId: string;
  previousCatalogRevisionId: string | null;
  previousCatalogHash: string | null;
  schemaVersion: "five-axis-definition-disposition-catalog/v1";
  entries: FiveAxisDefinitionDisposition[];
  catalogHash: string;
  decidedAt: string;
}
```

每个目录修订都是完整不可变快照：同一`definitionId + definitionVersion`在一个修订中恰好出现一次；同一ID/版本对应多个`definitionHash`时不得择一，必须作为定义身份冲突fail-closed。`entries`按`definitionId + definitionVersion`的无符号UTF-8字节逐分量排序，`definitionHash`仅作为该唯一身份的内容校验字段，不参与制造第二个同名条目。`catalogHash`的闭集输入固定为`{schemaVersion, previousCatalogHash, entries}`，显式排除`catalogRevisionId`、`previousCatalogRevisionId`、`catalogHash`自身和`decidedAt`；按严格Schema、JCS、无BOM UTF-8与SHA-256小写十六进制计算。首个修订的两个前驱字段均为`null`；后继修订的`previousCatalogRevisionId + previousCatalogHash`必须共同命中同一不可变前驱。工作区只保存一个可条件更新的当前目录头`currentFiveAxisDispositionCatalogRevisionId`；读写正式用途只能解析该头，禁止按`decidedAt`、最大ID或数据库行序选择处置。目录链断裂、循环、前驱ID/hash不一致、同ID/版本重复、定义记录与目录`definitionHash`不符或同一修订出现多个`FORMAL_CURRENT`均为处置冲突并fail-closed。

迁移边界固定如下：

- 旧定义原记录、publicationState、payload、definitionHash、VertexSet及引用它的ConfigurationSnapshot全部原样只读保留；不得通过改写旧定义状态或重算hash完成迁移。
- 迁移器先解析当前目录头并计算全部已知定义应有的完整`entries`：不符合本节契约的旧定义为`LEGACY_SNAPSHOT_ONLY`。若当前头已经逐项表达相同`entries`，重复运行必须直接返回该现有修订，不得把当前头再次作为前驱追加等价修订；只有目标`entries`不同才以当前头为前驱构建后继修订。旧Snapshot继续按其冻结定义、顶点、公式和投影证据读取、审计及重放，内容/hash不变；该处置不产生旧Snapshot UpgradeCandidate。
- `LEGACY_SNAPSHOT_ONLY`定义不得创建任何新正式ConfigurationSnapshot，不得作为新UpgradeCandidate的目标定义，也不得仅因原字段仍为`PUBLISHED`而通过发布检查。草稿预览必须明确标记legacy，不能冒充OPEN-005正式结果。
- 新定义只有同时声明`semanticContractVersion="five-axis/open005-2026-07-23/v1"`、`hashInputSchemaVersion="five-axis-hash-input/v1"`并使用与目标Workspace Schema一致的选择器，通过第21、22和24.6节完整Schema/固定向量校验，取得唯一`FORMAL_CURRENT`处置后，才可服务新正式Snapshot。Schema v23的新正式Snapshot必须使用`projection-reference/v23-function-template-frozen/v1`；`projection-reference/current-sku-frozen-match/v1`只允许服务v9/v22历史Snapshot，进入v23目录时其定义只能是`LEGACY_SNAPSHOT_ONLY`或`SUPERSEDED`。
- 在不存在唯一合法`FORMAL_CURRENT`定义、处置记录缺失/冲突、迁移未完成或新定义任一必需策略版本不可校验时，发布路径返回`FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE`并fail-closed；不得回退旧`PUBLISHED`定义、种子定义或无五维证据Snapshot。
- 新定义发布后，旧定义可继续保持`LEGACY_SNAPSHOT_ONLY`；此前符合本契约的正式定义被替换时，必须在同一个后继目录修订中把旧项写为`SUPERSEDED`、把新项写为唯一`FORMAL_CURRENT`。新定义、完整后继目录修订和目录头条件更新必须在一个数据库事务提交；并发头冲突方回滚并基于新头重算。任何替换都不修改历史定义、历史目录修订或Snapshot。
- 新正式Snapshot必须冻结其解析使用的`catalogRevisionId + catalogHash`以及命中的处置项；历史Snapshot没有该字段时仍按原冻结定义重放，不得补写。仅目录证据revision变化而命中的定义及全部五维语义输入未变化时，不得单独造成五维UpgradeCandidate。

迁移与发布门禁最低测试：旧定义迁移前后payload/hash及全部历史Snapshot字节不变；迁移重复运行不产生重复目录修订；仅有旧`PUBLISHED`定义时新正式Snapshot被拒绝；目录链断裂、前驱ID/hash不一致、同一`definitionId + definitionVersion`出现不同hash、目录hash与定义记录不一致、多个正式项或并发头冲突时fail-closed；改变`catalogRevisionId`或`decidedAt`不改变相同目录语义的`catalogHash`；符合新契约且固定哈希向量、投影选择器和比较策略均通过的定义才能成为唯一`FORMAL_CURRENT`；替换定义时旧项`SUPERSEDED`、新项`FORMAL_CURRENT`与目录头原子切换；切换正式定义只产生面向新版本的UpgradeCandidate，不改写旧Snapshot。

## 22. 五维图双模式叠加比较

第21节定义五维数据与逐件曲线。本节增加两种叠加模式；二者必须复用同一个五维计算内核、W重量段和顶点版本，不得在图表组件内重新计算另一套数值。

### 22.1 模式A：竿轮线钓组匹配

在同一个五维图中同时显示当前Model的Rod、Reel、Line曲线。所有曲线使用Model按最终拉力命中的同一W重量段、同一`vertexSetHash`和同一`fiveAxisRuleVersion`。禁止让竿轮线分别按自己的W段归一化。

显示要求：

- 竿、轮、线使用稳定且可区分的颜色、线型、图例和悬浮说明；
- 支持单独隐藏或显示任一曲线，默认保留三件装备；
- 每个轴标出direct点的排名、最高最低差值和未截断比值；
- 不生成Model最弱环节汇总曲线；
- 图表附近同时给出硬兼容结论，视觉接近不能替代CompatibilityRule；
- 配置缺失或无效时显示error或不可计算，不能默认为0。

抛投轴的特殊语义：

- 竿使用自己的max_cast_distance，来源为direct；
- 轮和线沿用比较顺序中第一根竿的抛投值，来源为context_inherited；
- 继承点使用虚线、链接图标或等价提示，并注明不代表轮线自身具有抛投参数；
- 继承抛投不参与竿轮线匹配差值，也不评价轮线的独立强弱。

每个轴可输出离散程度：

```text
if count(directApplicableRatios) < 2:
  axisSpread = unavailable
else:
  axisSpread = max(directApplicableRatios) - min(directApplicableRatios)
```

axisSpread只使用合法direct点，描述共同基准下的强弱跨度，不是硬兼容分，也不改变Affinity Score。合法direct点少于两个时不得把`unavailable`替换为0，也不得进入匹配良好、需要关注或明显失衡的阈值评级；这些评级阈值保持配置化。

### 22.2 模式B：多装备比较

用户可以选择竿、轮、线的任意组合，在同一个五维图中叠加比较；比较组不要求itemPartId相同。

约束：

- 每组至少2件；最大数量从当前已发布`FiveAxisViewDefinition.comparisonPolicy.maximumItems`读取，本次确认版本为5件。在该定义版本内，5是服务端强制的硬上限；未来调整必须发布新定义版本，因此5不是永久领域常量；
- 所有对象使用用户可见、可切换的同一W重量段、同一顶点集合和`fiveAxisRuleVersion`；
- 从Model或SKU进入时，默认采用当前Model按最终拉力命中的W段；
- 从独立装备库进入时必须明确显示并允许选择共同W段；
- 不得把每件装备分别归一化到各自W段后再叠加；
- 图例显示装备名称、部位、最终拉力、所属W段、品质和比较顺序；
- Series结构投影参考线不占5件装备名额。

多装备比较中的抛投：

- 竿的抛投是可比较的direct轴；
- 轮和线继承比较顺序中的第一根竿；只有一根竿时自然以该竿为参考，多根竿时仍按稳定比较顺序取第一根；
- 没有竿时轮线抛投为not_applicable，不绘制为0、不参与排序；
- 轮线继承点必须使用继承样式和提示，且不参与差异排名。

雷达图之外必须提供差异摘要：

- 每个轴的排序；
- 相对选定基准装备的增减值；
- 原始值、精确比例、顶点值、comparisonScore和officialDisplayScore；
- 超过100的未封顶比较分；
- not_applicable、context_inherited、missing和error四种不同状态。

### 22.3 100上限与超顶点比较

正式面板继续截断在0至100：

    officialDisplayScore = round(clamp(ratio, 0, 1) × 100)
    comparisonScore = ratio × 100
    overflow = max(comparisonScore - 100, 0)

雷达图外圈固定表示100分。`comparisonScore > 100`的节点和线段按真实比例直接伸出外圈，不设置视觉上限，也不把外圈自适应改写为其他数值。界面必须扩展绘图区或预留空间，不能裁掉外侧节点，并在外侧节点显示真实比较分。超出绘制不改变正式面板值、档位、品质、兼容、Affinity或Snapshot中的官方分值。

### 22.4 数据契约

FiveAxisSeriesPoint至少保存axisId、axisDefinitionVersion、rawValue、componentRatio、officialDisplayScore、comparisonScore、source和Trace。source枚举为direct、context_inherited、not_applicable、missing、error。

FiveAxisSeries至少保存entityId、itemPartId、label、modelFinalPullKg、weightBandId、comparisonOrder和五轴points。

FiveAxisComparisonView至少保存：

- mode：tackle_fit或equipment_compare；
- referenceWeightBandId与weightBandPolicyVersion；
- fiveAxisDefinitionId与fiveAxisDefinitionVersion；
- fiveAxisRuleVersion；
- vertexSetHash；
- referenceRodEntityId：`string | null`；比较组没有竿时固定为`null`；
- projectionReferenceAnchor：`{ baselineSnapshotId, seriesId, skuId, skuRevisionId, selectorVersion } | null`；独立比较未显式选择基准Snapshot时固定为`null`；
- projectionReferenceSetHash：`string | null`；没有锚点时固定为`null`；
- projectionReferences：竿、轮、线各一项，状态为`available/missing/error/not_selected`；有锚点时按第21.3节保存匹配与投影ID/revision，无锚点时三项均为`not_selected`且引用字段为`null`；
- series列表。

钓组模式中，已发布Snapshot冻结竿、轮、线单件曲线及Series对应的三条结构投影参考曲线，不保存Model汇总线。临时多装备比较选择不进入商品Snapshot；保存为评审记录时，单独保存比较对象ID、Revision、比较顺序、共同W段、可空参考竿和规则版本。玩家把装备从当前比较列表移除只改变该临时比较视图，不产生`REMOVE`候选差量，也不重建W段顶点；若移除的是第一根参考竿，则按剩余比较顺序选择新的第一根竿，剩余列表无竿时`referenceRodEntityId=null`且轮线抛投为`not_applicable`。

### 22.5 双模式必测场景

- 同一Model的竿轮线共享W重量段、顶点集合和规则版本；
- 不允许三个部件分别按自身W段归一化；
- 不生成部件最小占比或其他Model汇总曲线；
- 钓组模式下轮线抛投继承竿，标记context_inherited且不进入匹配差值；
- 多装备比较允许混合竿、轮、线；
- 多根竿的五个直接轴可以正确排序；
- 多个轮线无参考竿时抛投为not_applicable而非0；
- 轮线比较组不保存虚假参考竿，`referenceRodEntityId=null`；从比较列表移除第一根竿时选择剩余第一根竿，无竿时切换为null且不改变W段顶点；
- 多根竿时轮线稳定继承比较顺序中的第一根竿；
- 不同W段装备使用用户选择的共同W段比较；
- 只有一个合法direct点的轴返回axisSpread=unavailable且不进入匹配评级；
- 精确comparisonScore相同的direct点业务排名并列，稳定展示顺序不改变并列语义；
- 当前定义拒绝第6件比较对象；新定义版本可以发布不同maximumItems而不改变历史评审记录；
- 两个超过顶点的对象官方分均为100，但comparisonScore和overflow仍能区分；
- 超过100的曲线按真实比例伸出外圈且不被裁剪；
- 缺失、继承、不适用和错误状态不会互相混淆；
- Series结构基准分别输出竿轮线三条投影参考曲线且不聚合；
- 被动词条不改变单件曲线。

## 23. 系列甘特图与AI评估

### 23.1 “候选池”术语迁移

生产与发布模块的主导航统一使用“钓具系列甘特图”。它是Series、离散重量SKU Drawer和Model状态的规划与导航视图，不是Candidate的长期存储容器。

页面语义固定为：

| 层级 | 推荐文案 | 含义 |
| --- | --- | --- |
| 主导航与页面标题 | 钓具系列甘特图 | 按离散重量规划和查看Series、SKU与Model |
| 生成动作 | 生成 Model 候选 | 运行CandidateSearchRecipe |
| 临时结果 | Model 候选 / 候选结果 | 尚未成为正式Model的计算结果 |
| 规则变化结果 | 升级候选 | 针对已发布Snapshot的新版本建议 |

旧“候选池”不再作为主导航和产品领域层级。CandidateSearchRecipe继续存在，但权威中文名是“候选搜索配方”，只负责枚举、过滤和排序，不承担Series、SKU或Model身份。

甘特图采用纵向重量分段、横向Part分栏；SKU节点显示实际品质并可按其筛选。纵向重量分段直接使用01.x的稳定顺序和规划坐标，不是连续数轴；每个Part分别计算已选重量段的连续区间。

> 覆盖范围只表达系列规划跨度，不代表连续插值。

同一Part相邻重量段合并显示为一个矩形；中间缺至少一个01.x重量段时拆成多个矩形。竿、轮、线分别计算，禁止跨Part合并。合并只改变展示，不合并SKU数据。点击连续矩形后必须先选择具体重量段，再进入该段现有SKU列表与“新增SKU”预览；点击矩形或重量段本身都不得创建数据。

历史路由、书签或权限中使用candidate pool标识时应提供兼容别名或跳转；迁移不得删除已有Candidate、Recipe或计算轨迹。

### 23.2 AI评估与建议的定位

工作台增加“AI评估与建议”，但它是辅助解释与方案生成层，不是规则引擎、校验器或审批人。

固定界面文案：

> 辅助建议 · 不影响系统校验

AI可以读取当前权限范围内的：

- 最终面板属性及Calculation Trace；
- Series、SKU和Model Patch链；
- 硬Compatibility结果和失败原因；
- Affinity各轴贡献；
- Series不变量和重量曲线；
- 五维图逐件曲线、Series结构投影基准和比较结果；
- RuleSetVersion、Projection、Revision和Snapshot引用。

AI允许输出：

- 对硬冲突、warning、属性代价和系列偏离的自然语言解释；
- 问题优先级和可能根因；
- 多个调整方向及预期取舍；
- 调整前后差异预览；
- 当前Model作用域的ModelPatch草稿；
- 通用规则变更的RuleSourceChangeDraft（飞书规则修改草稿）；
- 候选Model之间的比较摘要。

AI不得：

- 改写或覆盖确定性计算结果；
- 把deny、error或硬冲突降级；
- 自动确认warning；
- 直接创建approved Patch；
- 直接写回飞书通用规则；
- 自动批准Series、SKU或Model；
- 自动发布ConfigurationSnapshot；
- 修改已发布Snapshot；
- 执行或推断被动技能的模拟器效果；
- 在没有依据引用时把建议描述为系统事实。

### 23.3 建议到动作的安全链路

AI建议只能沿以下链路进入正式数据：

    AI Finding
    → 查看依据和假设
    → 预览建议后的数值、五维、兼容和不变量变化
    → 创建draft Model Patch或RuleSourceChangeDraft
    → 执行确定性重算和校验
    → 人工审核
    → 批准或发布

AI生成草稿时必须记录生成者为AI，并保留人工创建者、审核者和最终修改差异。用户可以采纳、编辑、忽略或重新评估；忽略建议不得影响发布资格。

### 23.4 可追溯记录

每次AI评估至少保存：

- assessmentId；
- scopeType：series、sku、model或candidate_set；
- scopeId和输入对象Revision；
- inputHash；
- RuleSetVersion和fiveAxisRuleVersion；
- promptTemplateVersion；
- promptTemplateHash；
- 完整`AIModelDescriptorV1`；
- 生成时间；
- Finding、依据引用、假设和未覆盖信息；
- 建议动作与Patch或规则修改草稿预览；
- 状态：fresh、stale、accepted、dismissed或superseded。

当任何输入Revision、Patch、规则版本、五维顶点、promptTemplateVersion或promptTemplateHash发生变化，旧评估自动标记stale，不能继续一键生成草稿；用户必须重新评估或显式查看旧依据。

AI评估结果不进入finalPanelValues、Affinity Score或品质分。发布Snapshot可以保存所采纳草稿的来源assessmentId，但不需要冻结所有未采纳建议。

### 23.5 界面入口与视觉分层

提供两个入口：

1. 钓具系列甘特图工具栏：评估整个Series、多个SKU或一组Model候选；
2. Model预览抽屉的“AI评估与建议”Tab：分析当前Model并创建Patch草稿。

界面必须把三类结果分开：

- 硬校验：确定性、可阻断；
- Affinity：规则化软评分，不阻断；
- AI建议：概率性辅助解释，不改变前两者。

三者不能只依赖颜色区分，必须有明确标签、图标和行为文案。AI区域固定提供“查看依据”“预览变化”“创建草稿”“忽略”和“重新评估”。

### 23.6 AI服务与数据边界

AI能力是可选模块。AI服务不可用、超时或被关闭时，模板派生、候选生成、校验、Patch、发布和历史复现必须正常工作。

#### 23.6.1 Provider、不可变模型描述与降级

本节使用策略版本`ai-provider/open006-v1`。AI连接器只接入公司内网Fancy Hub，Tackle Forger不直接连接外部模型供应方。模型列表在运行时从Fancy Hub取得，不在代码或规范中写死具体模型。部署管理员从当前列表配置一个主模型和有序降级列表。

Fancy Hub模型列表中的可用项必须同时提供`modelId`和至少一个不可变修订标识：`modelVersion`、`deploymentRevision`或`modelArtifactDigest`。连接器把它规范化为：

```ts
interface AIModelRevisionSetV1 {
  modelVersion?: SafeCode;
  deploymentRevision?: SafeCode;
  modelArtifactDigest?: SafeCode;
}
interface AIModelDescriptorV1 {
  provider: "fancy_hub";
  modelId: SafeCode;
  revisions: AIModelRevisionSetV1;
  revisionIdentityHash: Sha256Hex;
  modelListSnapshotHash: Sha256Hex;
}
```

`revisions`递归使用`additionalProperties=false`，三个已知字段中至少一个非空。Fancy Hub同时返回多个标识时必须全部规范化并冻结，禁止任选、按客户端偏好丢弃或建立优先级。`revisionIdentityHash`固定为第23.6.3节算法对`revisions`对象计算的SHA-256。计算`modelListSnapshotHash`时，每项只包含`provider + modelId + revisions + revisionIdentityHash`，先按`modelId`、再按`revisionIdentityHash`的ASCII字节升序排序，随后对完整数组使用第23.6.3节算法；不得把`modelListSnapshotHash`自身放入哈希输入。缺少全部不可变修订标识的模型不得进入可选列表，产生`AI_MODEL_REVISION_UNAVAILABLE`。主模型不可用时只按已配置顺序跳到下一个满足要求的模型；列表耗尽时本次评估失败。响应必须回显完全相同的`modelId + revisions + revisionIdentityHash`，缺失、增加、减少或改变任一修订标识均产生`AI_MODEL_REVISION_MISMATCH`，原始响应只按失败调用留存且不得展示为有效建议或转换草稿。每次评估记录并展示完整`AIModelDescriptorV1`。

Fancy Hub可以把白名单数据转发给任意上游供应方；本工具不对上游训练、服务改进、正文留存、合同、处理地域或跨境流转增加限制。该风险接受不改变Tackle Forger到Fancy Hub之间的字段白名单和密钥禁发边界。Fancy Hub网关自身不得永久保留请求正文或回答；不含正文的运行日志最多保留7天。

#### 23.6.2 可执行出站Schema

`ai-provider/open006-v1`只允许发送`ai-request/v1`。这里的DTO是安全投影，不得直接序列化第24节含`unknown`、自由文本、URL或任意嵌套对象的领域DTO。

```ts
type SafeCode = string;      // ASCII，匹配^[A-Za-z0-9_.:-]{1,128}$
type RequestAlias = string;  // 匹配^[a-z][0-9]{3,7}$，仅本次请求有效
type Sha256Hex = string;     // 匹配^[a-f0-9]{64}$
type SafeValue =
  | { kind: "number"; value: number }   // 必须是有限数
  | { kind: "boolean"; value: boolean }
  | { kind: "enum"; value: SafeCode }
  | { kind: "null"; value: null };

interface AIRequestEnvelopeV1 {
  schemaVersion: "ai-request/v1";
  policyVersion: "ai-provider/open006-v1";
  promptTemplateVersion: SafeCode;
  promptTemplateHash: Sha256Hex;
  assessmentAlias: RequestAlias;
  analysisIntent: "explain_conflicts" | "prioritize_findings" | "suggest_tradeoffs"
    | "compare_candidates" | "draft_model_patch" | "draft_rule_change";
  model: AIModelDescriptorV1;
  scope: {
    scopeType: "series" | "sku" | "model" | "candidate_set";
    scopeAlias: RequestAlias;
    revisionAlias: RequestAlias;
  };
  panelValues: Array<{
    subjectAlias: RequestAlias; parameterKey: SafeCode; value: SafeValue; unitCode?: SafeCode;
  }>;
  traces: Array<{
    subjectAlias: RequestAlias; parameterKey: SafeCode; sequence: number;
    layerCode: SafeCode; sourceAlias: RequestAlias; sourceVersionAlias: RequestAlias;
    operationCode: SafeCode; before: SafeValue; operand: SafeValue; after: SafeValue;
    effectCode: "benefit" | "cost" | "neutral" | "contextual";
    warningCodes: SafeCode[];
  }>;
  patches: Array<{
    patchAlias: RequestAlias; patchRevisionAlias: RequestAlias;
    chainIndex: number; operationIndex: number;
    scopeType: "series" | "sku" | "model" | "final_review";
    subjectAlias: RequestAlias; parameterKey: SafeCode;
    operation: "set" | "add" | "multiply" | "clear";
    operand: SafeValue; before: SafeValue; after: SafeValue;
  }>;
  compatibility: Array<{
    subjectAlias: RequestAlias; result: "allow" | "deny" | "require";
    ruleCode: SafeCode; parameterKeys: SafeCode[]; conditionCodes: SafeCode[];
  }>;
  affinity: Array<{
    subjectAlias: RequestAlias; axisCode: SafeCode; ruleCode: SafeCode;
    score: number; weight: number; weightedContribution: number;
  }>;
  invariants: Array<{
    subjectAlias: RequestAlias; invariantCode: SafeCode; parameterKey?: SafeCode;
    expectedDirection?: "positive" | "negative" | "neutral" | "contextual";
    expected?: SafeValue; actual?: SafeValue;
  }>;
  fiveAxis: Array<{
    subjectAlias: RequestAlias; axisCode: SafeCode; componentAlias?: RequestAlias;
    source: "direct" | "context_inherited" | "not_applicable" | "missing" | "error";
    rawValue?: number; normalizedRatio?: number; officialDisplayScore?: number;
    comparisonScore?: number;
  }>;
  evidenceRefs: Array<{
    evidenceType: "trace" | "validation_issue" | "hard_compatibility" | "affinity_axis"
      | "series_invariant" | "five_axis" | "rule" | "snapshot";
    evidenceAlias: RequestAlias; contentHash: Sha256Hex;
  }>;
}
```

每一层对象都必须执行`additionalProperties=false`。固定硬上限为：UTF-8序列化后总请求不超过131,072字节；`panelValues<=256`、`traces<=1000`、`patches<=256`、`compatibility<=256`、`affinity<=64`、`invariants<=256`、`fiveAxis<=128`、`evidenceRefs<=256`；任一内部`warningCodes/parameterKeys/conditionCodes<=32`。数字必须有限，整数`sequence/chainIndex/operationIndex`必须在`0..1,000,000`。超出时产生`AI_PAYLOAD_SCHEMA_REJECTED`或`AI_PAYLOAD_LIMIT_EXCEEDED`，要求用户缩小范围，不得截断后静默发送。

禁止发送领域对象中的`name/displayName/label/title/message/reason/assumptions/user_note/excerpt/anchor/url/path/author/createdBy/updatedBy`、真实实体ID、真实Revision、飞书用户ID、任意`unknown`值、自由文本公式、完整规则Payload和ActionLink。硬兼容“原因”只能投影为`ruleCode + conditionCodes`，Evidence只能投影为`evidenceType + evidenceAlias + contentHash`；不得发送正文摘录。当前提示由受控、版本化模板和`analysisIntent`组成，不接受用户自由文本插入。prompt模板注册表中的version与正文hash绑定后不可原地修改；同一version出现不同hash时产生`AI_PROMPT_TEMPLATE_VERSION_CONFLICT`并禁止调用。未来要加入任一字段必须发布新Schema与白名单策略版本。

#### 23.6.3 别名、脱敏与发送前检查

每次请求新建独立局部别名表。先收集本次安全投影引用的全部本地身份，身份键固定为`(referenceKindCode, stableLocalId, stableRevisionIdOrEmpty)`。`referenceKindCode`只能取以下`ai-request/v1`固定值，新增种类必须发布新Schema版本：

```ts
type AliasReferenceKindV1 =
  | "adjustment_patch" | "affinity_axis" | "assessment" | "collection"
  | "configuration_snapshot" | "evidence" | "five_axis" | "five_axis_component"
  | "hard_compatibility" | "model" | "model_candidate" | "revision" | "rule"
  | "rule_source_change_draft" | "rule_source_version" | "ruleset_version"
  | "series" | "series_invariant" | "sku_drawer" | "trace"
  | "upgrade_candidate" | "validation_issue";
```

三个分量均使用持久化稳定引用的原始UTF-8字节，不使用显示名、数据库返回位置、创建时间或进程内对象地址，也不做Unicode归一化。比较时逐分量按无符号UTF-8字节字典序升序，空Revision排在非空之前；禁止把分量拼成带分隔符的字符串后比较。相同身份键必须合并为一个引用，不同实体出现相同键时产生`AI_ALIAS_IDENTITY_CONFLICT`并禁止调用。

排序完成后按唯一身份键依次分配`a001`、`a002`……，再替换安全投影中的全部引用。这里“请求级”表示别名映射对象、真实引用和加密映射存储不得跨请求复用；不禁止新的请求再次使用`a001`等别名字符串。相同本地身份集合即使以不同查询或遍历顺序返回，也必须得到相同别名布局；真实ID、Revision和用户身份只保存在该请求的本地加密映射中，不进入Envelope。响应引用无法解析的别名时产生`AI_RESPONSE_ALIAS_UNKNOWN`，对应内容不得生成草稿。

别名替换后、Schema校验前，必须规范化所有数组。字符串按ASCII字节升序，数字按数值升序，可选值按“缺失在前、存在值在后”，枚举按其在`ai-request/v1`联合类型中的声明顺序；复合键必须逐分量比较，不能使用本地化collation。内部`warningCodes`、`parameterKeys`和`conditionCodes`先按ASCII字节升序排列；内部数组或任一顶层数组存在完全相同的重复元素时产生`AI_PAYLOAD_DUPLICATE_ELEMENT`，不得依赖稳定排序保留重复项。顶层数组排序键固定为：

- `panelValues`：`subjectAlias, parameterKey, unitCode?, JCS(value)`；
- `traces`：`sequence, JCS(element)`；
- `patches`：`chainIndex, operationIndex, patchAlias, patchRevisionAlias, JCS(element)`；
- `compatibility`：`subjectAlias, result, ruleCode, JCS(element)`；
- `affinity`：`subjectAlias, axisCode, ruleCode, JCS(element)`；
- `invariants`：`subjectAlias, invariantCode, parameterKey?, JCS(element)`；
- `fiveAxis`：`subjectAlias, axisCode, componentAlias?, source, JCS(element)`；
- `evidenceRefs`：`evidenceType, evidenceAlias, contentHash`。

其中`JCS(value)`或`JCS(element)`只作为前述键相同时的最终字节级tie-breaker，使用本节相同RFC 8785实现。规范化完成后的数组顺序是Envelope契约的一部分，provider响应、数据库默认顺序、语言容器迭代顺序和调用方输入顺序都不得覆盖。

`traces[].sequence`是一次评估的全局且唯一的执行序号，不是subject或parameter内的局部序号；它由确定性内核在执行时产生并持久化，安全投影不得按查询结果重新编号。允许因作用域投影而存在序号间隙；重复或越界产生`AI_TRACE_SEQUENCE_CONFLICT`。`patches[].chainIndex`是本次输入中Patch revision按第8节层级和冻结有序Patch引用展开后的全局、从0开始、连续且唯一的revision链路序号；同一Patch revision的所有操作共享一个`chainIndex + patchAlias + patchRevisionAlias`。`operationIndex`直接投影第8节和第14.2节的权威Patch内执行顺序，不得按`operation`名称、参数或数据库位置重算；同一revision内必须唯一，允许保留历史序号间隙。一个`chainIndex`映射多个revision、同一revision出现不同chainIndex、或同一revision内operationIndex重复时产生`AI_PATCH_ORDER_CONFLICT`并禁止调用。由此`multiply → add`与`add → multiply`产生不同Envelope和inputHash，且provider能恢复原业务顺序。

prompt模板正文先统一为UTF-8、无BOM、换行符LF，并保留其他Unicode码点不做NFC/NFD转换；`promptTemplateHash = lowerHex(SHA-256(promptTemplateBytes))`。Envelope必须同时携带version和hash，因此模板正文或版本任一变化都会改变`inputHash`。

序列化顺序固定为：领域对象→显式安全投影→按本地稳定引用生成请求级别名→替换引用→规范化内部及顶层数组→严格Schema校验→大小/数量校验→密钥扫描→按[RFC 8785 JSON Canonicalization Scheme（JCS）](https://www.rfc-editor.org/rfc/rfc8785)生成canonical JSON→计算inputHash→发送。JCS实现必须完整遵循RFC 8785的对象属性排序、JSON字符串转义和ECMAScript数字序列化；只接受有效Unicode，数字必须有限，`-0`按JCS规范化为`0`，不添加空白。`canonicalBytes = UTF-8(canonicalJson)`且无BOM，`inputHash = lowerHex(SHA-256(canonicalBytes))`。禁止使用语言运行时默认的对象顺序、数组原始输入顺序、pretty-print、平台换行或非JCS数字格式。密钥扫描同时检查已加载凭据的精确值及令牌、私钥、Cookie和Authorization格式；命中时产生`AI_SECRET_DETECTED`并fail-closed。飞书令牌、应用密钥、会话Cookie、Fancy Hub凭据及其他认证材料或密钥在任何情况下都不得进入请求、提示、错误正文、日志或审计正文，且不能被单次操作覆盖。

JCS与哈希最低测试向量固定如下；该对象只用于canonicalization单元测试，不是完整Envelope：

```json
{"schemaVersion":"ai-request/v1","promptTemplateVersion":"prompt-v1","policyVersion":"ai-provider/open006-v1"}
```

规范化结果必须为：

```text
{"policyVersion":"ai-provider/open006-v1","promptTemplateVersion":"prompt-v1","schemaVersion":"ai-request/v1"}
```

上述UTF-8字节的SHA-256必须为`4e455bbba4a0c3a6d3048e2f5e372ab76a26336485ad1b26359b15f8add46e97`。实现还必须覆盖嵌套对象、数组、转义字符、`-0`和RFC 8785数字边界向量。

姓名等身份字段不是永久绝对禁区，但当前Schema没有相应路径，因此不能发送。完整飞书文档、工作簿原始行、附件、未分类自由文本、本机路径、`config.toml`、配置仓库文件、配置表和导出包同样没有Schema路径。未知字段和未知嵌套字段一律拒绝，不得以“脱敏后对象”“必要引用”或通用`metadata`容器绕过。

#### 23.6.4 字段级保留与删除矩阵

| 数据级别 | 精确字段 | 主存储周期 | 用户删除未采纳评估 | 到期/删除后的备份 | 已采纳后 |
| --- | --- | --- | --- | --- | --- |
| 操作元数据 | `assessmentId`、调用人稳定ID、作用域稳定引用、`AIModelDescriptorV1`、prompt/Schema/白名单/脱敏策略版本、input/output hash、请求/完成时间、耗时、token、费用、重试/取消和结果状态码 | 3年 | 保留，但状态改为`USER_DELETED`；不含语义正文 | 主存储到期后30天内清除备份 | 随3年周期；产物另存永久来源子集 |
| 加密原始内容 | 实际Envelope、完整提示、原始模型响应、请求级别名映射 | 180天 | 立即从界面和普通查询隐藏，24小时内从主存储清除 | 删除墓碑阻止恢复；30天内从备份清除 | 仍按180天删除，不因采纳永久保存 |
| 未采纳语义内容 | Finding、Recommendation、assumptions、uncoveredInformation、EvidenceRef、采纳/忽略反馈及理由 | 1年 | 立即隐藏，24小时内从主存储清除 | 删除墓碑阻止恢复；30天内从备份清除 | 选中子集转入产物来源，其余仍按1年删除 |
| 普通操作记录 | OPEN-009第20.2.7节的动作、对象/hash、结果和错误码 | 1年 | 不随评估删除；不得包含原始或语义正文 | 主存储到期后30天内清除备份 | 不变 |
| 产物来源 | `assessmentId`、实际模型描述、选中建议、证据contentHash、人工修改差异、Patch/规则草稿稳定引用 | 随产物永久保留 | 不随评估删除；删除界面必须明确提示 | 随产物备份与不可变规则 | 永久 |

手工删除和定时到期以较早发生者为准。删除事务先写不可变墓碑，再隐藏读取，随后清除主存储和搜索/缓存副本；备份不得被普通应用查询或恢复已经有墓碑的数据。备份清除失败产生运维Issue并重试，不能撤销主存储删除。审计事件、权限和可见性复用OPEN-009，不建立第二套语义。

#### 23.6.5 硬准入与软体验阈值

以下边界不可由单次用户确认越过：严格出站Schema、密钥禁发、不可变模型描述、登录与Capability、Fancy Hub返回的provider硬token/并发/速率/超时限制、部署租户的硬费用上限，以及`ai-batch-limits/open009-v1`中的`maxAssessmentsPerBatch`、`maxConcurrentAssessmentsPerWorkspace`、`batchHardTimeoutMs`、`maxEstimatedInputTokensPerBatch`、`maxEstimatedOutputTokensPerBatch`和`maxEstimatedCostMicroUsdPerBatch`。provider和租户硬值必须在启用连接器前从Fancy Hub能力或部署配置取得且大于0；缺失时产生`AI_HARD_LIMIT_POLICY_MISSING`并禁止调用。批量策略缺失或无效按第20.2.2节fail-closed，批量范围超过硬上限时必须拆分为新的显式批次。

初始软体验阈值为`softPerAssessmentWarningMs=60000`、临时错误自动重试1次、`softConcurrentAssessmentsPerUser=1`、`softConcurrentAssessmentsPerWorkspace=4`、单次参考输入24k token与输出4k token、工作区每日100次参考量，以及软预算80%和100%提示。超过软阈值但仍低于全部硬准入上限时，显示延迟、排队或成本风险，允许用户继续、排队、再次尝试或主动中断；软阈值不改变发布资格。达到任一硬上限时拒绝新请求；已派发调用只按Fancy Hub/provider硬超时终止，只影响AI，不影响核心流程。系统记录Fancy Hub能够返回的token、延迟、重试和成本信息。

#### 23.6.6 权限与动作边界

所有通过公司身份认证的用户都可以运行AI、查看建议并把建议转换为允许的ModelPatch或RuleSourceChangeDraft草稿。只有拥有`ai.provider_policy.manage`的部署管理员可以修改provider、主模型、降级顺序、字段Schema/白名单、保留策略、硬准入和软体验参数。AI永远只能提供解释、建议和草稿，不能批准Patch、确认warning、写回飞书、发布RuleSet、发布ConfigurationSnapshot或修改已发布Snapshot。AI连接器本身不执行发布，因此本策略不要求额外的安全、产品和数据负责人会签；本次用户决策记录和Issue记录构成决策证据。

### 23.7 必测场景

- 旧“候选池”入口兼容跳转到钓具系列甘特图；
- 甘特条不产生连续重量或属性插值；
- 相邻重量段按Part合并，缺段拆分，跨Part不合并；
- 点击合并块后先选具体重量段，点击本身不创建SKU；
- 生成Model候选仍由CandidateSearchRecipe执行；
- AI建议不能覆盖deny、error或硬冲突；
- AI只能创建draft Model Patch或RuleSourceChangeDraft；
- AI草稿进入正式数据前重新执行确定性计算和校验；
- inputHash变化后旧评估标记stale；
- AI失败或关闭不影响核心工作流；
- 未采纳建议不影响Snapshot和发布资格；
- 已发布Snapshot不会被AI修改；
- 被动技能不会被AI当作已验证模拟结果；
- 外部AI请求不包含未授权敏感字段；
- Fancy Hub模型缺少不可变修订时不可选择；同时返回多个修订标识时全部冻结且顺序无关；增加、减少或改变任一标识都使响应不匹配并禁止形成建议或草稿；
- `ai-request/v1`正常字段可以确定性序列化；领域`unknown`、自由文本、真实ID、正文Evidence和任意层未知字段均被拒绝且请求计数保持0；
- prompt模板version或正文hash任一变化都会改变inputHash并使旧评估stale；同version不同hash禁止调用；
- RFC 8785测试向量、嵌套对象、数组、转义字符、`-0`和数字边界在不同受支持运行时产生完全相同的canonical JSON与SHA-256；
- 对同一业务输入随机重排数据库查询返回顺序、实体遍历顺序、集合型顶层数组及内部code数组至少100次；对Patch/Trace查询结果只改变返回位置而保留其`chainIndex/operationIndex/sequence`，随后必须恢复业务执行顺序；每次都产生完全相同的别名布局、canonical Envelope字节和inputHash。跨请求允许重新出现`a001`，但映射对象、真实引用或存储实例不得复用；
- Given同一Patch链包含`multiply → add`，When查询以相反行序返回，Then Envelope仍按chainIndex/operationIndex恢复`multiply → add`；When显式交换两个operationIndex，Then Envelope、inputHash和重放结果都必须变化；
- Given全局Trace sequence为`0,2,5`且跨多个subject/parameter，When查询随机返回，Then Envelope仍为`0,2,5`；重复或按subject重新编号均fail-closed且请求计数保持0；
- 改变任一稳定引用身份键、数组元素或数组元素内容必须改变canonical Envelope与inputHash；别名身份冲突或完全重复元素必须fail-closed且请求计数保持0；
- Envelope超过字节、数组或内部列表硬上限时不得静默截断；实体稳定ID只以请求级代号发送；
- 任意密钥出现在候选请求字段、提示或错误对象时，连接器fail-closed且不发送请求；
- 低于provider/租户/批量硬上限但超过软体验阈值时只提示并允许继续或中断；命中任一硬上限时拒绝请求且不影响核心流程；
- 普通用户不能修改provider、白名单、保留或运行策略；
- 3年元数据、180天原始内容、1年语义/操作记录、永久产物来源互不混淆；用户删除按隐藏→24小时主存储清理→30天备份清理执行且墓碑阻止恢复。

### OPEN-006：AI供应方与数据出网策略

2026-07-23已确认并关闭产品决策，策略版本为`ai-provider/open006-v1`：使用公司内网Fancy Hub；模型从provider动态读取并由管理员配置主模型与降级顺序；请求严格采用版本化字段白名单和请求级实体代号；密钥绝对禁发；上游训练、留存和地域不另设限制；保留、删除、硬准入、软体验阈值、权限和审计按第23.6节执行。

关闭OPEN-006不等于真实连接器已经实现或获准启用。本Issue只固化安全与产品策略；连接器实现、契约测试、密钥扫描、白名单验证、失败降级、保留清理和上线准入由GitHub Issue [#25](https://github.com/futouyiba/tackle-forger/issues/25)跟踪，并必须使用独立Pull Request。在这些验证完成前，真实AI连接器继续保持禁用，只允许本地假数据和契约测试。
