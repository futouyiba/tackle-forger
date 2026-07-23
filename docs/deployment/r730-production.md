# Dell R730 内网生产部署

> 状态：生产运行手册；不定义领域语义
> 最后对齐v3：2026-07-23

本指南用于单实例内网部署。Vercel 只作为评审入口，不能替代持久磁盘、公司飞书 OAuth 凭据和真实 configs 仓库验收。

## 目录与账号

- 服务账号：`tackleforger`，禁止交互登录。
- 当前版本：`/opt/tackle-forger/current`。
- 私密环境文件：`/opt/tackle-forger/.env.local`，权限 `0600`。
- 持久数据根：`/opt/tackle-forger/data`，仅服务账号可读写。
- 从 `deploy/tackle-forger.env.example` 创建 `/opt/tackle-forger/.env.local`，不要把通用 `.env.example` 的相对 `.data/*` 路径直接用于生产。
- 将 `WORKSPACE_DATABASE_PATH`、`WORKSPACE_FILE_DATA_DIR`、`WORKSPACE_BACKUP_DIR`、`FEISHU_SESSION_DATA_DIR` 和 `AI_RETENTION_DATA_DIR` 全部指向该持久数据根内的独立目录；示例已使用 `/opt/tackle-forger/data/*` 绝对路径，与 systemd 的 `ReadWritePaths` 一致。

不要把飞书密钥、会话文件、SQLite 数据库、导入文件或 configs 凭据放入代码发布目录。

## 发布前检查

1. 使用 Node.js 22.16.0 或更新版本安装锁定依赖，并运行 `npm run typecheck`、`npm run lint`、`npm test`。备份脚本使用的 `node:sqlite` `backup()` 从 Node.js 22.16.0 起提供。
2. 运行 `npm run build`，确认 `dist` 已生成。
3. 按 `deploy/tackle-forger.env.example` 配置公司飞书应用、tenant key、回调地址、至少 32 字节会话密钥和持久目录，并确认文件权限为 `0600`。
4. 在飞书开放平台把回调逐字登记为 `https://<内网域名>/api/auth/feishu/callback`。
5. 若从 Vercel Blob 迁移，先在空目标数据库上运行 `npm run storage:migrate:blob-to-sqlite`；脚本拒绝覆盖已有数据库。

## 工作区 Revision 保留与裁剪门槛

权威政策见 v3 第 14.3 节和 [`../audits/aud-009-workspace-revision-retention-adr.md`](../audits/aud-009-workspace-revision-retention-adr.md)。本节只规定生产启用顺序，不代表当前运行时已经实现或启用了裁剪。

### 分期边界

- 一期只要求工作区主流程可运行；SQLite/D1 继续保留全部完整 revision，不实现用户归档、裁剪 migration、tombstone/retention run 或自动删除。
- 归档能力缺失不阻止一期部署和非删除业务验收。现有容量诊断与整库备份可以继续使用，但不得宣称已经完成用户归档。
- 二期归档由当前已登录工具用户主动执行，典型角色为数值策划或系统策划。优先方案是用户点击“归档”后通过浏览器保存窗口，把单一归档包写到工作 PC 自选位置。
- 正式 Chromium + HTTPS 入口优先使用 `showSaveFilePicker()` 和可写流；普通下载只作为待验证降级。用户取消、拒绝权限、写入或校验失败时，不记录成功，也不允许裁剪。
- 如果二期无法用可接受复杂度完成本机保存与恢复验证，继续保持全量在线保留和自动裁剪关闭；不为一期增加复杂后台归档系统。

### 策略配置

下列逻辑配置只在二期实现归档/裁剪时启用并严格校验。一期不要求提供这些配置键；实际键由后续实现 PR 和部署示例统一定义，本手册不预先编造环境变量名。

| 配置语义 | 生产要求 |
| --- | --- |
| 在线保留天数 | `90` |
| 最少在线完整 revision 数 | `100` |
| 保留集合 | 最近 90 天与最新 100 个的并集 |
| 自动裁剪 | 默认且当前保持关闭；完成本节全部验收后另行批准启用 |
| 归档操作者 | 当前已登录工具用户；典型为数值策划或系统策划 |
| 优先归档目标 | 用户通过保存窗口选择的工作 PC 文件；不预设服务端目录 |
| 包格式、压缩/加密和大小上限 | 二期验证并记录；不阻塞一期 |
| 恢复时间/恢复点目标、演练频率 | 启用前必须明确并完成一次隔离恢复 |
| 容量预算、告警阈值与维护窗口 | 由运维按真实负载批准，不得用隐藏默认值 |

任一配置缺失、非法、未知，或归档、备份、恢复与裁剪证据不可验证时必须 fail-closed：保留全部 revision、告警并拒绝裁剪。不得因磁盘压力自动缩短 90 天窗口或降低最新 100 个下限。

### 二期启用前只读 dry-run

在任何删除前执行只读 dry-run，并把报告作为部署变更证据保存。报告至少包含：

- 策略版本、冻结 UTC cutoff、数据库/备份标识和运行时间；
- revision 总数、最旧/最新 revision 与时间、最近 90 天集合、最新 100 个集合及两者并集；
- 候选 revision 明细、数量、状态 JSON 字节、预计可复用空间和集合哈希；
- 空白、非法或未来时间戳等 fail-closed 异常；
- 每个候选的归档 manifest、内容 SHA-256 和可恢复状态；
- 当前 `WorkspaceState`、ConfigurationSnapshot、领域审计、Patch、Trace 和发布记录的基线哈希/计数；
- 最近成功整库备份及隔离恢复验证标识。

