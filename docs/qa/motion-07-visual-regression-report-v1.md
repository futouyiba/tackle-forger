# MOTION-07 视觉回归、性能与因果理解验收报告 v1

> 对应 Issue: #147
> 验收日期: 2026-07-25
> 规范: `docs/ux/tackle-forger-motion-experience-requirements-v1.md` §11
> 基线 commit: 当前 main HEAD
> 状态: **部分完成** — 自动化验收全部通过；MOTION-02/04/05 阻塞的实机视觉证据和真人因果理解测试待后续完成

## 1. 自动化测试覆盖矩阵

### 1.1 MotionPresentation 内核（MOTION-01）

| 测试 | 状态 | 文件 |
| --- | --- | --- |
| 权威顺序与重复 sequence 拒绝 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 播放/暂停/继续位置保留 | ✅ PASS | `tests/motion-presentation.test.ts` |
| skip 与 reduced-motion 等价 | ✅ PASS | `tests/motion-presentation.test.ts` |
| cancel/revision 终止语义 | ✅ PASS | `tests/motion-presentation.test.ts` |
| cancelled/superseded 不可恢复 | ✅ PASS | `tests/motion-presentation.test.ts` |
| FakeClock 确定性五阶段推进 | ✅ PASS | `tests/motion-presentation.test.ts` |
| timing profile 分类（establish/patch/boundary/cost/normal） | ✅ PASS | `tests/motion-presentation.test.ts` |
| pause/cancel/skip/dispose 回调清理 | ✅ PASS | `tests/motion-presentation.test.ts` |
| reduced-motion 直接显示完整证据 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 8 来源标准用例 2.25–2.45s | ✅ PASS | `tests/motion-presentation.test.ts` |
| 无 command/network/persistence 导入边界 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 开发 fixture 生产环境排除 | ✅ PASS | `tests/motion-presentation.test.ts` |
| §6.3 focus gate 窗口合规 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 8 项 cost/Patch 来源刚好填满预算 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 混合 boundary/rounding/normal 在预算内 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 9/12 来源压缩后 focus gate 仍在窗口内 | ✅ PASS | `tests/motion-presentation.test.ts` |
| ≥13 来源代表性高速播放路径 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 13/16/20/32 来源均在 2.5s 硬上限内 | ✅ PASS | `tests/motion-presentation.test.ts` |
| effectivePlaybackPhaseDuration 独立缩放 | ✅ PASS | `tests/motion-presentation.test.ts` |

### 1.2 MOTION-07 新增验收测试

| 测试 | 状态 | 文件 |
| --- | --- | --- |
| 全状态快照确定性（逐相位两次独立运行一致） | ✅ PASS | `tests/motion-presentation.test.ts` |
| 七种 MotionStatus 全覆盖 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 动效/无动效等价性（播放/跳过/reduced-motion） | ✅ PASS | `tests/motion-presentation.test.ts` |
| 重播零副作用（reducer 纯函数 + model 不可变） | ✅ PASS | `tests/motion-presentation.test.ts` |
| 跳过/重播循环不产生额外写请求 | ✅ PASS | `tests/motion-presentation.test.ts` |
| 性能边界批量验证 [4,6,8,10,12,16,24,32] | ✅ PASS | `tests/motion-presentation.test.ts` |
| 全状态 evidence 保留（七种 status） | ✅ PASS | `tests/motion-accessibility.test.ts` |
| live region 六种状态转换覆盖 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| frozenEvidenceNotice 仅 cancelled/superseded 阻断 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| resolveReducedMotion OS 优先策略 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| 性能基准 8 种规模全在 2.5s 内 | ✅ PASS | `tests/motion-benchmark.test.ts` |
| 代表性高速播放缩放因子合法 | ✅ PASS | `tests/motion-benchmark.test.ts` |
| 混合场景性能预算正确 | ✅ PASS | `tests/motion-benchmark.test.ts` |

