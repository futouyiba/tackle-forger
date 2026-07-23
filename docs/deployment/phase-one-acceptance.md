# 一期内网部署与端到端验收清单

> 状态：Issue #73 部署准备与证据采集手册；不表示真实环境已经通过
> 最后对齐 v3：2026-07-23

本清单用于 Dell R730 一期验收。它补充
[`r730-production.md`](./r730-production.md)和
[`feishu-enterprise-login.md`](./feishu-enterprise-login.md)，不改变
`docs/tackle-forger-development-spec-v3.md` 的领域与分期语义。

一期验收必须使用真实目标环境、真实公司飞书用户和权威《钓具设计工作簿》。本地测试、
mock、Vercel 评审入口和无业务写入预检都只能作为准备证据，不能替代真实环境结论。

## 1. 当前启动门禁

执行真实部署前，先刷新 GitHub 并确认以下依赖已经合入 `main`，当前头 CI、review threads
和仓库评审信号均满足：

| 依赖 | 必须证据 | 未满足时 |
| --- | --- | --- |
| #66 / PR #67 | 权威 01/02/03 机器区的拉取、展示和计算使用同一规范草稿；稳定身份、Method×Type、单位和旧引用迁移问题均解决 | 不执行真实工作簿拉取或主流程验收 |
| #68 / PR #71 | schema v17 生产形态可读取；迁移保留未知字段、离散 Series 拉力规格和冻结 Snapshot | 不把生产 SQLite 交给新代码启动 |
| #72 / PR #76 | 一期 Capability、UI、直接 API 和下载物都只允许固定 `NON_FORMAL` 预览 | 不部署到真实用户可访问环境 |
| 其他一期领域阻断 | #43 当前清单中标记为一期门槛的子项已经完成或被明确延期，理由与 v3 一致 | 只做部署准备，不创建通过结论 |

任何一项未满足都记录为 `DEPENDENCY_BLOCKED`。此状态不是代码缺陷的笼统描述，也不能用
单元测试、手工临时开关或运维承诺消除。

## 2. 证据分层

Issue #73 使用三层证据，禁止互相替代：

1. `preflight`：检查构建 commit、Node 版本、部署模板、一期依赖 commit、源码提示和可选的
   目标环境文件。源码字符串只记 `INFO`；缺失会阻断，但存在不计作通过证据。
2. `public-smoke`：以未登录身份 GET 内网入口、登录起点和受保护 API；两次登录起点会各自
   创建一条最长 600 秒的临时 pending login 记录。
3. `authenticated-read-only`：使用已经由真实用户登录得到的临时会话，只读检查会话、
   Capability、工作区、revision 和权威工作簿。
4. 人工端到端验收：由已登录用户执行显式拉取、创建 RuleSet 草稿、显式发布、创建
   Series/SKU/Model/Snapshot、错误路径、备份和回滚演练。

前三层都不会执行拉取、发布、业务工作区写入、退出登录、部署、备份、恢复或 revision
裁剪；第 2 层会创建上述自动过期的 OAuth pending 状态，不是零副作用探测。
只有第 4 层能关闭 #73 的业务验收项。

## 3. 无业务写入验收脚本

### 3.1 仓库与部署配置预检

在待部署 commit 的干净工作树运行：

```bash
npm run acceptance:phase-one -- preflight \
  --env-file /opt/tackle-forger/.env.local \
  --output /secure/evidence/phase-one-preflight.json
```

`--env-file` 可以暂时省略以只检查仓库，但结果会保持 `BLOCKED`，不能作为环境通过证据。
脚本只输出已配置的键名，不输出值；环境文件必须使用仓库外绝对路径，归服务账号所有，
是非符号链接普通文件且权限为 `0600` 或更严格。`--output` 使用“仅新建、不覆盖”语义并
创建 `0600` 文件，推荐写入受限证据目录，不要写入仓库。

预检会显式阻断：

