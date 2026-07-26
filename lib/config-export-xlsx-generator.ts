/**
 * 从 MaterializedConfigRow[] 生成合并 NON_FORMAL 预览 XLSX。
 * 不依赖目标源文件，不经过 stageWorkbookRows——直接用 SheetJS 构建。
 *
 * 列顺序、字段名来自映射的 rowMapping.columns（而非首行对象属性顺序）。
 * 类型行来自列来源种类（snapshot_value/constant 等）而非样本推断。
 */
import * as XLSX from "xlsx";
import type {
  ConfigExportMapping,
  MaterializedConfigRow,
} from "./config-export-mapping";
import { NON_FORMAL_PREVIEW_NOTICE } from "./config-export-browser-mapping";

function typeFromSource(
  source: ConfigExportMapping["rows"][number]["columns"][string],
  firstValue: unknown,
): string {
  if (source.kind === "target_existing_or_constant") {
    if (typeof source.value === "boolean") return "BOOL";
    if (typeof source.value === "number" && Number.isInteger(source.value)) return "INT64";
    if (typeof source.value === "number") return "FLOAT";
    return "STRING";
  }
  if (source.kind === "snapshot_property") {
    // snapshot_property id/modelId/revision 等通常是字符串或整数
    if (source.property === "id" || source.property === "modelId") return "STRING";
    if (source.property === "version" || source.property === "modelRevision" || source.property === "skuRevision" || source.property === "seriesRevision") return "INT32";
    return "STRING";
  }
  if (source.kind === "snapshot_value") {
    if (source.scale !== undefined || source.precision !== undefined) return "FLOAT";
    if (typeof firstValue === "number" && Number.isInteger(firstValue)) return "INT32";
    if (typeof firstValue === "number") return "FLOAT";
    return "STRING";
  }
  if (typeof source.value === "boolean") return "BOOL";
  if (typeof source.value === "number" && Number.isInteger(source.value)) return "INT64";
  if (typeof source.value === "number") return "FLOAT";
  return "STRING";
}

export function generatePreviewXlsx(input: {
  rows: MaterializedConfigRow[];
  mapping: ConfigExportMapping;
  labels: Record<string, string>;
  notice?: string;
}): Uint8Array {
  const workbook = XLSX.utils.book_new();

  // 首 sheet：NON_FORMAL 声明
  const noticeText = input.notice ?? NON_FORMAL_PREVIEW_NOTICE;
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([[noticeText], [], ["生成时间", new Date().toISOString()]]),
    "NON_FORMAL",
  );

  if (!input.rows.length) {
    return new Uint8Array(
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
    );
  }

  // 按 workbook → sheet 两级分组，避免不同 workbook 同名 sheet 冲突
  const grouped = new Map<string, Map<string, MaterializedConfigRow[]>>();
  for (const row of input.rows) {
    const bySheet = grouped.get(row.workbook) ?? new Map();
    const list = bySheet.get(row.sheet) ?? [];
    list.push(row);
    bySheet.set(row.sheet, list);
    grouped.set(row.workbook, bySheet);
  }

  // 建立 rowMappingId → columns 查找
  const columnDefs = new Map(
    input.mapping.rows.map((r) => [r.rowMappingId, r.columns] as const),
  );

  for (const [workbookName, bySheet] of grouped) {
    for (const [sheetName, rows] of bySheet) {
      if (!rows.length) continue;
      // 用首个行的 rowMappingId 找到映射定义的列
      const columns = columnDefs.get(rows[0].rowMappingId);
      const fieldNames = columns ? Object.keys(columns) : Object.keys(rows[0].values);
      if (!fieldNames.length) continue;

      // Row 1: 类型行——从列来源推断
      const typeRow = fieldNames.map((col) =>
        typeFromSource(columns?.[col] ?? { kind: "constant", value: null }, rows[0].values[col]),
      );
      // Row 2: 字段名
      const fieldRow = [...fieldNames];
      // Row 3: 中文标签
      const labelRow = fieldNames.map((col) => input.labels[col] ?? col);
      // Row 4: 空行
      const emptyRow = fieldNames.map(() => null);

      const data: unknown[][] = [typeRow, fieldRow, labelRow, emptyRow];

      for (const row of rows) {
        data.push(fieldNames.map((col) => row.values[col] ?? null));
      }

      // sheet 名加 workbook 前缀防止冲突
      const safeSheetName =
        workbookName === "tackle.xlsx"
          ? sheetName
          : `${workbookName}>${sheetName}`;
      const sheet = XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName);
    }
  }

  return new Uint8Array(
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
  );
}
