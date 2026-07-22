# 当前工程状态审查复核补充（2026-07-22）

> 文档类型：对[`current-state-review-2026-07-22.md`](./current-state-review-2026-07-22.md)的后续复核，不是产品或领域规范。
> 复核时间：2026-07-22T22:31:55+08:00
> 复核HEAD：`ba2111c2e6021d968606cfe4ee3e839732184d71`
> 对比主线：`origin/main` at `a393c5470a73081967690dab733cf9cc5202cdc1`
> 权威产品语义仍以[`../tackle-forger-development-spec-v3.md`](../tackle-forger-development-spec-v3.md)为准。

## 1. 复核目的

本文件不改写原审查快照记录的Windows工作目录、审查分支和当时Git事实。它负责：

- 将后续代码审查结论映射到稳定`AUD-xxx`；
- 识别重复问题、部分完成状态和遗漏项；
- 记录本次复核工作区与原快照的差异；
- 为后续修复提供单一持续台账入口。

持续状态以[`engineering-issue-register.md`](./engineering-issue-register.md)为准。

## 2. 复核开始时的Git事实

本次复核运行于macOS工作区`/Volumes/Mac DS - Data/SharedProjects/tackle-forger`。开始写文档前确认：

- 本地分支名为`main`，不是本地`review/current-state-2026-07-22`；
- HEAD为`ba2111c2e6021d968606cfe4ee3e839732184d71`；
- `origin/review/current-state-2026-07-22`同样指向`ba2111c2`；
- `origin/main`指向`a393c547`，当前本地`main`相对它ahead 5；
- 工作树已有14份未提交文档修改；这些既有修改在本次整理中被保留，没有回退或覆盖。

因此，原快照中的“Windows工作目录、审查分支、工作树干净、ahead 2”仍可作为当时另一工作目录的历史事实，但不得继续用作当前工作区状态。后续状态变化使用新快照或台账更新，不回写历史段落。

## 3. 与后续审查结论的映射

| 后续结论 | 台账归属 | 复核结果 |
| --- | --- | --- |
| `PUT /api/state`整包保存可绕过冻结对象与领域命令 | `AUD-001` | 已登记，代码仍存在，保持OPEN |
| 五维定义未发布也可能进入新正式Snapshot | `AUD-023` | 原台账遗漏，本次补录为High |
| 后端仍以`targetWeightKg`作为核心目标拉力字段 | `AUD-024` | 原台账遗漏，本次补录为Medium |
| 默认`npm test`遗漏飞书回写测试文件 | `AUD-025` | 测试单独通过，但默认门禁仍遗漏；本次补录为Low |
| 客户端压缩chunk超过500 kB | `AUD-015` | 已登记，保持OPEN |

## 4. 去重与状态调整

### 4.1 AUD-012不再独立计数

`AUD-012`原本总括要求state、Series和导入路由测试，与`AUD-001/002/003/004/007`各自的验收测试重复。它已转为`SUPERSEDED`；具体问题只有在对应路由测试和行为修复同时完成后才能关闭。

### 4.2 AUD-018转为IN_PROGRESS

`ba2111c2`已经完成审计Markdown尾随空格清理，本次复核执行`git diff --check origin/main...HEAD`与工作树`git diff --check`均无错误。但仓库仍缺少`.gitattributes`，跨平台行尾策略尚未固定，因此不能标记`RESOLVED`。

### 4.3 相关但不重复的问题

- `AUD-R003`与`AUD-001`分别管理Series服务端命令和通用整包保存绕过；
- `AUD-R006`、`AUD-021`、`AUD-025`分别管理远端回读恢复、本地审计冲突恢复和默认测试入口；
- `AUD-R007`与`AUD-008/009/013/014`分别管理基础部署能力和剩余运行治理；
- `AUD-005`是架构父决策，`AUD-006/019`在该决策关闭时联动复核，不直接合并。

## 5. 当前计数与验证边界

整理后，持续台账包含：

- 24个有效未关闭问题：21个`OPEN`、1个`IN_PROGRESS`、2个`BLOCKED`；
- 7个`RESOLVED`历史问题；
- 1个`SUPERSEDED`重复问题。

本次只整理文档，没有修改应用代码或运行完整应用测试。当前macOS环境没有可直接调用的`corepack`命令，无法复现原Windows审查中的pnpm workspace验证；`AUD-006`因此保持OPEN。本次文档交付以Markdown链接检查、问题ID检查、`git diff --check`和差异审阅为验收。
