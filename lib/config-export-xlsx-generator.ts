/**
 * 从 MaterializedConfigRow[] 生成合并 XLSX（所有 sheet 在一个文件）。
 * 不依赖目标源文件，不经过 stageWorkbookRows——直接用 SheetJS 构建。
 */
import * as XLSX from "xlsx";
import type {
  ConfigExportMapping,
  MaterializedConfigRow,
} from "./config-export-mapping";

function inferType(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return "FLOAT";
  if (typeof value === "boolean") return "BOOL";
  if (typeof value === "bigint") return "INT64";
  return "STRING";
}

export function generatePreviewXlsx(input: {
  rows: MaterializedConfigRow[];
  mapping: ConfigExportMapping;
  labels: Record<string, string>;
}): Uint8Array {
  const workbook = XLSX.utils.book_new();
  if (!input.rows.length) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["导出无数据"]]),
      "说明",
    );
    return new Uint8Array(
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
    );
  }
  const grouped = new Map<string, MaterializedConfigRow[]>();

  for (const row of input.rows) {
    const key = row.sheet;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  for (const [sheetName, rows] of grouped) {
    if (!rows.length) continue;
    // 用首行的列顺序
    const columns = Object.keys(rows[0].values);
    if (!columns.length) continue;

    // Row 1: 类型推断
    const typeRow = columns.map((col) => inferType(rows[0].values[col]));
    // Row 2: 字段名
    const fieldRow = [...columns];
    // Row 3: 中文标签
    const labelRow = columns.map((col) => input.labels[col] ?? col);
    // Row 4: 空行
    const emptyRow = columns.map(() => null);

    const data: unknown[][] = [typeRow, fieldRow, labelRow, emptyRow];

    for (const row of rows) {
      data.push(columns.map((col) => row.values[col] ?? null));
    }

    const sheet = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  }

  return new Uint8Array(
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
  );
}
