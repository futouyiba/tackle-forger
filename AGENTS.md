# Tackle Forger 项目开发约束

<!-- workflow-contract-policy-ref/v2: .codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json -->

## 权威设计

开始任何实现、重构、评审或测试任务前，必须按渐进读取协议阅读：

- `docs/README.md`
- `docs/spec-v3/README.md`
- `docs/spec-v3/00-authority.md`
- `docs/spec-v3/05-open-decisions.md`中的§19
- `.codex/skills/tackle-agent-workflow/references/v3-open-registry.json`
- TaskBrief `applicableIds`对应的OPEN正文小节及registry声明的直接依赖
- 任务路由命中的相关章节及其直接依赖

紧凑OPEN registry是机器生成的导航证据，不替代canonical OPEN正文；即使`applicableIds`为空也必须绑定完整registry hash、检查全部ID并提供非空理由。`docs/spec-v3/`中的模块合起来是唯一权威产品与领域规范；`docs/tackle-forger-development-spec-v3.md`只是自动生成的兼容镜像。范围未知、影响广泛跨域、修改规范结构、strict/high-risk或无法可靠判断OPEN适用性时必须fail-closed读取全部模块。其他`docs/2026-*`和`crystal/*`文件均为历史材料；发生冲突时一律以v3规范为准。

## 不得自行改变的结论

- 重量规格使用最近派生模板，不做连续插值。
- 钓法和类型是两个规则层，界面可以放在同一步。
- 品质映射为C/绿、B/蓝、A/紫、S/橙。
- `functionIntensity`表示功能专精强度，不是品质。
- SKU是钓具抽屉，Model是实际选择和购买对象。
- 技术是词条组合包，不得与所含词条重复提供同名属性加成。
- 被动技能在本工具中只保存、计分和展示；不执行、不验证模拟器逻辑。
- 已发布ConfigurationSnapshot不可被上游规则静默重算。
- 仍在开放决策中的语义必须保持可配置，并在实现前请求确认。

## 旧表兼容说明

项目尚未正式交付，无生产环境历史 workspace state 需迁就。PR2b 切流后生产读取链默认走 WQ8w（`CANONICAL_FEISHU_WORKBOOK`）。旧表 YsEKw 的运行时兼容代码与 `LEGACY_YS_EKW_*` 常量已移除（历史拓扑仅 spec §14 审计文档保留）；`/wiki/` 通用解析能力保留。`lib/migrations.ts` 的 schema 迁移链仍需维护与测试覆盖。

## 实现要求

- 领域计算必须确定、可追踪、可重放。
- 兼容性必须区分硬规则和软Affinity Score。
- 手工修改使用分层Patch，不覆盖派生模板。
- 保留并迁移现有数据，不通过删除历史状态简化实现。
- 新增领域行为必须补测试；至少覆盖正常路径、边界、冲突和版本冻结。

## 项目级 Agent Skills

- 本仓库在`.codex/skills/`内提交所需工作流Skills；克隆仓库后优先使用项目级版本。
- 一个明确Issue的端到端交付使用`$agent-issue-loop`，其单个PR阶段交给`$agent-pr-loop`。
- 已存在PR的评论、复审、修补、当前head CI与集成证据使用`$agent-pr-loop`。
- 初始化、迁移、普通语言任务发现或仓库级GitHub协作政策使用`$agent-project-bootstrap`。
- 本仓库实现、修复或重构使用`$tackle-agent-workflow`准备Task Card/TaskBrief；本地、Issue与PR职责分别由该Skill、`$agent-issue-loop`和`$agent-pr-loop`承担。

## Agent 工作流权威

机器可读的唯一工作流政策是
`.codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json`。
`workflow-contract.mjs`执行并校验该政策；Task Card、TaskBrief、receipt、verdict、SCOPED/ROUTED/FULL、验证矩阵与证据身份的操作流程见`$tackle-agent-workflow`，本文不维护第二份教程或JSON。

