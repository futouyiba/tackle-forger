# AUD-009 工作区 Revision 数据保留 ADR（草案）

> 状态：`PROPOSED`，等待产品/运维/审计责任人确认
>
> 日期：2026-07-23
>
> 范围：R730 SQLite 的 `workspace_revisions`，并说明 Blob、D1、列表 API 与备份的边界
>
> 非目标：本草案不修改运行时代码、不执行历史删除，也不代表最终保留政策已经获批

## 1. 待决策事项

当前生产目标是 Dell R730 上的 SQLite。每次成功保存都会把完整 `WorkspaceState` JSON 同时写入当前态和 `workspace_revisions`，但历史表没有清理策略。与此同时：

- SQLite 与 D1 的列表查询只显示最近 100 条，但按 revision 精确读取仍可访问数据库中更早的记录；因此“列表 100 条”只是展示上限，不是保留承诺。
- Vercel Blob 文档在每次保存时直接把完整历史裁为最近 100 条；这是物理保留上限。
- `WorkspaceState.revisions` 只保存最近 100 条摘要，它不是完整历史副本。
- 每日备份复制完整 SQLite、导入文件和飞书会话目录，默认只保留 30 天；备份是灾难恢复副本，不是可在线查询的不可变审计库。

需要由责任人决定：R730 的完整工作区历史是永久审计记录，还是有期限的操作恢复记录；Vercel 评审环境是否可以继续只保留 100 条；若需要超过在线保留期的审计证据，由谁维护独立、加密且不可变的归档。

## 2. 当前实现与容量基线

| 位置 | 当前行为 | 风险/限制 |
| --- | --- | --- |
| `lib/sqlite-storage.ts` | `workspace_revisions` 每次保存一份完整 JSON，无删除；保存已在 `BEGIN IMMEDIATE` 事务中完成 | 数据库、WAL、备份持续增长 |
| `lib/sqlite-storage.ts` / `lib/storage.ts` | revision 列表 `ORDER BY revision DESC LIMIT 100` | 更早记录仍占空间，但普通界面不可发现 |
| `lib/storage.ts` Blob 路径 | 完整历史数组 `.slice(0, 100)` | 第 101 条起不可恢复，与 SQLite 语义不同 |
| `lib/storage.ts` D1 路径 | 完整历史无删除；当前更新和历史插入不是一个显式事务 | 与 SQLite 一样无界，且后续实现清理时必须先保证原子性 |
| `scripts/migrate-blob-to-sqlite.ts` | 把 Blob 中尚存的历史全部导入新 SQLite | 最多只能迁移 Blob 当时仍保存的 100 条，不能复原已裁剪历史 |
| `scripts/backup-workspace.ts` | 每日整库备份，连同导入文件与会话目录；目录按 30 天删除 | 空间消耗约为“活跃数据库体积 × 保留份数”，且长期保留会话副本会扩大安全风险 |

以2026-07-23的种子状态序列化估算，单份JSON为594,961字节，约0.57 MiB；本地现有SQLite的7条revision实测平均482,566字节、最大505,516字节，revision JSON合计约3.38 MB。两组数据说明单份状态会随样本、Snapshot、Trace、Patch和审计记录变化；下表采用约0.57 MiB作保守量级估算，SQLite页、索引和WAL还会增加额外开销。

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
| C. 时间 + 数量混合 | 保留“最近 D 天”与“最新 N 条”的并集 | 同时保证最低回退深度和最近审计窗口；低频、高频环境都比固定条数可解释 | 最近 D 天内高频写入仍可能较大；需要时钟、监控和明确的归档边界 | 事务内裁剪较简单；需增加配置校验、清理证据、容量告警和上线前 dry-run |

## 4. 建议默认值（等待批准）

建议把方案 C 作为 R730 默认候选：

- `retentionDays = 90`
- `minimumRevisions = 100`
- 保留集合为“`created_at` 在最近 90 天内，或属于最新 100 个 revision”的并集。
- 第一阶段不设置静默硬上限；当完整历史超过 20,000 条或数据库超过 2 GiB 时告警，但不得自动缩短 90 天窗口。由运维评估实际状态大小、写入频率和磁盘预算后再提策略变更。

选择 90 天是为了让操作调查窗口长于当前 30 天灾备窗口；保留至少 100 条可避免低频环境因为时间到期而失去基本回退深度。它不是合规结论。如果公司要求永久或一年以上审计，应选择方案 A，或在任何裁剪前建设独立的数据库状态归档；不能把当前 30 天、包含登录会话的整包备份直接延长成长期审计库。

Vercel Blob 仅作为评审入口时，建议明确记录其“最多 100 条、非审计权威源”的例外。若未来把 Blob/D1 提升为正式生产后端，则必须先实现与获批政策等价的保留和归档能力，不能继续依赖 `.slice(0, 100)`。

## 5. 建议的事务内清理算法

以下是实现约束，不是本草案中的代码变更。

