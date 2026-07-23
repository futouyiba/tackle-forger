import { deterministicHash } from "./rule-kernel";
import type { FeishuSourceRevision } from "./feishu-workbook";
import type {
  AdjustmentRule,
  CanonicalRuleSourceDraft,
  CanonicalRuleSourceIssue,
  DimensionKey,
  FunctionIntensity,
  FunctionProfile,
  ItemKind,
  ItemTypeProfile,
  MethodProfile,
  ModifierOption,
  ParameterDefinition,
  RuleLayer,
  WeightTemplate,
} from "./types";

export const CANONICAL_RULE_RANGES = {
  // revision 4226: each source sheet has one block per rod/reel/line, with
  // an empty separator and a repeated header for each block.
  weight: { sheetId: "d6e928", range: "A1:AE54" },
  type: { sheetId: "fATowU", range: "A1:AE20" },
  function: { sheetId: "vviXo0", range: "A1:AG63" },
  method: { sheetId: "rgFPUu", range: "A1:AB12" },
  methodTemplateReview: { sheetId: "m3eQCg", range: "A1:AB83" },
} as const;

const METHOD_IDS: Record<string, string> = {
  浮钓: "method:float",
  路亚: "method:lure",
  水底: "method:bottom",
  海钓: "method:sea",
};

const ESTABLISHED_PARAMETER_KEYS: Record<string, string> = {
  竿拉力: "杆最大拉力kgf",
  竿抛投系数: "杆抛投基础",
  竿耐久: "杆最大耐力",
  竿长度: "杆长m",
  竿自重: "杆自重g",
  竿饵重下限: "饵重下限g",
  竿饵重上限: "饵重上限g",
  竿调性: "钓性",
  竿硬度: "硬度",
  轮拉力: "轮最大拉力kgf",
  轮抛投系数: "轮抛投基础",
  轮耐久: "轮最大耐力",
  轮自重: "轮自重g",
  绕线量: "上线量m",
  线拉力: "线最大拉力kgf",
  线抛投系数: "线抛投基础",
  线号大小: "PE线号",
  线张力系数: "线张力指数",
};

const PART_SCOPED_SHARED_HEADERS = new Set(["修理系数", "购买系数", "维修系数", "购入系数"]);