- Node 低于 22.16.0、工作树不干净或 commit 不可解析；
- 受版本控制的 `deploy/phase-one-dependencies.json` 未把 #66/PR #67、#68/PR #71、
  #72/PR #76 分别绑定到唯一的已合入 commit，或其 review threads、必需 CI、PR 映射和
  HEAD 祖先关系不满足；源码字符串标记只作辅助提示，不能替代这项门禁；
- #66 数据链未落地；
- #68 schema v17 读取契约未落地；
- #72 `NON_FORMAL` 契约缺失，或一期仍授予 `snapshot.export`、`config.export.commit`、
  ConfigId/AI Capability；
- 回调协议/路径、会话密钥、TTL、飞书 HTTPS 基址或生产持久路径不合法；
- 权威工作簿解析后的 spreadsheet token 与服务器保存的
  `FEISHU_CANONICAL_SPREADSHEET_TOKEN` 不同；
- 环境启用 AI、revision 裁剪或可信代理身份模式；
- systemd 未限制回环监听/写目录，或 Nginx 未清除客户端身份头。

依赖满足后，在单独评审的提交中更新 `deploy/phase-one-dependencies.json`：记录固定
Issue/PR 映射、唯一完整 commit、review threads 已清零、必需 CI 已通过和已合入状态。
脚本会把实际 SHA 作为非敏感审计证据，并核对 commit 标题的 PR 来源及其为待部署 HEAD
祖先。不得用环境变量或重复填写当前 HEAD 代替依赖证据。持久路径会在规范化后检查重复/
越界，并核对数据库为普通文件、其余路径为目录、必要父目录与各路径均归服务账号所有且
不向组或其他用户开放读写/访问权限。

### 3.2 未登录 smoke（会创建短期 OAuth pending 状态）

部署完成且 Nginx/证书已生效后运行：

```bash
npm run acceptance:phase-one -- public-smoke \
  --base-url https://tackle-forger.internal.example \
  --env-file /opt/tackle-forger/.env.local \
  --output /secure/evidence/phase-one-public-smoke.json
```

检查项包括：

- 根页面可达；
- `/api/auth/session` 未登录返回 `401 / AUTH-SESSION-001`；
- 连续两次登录起点都返回配置的飞书授权来源和精确登记回调，state 非空且互不相同，
  每次响应只含一个对应 pending Cookie，值与各自 state 一致，并精确含
  `Path=/ + HttpOnly + SameSite=Lax + Secure + Max-Age=600`；
- `/api/state`、`/api/revisions`、`/api/feishu-workbook` 未登录均返回 401；
- 响应未回显环境文件中的密钥值。

若会话端点返回 `503 / AUTH-CONFIG-001`，结果是 `BLOCKED`，表示真实 OAuth 尚未配置；
不得记录为“匿名边界通过”后继续验收。

只有在已批准的 RFC 1918 数值 IPv4 降级中才能追加 `--allow-private-http`。该模式必须与
`FEISHU_ALLOW_INSECURE_HTTP=true` 和飞书登记回调 origin 一致；域名、localhost、回环地址、
IPv6 ULA 与公网 HTTP 永远拒绝。降级时还需明确记录 File System Access API 等安全上下文
能力不可用。

### 3.3 已登录只读核对

真实用户先通过浏览器完成飞书登录。若运维选择使用脚本核对，需把当前
`tf_session=<opaque-id>` 临时写入仓库外绝对路径的 `0600` 普通文件；相对路径、仓库内
文件和符号链接都会被拒绝。不要把 Cookie 放在命令参数、shell history、Issue、日志或聊天中：

```bash
npm run acceptance:phase-one -- authenticated-read-only \
  --base-url https://tackle-forger.internal.example \
  --cookie-file /run/user/<uid>/tackle-forger-session.cookie \
  --env-file /opt/tackle-forger/.env.local \
  --output /secure/evidence/phase-one-authenticated-read-only.json
```

