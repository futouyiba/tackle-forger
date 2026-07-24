# 本机已认证 worktree 启动

> 状态：本机开发与真实 Chrome 验收运行手册；不替代 v3 的身份、会话或领域契约。
> 最后对齐 v3：2026-07-24

本流程让不同 worktree 的 Agent 能安全复用同一台开发机上的飞书 OAuth 配置，而不复制、读取或提交任何凭据。它只用于本机验收，不构成部署配置，也不能代替内网生产验收。

## 1. 安全准备

共享凭据的唯一位置是：

```text
/Users/songfu/.config/tackle-forger/.env.local
```

目录权限必须为 `700`，文件权限必须为 `600`。每个 worktree 只保留一个指向该文件的忽略软链接；不要复制文件内容。

在目标 worktree 根目录先做只读确认：

```sh
test -L .env.local && readlink .env.local
```

若目标不存在 `.env.local`，才可创建链接：

```sh
ln -s /Users/songfu/.config/tackle-forger/.env.local /path/to/worktree/.env.local
```

若目标已经是普通文件或指向其他位置的链接，先停止；必须由用户明确授权迁移、替换或保留。不得读取、回显、提交、复制或截图 `.env.local` 的值。

## 2. 启动当前 worktree

从目标 worktree 根目录启动，并使用飞书开放平台已逐字登记在 `FEISHU_REDIRECT_URI` 中的端口。当前本机验收常用端口为 `43198`；端口不是通用默认值，变更端口前必须先更新已登记回调。

```sh
NODE_ENV=development node --env-file=.env.local node_modules/vinext/dist/cli.js start --hostname 127.0.0.1 --port 43198
```

只使用 `http://127.0.0.1:<port>`，不要改为 `localhost`、其他 `127/8` 地址、IPv6 或公网 HTTP。严格本机开发例外还要求共享环境中已经显式启用 `FEISHU_ALLOW_INSECURE_HTTP=true`；Agent 只检查运行结果，不应读取或打印该文件来确认其值。

端口已被占用时，先只读识别监听进程：

```sh
lsof -nP -iTCP:43198 -sTCP:LISTEN
```

仅在确认该进程就是当前任务先前启动的本机服务后，才停止它；不要杀掉其他 worktree 或用户的服务。若改用其他端口，必须先完成回调登记，不要临时绕过 OAuth 边界。

## 3. Chrome 验收

在真实 Chrome 中访问：

```text
http://127.0.0.1:43198/
```

页面显示 `AUTH-SESSION-001` 时，表示会话不存在或已过期：由用户在 Chrome 点击“使用飞书登录”完成正常登录，再继续验收。不要创建测试身份、伪造 Cookie、注入 session 或绕过认证。

页面显示 `AUTH-CONFIG-001` 时，表示 OAuth 运行配置不完整或不合规：验收应记为阻断。不要用匿名编辑、fixture、假 Trace 或跳过登录替代真实页面；由具备凭据管理权限的人检查共享环境文件和飞书开放平台的回调登记。

不同 worktree 可以共享凭据，但不保证共享浏览器会话：会话是否可复用取决于安全会话目录与有效期。每次启动后都先通过页面状态确认，不检查 Cookie、Local Storage 或凭据文件内容。

## 4. 面向 Agent 的边界

- 自动化测试使用独立临时数据库路径，不能把测试种子当作真实 UI 验收数据。
- 真实 UI 验收使用已认证页面和已有真实领域数据；没有已冻结的目标状态时，明确记录证据缺口，不创建或篡改业务数据来凑截图。
- 结束后保留用户需要继续操作的 Chrome 页面；本机服务只在确认没有其他 worktree 使用它时停止。
- 生产、内网 HTTP 降级、会话持久化与代理模式仍遵循[`../deployment/feishu-enterprise-login.md`](../deployment/feishu-enterprise-login.md)和 v3 §25，不能由本机流程放宽。
