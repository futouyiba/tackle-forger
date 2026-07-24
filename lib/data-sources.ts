import type {
  AdjustmentRule,
  DataSourceBinding,
  DataSourceDataset,
  DataSourceIssue,
  DataSourcePreview,
  DataSourceProfile,
  DataSourceWritebackPreview,
  DimensionKey,
  FeishuShareLinkHistoryEntry,
  ItemKind,
  ModifierOption,
  ParameterDefinition,
  WeightTemplate,
  WorkspaceState,
} from "./types";

export interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

export interface PreparedDataSourcePreview extends DataSourcePreview {
  templates?: WeightTemplate[];
  modifiers?: ModifierOption[];
  bindings: DataSourceBinding[];
}

export function defaultDataSourceProfiles(): DataSourceProfile[] {
  return [
    {
      id: "source-a",
      name: "飞书 A 表",
      provider: "feishu_bitable",
      dataset: "weight_templates",
      appToken: "",
      tableId: "",
      viewId: "",
      shareUrl: "",
      enabled: true,
      notes: "默认用于重量段模板；可切换数据类型。",
    },
    {
      id: "source-b",
      name: "飞书 B 表",
      provider: "feishu_bitable",
      dataset: "modifiers",
      appToken: "",
      tableId: "",
      viewId: "",
      shareUrl: "",
      enabled: true,
      notes: "默认用于流派与定位系数；可切换数据类型。",
    },
  ];
}

/** 飞书分享链接历史的最大保留条数。仅作导入便利，不保存凭据。 */
export const FEISHU_SHARE_LINK_HISTORY_LIMIT = 20;

/**
 * 记录一条已成功识别的飞书分享链接到历史。按 shareUrl 去重并刷新
 * lastUsedAt；超过上限时丢弃最旧条目。返回新数组，不修改入参。
 *
 * 历史只存 shareUrl/label/dataset/lastUsedAt，绝不包含 appToken、密钥
 * 或任何凭据。dataset 与数据源配置保持一致，便于按用途回填。
 */
export function recordShareLinkHistory(
  history: readonly FeishuShareLinkHistoryEntry[],
  entry: {
    shareUrl: string;
    label: string;
    dataset: DataSourceDataset;
    lastUsedAt?: string;
  },
): FeishuShareLinkHistoryEntry[] {
  const shareUrl = entry.shareUrl.trim();
  if (!shareUrl) return [...history];
  const lastUsedAt = entry.lastUsedAt ?? new Date().toISOString();
  // 保留既有条目前先按白名单投影，剥离任何可能夹带的凭据/PII 字段。
  const preserved = history
    .map(projectShareLinkHistoryEntry)
    .filter((item): item is FeishuShareLinkHistoryEntry => item !== null)
    .filter((item) => item.shareUrl !== shareUrl);
  const next: FeishuShareLinkHistoryEntry = {
    id: shareUrl,
    shareUrl,
    label: entry.label.trim() || shareUrl,
    dataset: entry.dataset,
    lastUsedAt,
  };
  const updated = [next, ...preserved];
  return updated.slice(0, FEISHU_SHARE_LINK_HISTORY_LIMIT);
}

/**
 * 从历史中移除指定 shareUrl（或全部）。返回新数组，不修改入参。
 */
export function removeShareLinkHistory(
  history: readonly FeishuShareLinkHistoryEntry[],
  shareUrl: string | null,
): FeishuShareLinkHistoryEntry[] {
  if (shareUrl === null) return [];
  const target = shareUrl.trim();
  return history.filter((item) => item.shareUrl !== target);
}

/**
 * 将单条飞书分享链接历史条目按白名单显式重建为
 * `{ id, shareUrl, label, dataset, lastUsedAt }`，丢弃 appToken、secret、
 * password、credential、nonce、session、apikey、个人身份及任何未知键。
 * 结构或类型非法时返回 null（由调用方过滤）。
 *
 * 这是一道硬边界：不论来源是 v19 历史、v20 客户端保存载荷，还是运行时
 * 传入的数组，写入 `feishuShareLinkHistory` 前都必须经过此投影，确保
 * 历史绝不持久化凭据或个人身份信息。白名单以 `lib/types.ts` 的
 * `FeishuShareLinkHistoryEntry` 定义为准。
 */
