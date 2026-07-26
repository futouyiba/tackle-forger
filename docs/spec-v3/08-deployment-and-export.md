## 25. 内网部署、飞书身份与配置表交付

### 25.1 分期边界

| 阶段 | 必做 | 明确不做 |
| --- | --- | --- |
| 一期 | 公司内网部署、飞书登录、统一Capability接口、全员统一权限、核心规则/Series/SKU/Model/Snapshot、不可提交的`NON_FORMAL`配置预览与结构关系校验；SQLite/D1全量保留workspace revision且保持所有裁剪关闭 | 正式ID预留、生产形态xlsx/正式人工搬运包、本地worktree提交、归档/恢复入口、人工或自动裁剪、AI运行连接器、细粒度RBAC、职责分离、飞书审批 |
| 1.5期 | 发布`ConfigTargetCatalogVersion`、获批扫描Manifest、`ConfigIdPolicyVersion`与reservation ledger；历史导入复核；生成正式人工搬运包或把正式配置差异写入用户选择的`dev/test/online/release`本地worktree | Git合并、远端发布、部署、替代现有发布系统 |
| 二期 | OPEN-006关闭后实现第23、24节已设计的AI评估、证据、变化预览和草稿转换；在OPEN-011独立Issue中验证用户主动归档、恢复和只读dry-run；继续全员统一权限 | OPEN-011关闭证据和首次生产裁剪授权完成前的任何revision删除、未经独立授权的自动裁剪、自动应用、自动发布、AI裁决、细粒度RBAC、职责分离、飞书审批 |
| 三期 | 保持统一Capability策略并完成既定业务能力；治理变化必须另立Issue和策略版本 | 预设业务角色、对象级RBAC、职责分离、飞书审批，以及改变既有ID、操作记录和Snapshot语义 |
| 交付Phase 4（尚未排期） | 仅在入口门槛、独立策略版本和明确授权全部满足后，按[`Phase 4并发演进设计`](../architecture/future-concurrency-evolution-phase-4.md)逐步验证统一Operation、结构化资源协调、依赖图事务边界、资源级并发和多节点可行性；每一步保留工作区锁回退 | 在入口门槛未满足时取消或缩小工作区级单写锁；仅凭规划文档新增API、schema、状态或多节点运行；降低fencing、幂等、Git CAS、本地恢复、历史冻结和外部结果回读门禁 |

“交付Phase 4”是本节的产品交付分期，不是第17节“当前实现迁移”的“阶段4”。本文发布时Phase 4尚未排期，且不改变一期至三期的任何实现范围或验收口径。未来即使进入Phase 4，也必须从保留工作区锁的统一记录与影子分析开始，不能直接跳到拆锁或多节点。

当前飞书登录同时构成身份边界和统一权限入口：

- 仅接受配置的公司飞书租户；保存稳定飞书用户标识、显示名和最近登录时间。
- 登录回调使用state/nonce和安全会话；令牌只保存在服务端，不进入浏览器日志、AI输入或导出包。
- 轻量操作记录按第20.2节记录当前用户。未登录返回401；功能未启用或Capability不可用时返回403和可恢复Action。
- 除`ai.provider_policy.manage`只授予部署管理员外，所有已登录用户统一获得全部当前已启用业务Capability；统一策略也必须由服务端Capability适配器返回，不在页面写`if user`，不得通过直接API绕过功能开关或管理员边界。
- 不建设应用内成员、代理或临时授权；停权通过飞书账号、部署访问名单或服务端会话撤销完成。
- 内网服务不可用时显示明确登录/服务状态；不得进入离线匿名编辑后再冒充用户提交。

### 25.2 本机配置目录与环境/渠道边界

