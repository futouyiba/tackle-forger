# Tackle Forger 需求集中交接（2026-07-21）

> 最后对齐v3：2026-07-23

## 1. 文档定位

本文把本轮讨论中已确认、且已合入v3权威规范的需求集中交给开发Agent，避免从聊天记录或视觉稿猜测语义。

- 唯一领域权威仍是 `docs/tackle-forger-development-spec-v3.md`。
- 本文是执行摘要和验收入口，不独立创造规则；冲突时以v3为准。
- UX文档负责页面组织和交互表达，不得反向改变领域对象、校验、版本或冻结语义。
- “钓具系列甘特图”是界面心智模型，不是新增领域实体。
- “AI评估与建议”是带证据的辅助层，不是新的规则裁决层。

## 2. 规则层与结构标杆

规则层分开计算，但钓法和类型可以在同一个界面步骤编辑：

1. 基础重量段模板；重量段本质是基础拉力段。
2. 钓法层；系数显式作用于基础模板。
3. 类型层；枪柄、直柄等系数独立于钓法。
4. 功能定位层；远投、精细、大物搏鱼等显式属性增减在此定义。

结构标杆只包含部位、钓法、类型和功能定位，不包含品质、性能定位、材料、词条、Affinity或后置Patch。性能和词条组合不预先笛卡尔积展开。

标杆只在相同部位、钓法、类型、功能定位中匹配，距离为：

`abs(ln(targetPullKg / derivedPullKg))`

取距离最近者，不连续插值。确定性并列规则、来源模板、规则版本和Trace必须保留。Affinity不参与标杆选择。

## 3. Series、SKU、Model与词条

- 先确定Quality，再编辑Series，最后选择词条。
- Quality固定为 `C/绿、B/蓝、A/紫、S/橙`。
- Series表达概念一致的定位、词条和产品规划，可包含多个离散目标重量。
- 同一Series内 `targetPullKg` 必须唯一；1.5kg、3.5kg、8.2kg分别生成多个SKU。
- SKU是“钓具抽屉”，Model才是玩家实际选择和购买的型号。
- 一个SKU可包含快调短竿、慢调长竿等多个Model。
- `name` 只用于显示和搜索；关联、幂等和改名前后对齐使用稳定ID与revision。
- SKU修改`targetPullKg`时，若尚无任何已发布后代Snapshot，则保留skuId并创建新revision；若已有已发布后代，则旧SKU的重量身份冻结，新重量必须创建新SKU，旧SKU可废弃。
- 正式路由和命令中的`EntityRef.revisionId`必填；不得用“当前最新版”隐式补齐写操作目标。
- 飞书 `06_系列` 保存 `SeriesArchetype`，不是运行时Series、SKU或Model。
- 词条在具体钓具阶段应用，不进入结构标杆匹配。
- 拉力词条只改变最终Model属性、价值分、兼容性或发布结果，不反向重选标杆。
- 技术是词条组合包，不得与内部词条重复提供同名属性加成。
- 被动词条只保存、计分和展示，不执行或验证模拟器逻辑。
- 选词条后计算并留存价值分，用于Quality区间校验和定价；不得反向自动改Quality。

## 4. 自动生成、人工介入与Patch