export function projectShareLinkHistoryEntry(
  entry: unknown,
): FeishuShareLinkHistoryEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.shareUrl !== "string" || !raw.shareUrl) return null;
  if (typeof raw.label !== "string") return null;
  if (raw.dataset !== "weight_templates" && raw.dataset !== "modifiers") return null;
  if (typeof raw.lastUsedAt !== "string") return null;
  // 显式重建：只拷贝类型允许的白名单字段，忽略 raw 上的一切其他键。
  return {
    id: raw.id,
    shareUrl: raw.shareUrl,
    label: raw.label,
    dataset: raw.dataset,
    lastUsedAt: raw.lastUsedAt,
  };
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(",");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return textValue(item.text ?? item.name ?? item.value ?? item.link ?? "");
  }
  return "";
}

function field(fields: Record<string, unknown>, aliases: string[]): string {
  const normalized = new Map(
    Object.entries(fields).map(([key, value]) => [key.trim().toLowerCase(), value]),
  );
  for (const alias of aliases) {
    const value = normalized.get(alias.trim().toLowerCase());
    if (value !== undefined) return textValue(value);
  }
  return "";
}

function numberField(fields: Record<string, unknown>, aliases: string[]): number {
  const raw = field(fields, aliases).replace(/,/g, "");
  return raw === "" ? Number.NaN : Number(raw);
}

