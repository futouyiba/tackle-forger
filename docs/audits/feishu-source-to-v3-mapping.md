# 飞书源工作簿 sheet ↔ v3 spec 概念 ↔ 代码实现位置 三方映射表

> 生成日期：2026-07-24
> 基线 commit：`eebd0c74a471dcf860cff3196b8d57448b51bbaf`（`git rev-parse HEAD`）
> 生成者：Claude 自动审计，只读现有文件
> 2026-07-26 校对：核对至 `d38d6a8`，pricing 区域（`33IGHy`/`34KaIv`/`35bCfX`）按 `4e77a3e` 更新；其余映射经 #191 旧表清理后仍准确。

## 数据源

1. **飞书源工作簿**（权威规则源·原始设计稿）：
   - spreadsheet-token = `WQ8wstS4ch29E2tAKnVcoh5KnJg`
   - 50 张 sheet，按 `00_系统接入` → `19_Patch台账` 编号；竿/轮/线拆为独立子表（`01.0/01.1/01.2` 等）。
   - 每张表只读了表头 + 1~2 行样例（`A1:Z3`），未读全表。
2. **v3 spec**：`docs/tackle-forger-development-spec-v3.md`（唯一权威规范，术语见 §2）。
3. **代码**：仓库**根目录** `lib/*.ts`（约 95 个领域模块）、`app/**/*.tsx`（工作台）与 `app/api/**/route.ts`（API）、`tests/*.test.ts`。
   - ⚠️ `apps/web/src/` 与 `packages/` 是被 `lint --ignore-pattern` 忽略的废弃 mock 原型，本表**不参考**。

## 阅读指南

- 列：`# | 源表sheet | sheet_id | 装什么 | v3 spec概念(节号) | 代码位置(根lib/app) | 实现状态 | 备注`。
- **实现状态**图例：
  - ✅ 已实现 — 有专门 lib 模块 + 测试 + 工作台/API，语义与 spec 对齐。
  - 🟡 部分 — 有实现但受 spec 明确限制（如仅预览、写回禁用、源表空）。
  - ❌ 未实现 — 代码中找不到对应。
  - 📋 仅源表 — 源表是样例/示意图/飞书侧暂存，spec 明确不作为领域实体或权威输入。
- “代码位置”给到关键文件（多个用 `、` 分隔），未穷尽全部引用点。
- 本表（WQ8w）即 spec §14 当前的权威主工作簿；spec §14 历史引用的 YsEKw 是切流前的旧表（仅审计区保留拓扑证据）。映射按**概念语义**对应，不按表号或 sheet_id 对应。

## 映射表

