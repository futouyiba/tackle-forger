# 钓具铸造台 · Tackle Forger

分层钓具装备设计与 SKU 生成系统——替代 Excel 工作簿的可配置 Web 编辑器。

## 功能

- **参数定义**：杆 / 轮 / 线 的完整钓具属性目录（可增删改参数名）
- **重量模板**：钓法 × 大重量段的中性基准，多模板横向对比
- **规则层**：可配置的分层生成管线，`+加 / ×乘 /=设` 三种系数运算
- **组合 SKU**：实时计算引擎——勾选维度选项 / 词条即重算品质、拉力、安全拉力，含计算追溯
- **词条库 + 品质评分**：装备品质由所携带词条的总评分决定
- **杆 / 轮 / 线明细**：按组件 ID 1:1 生成，型号 / 名称可覆盖
- **评审 / 提案 / 校验**：手工精调 → 规则学习的反馈闭环
- **工作簿导入导出**：与 Excel 双向迁移（SheetJS 读 / ExcelJS 写）
- **登录与角色**：管理员 / 编辑者 / 查看者

## 技术栈

Next.js 16 · React 19 · TypeScript · Tailwind · pnpm 工作区
- `packages/domain` — 计算引擎、公式解析器、品质模型、参数种子
- `packages/db` — Drizzle ORM schema（PostgreSQL）
- `packages/excel` — Excel 解析 / 导出
- `packages/ui` — 共享网格组件
- `apps/web` — Next.js 应用

## 本地开发

```bash
corepack pnpm install
corepack pnpm --filter @tackle-forger/web dev   # http://localhost:3000
corepack pnpm -r typecheck
corepack pnpm -r test
corepack pnpm --filter @tackle-forger/web build
```

> 部署在 Vercel；本地编辑通过 localStorage 持久化。
