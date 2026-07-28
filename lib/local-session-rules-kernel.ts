import {
  evaluateFormula,
  renameFormulaIdentifier,
  validateFormula,
} from "./engine";
import type {
  LocalEditableRule,
  LocalSessionDocument,
} from "./local-session-contracts";

export interface LocalSessionValidationIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface LocalSessionTraceEntry {
  traceId: string;
  sequence: number;
  ruleId: string;
  sourceKind: LocalEditableRule["sourceKind"];
  sourceId: string;
  parameterKey: string;
  operation: LocalEditableRule["operation"];
  before: number | string | null;
  operand: number | string;
  after: number | string | null;
  status: "applied" | "skipped" | "error";
  message: string;
}

export interface LocalSessionDerivation {
  templateId: string;
  values: Record<string, number | string>;
  trace: LocalSessionTraceEntry[];
  issues: LocalSessionValidationIssue[];
}

export function parseLocalTemplateValuesJson(
  raw: string,
): Record<string, number | string> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("模板值必须是 JSON 对象。");
  }
  const values: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value !== "string"
      && (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new TypeError(`模板值“${key}”只能是字符串或有限数值。`);
    }
    values[key] = value;
  }
  return values;
}

function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return repeated;
}

const LOCAL_PARAMETER_KEY =
  /^[\u4e00-\u9fffA-Za-z_][\u4e00-\u9fffA-Za-z0-9_.]*$/u;

function assertLocalParameterKey(
  document: LocalSessionDocument,
  parameterId: string,
  nextKey: string,
): void {
  if (!nextKey || !LOCAL_PARAMETER_KEY.test(nextKey)) {
    throw new TypeError("参数键必须以中文、字母或下划线开头，且只能包含中文、字母、数字、下划线或点。");
  }
  if (nextKey === "current") {
    throw new TypeError("参数键“current”由公式运行时保留。");
  }
  if (document.parameters.some((entry) =>
    entry.id !== parameterId && entry.key === nextKey
  )) {
    throw new TypeError(`参数键“${nextKey}”已存在。`);
  }
}

export function renameLocalSessionParameterKey(
  document: LocalSessionDocument,
  parameterId: string,
  nextKey: string,
): LocalSessionDocument {
  const parameter = document.parameters.find((entry) => entry.id === parameterId);
  if (!parameter) throw new TypeError(`找不到参数“${parameterId}”。`);
  assertLocalParameterKey(document, parameterId, nextKey);
  const previousKey = parameter.key;
  if (previousKey === nextKey) return document;
  for (const template of document.templates) {
    if (
      Object.hasOwn(template.values, previousKey)
      && Object.hasOwn(template.values, nextKey)
    ) {
      throw new TypeError(
        `模板“${template.name}”已同时包含参数键“${previousKey}”与“${nextKey}”；重命名已拒绝。`,
      );
    }
  }
  const templates = document.templates.map((template) => {
    if (!Object.hasOwn(template.values, previousKey)) return template;
    const values = Object.fromEntries(
      Object.entries(template.values).map(([key, value]) => [
        key === previousKey ? nextKey : key,
        value,
      ]),
    );
    return { ...template, values };
  });
  const rules = document.rules.map((rule) => ({
    ...rule,
    parameterKey: rule.parameterKey === previousKey ? nextKey : rule.parameterKey,
    value: rule.operation === "formula" && typeof rule.value === "string"
      ? renameFormulaIdentifier(rule.value, previousKey, nextKey)
      : rule.value,
  }));
  return {
    ...document,
    parameters: document.parameters.map((entry) =>
      entry.id === parameterId ? { ...entry, key: nextKey } : entry),
    templates,
    rules,
  };
}