| # | 源表sheet | sheet_id | 装什么（列摘要/1句） | v3 spec概念(节号) | 代码位置(根lib/app) | 实现状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 00_系统接入 | `0iGCcx` | 系统接入约定：唯一权威工作簿、每次拉取记录 revision | §0 文档权威 / §14 飞书治理 | `feishu-workbook.ts`、`workbook-governance.ts`、`data-sources.ts`、`feishu-sheets.ts` | ✅ | 本表（WQ8w）即 spec §14 当前的权威主工作簿；YsEKw 是切流前的历史合并表（§14 审计区保留） |
| 2 | 01.0_重量模板-竿 | `1cAihB` | 竿 16 级重量段基准面板：竿拉力/抛投距离/耐久/感度/长度/自重/饵重/调性/硬度 等 | §2 WeightTemplate / §5 DerivedProjection / §21.3 W 重量段 | `five-axis-weight-band-policy-source.ts`、`five-axis-formal.ts`、`five-axis.ts`、`types.ts`、`seed.ts`、`v3-seed.ts` | ✅ | WQ8w 按竿/轮/线分 3 子表（旧 YsEKw 是单表 3 块 竿3-18/轮21-36/线39-54，历史）。W 段上界 `1.5/3.8/12.6/25.9/82.5/null` |
| 3 | 01.1_重量模板-轮 | `2KCCHR` | 轮 16 级基准：轮拉力/传动比/绕线量/线径/积热散热/摩擦截面数 等 | §2 WeightTemplate | 同上 | ✅ | 同上 |
| 4 | 01.2_重量模板-线 | `3FYijT` | 线 16 级基准：线拉力/直径/线号/张力/摩擦/延展性 等 | §2 WeightTemplate | 同上 | ✅ | 同上 |
| 5 | 02.0_钓法类型-竿 | `4zXYpP` | 钓法（浮钓/路亚）对竿参数的乘法系数；稳定 ID `fishing_rod_*` | §2 MethodProfile / §3.1 模板与定位层 | `canonical-rule-source.ts`、`rule-kernel.ts`、`rule-workbook-inspection.ts`、`types.ts` | ✅ | spec 称 MethodProfile；`02_钓法类型` 的 `fishing_*` 行是钓法系数权威源 |
| 6 | 02.1_钓法类型-轮 | `5oZXTO` | 钓法对轮参数的系数（样例数据稀疏，钓法列多为 `-`） | §2 MethodProfile | 同上 | ✅ | 源表样例多数为 `-`，实际语义由稳定 ID 驱动 |
| 7 | 02.2_钓法类型-线 | `6FwSyV` | 钓法对线参数的系数（同上稀疏） | §2 MethodProfile | 同上 | ✅ | 同上 |
| 8 | 02.5.0_钓法模板-竿 | `7ygxLI` | 重量模板 × 钓法的派生结果（`fshg_rod_*`，BOUND） | §3.1 Method-layer Patch / §14 `02.5` 写回 | `canonical-rule-source.ts`、`rule-workbook-inspection.ts` | 🟡 | spec §14（line 940）明确：`02.5` 专用持久化写回命令**尚未提供**，当前是迁移证据，非权威输入 |
| 9 | 02.5.1_钓法模板-轮 | `8pvTQG` | 同上·轮 | §3.1 | 同上 | 🟡 | 同上 |
| 10 | 02.5.2_钓法模板-线 | `9gvEsP` | 同上·线 | §3.1 | 同上 | 🟡 | 同上 |
| 11 | 03.0_类型材质-竿 | `10TyFp` | 竿类型（浮钓竿/台钓竿/直柄竿…）系数 + 维修/购买系数；`type_rod_*` | §2 TypeProfile / §20.1 维修·购买系数 | `canonical-rule-source.ts`、`rule-kernel.ts`、`types.ts`、`pricing-policy.ts` | ✅ | spec 称 TypeProfile；维修/购买系数参与 §20.1 定价（当前种子值均为 1） |
| 12 | 03.1_类型材质-轮 | `11CfXW` | 轮类型（纺车轮/水滴轮）系数 | §2 TypeProfile | 同上 | ✅ | 同上 |
| 13 | 03.2_类型材质-线 | `12VetE` | 线类型（尼龙线/氟碳线）系数 | §2 TypeProfile | 同上 | ✅ | 同上 |
| 14 | 03.5.0_类型模板-竿 | `13awql` | 钓法模板 × 类型 的派生（`tppl_rod_*`，BOUND） | §3.1 Method×Type Patch / §5 | `canonical-rule-source.ts`、`rule-workbook-inspection.ts` | 🟡 | 同 02.5：派生结果的飞书镜像，写回工作流未上线 |
| 15 | 03.5.1_类型模板-轮 | `14rhyG` | 同上·轮 | §3.1 | 同上 | 🟡 | 同上 |
| 16 | 03.5.2_类型模板-线 | `15nsqs` | 同上·线 | §3.1 | 同上 | 🟡 | 同上 |
| 17 | 04.0_功能定位-竿 | `16qYVn` | FunctionProfile 强度行（`泛用\|1`、`远投\|1`）+ 评分系数 + 覆盖重量段/适用类型；`func_rod_*` | §2 FunctionProfile / §4.2 functionIntensity / §12.1 scoreFactor | `model-candidate-generation.ts`、`compatibility.ts`、`quality-value-policy.ts`、`types.ts` | ✅ | `funcgrp_*` 是部件内稳定外键；父级 ID 在 `04.00` 常量表。`postMatchContributions` 在结构标杆匹配后应用 |
| 18 | 04.1_功能定位-轮 | `17jqiE` | 同上·轮 | §2 FunctionProfile | 同上 | ✅ | 同上 |
| 19 | 04.2_功能定位-线 | `18pjcZ` | 同上·线 | §2 FunctionProfile | 同上 | ✅ | 同上 |
| 20 | 04.00_FunctionProfile常量 | `19XKzU` | FunctionProfile 父级定义：`function:all_round` 等，`supportedIntensities`、核心定义/优势/代价、三部位 group ID | §2 FunctionProfile / §4.2 / §14 父 ID 权威 | `model-candidate-generation.ts`、`types.ts`、`compatibility.ts` | ✅ | 源表为 2026-07-24 taxonomy review（rev 4227）产物。spec §14（line 938）：父 ID 权威，`func_*` 仅强度行，禁止按 displayName 聚组 |
| 21 | 04.5.0_功能模板-竿 | `20OOnC` | 重量模板 × 钓法 × 类型 × 功能定位 的派生（`fcpl_rod_*`，BOUND） | §3.1 / §5 StructuralBenchmark / DerivedProjection | `projection-matcher.ts`、`engine.ts`、`calculation-trace.ts`、`types.ts` | ✅ | 源表持久化了派生结果；spec §5.1 称 StructuralBenchmark「按需计算并缓存，不预先持久化」——飞书侧为审核镜像，运行时以计算为准 |
| 22 | 04.5.1_功能模板-轮 | `21kEvM` | 同上·轮 | §5 | 同上 | ✅ | 同上 |
| 23 | 04.5.2_功能模板-线 | `22RAak` | 同上·线（含 `#N/A` 脏数据） | §5 | 同上 | ✅ | 源表样例第 2 行 `竿拉力=#N/A`，导入需走迁移复核 |
| 24 | 05_词条 | `23CsXE` | Affix：属性/被动词条，加/减百分比，改变值（万分比），价值评分，生成稀有档位，公式说明 | §2 Affix / §11.1 分类 / §11.3 叠加 / §12.1 价值分 | `affix-engine.ts`、`reduction-stacking-policy.ts`、`quality-value-policy.ts`、`types.ts` | ✅ | spec 称 Affix；规范 operation 为 `percent_adjust/flat_adjust/clamp_add/enum_add/set`。源表「加百分比/减百分比」是旧输入别名 |
| 25 | 06_技术 | `24YDSO` | Technology：词条命名组合包，组成词条，正/负/净分，适合功能 | §2 Technology / §11.2 | `affix-engine.ts`、`compatibility.ts`、`types.ts` | ✅ | spec 称 Technology；只展开成员 Affix 贡献属性与价值分，本身不重复计分 |
| 26 | 07_系列 | `25UnTC` | Series 原型：入门·泛用 等，包含技术、推荐竿类型、推荐功能定位；`series_rod_*` | §2 Series / §6.2 / §7 不变量 | `product-model.ts`、`types.ts`、`seed.ts`、`v3-seed.ts` | ✅ | 源表实体类型 `SeriesArchetype`。spec §6.2 要求 Series 固定 method/type/quality/coreFunction/核心词条家族等 |
| 27 | 08.0_品质评分-公式 | `26gpIF` | 公式：`最终评分 = (∑词条价值+∑组合评分) × 功能定位_评分系数` | §12.1 finalValueScore / baseAffixScore | `quality-value-policy.ts` | ✅ | 公式形态与 spec §12.1 一致；spec 另要求 Performance 不参与计分 |
| 28 | 08.1_品质评分-品质定义 | `27hboC` | Quality 区间（C/绿 0-20、B/蓝 20-40…）+ 最小/最大价格系数 | §4.1 QualityProfile / §12.1 / §20.1 QualityPricingBasketMapping | `quality-value-policy.ts`、`pricing-policy.ts` | ✅ | spec §12.1 已决 S 为 `[65,100]` 含 100；若源表仍为旧 `[65,100)`，导入产生 `QUALITY_RANGE_SOURCE_OUTDATED`，飞书修订前禁止发布新策略 |
| 29 | 08.2_品质评分-词条组合 | `28fQhg` | affix × affix 组合评分矩阵（双列 `词条1/词条2`） | §12.1 combinationScore / 组合矩阵 | `quality-value-policy.ts` | ✅ | spec 称「07_品质评分 还提供竿/轮/线三张组合矩阵」。源表仅一张通用；`—` 对角线不产生组合，显式 `0` 是合法值 |
| 30 | 09.0_价格计算-公式 | `31RxeB` | 竿/轮/线维修价格公式（基础维修价 × 维修系数 × 评分插值） | §20.1 PricingPolicy | `pricing-policy.ts` | ✅ | spec §20.1 公式更精细：维修/购买分别舍入、购买价用未舍入维修价、最低价 100 仅作用于购买价 |
| 31 | 09.1_价格计算-参数释义 | `32BmZs` | 定价参数键释义：`score_interpolation_policy`、`rod_parts_to_whole_ratio` 等 | §20.1 PricingExecutionPolicy | `pricing-policy.ts`、`types.ts` | ✅ | spec 把执行策略显式化为 `PricingExecutionPolicy`（3 位有效数字向下取整、阈值 3 亿软确认） |
| 32 | 09.2_价格计算-维修消耗速度 | `33IGHy` | 维修消耗速度 × 钓具大类 × 重量段 × 品质；列含「零正比」（笔误零整比） | §20.1 维修消耗速度 / 零整比 | `pricing-policy.ts`、`rule-workbook-inspection.ts` | ✅ | 源表列名「零正比」为笔误，规范为「零整比」；PR2b-3（4e77a3e）后代码从 33IGHy 读取维修价格与零整比，行格式 `(part, weight, quality, maintenance, ratio)` |
| 33 | 09.3_价格计算-部件占比 | `34KaIv` | 部位占比（**表头为空**，未填数据） | §20.1 部位占比 | `pricing-policy.ts` | 🟡 | 34KaIv 当前为 `staging_output`、不参与导入；spec §20.1 要求「部位占比(part, pricingWeightBandId)」入定价公式与 Trace。PR2b-3（4e77a3e）：现行策略从 33IGHy 读取维修价/零整比，并为部位占比生成值=`1` 的显式身份默认项 |
| 34 | 09.4_价格计算-各部位全损时间-零整比 | `35bCfX` | 全损时间 / 零整比（**表头为空**，未填数据） | §20.1 全损时间 / 零整比 | `pricing-policy.ts` | 🟡 | 35bCfX 当前为 `staging_output`、不参与导入；spec 明确「零整比不得为 0」。PR2b-3（4e77a3e）：现行策略从 33IGHy 读取零整比，并为全损时间生成值=`1` 的显式身份默认项 |
| 35 | 10_钓具甘特图示意 | `36GGVk` | 品质 × 钓具类型 × 重量段 的系列覆盖示意（`系列 SA1…`） | §23 系列甘特图（语义不同） | `series-gantt-query.ts`、`series-pull-planning.ts`、`app/SeriesGanttWorkbenchV3.tsx`、`app/api/series-gantt/route.ts` | 📋 | spec §14（line 944）明确此类甘特表「是开发计划表/示意图，不是数据源，也不新增领域实体」。代码的系列甘特图是动态规划视图，语义不同 |
| 36 | 11.0_校验规则-枚举 | `37YLZE` | 枚举值：鱼重等级（微物…超级巨物）、钓具大类（竿/轮/线） | §13 校验 / §10.1 ParameterDefinition / §14.3.1 枚举 | `validation-issues.ts`、`rule-kernel.ts`、`types.ts` | ✅ | |
| 37 | 11.1_校验规则-竿组 | `38LXDQ` | 竿/轮/线 组合约束：类型、功能定位、系列匹配 | §9.1 硬兼容 Rod×Reel×Line 闭环 / §13 | `compatibility.ts`、`validation-issues.ts`、`part-constraints.ts` | ✅ | |
| 38 | 11.2_校验规则-竿 | `39IhAP` | 竿参数范围：竿长/饵重/调性/硬度 min~max | §13 / §10 ParameterDefinition | `validation-issues.ts`、`rule-kernel.ts` | ✅ | |
| 39 | 11.3_校验规则-轮 | `40RwxO` | 轮参数范围：轮尺寸/传动比/线容量/线径 | §13 / §10 | 同上 | ✅ | |
| 40 | 11.4_校验规则-线 | `41CgUB` | 线参数范围：线长/线径/隐蔽性 | §13 / §10 | 同上 | ✅ | |
| 41 | 12.0_组合SKU-竿 | `42ACks` | 竿 SKU 样例行（`FW-01-R`，含评分/品质/拉力/价格） | §6.3 SKU Drawer / §6.4 Model | `product-model.ts`、`publishing.ts`、`sku-target-pull-change.ts`、`types.ts` | 📋 | spec §14（line 944）：`11_组合SKU` 当前为「历史样例/映射参考/飞书侧暂存」，**不覆盖**工具内 Series/SKU/Model 真相 |
| 42 | 12.1_组合SKU-轮 | `43dYFE` | 轮 SKU 样例（`FW-01-W`） | §6.3 / §6.4 | 同上 | 📋 | 同上 |
| 43 | 12.2_组合SKU-线 | `44YIZT` | 线 SKU 样例（`FW-01-L`） | §6.3 / §6.4 | 同上 | 📋 | 同上 |
| 44 | 13_打包竿组 | `45qauz` | 竿组打包：竿组ID → 竿ID + 轮ID + 线ID + 竿组价格 | §9.1 Rod×Reel×Line 闭环 / §6.3 | `compatibility.ts`、`product-model.ts` | 📋 | spec §14：飞书侧暂存输出，非权威；代码侧由硬兼容与 SKU/Model 链路表达 |
| 45 | 14_上传发布 | `46ogtj` | 字段 → 映射工作簿/工作表/字段 的发布映射表 | §14 版本/快照/飞书治理 / §25 发布导出 | `publishing.ts`、`config-export.ts`、`config-export-mapping.ts`、`config-export-companion.ts` | 🟡 | 源表是字段映射清单；spec §25 发布末端两步，**一期仅 `NON_FORMAL` 预览**，正式交付为 1.5 期 |
| 46 | 15_Rods | `47PfUw` | 游戏 Rods 配置表 schema：前 1 行类型（INT64/STRING…）、第 2 行英文字段、第 3 行中文释义（含 `#RodSubType`、`#HardnessType`、`ActionType`） | §25 配置表交付（tackle.xlsx） | `config-preview-package.ts`、`config-export.ts`、`browser-config-export.ts`、`app/OperationalConfigExportWorkbench.tsx` | 🟡 | 一期仅 `NON_FORMAL` 预览包；游戏侧枚举 `RodSubType/HardnessType/ActionType` 在代码中未实现（Grep 无命中），与 spec §25「正式配置表为 1.5 期」一致 |
| 47 | 16_Reels | `48IxFG` | 游戏 Reels 配置表 schema（`#ReelSubType`、传动比、摩擦截面数、张力系数） | §25 | 同上 | 🟡 | 同上；`#ReelSubType` 等游戏枚举未实现 |
| 48 | 17_Lines | `49kgpf` | 游戏 Lines 配置表 schema（`#LineSubType`、直径、透明度、隐蔽性） | §25 | 同上 | 🟡 | 同上 |
| 49 | 18_Item | `50Yure` | 游戏 Item 配置表 schema：`#ItemType`、`#ItemSubType`、道具品质、锚定价格、堆叠 | §25（item.xlsx）/ §6.4 ConfigurationSnapshot | 同上 | 🟡 | 同上；spec §25 要求 store.xlsx 强制 `GoodsBasic` + `StoreBuy`，当前仅预览 |
| 50 | 19_Patch台账 | `51FogM` | Patch 镜像工作表（**前 3 行全空**，表头未填） | §14.1 Patch 权威账本与飞书台账 / §14.4 远端 schema / §8 Patch | `patch-ledger.ts`（运行时权威）、`patch-authority.ts`、`patch-engine.ts`、`patch-offset-policy.ts`、`feishu-proposal.ts` | 🟡 | 运行时 `PatchLedger` 已实现且为权威；飞书镜像 spec §14.4（line 1098）明确「当前仍为空表，真实镜像写入/拉取保持禁用，不得伪造 SYNCED」 |

