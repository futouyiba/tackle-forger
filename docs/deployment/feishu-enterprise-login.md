# 飞书企业登录部署

> 状态：可选飞书身份与会话运行手册；不替代 Capability 契约
> 最后对齐v3：2026-07-27

Tackle Forger 的内网本地会话无需登录。飞书网页 OAuth 是共享工作区、飞书规则源和其他共享/外部动作的可选身份通道；不依赖 `FEISHU_LOGIN_URL` 或浏览器提交的身份头。匿名本地会话不得读取、保存或伪造共享工作区，完整边界以 v3 §20.2.1 与 §25.1 为准。

## 三种鉴权路径

| 场景 | 身份方式 | 会话存储 | 说明 |
| --- | --- | --- | --- |
| **自动化测试** | 受密钥保护的 trusted-proxy fixture（`x-tf-proxy-secret` + `x-feishu-*`） | 临时目录（`mkdtemp`），测试后自动清理 | 不访问真实飞书网络、不要求真人 OAuth；通过 `FEISHU_TRUST_PROXY_HEADERS=true` 和共享密钥启用。该通道默认关闭、**非测试专用**——显式配置共享密钥的受控内网代理部署同样使用它（见「可选可信代理模式」），只是测试用 fixture 复用了同一路径 |
| **人工 worktree 开发验收** | 真实飞书 OAuth 重定向 | 按 worktree+端口隔离的 `.data/auth-<worktreeName>-<port>`，由 `scripts/start-dev.ps1` 自动推导 | 每个 worktree 有独立会话文件，不互相污染 |
| **R730 正式生产（启用共享功能时）** | 真实飞书 OAuth 重定向、HTTPS 代理 | 持久磁盘显式路径（`/opt/tackle-forger/data/auth`），由 systemd `EnvironmentFile` 设置 | 包含在 `npm run storage:backup` 的 auth 目录中；不可被开发脚本改写。纯本地会话部署不需要此路径 |

## 自动化测试专用 fixture

测试使用 `tests/auth-test-helpers.ts` 中封装的 trusted-proxy 模式验证
鉴权逻辑：

- `useTemporaryAuthDir()` —— 创建临时会话目录并设置 `FEISHU_SESSION_DATA_DIR`；
- `trustedProxyHeaders()` / `createMockAuthRequest()` —— 构造携带模拟身份头的请求；
- `withTrustedProxyEnvironment()` —— 设置 `FEISHU_TRUST_PROXY_HEADERS=true` 等环境变量。

测试不访问真实飞书网络，不依赖预先完成的浏览器 OAuth，且 `FEISHU_TRUST_PROXY_HEADERS`
在生产部署中默认关闭，确保 fail-closed。

## worktree 开发隔离

多个 `git worktree` 并行开发时，`scripts/start-dev.ps1` 检测当前目录是否为
linked worktree（`.git` 是文件而非目录），提取 worktree 名称，并为每个
`worktree + 端口` 生成独立的会话目录：

```
.data/auth-<worktreeName>-<port>/
```

- 该路径已包含在 `.gitignore` 的 `.data/` 规则中。
- 若终端环境已显式设置 `FEISHU_SESSION_DATA_DIR`，脚本不做改写。
- 生产部署路径（如 `/opt/tackle-forger/data/auth`）不会被脚本触及。

关于真实 OAuth 回调的端口限制：

> 飞书开放平台登记的 `FEISHU_REDIRECT_URI` 必须与回调 URL 逐字相等。
> 每个 worktree 开发服务器运行在不同端口，因此回调 URL 中的端口也必须匹配。
> 例如 worktree A 使用 `http://127.0.0.1:3000/api/auth/feishu/callback`，
> worktree B 使用 `http://127.0.0.1:3001/api/auth/feishu/callback`。
> 每个开发者需在飞书开放平台为自己的开发环境登记对应的回调地址（或使用单独的应用）。
> 本机开发使用 `127.0.0.1` loopback 例外需要 `NODE_ENV=development` 且
> `FEISHU_ALLOW_INSECURE_HTTP=true`；公网 HTTP 始终拒绝。

## 飞书开放平台