完成后按公司的安全流程清理临时 Cookie 文件并在浏览器退出登录。清理和退出都不是脚本
自动动作，避免把只读核对伪装成有副作用的验收。

证据只保存：

- tenant key 与 open ID 的 SHA-256，不保存原值或显示名；
- 会话过期时间与 Capability 名称；
- 工作区 revision、schema、Series/SKU/Model/Snapshot 计数；
- 按 Snapshot ID/contentHash 生成的集合哈希；
- 工作簿 token 的 SHA-256、source revision、sheet_id 与工作表名称；
- HTTP 状态、响应大小和响应体哈希。

脚本不会保存 Cookie、环境值、工作簿 token、飞书用户 ID、工作区 Payload 或 Trace 正文。
发出首个携带 Cookie 的请求前，脚本会要求目标 origin 与 `FEISHU_REDIRECT_URI` 精确一致，
并要求环境提供预期 tenant key 和权威工作簿 token。已登录 PASS 还要求 tenant 精确匹配、
会话未过期、Capability 精确匹配一期允许集合、workspace schema 精确为 17，以及必需的
01–08、10 稳定 sheet_id/名称完整无重复、工作簿身份/token 匹配、所有稳定 ID 已确认且
无重复/冲突，以及品质和定价草稿没有阻断 issue 或残缺状态。

## 4. 真实部署记录

依赖全部满足后，由获授权运维人员按 `r730-production.md` 部署。Issue/验收包至少记录：

- `main` 完整 commit SHA、构建时间、Node/npm 版本和锁文件 hash；
- 只读 release 目录、`current` 切换前后目标和上一版本回滚点；
- systemd/Nginx 模板 hash、服务账号、监听地址、证书标识与到期时间；
- 环境文件权限、必要键是否存在、四类持久路径与所有权；不记录任何值；
- SQLite 文件标识/大小/只读 hash、启动前备份标识和 `PRAGMA integrity_check` 结果；
- 应用服务与每日备份 timer 状态；
- `preflight` 和 `public-smoke` 原始 JSON 证据的 SHA-256；
- 发布前门禁结果及其 GitHub URL。

不得把 `.env.local`、会话文件、OAuth code/token、Cookie、应用密钥、数据库、用户资料或
工作簿 token 原文上传 Issue、PR、日志或验收回答。

## 5. 飞书登录真实验收

使用公司租户内至少一个真实用户，在浏览器网络面板与服务端去敏操作记录中验证：

- 飞书开放平台登记回调与 `FEISHU_REDIRECT_URI` 逐字一致；
- OAuth 起点生成随机 state；回调同时匹配 pending Cookie 与 state；
- 同一 state 第二次使用被拒绝，过期 state 被拒绝；
- 非目标 tenant key 被拒绝，且不创建会话；
- 成功会话 Cookie 为 opaque ID，HTTPS 下含 `HttpOnly/Secure/SameSite=Lax/Path=/`；
- `/api/auth/session` 只返回最小身份和服务端 Capability，不返回 token；
- 会话绝对过期后返回 401；退出登录后旧会话不可复用；
- 浏览器和服务日志中没有 OAuth code、access token、应用密钥、会话 Cookie；
- 缺少任一必要登录配置的隔离启动返回 `AUTH-CONFIG-001`，不会进入匿名编辑。

测试配置缺失必须使用隔离实例或隔离进程，不修改正在验收的生产环境文件。

## 6. 权威工作簿与主流程

以下步骤会改变工作区，只有在依赖全部满足、备份已验证且用户明确进入 #73 真实验收后执行：

1. GET“检查规则工作簿”，记录本次 source revision、完整稳定 sheet_id 集合、身份报告和
   导入 Issue。工作簿 token 只进入受限验收包，Issue 只记录其哈希。
2. 点击“显式拉取”，确认只新增 `FeishuSourceRevision` 和规范规则源草稿，不发布
   RuleSetVersion，不改变任何历史 Snapshot。
