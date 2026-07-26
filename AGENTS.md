# Tackle Forger 项目开发约束

## 权威设计

开始任何实现、重构、评审或测试任务前，必须按渐进读取协议阅读：

- `docs/README.md`
- `docs/spec-v3/README.md`
- `docs/spec-v3/00-authority.md`
- `docs/spec-v3/05-open-decisions.md`
- 任务路由命中的相关章节及其直接依赖

`docs/spec-v3/`中的模块合起来是唯一权威产品与领域规范；`docs/tackle-forger-development-spec-v3.md`只是自动生成的兼容镜像。范围未知、影响广泛跨域或修改规范结构时必须读取全部模块。其他`docs/2026-*`和`crystal/*`文件均为历史材料；发生冲突时一律以v3规范为准。

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

- 本仓库在`.codex/skills/`内提交所需工作流Skills；克隆仓库后优先使用项目级版本，不要求预先全局安装。
- 对一个明确Issue的端到端交付，使用`$agent-issue-loop`。由同一个主Agent完成就绪检查、实现、验证、PR交接与结果回读，并把单个PR阶段交给`$agent-pr-loop`。
- 对一个已经存在的PR执行评论、独立复审、修补、当前head CI与集成证据检查时，使用`$agent-pr-loop`。
- 需要初始化、迁移、普通语言任务发现或仓库级GitHub协作政策时，使用`$agent-project-bootstrap`。
- 对本仓库中的实现、修复或重构，`$tackle-agent-workflow`为所有路由提供项目约束与 TaskBrief；只有本地路由使用其编码与独立本地审核。Issue 与 PR 路由仍分别遵循`$agent-issue-loop`和`$agent-pr-loop`；仓库的合并、发布和部署门禁不因项目级Skill存在而放宽。

## Tackle 工作流契约

