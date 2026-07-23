# 钓具配置工坊

面向淡水路亚杆、轮、线装备的团队配置工作台。

## 能力

- 重量模板与动态参数管理
- 类型、材质、功能、性能、技术和系列规则矩阵
- 有类型的规则 DAG，支持条件分支、汇合、手动节点、人工审阅中间表和完整执行轨迹
- 节点内部保留可排序规则栈，支持加、乘、覆盖、上下限和安全公式
- 直接属性词条与被动机制词条
- 有损相加、协同与冲突驱动的品质评分
- v3 Collection / Series、离散重量 SKU 抽屉与可购买 Model
- CandidateSearchRecipe 驱动的确定性 Model 候选生成、物化与审计
- Series / SKU / Model 分层 Patch、冻结 ConfigurationSnapshot 与升级候选
- 旧 SeriesRecipe、Candidate、OfficialSku 与 DetailOverride 只读归档及迁移诊断
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

`apps/web`与`packages/*`是历史pnpm workspace。它的workspace声明和锁文件隔离在
`legacy-workspace/`；必须从这个目录边界运行pnpm，不得把仓库根npm应用重新加入pnpm importer，
也不得用pnpm安装隐式替代根应用的npm验证：

```powershell
pnpm --dir legacy-workspace install --frozen-lockfile
pnpm --dir legacy-workspace --filter '@tackle-forger/*' typecheck
pnpm --dir legacy-workspace --filter '@tackle-forger/*' lint
pnpm --dir legacy-workspace --filter '@tackle-forger/*' test
pnpm --dir legacy-workspace --filter '@tackle-forger/*' build
```

根`package.json`或`package-lock.json`的单独变化不应改写
`legacy-workspace/pnpm-lock.yaml`；历史workspace依赖变化必须同步该锁文件，否则冻结安装会失败。
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
一期部署前预检、无业务写入 smoke、真实 OAuth/工作簿/主流程证据与回填格式见
`docs/deployment/phase-one-acceptance.md`。预检结果不能替代真实环境端到端验收。

Vercel 评审构建同样从仓库根安装 `package-lock.json`，但通过
`npm run build:vercel` 启用 Vinext 的 Nitro 适配器。该命令生成 Vercel Build Output API
要求的 `.vercel/output`；`vercel.json` 不执行 `next build`、不修改源码，也不把历史
`apps/web` 当作部署入口。

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

## Fancy Hub AI 连接器

真实 AI 连接器默认关闭（`FANCY_HUB_ENABLED=false`），关闭、超时、限流或不可用均不影响
派生、校验、Patch、发布和历史复现。它只允许连接部署配置中的单一 Fancy Hub HTTPS origin，
只发送严格递归白名单的 `ai-request/v1`；真实 ID、自由文本、Evidence 正文、ActionLink、密钥
和未知字段会在网络请求前被拒绝。

启用前必须完成以下证据并由部署管理员保留：Fancy Hub 动态模型列表及不可变修订标识、
主模型与有序降级列表、provider 与租户硬 token/并发/速率/超时/费用上限、全部本地门禁、
独立评审和回滚演练。完成后才配置 `.env.example` 中的全部 `FANCY_HUB_*` 估算/限额项、
持久化 `AI_RETENTION_DATA_DIR`、32 字节留存加密密钥及版本，并显式改为
`FANCY_HUB_ENABLED=true`。缺少任一项时产品入口保持关闭。只有 `AI_PROVIDER_ADMIN_OPEN_IDS` 中的飞书用户拥有
`ai.provider_policy.manage`；其他已登录公司用户只在功能启用时获得评估、查看和创建草稿能力。
部署期 provider 硬限额是首次模型发现请求的启动上限；运行时模型列表只能进一步收紧本次调用，
不能用首次出网后的发现结果补偿缺失的启动配置。

