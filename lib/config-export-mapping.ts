import type { ConfigurationSnapshot } from "./types";
import { assertSnapshotItemPartEnabled } from "./enabled-item-parts";

export type ExportSnapshotProperty =
  | "id"
  | "modelId"
  | "projectionId"
  | "contentHash"
  | "version"
  | "modelRevision"
  | "skuRevision"
  | "seriesRevision";

export type ExportColumnSource =
  | {
      kind: "constant";
      value: unknown;
    }
  | {
      kind: "snapshot_value";
      key: string;
      required?: boolean;
      scale?: number;
      offset?: number;
      precision?: number;
      nullSentinel?: string;
    }
  | {
      kind: "snapshot_property";
      property: ExportSnapshotProperty;
      required?: boolean;
      nullSentinel?: string;
    }
  | {
      /** 新行写默认值；更新行保留目标表当前值。 */
      kind: "target_existing_or_constant";
      value: unknown;
    };

export interface ConfigExportRowMapping {
  rowMappingId: string;
  logicalTable: string;
  businessKeyField: string;
  configNameKeyField: string;
  columns: Record<string, ExportColumnSource>;
}

export interface ConfigExportMapping {
  mappingId: string;
  version: string;
  enumReferenceField: "id" | "name";
  logicalTables: Record<string, {
    workbook: string;
    sheet: string;
    required: boolean;
    stableBusinessKey: string;
    dataStartRow: number;
  }>;
  rows: ConfigExportRowMapping[];
}

export interface ConfigCompilerEnumDefinition {
  field: string;
  targetLogicalTables: string[];
}

export interface ConfigCompilerTableDefinition {
  logicalName: string;
  workbook: string;
  sheets: string[];
  enums: ConfigCompilerEnumDefinition[];
}

export interface ConfigExportMappingIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  gate: "export";
  logicalTable?: string;
  workbook?: string;
  sheet?: string;
  field?: string;
  sourceKey?: string;
  suggestion?: string;
}

export interface MaterializedConfigRow {
  rowMappingId: string;
  logicalTable: string;
  workbook: string;
  sheet: string;
  businessKeyField: string;
  configNameKeyField: string;
  values: Record<string, unknown>;
}

export interface MaterializedConfigExport {
  mappingId: string;
  mappingVersion: string;
  snapshotId: string;
  rows: MaterializedConfigRow[];
  issues: ConfigExportMappingIssue[];
}

function stringValues(input: string) {
  return Array.from(input.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)).map(
    (match) => match[1].replace(/\\"/g, '"'),
  );
}

export function parseConfigTomlTables(
  toml: string,
): Record<string, ConfigCompilerTableDefinition> {
  const header = /^\s*\[tables\.([^\]]+)\]\s*$/gm;
  const matches = Array.from(toml.matchAll(header));
  const definitions: Record<string, ConfigCompilerTableDefinition> = {};

  matches.forEach((match, index) => {
    const logicalName = match[1].trim();
    const blockStart = (match.index ?? 0) + match[0].length;
    const blockEnd = matches[index + 1]?.index ?? toml.length;
    const block = toml.slice(blockStart, blockEnd);
    const workbook = block.match(/^\s*workbook\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    const sheetExpression = block.match(/^\s*sheet\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
    const sheets = stringValues(sheetExpression);
    const enumExpression = block.match(/^\s*enums\s*=\s*\[([\s\S]*?)^\s*\]/m)?.[1] ?? "";
    const enums: ConfigCompilerEnumDefinition[] = [];
    for (const enumMatch of enumExpression.matchAll(/\{([^}]+)\}/g)) {
      const body = enumMatch[1];
      const field = body.match(/\bfield\s*=\s*"([^"]+)"/)?.[1]?.trim();
      const tableList = body.match(/\btable\s*=\s*"([^"]+)"/)?.[1];
      if (!field || !tableList) continue;
      enums.push({
        field,
        targetLogicalTables: tableList.split(",").map((value) => value.trim()).filter(Boolean),
      });
    }
    definitions[logicalName] = { logicalName, workbook, sheets, enums };
  });

  return definitions;
}

function issue(
  input: Omit<ConfigExportMappingIssue, "level" | "gate"> & {
    level?: ConfigExportMappingIssue["level"];
  },
): ConfigExportMappingIssue {
  return { level: input.level ?? "error", gate: "export", ...input };
}