- `$tackle-agent-workflow`日常开发先用 Task Card；仅本地路由使用其编码与独立本地审核。Issue 生命周期归`$agent-issue-loop`，PR 审核/CI/修复归`$agent-pr-loop`；已有 PR 直接使用后者。不得增加第二个独立审核者。
- 日常任务使用闭合`tackle-task-card/v1`，且只有六个语义字段：`taskId`、`workflowMode`、`scope`、`ownedPaths`、`riskProfile`、`changeClass`。`--prepare-task-card`机械派生当前base/v3、路由、完整OPEN登记表覆盖、读取计划模板和升级标记；不生成已阅读声明或receipt。每张卡在正式边界均有`formalTaskBriefRequiredAtBoundary: true`；运行时、持久化/历史、并发、授权、发布/导出/外部作用、非SCOPED路径、Issue/PR或无法确定分类另以`earlyEscalationRequired`标记，必须提前转入完整TaskBrief。
- TaskBrief仅在正式本地审核交接、Issue派发或PR边界创建，必须记录任务与路由、阶段（`pre_dispatch`或`verdict`）、v3 hash、当前v3 headings存在的relevantSections（含20）、结构化OPEN核对、base/head或WORKTREE、owned与既有改动（含unowned）、范围、验收、排除、风险档与是否含运行时语义、必跑验证或 N/A 理由。OPEN核对绑定完整当前登记表hash、检查全部实际ID，并把applicableIds表达为其子集；即使登记表非空也可诚实声明“无适用项”，但须保留非空理由。SCOPED资格由全部owned路径的保守机器分类决定：仅`AGENTS.md`、仓库自带的 Codex 工作流技能（`.codex/skills/tackle-agent-workflow/**`、`.codex/skills/agent-project-bootstrap/**`、`.codex/skills/agent-issue-loop/**`、`.codex/skills/agent-pr-loop/**`）、仓库自带的 Claude PR 工作流技能（`.claude/skills/agent-pr-loop/**`）、明确命名的非权威治理文档、根`.github/*.md|yml|yaml`及规范 Actions workflow `.github/workflows/*.yml|yaml`可候选；其他 Claude 技能与嵌套`.github`路径仍不合格。`docs/README.md`、v3及其他产品/领域合同、任何其他、运行时代码、包、迁移或配置影响路径强制FULL。TaskBrief是receipt的唯一风险与章节来源：分类合格的纯workflow/docs/metadata且无运行时语义可使用SCOPED；其他任务按路由使用ROUTED，只有范围未知、广泛跨域或规范结构变化才FULL。pre-dispatch恰好一个coordinator收据；verdict阶段恰好各一个coordinator、coding、review收据。`tackle-spec-read/v1`保持原有验证语义；仅连续同一Agent、同一明确上下文session、v3/README/OPEN登记表哈希均完全一致的低风险workflow/docs/metadata任务，可以用封闭的`tackle-spec-full-read-session/v1`和任务专属`tackle-spec-read/v2`复用一次FULL阅读。复用检查必须由协调器/调用环境注入可信的当前Agent identity、当前context-session identity和当前context state，并分别与session比对且state严格为`continuous`；TaskBrief含`REUSE_FULL`时也必须提供这三个基线。上下文未知或压缩、Agent/session变化、任一哈希变化、风险升级、运行时语义或相关章节未明确读取均强制FULL；创建时间只供审计，绝不可用TTL推定连续性；任何receipt仍只是声明，不证明理解。
- 本地既有owned改动的冻结基线为`tackle-owned-baseline/v1`确定性manifest/hash，必须绑定base、完整owned路径及既有owned路径；仅64位字符串不是有效基线。
- 证据按边界分层：`development`仅要求Task Card和适用验证，编码探索/迭代不生成正式Patch Hash、TaskBrief或PASS；`local_review_handoff`与`pr_final`必须使用完整TaskBrief，前者冻结受审身份，后者保持精确head上的CI和PR门禁。Task Card只能机械生成OPEN覆盖、读取计划和未完成receipt草稿，不能生成阅读声明；从干净初始状态完成日常开发后，`--upgrade-task-card`只接受card-owned脏改动并把完整人类边界输入升级为TaskBrief。所有版本化收据、TaskBrief、冻结基线、验证项和verdict必须closed schema，拒绝未知、缺失或当前条件不适用字段；Issue/PR的reviewedHead必须是当前HEAD的精确commit、Git状态完全干净，baseSha必须是该head的精确40位已解析祖先（允许feature branch相对base有非空diff），只有local可显式使用WORKTREE。本地审核结论为`tackle-local-verdict/v1`：已提交artifact以精确commit SHA为身份，不重复强制Patch Hash；WORKTREE必须绑定base、owned路径与重算Patch Hash。P0/P1/P2阻断PASS，P3仅信息性，不得为取得PASS降级发现。
- 验证由工作流的封闭命令目录按 verdict-phase TaskBrief 自行执行并产出精简`command / input identity / exit-result / timestamp / duration`摘要；调用方不得提供成功、哈希、耗时或环境字段。可复用摘要要求没有任何既有或非owned脏改动：已提交工件必须工作树完全干净，WORKTREE只允许其TaskBrief owned路径与当前冻结manifest一致。摘要用于交接与复用判断，不能作为可编辑 Verdict JSON 的 PASS 依据；常规交接不得人工复制完整日志，失败详情作为可展开证据保留。复用前必须重新比对工件、相关输入、依赖锁、命令契约、实际解析工具路径/版本、PATH及执行环境哈希、已安装依赖状态；PR最终门禁仍以精确head CI为准，不得复用替代。
- 文档/工作流改动逐个分类 tracked changed、untracked、deleted 或 unchanged；tracked/deleted运行`git diff --check <base> -- <paths>`，untracked运行`git diff --no-index --check /dev/null <path>`，无空白诊断才通过。产品测试未运行时写明无产品代码改动。
- 工作流改动运行`node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index`与`--check-policy`；仅在本地`WORKTREE`进入审核交接时运行`--patch-hash --base <sha> --owned <path> ...`，已提交artifact以精确commit SHA为准。

