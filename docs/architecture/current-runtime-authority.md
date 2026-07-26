# 当前运行时与部署权威边界

> 状态：工程运行时权威说明；不定义产品或领域语义
> 最后对齐 v3：2026-07-26
> 实现基线：`main@d01ab1005590b41c8360c66e92693e19e8dc56ee`

本文件固定当前仓库的产品入口、包管理、构建、持久化与部署角色。发生冲突时，产品与领域语义仍以
[`../tackle-forger-development-spec-v3.md`](../tackle-forger-development-spec-v3.md) 为准；本文件只解释怎样安全运行该实现。

| 事项 | 当前唯一结论 | 禁止的替代解释 |
| --- | --- | --- |
| 产品实现 | 仓库根目录的 v3 应用（`app/`、`lib/`、`tests/`） | 不把 `apps/web` 或 `packages/*` 当作现行产品入口 |
| 包管理 | 根目录 `npm` + `package-lock.json` | 不在根目录创建 pnpm importer，也不以 pnpm 验证代替根 npm 验证 |
| 正式构建 | `npm run build`，即 `vinext build` | 不使用历史 workspace 或 `next build` 作为正式构建 |
| 正式生产 | 单实例公司内网 Dell R730 | 不把 Vercel、Cloudflare 或 OpenAI Sites 表述为正式生产 |
| 正式持久化 | R730 上显式 `sqlite` 后端与持久磁盘 | 不通过 token、binding 或临时文件系统隐式切换后端 |
| Vercel / Cloudflare / OpenAI Sites | 已退役；不再有仓库内部署或预览路径 | 不重新加入平台构建、运行时 binding 或存储分支 |
| historical pnpm workspace | 只读历史与经审计迁移边界 | 不作为新功能、日常验证或正式部署的实现目标 |

## Next.js 与 Vinext

根应用使用 Next.js App Router 与 React 的应用 API；Vinext 是其 Node/Vite 构建适配层，不是第二个产品版本。唯一部署构建是 `vinext build`，启动为 `vinext start`；不使用 `next build` 或平台专用构建器。

## 存储部署契约

存储选择必须由 `WORKSPACE_STORAGE_BACKEND` 明确声明，而不是由偶然存在的 token 或运行时 binding 推断：

| 后端 | 允许的用途 | 必需条件 |
| --- | --- | --- |
| `sqlite` | R730 正式生产与本地持久化开发 | `WORKSPACE_DATABASE_PATH` 与持久文件目录 |
| `ephemeral` | development/test | 进程内状态；生产一律拒绝 |

生产环境缺少显式后端、后端与部署目标不匹配、或路径缺失时必须 fail-closed。`@vercel/blob` 仅被一次性 Blob→SQLite 迁移脚本使用；迁移先在同目录唯一临时 SQLite 导入、执行完整回读与 `integrity_check`，再以不覆盖目标的原子发布完成。迁移不改变历史 Snapshot、未知字段或工作区身份；Blob 最多只能给出 100 条的可获得窗口，报告始终标记 `historyTruncatedOrUnknown=true`，不得声称复原已裁掉历史。

## Legacy 收敛边界

`legacy-workspace/` 只保存 pnpm workspace 元数据与锁文件；`apps/web`、`packages/*` 保留为历史取证和经审计迁移输入。历史 workspace 已退出日常 CI、合并门禁和 Agent 验证，不再承担“始终可安装、可构建”的现行维护义务。

最后一次冻结安装、typecheck、lint、test、build 的恢复证据由 annotated tag `legacy-workspace-last-green-2026-07-26` 固定，使用 Node.js 22.16.0 与 pnpm 10.33.2。恢复旧 workspace 验证、修改历史目录或重新引入相关运行路径，必须作为独立治理变更审查；不得把历史目录、迁移证据或已发布快照静默解释为现行产品。