export function entityHash(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sourceFingerprint(source: DataSourceProfile) {
  return entityHash({
    provider: source.provider,
    dataset: source.dataset,
    appToken: source.appToken.trim(),
    tableId: source.tableId.trim(),
    viewId: source.viewId.trim(),
  });
}

function parseRuleCell(text: string, parameterKey: string, recordId: string): AdjustmentRule | null {
  const value = text.trim();
  if (!value) return null;
  const operations: Record<string, AdjustmentRule["operation"]> = {
    "×": "multiply",
    "*": "multiply",
    "+": "add",
    "=": "set",
    "≤": "min",
    "≥": "max",
    "ƒ": "formula",
  };
  const prefix = value[0];
  const operation = operations[prefix] ?? "set";
  const raw = operations[prefix] ? value.slice(1).trim() : value;
  const numeric = Number(raw);
  return {
    id: "source-" + recordId + "-" + parameterKey,
    parameterKey,
    operation,
    value: operation === "formula" || Number.isNaN(numeric) ? raw : numeric,
    notes: "飞书数据源导入",
  };
}

function dimensionValue(value: string): DimensionKey | null {
  const aliases: Record<string, DimensionKey> = {
    structure: "structure",
    结构: "structure",
    结构类型: "structure",
    material: "material",
    材质: "material",
    类型材质: "material",
    function: "function",
    功能: "function",
    功能定位: "function",
    performance: "performance",
    性能: "performance",
    性能定位: "performance",
    technology: "technology",
    技术: "technology",
    series: "series",
    系列: "series",
    特殊系列: "series",
  };
  return aliases[value.trim().toLowerCase()] ?? null;
}

function itemKindsValue(value: string): ItemKind[] {
  if (!value.trim()) return ["rod", "reel", "line"];
  const aliases: Record<string, ItemKind> = {
    rod: "rod",
    杆: "rod",
    鱼竿: "rod",
    reel: "reel",
    轮: "reel",
    渔轮: "reel",
    line: "line",
    线: "line",
    鱼线: "line",
  };
  return Array.from(
    new Set(
      value
        .split(/[,，、;/\s]+/)
        .map((item) => aliases[item.trim().toLowerCase()])
        .filter((item): item is ItemKind => Boolean(item)),
    ),
  );
}

function convertTemplates(records: FeishuRecord[], parameters: ParameterDefinition[]) {
  return records.map((record) => {
    const values: Record<string, number | string> = {};
    for (const parameter of parameters) {
      const raw = field(record.fields, [parameter.label, parameter.key]);
      if (!raw) continue;
      const numeric = Number(raw.replace(/,/g, ""));
      values[parameter.key] = Number.isNaN(numeric) ? raw : numeric;
    }
    const id = field(record.fields, ["模板ID", "模板 Id", "templateId", "id"]);
    const tier = field(record.fields, ["档位", "重量段", "tier"]);
    return {
      id,
      name: field(record.fields, ["模板名称", "名称", "name"]) || tier || id,
      fishMinKg: numberField(record.fields, ["鱼重下限kg", "鱼重下限", "fishMinKg"]),
      fishMaxKg: numberField(record.fields, ["鱼重上限kg", "鱼重上限", "fishMaxKg"]),
      nominalFishKg: numberField(record.fields, ["标称鱼重kg", "标称鱼重", "nominalFishKg"]),
      tier,
      values,
      notes: field(record.fields, ["备注", "说明", "notes"]),
    } satisfies WeightTemplate;
  });
}

function convertModifiers(records: FeishuRecord[], parameters: ParameterDefinition[]) {
  return records.map((record) => {
    const id = field(record.fields, ["规则ID", "系数ID", "ID", "id"]);
    const rawDimension = field(record.fields, ["维度", "规则维度", "dimension"]);
    const rules = parameters
      .map((parameter) =>
        parseRuleCell(
          field(record.fields, [parameter.label, parameter.key]),
          parameter.key,
          record.record_id,
        ),
      )
      .filter((rule): rule is AdjustmentRule => Boolean(rule));
    const enabled = field(record.fields, ["启用", "状态", "enabled"]).trim().toLowerCase();
    return {
      id,
      dimension: dimensionValue(rawDimension) ?? "function",
      name: field(record.fields, ["名称", "规则名称", "name"]) || id,
      level: field(record.fields, ["级别", "等级", "level"]) || "—",
      itemKinds: itemKindsValue(field(record.fields, ["适用道具", "道具类型", "itemKinds"])),
      rules,
      notes: field(record.fields, ["备注", "说明", "notes"]),
      enabled: !["否", "禁用", "false", "0", "no", "off"].includes(enabled),
    } satisfies ModifierOption;
  });
}


function resolvedFieldName(fields: Record<string, unknown>, aliases: string[]): string {
  const names = new Map(Object.keys(fields).map((key) => [key.trim().toLowerCase(), key]));
  for (const alias of aliases) {
    const name = names.get(alias.trim().toLowerCase());
    if (name) return name;
  }
  return "";
}

const templateAliases = {
  id: ["模板ID", "模板 Id", "templateId", "id"],
  name: ["模板名称", "名称", "name"],
  fishMinKg: ["鱼重下限kg", "鱼重下限", "fishMinKg"],
  fishMaxKg: ["鱼重上限kg", "鱼重上限", "fishMaxKg"],
  nominalFishKg: ["标称鱼重kg", "标称鱼重", "nominalFishKg"],
  tier: ["档位", "重量段", "tier"],
  notes: ["备注", "说明", "notes"],
} satisfies Record<string, string[]>;

const modifierAliases = {
  id: ["规则ID", "系数ID", "ID", "id"],
  dimension: ["维度", "规则维度", "dimension"],
  name: ["名称", "规则名称", "name"],
  level: ["级别", "等级", "level"],
  itemKinds: ["适用道具", "道具类型", "itemKinds"],
  notes: ["备注", "说明", "notes"],
  enabled: ["启用", "状态", "enabled"],
} satisfies Record<string, string[]>;

function bindingFieldMap(
  source: DataSourceProfile,
  record: FeishuRecord,
  parameters: ParameterDefinition[],
) {
  const result: Record<string, string> = {};
  const aliases = source.dataset === "weight_templates" ? templateAliases : modifierAliases;
  for (const [canonical, names] of Object.entries(aliases)) {
    const actual = resolvedFieldName(record.fields, names);
    if (actual) result[canonical] = actual;
  }
  for (const parameter of parameters) {
    const actual = resolvedFieldName(record.fields, [parameter.label, parameter.key]);
    if (actual) {
      result[(source.dataset === "weight_templates" ? "value." : "rule.") + parameter.key] =
        actual;
    }
  }
  return result;
}

function buildBindings(
  source: DataSourceProfile,
  records: FeishuRecord[],
  entities: Array<WeightTemplate | ModifierOption>,
  parameters: ParameterDefinition[],
): DataSourceBinding[] {
  return entities.map((entity, index) => ({
    sourceId: source.id,
    dataset: source.dataset,
    entityId: entity.id,
    recordId: records[index]?.record_id ?? "",
    baselineHash: entityHash(entity),
    baseline: structuredClone(entity),
    fieldMap: bindingFieldMap(source, records[index] ?? { record_id: "", fields: {} }, parameters),
  }));
}

function ruleCell(rule: AdjustmentRule | undefined): number | string {
  if (!rule) return "";
  const prefixes: Record<AdjustmentRule["operation"], string> = {
    add: "+",
    multiply: "×",
    set: "=",
    min: "≤",
    max: "≥",
    formula: "ƒ",
  };
  return prefixes[rule.operation] + String(rule.value);
}

function changedFields(
  binding: DataSourceBinding,
  current: WeightTemplate | ModifierOption,
): { fields: Record<string, unknown>; missing: string[] } {
  const baseline = binding.baseline;
  const fields: Record<string, unknown> = {};
  const missing: string[] = [];
  const add = (canonical: string, before: unknown, after: unknown, value: unknown = after) => {
    if (entityHash(before) === entityHash(after)) return;
    const fieldName = binding.fieldMap[canonical];
    if (!fieldName) {
      missing.push(canonical);
      return;
    }
    fields[fieldName] = value;
  };

  if (binding.dataset === "weight_templates") {
    const before = baseline as WeightTemplate;
    const after = current as WeightTemplate;
    add("name", before.name, after.name);
    add("fishMinKg", before.fishMinKg, after.fishMinKg);
    add("fishMaxKg", before.fishMaxKg, after.fishMaxKg);
    add("nominalFishKg", before.nominalFishKg, after.nominalFishKg);
    add("tier", before.tier, after.tier);
    add("notes", before.notes, after.notes);
    const keys = new Set([...Object.keys(before.values), ...Object.keys(after.values)]);
    for (const key of keys) {
      add("value." + key, before.values[key], after.values[key], after.values[key] ?? "");
    }
  } else {
    const before = baseline as ModifierOption;
    const after = current as ModifierOption;
    add("dimension", before.dimension, after.dimension);
    add("name", before.name, after.name);
    add("level", before.level, after.level);
    add("itemKinds", before.itemKinds, after.itemKinds, after.itemKinds.join(","));
    add("notes", before.notes, after.notes);
    add("enabled", before.enabled, after.enabled);
    const beforeRules = new Map(before.rules.map((rule) => [rule.parameterKey, rule]));
    const afterRules = new Map(after.rules.map((rule) => [rule.parameterKey, rule]));
    const keys = new Set([...beforeRules.keys(), ...afterRules.keys()]);
    for (const key of keys) {
      add(
        "rule." + key,
        beforeRules.get(key),
        afterRules.get(key),
        ruleCell(afterRules.get(key)),
      );
    }
  }
  return { fields, missing };
}

export function prepareDataSourceWriteback(
  source: DataSourceProfile,
  records: FeishuRecord[],
  state: WorkspaceState,
  pulledAt = new Date().toISOString(),
): DataSourceWritebackPreview {
  const issues: DataSourceIssue[] = [];
  const bindings = state.dataSourceBindings.filter(
    (binding) => binding.sourceId === source.id && binding.dataset === source.dataset,
  );
  const currentEntities: Array<WeightTemplate | ModifierOption> =
    source.dataset === "weight_templates" ? state.templates : state.modifiers;
  const currentById = new Map(currentEntities.map((entity) => [entity.id, entity]));
  const boundIds = new Set(bindings.map((binding) => binding.entityId));
  const latestEntities: Array<WeightTemplate | ModifierOption> =
    source.dataset === "weight_templates"
      ? convertTemplates(records, state.parameters)
      : convertModifiers(records, state.parameters);
  const latestByRecord = new Map(
    records.map((record, index) => [record.record_id, latestEntities[index]]),
  );
  const rows: DataSourceWritebackPreview["rows"] = [];

  if (!bindings.length) {
    issues.push({
      level: "error",
      message: "此数据源尚未发布并建立来源绑定，不能回写。请先拉取、预览并发布一次。",
    });
  }

  for (const entity of currentEntities) {
    if (!boundIds.has(entity.id)) {
      issues.push({
        level: "warning",
        rowId: entity.id,
        message: "本地新增记录没有飞书行绑定，本次不会自动新建飞书记录。",
      });
    }
  }

  for (const binding of bindings) {
    const current = currentById.get(binding.entityId);
    if (!current) {
      issues.push({
        level: "error",
        rowId: binding.entityId,
        message: "本地记录已删除或 ID 已修改；为防止误删飞书行，本次回写已阻止。",
      });
      continue;
    }
    if (entityHash(current) === binding.baselineHash) continue;
    if (entityHash(binding.baseline) !== binding.baselineHash) {
      issues.push({
        level: "error",
        rowId: binding.entityId,
        message: "来源基准已损坏，请重新从飞书拉取并发布。",
      });
      continue;
    }
    const latest = latestByRecord.get(binding.recordId);
    if (!latest) {
      issues.push({
        level: "error",
        rowId: binding.entityId,
        message: "对应飞书行已不存在，已阻止回写。",
      });
      continue;
    }
    if (entityHash(latest) !== binding.baselineHash) {
      issues.push({
        level: "error",
        rowId: binding.entityId,
        message: "该行在飞书中也发生了变化，请先重新拉取并处理冲突。",
      });
      continue;
    }
    const change = changedFields(binding, current);
    if (change.missing.length) {
      issues.push({
        level: "error",
        rowId: binding.entityId,
        message: "以下本地改动在飞书源表中没有对应列：" + change.missing.join("、"),
      });
      continue;
    }
    const fieldNames = Object.keys(change.fields);
    if (fieldNames.length) {
      rows.push({
        entityId: binding.entityId,
        recordId: binding.recordId,
        fieldNames,
        fields: change.fields,
      });
    }
  }

  return {
    sourceId: source.id,
    sourceName: source.name,
    dataset: source.dataset,
    sourceFingerprint: sourceFingerprint(source),
    checksum: entityHash(rows),
    pulledAt,
    recordCount: rows.length,
    fieldCount: rows.reduce((sum, row) => sum + row.fieldNames.length, 0),
    issues,
    rows,
  };
}

function validateTemplates(rows: WeightTemplate[]): DataSourceIssue[] {
  const issues: DataSourceIssue[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id) issues.push({ level: "error", message: "存在缺少模板ID的记录。" });
    if (row.id && seen.has(row.id)) {
      issues.push({ level: "error", rowId: row.id, message: "模板ID " + row.id + " 重复。" });
    }
    seen.add(row.id);
    if (![row.fishMinKg, row.fishMaxKg, row.nominalFishKg].every(Number.isFinite)) {
      issues.push({
        level: "error",
        rowId: row.id,
        message: "鱼重下限、上限和标称鱼重必须是数字。",
      });
    } else if (row.fishMinKg >= row.fishMaxKg) {
      issues.push({ level: "error", rowId: row.id, message: "鱼重下限必须小于上限。" });
    } else if (row.nominalFishKg < row.fishMinKg || row.nominalFishKg > row.fishMaxKg) {
      issues.push({ level: "error", rowId: row.id, message: "标称鱼重必须落在重量段内。" });
    }
    if (!row.tier) issues.push({ level: "warning", rowId: row.id, message: "档位为空。" });
  }
  if (!rows.length) {
    issues.push({ level: "error", message: "源表没有可导入记录，已阻止空表覆盖。" });
  }
  return issues;
}

