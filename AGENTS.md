# Tackle Forger 项目开发约束

## 权威设计

开始任何实现、重构、评审或测试任务前，必须完整阅读：

- `docs/README.md`
- `docs/tackle-forger-development-spec-v3.md`

`docs/tackle-forger-development-spec-v3.md`是唯一权威产品与领域规范。其他`docs/2026-*`和`crystal/*`文件均为历史材料；发生冲突时一律以v3规范为准。

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

## 实现要求

- 领域计算必须确定、可追踪、可重放。
- 兼容性必须区分硬规则和软Affinity Score。
- 手工修改使用分层Patch，不覆盖派生模板。
- 保留并迁移现有数据，不通过删除历史状态简化实现。
- 新增领域行为必须补测试；至少覆盖正常路径、边界、冲突和版本冻结。

## GitHub合并门禁

- 当前不配置GitHub Ruleset、分支保护、required check或额外status context；合并门禁由首个有权限的
  Agent或单一托管主管在实时GitHub状态上执行，不得新增重复workflow代替该流程。
- 合并前显式把变更分类为`normal`或`high`，并运行`npm run governance:check-pr -- --repo
  futouyiba/tackle-forger --pr <number> --risk <normal|high>`；任何相关远端状态变化后必须重跑。
- 只接受Pull Request同一个当前head SHA上的根npm CI、历史pnpm CI和Windows行尾检查；缺失、未完成、
  失败、跳过、取消或旧head结果均阻断。#21仅是历史事故，其事后CI不得冒充当前通过。
- Draft或存在未解决review thread时阻断。高风险变更还必须由Pull Request作者之外的人工评审者在当前
  head提交`APPROVED`；作者自批和`COMMENTED`不计入。
- 检查通过只是可合并证据，不授予合并权限；合并仍需本轮用户明确授权。完整契约见
  `.github/merge-gates.md`。