3. 从该 source revision 创建 RuleSet 草稿，记录草稿 ID、内容 hash 和校验结果。
4. 显式发布 RuleSetVersion，确认页面展示、候选计算和 Trace 都引用同一 source revision、
   规则草稿内容 hash 和已发布版本。
5. 创建至少一个启用部位的 Series，明确 Method 与 Type 两层；添加至少两个离散
   `targetPullKg` SKU，确认覆盖范围不产生连续插值。
6. 为竿、轮、线各形成可验证 Model/组件链，完成硬兼容、Affinity、品质、价格与发布检查；
   不执行或验证被动技能模拟器逻辑。
7. 发布 Snapshot，保存 model/revision、RuleSetVersion、ProjectionMatch、PatchSetHash、
   Trace hash、ValidationIssue、性能摘要状态和 Snapshot contentHash。
8. 再次读取旧 Snapshot 并与发布时 Payload/hash 比较，确认上游变化只产生
   UpgradeCandidate，不改写历史 Snapshot。

若当前仍缺必需的已发布策略版本，正常行为是对应新 Snapshot fail-closed；不得临时注入
默认策略、修改旧 Snapshot 或把种子数据当作真实通过。

## 7. 错误与恢复路径

所有破坏性/冲突用例都在隔离工作区、工作簿副本或受控测试行执行，不修改权威历史记录：

- 缺稳定 ID 新行、重复 ID、非法字段或源结构缺失：拉取不切换当前可用规则；
- 拉取后源 revision 变化：旧预览提交返回冲突，要求重新检查；
- RuleSet 草稿内容 hash 或 source revision 过期：发布 fail-closed；
- schema v17 生产副本：启动读取成功，未知历史字段保留，离散 Series 规格可用，
  Snapshot Payload/contentHash 逐字节不变；
- 工作区 revision 冲突：失败方不覆盖成功方；
- 扩展部位创建/生成/发布/导出：返回“部位未启用”，历史 Payload 与引用保留；
- AI：入口与直接 API 都不可运行；
- 配置导出：只能产生 `CONFIG_PREVIEW/NON_FORMAL`，文件名为 `*.preview.xlsx` 或差异报告，
  无数字 ID/正式 `configNameKey`，`commit_config_export` 必须拒绝；
- revision：一期没有归档、retention 或 prune 定时任务；SQLite/D1 继续全量保留。

## 8. 备份与回滚演练

1. 在目标服务账号下执行 `npm run storage:backup`。
2. 校验 manifest 包含 SQLite、导入文件和可选 auth 会话目录；不读取或打印会话内容。
3. 停止隔离实例，把备份恢复到新的隔离路径，运行 SQLite 完整性检查。
4. 对比当前 WorkspaceState、revision 数、Snapshot contentHash 集合、Patch/Trace 与发布记录。
5. 代码回滚只把 `current` 切到上一只读 release 并重启；不回滚或覆盖生产 SQLite。
6. 恢复业务数据必须停服、恢复到新文件、验证后再独立切换；保留原数据库作审计副本。

演练记录开始/结束时间、操作者、备份/恢复标识、前后 hash、服务中断、结果和回退步骤。
任何恢复验证失败都保持 `BLOCKED`。

## 9. Issue #73 回填模板

Issue 回填只写去敏摘要：

```text
验收 commit:
目标环境标识:
Node / systemd / Nginx:
依赖门禁:
preflight evidence SHA-256:
public smoke evidence SHA-256:
authenticated read-only evidence SHA-256:
OAuth state/nonce/tenant/session/logout:
权威 source revision + sheet_id:
RuleSet 草稿/发布分离:
Series/SKU/Model/Snapshot:
错误与冻结:
一期关闭边界:
备份/隔离恢复/代码回滚:
仓库门禁:
阻断与风险:
```

只有真实环境所有必需项均有直接证据时才能勾选 #73。部分完成时逐项写
`PASS/BLOCKED/NOT_RUN`，不得用“整体通过”覆盖未执行项。
