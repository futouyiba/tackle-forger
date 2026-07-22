# 飞书企业登录部署

Tackle Forger 直接使用飞书网页 OAuth，不依赖 `FEISHU_LOGIN_URL` 或浏览器提交的身份头。

## 飞书开放平台

1. 创建或选择公司租户内的企业自建应用，并启用网页应用能力。
2. 安全重定向 URL 必须逐字登记为 `FEISHU_REDIRECT_URI`。默认使用：
   `https://<内网域名>/api/auth/feishu/callback`。仅在无 HTTPS 的受控私网中，可显式设置
   `FEISHU_ALLOW_INSECURE_HTTP=true` 并使用 RFC 1918 私网 IP 回调，例如
   `http://192.168.1.157/api/auth/feishu/callback`；公网 HTTP 地址始终拒绝。
3. 只开通基础登录资料所需的最小权限。当前实现不持久化或刷新用户 token，不申请
   `offline_access`。
4. 将目标公司的 tenant key 配置为 `FEISHU_TENANT_KEY`；邮箱和手机号不用于登录或租户判断。

## 服务器环境

按 `.env.example` 配置：

- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；
- `FEISHU_TENANT_KEY`；
- `FEISHU_REDIRECT_URI`；
- 私网 HTTP 例外开关 `FEISHU_ALLOW_INSECURE_HTTP`（默认关闭）；
- 至少 32 字节高熵的 `FEISHU_SESSION_SECRET`；
- `FEISHU_SESSION_TTL_SECONDS`；
- `FEISHU_OPEN_API_BASE_URL`、`FEISHU_ACCOUNTS_BASE_URL`；
- 最小权限集合 `FEISHU_OAUTH_SCOPES`；
- 持久磁盘目录 `FEISHU_SESSION_DATA_DIR`。

会话目录只允许服务账号读写，必须位于 Dell R730 的持久磁盘并纳入备份，不得提交仓库。
会话 Cookie `tf_session` 只包含不可猜测的 opaque ID；HTTPS 环境属性为 HttpOnly、Secure、
SameSite=Lax、Path=/。显式私网 HTTP 模式下不设置 Secure，但仍保留 HttpOnly 与 SameSite=Lax。
服务端文件只保存 ID 的 HMAC、最小用户资料和绝对过期时间。
OAuth access/refresh token 不落盘、不返回浏览器，也不进入日志、AI 上下文或导出文件。

## 可选可信代理模式

默认 `FEISHU_TRUST_PROXY_HEADERS=false`，任何 `x-feishu-*` 头都不会授予身份。如确需兼容
公司身份网关，必须同时：

1. 设置 `FEISHU_TRUST_PROXY_HEADERS=true` 和 `FEISHU_PROXY_SHARED_SECRET`；
2. 禁止浏览器绕过网关直达源站；
3. 网关剥离客户端提交的 `x-feishu-*` 与 `x-tf-proxy-secret`，再写入已验证身份和共享校验头；
4. 限制源站网络边界，并定期轮换共享密钥。