一期可以完成并下载不可提交的`NON_FORMAL`预览；1.5期才允许生成正式人工搬运包或通过支持File System Access API的Chromium内核浏览器正式写入本地，默认通过HTTPS提供内网页面。无内网DNS且明确接受降级时，可通过默认关闭的`FEISHU_ALLOW_INSECURE_HTTP=true`配置，仅对RFC 1918私网IP开放HTTP；此时会话Cookie不设置Secure，且浏览器依赖安全上下文的能力（包括File System Access API）可能不可用。另有严格的本机开发例外：仅当`NODE_ENV=development`且同一显式开关开启时，飞书登记回调可使用数值 IPv4 `http://127.0.0.1[:port]/api/auth/feishu/callback`。该例外不得接受`localhost`、其他`127/8`地址、IPv6 loopback/ULA、域名或公网 HTTP，生产、测试和部署环境一律拒绝；它不改变一期生产验收或部署降级边界。用户通过目录选择器显式授权本地配置worktree；不要求安装本地伴随程序，也不让服务器访问设计人员电脑。

```ts
interface ConfigEnvironmentProfile {
  environmentId: string;       // dev、test、online、release
  label: string;
  configTomlRelativePath: "config.toml";
}

interface LocalExportTargetBinding {
  bindingId: string;
  environmentId: string;
  channelKey: string;          // 1001或用户自定义标签
  targetKind: "DEFAULT_1001" | "EXPLICIT_CHANNEL_DIRECTORY";
  directoryHandleStorageKey: string;
  userLabel: string;
}
```

- `dev`、`test`、`online`、`release`是首批人工导出环境，不是渠道；每个环境对应一个用户选择的独立configs worktree根目录，并使用自己的`config.toml`。
- 每个环境的1001渠道固定写入该环境根目录下的`xlsx`。
- 其他渠道只处理用户明确选择的具体目录，例如`xlsx_channel/numerical`；正式提交还必须匹配当前`ConfigIdPolicyVersion`引用的权威目标目录条目，未列入的绑定只能用于`NON_FORMAL`预览。工具不从本机目录发现、启用、停用或治理渠道，也不解析或修正`config_system.toml`。
- 服务端只保存环境、渠道和用户标签等逻辑信息，不保存本机绝对路径。
- `FileSystemDirectoryHandle`按`userId + browserProfile + siteOrigin + environmentId + channelKey`保存在IndexedDB中；不进入用户业务数据库，Cookie仅用于飞书登录会话。切换环境或渠道时自动切换到对应绑定，不要求用户重复输入目录。
- 导出前调用`queryPermission({ mode: "readwrite" })`；状态至少表达已绑定已授权、已绑定需重新授权、未绑定、目录失效。
- 换电脑、浏览器配置、站点origin或无痕会话时允许重新绑定；不同用户不共享目录句柄。
- File System Access API不可用时，一期仍只能下载`NON_FORMAL`预览包；1.5期只有在已有正式Bundle、目标已列入权威目录、对应获批`ConfigTargetScanManifest`保持新鲜、通过`config.export.commit`鉴权，并在生成/下载前取得`ConfigTargetGovernanceLease`且确认全部authoritative ref可执行受保护expected-old-OID CAS时，才可下载正式变更包作为人工搬运降级。协调器不可达、token连续性无法证明、ref存在绕过路径或其他串行化门禁不成立时返回`CONFIG_TARGET_SERIALIZATION_UNAVAILABLE`，不得生成或下载正式包，只能保留`NON_FORMAL`预览。下载成功结果审计为`FORMAL_PACKAGE_DOWNLOADED_NOT_APPLIED`并冻结租约/CAS证据，不得声称已经写入本机Git工作区。

一期下载物固定为`ConfigPreviewPackage`：`packageKind=CONFIG_PREVIEW`、`publicationState=NON_FORMAL`、`formal=false`。没有正式Bundle时，数字ID和正式`configNameKey`字段必须为空，并只在预览Manifest中使用不符合生产schema的`NON_FORMAL:<modelId>:<objectKind>`符号引用来做结构关系检查。包内不得出现可被配置编译器直接接受的`tackle.xlsx`、`item.xlsx`、`store.xlsx`，只允许带明显水印/说明的`*.preview.xlsx`或差异报告；每个预览文件顶部和Manifest都必须写明“不可提交、不可人工搬运到configs”。`commit_config_export`必须拒绝`NON_FORMAL`包、占位身份和没有已预留Bundle的请求。