export function validateConfigExportMapping(input: {
  mapping: ConfigExportMapping;
  compilerTables: Record<string, ConfigCompilerTableDefinition>;
}): ConfigExportMappingIssue[] {
  const issues: ConfigExportMappingIssue[] = [];
  const rowMappingIds = new Set<string>();

  if (!input.mapping.mappingId.trim() || !input.mapping.version.trim()) {
    issues.push(issue({
      code: "EXPORT_MAPPING_IDENTITY_MISSING",
      message: "配置导出映射必须声明 mappingId 与 version。",
      suggestion: "发布一个新的版本化 ConfigExportMapping。",
    }));
  }
  if (!input.mapping.rows.length) {
    issues.push(issue({
      code: "EXPORT_MAPPING_ROWS_EMPTY",
      message: "配置导出映射没有声明任何目标行。",
      suggestion: "至少声明一个由冻结 Snapshot 生成的逻辑表行。",
    }));
  }

  for (const row of input.mapping.rows) {
    if (rowMappingIds.has(row.rowMappingId)) {
      issues.push(issue({
        code: "EXPORT_ROW_MAPPING_DUPLICATED",
        message: `行映射 ${row.rowMappingId} 重复。`,
        logicalTable: row.logicalTable,
      }));
      continue;
    }
    rowMappingIds.add(row.rowMappingId);
    const declared = input.mapping.logicalTables[row.logicalTable];
    const compiler = input.compilerTables[row.logicalTable];
    if (!declared) {
      issues.push(issue({
        code: "EXPORT_LOGICAL_TABLE_UNDECLARED",
        message: `映射未声明逻辑表 ${row.logicalTable}。`,
        logicalTable: row.logicalTable,
      }));
      continue;
    }
    if (!Number.isInteger(declared.dataStartRow) || declared.dataStartRow < 2) {
      issues.push(issue({
        code: "EXPORT_DATA_START_ROW_INVALID",
        message: `${row.logicalTable} 必须显式声明合法的数据起始行。`,
        logicalTable: row.logicalTable,
        suggestion: "按目标工作表的真实表头结构填写 dataStartRow；系统不会猜测。",
      }));
      continue;
    }
    if (!compiler) {
      issues.push(issue({
        code: "EXPORT_LOGICAL_TABLE_NOT_IN_CONFIG",
        message: `config.toml 不包含逻辑表 ${row.logicalTable}。`,
        logicalTable: row.logicalTable,
        suggestion: "检查目标 Profile 的 config.toml 与映射版本。",
      }));
      continue;
    }
    if (compiler.workbook !== declared.workbook) {
      issues.push(issue({
        code: "EXPORT_WORKBOOK_MISMATCH",
        message: `${row.logicalTable} 的 workbook 与 config.toml 不一致。`,
        logicalTable: row.logicalTable,
        workbook: compiler.workbook,
        suggestion: `映射期望 ${declared.workbook}，请发布新映射而不是猜测。`,
      }));
    }
    if (!compiler.sheets.includes(declared.sheet)) {
      issues.push(issue({
        code: "EXPORT_SHEET_MISMATCH",
        message: `${row.logicalTable} 的 sheet 与 config.toml 不一致。`,
        logicalTable: row.logicalTable,
        workbook: compiler.workbook,
        sheet: declared.sheet,
      }));
    }
    if (declared.stableBusinessKey !== row.businessKeyField) {
      issues.push(issue({
        code: "EXPORT_BUSINESS_KEY_MISMATCH",
        message: `${row.logicalTable} 的稳定业务键声明不一致。`,
        logicalTable: row.logicalTable,
        field: row.businessKeyField,
      }));
    }
    if (!row.configNameKeyField?.trim()) {
      issues.push(issue({
        code: "EXPORT_CONFIG_NAME_KEY_MISSING",
        message: `${row.logicalTable} 未声明 configNameKeyField，不能按 ID + configNameKey 安全 upsert。`,
        logicalTable: row.logicalTable,
        suggestion: "发布包含稳定配置名称键的新 ConfigExportMapping。",
      }));
    } else if (!row.columns[row.configNameKeyField]) {
      issues.push(issue({
        code: "EXPORT_CONFIG_NAME_KEY_SOURCE_MISSING",
        message: `${row.logicalTable}.${row.configNameKeyField} 没有值来源。`,
        logicalTable: row.logicalTable,
        field: row.configNameKeyField,
      }));
    }
    if (!row.columns[row.businessKeyField]) {
      issues.push(issue({
        code: "EXPORT_BUSINESS_KEY_SOURCE_MISSING",
        message: `${row.logicalTable}.${row.businessKeyField} 没有值来源。`,
        logicalTable: row.logicalTable,
        field: row.businessKeyField,
        suggestion: "为业务 ID 配置显式 constant 或 Snapshot 来源。",
      }));
    }
  }
  return issues;
}