function validateModifiers(
  rows: ModifierOption[],
  records: FeishuRecord[],
): DataSourceIssue[] {
  const issues: DataSourceIssue[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!row.id) issues.push({ level: "error", message: "存在缺少规则ID的记录。" });
    if (row.id && seen.has(row.id)) {
      issues.push({ level: "error", rowId: row.id, message: "规则ID " + row.id + " 重复。" });
    }
    seen.add(row.id);
    const rawDimension = field(
      records[index]?.fields ?? {},
      ["维度", "规则维度", "dimension"],
    );
    if (!dimensionValue(rawDimension)) {
      issues.push({
        level: "error",
        rowId: row.id,
        message: "无法识别规则维度“" + (rawDimension || "空") + "”。",
      });
    }
    if (!row.rules.length) {
      issues.push({ level: "warning", rowId: row.id, message: "该规则没有任何参数系数。" });
    }
  });
  if (!rows.length) {
    issues.push({ level: "error", message: "源表没有可导入记录，已阻止空表覆盖。" });
  }
  return issues;
}

function diffSummary<T extends { id: string }>(current: T[], incoming: T[]) {
  const before = new Map(current.map((item) => [item.id, entityHash(item)]));
  const after = new Map(incoming.map((item) => [item.id, entityHash(item)]));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const [id, checksum] of after) {
    if (!before.has(id)) added += 1;
    else if (before.get(id) === checksum) unchanged += 1;
    else changed += 1;
  }
  let removed = 0;
  for (const id of before.keys()) if (!after.has(id)) removed += 1;
  return { added, changed, removed, unchanged };
}