`reviewTier: fast | standard | strict`独立决定审核边界与强度，风险事实仍由`riskProfile`和`riskDimensions`表达；`strict`同时按中央policy触发FULL规范读取。`unknown_high_risk`，或`persistedData`、`historicalSnapshots`、`concurrency`、`authorization`、`externalSideEffects`任一为真时，`reviewTier`必须为`strict`；不得由显示文案、标签或本地缓存降低该下限。

工作流治理改动至少运行：

- `node scripts/spec-v3-modules.mjs --check`
- `node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index`
- `node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy`
- `node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs`

## 本机凭据与多 worktree

- 本机开发的忽略凭据文件统一存放于`/Users/songfu/.config/tackle-forger/.env.local`；目录权限必须为`700`，文件权限必须为`600`。不得读取、回显、提交或复制其中的值到仓库、日志、Issue、PR、截图或聊天记录。
- 每个需要本机飞书认证的 worktree 使用其根目录的`.env.local`软链接指向该共享文件。新 worktree 尚不存在`.env.local`时，执行：`ln -s /Users/songfu/.config/tackle-forger/.env.local /path/to/worktree/.env.local`。
- 如果目标 worktree 已有常规文件或其他软链接，先只读检查目标与来源，再由用户明确授权迁移、替换或保留；不得以链接命令覆盖现有凭据文件。
- 共享凭据只用于本机验收，不构成部署配置。飞书`FEISHU_REDIRECT_URI`必须与开放平台登记值逐字一致，并遵循`docs/deployment/feishu-enterprise-login.md`的HTTPS/私网HTTP边界。

## GitHub合并门禁

`.github/merge-gates.md`是Pull Request合并资格、CI provenance、规范review signal和workflow治理例外的唯一完整人类可读权威；`scripts/check-pr-merge-gate.mjs`只实现其中的机器检查。

本仓库的managed mode为`autonomous`，作用域是当前仓库和当前明确目标；由单一有权限的coordinator/托管主管负责，活跃任务轮次或已配置唤醒作为heartbeat，当前不声称存在额外后台Automation。重试上限为3个fix-review-CI循环，自动独立review按`reviewTier`和高风险门禁执行，merge policy为`qualified_auto_merge`。人工关卡包括本任务用户显式合并暂停、未决产品/范围或依赖、安全/授权/凭据/计费/法律决定、不可逆或破坏性数据动作、必需验证或身份不可用、合并触发部署/发布/外部副作用及重试耗尽；部署和发布策略固定为`never`。

合并门禁由首个有权限的Agent或单一托管主管基于实时GitHub状态执行；这是仓库的standing responsibility，不把checker通过扩张成部署、发布或其他外部副作用授权。

合并决策前从干净、同步到实时base tip的目标分支工作树运行：

`npm run governance:check-pr -- --repo futouyiba/tackle-forger --pr <number> --risk <normal|high>`

任何相关远端状态变化后都必须刷新并重跑。不得从被审分支复制checker，也不得通过参数、评论或自身代码自行放行。实时checker对精确head/base返回`READY`，且不存在`.github/merge-gates.md`定义的人工关卡时，即激活本仓库的qualified auto-merge standing authorization：首个有权限的coordinator或单一托管主管应直接合并一个符合条件的PR，无需本轮用户另行授权，并立即回读远端合并结果。专门修改CI workflow或merge-gate program的治理PR即使因受信基线比较而保持非`READY`，在独立exact-head review明确接受全部预期治理阻断、其余阻断清零且无人工关卡时，也由同一standing authorization自动合并，不再要求owner另行授权。用户在本任务开始或进行中明确要求不合并、等待人工合并或合并前再次询问时，该指令建立任务级人工关卡；即使checker返回`READY`也必须等待，且只有用户后续明确授权合并才能解除，沉默、CI/review通过或新的`READY`均不能解除。checker未返回`READY`且未满足上述治理路径，或命中其他人工关卡时必须停止并请求决定。现行仓库不配置GitHub Ruleset、分支保护、required check或额外status context；不得新增重复workflow替代该门禁。合并授权不包括部署、发布、删除、范围扩张或其他外部副作用。
