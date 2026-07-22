# 配置表生产映射指南

> 状态：配置映射契约；从属于v3第25节
> 最后对齐v3：2026-07-22

本文件记录 `Tackle Forger` 到 `configsDesign` 的已确认事实、必须显式配置的语义，以及映射发布门槛。它不包含 `config_system.toml` 的内容，也不允许把该文件中的秘密写入日志、Manifest 或页面。

## 已确认的编译器语义

- 根清单是 `config.toml`，逻辑表由 `[tables.<logicalName>]` 声明。
- `workbook` 与 `sheet` 必须从 `config.toml` 解析，不能仅凭文件名猜测。
- `enums = [{ field, table }]` 中的目标可以是逗号分隔的逻辑表并集。
- 当前 `configsDesign` 样例单元格使用目标表的 `name` 值作为枚举引用，映射必须显式声明 `enumReferenceField: "name"`。
- 普通工作表第 1 行是类型、第 2 行是字段名、第 3 行是说明、第 4 行是表达式/空行，数据从第 5 行开始。
- `NULL` 是编译器使用的显式哨兵；需要空值时由字段映射声明 `nullSentinel`，不能把空字符串、空单元格和 `NULL` 混用。

## 已确认的目标逻辑表

| logical table | workbook | sheet | dataStartRow | 业务键候选 |
| --- | --- | --- | ---: | --- |
| `rods` | `tackle.xlsx` | `Rods` | 5 | `id` |
| `reels` | `tackle.xlsx` | `Reels` | 5 | `id` |
| `lines` | `tackle.xlsx` | `Lines` | 5 | `id` |
| `item` | `item.xlsx` | `Item` | 5 | `id` |
| `goods_basic` | `store.xlsx` | `GoodsBasic` | 5 | `id` |
| `store_buy` | `store.xlsx` | `StoreBuy` | 5 | `id` |

`store_buy.goods_id` 按 `name` 解析到 `goods_basic`，`goods_basic.item_id` 与 `store_buy.cost_item` 按 `name` 解析到 `item`。

## 两个 Profile 的单位差异

当前检查到的工作簿并非完全同构：

- `xlsx/tackle.xlsx` 的部分重量列使用 `0.01g`；`xlsx_channel/numerical/tackle.xlsx` 对应列使用 `g`。
- 拉力列在工作簿中使用 `g`，Snapshot 中使用 `kgf`，倍率必须由映射显式声明。
- 两个 Profile 的列集合也不同，不能共享未校验的 schema hash。

因此单位换算属于 Profile 对应的版本化映射，不应散落在 UI 或写入器代码中。

## 发布前必须补齐

每个 Model 的映射至少需要：

1. 已发布`ConfigIdPolicyVersion`（v3 OPEN-008）分配的Rod、Reel、Line数值型`INT64 id`与稳定`name`；公司数字区间和命名格式未发布时只能预览，禁止用当前最大值+1或本文示例ID正式提交。
2. Item、GoodsBasic、StoreBuy 的数值型 `INT64 id` 与稳定 `name`。
3. `brand`、`series`、`sub_type`、`item_type`、`quality` 等枚举展示值。
4. 每个目标字段的 Snapshot 来源、常量、倍率、偏移、精度和空值哨兵。
5. 是否生成 `tackle_set`、`store_recommend`、`store_room`、`pond_store_group`、`pond_store` 等可选行。
6. mappingId、version、Profile、schema hash 与审批记录。

缺任一必填输入时，生成器必须产生`ValidationIssue(gate="EXPORT")`并阻止当前“环境×渠道”目标提交；不得面向正式文件静默跳过行或生成半套tackle/item/store记录。其他已通过预检的目标默认可继续，失败目标保留预览包、Issue和恢复Manifest。

## 最小映射示例

下面只演示结构，不是可发布的生产 ID：

```json
{
  "mappingId": "configs-design-qinglu",
  "version": "1.0.0",
  "enumReferenceField": "name",
  "logicalTables": {
    "rods": {
      "workbook": "tackle.xlsx",
      "sheet": "Rods",
      "required": true,
      "stableBusinessKey": "id",
      "dataStartRow": 5
    }
  },
  "rows": [
    {
      "rowMappingId": "model:qinglu-1.5-fast:rod",
      "logicalTable": "rods",
      "businessKeyField": "id",
      "columns": {
        "id": { "kind": "constant", "value": 301499001 },
        "name": { "kind": "constant", "value": "rod_qinglu_15_fast" },
        "drag": {
          "kind": "snapshot_value",
          "key": "杆最大拉力kgf",
          "scale": 1000,
          "precision": 0
        }
      }
    }
  ]
}
```

