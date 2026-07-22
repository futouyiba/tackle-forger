import * as XLSX from "xlsx";
import type {
  ConfigExportMapping,
  ConfigExportMappingIssue,
  MaterializedConfigRow,
} from "./config-export-mapping";
import type { LogicalTableData } from "./config-export";

export interface WorkbookCellChange {
  logicalTable: string;
  sheet: string;
  excelRow: number;
  businessKey: string;
  operation: "insert" | "update" | "skip";
  changedFields: string[];
}

export interface StagedWorkbookResult {
  workbook: string;
  status: "ready" | "blocked";
  output: Uint8Array;
  issues: ConfigExportMappingIssue[];
  changes: WorkbookCellChange[];
  preservedSheetNames: string[];
}

function workbookIssue(input: Omit<ConfigExportMappingIssue, "level" | "gate">): ConfigExportMappingIssue {
  return { level: "error", gate: "export", ...input };
}

function workbookWarning(input: Omit<ConfigExportMappingIssue, "level" | "gate">): ConfigExportMappingIssue {
  return { level: "warning", gate: "export", ...input };
}

function cellType(value: unknown): XLSX.ExcelDataType {
  if (typeof value === "number") return "n";
  if (typeof value === "boolean") return "b";
  return "s";
}

function normalizeBusinessKey(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function headerColumns(
  worksheet: XLSX.WorkSheet,
  fieldNameRow: number,
): Map<string, number[]> {
  const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1:A1");
  const columns = new Map<string, number[]>();
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: fieldNameRow - 1, c: column })];
    const field = cell?.v === undefined || cell?.v === null ? "" : String(cell.v).trim();
    if (!field) continue;
    const existing = columns.get(field) ?? [];
    existing.push(column);
    columns.set(field, existing);
  }
  return columns;
}

function cloneCellStyle(source: XLSX.CellObject | undefined) {
  if (!source) return {};
  const cloned: Partial<XLSX.CellObject> = {};
  if (source.s !== undefined) cloned.s = structuredClone(source.s);
  if (source.z !== undefined) cloned.z = source.z;
  return cloned;
}