## 确定性验证矩阵

- 拉取、对比、历史审视和状态检查：不运行CI，只保留对应的只读检查证据。
- 文档说明或不改变行为的工作流：只运行格式、权威引用和范围diff检查；产品测试记为N/A并说明“无产品代码改动”。
- 单个脚本或规则：运行该脚本或规则的定向测试，不把一次局部修改升级为全量CI。
- 部署配置：验证配置、重启服务，并检查实际监听地址和健康状态。
- 普通业务代码：运行`npm run typecheck`、`npm run lint`和相关测试；新增领域行为还须覆盖正常、边界、冲突和版本冻结场景。
- 持久化、迁移、权限或外部写入：除相关代码检查外，必须验证边界、失败恢复、幂等和写后回读；迁移还须使用真实或脱敏生产形状fixture，并证明第二次执行无变化。
- 稳定PR候选：针对同一个精确head/base只运行一次完整CI。根应用逐字运行`npm run typecheck`、`npm run lint`、`npm test`；历史workspace仅在路径触及时运行`node --test tests/package-manager-boundaries.test.mjs`、`pnpm --dir legacy-workspace install --frozen-lockfile`及四个`pnpm --dir legacy-workspace --filter '@tackle-forger/*'`的`typecheck`、`lint`、`test`、`build`命令；未触及必须记录N/A理由。
- rebase或base/head变化：先按实际diff重新分类，只重跑受影响检查；仅当影响广泛或形成新的稳定PR候选时才重跑完整CI。
- 迭代分类与稳定候选门禁是两个正交维度：业务、部署、持久化或外部写入在迭代阶段不跑完整CI，不表示其成为稳定精确head/base候选后可以跳过一次完整CI；rebase只先触发受影响检查，形成新稳定候选后仍须取得该精确head/base的一次完整CI证据。