export function prepareDataSourcePreview(
  source: DataSourceProfile,
  records: FeishuRecord[],
  state: WorkspaceState,
  pulledAt = new Date().toISOString(),
): PreparedDataSourcePreview {
  if (source.dataset === "weight_templates") {
    const templates = convertTemplates(records, state.parameters);
    return {
      sourceId: source.id,
      sourceName: source.name,
      dataset: source.dataset,
      sourceFingerprint: sourceFingerprint(source),
      checksum: entityHash(templates),
      pulledAt,
      recordCount: templates.length,
      summary: diffSummary(state.templates, templates),
      issues: validateTemplates(templates),
      templates,
      bindings: buildBindings(source, records, templates, state.parameters),
    };
  }
  const modifiers = convertModifiers(records, state.parameters);
  return {
    sourceId: source.id,
    sourceName: source.name,
    dataset: source.dataset,
    sourceFingerprint: sourceFingerprint(source),
    checksum: entityHash(modifiers),
    pulledAt,
    recordCount: modifiers.length,
    summary: diffSummary(state.modifiers, modifiers),
    issues: validateModifiers(modifiers, records),
    modifiers,
    bindings: buildBindings(source, records, modifiers, state.parameters),
  };
}

export function applyDataSourcePreview(
  state: WorkspaceState,
  preview: PreparedDataSourcePreview,
): WorkspaceState {
  const next = structuredClone(state);
  if (preview.dataset === "weight_templates" && preview.templates) {
    next.templates = preview.templates;
  }
  if (preview.dataset === "modifiers" && preview.modifiers) {
    next.modifiers = preview.modifiers;
  }
  next.dataSourceBindings = [
    ...next.dataSourceBindings.filter((binding) => binding.dataset !== preview.dataset),
    ...preview.bindings,
  ];
  next.importedAt = preview.pulledAt;
  return next;
}

export function datasetLabel(dataset: DataSourceProfile["dataset"]) {
  return dataset === "weight_templates" ? "重量段模板" : "流派 / 定位系数";
}