回滚时首先把 `FANCY_HUB_ENABLED` 恢复为 `false` 并重启服务，然后撤销 Fancy Hub token；
连接器不会自动批准 Patch、写回飞书、发布 RuleSet/Snapshot 或改写历史快照。AI 原始内容、
语义内容、操作元数据与采纳来源分别执行 180 天、1 年、3 年和随产物永久保留策略；用户删除
会立即隐藏，24 小时内清除主存储内容并以墓碑阻止备份恢复，备份清除期限为 30 天。备份清理
必须由存储适配器实际删除并回读确认；失败保持待重试状态，不能只记录“已清除”。生产调用在
出网前确认留存目录可写，使用持久化锁实现跨请求/进程并发与速率协调，并按 canonical Envelope 的 UTF-8 字节
上界、最大输出 token 与批准费率计算硬准入估算；成功后同步写入审计事件和加密留存记录。Fancy Hub
响应同样使用严格的 `ai-response/v1`，未知字段、超限内容和请求外别名在生成建议前拒绝，成功
结果记录规范化 `outputHash`。工作台的 AI 按钮只消费服务端启用状态，并通过认证接口运行。
生产备份会把 `AI_RETENTION_DATA_DIR` 纳入独立 `ai-retention` 目录；不可回退的删除墓碑写入
其外部的 `AI_RETENTION_TOMBSTONE_DIR`，工作区备份和恢复不得覆盖该目录。每小时 systemd timer 运行
`npm run ai-retention:sweep`，完成主存储期限清理，并在备份期限到达后按 assessmentId 删除所有备份副本、
回读确认后才把墓碑标记为已清除。`GET/DELETE /api/ai/assessments/:assessmentId` 只允许已登录所有者读取或删除；
删除幂等并立即从读取路径隐藏。

## 配置表交付

一期只提供服务端生成的 `ConfigPreviewPackage`：固定
`packageKind=CONFIG_PREVIEW`、`publicationState=NON_FORMAL`、`formal=false`。
没有正式 Bundle 时，数字 ID 与正式 `configNameKey` 均为空，关系检查只使用
`NON_FORMAL:<modelId>:<objectKind>` 符号引用。下载物是带“不可提交、不可人工搬运到configs”
声明的预览关系报告，不使用生产工作簿文件名。

一期不提供本地目录绑定、正式人工搬运包或配置提交。浏览器、文件系统与历史伴随服务中的
1.5 期恢复型写入骨架继续保留，但生产形态预览、暂存与 `commit_config_export` 同时受服务端
阶段开关、独立运行时启用、`config.export.commit`、正式 Bundle、策略/目录/新鲜 Manifest、
治理租约与受保护 expected-old-OID CAS 门禁；这些证据还必须由服务端验证器在读取本地
`config.toml`/工作簿前预检，并在写入 staging 前绑定实际文件 hash 再次确认，调用方自报字符串
无效。浏览器没有受信服务端验证器、伴随服务只有 preview Capability 或任一前置缺失时，稳定
返回 `CONFIG_TARGET_SERIALIZATION_UNAVAILABLE`，只保留 NON_FORMAL 预览。
验证请求绑定 package、Profile、环境×渠道、映射版本、Snapshot id/hash 与每个暂存操作；目标
使用工作簿相对逻辑引用，不把执行机 projectRoot 或绝对路径写入远端证据。验证后的
上下文 hash、Manifest 集合 hash、验证时间、ConfigId/目录版本、lease、fencing token 与
expected-old-OID 冻结进提交结果，不能换目标、内容或授权证据重放。已提交的同上下文、同授权
幂等重试可从冻结结果恢复，不要求已消费的原租约再次在线验证，也不会重新写文件。
正式 ConfigId 与导出治理分别由 GitHub #55、#56 实现并独立启用。缺少可重放正式品质或定价
策略引用，或仍有未解决 EXPORT ERROR/BLOCKER 的历史 Snapshot，只能下载原样审计归档，
不能进入配置预览或提交链；同一 Model 的多个冻结修订也不能进入同一个预览包。

## 旧版工作区

合并前的 pnpm 多包实现仍保留在 `apps/web` 与 `packages/*`，仅用于历史追溯、兼容性测试和经审计的数据迁移；其中的浏览器本地状态不属于正式产品数据。当前开发、验证、评审和生产部署均以仓库根目录的 v3 应用和 npm 脚本为准。