<!-- workflow-contract-policy/v2
{"dirtyIsolation":{"issuePr":"clean_synced","localOwnedBaseline":"tackle-owned-baseline/v1"},"issue":{"localReviewer":false,"owner":"agent-issue-loop","prReviewer":"agent-pr-loop"},"local":{"independentReviewer":true,"owner":"tackle-agent-workflow"},"localVerdict":{"artifactIdentity":{"committed":"commit_sha_only","worktree":"base_owned_paths_patch_hash"},"required":["taskBriefSha256","specReceiptHashes","dirtyWorktreeDisposition","specSha256","baseSha","reviewedHead","ownedPaths","artifactIdentity"],"schema":"tackle-local-verdict/v1"},"pullRequest":{"owner":"agent-pr-loop","reviewer":"agent-pr-loop"},"reviewSeverity":{"passBlocking":["P0","P1","P2"],"p3":"informational"},"scopedEligibility":{"allowedPathClasses":["AGENTS.md",".codex/skills/tackle-agent-workflow/**",".codex/skills/agent-project-bootstrap/**",".codex/skills/agent-issue-loop/**",".codex/skills/agent-pr-loop/**",".claude/skills/agent-pr-loop/**","docs/(workflow|agent-governance)-*.md",".github/*.md|yml|yaml",".github/workflows/*.yml|yaml"],"unknownForcesFull":true},"specReceipt":{"schema":"tackle-spec-read/v1"},"taskCard":{"dailySemanticFields":["taskId","workflowMode","scope","ownedPaths","riskProfile","changeClass"],"developmentEvidence":"task_card_daily","formalBoundaryUpgrade":"task_brief_only","schema":"tackle-task-card/v1"},"taskBrief":{"allowedChangesEqualsOwnedPaths":true,"closedSchema":true,"conditionalNaApplicability":{"legacyTouchedForbids":"legacy_workspace_ci","nonLegacyRequires":"legacy_workspace_ci","nonWorkflowForbids":"product_runtime_tests","workflowMetadataRequires":"product_runtime_tests"},"conditionalNaCatalog":{"legacyWorkspaceCi":"legacy_workspace_ci","productRuntimeTests":"product_runtime_tests"},"evidenceStages":{"development":"task_card_daily","localReviewHandoff":"local_verdict","prFinal":"pr_final_change_class"},"openDecisionCheck":true,"phaseReceipts":{"pre_dispatch":["coordinator"],"verdict":["coordinator","coding","review"]},"receiptRiskAuthority":true,"schema":"tackle-task-brief/v1","structuredFields":["changeClass","allowedChanges","riskDimensions","validationPlan"]},"validationRunner":{"closedCommandCatalog":true,"formalVerdictEvidence":false,"reusableWorktree":"committed_clean_or_worktree_owned_manifest_only","reuseRequiresUnchanged":["artifact","relevant_inputs","dependency_lock","command_contract","toolchain","path_and_execution_environment","installed_dependency_state"],"schema":"tackle-validation-summary/v1"},"validationMatrix":{"commandsAndScenariosSeparated":true,"executionTiers":{"business_code":{"iterationFullCi":"forbidden","requiredEvidence":["typecheck","lint","related_tests"]},"deployment_configuration":{"iterationFullCi":"forbidden","requiredEvidence":["config_validation","service_restart","actual_listener","health_check"]},"documentation_or_nonbehavior_workflow":{"iterationFullCi":"forbidden","requiredEvidence":["format_reference_scoped_diff"]},"durable_or_external":{"iterationFullCi":"forbidden","requiredEvidence":["boundary","failure_recovery","idempotency","readback"]},"focused_script_or_rule":{"iterationFullCi":"forbidden","requiredEvidence":["targeted_test"]},"inspection_only":{"iterationFullCi":"forbidden","requiredEvidence":["fetch_compare_history_or_status"]},"rebase_refresh":{"candidateFullCi":"broad_impact_or_new_stable_candidate","requiredEvidence":["actual_diff_classification","affected_checks"]},"stable_pr_candidate":{"candidateFullCi":"once_per_exact_head_base","requiredEvidence":["root_full_ci","applicable_historical_ci","windows_policy"]}},"legacyWorkspaceCommands":["node --test tests/package-manager-boundaries.test.mjs","pnpm --dir legacy-workspace install --frozen-lockfile","pnpm --dir legacy-workspace --filter '@tackle-forger/*' typecheck","pnpm --dir legacy-workspace --filter '@tackle-forger/*' lint","pnpm --dir legacy-workspace --filter '@tackle-forger/*' test","pnpm --dir legacy-workspace --filter '@tackle-forger/*' build"],"mandatoryWorkflowCommands":["node scripts/spec-v3-modules.mjs --check","node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index","node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy","node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs"],"prFinalCommandsNonWaivable":["npm run typecheck","npm run lint","npm test"],"triggeredCannotBeNa":true,"triggeredScenariosNonWaivable":true,"userVisiblePathClassifier":"tsx_jsx_css_scss_sass_less_html_and_ui_roots","userVisibleScenario":"unified_visual_review_pending_or_completed","workflowMetadataDynamicDiff":true},"visual":{"minimalSmokeCompletesReview":false,"pendingMarker":"视觉与交互统一检查待执行"}}
-->

## 本机凭据与多 worktree

- 本机开发的忽略凭据文件统一存放于`/Users/songfu/.config/tackle-forger/.env.local`；目录权限必须为`700`，文件权限必须为`600`。不得读取、回显、提交或复制其中的值到仓库、日志、Issue、PR、截图或聊天记录。
- 每个需要本机飞书认证的 worktree 使用其根目录的`.env.local`软链接指向该共享文件。新 worktree 尚不存在`.env.local`时，执行：`ln -s /Users/songfu/.config/tackle-forger/.env.local /path/to/worktree/.env.local`。
- 如果目标 worktree 已有常规文件或其他软链接，先只读检查目标与来源，再由用户明确授权迁移、替换或保留；不得以链接命令覆盖现有凭据文件。
- 共享凭据只用于本机验收，不构成部署配置。飞书`FEISHU_REDIRECT_URI`必须与开放平台登记值逐字一致，并遵循`docs/deployment/feishu-enterprise-login.md`的HTTPS/私网HTTP边界。

