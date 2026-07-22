# Dell R730 内网生产部署

> 状态：生产运行手册；不定义领域语义
> 最后对齐v3：2026-07-22

本指南用于单实例内网部署。Vercel 只作为评审入口，不能替代持久磁盘、公司飞书 OAuth 凭据和真实 configs 仓库验收。

## 目录与账号

- 服务账号：`tackleforger`，禁止交互登录。
- 当前版本：`/opt/tackle-forger/current`。
- 私密环境文件：`/opt/tackle-forger/.env.local`，权限 `0600`。
- 持久数据根：`/opt/tackle-forger/data`，仅服务账号可读写。
- 从 `deploy/tackle-forger.env.example` 创建 `/opt/tackle-forger/.env.local`，不要把通用 `.env.example` 的相对 `.data/*` 路径直接用于生产。
- 将 `WORKSPACE_DATABASE_PATH`、`WORKSPACE_FILE_DATA_DIR`、`WORKSPACE_BACKUP_DIR` 和 `FEISHU_SESSION_DATA_DIR` 全部指向该持久数据根内的独立目录；示例已使用 `/opt/tackle-forger/data/*` 绝对路径，与 systemd 的 `ReadWritePaths` 一致。

不要把飞书密钥、会话文件、SQLite 数据库、导入文件或 configs 凭据放入代码发布目录。

## 发布前检查

1. 使用 Node.js 22.16.0 或更新版本安装锁定依赖，并运行 `npm run typecheck`、`npm run lint`、`npm test`。备份脚本使用的 `node:sqlite` `backup()` 从 Node.js 22.16.0 起提供。
2. 运行 `npm run build`，确认 `dist` 已生成。
3. 按 `deploy/tackle-forger.env.example` 配置公司飞书应用、tenant key、回调地址、至少 32 字节会话密钥和持久目录，并确认文件权限为 `0600`。
4. 在飞书开放平台把回调逐字登记为 `https://<内网域名>/api/auth/feishu/callback`。
5. 若从 Vercel Blob 迁移，先在空目标数据库上运行 `npm run storage:migrate:blob-to-sqlite`；脚本拒绝覆盖已有数据库。

## systemd 与反向代理

1. 将 `deploy/tackle-forger.service`、`deploy/tackle-forger-backup.service`、`deploy/tackle-forger-backup.timer` 安装到 `/etc/systemd/system/`。
2. 将 `deploy/nginx-tackle-forger.conf.example` 复制到 Nginx 配置并替换内网域名和公司证书路径。该示例采用“浏览器 → Nginx → 应用”的直接 OAuth 拓扑，会显式清除客户端提交的 `x-feishu-*` 与 `x-tf-proxy-secret`，并保持可信代理身份模式关闭。
3. 重新加载 systemd，启用应用服务和每日备份 timer。
4. 应用仅监听 `127.0.0.1:3000`；浏览器只能通过 HTTPS 反向代理访问。

## 验收与回滚

- 验收 `/api/auth/session` 未登录返回 401，飞书登录成功后返回当前租户身份。
- 在“飞书规则源”执行检查与显式拉取，确认 revision、sheet_id 和 Trace；不要把拉取误当发布。
- 创建一个测试 Series，确认离散拉力逐项物化 SKU，规划范围不参与生成。
- 预览 configs 三表差异，但只有登记 Profile、映射和正式 PricingPolicy 后才允许提交。
- 执行 `npm run storage:backup` 并验证 SQLite、导入文件、`auth` 会话目录和 manifest 均存在。恢复会话目录时必须停服，保持目录仅服务账号可读写；若备份创建时尚无会话目录，manifest 的 `sessionDataIncluded` 为 `false`，恢复后用户需要重新登录。
- 回滚代码时切换 `current` 到上一只读发布目录并重启服务；不得回滚或覆盖 SQLite。若业务数据必须恢复，只能停服后从已验证备份恢复到新文件，再保留原数据库作审计副本。
