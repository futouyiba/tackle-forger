import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  materializeConfigExport,
  parseConfigTomlTables,
  validateConfigExportMapping,
  type ConfigExportMapping,
} from "../lib/config-export-mapping";

const configToml = `
[tables.rods]
sheet = ["Rods"]
workbook = "tackle.xlsx"
enums = []

[tables.item]
sheet = ["Item"]
workbook = "item.xlsx"
enums = [
  {field = "name_language", table = "language_item"},
]

[tables.goods_basic]
sheet = ["GoodsBasic"]
workbook = "store.xlsx"
enums = [
  {field = "item_id", table = "item"},
]

[tables.store_buy]
sheet = ["StoreBuy"]
workbook = "store.xlsx"
enums = [
  {field = "goods_id", table = "goods_basic"},
  {field = "cost_item", table = "item,currency_item"},
]
`;

function rodMapping(): ConfigExportMapping {
  return {
    mappingId: "configs-design-rod",
    version: "1.0.0",
    enumReferenceField: "name",
    logicalTables: {
      rods: {
        workbook: "tackle.xlsx",
        sheet: "Rods",
        required: true,
        stableBusinessKey: "id",
        dataStartRow: 5,
      },
    },
    rows: [
      {
        rowMappingId: "rod",
        logicalTable: "rods",
        businessKeyField: "id",
        configNameKeyField: "name",
        columns: {
          id: { kind: "constant", value: 301499001 },
          name: { kind: "constant", value: "rod_qinglu_15_fast" },
          drag: {
            kind: "snapshot_value",
            key: "杆最大拉力kgf",
            scale: 1000,
            precision: 0,
          },
          weight: {
            kind: "snapshot_value",
            key: "杆自重g",
            scale: 1,
            precision: 2,
          },
        },
      },
    ],
  };
}

test("config.toml 解析 workbook/sheet 与逗号目标枚举，不读取系统密钥文件", () => {
  const tables = parseConfigTomlTables(configToml);
  assert.equal(tables.rods.workbook, "tackle.xlsx");
  assert.deepEqual(tables.rods.sheets, ["Rods"]);
  assert.deepEqual(tables.store_buy.enums[1], {
    field: "cost_item",
    targetLogicalTables: ["item", "currency_item"],
  });
});

test("版本化映射显式提供业务ID和单位换算后生成完整行", () => {
  const snapshot = createSeedState().configurationSnapshots[0];
  const result = materializeConfigExport({
    snapshot,
    mapping: rodMapping(),
    compilerTables: parseConfigTomlTables(configToml),
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].values.id, 301499001);
  assert.equal(
    result.rows[0].values.drag,
    Math.round(Number(snapshot.finalPanelValues["杆最大拉力kgf"]) * 1000),
  );
});

test("Snapshot 缺映射输入时阻止整行，不生成半行数据", () => {
  const snapshot = structuredClone(createSeedState().configurationSnapshots[0]);
  delete snapshot.finalPanelValues["杆最大拉力kgf"];
  const result = materializeConfigExport({
    snapshot,
    mapping: rodMapping(),
    compilerTables: parseConfigTomlTables(configToml),
  });
  assert.equal(result.rows.length, 0);
  assert.ok(result.issues.some((entry) => entry.code === "EXPORT_MAPPING_SOURCE_MISSING"));
});

test("映射与 config.toml 的 workbook/sheet 不一致时精确阻断", () => {
  const mapping = rodMapping();
  mapping.logicalTables.rods.workbook = "wrong.xlsx";
  mapping.logicalTables.rods.sheet = "WrongSheet";
  const issues = validateConfigExportMapping({
    mapping,
    compilerTables: parseConfigTomlTables(configToml),
  });
  assert.ok(issues.some((entry) => entry.code === "EXPORT_WORKBOOK_MISMATCH"));
  assert.ok(issues.some((entry) => entry.code === "EXPORT_SHEET_MISMATCH"));
});