- 默认自动批量生成Series下多个SKU及Model；用户可以主动限制生成范围。
- 阶段默认不阻断；用户显式介入或阶段策略为 `REVIEW_ON_CHANGE` 时才暂停复核。
- 同输入、同规则版本、同显式seed必须同结果；无随机需求时不强行引入seed。
- 原“候选池”降级为Series/SKU上下文中的“生成Model候选”动作。
- 钓法×重量段、重量段×钓法×类型、功能定位标杆均可预览和人工修改。
- 共享中间层使用 `DerivationLayerPatch`；Series、SKU、Model和最终复核使用各自Patch。
- Patch记录operation、operand、before、after、理由、作者、时间、基线版本和Trace，不覆盖源模板。
- 中间层修改使受影响下游进入DIRTY或待升级；已发布Snapshot不变。
- 所有保存过的Patch进入工具内权威`PatchLedger`，并同步到主飞书工作簿的单一`Patch台账`页；重生成、改名、重启和重新拉取均不得丢失。
- 飞书`Patch台账`是人工可见镜像和审计副本，不是通用规则表或唯一运行时来源；Patch组按`patchId + patchRevision`定位，逐操作镜像按`patchId + patchRevision + operationId`幂等同步；一条属性操作一行，前三个机器字段为`scopeType`、`layerType`、`subjectEntityId`。
- 通用中间层Patch及多个个体Patch呈现的稳定模式，可经汇总分析、人工归纳和影响预览转为 `RuleSourceChangeDraft`，确认后回写对应通用规则页；一期、二期和当前规划三期均不接飞书审批。
- Series、SKU、Model个案Patch不得未经归纳自动反推通用规则；新RuleSet发布后再判断`ABSORBED`、`PARTIALLY_ABSORBED`、继续有效或需要rebase。
- Patch业务状态与飞书镜像同步状态必须分开；一条操作具有稳定`operationId`和`operationIndex`，明细幂等键为`patchId + patchRevision + operationId`。完整Patch revision是审核、重放、rebase、吸收和Snapshot引用的事务边界，部分镜像成功不等于整组同步成功。
- 新建、账本、Snapshot和飞书镜像的规范操作集统一为`set/add/multiply/clear`。旧`ProjectionPatchOperation.remove`只在兼容读取时转换为`clear`；`clear`表示清除当前层覆盖而非写null。`min/max`只用于模板/通用规则；旧Patch或草稿必须在冻结基底上求值并规范化为保留原始意图证据的`set`，无法无损转换则进入复核。
- 飞书镜像行被删除、清空、隐藏或移动不得删除本地Patch；缺失产生`PATCH_MIRROR_ROW_MISSING`并可补写。对象缺失时进入`ORPHANED`，不得按名称重绑。
- `PatchLedger`使用版本化schema和幂等顺序迁移；Snapshot冻结有序Patch revision及operationId集合和PatchSetHash。

## 5. 校验、兼容性、五维图与AI

四套语义必须独立：

1. 硬兼容决定能否组合、生成或发布，不能被AI或软评分覆盖。
2. Affinity Score只表达软适配和排序解释，不参与结构模板选择。
3. 系列不变量保证钓法、类型、功能定位、品质和离散重量约束。
4. AI建议只产生带证据的草稿，不改变前三者裁决。

问题统一使用`ValidationIssue`，动作统一使用受权限约束的`ActionLink`。Severity、Gate和State分别表达强度、关口和处理状态：`BLOCKER`不可waive；`ERROR`默认阻断命中Gate，只有版本化WaiverPolicy明确允许且服务端返回动作时才可申请例外；`WARNING`使用ACKNOWLEDGED记录理由，不得伪装成waiver；`INFO`只解释。硬deny/缺require、Snapshot或Trace完整性、必需版本和配置断链不可waive。每项必须覆盖正常、边界、冲突、恢复、权限和版本冻结验收。

Model右侧预览层包含可配置五维图，支持竿轮线同图观察强弱，也支持多个同部位装备同图比较。轴、聚合、缺值和Series基准由版本化 `FiveAxisViewDefinition` 决定，并展示来源。

“Model预览”和“AI评估与建议”共用右侧层。`AIRecommendation` 记录证据、影响对象、影响属性、动作、建议Patch、生成时间和规则版本。

AI只允许预览、生成Model Patch草稿或飞书规则提案草稿。AI不得自动应用、发布、覆盖硬兼容、改变Affinity、执行被动模拟器、写回飞书、触发拉取或重算已发布Snapshot。AI建议二期实现，一期只完成契约和界面设计。

## 6. 飞书唯一规则工作簿

唯一通用规则源：

`https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh?from=from_copylink&sheet=9nE3Rx`

`?sheet=9nE3Rx` 只是打开锚点；同步边界是整个工作簿。接入器按固定 `sheet_id` 定位并校验名称；改名只告警，同名新表不得顶替。

同步链固定为：

`工具内规则草稿 → 人工确认回写 → 技术回读 → REMOTE_CHANGES_AVAILABLE → 用户显式拉取 → RuleSet草稿 → 校验 → 人工发布RuleSetVersion`

飞书变化不会自动进入工具；回写不等于拉取，拉取不等于发布。通用规则页与`Patch台账`语义分离：前者是共享规则源，后者是工具内Patch权威账本的协作镜像。

### 6.1 revision 2352源表整改

2026-07-21实际执行54个批操作且全部成功，回读revision为 `2352`。该值只是历史观测，不得硬编码成最新版本。