export function stageWorkbookRows(input: {
  source: Uint8Array;
  workbookName: string;
  mapping: ConfigExportMapping;
  rows: MaterializedConfigRow[];
}): StagedWorkbookResult {
  const workbook = XLSX.read(input.source, {
    type: "array",
    cellFormula: true,
    cellStyles: true,
    cellNF: true,
    cellDates: true,
  });
  const issues: ConfigExportMappingIssue[] = [];
  const changes: WorkbookCellChange[] = [];
  const rows = input.rows.filter((row) => row.workbook === input.workbookName);
  const declaredSheets = new Set(
    Object.values(input.mapping.logicalTables)
      .filter((table) => table.workbook === input.workbookName)
      .map((table) => table.sheet),
  );
  for (const sheet of workbook.SheetNames) {
    if (declaredSheets.has(sheet)) continue;
    issues.push(workbookWarning({
      code: "EXPORT_UNDECLARED_SHEET_PRESERVED",
      message: `${input.workbookName} 中未声明工作表 ${sheet} 已原样保留。`,
      workbook: input.workbookName,
      sheet,
      suggestion: "如需管理该工作表，请发布包含对应逻辑表的新映射。",
    }));
  }


  for (const row of rows) {
    const table = input.mapping.logicalTables[row.logicalTable];
    const worksheet = workbook.Sheets[row.sheet];
    if (!table || !worksheet) {
      issues.push(workbookIssue({
        code: "EXPORT_WORKSHEET_MISSING",
        message: `${row.logicalTable} 的目标工作表 ${row.sheet} 不存在。`,
        logicalTable: row.logicalTable,
        workbook: input.workbookName,
        sheet: row.sheet,
        suggestion: "检查 config.toml、目标 Profile 与映射版本。",
      }));
      continue;
    }
    const columns = headerColumns(worksheet, 2);
    const managedColumns = new Map<string, number>();
    for (const field of Object.keys(row.values)) {
      const matches = columns.get(field) ?? [];
      if (!matches.length) {
        issues.push(workbookIssue({
          code: "EXPORT_FIELD_MISSING",
          message: `${row.logicalTable}.${field} 在目标工作表中不存在。`,
          logicalTable: row.logicalTable,
          workbook: input.workbookName,
          sheet: row.sheet,
          field,
        }));
      } else if (matches.length > 1) {
        issues.push(workbookIssue({
          code: "EXPORT_REPEATED_FIELD_UNRESOLVED",
          message: `${row.logicalTable}.${field} 存在重复列组，但映射没有声明具体序号。`,
          logicalTable: row.logicalTable,
          workbook: input.workbookName,
          sheet: row.sheet,
          field,
          suggestion: "发布包含重复列组序号的新映射；系统不会任选一列。",
        }));
      } else {
        managedColumns.set(field, matches[0]);
      }
    }
    const keyColumns = columns.get(row.businessKeyField) ?? [];
    if (keyColumns.length !== 1) {
      issues.push(workbookIssue({
        code: "EXPORT_BUSINESS_KEY_COLUMN_INVALID",
        message: `${row.logicalTable}.${row.businessKeyField} 必须唯一存在。`,
        logicalTable: row.logicalTable,
        workbook: input.workbookName,
        sheet: row.sheet,
        field: row.businessKeyField,
      }));
      continue;
    }
    const nameKeyColumns = columns.get(row.configNameKeyField) ?? [];
    if (nameKeyColumns.length !== 1) {
      issues.push(workbookIssue({
        code: "EXPORT_CONFIG_NAME_KEY_COLUMN_INVALID",
        message: `${row.logicalTable}.${row.configNameKeyField} 必须唯一存在。`,
        logicalTable: row.logicalTable,
        workbook: input.workbookName,
        sheet: row.sheet,
        field: row.configNameKeyField,
      }));
      continue;
    }
    if (issues.some((entry) => entry.logicalTable === row.logicalTable && entry.sheet === row.sheet)) {
      continue;
    }

    const key = normalizeBusinessKey(row.values[row.businessKeyField]);
    const nameKey = normalizeBusinessKey(row.values[row.configNameKeyField]);
    const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1:A1");
    const matchingRows: number[] = [];
    const matchingNameRows: number[] = [];
    for (let excelRow = table.dataStartRow; excelRow <= range.e.r + 1; excelRow += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: keyColumns[0] })];
      if (normalizeBusinessKey(cell?.v) === key) matchingRows.push(excelRow);
      const nameCell = worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: nameKeyColumns[0] })];
      if (normalizeBusinessKey(nameCell?.v) === nameKey) matchingNameRows.push(excelRow);
    }
    if (matchingRows.length > 1 || matchingNameRows.length > 1) {
      issues.push(workbookIssue({
        code: "EXPORT_EXISTING_IDENTITY_DUPLICATED",
        message: `${row.logicalTable} 的 ID 或 configNameKey 在工作表中重复。`,
        logicalTable: row.logicalTable,
        workbook: input.workbookName,
        sheet: row.sheet,
        field: row.businessKeyField,
      }));
      continue;
    }
    if (
      matchingRows.length !== matchingNameRows.length
      || (matchingRows.length === 1 && matchingRows[0] !== matchingNameRows[0])
    ) {
      issues.push(workbookIssue({
        code: "EXPORT_IDENTITY_SPLIT_MATCH",
        message: `${row.logicalTable} 的 ID=${key} 与 configNameKey=${nameKey} 未命中同一行。`,
        logicalTable: row.logicalTable,
        workbook: input.workbookName,
        sheet: row.sheet,
        field: row.businessKeyField,
        suggestion: "修复同名不同 ID、同 ID 不同名或分裂命中后重新预览。",
      }));
      continue;
    }

    const operation = matchingRows.length ? "update" : "insert";
    const excelRow = matchingRows[0] ?? Math.max(table.dataStartRow, range.e.r + 2);
    const changedFields: string[] = [];
    for (const [field, value] of Object.entries(row.values)) {
      const column = managedColumns.get(field);
      if (column === undefined) continue;
      const address = XLSX.utils.encode_cell({ r: excelRow - 1, c: column });
      const previous = worksheet[address];
      const rowMapping = input.mapping.rows.find((entry) => entry.rowMappingId === row.rowMappingId);
      if (operation === "update" && rowMapping?.columns[field]?.kind === "target_existing_or_constant") {
        continue;
      }
      if (Object.is(previous?.v, value) && !previous?.f) continue;
      const styleSource = previous ?? worksheet[XLSX.utils.encode_cell({
        r: Math.max(table.dataStartRow - 1, excelRow - 2),
        c: column,
      })];
      worksheet[address] = {
        ...cloneCellStyle(styleSource),
        t: cellType(value),
        v: value as XLSX.CellObject["v"],
      } as XLSX.CellObject;
      changedFields.push(field);
    }
    if (excelRow - 1 > range.e.r) {
      range.e.r = excelRow - 1;
      worksheet["!ref"] = XLSX.utils.encode_range(range);
    }
    changes.push({
      logicalTable: row.logicalTable,
      sheet: row.sheet,
      excelRow,
      businessKey: key,
      operation: changedFields.length ? operation : "skip",
      changedFields,
    });
  }

  if (issues.some((issue) => issue.level === "error")) {
    return {
      workbook: input.workbookName,
      status: "blocked",
      output: input.source,
      issues,
      changes: [],
      preservedSheetNames: structuredClone(workbook.SheetNames),
    };
  }
  const output = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    cellStyles: true,
  });
  return {
    workbook: input.workbookName,
    status: "ready",
    output: new Uint8Array(output),
    issues,
    changes,
    preservedSheetNames: structuredClone(workbook.SheetNames),
  };
}
export interface ExtractedWorkbookTables {
  tables: LogicalTableData[];
  issues: ConfigExportMappingIssue[];
}