function asText(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asFinite(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function parameterKind(label: string): ItemKind {
  if (label.startsWith("轮") || ["传动比", "饵重下限", "饵重上限", "绕线量", "线径", "积热系数", "散热系数", "摩擦截面数", "张力系数", "摩檫力系数"].includes(label)) return "reel";
  if (label.startsWith("线")) return "line";
  return "rod";
}

function parameterKey(label: string, kind = parameterKind(label)) {
  if (ESTABLISHED_PARAMETER_KEYS[label]) return ESTABLISHED_PARAMETER_KEYS[label];
  if (kind && PART_SCOPED_SHARED_HEADERS.has(label)) {
    const prefix = kind === "rod" ? "竿" : kind === "reel" ? "轮" : "线";
    return `${prefix}${label}`;
  }
  if (kind === "reel" && ["饵重下限", "饵重上限", "线径", "张力系数"].includes(label)) return `轮${label}`;
  return label;
}

function unitFor(label: string) {
  if (label.includes("拉力")) return "kgf";
  if (label.includes("自重") || label.includes("饵重")) return "g";
  if (label.includes("长度") || label.includes("绕线量")) return "m";
  return "";
}

function definitions(headers: Array<{ label: string; kind?: ItemKind }>): ParameterDefinition[] {
  const seen = new Set<string>();
  return headers.flatMap(({ label, kind: specifiedKind }) => {
    const kind = specifiedKind ?? parameterKind(label);
    const key = parameterKey(label, kind);
    if (!label || seen.has(key)) return [];
    seen.add(key);
    return [{
      key,
      label,
      itemKind: kind,
      itemPartId: `part:${kind}`,
      unit: unitFor(label),
      precision: 3,
      benefitMode: label.includes("自重") ? "lower_better" as const : "contextual" as const,
      balanceWeight: 1,
      normalizationScale: 1,
      allowedOperations: ["add", "multiply", "set", "min", "max", "formula"] as ParameterDefinition["allowedOperations"],
      notes: "来自飞书规则工作簿；显示名保持源表表头。",
    }];
  });
}

function sourceParameterHeaders(input: {
  weightHeaders: string[];
  typeValues: unknown[][];
  functionValues: unknown[][];
}) {
  const result: Array<{ label: string; kind?: ItemKind }> = input.weightHeaders.map((label) => ({ label }));
  for (const row of input.typeValues) {
    if (!asText(row[1]).includes("机器ID")) continue;
    const typeLabel = asText(row[3]);
    const kind: ItemKind = typeLabel.includes("轮") ? "reel" : typeLabel.includes("线") ? "line" : "rod";
    result.push(...row.slice(5).map(asText).filter(Boolean).map((label) => ({ label, kind })));
  }
  const functionMetadata = new Set(["机器ID（勿改）", "实体类型", "FunctionProfile ID（勿改）", "功能定位", "定位/类型", "级别", "评分系数"]);
  for (const functionHeader of input.functionValues.filter((row) => row.some((value) => asText(value).includes("机器ID")))) {
    result.push(...functionHeader.map(asText).filter((label) => label && !functionMetadata.has(label)).map((label) => ({ label })));
  }
  return result;
}

function methodId(name: string) {
  // This is the explicit source binding for the Method dimension. Display names
  // are not identities: an unknown/renamed value must be reviewed upstream.
  return METHOD_IDS[name];
}

function sourceRule(input: {
  id: string;
  header: string;
  raw: unknown;
  kind?: ItemKind;
  sourceRevisionId: string;
  sheetId: string;
  row: number;
  column: number;
}): AdjustmentRule | undefined {
  const rawText = asText(input.raw);
  if (!rawText || rawText === "-" || rawText === "—") return undefined;
  const numeric = asFinite(input.raw);
  return {
    id: input.id,
    parameterKey: parameterKey(input.header, input.kind),
    operation: numeric === undefined ? "set" : "multiply",
    value: numeric ?? rawText,
    notes: "来自飞书系数矩阵。",
    sourceRevisionId: input.sourceRevisionId,
    sourceSheetId: input.sheetId,
    sourceCell: `${columnName(input.column)}${input.row}`,
  };
}

function parseWeight(input: {
  values: unknown[][];
  sourceRevisionId: string;
  issues: CanonicalRuleSourceIssue[];
}) {
  let headers: string[] = [];
  let columns: Record<string, number | undefined> = {};
  const attributeHeaders: string[] = [];
  const seen = new Set<string>();
  const templates: WeightTemplate[] = [];
  const templateKinds = new Map<string, ItemKind>();
  for (let index = 0; index < input.values.length; index += 1) {
    const row = input.values[index] ?? [];
    const sourceRow = index + 1;
    if (row.some((value) => asText(value).includes("机器ID"))) {
      headers = row.map(asText);
      const find = (label: string) => headers.findIndex((value) => value === label);
      columns = { id: find("机器ID（勿改）"), part: find("钓具大类"), notes: find("备注"), band: find("重量段"), min: find("最小拉力"), max: find("最大拉力"), grade: find("鱼重等级") };
      for (const [column, header] of headers.entries()) if (header && !Object.values(columns).includes(column)) attributeHeaders.push(header);
      continue;
    }
    if (!headers.length || !row.some((value) => asText(value))) continue;
    const id = asText(row[columns.id ?? -1]);
    const min = asFinite(row[columns.min ?? -1]);
    const max = asFinite(row[columns.max ?? -1]);
    const isSourceRow = Boolean(id || min !== undefined || max !== undefined || asText(row[columns.band ?? -1]));
    if (!id) {
      if (isSourceRow) input.issues.push({ level: "error", code: "WEIGHT_TEMPLATE_ID_MISSING", message: `重量模板第 ${sourceRow} 行缺少机器 ID。`, sheetId: CANONICAL_RULE_RANGES.weight.sheetId, row: sourceRow });
      continue;
    }
    if (seen.has(id)) input.issues.push({ level: "error", code: "WEIGHT_TEMPLATE_ID_DUPLICATE", message: `重量模板 ID 重复：${id}`, sheetId: CANONICAL_RULE_RANGES.weight.sheetId, row: sourceRow });
    seen.add(id);
    if (min === undefined || max === undefined || min >= max) {
      input.issues.push({ level: "error", code: "WEIGHT_TEMPLATE_ROW_INVALID", message: `重量模板 ${id} 的拉力区间无效。`, sheetId: CANONICAL_RULE_RANGES.weight.sheetId, row: sourceRow });
      continue;
    }
    const values: Record<string, number | string> = {};
    for (let column = 0; column < headers.length; column += 1) {
      const header = headers[column];
      if (!header || Object.values(columns).includes(column)) continue;
      const raw = row[column];
      if (raw === null || raw === undefined || asText(raw) === "") continue;
      values[parameterKey(header)] = asFinite(raw) ?? asText(raw);
    }
    const band = asText(row[columns.band ?? -1]);
    const fishGrade = asFinite(row[columns.grade ?? -1]) ?? asText(row[columns.grade ?? -1]);
    const partName = asText(row[columns.part ?? -1]);
    const itemKind: ItemKind = partName.includes("轮") ? "reel" : partName.includes("线") ? "line" : "rod";
    templates.push({
      id,
      name: band || id,
      fishMinKg: min,
      fishMaxKg: max,
      nominalFishKg: (min + max) / 2,
      rangeSemantics: "target_pull",
      targetPullMinKgf: min,
      targetPullMaxKgf: max,
      nominalTargetPullKgf: (min + max) / 2,
      tier: band,
      values,
      notes: asText(row[columns.notes ?? -1]),
      sourceRevisionId: input.sourceRevisionId,
      sourceSheetId: CANONICAL_RULE_RANGES.weight.sheetId,
      sourceRow,
      fishWeightLevel: fishGrade,
    });
    templateKinds.set(id, itemKind);
  }
  if (!templates.length) input.issues.push({ level: "error", code: "WEIGHT_TEMPLATE_EMPTY", message: "01_重量模板没有可导入记录。", sheetId: CANONICAL_RULE_RANGES.weight.sheetId });
  return { templates, attributeHeaders, templateKinds };
}

function parseMethods(input: { values: unknown[][]; sourceRevisionId: string; issues: CanonicalRuleSourceIssue[] }) {
  let headers: string[] = [];
  let columns: Record<string, number> = {};
  const entries: Array<{ profile: MethodProfile; kind: ItemKind }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.values.length; index += 1) {
    const row = input.values[index] ?? [];
    const sourceRow = index + 1;
    if (row.some((value) => asText(value).includes("机器ID"))) {
      headers = row.map(asText);
      const findOne = (...labels: string[]) => headers.findIndex((value) => labels.includes(value));
      columns = { id: findOne("机器ID（勿改）"), name: findOne("钓法", "钓法类型"), part: findOne("钓具大类", "部位") };
      continue;
    }
    if (!headers.length || !row.some((value) => asText(value))) continue;
    const id = asText(row[columns.id]);
    if (!id) { input.issues.push({ level: "error", code: "METHOD_ID_MISSING", message: `钓法类型第 ${sourceRow} 行缺少机器 ID。`, sheetId: CANONICAL_RULE_RANGES.method.sheetId, row: sourceRow }); continue; }
    if (seen.has(id)) input.issues.push({ level: "error", code: "METHOD_ID_DUPLICATE", message: `钓法类型稳定 ID 重复：${id}`, sheetId: CANONICAL_RULE_RANGES.method.sheetId, row: sourceRow });
    seen.add(id);
    const name = asText(row[columns.name]) || id;
    const part = asText(row[columns.part]);
    const kind: ItemKind = part.includes("轮") || id.includes("_reel_") ? "reel" : part.includes("线") || id.includes("_line_") ? "line" : "rod";
    const rules = headers.flatMap((header, column) => {
      if (!header || Object.values(columns).includes(column)) return [];
      const rule = sourceRule({ id: `${id}:${columnName(column)}${sourceRow}`, header, raw: row[column], kind, sourceRevisionId: input.sourceRevisionId, sheetId: CANONICAL_RULE_RANGES.method.sheetId, row: sourceRow, column });
      return rule ? [rule] : [];
    });
    entries.push({ profile: { id, name, rules, enabled: true, sourceRevisionId: input.sourceRevisionId, notes: "来自飞书 02_钓法类型的稳定 fishing_* 行。" }, kind });
  }
  return entries;
}

function deriveMethodTemplates(input: { templates: WeightTemplate[]; templateKinds: Map<string, ItemKind>; methods: Array<{ profile: MethodProfile; kind: ItemKind }> }) {
  if (!input.methods.length) return input.templates;
  return input.templates.flatMap((template) => input.methods.filter((method) => method.kind === input.templateKinds.get(template.id)).map(({ profile }) => {
    const values = { ...template.values };
    for (const rule of profile.rules) {
      const current = values[rule.parameterKey];
      if (typeof current !== "number" || typeof rule.value !== "number") continue;
      if (rule.operation === "multiply") values[rule.parameterKey] = current * rule.value;
      if (rule.operation === "set") values[rule.parameterKey] = rule.value;
    }
    return { ...template, id: `${template.id}:${profile.id}`, name: `${template.name} · ${profile.name}`, methodId: profile.id, values, notes: `${template.notes ?? ""}；钓法系数：${profile.id}` };
  }));
}

function parseTypes(input: { values: unknown[][]; sourceRevisionId: string; methodProfiles: MethodProfile[]; issues: CanonicalRuleSourceIssue[] }) {
  let headers: string[] = [];
  let columns: Record<string, number | undefined> = {};
  const profiles: ItemTypeProfile[] = [];
  const modifiers: ModifierOption[] = [];
  const seen = new Set<string>();
  const allMethodIds = input.methodProfiles.map((entry) => entry.id);
  for (let index = 0; index < input.values.length; index += 1) {
    const row = input.values[index] ?? [];
    if (row.some((value) => asText(value).includes("机器ID"))) {
      headers = row.map(asText);
      const find = (label: string) => headers.findIndex((value) => value === label);
      columns = { id: find("机器ID（勿改）"), entityType: find("实体类型"), band: find("重量段"), method: find("钓法"), name: find("具体类型") };
      continue;
    }
    if (!headers.length || !row.some((value) => asText(value))) continue;
    const entityType = asText(row[columns.entityType ?? -1]);
    const sourceRow = index + 1;
    const id = asText(row[columns.id ?? -1]);
    if (!/^(RodType|ReelType|LineType)$/.test(entityType)) continue;
    if (!id) {
      input.issues.push({ level: "error", code: "ITEM_TYPE_ID_MISSING", message: `类型材质第 ${sourceRow} 行缺少机器 ID。`, sheetId: CANONICAL_RULE_RANGES.type.sheetId, row: sourceRow });
      continue;
    }
    if (seen.has(id)) input.issues.push({ level: "error", code: "ITEM_TYPE_ID_DUPLICATE", message: `类型 ID 重复：${id}`, sheetId: CANONICAL_RULE_RANGES.type.sheetId, row: sourceRow });
    seen.add(id);
    const kind: ItemKind = entityType === "RodType" ? "rod" : entityType === "ReelType" ? "reel" : "line";
    const rules = headers.flatMap((header, column) => {
      if (!header || Object.values(columns).includes(column)) return [];
      const rule = sourceRule({ id: `${id}:${columnName(column)}${sourceRow}`, header, raw: row[column], kind, sourceRevisionId: input.sourceRevisionId, sheetId: CANONICAL_RULE_RANGES.type.sheetId, row: sourceRow, column });
      return rule ? [rule] : [];
    });
    const sourceMethods = asText(row[columns.method ?? -1]).split(/[、,，/|]/).map((value) => value.trim()).filter((value) => value && value !== "-");
    const resolvedMethods = sourceMethods.length ? sourceMethods.map(methodId) : allMethodIds;
    if (resolvedMethods.some((method) => !method)) {
      input.issues.push({ level: "error", code: "ITEM_TYPE_METHOD_UNKNOWN", message: `类型 ${id} 引用了未绑定稳定 ID 的钓法。`, sheetId: CANONICAL_RULE_RANGES.type.sheetId, row: sourceRow });
      continue;
    }
    const methods = resolvedMethods as string[];
    const name = asText(row[columns.name ?? -1]) || id;
    profiles.push({ id, name, methodIds: methods, itemPartIds: [`part:${kind}`], rules, enabled: true, sourceRevisionId: input.sourceRevisionId, notes: `来自飞书 02_类型材质第 ${sourceRow} 行。` });
    const dimension: DimensionKey = kind === "line" ? "material" : "structure";
    modifiers.push({ id, dimension, name, level: 1, itemKinds: [kind], methodIds: methods, rules: structuredClone(rules), notes: `来自飞书 02_类型材质第 ${sourceRow} 行。`, enabled: true });
  }
  if (!profiles.length) input.issues.push({ level: "error", code: "ITEM_TYPE_EMPTY", message: "02_类型材质没有可导入记录。", sheetId: CANONICAL_RULE_RANGES.type.sheetId });
  return { profiles, modifiers };
}

function parseFunctions(input: { values: unknown[][]; sourceRevisionId: string; issues: CanonicalRuleSourceIssue[] }) {
  let headers: string[] = [];
  let columns: Record<string, number | undefined> = {};
  let headerInvalid = false;
  const metadataLabels = new Set(["机器ID（勿改）", "实体类型", "FunctionProfile ID（勿改）", "功能定位", "定位/类型", "级别", "评分系数"]);
  const rows: Array<{ id: string; groupId: string; name: string; intensity: FunctionIntensity; rules: AdjustmentRule[]; sourceRow: number }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.values.length; index += 1) {
    const row = input.values[index] ?? [];
    const sourceRow = index + 1;
    if (row.some((value) => asText(value).includes("机器ID"))) {
      headers = row.map(asText);
      const resolve = (label: string, code: string) => {
        const matches = headers.reduce<number[]>((all, value, column) => value === label ? [...all, column] : all, []);
        if (matches.length === 1) return matches[0];
        input.issues.push({ level: "error", code, message: `功能定位区块第 ${sourceRow} 行必须且只能包含一列 ${label}。`, sheetId: CANONICAL_RULE_RANGES.function.sheetId, row: sourceRow });
        headerInvalid = true;
        return undefined;
      };
      columns = {
        id: resolve("机器ID（勿改）", "FUNCTION_ROW_ID_COLUMN_INVALID"),
        groupId: resolve("FunctionProfile ID（勿改）", "FUNCTION_PROFILE_GROUP_BINDING_MISSING"),
        name: resolve("定位/类型", "FUNCTION_DISPLAY_NAME_COLUMN_INVALID"),
        intensity: resolve("级别", "FUNCTION_INTENSITY_COLUMN_INVALID"),
      };
      continue;
    }
    if (!headers.length || headerInvalid || !row.some((value) => asText(value))) continue;
    const id = asText(row[columns.id ?? -1]);
    const groupId = asText(row[columns.groupId ?? -1]);
    const intensity = Number(row[columns.intensity ?? -1]);
    const name = asText(row[columns.name ?? -1]);
    const isSourceRow = true;
    if (!id) {
      if (isSourceRow) input.issues.push({ level: "error", code: "FUNCTION_ROW_ID_MISSING", message: `功能定位第 ${sourceRow} 行缺少机器 ID。`, sheetId: CANONICAL_RULE_RANGES.function.sheetId, row: sourceRow });
      continue;
    }
    if (seen.has(id)) input.issues.push({ level: "error", code: "FUNCTION_ROW_ID_DUPLICATE", message: `功能行 ID 重复：${id}`, sheetId: CANONICAL_RULE_RANGES.function.sheetId, row: sourceRow });
    seen.add(id);
    if (!groupId) {
      input.issues.push({ level: "error", code: "FUNCTION_PROFILE_GROUP_ID_MISSING", message: `功能行 ${id} 缺少 FunctionProfile 稳定父级 ID。`, sheetId: CANONICAL_RULE_RANGES.function.sheetId, row: sourceRow });
      continue;
    }
    if (!name || ![1, 2, 3].includes(intensity)) {
      input.issues.push({ level: "error", code: "FUNCTION_ROW_INVALID", message: `功能行 ${id} 的展示名或强度无效。`, sheetId: CANONICAL_RULE_RANGES.function.sheetId, row: sourceRow });
      continue;
    }
    const rules = headers.flatMap((header, column) => {
      if (!header || metadataLabels.has(header)) return [];
      const rule = sourceRule({ id: `${id}:${columnName(column)}${sourceRow}`, header, raw: row[column], sourceRevisionId: input.sourceRevisionId, sheetId: CANONICAL_RULE_RANGES.function.sheetId, row: sourceRow, column });
      return rule ? [rule] : [];
    });
    rows.push({ id, groupId, name, intensity: intensity as FunctionIntensity, rules, sourceRow });
  }
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.groupId, [...(grouped.get(row.groupId) ?? []), row]);
  const profiles: FunctionProfile[] = [];
  const modifiers: ModifierOption[] = [];
  for (const [groupId, group] of grouped) {
    const rowsByIntensity = new Map<FunctionIntensity, typeof group[number]>();
    const displayNames = new Set(group.map((row) => row.name));
    let valid = true;
    for (const row of group) {
      if (rowsByIntensity.has(row.intensity)) {
        input.issues.push({ level: "error", code: "FUNCTION_GROUP_INTENSITY_DUPLICATE", message: `FunctionProfile ${groupId} 的强度 ${row.intensity} 重复。`, sheetId: CANONICAL_RULE_RANGES.function.sheetId, row: row.sourceRow });
        valid = false;
      } else rowsByIntensity.set(row.intensity, row);
    }
    const isGeneric = groupId.toLowerCase().includes("generic") || group.every((row) => row.name.includes("泛用"));
    const requiredIntensities = isGeneric ? [1] as FunctionIntensity[] : [1, 2, 3] as FunctionIntensity[];
    for (const intensity of requiredIntensities) if (!rowsByIntensity.has(intensity)) {
      input.issues.push({ level: "error", code: "FUNCTION_GROUP_INTENSITY_MISSING", message: `FunctionProfile ${groupId} 缺少强度 ${intensity}。`, sheetId: CANONICAL_RULE_RANGES.function.sheetId });
      valid = false;
    }
    if (displayNames.size !== 1) {
      input.issues.push({ level: "error", code: "FUNCTION_GROUP_DISPLAY_NAME_CONFLICT", message: `FunctionProfile ${groupId} 的展示名不一致。`, sheetId: CANONICAL_RULE_RANGES.function.sheetId });
      valid = false;
    }
    if (!valid) continue;
    const profileName = group[0]!.name;
    profiles.push({ id: groupId, name: profileName, rules: [], intensityRules: requiredIntensities.map((intensity) => {
      const row = rowsByIntensity.get(intensity)!;
      return { intensity, rules: structuredClone(row.rules), sourceRowId: row.id };
    }), enabled: true, sourceRevisionId: input.sourceRevisionId, notes: "来自飞书 03_功能定位显式 FunctionProfile ID；显示名仅用于展示。" });
    for (const row of group) modifiers.push({ id: row.id, dimension: "function", name: profileName, level: row.intensity, itemKinds: ["rod", "reel", "line"], rules: structuredClone(row.rules), notes: `来自飞书 03_功能定位第 ${row.sourceRow} 行。`, enabled: true });
  }
  if (!rows.length && !input.issues.some((issue) => issue.code === "FUNCTION_PROFILE_GROUP_BINDING_MISSING")) input.issues.push({ level: "error", code: "FUNCTION_PROFILE_EMPTY", message: "04_功能定位没有可导入记录。", sheetId: CANONICAL_RULE_RANGES.function.sheetId });
  return { profiles, modifiers };
}

