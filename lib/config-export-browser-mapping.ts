/**
 * 浏览器导出用的生产级 ConfigExportMapping。
 * 基于仓库根目录 config-export-registry.json 的 mapping:default@1。
 */
import type {
  ConfigCompilerTableDefinition,
  ConfigExportMapping,
} from "./config-export-mapping";

export const BROWSER_EXPORT_MAPPING: ConfigExportMapping = {
  mappingId: "browser-download-v1",
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
    reels: {
      workbook: "tackle.xlsx",
      sheet: "Reels",
      required: true,
      stableBusinessKey: "id",
      dataStartRow: 5,
    },
    lines: {
      workbook: "tackle.xlsx",
      sheet: "Lines",
      required: true,
      stableBusinessKey: "id",
      dataStartRow: 5,
    },
    item: {
      workbook: "item.xlsx",
      sheet: "Item",
      required: true,
      stableBusinessKey: "id",
      dataStartRow: 5,
    },
    goods_basic: {
      workbook: "store.xlsx",
      sheet: "GoodsBasic",
      required: true,
      stableBusinessKey: "id",
      dataStartRow: 5,
    },
    store_buy: {
      workbook: "store.xlsx",
      sheet: "StoreBuy",
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
        id: { kind: "snapshot_property", property: "id" },
        name: { kind: "snapshot_value", key: "杆型号" },
        drag: {
          kind: "snapshot_value",
          key: "杆最大拉力kgf",
          scale: 1000,
          precision: 0,
        },
        length: {
          kind: "snapshot_value",
          key: "杆长度cm",
          precision: 0,
        },
        weight: {
          kind: "snapshot_value",
          key: "杆自重g",
          precision: 2,
        },
      },
    },
    {
      rowMappingId: "item",
      logicalTable: "item",
      businessKeyField: "id",
      configNameKeyField: "name",
      columns: {
        id: { kind: "snapshot_property", property: "id" },
        name: { kind: "snapshot_value", key: "杆型号" },
      },
    },
    {
      rowMappingId: "goods",
      logicalTable: "goods_basic",
      businessKeyField: "id",
      configNameKeyField: "name",
      columns: {
        id: { kind: "snapshot_property", property: "id" },
        name: { kind: "snapshot_value", key: "杆型号" },
        item_id: { kind: "snapshot_value", key: "杆型号" },
      },
    },
    {
      rowMappingId: "store",
      logicalTable: "store_buy",
      businessKeyField: "id",
      configNameKeyField: "name",
      columns: {
        id: { kind: "snapshot_property", property: "id" },
        name: { kind: "snapshot_value", key: "杆型号" },
        goods_id: { kind: "snapshot_value", key: "杆型号" },
        enabled: { kind: "target_existing_or_constant", value: true },
      },
    },
  ],
};

export const BROWSER_COMPILER_TABLES: Record<
  string,
  ConfigCompilerTableDefinition
> = {
  rods: {
    logicalName: "rods",
    workbook: "tackle.xlsx",
    sheets: ["Rods"],
    enums: [],
  },
  reels: {
    logicalName: "reels",
    workbook: "tackle.xlsx",
    sheets: ["Reels"],
    enums: [],
  },
  lines: {
    logicalName: "lines",
    workbook: "tackle.xlsx",
    sheets: ["Lines"],
    enums: [],
  },
  item: {
    logicalName: "item",
    workbook: "item.xlsx",
    sheets: ["Item"],
    enums: [],
  },
  goods_basic: {
    logicalName: "goods_basic",
    workbook: "store.xlsx",
    sheets: ["GoodsBasic"],
    enums: [],
  },
  store_buy: {
    logicalName: "store_buy",
    workbook: "store.xlsx",
    sheets: ["StoreBuy"],
    enums: [],
  },
};

/** 字段名 → 中文标签。Row 3 展示用。 */
export const BROWSER_FIELD_LABELS: Record<string, string> = {
  id: "ID",
  name: "名称",
  drag: "拉力(g)",
  length: "长度(cm)",
  weight: "自重(g)",
  item_id: "物品ID",
  goods_id: "商品ID",
  enabled: "上架",
};
