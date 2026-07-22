# AUD-009 工作区 Revision 数据保留 ADR

> 状态：`ACCEPTED`
>
> 提出日期：2026-07-23
>
> 批准日期：2026-07-23
>
> 决策记录：GitHub [#1](https://github.com/futouyiba/tackle-forger/issues/1)；文档治理 [#5](https://github.com/futouyiba/tackle-forger/issues/5)
>
> 范围：SQLite/D1 的 `workspace_revisions`，并说明 Vercel Blob、列表 API、归档与备份边界
>
> 非目标：本 ADR 不修改运行时代码、不执行历史删除，也不代表归档、恢复验证或自动裁剪已经实现或获准启用

## 1. 已批准决策

当前生产目标是 Dell R730 上的 SQLite。每次成功保存都会把完整 `WorkspaceState` JSON 同时写入当前态和 `workspace_revisions`，但历史表尚无获准启用的清理能力。2026-07-23 已批准方案 C“时间 + 数量混合”，完整决定如下：

> SQLite/D1 在线保留最近 90 天的完整工作区 revision，并且无论时间如何至少保留最近 100 个。保留集合是“最近 90 天”与“最新 100 个”的并集。超出在线范围的 revision 只有在完成可验证归档后才能裁剪。Vercel Blob 明确为非权威评审存储，最多保留 100 个 revision。ConfigurationSnapshot、领域审计、Patch、Trace 和发布记录不受工作区 revision 裁剪影响，继续保持不可变和可追溯。在归档能力、恢复验证和裁剪证据完成前，禁止启用自动删除。

这项决定已经关闭“选择哪一种保留政策”的产品问题，但没有授权立即删除数据。政策与实施状态必须分开：

| 类别 | 状态 | 结论 |
| --- | --- | --- |
| 在线保留政策 | 已批准 | SQLite/D1 保留最近 90 天与最新 100 个完整 revision 的并集 |
| Blob 例外 | 已批准 | Vercel Blob 仅作非权威评审存储，最多保留 100 个 revision |
| 不可变对象边界 | 已批准 | ConfigurationSnapshot、领域审计、Patch、Trace 和发布记录不受工作区 revision 裁剪影响 |
| 自动删除 | 禁止启用 | 归档能力、恢复验证和裁剪证据未完成前必须保持关闭 |
| 归档位置与责任人 | 实施前置条件，尚未确定 | 不在本 ADR 中编造；启用裁剪前必须明确并留证 |
| 加密、访问控制与删除授权 | 实施前置条件，尚未确定 | 必须由运维、安全与审计责任边界共同确认 |
| 恢复目标、容量预算、告警阈值与维护窗口 | 实施前置条件，尚未确定 | 必须在首次裁剪和自动化启用前完成验证与批准 |

## 2. 当前实现与容量基线

| 位置 | 当前行为 | 风险/限制 |
| --- | --- | --- |
| `lib/sqlite-storage.ts` | `workspace_revisions` 每次保存一份完整 JSON，无删除；保存已在 `BEGIN IMMEDIATE` 事务中完成 | 数据库、WAL、备份持续增长 |
| `lib/sqlite-storage.ts` / `lib/storage.ts` | revision 列表 `ORDER BY revision DESC LIMIT 100` | 更早记录仍占空间，但普通界面不可发现；展示上限不是保留承诺 |
| `lib/storage.ts` Blob 路径 | 完整历史数组 `.slice(0, 100)` | 第 101 条起不可恢复；只能作为已批准的非权威评审例外 |
| `lib/storage.ts` D1 路径 | 完整历史无删除；当前更新和历史插入不是一个显式事务 | 后续实现保留政策前必须先满足等价原子性和审计要求 |
| `scripts/migrate-blob-to-sqlite.ts` | 把 Blob 中尚存的历史全部导入新 SQLite | 最多只能迁移 Blob 当时仍保存的 100 条，不能复原已裁剪历史 |
| `scripts/backup-workspace.ts` | 每日整库备份，连同导入文件与飞书会话目录；目录按 30 天删除 | 灾难恢复副本不等于长期 revision 归档，且长期保留会话副本会扩大安全风险 |

以 2026-07-23 的种子状态序列化估算，单份 JSON 为 594,961 字节，约 0.57 MiB；本地现有 SQLite 的 7 条 revision 实测平均 482,566 字节、最大 505,516 字节，revision JSON 合计约 3.38 MB。两组数据说明单份状态会随样本、Snapshot、Trace、Patch 和审计记录变化；下表采用约 0.57 MiB 作保守量级估算，SQLite 页、索引和 WAL 还会增加额外开销。

| 完整 revision 数量 | 仅 JSON 的近似体积 | 30 份同体量每日整库备份的近似上限 |
| ---: | ---: | ---: |
| 100 | 57 MiB | 1.7 GiB |
| 900 | 511 MiB | 15 GiB |
| 4,500 | 2.5 GiB | 75 GiB |

若每天保存 10 次，90 天约 900 条；每天保存 50 次，90 天约 4,500 条。永久保留的主要风险不是单次写入，而是完整状态复制、WAL、备份窗口和恢复验证时间共同线性增长。

## 3. 方案比较

| 方案 | 规则 | 优点 | 主要风险 | 操作影响 |
| --- | --- | --- | --- | --- |
| A. 永久保留 | 不删除任何完整 revision | 最强的在线追溯能力；无需定义删除边界 | 容量、备份时间和恢复时间无上限；不等于防篡改审计；删除请求和敏感数据生命周期更难处理 | 必须设置容量预算、告警、离线归档和定期恢复演练；列表仍需分页才能发现旧记录 |
| B. 固定条数 | 只保留最新 N 条，例如 100 条 | 空间上界直观；与 Blob 当前行为一致；实现简单 | 时间覆盖随写入频率剧烈变化；高频操作时可能只剩数小时/数天；会删除仍可能需要的调查证据 | 每次成功保存后事务内裁剪；首次启用前必须备份并展示待删除范围 |
| C. 时间 + 数量混合 | 保留“最近 D 天”与“最新 N 条”的并集 | 同时保证最低回退深度和最近审计窗口；低频、高频环境都比固定条数可解释 | 最近 D 天内高频写入仍可能较大；需要时钟、监控和明确的归档边界 | 需增加配置校验、归档、清理证据、容量告警和上线前 dry-run |

选择 C 是为了让操作调查窗口长于当前 30 天灾备窗口，同时避免低频环境因时间到期而失去基本回退深度。原草案提出“超过 20,000 条或数据库超过 2 GiB 时告警”作为容量讨论起点；该数值没有随政策一起获批，仍须由运维根据真实状态大小、写入频率和磁盘预算确定，且任何告警都不得自动缩短 90 天窗口或突破最新 100 个下限。

## 4. 规范保留语义

- `workspace revision` 是一次成功保存后的完整工作区操作恢复点，不是防篡改事件账本，也不是 ConfigurationSnapshot。
- SQLite/D1 的在线保留集合等于：`created_at` 位于当前 retention run 冻结 UTC cutoff 的最近 90 天内的全部 revision，与按 revision 稳定降序选出的最新 100 个 revision 的并集。
- 恰好位于 cutoff 的 revision 必须保留；时间戳无法解析、为空或位于未来时必须 fail-closed 保留并登记问题。
- 列表默认显示 100 条只是查询展示上限，不代表 SQLite/D1 的物理保留上限。精确读取、分页、总数和最旧在线时间的语义必须与保留证据一致。
- Vercel Blob 最多保留 100 个 revision，只能用于评审。它不是生产恢复、长期归档或审计权威源；Blob→SQLite 迁移不得声称找回源 Blob 已裁掉的历史。
- 超出在线并集只表示“具备裁剪候选资格”，不表示允许直接删除。每个候选必须先进入可验证归档，并满足第 5 节全部门槛。

## 5. 裁剪门槛与 fail-closed 行为

任何自动或人工裁剪都必须同时满足以下条件；任一条件缺失、非法、过期或不可验证时，不得删除任何 revision：

1. `retentionDays=90`、`minimumRevisions=100` 和策略版本通过严格配置校验；实现不得用页面默认值或回退值继续删除。
2. 归档位置、责任人、加密方式、访问审批、删除授权和恢复目标已经明确，并形成可审计的运维记录。
3. 每个候选 revision 已写入归档，归档 manifest、内容 SHA-256、数量和范围已经验证，且归档标识可以从裁剪证据反向定位。
4. 当前数据库已有独立备份，manifest 已校验，并在隔离路径完成恢复及完整性检查；备份/恢复验证标识必须写入 retention run。
5. 已执行只读 dry-run，报告冻结 cutoff、当前条数、最旧/最新 revision、候选与保留集合、异常时间戳、预计释放字节及不可变对象校验结果。
6. 首次生产裁剪已经获得明确维护窗口和删除授权；自动裁剪只有在首次裁剪及回滚演练独立验收后才能另行启用。
7. tombstone 与 retention run 能在删除前持久化；任何证据写入、归档、删除或事务提交失败都必须使本次裁剪失败且不产生无证据删除。

归档能力完成前、恢复验证失败时、备份不可验证时、策略配置非法时或裁剪证据不完整时，系统必须 fail-closed：保留全部现有 revision、产生可观测告警，并保持自动裁剪关闭。

## 6. 确定、幂等和可审计的实现约束

以下是后续实现约束，不是本 ADR 中的代码变更：

1. retention run 开始时一次性冻结 UTC cutoff、策略版本、候选输入集合和幂等键；同一输入与策略必须产生同一保留/候选集合。
2. 清理只处理同时满足以下条件的行：不属于最新 100 个；早于 90 天 cutoff；不是当前工作区 revision；已完成逐项可验证归档；没有 fail-closed 异常。
3. SQLite 保存继续使用 `BEGIN IMMEDIATE`：验证 `baseRevision`、更新当前态、插入新 revision、写入证据并按策略处理裁剪，最后统一 `COMMIT`。revision 冲突路径不得执行裁剪。D1 必须提供等价的原子性或可证明不会产生半完成状态的事务边界。
4. 每个被裁剪 revision 在删除前写入 tombstone，至少包含 revision、author、message、created_at、状态 JSON 的 SHA-256、pruned_at、策略版本、retention run ID、归档 manifest ID 和已验证备份/恢复标识。
5. retention run 至少记录幂等键、策略版本、冻结 cutoff、输入/保留/候选数量及集合哈希、异常集合、归档证据、备份恢复证据、操作者、开始/结束时间和结果。
6. 相同策略与幂等键重复运行不得重复删除、重复归档或生成重复 tombstone；部分失败重试必须先回读证据。
7. 不在每次保存中执行 `VACUUM`。WAL checkpoint、增量 vacuum 或停服维护由独立运维流程按已批准阈值触发。

示意 SQL 只表达保留候选的初步筛选，正式实现必须在 `DELETE` 前校验归档与恢复证据，并使用绑定参数：

```sql
WITH protected AS (
  SELECT revision
  FROM workspace_revisions
  ORDER BY revision DESC
  LIMIT :minimum_revisions
)
SELECT revision
FROM workspace_revisions
WHERE revision NOT IN (SELECT revision FROM protected)
  AND revision <> :current_revision
  AND julianday(created_at) IS NOT NULL
  AND julianday(created_at) < julianday(:cutoff_utc);
```

## 7. Snapshot、审计、归档与备份边界

- `workspace_revisions` 保存完整工作区的操作恢复历史。`ConfigurationSnapshot` 是 Model 发布时冻结的领域发布产物；两者身份、生命周期和删除规则不同。
- ConfigurationSnapshot、领域审计、Patch revision、Calculation Trace 和发布记录不属于 workspace revision 裁剪对象。裁剪流程不得删除、重算、重排、覆盖或改写它们，也不得改变其内容哈希、稳定引用或发布证据。
- 裁剪旧完整状态会失去“从在线 SQLite/D1 直接恢复整个工作区到该 revision”的能力。tombstone 只能证明删除范围，不能替代内容归档。
- 每日备份是灾难恢复点，不自动等于长期 revision 归档。恢复必须停服，把已验证副本恢复到新文件，并保留原数据库作审计副本；不能为查看单条历史而覆盖生产数据库。
- 当前备份把数据库、导入文件和飞书会话放在同一目录。长期归档必须与会话备份生命周期隔离，并满足已批准的加密、访问控制与不可变要求。
- 备份保留期、在线 revision 保留期和归档保留期是三个独立策略。任何一项都不得被另一项的默认值替代。

## 8. 迁移与上线顺序

1. 先完成文档治理；文档 PR 合并不等于 AUD-009 实现完成，也不授权删除。
2. 明确归档物理位置、责任人、加密与访问控制、删除授权、容量预算、告警阈值、恢复目标和维护窗口。
3. 新增顺序 SQLite/D1 storage migration，而不是改写已有 migration：建立必要索引、tombstone 表和 retention run 表。schema migration 本身不得删除历史。
4. 实现只读 dry-run、归档、manifest/hash 验证、隔离恢复与不可变对象校验；先在现有数据上报告异常时间戳和候选范围。
5. 在隔离副本执行首次裁剪和幂等重跑，验证当前状态、保留 revision、ConfigurationSnapshot hash、Patch/Trace、领域审计和精确历史读取。
6. 在明确授权的维护窗口内执行生产首次裁剪；完成 `PRAGMA integrity_check`、证据核对和回滚演练。是否 vacuum 由空间收益和停机预算单独决定。
7. 只有首次裁剪、恢复和回滚独立验收通过后，才能另行评审是否启用自动裁剪；启用前保持关闭。
8. 上线后监控 revision 总数、90 天写入速率、数据库/WAL/备份/归档体积、裁剪数量、最旧在线时间、最近成功归档和最近恢复演练时间。

## 9. 测试与验收条件

后续实现至少覆盖：

- 正常路径：90 天内全部保留，90 天外仍保留最新 100 条，其他已归档行才可裁剪并生成 tombstone/retention run。
- 边界：恰好位于 cutoff、99/100/101 条、同一时间戳、revision 非连续、数据库只有当前一条。
- 异常：非法/空白/未来 `created_at` 不被删除并可观测；非法配置、归档不可验证、备份或恢复未验证时不删除。
- 冲突与并发：过期 `baseRevision` 不插入也不裁剪；并发保存仍只有一个成功；成功 revision 永远可读取或有可验证归档证据。
- 幂等：同一策略和输入重复运行不会新增重复 tombstone、重复归档或改变保留集合。
- 冻结语义：裁剪前后当前 `WorkspaceState`、已发布 `ConfigurationSnapshot.contentHash`、Patch/Trace、领域审计和发布记录逐字节或结构一致。
- 导入：Blob 最多 100 条的边界被报告；导入不会在同一事务中静默裁剪；首次裁剪由独立确认触发。
- 列表与精确读取：普通列表默认 100 条不等于物理上限；管理员可查看总数、最旧时间和分页历史；已裁剪 revision 返回明确的策略、tombstone 和归档引用。
- 备份恢复：裁剪前备份可恢复到新 SQLite；恢复后 revision、当前状态和 Snapshot hash 一致；原数据库保持不变。
- 运维：容量/条数阈值、裁剪计数、最近成功归档、最近成功备份和最近恢复演练均可查询和告警。

## 10. 尚待实施确认的参数

以下问题不再影响保留政策的 `ACCEPTED` 状态，但会继续阻止首次裁剪和自动删除。答案必须进入后续 Issue、实现 PR、部署变更和运维证据，不得仅口头约定：

- 长期归档的物理位置、介质与不可变能力是什么？
- 归档、备份恢复、裁剪批准、生产执行和审计复核分别由谁负责？
- 使用何种加密、密钥管理、访问审批、日志和删除授权？
- 归档保留期、恢复时间目标、恢复点目标和演练频率是什么？
- 数据库、WAL、备份与归档的容量预算和告警阈值是什么？
- 首次裁剪维护窗口、审批链、观察期和自动裁剪启用标准是什么？

在这些实施前置条件及其验证证据完成前，自动删除必须保持关闭。