export function validateLocalSessionDocument(
  document: LocalSessionDocument,
): LocalSessionValidationIssue[] {
  const issues: LocalSessionValidationIssue[] = document.sourceIssues.map(
    (issue) => ({ ...issue }),
  );
  for (const key of duplicates(document.parameters.map((entry) => entry.key))) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_PARAMETER_KEY",
      path: `parameters.${key}`,
      message: `参数键“${key}”重复。`,
    });
  }
  for (const id of duplicates([
    ...document.parameters.map((entry) => entry.id),
    ...document.templates.map((entry) => entry.id),
    ...document.rules.map((entry) => entry.id),
  ])) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_LOCAL_ID",
      path: id,
      message: `本地编辑对象 ID“${id}”重复。`,
    });
  }
  for (const sequence of duplicates(
    document.rules.map((entry) => String(entry.sequence)),
  )) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_RULE_SEQUENCE",
      path: `rules.sequence.${sequence}`,
      message: `规则 Trace sequence“${sequence}”重复；派生已阻断。`,
    });
  }
  const parametersByKey = new Map(
    document.parameters.map((entry) => [entry.key, entry] as const),
  );
  const parameterKeys = new Set(parametersByKey.keys());
  for (const [index, parameter] of document.parameters.entries()) {
    if (!parameter.key || !LOCAL_PARAMETER_KEY.test(parameter.key)) {
      issues.push({
        severity: "error",
        code: "INVALID_PARAMETER_KEY",
        path: `parameters[${index}].key`,
        message: `参数键“${parameter.key}”格式无效。`,
      });
    } else if (parameter.key === "current") {
      issues.push({
        severity: "error",
        code: "RESERVED_PARAMETER_KEY",
        path: `parameters[${index}].key`,
        message: "参数键“current”由公式运行时保留。",
      });
    }
  }
  for (const [index, template] of document.templates.entries()) {
    if (
      template.targetPullMinKgf >= template.targetPullMaxKgf
      || template.targetPullMinKgf > template.nominalTargetPullKgf
      || template.nominalTargetPullKgf > template.targetPullMaxKgf
    ) {
      issues.push({
        severity: "error",
        code: "INVALID_TEMPLATE_PULL_RANGE",
        path: `templates[${index}]`,
        message: `模板“${template.name}”必须满足最小拉力 < 最大拉力，且最小拉力 ≤ 标称拉力 ≤ 最大拉力。`,
      });
    }
    for (const key of Object.keys(template.values)) {
      const parameter = parametersByKey.get(key);
      if (!parameter) {
        issues.push({
          severity: "error",
          code: "TEMPLATE_PARAMETER_NOT_DECLARED",
          path: `templates[${index}].values.${key}`,
          message: `模板值“${key}”没有对应的参数定义。`,
        });
      } else if (parameter.itemPart !== template.itemPart) {
        issues.push({
          severity: "error",
          code: "TEMPLATE_PARAMETER_ITEM_PART_MISMATCH",
          path: `templates[${index}].values.${key}`,
          message: `模板“${template.name}”的部位 ${template.itemPart} 与参数“${key}”的部位 ${parameter.itemPart} 不匹配。`,
        });
      }
    }
  }
  for (const [index, rule] of document.rules.entries()) {
    if (!parameterKeys.has(rule.parameterKey)) {
      issues.push({
        severity: "error",
        code: "RULE_PARAMETER_NOT_DECLARED",
        path: `rules[${index}].parameterKey`,
        message: `规则“${rule.id}”引用了未声明参数“${rule.parameterKey}”。`,
      });
    }
    if (
      rule.operation !== "set"
      && rule.operation !== "formula"
      && typeof rule.value !== "number"
    ) {
      issues.push({
        severity: "error",
        code: "RULE_NUMERIC_OPERAND_REQUIRED",
        path: `rules[${index}].value`,
        message: `规则“${rule.id}”的 ${rule.operation} 操作需要数值。`,
      });
    }
    if (rule.operation === "formula") {
      if (typeof rule.value !== "string") {
        issues.push({
          severity: "error",
          code: "RULE_FORMULA_REQUIRED",
          path: `rules[${index}].value`,
          message: `规则“${rule.id}”的 formula 操作需要公式字符串。`,
        });
      } else {
        try {
          validateFormula(rule.value);
        } catch (error) {
          issues.push({
            severity: "error",
            code: "RULE_FORMULA_INVALID",
            path: `rules[${index}].value`,
            message: error instanceof Error ? error.message : "公式语法无效。",
          });
        }
      }
    }
  }
  return issues;
}