生产映射必须经过预览、关系校验和人工确认后才能绑定到已发布的`ConfigEnvironmentProfile`，再由用户对每个环境×渠道建立`LocalExportTargetBinding`。服务端只保存环境、渠道、映射版本和用户标签，不保存本机绝对路径或目录句柄。

## 一期权威路径：浏览器目录授权

一期使用Chromium的File System Access API。用户先选择某环境的configs仓库根目录，再为非1001渠道选择明确的渠道目录。`FileSystemDirectoryHandle`只保存在当前用户、浏览器和origin的IndexedDB中；页面在每次导出前重新检查读写权限。

浏览器本地配置写入不进入服务端fenced outbox，服务端也不能取得目录句柄代写本机文件。工作区租约和fencing token只授权正式写入并约束服务端成功证据；页面在开始、每个文件写入前和最终报告前重验租约，但不能宣称token可撤销已经交给本机文件系统的写操作。文件一致性继续由基线hash/mtime、备份、恢复Manifest和逐文件回读保证。

写入期间租约失效或出现更高token时，旧页面不得报告成功。任一配置导出租约没有已验证终态便过期、断线或取消时，服务端必须把对应逻辑目标置为`recoveryState=RECOVERY_REQUIRED`并记录`reason=EXTERNAL_FILE_CONFLICT`，不能因页面未回报而假定文件未变。当前持锁者必须重新授权目录、回读全部目标文件并按Manifest恢复或前向协调，在记录新hash并关闭恢复状态前不得再次正式写入该目标。

当File System Access API不可用、目录句柄失效或用户未授权时，页面只能要求重新绑定，或下载包含`ExportManifest`和校验报告的变更包供人工搬运；不得声称已写入本机Git工作区。

## 遗留兼容：本地伴随服务（非一期规范路径）

仓库中仍保留`local_companion`执行器与`docs/config-export-registry.example.json`，用于兼容已有实验性实现。它不是新部署的默认方案，不能替代`ConfigEnvironmentProfile + LocalExportTargetBinding`，也不得让服务器获取设计人员电脑上的路径。只有未来经用户明确批准修改v3部署边界后，才能将其重新提升为支持路径。

以下内容仅记录遗留实现的隔离要求，不构成一期安装步骤：

1. 复制 `docs/config-export-registry.example.json` 到本机受控位置。
2. 将 `pairing.workspaceId` 替换为公司飞书租户键，并在 `pairing.allowedOpenIds` 登记允许执行交付的用户。
3. 把审核通过的完整 Mapping 加入 `mappings`，在 Profile 中填写相同的 `mappingId` 与 `mappingVersion`。
4. 完成业务 ID、枚举值、单位与 schema 审核后，将对应 Profile 的 `enabled` 改为 `true`。
5. 启动伴随服务：

```powershell
npm run config-export:companion -- --registry <注册表绝对路径>
```

启动窗口会显示本机地址与配对令牌文件路径；默认文件为 `<registry>.pairing-token`。进入“配置表交付”，粘贴令牌并连接后，依次完成暂存预览、关系校验、逐Profile精确确认和恢复型提交。这里的遗留执行器也只能保证单文件替换配合多文件备份/恢复，不能宣称三个工作簿跨文件原子提交。

安全边界：

- 注册表由本地管理员维护；网页请求不能传入 `projectRoot`、工作簿路径或 Mapping。
- 配对令牌长度至少 16 字符，仅写入权限受限的本地令牌文件并保存在当前页面状态，不写入 Workspace、Manifest、审计或控制台日志。
- 服务默认只接受 `localhost` / `127.0.0.1` 来源；额外来源必须在 `allowedOrigins` 精确登记；所有请求还会校验飞书租户和当前用户。
- 预览 30 分钟后失效；服务重启后必须重新预览，但已提交任务可按任务包 ID 从幂等记录恢复。
- 提交重新解析登记 Profile，并检查目标路径、暂存路径、原文件 hash、文件锁与幂等键。
- 写入前记录基线hash并创建备份与恢复Manifest；逐文件写入后回读验证，多文件提交失败时按Manifest恢复已写文件并保留完整审计。

示例注册表故意保持 Profile 停用且不含生产 Mapping，避免把结构示例误当成可发布业务数据。