export function importCanonicalRuleSource(input: {
  sourceRevision: FeishuSourceRevision;
  weightValues: unknown[][];
  typeValues: unknown[][];
  functionValues: unknown[][];
  /** 02_钓法类型；02.5 只保留为审核/回写证据，绝不反向作为规则输入。 */
  methodValues?: unknown[][];
  methodTemplateReviewValues?: unknown[][];
  importedAt: string;
}): CanonicalRuleSourceDraft {
  const issues: CanonicalRuleSourceIssue[] = [];
  const weight = parseWeight({ values: input.weightValues, sourceRevisionId: input.sourceRevision.id, issues });
  const importedMethods = parseMethods({ values: input.methodValues ?? [], sourceRevisionId: input.sourceRevision.id, issues });
  const enabledKinds = new Set(weight.templateKinds.values());
  for (const kind of enabledKinds) if (!importedMethods.some((entry) => entry.kind === kind)) {
    issues.push({ level: "error", code: "METHOD_PART_COVERAGE_MISSING", message: `02_钓法类型缺少已启用 ${kind} 部位的稳定钓法块。`, sheetId: CANONICAL_RULE_RANGES.method.sheetId });
  }
  const templates = deriveMethodTemplates({ templates: weight.templates, templateKinds: weight.templateKinds, methods: importedMethods });
  const methods = importedMethods.length ? importedMethods.map((entry) => entry.profile) : [...new Set(templates.map((entry) => entry.methodId).filter((entry): entry is string => Boolean(entry)))].map((id): MethodProfile => ({
    id,
    name: weight.templates.find((entry) => entry.methodId === id)?.name.split(" · ")[0] ?? id,
    rules: [],
    enabled: true,
    sourceRevisionId: input.sourceRevision.id,
    notes: "来自飞书 01_重量模板的钓法列；钓法与类型保持独立规则层。",
  }));
  const types = parseTypes({ values: input.typeValues, sourceRevisionId: input.sourceRevision.id, methodProfiles: methods, issues });
  const functions = parseFunctions({ values: input.functionValues, sourceRevisionId: input.sourceRevision.id, issues });
  const parameters = definitions(sourceParameterHeaders({
    weightHeaders: weight.attributeHeaders,
    typeValues: input.typeValues,
    functionValues: input.functionValues,
  }));
  const layers: RuleLayer[] = [
    { id: "layer-weight-template", name: "01_重量模板", order: 10, enabled: true, mode: "global", optionIds: [], rules: [], notes: "基准值直接来自所选飞书重量模板。" },
    { id: "layer-item-type", name: "02_类型材质 · 类型", order: 20, enabled: true, mode: "selection", dimension: "structure", optionIds: types.modifiers.filter((entry) => entry.dimension === "structure").map((entry) => entry.id), rules: [], notes: "应用飞书 02 类型系数。" },
    { id: "layer-line-type", name: "02_类型材质 · 线", order: 30, enabled: true, mode: "selection", dimension: "material", optionIds: types.modifiers.filter((entry) => entry.dimension === "material").map((entry) => entry.id), rules: [], notes: "应用飞书 02 线类型系数。" },
    { id: "layer-function", name: "03_功能定位", order: 40, enabled: true, mode: "selection", dimension: "function", optionIds: functions.modifiers.map((entry) => entry.id), rules: [], notes: "应用飞书 03 功能强度系数。" },
    { id: "layer-affix", name: "词条", order: 80, enabled: true, mode: "global", optionIds: [], rules: [], notes: "运行时系统层：应用当前可见词条。" },
    { id: "layer-manual", name: "手工 Patch", order: 90, enabled: true, mode: "global", optionIds: [], rules: [], notes: "运行时系统层：最后应用显式手工 Patch。" },
  ];
  const content = { parameters, templates, methodProfiles: methods, itemTypeProfiles: types.profiles, functionProfiles: functions.profiles, modifiers: [...types.modifiers, ...functions.modifiers], layers };
  const contentHash = deterministicHash(content);
  return {
    id: `canonical-rule-draft:${input.sourceRevision.id}:${contentHash}`,
    sourceRevisionId: input.sourceRevision.id,
    sourceRevision: input.sourceRevision.sourceRevision,
    contentHash,
    importedAt: input.importedAt,
    ...content,
    issues,
  };
}
