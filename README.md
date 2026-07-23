# 钓具配置工坊

面向淡水路亚杆、轮、线装备的团队配置工作台。

## 能力

- 重量模板与动态参数管理
- 类型、材质、功能、性能、技术和系列规则矩阵
- 有类型的规则 DAG，支持条件分支、汇合、手动节点、人工审阅中间表和完整执行轨迹
- 节点内部保留可排序规则栈，支持加、乘、覆盖、上下限和安全公式
- 直接属性词条与被动机制词条
- 有损相加、协同与冲突驱动的品质评分
- 系列配方、受约束候选生成、批量筛选、对比和精调
- 正式组合 SKU 及杆、轮、线明细
- 强度闭环、重量段覆盖校验和精调规则学习
- D1 团队共享状态、版本记录与冲突保护
- R2 保存 Excel 原始导入文件
- Excel 完整导入导出

## 规则执行模型

规则编排采用有向无环图（DAG）：图负责表达依赖、分支、汇合和人工关卡；每条实际执行路径仍按拓扑顺序确定执行。自动、手动和混合三种模式共用同一套执行引擎，中间结果以快照进入可编辑审阅表，批准后才继续流向下游。

## 本地验证

仓库根目录的v3应用是当前权威实现，使用`package-lock.json`和npm验证：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
```

`apps/web`与`packages/*`是历史pnpm workspace，使用独立锁文件和门禁，不得用pnpm安装隐式替代根应用的npm验证：

```powershell
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build
```

GitHub Actions分别运行上述两套作业；修改任一架构时都不能以另一套门禁通过代替本套验证。

## 本地启动

Windows 推荐使用项目自带脚本，避免把重定向字符串误当成程序名：

```powershell
.\scripts\start-dev.ps1 -Port 3000
```

需要在当前窗口直接查看开发日志时，追加 `-Foreground`。

生产构建由 Vinext 生成。正式目标环境是公司内网 Dell R730；Vercel 地址仅作为评审入口，
不能替代内网持久磁盘、公司飞书凭据和真实配置仓库验收。
完整安装、systemd、Nginx、备份与回滚步骤见 `docs/deployment/r730-production.md`。

## 公司飞书登录

应用不提供匿名编辑或离线冒名提交。飞书 OAuth 仅接受配置的公司租户；未登录返回 401，
已登录但动作能力不足返回 403 和服务端 `ActionAvailability`。登录失败显示稳定错误编号、
重试与管理员入口；会话过期时浏览器暂存未保存草稿，重登后仅在团队 revision 未变化时
自动恢复，否则提供冲突草稿下载。

生产环境必须配置 `.env.example` 中的 OAuth、租户、会话密钥和支持入口。OAuth token、
应用密钥不得进入前端、日志、导出包或 AI 输入。`FEISHU_SESSION_DATA_DIR` 必须指向受备份
保护、仅服务账号可读写的持久磁盘；Vercel 临时文件系统不能作为正式会话存储。

## 唯一飞书规则工作簿

唯一规则源是整本工作簿：

<https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh?from=from_copylink&sheet=9nE3Rx>

链接中的 `sheet=9nE3Rx` 只负责打开时定位到 `06_系列`，同步边界仍是 00–17 整本工作簿。
接入器按 v3 第 14 节登记的 `sheet_id` 定位并校验期望名称；改名只告警，同名新表不会冒充
原表。revision 必须实时读取；2302 与 2352 都只是历史观察值，禁止硬编码为“最新”。

`01_重量模板` 至 `06_系列` 当前已有 176 个稳定机器 ID。已绑定 ID 必须保留；未来缺 ID
的新行进入 `NEW_SOURCE_ROW`，经过迁移预览、人工确认、回写和回读验证后才建立绑定。
检查、显式拉取、创建 `RuleSetVersion` 草稿、ID 回写和正式发布始终是彼此独立的动作。

飞书应用凭证只配置在服务器环境中：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_OPEN_API_BASE_URL=https://open.feishu.cn
```

应用需要电子表格读写权限，并能访问该工作簿。拉取只登记 `FeishuSourceRevision`；创建
PricingPolicy/RuleSet 草稿不会发布正式版本。写回前重新读取源表并校验 revision、单元格
Trace、ID 唯一性、前缀与实体类型；写后必须回读恢复，不能把写回等同于拉取或发布。

`08_价格计算` 导入为 `PricingPolicyDraft`。C/B/A/S 到 PricingBasket 的显式映射已存在；
评分插值、竿/轮/线零整比、金额单位、舍入、最低价格和溢出上限未发布前，只允许非正式
试算与单元格级 Trace，正式 Store 导出继续阻断且没有手填价格兜底。

## 配置表交付

一期只提供服务端生成的 `ConfigPreviewPackage`：固定
`packageKind=CONFIG_PREVIEW`、`publicationState=NON_FORMAL`、`formal=false`。
没有正式 Bundle 时，数字 ID 与正式 `configNameKey` 均为空，关系检查只使用
`NON_FORMAL:<modelId>:<objectKind>` 符号引用。下载物是带“不可提交、不可人工搬运到configs”
声明的预览关系报告，不使用生产工作簿文件名。

一期不提供本地目录绑定、正式人工搬运包或配置提交。浏览器、文件系统与历史伴随服务中的
1.5 期恢复型写入骨架继续保留，但 `commit_config_export` 同时受服务端阶段开关、独立运行时
启用、正式 Bundle、策略/目录/新鲜 Manifest、治理租约与受保护 expected-old-OID CAS 门禁；
这些证据还必须由服务端验证器回读确认，调用方自报字符串无效；任一条件缺失均 fail-closed。
验证请求绑定 package、Profile、环境×渠道、映射版本、Snapshot id/hash 与每个暂存操作，验证后的
上下文 hash、Manifest 集合 hash、验证时间、ConfigId/目录版本、lease、fencing token 与
expected-old-OID 冻结进提交结果，不能换目标、内容或授权证据重放。已提交的同上下文、同授权
幂等重试可从冻结结果恢复，不要求已消费的原租约再次在线验证，也不会重新写文件。
正式 ConfigId 与导出治理分别由 GitHub #55、#56 实现并独立启用。缺少可重放正式品质或定价
策略引用，或仍有未解决 EXPORT ERROR/BLOCKER 的历史 Snapshot，只能下载原样审计归档，
不能进入配置预览或提交链。

## 旧版工作区

合并前的 pnpm 多包实现仍保留在 `apps/web` 与 `packages/*`，用于历史追溯；当前开发、验证与部署均以仓库根目录的 v3 应用和 npm 脚本为准。