1. 创建或选择公司租户内的企业自建应用，并启用网页应用能力。
2. 安全重定向 URL 必须逐字登记为 `FEISHU_REDIRECT_URI`。默认使用：
   `https://<内网域名>/api/auth/feishu/callback`。仅在无 HTTPS 的受控私网中，可显式设置
   `FEISHU_ALLOW_INSECURE_HTTP=true` 并使用 RFC 1918 私网 IP 回调，例如
   `http://192.168.1.157/api/auth/feishu/callback`；公网 HTTP 地址始终拒绝。仅供本机开发，且同时
   设置`NODE_ENV=development`与`FEISHU_ALLOW_INSECURE_HTTP=true`时，也可登记数值 IPv4
   `http://127.0.0.1[:port]/api/auth/feishu/callback`。该例外不接受`localhost`、其他回环地址或
   IPv6，且生产、测试和部署环境一律拒绝。
3. 只开通基础登录资料所需的最小权限。当前实现不持久化或刷新用户 token，不申请
   `offline_access`。
4. 将目标公司的 tenant key 配置为 `FEISHU_TENANT_KEY`；邮箱和手机号不用于登录或租户判断。

## 服务器环境

按 `.env.example` 配置：

- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；
- `FEISHU_TENANT_KEY`；
- `FEISHU_REDIRECT_URI`；
- 私网 HTTP 例外开关 `FEISHU_ALLOW_INSECURE_HTTP`（默认关闭；本机开发的`127.0.0.1`例外也必须开启）；
- 至少 32 字节高熵的 `FEISHU_SESSION_SECRET`；
- `FEISHU_SESSION_TTL_SECONDS`；
- `FEISHU_OPEN_API_BASE_URL`、`FEISHU_ACCOUNTS_BASE_URL`；
- 最小权限集合 `FEISHU_OAUTH_SCOPES`；
- 持久磁盘目录 `FEISHU_SESSION_DATA_DIR`。

会话目录只允许服务账号读写，必须位于 Dell R730 的持久磁盘并纳入 `npm run storage:backup` 的 `auth` 目录，不得提交仓库。会话恢复必须停服进行；没有可用会话备份时，恢复后的预期行为是所有用户重新登录。
会话 Cookie `tf_session` 只包含不可猜测的 opaque ID；HTTPS 环境属性为 HttpOnly、Secure、
SameSite=Lax、Path=/。显式私网 HTTP 或严格本机开发 loopback 模式下不设置 Secure，但仍保留
HttpOnly 与 SameSite=Lax；本机 loopback 不是生产部署拓扑。
服务端文件只保存 ID 的 HMAC、最小用户资料和绝对过期时间。
OAuth access/refresh token 不落盘、不返回浏览器，也不进入日志、AI 上下文或导出文件。

## 工作区身份与登录后初始化

通过 OAuth 取得公司身份后，服务端才读取共享工作区。新部署默认从`FEISHU_TENANT_KEY`派生工作区身份；已有工作区迁入时，部署管理员可以在私密环境文件中一次性设置`TACKLE_FORGER_WORKSPACE_ID`为该工作区**已经保存的**稳定 ID。不得修改 SQLite/Blob 中的历史 payload，也不得用另一个 tenant 值绕过身份错配。

若登录成功但工作区无法读取，页面会显示`WORKSPACE-IDENTITY-001`（部署身份与历史工作区不一致）或`WORKSPACE-SERVICE-001`（工作区服务暂不可用），而不是把该状态伪装成 OAuth 失败。前者应由部署管理员核对私密环境配置和持久化工作区来源；修复后使用“重新检查”。错误响应和浏览器诊断不包含 tenant、工作区 ID、会话或凭据值。

## 可选可信代理模式

默认 `FEISHU_TRUST_PROXY_HEADERS=false`，任何 `x-feishu-*` 头都不会授予身份。如确需兼容
公司身份网关，必须同时：

1. 设置 `FEISHU_TRUST_PROXY_HEADERS=true` 和 `FEISHU_PROXY_SHARED_SECRET`；
2. 禁止浏览器绕过网关直达源站；
3. 网关剥离客户端提交的 `x-feishu-*` 与 `x-tf-proxy-secret`，再写入已验证身份和共享校验头；
4. 限制源站网络边界，并定期轮换共享密钥。
