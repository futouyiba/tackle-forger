# Tackle Forger v3 当前实现与 UX 原型差距矩阵

> 审计日期：2026-07-22  
> 原始实现审计代码基线：`a393c5470a73081967690dab733cf9cc5202cdc1`（2026-07-22 20:06:22 +0800）
> 原始验证时间：2026-07-22 20:58:36 +0800
> 本次反馈归并复核：2026-07-22 22:55:13 +0800，HEAD `ba2111c2e6021d968606cfe4ee3e839732184d71`；只复核本次五条反馈及对应代码事实，没有重跑完整测试。
> 远端分支复审：2026-07-22 23:03:53 +0800，`origin/review/current-state-2026-07-22@fee6c83a1f269ef310116828ad40bd6d832020c7`；完整测试与类型检查已重跑，详细证据见`../audits/remote-branches-review-2026-07-22.md`。
> 规范同步：2026-07-23，按v3 OPEN-008已确认决策修正1/1.5期边界与外部阻断；本次只更新目标契约和差距描述，不冒充代码实现或新测试证据。  
> OPEN-009对象可见性复核：2026-07-23 05:41:56 +0800，代码基线`origin/main@33cb47e4d923e6675f1a1bab8b2685266117bcaf`（提交时间2026-07-23 05:18:57 +0800）；确认运行时与测试仍执行对象级裁剪、隐藏计数和脱敏父链，本轮仅修正文档状态并由[Issue #31](https://github.com/futouyiba/tackle-forger/issues/31)跟踪实现迁移。
> OPEN-003运行时复核：2026-07-23，代码基线`codex/open-003-deferred-parts@cdcbd7ce6bea60548f2224039861593c453ae028`；确认迁移层会保留四类扩展部位，创建Series页面仍渲染全部`state.itemParts`，服务端尚无独立启用策略门禁。本轮只记录实现事实，由[Issue #37](https://github.com/futouyiba/tackle-forger/issues/37)跟踪代码收口。
> 对齐基线：v3 领域规范 > product-design-completion-v3 > implementation/requirements handoff > ux-design-v1 与 prototype 视觉证据。  
> 状态定义：已实现、部分实现、缺失、因 v3 冲突而不采纳。

## 1. 功能、状态与交互

| 范围 | 状态 | 当前证据 | 仍需工作 |
|---|---|---|---|
| 高密度数据驾驶舱与分组导航 | 已实现 | Workbench 分为建模、品质、生产、治理；生产构建渲染测试覆盖完整客户端和样式 | 实际部署后继续做多分辨率视觉回归 |
| 飞书唯一规则工作簿入口 | 已实现 | 侧栏顶部固定“飞书规则源 / 显式拉取工作簿”；按 sheet_id 检查、显式拉取 revision、建 RuleSet 草稿、ID 迁移和 PricingPolicyDraft 分离 | 真实租户部署需配置飞书应用凭据并做一次线上回读 |
| 写回、拉取、发布三步分离 | 已实现 | RuleWorkbookWorkbench 与 API 明确分成检查、显式拉取、创建草稿、人工显式发布；ruleset.publish 独立授权，过期源/error 阻断，warning 需理由，发布重试幂等且冻结审计 hash | 无 |
| Series 规划范围与离散拉力规格 | 已实现 | 正式创建以明确离散列表为唯一必填生成输入；planningPullRange 可选且不参与生成；每个值独立匹配并物化一个 SKU | 无 |
| 连续范围自动生成 SKU | 因 v3 冲突而不采纳 | v3 固定“范围负责规划，离散拉力负责生成” | 不实现连续插值或静默补规格 |
| 纵向重量轴、横向品质/类型泳道 | 已实现 | SeriesGanttWorkbenchV3 使用真实离散 SKU 节点与 Series 覆盖块；范围不充当实体 | 实际页面继续做视觉密度微调 |
| SKU 抽屉与多个 Model | 部分实现 | SKU抽屉、多Model、候选生成与右侧预览已存在；但`SeriesGanttQuery`仍按对象可见性裁剪Series/SKU/Model并隐藏总数，R2父链仍会返回脱敏占位，与当前OPEN-009统一业务Capability契约冲突 | 按[Issue #31](https://github.com/futouyiba/tackle-forger/issues/31)移除对象级裁剪、隐藏计数和脱敏父链，改为Model总数/当前查询命中数、完整稳定父链及跨工作区明确拒绝，并补齐R1/R2回归 |
| SKU targetPullKg变更身份保护 | 部分实现 | 已有离散拉力唯一性、稳定skuId、revision和Snapshot冻结基础 | 尚缺统一重量变更命令及回归：无已发布后代时同skuId新revision；有已发布后代时强制新SKU并可废弃旧SKU |
| 最近结构标杆 | 已实现 | 相同部位、钓法、类型、功能内按 abs(ln(target/derived))；不插值；平局规则确定 | 无 |
| Patch 分层与 Rebase | 已实现 | patch-engine 支持稳定层序、冲突与 rebase 差异；上游变化不改旧 Snapshot | 无 |
| Patch操作统一契约 | 部分实现 | PatchLedger与工作台使用set/add/multiply/clear，迁移器把旧remove转换为clear | 旧ProjectionPatchOperation仍暴露remove，旧AdjustmentRule路径仍可执行min/max；需按v3规范收口适配器、冻结规范化和迁移复核 |
| PatchLedger 权威账本 | 已实现 | Workspace schema v14 + PatchLedger schema v4；稳定 ID、仅 ACTIVE 重放、revision 幂等、ORPHANED、Rebase/吸收均生成新 revision、Snapshot 引用冻结 | 无 |
| Patch 台账工作台 | 已实现 | 治理区一级入口展示 revision、稳定对象、操作顺序、基线、镜像状态、Snapshot 引用、迁移待复核及 RuleSet 发布后吸收评估；支持创建、审核、显式启用 | 镜像写入/拉取按钮在远端连接器可用前保持禁用 |
| 个体 Patch 汇总、规则草稿与吸收 | 已实现 | Patch 确定性归组后由独立权限创建 RuleSourceChangeDraft；新 RuleSet 下以逐操作 Trace 评估完全/部分/未覆盖/Rebase，保存 assessment 并创建新 revision，不改旧 Snapshot | 草稿远端写回仍需已确认的通用规则页写入契约 |
| 飞书 Patch 台账镜像 | 部分实现 | 已有领域契约、独立权限、幂等命令、部分失败和回读恢复状态；不会伪造 SYNCED | 主工作簿尚无已确认 Patch 台账 sheet_id/机器列，无法实施真实远端写入 |
| 硬兼容与 Affinity | 已实现 | deny/require 与软分值分离；高 Affinity 不覆盖 deny；低分合法候选仍可生成 | 无 |
| 属性词条、被动词条与 Technology | 已实现 | Technology 只展开成员；按 affixId 去重；被动参与价值分但不执行模拟器逻辑 | 无 |
| 品质评分 | 已实现 | 人工选择品质；区间、组合矩阵、功能/性能系数、score=100 冲突、source=quality Trace | 无 |
| 自动定价与 NON_FORMAL | 已实现 | 07/08 同 revision 导入、Lerp、结构源重量段、维修/购买公式、Trace、正式发布阻断 | OPEN-007的S=100边界、性能评分来源、roundingStage、minimumPriceScope、overflowMode未全部解决时只能NON_FORMAL |
| 手填价格兜底 | 因 v3 冲突而不采纳 | 正式价格只能来自已发布 PricingPolicyVersion | 不提供绕过动作 |
| 五维图及双模式比较 | 已实现 | 版本化 ViewDefinition/VertexSet、单装备/钓组模式、缺失值不归零、Snapshot 冻结 | 中档边界继续保持种子配置，不固化为永久常量 |
| AI 建议壳与草稿边界 | 已实现 | AI 默认关闭；仅草稿；不能写飞书、发布或改变裁决；证据、过期和权限契约已有测试 | OPEN-006 未确认前不得连接外部模型 |
| AI 真实供应方 | 部分实现 | UI 明确禁用并解释原因 | 等待用户确认供应方、模型、字段白名单和数据出网策略 |
| ValidationIssue 与 ActionLink | 部分实现 | EntityRef、ActionAvailability、部分命令契约和页面问题展示已存在；品质模块已有BLOCKER概念 | 主领域仍使用`level=error/warning/info`，命令层另有小写severity+blocking，查询层又消费四档Severity；尚未统一v3的Severity/Gate/State、BLOCKER和版本化waiver，也未实现OPEN-008新增治理ActionCode、禁用态及不可篡改payload契约 |
| 内网飞书登录 | 已实现 | OAuth state、会话持久化、过期、防重放、可信代理和 API 401 测试 | 部署环境需配置 HTTPS 回调或明确私网 HTTP |
| 本地 configs 多环境/多渠道三表交付 | 部分实现 | 既有代码已有config.toml、映射版本、预览、关系校验、备份、幂等、冲突恢复、GoodsBasic+StoreBuy | v3已把一期收紧为不可提交`NON_FORMAL`预览，正式预留/人工搬运包/worktree写入移到1.5期；尚未实现稳定rangeId ledger、Model revision锁、权威目标目录/获批Manifest、新鲜度复验及dev/test/online/release正式流程，现有执行器不能作为已满足新契约的证据 |
| Snapshot 冻结与 UpgradeCandidate | 已实现 | 已发布 Snapshot 内容/hash/有序 Patch 引用不可原地变更；上游变化只产生升级候选 | 无 |
| 09_甘特图作为产品实体 | 因 v3 冲突而不采纳 | 09 只属于开发排期；产品甘特图来自本地 Series/SKU/Model | 不从 09 反向生成领域对象 |
| 11/12/14–17 反向覆盖产品真相 | 因 v3 冲突而不采纳 | 仅作为历史样例、映射参考或暂存输出 | 不反向覆盖 Snapshot |
| 扩展部位主流程 | 部分实现 | 注册表和迁移层会保留钩、漂、真饵、拟饵并标记`activeInGeneration=false`；但创建Series页面仍直接渲染全部`state.itemParts`，写接口也未独立校验启用部位策略 | OPEN-003已确认当前完全延期；按[Issue #37](https://github.com/futouyiba/tackle-forger/issues/37)移除产品入口并增加服务端门禁，同时保留稳定ID、历史Payload和引用。修复完成前不得声称运行时已经禁用 |

## 2. 产品反馈归并

以下反馈按“一个问题只保留一个权威归属”处理。已经存在实现的能力不再以“缺失”重复登记；只有重新复现出代码与界面结果不一致时，才另建回归问题。

| 原始反馈 | 复核后的准确结论 | 权威归属 | 处置 |
| --- | --- | --- | --- |
| 【品质评分】未计算【功能定位】提供的品质分 | v3正式公式使用`FunctionProfile.scoreFactor`，当前品质内核已经乘入该系数并记录Trace。 | v3 §12.1；本矩阵“品质评分” | 不新增问题；若当前页面仍出现错误结果，附Model、规则revision和Trace另建回归Bug。 |
| 【系列配方】未拆分竿轮线 | v14已为旧配方增加竿/轮/线独立约束迁移载体，但目前仅类型、迁移和测试使用；正式运行时及页面仍未消费，且旧`SeriesRecipe`和v3流程继续并存。 | `AUD-005`；迁移子项`AUD-R010` | 迁移结构子项已解决；用户可操作的分部位配方仍保持在`AUD-005`，不重复登记产品问题。 |
| 缺少钓具价格计算公式 | 维修价、购买价、评分插值和逐步Trace已经实现；缺的是可发布的正式策略。 | v3 `OPEN-007` | 删除“公式缺失”表述；源表未解决S=100边界、性能评分来源和执行语义前，只允许`NON_FORMAL`试算。 |
| 缺少最终配置表格的字段映射和同步 | 既有`ConfigExportMapping`、三表差异预览、关系校验、恢复写入和测试存在，但只证明旧执行器；正式提交仍需要真实Profile/映射、已发布定价，以及OPEN-008的目录/Manifest、策略、ledger和revision锁。 | v3 `OPEN-007`、`OPEN-008`；`config-export-mapping-guide.md` | 不重复登记“完全缺失”；按1.5期目标契约改造后再做真实仓库联调，完成前不得把旧下载/写入能力视为正式路径。 |
| 单元格编辑、规则设定不够便捷 | 属于两个可验收的持续体验问题，不与工程安全问题混记。 | `ux-design-v1`的`UX-001/UX-002` | 保持OPEN，后续实现与Design QA按对应验收条件关闭。 |

## 3. 当前外部阻断

1. OPEN-010：飞书主工作簿尚未提供已确认的Patch台账工作表sheet_id、机器列布局和协作字段权限，因此真实镜像写入/拉取不可启用。
2. Vercel评审项目当前只配置`BLOB_READ_WRITE_TOKEN`，缺少`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TENANT_KEY`、`FEISHU_REDIRECT_URI`和`FEISHU_SESSION_SECRET`；首页HTTP 200，但会话端点返回503/`AUTH-CONFIG-001`，需部署方提供公司应用凭据并在飞书开放平台登记回调。
3. OPEN-007：S=100边界、性能评分来源、PricingPolicy的roundingStage、minimumPriceScope、overflowMode尚未全部由权威规则源解决，因此新正式价格策略及其Model/Snapshot/Store导出必须继续阻断。
4. OPEN-006 尚未确认 AI 供应方、模型和数据出网策略，因此真实 AI 连接器必须继续禁用。
5. OPEN-008的数字区间、派生关系、命名、永不复用和权限语义已经确认；但尚未发布权威`ConfigTargetCatalogVersion`、覆盖全部必需目标的获批且新鲜`ConfigTargetScanManifest`、可校验`ConfigIdPolicyVersion`及reservation ledger，也未实现Model revision锁，因此仍不能正式预留ID或提交配置。
6. 真实 configs Git 目标需由配置治理方发布环境/渠道权威目录并完成authoritative ref、commit、`config.toml`和workbook hash扫描复核；用户本机目录绑定和旧Profile不能替代该门禁，未完成时只能`NON_FORMAL`预览。

## 4. 当前验证证据

- 远端复审完整`npm test`为190项主测试通过，另有1项渲染测试通过，覆盖领域、API、迁移、权限、冲突、恢复、SQLite持久化和冻结。
- 默认入口遗漏的`tests/feishu-writeback.test.ts`单独5项通过；遗漏本身仍由`AUD-025`管理。
- `npm run typecheck`通过。
- 生产构建与渲染验收覆盖飞书规则源、离散 Series 创建和 Patch 台账入口。
- PatchLedger单测覆盖独立schema v4、Workspace schema v14、幂等、仅ACTIVE生效、操作顺序、稳定ID、Rebase新revision、ORPHANED、规则草稿权限、镜像失败、显式拉取与Snapshot冻结。
- 最新评审构建已部署到`https://tackle-forger-workbench.vercel.app`；首页HTTP 200，会话端点503/`AUTH-CONFIG-001`，浏览器因缺少飞书OAuth环境变量停在明确登录配置错误页。
- 最终完成仍需在真实内网部署环境完成飞书 OAuth、真实工作簿回读、目标 configs Profile 和多分辨率页面的联调验收。