## 关键差异 / 缺口汇总

1. **WQ8w 是当前唯一权威主工作簿**（50 张分表）。spec §14 历史引用的 YsEKw（wiki，约 18 张合并表）是切流前的旧表，§14 审计区保留其拓扑作历史证据；本表（WQ8w）映射按**概念语义**对应，不按表号或 sheet_id 对应。

2. **品质 S 区间源表过期**。源表 `08.1` 可能仍写 `[65,100)`；spec §12.1 已决 `S=[65,100]` 含 100（评分 100 属 S，>100 报 `QUALITY_SCORE_OUT_OF_RANGE`）。飞书机器源修订并显式拉取前，导入器产生 `QUALITY_RANGE_SOURCE_OUTDATED`，旧 Draft 禁止发布为新正式 `QualityValuePolicyVersion`。代码 `quality-value-policy.ts` 已按新契约。

3. **02.5 / 03.5 派生模板写回未上线**。源表 `fshg_*/tppl_*` 行标记 `BOUND`，看似已持久化；但 spec §14（line 940）明确「`02.5` 专用持久化写回命令尚未提供」，当前 rev `4226→4227` 的写入与技术回读**仅是迁移证据**，不得宣称为该工作流已上线。代码侧以运行时演绎为权威。

4. **09.3 部位占比 / 09.4 全损时间-零整比 当前为 staging_output**。两张表不参与导入（表头未填）；spec §20.1 把「部位占比」「全损时间」「零整比」列为定价公式必填输入。PR2b-3（4e77a3e）后，现行策略从 `33IGHy` 读取维修价/零整比，并为部位占比与全损时间生成值=`1` 的显式身份默认项，构造完整输入，可正式发布 `PricingPolicyVersion`；未来启用 `34KaIv/35bCfX` 时再通过独立切流替换默认项。