export function extractLogicalTablesFromWorkbook(input: {
  source: Uint8Array;
  workbookName: string;
  mapping: ConfigExportMapping;
}): ExtractedWorkbookTables {
  const workbook = XLSX.read(input.source, {
    type: "array",
    cellFormula: true,
    cellDates: true,
  });
  const tables: LogicalTableData[] = [];
  const issues: ConfigExportMappingIssue[] = [];

  for (const [logicalName, table] of Object.entries(input.mapping.logicalTables)) {
    if (table.workbook !== input.workbookName) continue;
    const worksheet = workbook.Sheets[table.sheet];
    if (!worksheet) {
      if (table.required) {
        issues.push(workbookIssue({
          code: "EXPORT_WORKSHEET_MISSING",
          message: `${logicalName} 的目标工作表 ${table.sheet} 不存在。`,
          logicalTable: logicalName,
          workbook: input.workbookName,
          sheet: table.sheet,
        }));
      }
      continue;
    }
    const columns = headerColumns(worksheet, 2);
    const uniqueColumns = new Map<string, number>();
    for (const [field, indexes] of columns) {
      if (indexes.length === 1) uniqueColumns.set(field, indexes[0]);
    }
    const keyColumns = columns.get(table.stableBusinessKey) ?? [];
    if (keyColumns.length !== 1) {
      issues.push(workbookIssue({
        code: "EXPORT_BUSINESS_KEY_COLUMN_INVALID",
        message: `${logicalName}.${table.stableBusinessKey} 必须唯一存在。`,
        logicalTable: logicalName,
        workbook: input.workbookName,
        sheet: table.sheet,
        field: table.stableBusinessKey,
      }));
      continue;
    }
    const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1:A1");
    const rows: LogicalTableData["rows"] = [];
    for (let excelRow = table.dataStartRow; excelRow <= range.e.r + 1; excelRow += 1) {
      const values: Record<string, unknown> = {};
      let hasValue = false;
      for (const [field, column] of uniqueColumns) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: column })];
        if (cell?.v !== undefined && cell?.v !== null && cell.v !== "") hasValue = true;
        values[field] = cell?.v;
      }
      if (!hasValue) continue;
      rows.push({ excelRow, values });
    }
    tables.push({
      logicalName,
      workbook: input.workbookName,
      sheet: table.sheet,
      keyField: table.stableBusinessKey,
      rows,
    });
  }
  return { tables, issues };
}