1.5期的正式`ExportPackage`必须引用已预留Bundle、有效策略版本、目标目录版本和对应获批扫描Manifest，并要求`config.export.commit`；正式人工搬运包的生成/下载和本地落盘都必须取得第20节OPEN-008定义的`ConfigTargetGovernanceLease`，冻结`leaseId + fencingToken + expected old OID + manifestSetHash`，并以受保护CAS/串行化可用作为生成门禁。无论选择浏览器落盘还是正式人工搬运包，都不能由一期预览包原地升级或仅移除`NON_FORMAL`标记，必须从当前Snapshot和目标基线重新生成、重新校验。人工搬运包下载完成并提交`FORMAL_PACKAGE_DOWNLOADED_NOT_APPLIED`证据后释放本次租约，不长期持有；下游真正推进authoritative ref时必须重新取得治理租约并以包内expected old OID执行受保护CAS，Tackle Forger只记录“已下载、未应用”。

### 25.3 发布末端两步

1.5期正式流程固定为：

```text
选择Series/SKU/Model范围
→ 准备发布与导出
→ 批量预检并生成SnapshotBatch
→ 一次确认：复用未变化Snapshot、为合格新revision创建Snapshot
→ 选择一个或多个环境×渠道目标
→ 步骤1：生成配置表差异预览
→ 步骤2：关系校验、人工确认、恢复型提交
→ 每目标独立结果与审计
```

不要求逐个Model手工冻结。SnapshotBatch必须列出复用、新建和因问题跳过的Model；批次由用户显式发起并一次确认，禁止后台静默冻结。无内容变化时复用现有Snapshot，不创建空版本。正式写入始终读取明确的Snapshot，不读取可变草稿。

SnapshotBatch跨Series、SKU或W段时，必须按第21.3节先划分完整`vertexGroupKey`，再以跨组迁移为边建立受影响顶点组依赖图。批次只是用户确认、进度和结果报告单位，不是全局五维事务边界；确认页至少列出每个组的完整身份、变更前/后候选语义hash与证据hash、所属连通分量、顶点结果或不可用状态、该组SnapshotBuild及被影响的UpgradeCandidate数量。每个连通分量按稳定组锁顺序，以一个数据库事务提交触及其节点的全部迁移和组内变更；无依赖连通分量可以分别成功、失败和重试。预检中不合格Model可以在用户确认前明示跳过；提交后批次结果必须逐连通分量及逐组报告，失败分量不得产生新Snapshot或迁移半边，成功分量不得因无依赖W段失败而回滚。

SnapshotBatch预检还必须按第21.7节解析唯一`FORMAL_CURRENT`五维定义，并按第21.3节为每个SnapshotBuild冻结`projectionReferenceAnchor + projectionReferenceSetHash`。仅有旧`PUBLISHED`/`LEGACY_SNAPSHOT_ONLY`定义、处置冲突、投影引用歧义或引用revision断裂时，整个受影响SnapshotBuild在进入用户确认前fail-closed；不得生成缺少新契约五维证据的正式Snapshot。历史Snapshot的查看、重放和既有导出引用继续使用其冻结旧定义，不进入该新建门禁的重算路径。

步骤1不直接覆盖正式文件。它在内存或浏览器暂存区生成：

- `tackle.xlsx`：按部位写入Rods、Reels、Lines等目标sheet；
- `item.xlsx`：写入Item及必要的展示/引用字段；
- `store.xlsx`：每个Model强制生成GoodsBasic和StoreBuy；
- `ExportManifest`：目标Profile、源Snapshot、正式Bundle、`ConfigIdPolicyVersion`、`ConfigTargetCatalogVersion`、目标扫描Manifest、目标workbook/sheet/row、before/after、原文件hash、生成器版本、映射版本。

