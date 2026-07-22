# Tackle Forger v3 当前实现与 UX 原型差距矩阵

> 审计日期：2026-07-22  
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
| SKU 抽屉与多个 Model | 已实现 | Series/SKU/Model 稳定父链、Model 候选生成、抽屉及右侧 Model 预览 | 无 |
| 最近结构标杆 | 已实现 | 相同部位、钓法、类型、功能内按 abs(ln(target/derived))；不插值；平局规则确定 | 无 |
| Patch 分层与 Rebase | 已实现 | patch-engine 支持稳定层序、冲突与 rebase 差异；上游变化不改旧 Snapshot | 无 |
| PatchLedger 权威账本 | 已实现 | Workspace schema v13 + PatchLedger schema v3；稳定 ID、仅 ACTIVE 重放、revision 幂等、ORPHANED、Rebase/吸收均生成新 revision、Snapshot 引用冻结 | 无 |
| Patch 台账工作台 | 已实现 | 治理区一级入口展示 revision、稳定对象、操作顺序、基线、镜像状态、Snapshot 引用、迁移待复核及 RuleSet 发布后吸收评估；支持创建、审核、显式启用 | 镜像写入/拉取按钮在远端连接器可用前保持禁用 |
| 个体 Patch 汇总、规则草稿与吸收 | 已实现 | Patch 确定性归组后由独立权限创建 RuleSourceChangeDraft；新 RuleSet 下以逐操作 Trace 评估完全/部分/未覆盖/Rebase，保存 assessment 并创建新 revision，不改旧 Snapshot | 草稿远端写回仍需已确认的通用规则页写入契约 |
| 飞书 Patch 台账镜像 | 部分实现 | 已有领域契约、独立权限、幂等命令、部分失败和回读恢复状态；不会伪造 SYNCED | 主工作簿尚无已确认 Patch 台账 sheet_id/机器列，无法实施真实远端写入 |
| 硬兼容与 Affinity | 已实现 | deny/require 与软分值分离；高 Affinity 不覆盖 deny；低分合法候选仍可生成 | 无 |
| 属性词条、被动词条与 Technology | 已实现 | Technology 只展开成员；按 affixId 去重；被动参与价值分但不执行模拟器逻辑 | 无 |
| 品质评分 | 已实现 | 人工选择品质；区间、组合矩阵、功能/性能系数、score=100 冲突、source=quality Trace | 无 |
| 自动定价与 NON_FORMAL | 已实现 | 07/08 同 revision 导入、Lerp、结构源重量段、维修/购买公式、Trace、正式发布阻断 | 飞书尚未发布 roundingStage、minimumPriceScope、overflowMode 时只能 NON_FORMAL |
| 手填价格兜底 | 因 v3 冲突而不采纳 | 正式价格只能来自已发布 PricingPolicyVersion | 不提供绕过动作 |
| 五维图及双模式比较 | 已实现 | 版本化 ViewDefinition/VertexSet、单装备/钓组模式、缺失值不归零、Snapshot 冻结 | 中档边界继续保持种子配置，不固化为永久常量 |
| AI 建议壳与草稿边界 | 已实现 | AI 默认关闭；仅草稿；不能写飞书、发布或改变裁决；证据、过期和权限契约已有测试 | OPEN-006 未确认前不得连接外部模型 |
| AI 真实供应方 | 部分实现 | UI 明确禁用并解释原因 | 等待用户确认供应方、模型、字段白名单和数据出网策略 |
| ValidationIssue 与 ActionLink | 已实现 | 服务端动作可用性、权限和领域阻断原因统一返回；Model/发布页显示问题和修复方向 | Patch 台账远端 ActionLink 等连接器可用后再启用 |
| 内网飞书登录 | 已实现 | OAuth state、会话持久化、过期、防重放、可信代理和 API 401 测试 | 部署环境需配置 HTTPS 回调或明确私网 HTTP |
| 本地 configs 多环境/多渠道三表交付 | 已实现 | config.toml、映射版本、预览、关系校验、备份、幂等、冲突恢复、GoodsBasic+StoreBuy | 真实目标仓库需要登记 Profile 与映射后才能提交 |
| Snapshot 冻结与 UpgradeCandidate | 已实现 | 已发布 Snapshot 内容/hash/有序 Patch 引用不可原地变更；上游变化只产生升级候选 | 无 |
| 09_甘特图作为产品实体 | 因 v3 冲突而不采纳 | 09 只属于开发排期；产品甘特图来自本地 Series/SKU/Model | 不从 09 反向生成领域对象 |
| 11/12/14–17 反向覆盖产品真相 | 因 v3 冲突而不采纳 | 仅作为历史样例、映射参考或暂存输出 | 不反向覆盖 Snapshot |
| 扩展部位主流程 | 部分实现 | 注册表可保留扩展部位 | OPEN-003 下钩、漂、真饵、拟饵在一期 UI 保持禁用 |

## 2. 当前外部阻断

1. 飞书主工作簿尚未提供已确认的 Patch 台账工作表 sheet_id、机器列布局和协作字段权限，因此真实镜像写入/拉取不可启用。
2. Vercel 评审项目当前只配置 `BLOB_READ_WRITE_TOKEN`，缺少 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TENANT_KEY`、`FEISHU_REDIRECT_URI` 和 `FEISHU_SESSION_SECRET`；生产浏览器实测显示 `AUTH-CONFIG-001`，需部署方提供公司应用凭据并在飞书开放平台登记回调。
3. PricingPolicy 的 roundingStage、minimumPriceScope、overflowMode 尚未从权威规则源发布，因此新正式价格策略和正式 Store 导出必须继续阻断。
4. OPEN-006 尚未确认 AI 供应方、模型和数据出网策略，因此真实 AI 连接器必须继续禁用。
5. 真实 configs Git 目标需由部署方登记环境、渠道、路径与映射版本；未登记时只能预览或明确阻断。

## 3. 当前验证证据

- 完整测试套件当前 182 项通过，覆盖领域、API、迁移、权限、冲突、恢复、SQLite 持久化和冻结。
- 生产构建与渲染验收覆盖飞书规则源、离散 Series 创建和 Patch 台账入口。
- PatchLedger 单测覆盖独立 schema v3、Workspace schema v13、幂等、仅 ACTIVE 生效、操作顺序、稳定 ID、Rebase 新 revision、ORPHANED、规则草稿权限、镜像失败、显式拉取与 Snapshot 冻结。
- 最新评审构建已部署到 `https://tackle-forger-workbench.vercel.app`；静态页面 HTTP 200，浏览器实测因缺少飞书 OAuth 环境变量停在明确登录配置错误页。
- 最终完成仍需在真实内网部署环境完成飞书 OAuth、真实工作簿回读、目标 configs Profile 和多分辨率页面的联调验收。