5. **10_甘特图示意 ≠ 系列甘特图领域实体**。源表名带「示意」，是品质×类型×重量段的静态系列覆盖图；spec §14（line 944）明确此类表「是开发计划表/示意图，**不是数据源，也不新增领域实体**」。代码的系列甘特图（`series-gantt-query.ts` + `SeriesGanttWorkbenchV3.tsx`）是 spec §23 定义的动态规划/导航视图，二者语义不同。

6. **12 组合SKU / 13 打包竿组 是飞书侧暂存样例**。spec §14（line 944）明确 `11_组合SKU`、`12_打包竿组`「当前作为历史样例、映射参考或飞书侧暂存输出，**不能反向覆盖** Tackle Forger 中的 Series、SKU、Model 与 Snapshot 真相」。工具内 SKU/Model 是独立领域实体（`product-model.ts`、`types.ts`），不由这些样例行驱动。

7. **15-18 Rods/Reels/Lines/Item 配置表为 1.5 期正式交付**。源表给出游戏侧完整 schema（含 `#RodSubType`、`#HardnessType`、`#ItemType` 等枚举）；spec §25 定义正式 `tackle.xlsx/item.xlsx/store.xlsx` 交付为 1.5 期，一期仅 `NON_FORMAL` 预览包。代码 `config-preview-package.ts`/`browser-config-export.ts` 实现了预览，但游戏侧枚举类型在代码中**未实现**（Grep `RodSubType/ReelSubType/LineSubType` 无命中），与 spec 分期一致。