## GitHub合并门禁

- 当前不配置GitHub Ruleset、分支保护、required check或额外status context；合并门禁由首个有权限的
  Agent或单一托管主管在实时GitHub状态上执行，不得新增重复workflow代替该流程。
- `Ready for review`与“可合并”是两个独立判断。实现、范围内验证、迁移/风险/回滚说明已足以让评审者
  作出决定时，Pull Request应退出Draft，关联Issue同步进入`In review`；不得先要求只能在非Draft阶段
  取得的人工批准或合并门禁放行结果，否则会形成流程死锁。
- 阻断必须归类为实现/验收缺陷、证据缺口、元数据滞后、外部授权或依赖/基线变化。只有实现、测试、
  代码冲突或验收条件问题才退回实现；Draft和Issue状态由有权限的观察者幂等修正。平台或仓库明确要求
  的外部批准只阻断合并，不表示代码有缺陷，也不阻止已完成变更进入正式评审。
- 合并前显式把变更分类为`normal`或`high`，并运行`npm run governance:check-pr -- --repo
  futouyiba/tackle-forger --pr <number> --risk <normal|high>`；任何相关远端状态变化后必须重跑。
- 只接受属于该Pull Request、同一个当前head SHA和当前base SHA的`pull_request`工作流中的根npm CI、
  历史pnpm CI和Windows行尾检查；缺失、未完成、失败、跳过、取消、仅push、旧head或旧base结果均阻断。
  PR编号、head和base必须来自CI运行时固化的结构化run name，且run必须来自规范workflow路径；不得把
  workflow run API中会随PR漂移的嵌套PR字段当作历史证据。先按结构化provenance筛选属于目标PR和head的
  规范run，再从该集合选择最新run；同head的其他PR不得遮蔽目标PR证据。当前attempt的jobs必须从GitHub
  attempt-specific端点读取，不依赖`job.run_attempt`字段。三个必需job各须恰好出现一次；缺失、重名或
  跨run/attempt拼接均阻断。#21仅是历史事故，其事后CI不得冒充当前通过。
- 门禁必须从干净、同步到实时base tip的目标分支工作树执行；门禁脚本内容必须与实时base上的
  `scripts/check-pr-merge-gate.mjs`一致。规范`.github/workflows/ci.yml`在PR head与实时base之间必须
  内容完全一致；PR修改该workflow时即使Actions成功也必须fail closed，转入独立workflow治理变更流程，
  门禁脚本本身的变更也遵循同一治理原则。不得由被审PR通过参数、环境变量、评论或自身代码自动放行。
  PR #63首次引入run-name和门禁脚本，只允许
  按`.github/merge-gates.md`记录一次明确的人工bootstrap决定；任何后续PR不得继承该例外。
- Draft、当前头存在有效`CHANGES_REQUESTED`或存在未解决review thread时阻断。高风险变更还必须在
  当前head留下可追溯的审查信号；本仓库由单一负责人管理多个Agent，因此`COMMENTED`、Bot或同一GitHub
  账号提交的审查均可承载Agent复核证据。`COMMENTED`必须在review正文中包含独立一行
  `Agent-Review: PASS`，普通评论或仅描述发现的review不计入。该信号只证明复核已发生，不冒充GitHub
  真人`APPROVED`；旧head上的较晚决定不得清除当前head的`CHANGES_REQUESTED`。同一评审者在同一当前
  head上较晚提交的精确`Agent-Review: PASS`可取代其较早的`CHANGES_REQUESTED`，普通`COMMENTED`不可。
  只有平台规则或负责人另行明确要求时，才增加真人批准门槛。