### 1.3 MotionAccessibility（MOTION-06）

| 测试 | 状态 | 文件 |
| --- | --- | --- |
| reduced-motion 解析 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| 键盘快捷键与编辑控件保护 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| live-region 阶段播报（不携带逐项数值） | ✅ PASS | `tests/motion-accessibility.test.ts` |
| 取消/revision 后完整冻结证据 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| 冻结 revision 标记 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| 灰阶下文本/形状语义 | ✅ PASS | `tests/motion-accessibility.test.ts` |
| Demo 组件 ARIA/焦点/reduced-motion 静态检查 | ✅ PASS | `tests/motion-accessibility.test.ts` |

## 2. 性能基准数据

使用 FakeClock 零延迟调度测量（不测量真实墙钟），验证所有规模的调度预算都在 2.5s 硬上限内。

| 来源数 | 可行 | handoffScale | focusScale | repScale | 序列化总计 | 实际总计 | 证据保留 | 在预算内 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | ✅ | 1.000 | 1.000 | - | 1090ms | 1310ms | 4 | ✅ |
| 6 | ✅ | 1.000 | 1.000 | - | 1580ms | 1800ms | 6 | ✅ |
| 8 | ✅ | 1.000 | 1.000 | - | 2105ms | 2325ms | 8 | ✅ |
| 10 | ✅ | 0.500 | 1.000 | - | 2630ms | 2500ms | 10 | ✅ |
| 12 | ✅ | 0.000 | 0.000 | - | 3120ms | 2500ms | 12 | ✅ |
| 16 | ⚠️ | 0.000 | 0.000 | 0.5468 | 4170ms | 2500ms | 16 | ✅ |
| 24 | ⚠️ | 0.000 | 0.000 | 0.3677 | 6200ms | 2500ms | 24 | ✅ |
| 32 | ⚠️ | 0.000 | 0.000 | 0.2759 | 8265ms | 2500ms | 32 | ✅ |

**压缩行为说明:**
- 4–8 来源：无压缩，focus gate 保持 §6.3 原始窗口
- 10 来源：交接 phase（source/explanation/evidence）开始压缩
- 12 来源：交接 phase 归零，focus gate 退至 floor（impact≥90ms, main≥100ms）
- ≥13 来源：进入代表性高速播放路径，所有 phase 统一缩放，完整证据保留

**验证:`npm test` 中运动相关测试共 41 项全部通过。**

## 3. 发布门槛验收对照

| 规范 §11 条目 | 状态 | 证据 |
| --- | --- | --- |
| 1. 真实 Trace 驱动 | ✅ | `TraceSettlementPanel.tsx` 消费 `CalculationTraceEntry`；`MotionPresentationModel` 从冻结 Trace 构建 |
| 2. 正常、边界、冲突、恢复、权限、历史冻结测试 | ✅ | 41 项自动化测试覆盖全部状态和路径 |
| 3. reduced-motion、键盘、缩放、屏幕阅读器 | ✅ | `motion-accessibility.ts` + ARIA 静态检查 + CSS media query |
| 4. 目标 Chromium 环境性能记录 | ⚠️ 待 MOTION-02/04/05 | 调度预算验证已完成；实机性能需真实环境 |
| 5. 跳过/重播不产生外部副作用 | ✅ | 自动化证据：无导入边界 + 5 轮 skip/replay 循环状态可预测 |
| 6. 有/无动效结果、Issue、revision、hash 一致 | ✅ | 动效/无动效等价性测试：三条路径相同 evidence |

## 4. 未覆盖项