8. **19_Patch台账 飞书镜像禁用中**。源表前 3 行全空；spec §14.4（line 1098）明确「工作表当前仍为空表；在表头、保护边界和联调完成前，真实镜像写入/拉取保持禁用，不得伪造 `SYNCED`」。运行时 `patch-ledger.ts`（64.9K，权威）已完整实现 Patch 账本语义，飞书镜像同步为 🟡 部分（命令边界、哈希契约在 `patch-authority.ts` 已定义，远端联调未开）。

9. **04.5 功能模板「持久化派生」与 spec「不预先持久化」张力**。源表 `fcpl_*` 把「重量模板×钓法×类型×功能定位」的派生结果持久化为 BOUND 行；spec §5.1 称 StructuralBenchmark「按需计算并缓存，不预先持久化其他近乎无限的组合」「缓存不是人工编辑源」。代码以运行时演绎（`projection-matcher.ts`/`engine.ts`）为权威，飞书侧持久化仅作审核镜像。

10. **「性能定位」字段去功能化**。源表多处出现「性能定位」列（如 `12.x` 的「标准工艺\|1」、`08.x` 历史「性能定位」表述）；spec §2/§11.2.1 明确 `PerformanceSummary` 是「结算后的只读派生摘要，不是配置输入或数值贡献层」，不参与价值分（§12.1 禁止读 `performanceScoreFactor`）。代码 `performance-summary.ts` 为只读派生。源表的性能字段属历史/样例，不参与计分。