以下是revision `2352`的历史机器ID审计结果，用于迁移核对，不代表当前工作表拓扑：

| 工作表 | 机器列 | 实体 | 数量 |
| --- | --- | --- | ---: |
| 01_重量模板 | BG:BH | WeightTemplate | 64 |
| 02_类型材质 | AC:AD | RodType/ReelType/LineType | 14 |
| 03_功能定位 | BE:BF | FunctionProfile | 19 |
| 04_性能定位 | BE:BF | PerformanceProfile | 19 |
| 05_词条 | AB:AC | RodAffix/ReelAffix/LineAffix | 36 |
| 06_系列 | E:F | SeriesArchetype | 24 |

历史共176个机器ID已经验证数量和唯一性，必须保留且不得复用。revision `2869`的当前拓扑已调整为`04_词条/zrVOxd`、`05_技术/RdZv0J`，不再有独立性能定位页；接入器必须重新审计当前机器区域，未来缺ID新行进入`NEW_SOURCE_ROW`，人工确认后分配并回写，不能按名称猜旧对象。

`00_使用说明` 已补系统接入约定；`09_甘特图` 是开发排期。历史、样例和暂存页不得反向覆盖Series、SKU、Model或冻结Snapshot。

## 7. 品质校验与定价契约

主工作簿revision `2869`将`07_品质评分/FqD4j7`与`08_价格计算/u87sRh`组成一套联合策略，必须按同一revision导入和发布。

品质与价值分：

- 先人工选择Quality，再选择词条和Technology；系统只校验，不根据分数自动改品质。
- 当前区间为C/绿`[0,20)`、B/蓝`[20,40)`、A/紫`[40,65)`、S/橙`[65,100)`。
- 基础分为去重后的词条价值分，加上同部位每个无序词条对只计一次的组合分；Technology只展开成员，不重复计分。
- 三张组合矩阵中的显式0、正分和负分都是规则值；空白镜像半区不是0。缩写必须先解析为稳定affixId，运行时不得按名称关联。
- 最终分按功能定位评分系数相乘；07仍引用性能定位评分系数，但当前工作簿没有独立性能定位页。未显式禁用性能计分时，策略发布以`QUALITY_SCORE_SOURCE_MISSING`阻断。

品质到价格篮子固定为C→跑刀、B→稳健、A→猛攻、S→猛攻。PricingBasket是独立价格分组，不复用Quality、Function或Performance。

定价重量段沿用结构标杆命中的源重量段：`MATCHED_STRUCTURAL_SOURCE_BAND`。评分插值为品质区间内线性插值；08已显式定义零整比、金币、三位有效数字向下取整、最低价100和价格上限300,000,000。数值定义已经具备，但正式策略还必须显式给出`roundingStage`、`minimumPriceScope`和`overflowMode`，不得由开发默认。

当前仍有五项源表一致性或执行语义Issue，而不是旧版笼统的“定价参数待补齐”：

- 07把S上界写为`<100`，08却计算评分100；修复前评分100以`QUALITY_SCORE_BOUNDARY_CONFLICT`阻断正式发布和定价。
- 07引用性能评分系数，但当前工作簿缺少对应规则源；必须显式恢复来源或声明禁用并使用可追踪恒等操作。
- 未定义维修价与购买价的舍入阶段，以及购买价使用未舍入还是已舍入维修价。
- 未定义最低价100作用于维修价、购买价还是两者。
- 未定义超过300,000,000时采用阻断还是封顶。

系统可以生成`NON_FORMAL`价格试算，但只有校验完整并已发布的`PricingPolicyVersion`才能进入Snapshot和Store导出。缺失执行语义时不得发布新策略；修复方式固定为：修改飞书→用户显式拉取→生成新Draft→校验→发布新策略。任何代码默认值、手填价格和对旧Snapshot的静默重算都禁止。

验收至少覆盖：组合分去重与负分、Technology重复引用、品质区间端点、评分100冲突、B品质30分插值得到1.0、A/S共享篮子但使用不同系数区间、已明确舍入阶段时12,345,678向下取三位有效数字为12,300,000，以及缺少舍入阶段/最低价作用域/超限动作时新PricingPolicyDraft不能发布。


## 8. 内网部署与配置交付

