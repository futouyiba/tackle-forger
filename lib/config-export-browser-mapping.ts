/**
 * 浏览器导出用的 NON_FORMAL 预览映射。
 * 基于仓库根目录 config-export-registry.json 的 mapping:default@1，
 * 修正为与种子/快照实际字段名一致。
 */
import type {
  ConfigCompilerTableDefinition,
  ConfigExportMapping,
} from "./config-export-mapping";

export const NON_FORMAL_PREVIEW_NOTICE =
  "NON_FORMAL — 不可提交、不可人工搬运到 configs。仅供本地预览参考。";

export const BROWSER_EXPORT_MAPPING: ConfigExportMapping = {
  mappingId: "browser-download-v1",
  version: "1.0.0",
  enumReferenceField: "name",
  logicalTables: {
    rods: {
      workbook: "tackle.xlsx",
      sheet: "Rods",
      required: true,
      stableBusinessKey: "non_formal_ref",
      dataStartRow: 5,
    },
    reels: {
      workbook: "tackle.xlsx",
      sheet: "Reels",
      required: true,
      stableBusinessKey: "non_formal_ref",
      dataStartRow: 5,
    },
    lines: {
      workbook: "tackle.xlsx",
      sheet: "Lines",
      required: true,
      stableBusinessKey: "non_formal_ref",
      dataStartRow: 5,
    },
    item: {
      workbook: "item.xlsx",
      sheet: "Item",
      required: true,
      stableBusinessKey: "non_formal_ref",
      dataStartRow: 5,
    },
    goods_basic: {
      workbook: "store.xlsx",
      sheet: "GoodsBasic",
      required: true,
      stableBusinessKey: "non_formal_ref",
      dataStartRow: 5,
    },
    store_buy: {
      workbook: "store.xlsx",
      sheet: "StoreBuy",
      required: true,
      stableBusinessKey: "non_formal_ref",
      dataStartRow: 5,
    },
  },
  rows: [
    // ── 竿 (part:rod) ──
    {
      rowMappingId: "rod",
      logicalTable: "rods",
      businessKeyField: "non_formal_ref",
      configNameKeyField: "non_formal_ref",
      columns: {
        non_formal_ref: { kind: "snapshot_property", property: "modelId" },
        drag: {
          kind: "snapshot_value",
          key: "杆最大拉力kgf",
          scale: 1000,
          precision: 0,
        },
        length: {
          kind: "snapshot_value",
          key: "杆长m",
          scale: 100,
          precision: 0,
        },
        weight: {
          kind: "snapshot_value",
          key: "杆自重g",
          precision: 2,
        },
        action: {
          kind: "snapshot_value",
          key: "钓性",
          required: false,
        },
        hardness: {
          kind: "snapshot_value",
          key: "硬度",
          required: false,
        },
        lure_max_g: {
          kind: "snapshot_value",
          key: "饵重上限g",
          required: false,
        },
        lure_min_g: {
          kind: "snapshot_value",
          key: "饵重下限g",
          required: false,
        },
      },
    },
    // ── 轮 (part:reel) ──
    {
      rowMappingId: "reel",
      logicalTable: "reels",
      businessKeyField: "non_formal_ref",
      configNameKeyField: "non_formal_ref",
      columns: {
        non_formal_ref: { kind: "snapshot_property", property: "modelId" },
        drag: {
          kind: "snapshot_value",
          key: "轮最大拉力kgf",
          scale: 1000,
          precision: 0,
        },
        weight: {
          kind: "snapshot_value",
          key: "轮自重g",
          precision: 2,
        },
        ratio: {
          kind: "snapshot_value",
          key: "传动比",
          required: false,
        },
        resilience: {
          kind: "snapshot_value",
          key: "回弹指数",
          required: false,
        },
      },
    },
    // ── 线 (part:line) ──
    {
      rowMappingId: "line",
      logicalTable: "lines",
      businessKeyField: "non_formal_ref",
      configNameKeyField: "non_formal_ref",
      columns: {
        non_formal_ref: { kind: "snapshot_property", property: "modelId" },
        drag: {
          kind: "snapshot_value",
          key: "线最大拉力kgf",
          scale: 1000,
          precision: 0,
        },
        pe_max: {
          kind: "snapshot_value",
          key: "PE号上限",
          required: false,
        },
        pe_min: {
          kind: "snapshot_value",
          key: "PE号下限",
          required: false,
        },
        tension: {
          kind: "snapshot_value",
          key: "线张力指数",
          required: false,
        },
      },
    },
    // ── 通用（跨部位）──
    {
      rowMappingId: "item",
      logicalTable: "item",
      businessKeyField: "non_formal_ref",
      configNameKeyField: "non_formal_ref",
      columns: {
        non_formal_ref: { kind: "snapshot_property", property: "modelId" },
        tackle_ref: { kind: "snapshot_property", property: "modelId" },
      },
    },
    {
      rowMappingId: "goods",
      logicalTable: "goods_basic",
      businessKeyField: "non_formal_ref",
      configNameKeyField: "non_formal_ref",
      columns: {
        non_formal_ref: { kind: "snapshot_property", property: "modelId" },
        item_ref: { kind: "snapshot_property", property: "modelId" },
      },
    },
    {
      rowMappingId: "store",
      logicalTable: "store_buy",
      businessKeyField: "non_formal_ref",
      configNameKeyField: "non_formal_ref",
      columns: {
        non_formal_ref: { kind: "snapshot_property", property: "modelId" },
        goods_ref: { kind: "snapshot_property", property: "modelId" },
        enabled: { kind: "target_existing_or_constant", value: false },
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
  non_formal_ref: "NON_FORMAL 引用",
  tackle_ref: "钓具引用",
  item_ref: "物品引用",
  goods_ref: "商品引用",
  drag: "拉力(g)",
  length: "长度(cm)",
  weight: "自重(g)",
  action: "钓性",
  hardness: "硬度",
  lure_max_g: "饵重上限(g)",
  lure_min_g: "饵重下限(g)",
  ratio: "传动比",
  resilience: "回弹指数",
  pe_max: "PE号上限",
  pe_min: "PE号下限",
  tension: "线张力指数",
  enabled: "上架",
};

const OBJECT_KINDS: Record<string, string> = {
  rod: "tackle",
  reel: "tackle",
  line: "tackle",
  item: "item",
  goods: "goods_basic",
  store: "store_buy",
};

/**
 * 将 modelId 转为 NON_FORMAL 符号引用。
 * 根据 rowMappingId 确定对象种类。
 */
export function nonFormalRef(modelId: string, rowMappingId: string): string {
  const kind = OBJECT_KINDS[rowMappingId] ?? rowMappingId;
  return `NON_FORMAL:${modelId}:${kind}`;
}

/** itemPartId → 部位行映射 ID */
const PART_ROW_IDS: Record<string, string> = {
  "part:rod": "rod",
  "part:reel": "reel",
  "part:line": "line",
};

/** 始终适用的通用行映射 */
const COMMON_ROW_IDS = new Set(["item", "goods", "store"]);

/**
 * 按快照部位筛选适用的行映射。
 * 竿快照用 rod + item/goods/store，轮快照用 reel + item/goods/store。
 */
export function filterMappingForPart(
  mapping: ConfigExportMapping,
  itemPartId: string,
): ConfigExportMapping {
  const partRowId = PART_ROW_IDS[itemPartId];
  const allowed = new Set(partRowId ? [...COMMON_ROW_IDS, partRowId] : COMMON_ROW_IDS);
  return {
    ...mapping,
    rows: mapping.rows.filter((r) => allowed.has(r.rowMappingId)),
  };
}