以下项因依赖未完成的 MOTION-02 (#144)、MOTION-04 (#145)、MOTION-05 (#146) 而暂无法自动化验收：

| 项目 | 阻塞 Issue | 说明 |
| --- | --- | --- |
| 飞书编排视觉证据（待拉取→拉取→发布各阶段） | #144 | 需等 MOTION-02 实现后才能捕捉各阶段状态的确定性快照 |
| 候选生成阻断/恢复视觉证据 | #145 | 需等 MOTION-04 实现 |
| Snapshot 冻结与 UpgradeCandidate 差量视觉证据 | #146 | 需等 MOTION-05 实现 |
| 实机 Chromium 性能记录 | #144 #145 #146 | 调度预算验证已完成（FakeClock），真实设备帧率/卡顿需在完整工作台中测量 |
| 5 人因果理解测试 | #144 #145 #146 | 测试脚本已准备（见 §5），但完整流程需 MOTION-02/04/05 均可交互后才能执行 |

## 5. 因果理解测试脚本

以下脚本设计为轻量可用性测试，在 MOTION-02 完成后的完整工作台环境中执行。测试人不需领域知识。

### 测试设置

- 环境：目标 Chromium 浏览器，完整工作台（含飞书编排、属性结算、候选生成、快照冻结）
- 测试人：至少 5 人，不要求事先了解 Tackle Forger
- 时长：每人约 10–15 分钟
- 记录方式：观察 + 简短问答

### 任务 A：显式拉取不等于发布

1. 打开工作台，观察初始状态。
2. 问："你觉得现在页面上有没有已经自动从飞书同步了数据？"（正确答案：没有，显示的是"待连接/待拉取"）
3. 引导测试人点击"从飞书拉取规则"。
4. 观察拉取完成后页面显示的阶段（应为"RuleSet 草稿/待发布"，不是"已发布"）。
5. 问："现在数据已经发布了吗？还需要做什么？"（正确答案：还没发布，需要显式点击发布）
6. 引导测试人点击发布，观察发布后状态变化。

**通过标准：测试人能说出"拉取不等于发布，需要再点一次发布才算"或等价表述。目标 5 人中至少 4 人通过。**

### 任务 B：指出最后一次属性变化的来源与 delta

1. 进入一个已有完整 Trace 的 Model（至少 4+ 个来源）。
2. 引导测试人点击"属性高速结算"播放按钮。
3. 让结算完整播放（约 2–2.5 秒）。
4. 问："刚刚数字最后是从多少变成多少的？"（验证能注意到最终锁定）
5. 展开完整 Trace 证据。
6. 问："最后一步算的是什么？从什么变成了什么？"（应指向最后一个 Trace 步骤的 sourceId、before→after 和单位）

**通过标准：测试人能指出最后一个来源的名称或类型，以及 before/after 数值变化。目标 5 人中至少 4 人通过。**

### 记录模板

```
测试人: [编号]
任务 A 通过: [是/否]  备注:
任务 B 通过: [是/否]  备注:
观察:
- 是否在未操作前认为数据已同步？
- 是否注意到播放中的正/负/中性区分？
- 是否在未引导下使用了跳过/重播？
```

## 6. 发布检查清单

在 MOTION-02/04/05 完成并补充验收后，发布前最终检查：

- [ ] `npm test` 全部通过（含 motion 相关 41+ 测试）
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] 实机 Chromium 性能记录完成（无明显持续卡顿）
- [ ] 5 人因果理解测试：任务 A ≥4/5 通过，任务 B ≥4/5 通过
- [ ] 飞书编排状态视觉证据截图已存档
- [ ] 候选阻断/恢复视觉证据截图已存档
- [ ] Snapshot 冻结/UpgradeCandidate 视觉证据截图已存档
- [ ] 200%/400% 缩放不丢失信息
- [ ] 键盘操作完整可用
- [ ] 屏幕阅读器播报节制且正确
- [ ] 本报告更新为最终版，移除所有"待完成"标记

## 7. 执行命令

```powershell
# 运行全部 motion 测试
npx tsx --test tests/motion-presentation.test.ts
npx tsx --test tests/motion-accessibility.test.ts
npx tsx --test tests/motion-benchmark.test.ts

# 运行完整测试套件
npm test
npm run typecheck
npm run lint
```
