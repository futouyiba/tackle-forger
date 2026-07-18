# 系列自动演示表：设计验收

- 参考来源：`E:/DocsHDD/tackleForger/design-qa-assets/series-table-reference.png`
- 实现截图：`E:/DocsHDD/tackleForger/design-qa-assets/series-table-implementation.png`
- 对照图：`E:/DocsHDD/tackleForger/design-qa-assets/series-table-comparison.png`
- 验收地址：`https://tackle-forger-workbench.vercel.app/`
- 桌面视口：1400 × 900
- 响应式视口：980 × 800、390 × 844

## 验收状态

- 两级表头：C、B、A、S；每个品质下均有“直柄S / 枪柄C”。
- 纵向轴：按钓重等级从上到下排列。
- 系列块：按钓重范围跨行，呈现为无圆角、无阴影的合并单元格。
- 同一品质与结构内：最小饵重 2g 的系列位于 10g 系列左侧。
- 系列内容：系列 ID、特点、钓重、饵重及词条等级均完整显示，定义品质未在块内重复展示。
- 交互：添加、发布、点击系列进入编辑均已验证；测试数据未保存到正式版本。
- 控制台：0 个 error，0 个 warning。
- 响应式：桌面、平板和手机宽度下页面无整体横向溢出；演示表使用独立横向滚动区保留完整表格结构。

## 对照结论

参考图与实现均采用 Excel 式细边框、白底单元格、浅蓝直柄表头、浅紫枪柄表头，以及系列块纵向跨格的布局。产品本身保留侧边导航和操作栏；钓重档位使用当前重量模板中的 12 档数据，而非参考图里的 6 档示例。

未发现 P0、P1 或 P2 问题。

final result: passed