function resolveColumnValue(
  snapshot: ConfigurationSnapshot,
  source: ExportColumnSource,
): { ok: true; value: unknown } | { ok: false; sourceKey: string } {
  let value: unknown;
  let sourceKey: string;
  if (source.kind === "constant") {
    return { ok: true, value: structuredClone(source.value) };
  }
  if (source.kind === "target_existing_or_constant") {
    return { ok: true, value: structuredClone(source.value) };
  }
  if (source.kind === "snapshot_property") {
    sourceKey = source.property;
    value = snapshot[source.property];
  } else {
    sourceKey = source.key;
    value = snapshot.finalPanelValues[source.key];
  }

  if (value === undefined || value === null || value === "") {
    if (source.nullSentinel !== undefined) return { ok: true, value: source.nullSentinel };
    if (source.required === false) return { ok: true, value: null };
    return { ok: false, sourceKey };
  }
  if (source.kind === "snapshot_value" && (source.scale !== undefined || source.offset !== undefined || source.precision !== undefined)) {
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, sourceKey };
    const transformed = value * (source.scale ?? 1) + (source.offset ?? 0);
    value = source.precision === undefined
      ? transformed
      : Number(transformed.toFixed(source.precision));
  }
  return { ok: true, value };
}

export function materializeConfigExport(input: {
  snapshot: ConfigurationSnapshot;
  mapping: ConfigExportMapping;
  compilerTables: Record<string, ConfigCompilerTableDefinition>;
}): MaterializedConfigExport {
  assertSnapshotItemPartEnabled(input.snapshot, "config_export");
  const issues = validateConfigExportMapping({
    mapping: input.mapping,
    compilerTables: input.compilerTables,
  });
  const rows: MaterializedConfigRow[] = [];

  for (const rowMapping of input.mapping.rows) {
    const declared = input.mapping.logicalTables[rowMapping.logicalTable];
    const compiler = input.compilerTables[rowMapping.logicalTable];
    if (!declared || !compiler) continue;
    const values: Record<string, unknown> = {};
    const rowIssues: ConfigExportMappingIssue[] = [];
    for (const [field, source] of Object.entries(rowMapping.columns)) {
      const resolved = resolveColumnValue(input.snapshot, source);
      if (!resolved.ok) {
        rowIssues.push(issue({
          code: "EXPORT_MAPPING_SOURCE_MISSING",
          message: `${rowMapping.logicalTable}.${field} 缺少映射输入 ${resolved.sourceKey}。`,
          logicalTable: rowMapping.logicalTable,
          workbook: compiler.workbook,
          sheet: declared.sheet,
          field,
          sourceKey: resolved.sourceKey,
          suggestion: "补齐冻结 Snapshot 字段或发布显式常量映射；系统不会生成半行。",
        }));
      } else {
        values[field] = resolved.value;
      }
    }
    issues.push(...rowIssues);
    if (rowIssues.length) continue;
    const businessKey = values[rowMapping.businessKeyField];
    if (businessKey === undefined || businessKey === null || String(businessKey).trim() === "") {
      issues.push(issue({
        code: "EXPORT_BUSINESS_KEY_EMPTY",
        message: `${rowMapping.logicalTable}.${rowMapping.businessKeyField} 不能为空。`,
        logicalTable: rowMapping.logicalTable,
        workbook: compiler.workbook,
        sheet: declared.sheet,
        field: rowMapping.businessKeyField,
      }));
      continue;
    }
    const configNameKey = values[rowMapping.configNameKeyField];
    if (configNameKey === undefined || configNameKey === null || String(configNameKey).trim() === "") {
      issues.push(issue({
        code: "EXPORT_CONFIG_NAME_KEY_EMPTY",
        message: `${rowMapping.logicalTable}.${rowMapping.configNameKeyField} 不能为空。`,
        logicalTable: rowMapping.logicalTable,
        workbook: compiler.workbook,
        sheet: declared.sheet,
        field: rowMapping.configNameKeyField,
      }));
      continue;
    }
    rows.push({
      rowMappingId: rowMapping.rowMappingId,
      logicalTable: rowMapping.logicalTable,
      workbook: compiler.workbook,
      sheet: declared.sheet,
      businessKeyField: rowMapping.businessKeyField,
      configNameKeyField: rowMapping.configNameKeyField,
      values,
    });
  }

  return {
    mappingId: input.mapping.mappingId,
    mappingVersion: input.mapping.version,
    snapshotId: input.snapshot.id,
    rows,
    issues,
  };
}