function applyRuleValue(
  before: number | string | undefined,
  rule: LocalEditableRule,
  numericValues: Record<string, number>,
): number | string {
  let computed: number | string;
  if (rule.operation === "set") {
    computed = rule.value;
  } else if (rule.operation === "formula") {
    if (typeof rule.value !== "string") {
      throw new Error("formula 操作需要公式字符串。");
    }
    computed = evaluateFormula(rule.value, {
      ...numericValues,
      current: typeof before === "number" ? before : 0,
    });
  } else {
    if (typeof before !== "number" || typeof rule.value !== "number") {
      throw new Error(`${rule.operation} 操作要求当前值与操作数均为数值。`);
    }
    if (rule.operation === "add") computed = before + rule.value;
    else if (rule.operation === "multiply") computed = before * rule.value;
    else if (rule.operation === "min") computed = Math.min(before, rule.value);
    else computed = Math.max(before, rule.value);
  }
  if (typeof computed === "number" && !Number.isFinite(computed)) {
    throw new Error(`${rule.operation} 操作结果不是有限数值。`);
  }
  return computed;
}

export function deriveLocalSessionTemplate(
  document: LocalSessionDocument,
  templateId: string,
): LocalSessionDerivation {
  const issues = validateLocalSessionDocument(document);
  const template = document.templates.find((entry) => entry.id === templateId);
  if (!template) {
    return {
      templateId,
      values: {},
      trace: [],
      issues: [
        ...issues,
        {
          severity: "error",
          code: "TEMPLATE_NOT_FOUND",
          path: "templateId",
          message: `找不到模板“${templateId}”。`,
        },
      ],
    };
  }
  const parametersByKey = new Map(
    document.parameters.map((entry) => [entry.key, entry] as const),
  );
  const values = Object.fromEntries(
    Object.entries(template.values).filter(([key]) => {
      const parameter = parametersByKey.get(key);
      return Boolean(parameter && parameter.itemPart === template.itemPart);
    }),
  );
  const trace: LocalSessionTraceEntry[] = [];
  if (issues.some((issue) => issue.severity === "error")) {
    return { templateId, values, trace, issues };
  }
  const rules = [...document.rules].sort(
    (left, right) =>
      left.sequence - right.sequence
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  for (const rule of rules) {
    const before = values[rule.parameterKey];
    const entry: LocalSessionTraceEntry = {
      traceId: `${String(rule.sequence).padStart(6, "0")}:${rule.id}`,
      sequence: rule.sequence,
      ruleId: rule.id,
      sourceKind: rule.sourceKind,
      sourceId: rule.sourceId,
      parameterKey: rule.parameterKey,
      operation: rule.operation,
      before: before ?? null,
      operand: rule.value,
      after: before ?? null,
      status: "skipped",
      message: "",
    };
    if (!rule.enabled) {
      entry.message = "规则已停用。";
      trace.push(entry);
      continue;
    }
    const parameter = parametersByKey.get(rule.parameterKey);
    if (parameter?.itemPart !== template.itemPart) {
      entry.message = `规则部位 ${parameter?.itemPart ?? "unknown"} 与模板部位 ${template.itemPart} 不匹配。`;
      trace.push(entry);
      continue;
    }
    if (rule.condition.trim()) {
      entry.message = "本地最小竖切不推断条件语义，含条件规则保持未执行。";
      trace.push(entry);
      continue;
    }
    try {
      const numericValues = Object.fromEntries(
        Object.entries(values).filter((entry): entry is [string, number] =>
          typeof entry[1] === "number"),
      );
      const after = applyRuleValue(before, rule, numericValues);
      values[rule.parameterKey] = after;
      entry.after = after;
      entry.status = "applied";
      entry.message = "已按稳定 sequence 应用。";
    } catch (error) {
      entry.status = "error";
      entry.message = error instanceof Error ? error.message : "规则计算失败。";
      issues.push({
        severity: "error",
        code: "RULE_EVALUATION_FAILED",
        path: `rules.${rule.id}`,
        message: entry.message,
      });
    }
    trace.push(entry);
  }
  return { templateId, values, trace, issues };
}
