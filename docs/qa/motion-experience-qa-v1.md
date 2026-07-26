# MOTION 动效体验 QA 验收报告 v1

> 对应：MOTION-07 (#147)  
> 生成日期：2026-07-26  
> 基线 commit：待填充

## 1. 自动化验证

### 运行命令

```powershell
# 动效验收自动化测试
npx tsx --test tests/motion-acceptance.test.ts

# 表示模型一致性
npx tsx --test tests/motion-presentation.test.ts tests/snapshot-freeze-presentation.test.ts tests/feishu-orchestration-presentation.test.ts

# 全量
npm test
```

### 验证结论

- [ ] 跳过/重播不产生额外写入 — `motion-acceptance.test.ts`
- [ ] 动效/无动效路径 hash 一致 — hash consistency 测试
- [ ] 表示模型确定性 — 所有 presentation model 测试
- [ ] revision 变化 → SUPERSEDED 终端态 — revisionChange 测试

## 2. 视觉证据检查清单

每个状态截图一张，使用 DevTools 截取完整工作台区域。

| 状态 | 如何触发 | 截图 | 检查项 |
|------|---------|------|--------|
| 初始待拉取 | 打开"飞书规则源"页面 | | 四阶段全部 PENDING，无"同步中" |
| 检查完成 | 点击"检查工作簿" | | workbook_identity→已检查，显示 revision |
| 拉取完成 | 点击"显式拉取" | | source_pull→已拉取，显示 revision/hash |
| 草稿就绪 | 点击"创建规则草稿" | | ruleset_draft→草稿已就绪，显示 contentHash |
| 已发布 | 点击"显式发布" | | ruleset_publish→已发布，显示 publicationHash |
| 阻断态 | 检查后存在 registry error | | 红色阻断横幅，列出 issue codes |
| SUPERSEDED | 拉取后 revision 变化 | | 橙色过时横幅，提示重新拉取 |
| reduced-motion | 系统开减少动态 | | 所有阶段直接显示，无过渡动画 |

## 3. 性能基线

### 目标环境

- 设备：办公 Chromium（Windows 10/11）
- 网络：公司内网
- 屏幕：1920×1080

### 测量指标

| 指标 | 目标 | 实测 | 
|------|------|------|
| 属性结算总时长（8 来源） | ≤2.5s | |
| 编排阶段过渡（4 阶段） | 每阶段 ≤300ms | |
| reduced-motion 首次渲染 | 与无动效一致 | |
| 连续操作 10 次无卡顿 | 无明显掉帧 | |

### 测量命令

```powershell
# Chrome DevTools Performance 面板录制
# 1. 打开 Performance 面板
# 2. 点击 Record
# 3. 执行"属性高速结算"操作
# 4. 停止录制，查看 FPS 和 Long Tasks
```

## 4. 5 人轻量因果理解测试

### 测试脚本（约 5 分钟/人）

1. 请被试者打开"飞书规则源"页面。
2. 问：**"这个页面现在是什么状态？你需要做什么才能获取最新规则？"**
    - 期望：说出"需要点击检查/拉取"，而非"自动同步"
3. 按引导完成：检查 → 拉取 → 创建草稿 → 发布。
4. 问：**"拉取和发布是同一个动作吗？"**
    - 期望：说出"不是，拉取后再发布才生效"
5. 切换到属性结算页面（#103 TraceSettlementPanel）。
6. 执行一次完整结算。
7. 问：**"最后一个数字变化来自哪个来源？增加了多少？"**
    - 期望：能指出最后一条 Trace step 的 layer 和 delta

### 通过标准

- 至少 4/5 人能正确说出"显式拉取不等于发布"
- 至少 4/5 人能正确指出最后一次属性变化的来源与 delta

### 结果记录

| 被试者 | Q2 通过 | Q4 通过 | 备注 |
|--------|---------|---------|------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

## 5. 未执行检查

以下项目依赖 #73（内网部署与真实飞书租户），本报告未覆盖：

- 真实飞书 OAuth 登录流程
- 真实工作簿 revision 拉取与冲突
- 内网 R730 环境性能基线
- 真实配置仓库导出验证

## 6. 已知限制

- `FUNCTION_RULE_CROSS_PART_BINDING` — WQ8w 新工作簿中 04_功能定位列布局与硬编码 `parameterKind` 分类不匹配，需 PR2B 后续处理
- `isBuilding`/`buildError` 在 SnapshotFreezePanel 中固定为 false/null — 待 SnapshotBuild 异步 API 接通后激活
- `reducedMotion` prop 由 CSS `@media (prefers-reduced-motion)` 处理，组件层已移除死代码