dry-run 不得写入 tombstone、删除 revision、执行 `VACUUM` 或改变数据库/WAL。报告有异常、缺证据或无法稳定重跑时停止上线。

### 二期归档与恢复验证

1. 用户点击“归档”后立即打开浏览器保存窗口，由用户在工作 PC 上选择文件名与位置；不得先在内存生成整个大包再请求文件权限。
2. 把候选完整 revision 与 manifest/hash 流式写入单一归档包；排除飞书令牌、登录会话、应用密钥和其他凭据。
3. 完成写入并回读或等价校验 manifest，逐项核对 revision、范围、数量、内容 SHA-256、策略版本和归档文件标识。弹出保存窗口或写入完成但未校验都不算成功。
4. 执行当前数据库整库备份并校验 manifest。备份保留期不能替代归档保留期。
5. 在隔离路径恢复备份和至少一个归档 revision，运行 SQLite 完整性检查并核对当前状态、revision、Snapshot hash、Patch/Trace、领域审计与发布记录。不得覆盖生产数据库做恢复演练。
6. 保存操作者、用户选择的目标标识、恢复耗时、结果和失败处理；恢复失败时自动裁剪继续关闭。

### 二期或更晚的首次裁剪

首次生产裁剪只能在明确批准的维护窗口内以人工一次性任务执行：

1. 确认自动裁剪仍关闭，记录应用版本、数据库 hash/大小、WAL、页统计、策略版本和删除授权。
2. 重新执行 dry-run；若候选集合、数据库标识或归档证据相对批准报告发生变化，停止并重新评审。
3. 先在最新隔离副本执行相同裁剪，重复运行验证幂等，并演练停止任务、恢复到新文件和重新挂载的回滚路径。
4. 生产执行必须在删除前写入 tombstone/retention run，记录归档与备份恢复标识；任何证据写入、归档、删除、事务或回读失败都必须回滚或停止，不得留下无证据删除。
5. 完成后运行 `PRAGMA integrity_check`，重新核对保留集合、当前工作区、ConfigurationSnapshot hash、领域审计、Patch、Trace 和发布记录，并验证已裁剪 revision 返回明确的策略/tombstone/归档结果。
6. 保存实际删除数、前后体积、空闲页、WAL、告警和观察期结果。不要在保存事务内执行 `VACUUM`；空间维护使用独立批准的停服步骤。

首次裁剪、隔离恢复、回滚和观察期未完成独立验收前，不得启用定时或保存后自动裁剪。文档 PR 合并不构成启用批准。

## systemd 与反向代理

1. 将 `deploy/tackle-forger.service`、`deploy/tackle-forger-backup.service`、`deploy/tackle-forger-backup.timer`、`deploy/tackle-forger-ai-retention.service` 和 `deploy/tackle-forger-ai-retention.timer` 安装到 `/etc/systemd/system/`。
2. 将 `deploy/nginx-tackle-forger.conf.example` 复制到 Nginx 配置并替换内网域名和公司证书路径。该示例采用“浏览器 → Nginx → 应用”的直接 OAuth 拓扑，会显式清除客户端提交的 `x-feishu-*` 与 `x-tf-proxy-secret`，并保持可信代理身份模式关闭。
3. 重新加载 systemd，启用应用服务、每日备份 timer 和每小时 AI 留存 timer。首次启用 timer 前先手工运行一次 `npm run ai-retention:sweep`；任一备份删除未通过回读确认时任务以失败状态留待下次重试，不得手工把墓碑改为已清除。
4. 应用仅监听 `127.0.0.1:3000`；浏览器只能通过 HTTPS 反向代理访问。

## 验收与回滚

- 验收 `/api/auth/session` 未登录返回 401，飞书登录成功后返回当前租户身份。
- 在“飞书规则源”执行检查与显式拉取，确认 revision、sheet_id 和 Trace；不要把拉取误当发布。
- 创建一个测试 Series，确认离散拉力逐项物化 SKU，规划范围不参与生成。
- 预览 configs 三表差异，但只有登记 Profile、映射和正式 PricingPolicy 后才允许提交。
- 执行 `npm run storage:backup` 并验证 SQLite、导入文件、`auth` 会话目录、`ai-retention` 留存目录和 manifest 均存在。恢复会话目录时必须停服，保持目录仅服务账号可读写；若备份创建时尚无会话目录，manifest 的 `sessionDataIncluded` 为 `false`，恢复后用户需要重新登录。用户删除 AI 评估后，主存储立即隐藏、24 小时内清除内容；`npm run ai-retention:sweep` 会在 30 天期限到达时按 assessmentId 删除所有整库备份中的对应留存文件并回读确认，失败保持 `FAILED` 以便后续重试。
- 一期验收确认没有归档/裁剪任务且自动裁剪保持关闭；缺少归档配置不阻塞工作区主流程。
- 二期准备裁剪时再检查 retention 配置和最近 dry-run/归档/备份恢复证据；任一证据缺失时仍可继续提供不裁剪的工作区服务，但不得启用删除任务。
- 回滚代码时切换 `current` 到上一只读发布目录并重启服务；不得回滚或覆盖 SQLite。若业务数据必须恢复，只能停服后从已验证备份恢复到新文件，再保留原数据库作审计副本。
- 裁剪异常时立即禁用并停止 retention 任务，保留当前数据库、WAL、归档、tombstone、retention run 和日志。不要原地拼接或覆盖生产库；在新文件恢复已验证备份/归档，校验完整性和不可变对象后再通过独立变更切换。
- 如果自动裁剪已经启用但归档、备份、恢复目标、责任人、加密或访问控制后来失效，必须自动回到 fail-closed 状态；恢复自动化需要新的验证与批准，不能只重启任务。