映射必须按该环境根目录`config.toml`的逻辑表名解析`workbook + sheet`，不能只凭文件名或固定sheet猜测。装备Model的最小强制映射为部位tackle表、item、goods_basic和store_buy；TackleSet及其他摆放表只有在用户显式生成相应对象时才写。

配置身份规则：

- 配置ID由服务端的版本化`ConfigIdPolicy`和reservation ledger按`OPEN-008`已确认规则分配；禁止把“扫描当前最大值+1”作为永久策略。分配必须事务化，已预留ID即使放弃也不复用。策略版本未发布、其引用的权威目标目录/获批扫描Manifest覆盖不完整，或任一authoritative ref没有可强制执行的治理租约、fencing token与expected-old-OID CAS协议时，仍按`OPEN-008`阻止正式预留、历史导入和提交。
- 一个Model拥有稳定`ConfigIdBundle`；tackle与item共享`configNumericId + configNameKey`，GoodsBasic与StoreBuy使用各自稳定ID/名称键。
- 同一个Model跨Snapshot、环境和渠道沿用同一套ID；若游戏中需要新旧版本并存，必须创建新Model。
- 同一Model的新Snapshot导出时更新相同配置行；旧Snapshot继续在Tackle Forger内部不可变、可审计，但配置Git仓库只表达该Model最近一次成功导出的当前状态。
- 找到相同`ID + configNameKey`时更新工具负责的列；未找到时新增；同名不同ID、同ID不同名或ID/名称分裂命中时阻止该目标写入。
- 工具不按行号关联、不整行覆盖、不删除未导出的旧行，也不自动整理顺序；未知列、人工列、样式、公式和表头必须保留。
- `store_buy.enabled`是BOOL“上架开关”。必须同步更新所有渠道StoreBuy schema、配置编译器类型/解析、迁移、导出器和校验器。新建StoreBuy默认false；更新普通数值时保留每个环境×渠道现有值，只有用户显式修改上架状态时才改变。
- 定价必须来自已发布`PricingPolicyVersion`。2026-07-23已确定S包含100、Performance不参与计分、两个价格分别最终舍入、购买价使用未舍入维修价、最低价100作用于舍入后的购买价，以及300,000,000为需二次确认的软阈值。飞书机器源与运行时完成新契约落地前，旧Draft不得冒充正式新策略；不得用手填价格替代。Snapshot必须冻结实际价格、超限标记和有效ACKNOWLEDGED确认引用。目标字段无法表示实际价格时仍以独立EXPORT BLOCKER阻止该目标。

写入要求：

- 保留未管理sheet、未知列、样式、公式和表头；当前工作簿前4行为元数据/表头，数据从第5行开始，生成器不得破坏。
- 多目标可同时选择，每个“环境×渠道”独立预检、暂存、校验和提交；默认继续写入其他合格目标，用户可以在确认页改为“任一失败则全部不写”。
- 预览后原文件hash或mtime变化则阻止提交并要求重新生成。
- 浏览器不能保证三个工作簿跨文件原子替换。每个目标使用恢复型事务：记录基线hash→生成备份与恢复Manifest→逐文件写入→逐文件回读验证；任一失败则按Manifest恢复已经写入的文件。
- 备份保留周期和清理策略配置化；用户可下载Manifest和校验报告。
- 工具只修改工作区文件并报告差异，不执行git add、commit、pull、push。

### 25.4 TOML关系校验

根`config.toml`以`[tables.<logicalName>]`声明workbook/sheet，并以`enums = [{ field, table }]`声明引用。校验器必须复用现有配置编译器的解析语义。当前表内引用值使用可读`configNameKey`，解析后必须唯一落到目标记录及其数字ID；逗号分隔目标表按合法目标并集处理。

最低校验：

