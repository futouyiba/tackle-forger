# 重量段 SKU 与词条派生实现任务书（2026-07-28）

> 最后对齐 v3：2026-07-28
> 实现事实审计基线：`ae6f782b1272efcf3ccf6feba5f81c4ca8b917bf`
> 本文是独立实现任务书，不修改当前运行时，也不覆盖 v3 权威语义。

## 1. 目标与边界

把当前“Series直接填写`targetPullKg`→最近结构标杆→Model阶段结算词条”的流程迁移为“Series包含独立Part→选择01.x重量段→六键唯一匹配04.5→SKU有效词条派生拉力与品质推荐”。Series含1～3个竿/轮/线Part，每种最多一个。

不在本任务中启用钩、漂、真饵、拟饵；不改变五维W段语义；不插值；不改写Schema v9、当前Schema v22或既有ConfigurationSnapshot；不通过ModelPatch修改拉力；不把项目Excel往返与正式配置Git导出合并。

## 2. 当前实现差距

审计commit中`lib/migrations.ts`的`CURRENT_WORKSPACE_SCHEMA_VERSION`为22；v9只是历史迁移输入。`app/api/series/route.ts`仍接收拉力规格并物化`targetPullKg`，`app/api/skus/target-pull/**`仍提供直接改拉力命令，`lib/projection-matcher.ts`仍按目标拉力最近匹配；`lib/types.ts`、`SeriesGanttWorkbenchV3.tsx`、`V3FlowWorkbench.tsx`、候选/AI/导出路径均消费`targetPullKg`。

`lib/quality-value-policy.ts`与`lib/pricing-policy.ts`实现旧“所选品质校验”和100边界；当前对象尚未区分项目词条定义、SKU局部词条副本与引用，也没有Part继承屏蔽/恢复意图。`lib/series-gantt-query.ts`与`lib/series-pull-planning.ts`按拉力节点组织覆盖，不具备按Part和01.x顺序合并连续重量段的目标态。

## 3. 分阶段实施

### 阶段A：v23数据模型与只读适配

新增Schema v23：

- `SeriesPartRevision`：partType、fishingMethod、materialType、functionProfile/intensity、统一词条、Technology、weightBand选择；
- `SkuDrawerRevision`：partId、weightBandId、functionTemplateRef、输入指纹、有效/失效状态、局部词条意图、推荐/实际品质；
- `ProjectAffixDefinition`、`SkuLocalAffixCopy`、稳定引用判别联合；
- 历史v9/v22分支保持原Payload与读取语义。

验收：旧数据能读；无法唯一映射的记录进入复核/失效，不按名称、范围或拉力猜测；`22→23`执行两次无变化；历史Snapshot字节与hash不变。

### 阶段B：04.5唯一匹配与SKU派生内核

实现唯一键：

```text
partType + weightBandId + fishingMethod + materialType
+ functionProfile + functionIntensity
```

零/多匹配fail-closed。唯一匹配后，以04.5基准和`effectiveSkuEntries`的add/multiply派生SKU最终拉力；禁止直接输入拉力。Part变化重新匹配并重算已有SKU，保留SKU局部意图。

验收覆盖唯一、零、多匹配；Part变化后有效与失效；Technology/直接引用稳定ID去重；屏蔽、恢复、增加、局部副本；ModelPatch四种拉力操作全部拒绝。

### 阶段C：领域动作与API

建议动作：

- `create_series`只创建Series与1～3个Part，不接收目标拉力；
- `update_part_configuration`；
- `preview_weight_band_skus`：只读返回匹配和现有SKU；
- `create_sku`：显式创建，同Part同段允许多个；
- `add_sku_affix`、`remove_inherited_affix`、`restore_inherited_affix`、`copy_sku_local_affix`；
- `create_project_affix`：完整编辑浮窗创建项目词条；
- `set_sku_actual_quality`：采纳推荐或人工覆盖并保存理由。

废止目标态对`/api/skus/target-pull`的调用；历史接口只在明确兼容边界读取旧数据，不得继续创建v23对象。所有写动作绑定expected revision、inputHash和幂等键。

### 阶段D：品质推荐、实际品质与定价

按`(Σ有效词条价值评分 + Σ同部位无序组合评分) × 功能定位评分系数`即时重算。区间统一`[min,max)`；99.999可推荐S，100及以上无推荐。保存推荐、实际品质、覆盖状态和理由；定价使用实际品质，Trace保留推荐依据。

### 阶段E：UI与甘特图

Series编辑区集中展示1～3个Part卡片。点击重量段先进入现有SKU列表/新增预览，不静默创建。SKU词条区支持增加、屏蔽、恢复、局部复制修改、Technology和新增项目词条。

甘特图按Part和01.x顺序合并相邻段，缺段拆分；连续矩形点击后仍选择具体重量段。视觉合并不改变SKU数据。

### 阶段F：项目Excel往返

提供完整替换与按稳定ID合并；导出当前完整项目数据并在约定范围无损回导。导入/UI新增/内置数据同资格。已引用稳定ID不可换ID，其他业务字段按领域动作CRUD。失败不得留下半导入，重试幂等并写后回读。

## 4. 建议代码落点

- 类型与迁移：`lib/types.ts`、`lib/migrations.ts`、`lib/legacy-product-migration.ts`
- 04.5与派生：新建独立匹配/派生模块，逐步替代`lib/projection-matcher.ts`目标态调用
- Series/SKU命令：`app/api/series/route.ts`、新Part/重量段/SKU/词条路由；旧`app/api/skus/target-pull/**`降为历史兼容
- 词条/品质/定价：`lib/affix-engine.ts`、`lib/quality-value-policy.ts`、`lib/model-pricing-evaluation.ts`、`lib/pricing-policy.ts`
- 甘特与UI：`lib/series-gantt-query.ts`、`lib/series-pull-planning.ts`、`app/SeriesGanttWorkbenchV3.tsx`、`app/V3FlowWorkbench.tsx`
- 保存边界、候选、AI与导出消费：`lib/api-command-boundaries.ts`及所有`targetPullKg`读取方

## 5. 必测场景

- 正常：1～3个非重复Part；唯一04.5；同Part同段多个SKU；继承与局部词条；推荐与实际品质一致。
- 边界：单Part、三个Part、空词条、99.999、100、重量段首尾、局部副本来源更新。
- 冲突：重复Part、04.5零/多匹配、未知词条ID、Technology重复、实际品质覆盖无理由、Excel稳定ID冲突。
- 冻结：Part/词条/策略更新只产生新revision或UpgradeCandidate；旧Snapshot、v9/v22 payload与hash不变。
- 迁移：真实或脱敏v9/v22形状迁到v23；未知字段保留；第二次迁移无变化；失败可恢复。
- 项目Excel：完整替换、稳定ID合并、冲突原子失败、导出回导等价。

## 6. 完成门槛

实现阶段按普通业务、持久化迁移和用户可见变更分别完成定向测试、typecheck、lint、相关测试、迁移边界/失败恢复/幂等/写后回读及统一视觉检查；形成稳定PR候选后再对同一精确head/base执行完整CI。任何验收不得以旧`targetPullKg`最近匹配通过来冒充目标态。