1. 启动时验证 `retentionDays` 和 `minimumRevisions` 为正整数；配置缺失或非法时不删除任何历史，并产生可观测告警。
2. 首次启用前执行只读 dry-run，报告当前条数、最旧/最新 revision、预计删除条数、预计释放的 JSON 字节和异常时间戳；由管理员确认已经存在可恢复的整库备份。
3. 每次 SQLite 保存继续使用 `BEGIN IMMEDIATE`：先验证 `baseRevision`，更新 `workspace_state`，插入新的完整 revision，再执行清理，最后统一 `COMMIT`。
4. 清理只删除同时满足以下条件的行：不属于按 revision 降序的最新 N 条；`created_at` 可解析且早于 UTC cutoff；不是当前 `workspace_state.revision`。
5. 任何更新、插入、清理或清理证据写入失败都回滚整次保存。revision 冲突路径不得执行清理。
6. 对无法解析、为空或位于未来的历史时间戳采取 fail-closed：保留该行并登记待复核，不猜测时间后删除。
7. 在同一事务内为每个被裁剪 revision 保留小型 tombstone：revision、author、message、created_at、状态 JSON 的 SHA-256、pruned_at、策略版本和最近一次已验证备份标识。tombstone 不能宣称可恢复内容，但能证明发生过受策略控制的删除。
8. 不在每次保存中执行 `VACUUM`。删除只让页可复用；WAL checkpoint、增量 vacuum 或停服维护应由独立运维任务按数据库体积和空闲页比例触发。

示意 SQL 语义如下，正式实现需使用绑定参数，并把 tombstone 写入放在 `DELETE` 之前：

```sql
WITH protected AS (
  SELECT revision
  FROM workspace_revisions
  ORDER BY revision DESC
  LIMIT :minimum_revisions
)
DELETE FROM workspace_revisions
WHERE revision NOT IN (SELECT revision FROM protected)
  AND revision <> :current_revision
  AND julianday(created_at) IS NOT NULL
  AND julianday(created_at) < julianday(:cutoff_utc);
```

## 6. 审计、Snapshot 与备份边界

- `workspace_revisions` 是完整工作区的操作恢复历史；它不是防篡改事件账本。领域审计、Patch revision、Trace、发布记录和 `ConfigurationSnapshot` 仍保存在当前工作区中，不得因存储层裁剪而删除、重算或改写。
- 裁剪旧完整状态会失去“把整个工作区恢复到该 revision”的在线能力。tombstone 只能证明删除范围，不能替代内容归档。
- 每日备份是灾难恢复点。恢复必须停服，把已验证副本恢复到新文件，并保留原数据库作审计副本；不能为查看单条历史而覆盖生产数据库。
- 当前备份把数据库、导入文件和飞书会话放在同一目录。若需要长期审计归档，应新增“数据库-only、加密、访问受控、不可变”的独立层，不应延长登录会话副本的生命周期。
- 启用第一次裁剪前至少完成一次整库备份、校验 manifest、在隔离路径恢复并运行完整性检查。备份标识应写入 retention run 记录。
- 备份保留期与在线 revision 保留期是两个独立参数；两者都必须记录责任人、磁盘预算、恢复时间目标和删除授权。

## 7. 迁移与上线建议

1. 先确认本 ADR 的选项、默认值、Blob 例外和长期归档责任人；`AUD-009` 在确认前保持 `BLOCKED`。
2. 新增 SQLite storage migration，而不是改写已有 migration 1：建立 `created_at`/revision 索引、tombstone 表和 retention run 表。schema 迁移本身不删除历史。
3. 读取现有行并生成 dry-run 报告；异常时间戳进入复核集合。记录当前数据库 hash、文件大小、页数、空闲页数和备份标识。
4. 在隔离副本上执行第一次清理，验证当前状态、保留 revision、Snapshot hash 和精确历史读取，再评估实际释放空间。
5. 维护窗口内对生产库执行已批准的首次清理。清理后运行 `PRAGMA integrity_check`；是否 vacuum 由空间收益和停机预算单独决定。
6. 上线后监控 revision 总数、90 天写入速率、数据库/WAL/备份体积、清理数量、最旧在线时间和最近恢复演练时间。
7. Blob→SQLite 迁移报告必须明确“源 Blob 只提供当时尚存的最多 100 条”；不能把迁移成功表述成找回更早历史。

## 8. 测试与验收条件

实现获批策略时至少覆盖：

- 正常路径：90 天内全部保留，90 天外仍保留最新 100 条，其他行被裁剪并生成 tombstone/retention run。
- 边界：恰好位于 cutoff、99/100/101 条、同一时间戳、revision 非连续、数据库只有当前一条。
- 异常：非法/空白/未来 `created_at` 不被删除并可观测；非法配置不删除；清理 SQL 失败使保存整体回滚。
- 冲突与并发：过期 `baseRevision` 不插入也不清理；并发保存仍只有一个成功；成功 revision 永远可读取。
- 幂等：同一策略重复运行不会新增重复 tombstone，也不会改变保留集合。
- 冻结语义：清理前后当前 `WorkspaceState`、已发布 `ConfigurationSnapshot.contentHash`、Patch/Trace 与领域审计逐字节或结构一致。
- 导入：Blob 最多 100 条的边界被报告；导入不会在同一事务中静默裁剪；首次清理由独立确认触发。
- 列表与精确读取：普通列表默认 100 条不等于物理上限；管理员可查看总数、最旧时间和分页历史；已裁剪 revision 返回明确的“按策略删除”而非“不存在/损坏”。
- 备份恢复：裁剪前备份可恢复到新 SQLite；恢复后 revision、当前状态和 Snapshot hash 一致；原数据库保持不变。
- 运维：容量/条数阈值告警、清理计数、最近成功备份和最近恢复演练均可查询。

## 9. 需要责任人确认

- 是否批准方案 C，以及 `90 天 + 至少 100 条`的候选默认值？
- Vercel Blob 是否确认只作非权威评审环境，并接受最多 100 条历史？
- 是否存在法规、劳动、人事、安全或公司审计要求，需要永久/一年以上保存完整状态？
- 若需要长期归档，存储位置、加密、访问审批、删除授权和恢复责任人是谁？
- 首次清理可接受的维护窗口、数据库空间预算、告警阈值和恢复时间目标是多少？

在这些问题被明确回答前，不应启用任何自动删除。