1. 目标文件、sheet、字段和前4行schema存在且与Profile预期兼容；
2. 主键/业务键非空且不重复；
3. 每个`enums.field`能解析到一个允许目标表；逗号分隔目标表示合法目标并集；
4. 标量、分段列表、重复列组和NULL哨兵按现有编译器语义解析；
5. tackle/item/store新增行之间的引用完整；
6. 未声明sheet、孤儿记录和未使用对象按策略产生warning，不直接删除；
7. 同一ExportPackage在多个channel结果可不同，但schema/mapping版本必须显式记录。

校验分两层：

- 强制增量校验：本次新增/更新行及其必需引用闭包。断链、重复ID/名称、类型和schema错误以`gate=EXPORT`阻止该目标。
- 可选全库检查：用户主动触发后扫描`config.toml`声明的全部关系。与本次变更无关的历史问题只提示和记录，不阻止本批导出。

统一错误返回`ValidationIssue(gate=EXPORT)`，至少包含环境、渠道、源文件、sheet、Excel行、字段、原值、目标逻辑表、规则和ActionLink。缺workbook/sheet/field、重复键、断链、类型错误为ERROR或BLOCKER；未声明sheet和可接受孤儿默认为WARNING。

本工具不读取或治理`config_system.toml`，也不根据其中的渠道声明决定写入路径。

### 25.5 导出场景与验收

正常路径：选择dev/test/online/release中的多个显式目标，在暂存区生成三表，关系全通过后确认并提交，各目标返回新hash与备份。
边界：某目标缺必需Store映射时阻止该目标，不能生成半行；一期或没有正式Bundle时只能下载`NON_FORMAL`预览；1.5期浏览器不支持或未授权目录时，只有`config.export.commit`鉴权、新鲜Manifest、治理租约和受保护CAS/串行化门禁全部通过后才可生成并下载人工搬运包。
冲突：预览后文件被Excel或其他人修改，hash冲突阻止覆盖。
恢复：保留ExportPackage和报告；重新读取目标做三方差异，或从备份回滚；幂等提交不得重复插行。
权限：选择目标和生成`NON_FORMAL`预览需`config.export.preview`；生成正式人工搬运包或实际落盘需`config.export.commit`；浏览器目录授权不能替代服务端Capability。
验收：

- Given 选择两个目标且其中一个StoreBuy引用不存在的GoodsBasic，When 校验，Then 该目标阻止提交并精确定位store.xlsx/sheet/行/字段，另一目标显示独立结果。
- Given 一期Model没有正式Bundle，When 下载配置预览，Then 只生成标记`NON_FORMAL`的预览文件和符号引用，不出现生产文件名或有效数字ID；When 尝试提交该包，Then `commit_config_export`拒绝。
- Given 1.5期用户绑定了未列入当前权威目标目录的渠道，When 请求正式导出，Then 只能生成`NON_FORMAL`预览并提示先发布新目录、扫描Manifest和策略版本。
- Given 1.5期已有正式Bundle、权威目录、新鲜获批Manifest且通过`config.export.commit`，但治理协调器或受保护expected-old-OID CAS不可用，When 请求生成或下载正式人工搬运包，Then 返回`CONFIG_TARGET_SERIALIZATION_UNAVAILABLE`，不生成、不下载且不记录`FORMAL_PACKAGE_DOWNLOADED_NOT_APPLIED`，只允许保留`NON_FORMAL`预览。
- Given 预览后tackle.xlsx发生外部修改，When 确认提交，Then 系统返回文件冲突、保留暂存包且不覆盖三张正式表。
- Given 三张表写入到第二张失败，When 执行恢复，Then 第一张按备份恢复、第三张未写入，目标结果为失败且有完整审计。
- Given dev/1001与test/numerical同时选择且前者预检失败，When 用户保持默认继续策略，Then test/numerical仍可写入，dev/1001标记未执行。
- Given 当前Model revision未变化且已有Snapshot，When 批量准备发布与导出，Then SnapshotBatch复用原Snapshot，不创建重复版本。
- Given 新建StoreBuy，When 生成差异，Then`enabled=false`；Given 更新已有StoreBuy且未显式改变上架状态，Then保留该目标原enabled值。