工具部署在公司内网Dell R730，使用飞书登录。按已发布`separation-of-duties/open009-v1`，一期、二期和当前规划三期均使用全员统一的已启用Capability，不建设细粒度RBAC、职责分离或飞书审批；未来变化必须另建Issue并发布新策略版本。关键共享写操作使用带单调fencing token的工作区租约：旧token不得提交服务端状态、启动新的服务端可达副作用或写入成功证据，进行中的未知结果必须先回读恢复；浏览器本地文件不能由服务端outbox代写，租约失效后按文件冲突与Manifest恢复处理。支持Chromium内核浏览器。

配置目标是设计人员本地配置Git仓库：

- dev、test等环境各有一个 `configs` 目录和 `config.toml`；
- 环境目录下 `xlsx` 表示1001渠道；
- 非1001渠道不推导固定子目录；每个渠道必须由用户通过目录选择器显式绑定具体目录，例如`xlsx_channel/numerical`；
- 每个目标必须生成并写入 `tackle`、`item`、`store` 三张xlsx表；
- `store` 强制生成并含“上架开关”；
- 按目标目录的TOML校验跨表关联，无法关联必须提示并阻断提交。

草稿不要求逐个手工冻结。发布前可批量创建Snapshot：复用未变化快照，为合格revision生成新Snapshot，跳过并报告阻断对象。

写入必须预览差异、校验关系、确认目标，并使用恢复型事务：记录基线hash，生成三文件备份与恢复Manifest，逐文件写入并回读验证；任一失败按Manifest恢复已写文件。浏览器不能保证三文件跨文件原子替换，不得在界面、日志或验收中宣称“原子提交”。租约在写入期间失效时，即使已有文件落盘也不得报告成功；目标进入外部文件冲突，后续操作先重新授权、回读并恢复或前向协调。关联使用稳定ID和配置键，不按名称、行号或整行覆盖。

## 9. 状态、冻结和开发优先级

后端枚举与前端文案显式映射，至少覆盖草稿、待复核、需修改、硬冲突、待发布、已发布、有升级候选和发布失败。

- `ConfigurationSnapshot` 发布后不可被上游变化静默替换。
- 上游变化只创建新revision、DIRTY或 `UpgradeCandidate`。
- Patch rebase展示基线、远端新值、草稿值和人工选择；冲突未解决不可发布。
- 已发布旧Snapshot与被阻断的新revision可以同时存在。

当前开发优先级：

1. 飞书工作簿注册表、sheet_id校验、revision拉取和单元格Trace。
2. 已有机器ID识别、`NEW_SOURCE_ROW`、人工确认回写与回读。
3. `PricingPolicyDraft` 导入、品质映射、非正式试算和缺参阻断。
4. Series→离散SKU抽屉→Model的稳定ID、生成和Patch传播。
5. 硬兼容、Affinity、系列不变量和统一ValidationIssue。
6. Snapshot批量冻结、UpgradeCandidate和本地三表导出。

实现必须提供正常、边界、冲突、恢复、权限和版本冻结测试；保留输入、规则版本、输出、Trace和审计；增量迁移旧数据，不删除、不重排、不覆盖历史状态。

## 10. 未决事项摘要

唯一登记以v3第20节为准，本文不另建开放清单：

- 产品/策略项：OPEN-001降低型叠加、OPEN-002未来Performance扩展、OPEN-003扩展部位、OPEN-004 Patch偏移阈值、OPEN-005五维定义、OPEN-006 AI供应方与出网；
- 外部规则源阻断：OPEN-007定价执行与源表一致性、OPEN-010飞书Patch台账远端契约；
- 公司策略缺口：OPEN-008 ConfigIdPolicy数字区间、命名格式与保留规则。

OPEN-009已于2026-07-23解决：`ai-refresh/open009-v1`、`ai-batch-limits/open009-v1`、`ai-model-record/open009-v1`、`ai-review/open009-v1`和`separation-of-duties/open009-v1`按v3第20.2节执行，不再列为未决事项。

未发布`ConfigIdPolicyVersion`前不得正式预留ID或提交配置，不能用“最大值+1”或示例ID代替。TOML枚举引用已经由v3确定为通过`configNameKey/name`唯一解析数字ID，不是开放决策。任何可能改变已发布Snapshot冻结语义的方案都不是配置选择，必须先由用户明确确认并修订v3。
