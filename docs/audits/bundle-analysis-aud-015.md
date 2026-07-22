# AUD-015 客户端 Bundle 分析

> 分析日期：2026-07-22
> 基线：`b59e16a3fe05fb00a2ec0757350fcfbdc26489be`
> 构建命令：`npm run build`

## 结论

根因是`app/Workbench.tsx`静态导入六个只在对应页面使用的大型工作台，Vite因此把甘特、V3流程、规则图、规则源、Patch台账和配置导出合入同一个客户端chunk。修复采用页面模块动态入口和React Suspense加载边界，没有提高Vite warning阈值，也没有把领域计算复制到客户端。

## 构建证据

| 指标 | 基线 | 修复后 |
| --- | ---: | ---: |
| 最大`Workbench`客户端chunk | 869,491 B | 101,969 B |
| 最大客户端chunk | 869,491 B | 424,888 B（`xlsx`独立chunk） |
| `SeriesGanttWorkbenchV3` | 合并在869,491 B主chunk | 75,977 B动态入口 |
| 超过500 kB警告 | 有 | 无 |

修复后动态入口包括：`SeriesGanttWorkbenchV3`、`V3FlowWorkbench`、`RuleGraphStudio`、`RuleWorkbookWorkbench`、`PatchLedgerWorkbench`和`BrowserConfigExportWorkbench`。服务端、RSC、客户端和SSR五阶段构建均成功；现有渲染产物测试仍能在拆分后的全部chunk中找到关键工作台文案，证明模块没有从生产产物丢失。

## 持续预算

`tests/bundle-budget.test.mjs`读取生产构建manifest并强制：

- 任一客户端JavaScript chunk不超过500,000 B；
- 六个工作台继续是动态入口；
- `Workbench`入口不超过150,000 B。

预算测试由默认`npm test`在生产构建后执行。预算是对真实产物的回归保护，不修改构建器warning阈值。
