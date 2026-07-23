import { sha256Text } from "./sha256";
import type {
  AttributeAffixEffect,
  AttributeContribution,
  CanonicalAttributeOperation,
  ParameterDefinition,
  ProjectionTraceContribution,
  ReductionStackingPolicyVersion,
  ValidationIssue,
  V3Affix,
  ConfigurationSnapshot,
} from "./types";
import type { FeishuSourceRevision } from "./feishu-workbook";

export const BIDIRECTIONAL_RATIO_POLICY_ID = "reduction-policy:bidirectional-ratio";
export const BIDIRECTIONAL_RATIO_OPERATION_ORDER = [
  "set",
  "percent_adjust",
  "flat_adjust",
  "clamp_add",
  "final_review_patch",
  "parameter_definition",
] as const;

export interface ReductionPolicyMachineRule {
  ruleId: string;
  parameterKey: string;
  strategy: "bidirectional_ratio";
  numericContract: "ieee754-binary64-v1";
  operationOrder: readonly string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function fingerprint(code: string, evidence: Record<string, unknown>): string {
  return sha256Text(stableJson({ code, evidence }));
}

function issue(
  code: string,
  message: string,
  evidence: Record<string, unknown> = {},
  severity: NonNullable<ValidationIssue["severity"]> = "BLOCKER",
  gate: NonNullable<ValidationIssue["gate"]> = "PUBLISH",
): ValidationIssue {
  return {
    level: severity === "INFO" ? "info" : severity === "WARNING" ? "warning" : "error",
    severity,
    source: "affix",
    gate,
    state: "OPEN",
    fingerprint: fingerprint(code, evidence),
    code,
    message,
    evidence,
  };
}

export function importReductionStackingPolicyDraft(input: {
  sourceRevision: FeishuSourceRevision;
  machineRules?: ReductionPolicyMachineRule[];
  createdAt: string;
}): ReductionStackingPolicyVersion {
  const { sourceRevision } = input;
  const issues: ValidationIssue[] = [];
  const rules = input.machineRules ?? [];
  const sourceSheet = sourceRevision.sheets.find((sheet) => sheet.sheetId === "zrVOxd");
  if (
    sourceRevision.workbookRefId !== "feishu-workbook:tackle-design"
    || !sourceSheet
    || rules.length === 0
  ) {
    issues.push(issue(
      "REDUCTION_POLICY_SOURCE_MISSING",
      "权威主工作簿 04_词条/zrVOxd 尚未提供可机器读取的 bidirectional_ratio 规则；仅允许非正式预览。",
      {
        workbookRefId: sourceRevision.workbookRefId,
        sourceRevision: sourceRevision.sourceRevision,
        requiredSheetId: "zrVOxd",
        machineRuleCount: rules.length,
      },
    ));
  }
  if (
    sourceRevision.workbookRefId !== "feishu-workbook:tackle-design"
    || sourceRevision.sourceRevision === "17173"
  ) {
    issues.push(issue(
      "REDUCTION_POLICY_SOURCE_INVALID",
      "该修订只能作为外部证据，不能充当运行时规则源。",
      {
        workbookRefId: sourceRevision.workbookRefId,
        sourceRevision: sourceRevision.sourceRevision,
      },
    ));
  }
  const validRules = rules.filter((rule) => (
    rule.strategy === "bidirectional_ratio"
    && rule.numericContract === "ieee754-binary64-v1"
    && stableJson(rule.operationOrder) === stableJson(BIDIRECTIONAL_RATIO_OPERATION_ORDER)
    && rule.ruleId.trim()
    && rule.parameterKey.trim()
  ));
  if (validRules.length !== rules.length) {
    issues.push(issue(
      "REDUCTION_POLICY_MACHINE_RULE_INVALID",
      "机器规则未完整冻结策略、binary64 数值契约或阶段顺序。",
      { invalidRuleCount: rules.length - validRules.length },
    ));
  }
  const normalizedRules = [...validRules].sort((left, right) =>
    compareUtf8(left.parameterKey, right.parameterKey)
    || compareUtf8(left.ruleId, right.ruleId)
  );
  const inputHash = sha256Text(stableJson({
    workbookRefId: sourceRevision.workbookRefId,
    sourceRevisionId: sourceRevision.id,
    sourceRevision: sourceRevision.sourceRevision,
    sheetId: "zrVOxd",
    rules: normalizedRules,
    numericContract: "ieee754-binary64-v1",
    operationOrder: BIDIRECTIONAL_RATIO_OPERATION_ORDER,
  }));
  return {
    id: `${BIDIRECTIONAL_RATIO_POLICY_ID}:${inputHash.slice(0, 16)}`,
    version: inputHash,
    status: "draft",
    strategy: "bidirectional_ratio",
    numericContract: "ieee754-binary64-v1",
    operationOrder: [...BIDIRECTIONAL_RATIO_OPERATION_ORDER],
    ...(issues.length || !normalizedRules.length ? {} : {
      source: {
        workbookRefId: "feishu-workbook:tackle-design" as const,
        sheetId: "zrVOxd" as const,
        sourceRevisionId: sourceRevision.id,
        sourceRevision: sourceRevision.sourceRevision,
        ruleId: normalizedRules.map((rule) => rule.ruleId).join(","),
        parameterKey: normalizedRules.map((rule) => rule.parameterKey).join(","),
      },
    }),
    issues,
    inputHash,
    createdAt: input.createdAt,
  };
}

export function publishReductionStackingPolicyVersion(input: {
  draft: ReductionStackingPolicyVersion;
  publishedAt: string;
  publishedBy: string;
}): ReductionStackingPolicyVersion {
  if (input.draft.status === "published") return structuredClone(input.draft);
  if (input.draft.status !== "draft") throw new Error("只有草稿 ReductionStackingPolicyVersion 可以发布。");
  if (!input.draft.source || input.draft.issues.some((entry) => entry.severity === "BLOCKER")) {
    const codes = input.draft.issues.map((entry) => entry.code).join("、")
      || "REDUCTION_POLICY_SOURCE_MISSING";
    throw new Error(`ReductionStackingPolicyVersion 发布被阻止：${codes}`);
  }
  if (
    input.draft.source.workbookRefId !== "feishu-workbook:tackle-design"
    || input.draft.source.sheetId !== "zrVOxd"
    || input.draft.source.sourceRevision === "17173"
  ) {
    throw new Error("ReductionStackingPolicyVersion 发布被阻止：REDUCTION_POLICY_SOURCE_INVALID");
  }
  return {
    ...structuredClone(input.draft),
    status: "published",
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy,
  };
}

const textEncoder = new TextEncoder();
export function compareUtf8(left: string, right: string): number {
  const a = textEncoder.encode(left);
  const b = textEncoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function numberToBinary64Hex(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_52 = BigInt(52);
const BIG_63 = BigInt(63);
const BIG_EXPONENT_MASK = BigInt("0x7ff");
const BIG_FRACTION_MASK = BigInt("0x000fffffffffffff");

function exactNumber(value: number): Rational {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const sign = bits >> BIG_63 ? -BIG_ONE : BIG_ONE;
  const exponentBits = Number((bits >> BIG_52) & BIG_EXPONENT_MASK);
  const fraction = bits & BIG_FRACTION_MASK;
  if (exponentBits === 0x7ff) return { numerator: BIG_ZERO, denominator: BIG_ZERO };
  if (exponentBits === 0 && fraction === BIG_ZERO) {
    return { numerator: BIG_ZERO, denominator: BIG_ONE };
  }
  const significand = exponentBits === 0 ? fraction : (BIG_ONE << BIG_52) | fraction;
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  return exponent >= 0
    ? {
        numerator: sign * significand * (BIG_ONE << BigInt(exponent)),
        denominator: BIG_ONE,
      }
    : { numerator: sign * significand, denominator: BIG_ONE << BigInt(-exponent) };
}

function addExact(left: Rational, right: Rational): Rational {
  return {
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  };
}

function subtractExact(left: Rational, right: Rational): Rational {
  return addExact(left, { numerator: -right.numerator, denominator: right.denominator });
}

function multiplyExact(left: Rational, right: Rational): Rational {
  return {
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  };
}

function divideExact(left: Rational, right: Rational): Rational {
  return {
    numerator: left.numerator * right.denominator,
    denominator: left.denominator * right.numerator,
  };
}

const MAX_FINITE_EXACT = exactNumber(Number.MAX_VALUE);

function exactExceedsMax(value: Rational): boolean {
  if (value.denominator === BIG_ZERO) return true;
  const numerator = value.numerator < BIG_ZERO ? -value.numerator : value.numerator;
  const denominator = value.denominator < BIG_ZERO ? -value.denominator : value.denominator;
  return numerator * MAX_FINITE_EXACT.denominator
    > MAX_FINITE_EXACT.numerator * denominator;
}

type NumericAnomaly = NonNullable<
  NonNullable<ProjectionTraceContribution["numericEvidence"]>["anomaly"]
>;

function classifyNumeric(exact: Rational, result: number): NumericAnomaly {
  if (!Number.isFinite(result) || exactExceedsMax(exact)) return "overflow";
  if (exact.numerator !== BIG_ZERO && result === 0) return "underflow_to_zero";
  return "none";
}

function canonicalOperationSort(
  left: CanonicalAttributeOperation,
  right: CanonicalAttributeOperation,
): number {
  return compareUtf8(left.sourceAffixId, right.sourceAffixId)
    || left.sourceAffixRevision - right.sourceAffixRevision
    || left.operationIndex - right.operationIndex
    || compareUtf8(left.operationId, right.operationId);
}

function canonicalFromEffect(
  affix: V3Affix,
  effect: AttributeAffixEffect,
  index: number,
): { operation?: CanonicalAttributeOperation; issue?: ValidationIssue } {
  const raw = effect as AttributeAffixEffect & Record<string, unknown>;
  const operationId = String(raw.operationId ?? raw.id ?? `${affix.id}:operation:${index}`);
  const sourceAffixRevision = Number(raw.sourceAffixRevision ?? affix.version);
  const operationIndex = Number(raw.operationIndex ?? index);
  const legacyValue = typeof raw.value === "number" ? raw.value : undefined;
  const explicitMagnitude = typeof raw.magnitude === "number" ? raw.magnitude : undefined;
  const explicitDirection = raw.direction === "increase" || raw.direction === "decrease"
    ? raw.direction
    : undefined;
  const common = {
    operationId,
    operationIndex,
    sourceAffixId: affix.id,
    sourceAffixRevision,
    parameterKey: String(raw.parameterKey),
    rawLexical: typeof raw.rawLexical === "string"
      ? raw.rawLexical
      : legacyValue === undefined ? undefined : String(legacyValue),
  };
  if (["percent_adjust", "flat_adjust", "clamp_add"].includes(String(raw.operation))) {
    if (
      !explicitDirection
      || explicitMagnitude === undefined
      || !Number.isFinite(explicitMagnitude)
      || explicitMagnitude < 0
    ) {
      return {
        issue: issue(
          "AFFIX_DIRECTION_CONFLICT",
          `词条 ${affix.id} 的方向/幅度不能规范化，已隔离整个修订。`,
          { affixId: affix.id, effect: raw },
          "ERROR",
          "REVIEW",
        ),
      };
    }
    if (
      legacyValue !== undefined
      && (
        Math.abs(legacyValue) !== explicitMagnitude
        || (legacyValue < 0 ? "decrease" : "increase") !== explicitDirection
      )
    ) {
      return {
        issue: issue(
          "AFFIX_DIRECTION_CONFLICT",
          `词条 ${affix.id} 同时存在且不一致的旧值与 canonical direction+magnitude，已隔离整个修订。`,
          { affixId: affix.id, effect: raw },
          "ERROR",
          "REVIEW",
        ),
      };
    }
    return {
      operation: {
        ...common,
        operation: raw.operation as "percent_adjust" | "flat_adjust" | "clamp_add",
        direction: explicitDirection,
        magnitude: explicitMagnitude,
        ...(typeof raw.clampMin === "number" ? { clampMin: raw.clampMin } : {}),
        ...(typeof raw.clampMax === "number" ? { clampMax: raw.clampMax } : {}),
        migrationEvidence: (
          raw.migrationEvidence
          && typeof raw.migrationEvidence === "object"
          && "sourceShape" in raw.migrationEvidence
        )
          ? raw.migrationEvidence as CanonicalAttributeOperation["migrationEvidence"]
          : { sourceShape: "canonical" },
      },
    };
  }
  if (raw.operation === "set" || raw.operation === "enum_add") {
    return {
      operation: {
        ...common,
        operation: raw.operation,
        value: raw.value as number | string | boolean,
        migrationEvidence: { sourceShape: "canonical" },
      },
    };
  }
  const legacyMapping = {
    percent_bonus: ["percent_adjust", "increase"],
    reduction_diminishing: ["percent_adjust", "decrease"],
    reduction: ["percent_adjust", "decrease"],
    flat_bonus: ["flat_adjust", "increase"],
    flat_reduction: ["flat_adjust", "decrease"],
  } as const;
  const mapped = legacyMapping[String(raw.operation) as keyof typeof legacyMapping];
  if (mapped && legacyValue !== undefined && Number.isFinite(legacyValue)) {
    const direction = legacyValue < 0
      ? (mapped[1] === "increase" ? "decrease" : "increase")
      : mapped[1];
    return {
      operation: {
        ...common,
        operation: mapped[0],
        direction,
        magnitude: Math.abs(legacyValue),
        migrationEvidence: {
          sourceShape: legacyValue < 0 || Object.is(legacyValue, -0)
            ? "legacy_signed"
            : "legacy_named",
          originalOperation: String(raw.operation),
          originalValue: legacyValue,
          negativeZero: Object.is(legacyValue, -0),
        },
      },
    };
  }
  if (!raw.operation && legacyValue !== undefined && Number.isFinite(legacyValue)) {
    return {
      operation: {
        ...common,
        operation: "percent_adjust",
        direction: legacyValue < 0 ? "decrease" : "increase",
        magnitude: Math.abs(legacyValue),
        migrationEvidence: {
          sourceShape: "legacy_signed",
          originalValue: legacyValue,
          negativeZero: Object.is(legacyValue, -0),
        },
      },
    };
  }
  return {
    issue: issue(
      "AFFIX_DIRECTION_CONFLICT",
      `词条 ${affix.id} 的旧操作无法无损迁移，已隔离整个修订。`,
      { affixId: affix.id, effect: raw },
      "ERROR",
      "REVIEW",
    ),
  };
}

export function canonicalizeAffixOperations(affixes: V3Affix[]): {
  operations: CanonicalAttributeOperation[];
  issues: ValidationIssue[];
  isolatedAffixRevisionIds: string[];
} {
  const operations: CanonicalAttributeOperation[] = [];
  const issues: ValidationIssue[] = [];
  const isolatedAffixRevisionIds: string[] = [];
  for (const affix of affixes) {
    const converted = affix.attributeEffects.map((effect, index) =>
      canonicalFromEffect(affix, effect, index)
    );
    const affixIssues = converted.flatMap((entry) => entry.issue ? [entry.issue] : []);
    if (affixIssues.length) {
      issues.push(...affixIssues);
      isolatedAffixRevisionIds.push(`${affix.id}@${affix.version}`);
      continue;
    }
    operations.push(...converted.flatMap((entry) => entry.operation ? [entry.operation] : []));
  }
  return {
    operations: operations.sort(canonicalOperationSort),
    issues,
    isolatedAffixRevisionIds,
  };
}

export function canonicalizeContributions(
  contributions: AttributeContribution[],
): CanonicalAttributeOperation[] {
  const syntheticAffixes = new Map<string, V3Affix>();
  for (const entry of contributions) {
    const affix = syntheticAffixes.get(entry.sourceId) ?? {
      id: entry.sourceId,
      version: entry.sourceAffixRevision ?? 1,
      name: entry.sourceName,
      category: "attribute" as const,
      itemPartId: "",
      generationPolicy: "normal" as const,
      rarity: "common" as const,
      valueScore: 0,
      tags: [],
      attributeEffects: [],
      description: "",
      enabled: true,
    };
    affix.attributeEffects.push({
      id: entry.operationId ?? entry.id,
      operationId: entry.operationId ?? entry.id,
      operationIndex: entry.operationIndex ?? affix.attributeEffects.length,
      sourceAffixId: entry.sourceId,
      sourceAffixRevision: entry.sourceAffixRevision ?? 1,
      parameterKey: entry.parameterKey,
      operation: entry.operation,
      direction: entry.direction,
      magnitude: entry.magnitude,
      rawLexical: entry.rawLexical,
      clampMin: entry.clampMin,
      clampMax: entry.clampMax,
      ...(entry.operation === "set" || entry.operation === "enum_add"
        ? { value: entry.setValue ?? entry.value }
        : ["percent_bonus", "flat_bonus", "reduction"].includes(entry.operation)
          ? { value: entry.value }
          : {}),
      unit: "",
      stackingGroup: "",
      ruleSetVersion: "",
    } as AttributeAffixEffect);
    syntheticAffixes.set(entry.sourceId, affix);
  }
  return canonicalizeAffixOperations([...syntheticAffixes.values()]).operations;
}

export interface BidirectionalRatioResult {
  values: Record<string, number | string>;
  trace: ProjectionTraceContribution[];
  issues: ValidationIssue[];
  formalStatus: "FORMAL" | "NON_FORMAL";
  traceHash: string;
}

function addRuntimeIssue(
  issues: ValidationIssue[],
  code: string,
  message: string,
  parameterKey: string,
  evidence: Record<string, unknown>,
  severity: "ERROR" | "BLOCKER" = "BLOCKER",
): void {
  issues.push({
    ...issue(code, message, { parameterKey, ...evidence }, severity, "REVIEW"),
    parameterKey,
  });
}

export function evaluateBidirectionalRatio(input: {
  baseValues: Record<string, number | string>;
  operations: CanonicalAttributeOperation[];
  policy?: ReductionStackingPolicyVersion;
  sequenceStart?: number;
}): BidirectionalRatioResult {
  const values = structuredClone(input.baseValues);
  const issues: ValidationIssue[] = [];
  const trace: ProjectionTraceContribution[] = [];
  let sequence = input.sequenceStart ?? 0;
  const policyFormal = input.policy?.status === "published"
    && input.policy.strategy === "bidirectional_ratio"
    && input.policy.numericContract === "ieee754-binary64-v1"
    && input.policy.issues.every((entry) => entry.severity !== "BLOCKER");
  if (!policyFormal) {
    issues.push(issue(
      "REDUCTION_POLICY_SOURCE_MISSING",
      "缺少来自权威主工作簿的已发布 ReductionStackingPolicyVersion；结果仅为非正式预览。",
      { policyVersion: input.policy?.version ?? null },
    ));
  }
  const groups = new Map<string, CanonicalAttributeOperation[]>();
  for (const operation of [...input.operations].sort(canonicalOperationSort)) {
    const entries = groups.get(operation.parameterKey) ?? [];
    entries.push(operation);
    groups.set(operation.parameterKey, entries);
  }

  const record = (
    operation: CanonicalAttributeOperation,
    stage: string,
    before: number | string | null,
    operand: number | string,
    after: number | string | null,
    anomaly: NumericAnomaly,
    ruleId = operation.operationId,
  ) => {
    sequence += 1;
    trace.push({
      sequence,
      ruleId,
      sourceId: operation.sourceAffixId,
      sourceName: operation.sourceAffixId,
      parameterKey: operation.parameterKey,
      operation: operation.operation,
      before,
      operand,
      after,
      numericEvidence: {
        stage,
        rawLexical: operation.rawLexical,
        ...(typeof operand === "number" ? { operandBinary64: numberToBinary64Hex(operand) } : {}),
        ...(typeof before === "number" ? { beforeBinary64: numberToBinary64Hex(before) } : {}),
        ...(typeof after === "number" ? { afterBinary64: numberToBinary64Hex(after) } : {}),
        anomaly,
      },
    });
  };

  for (const parameterKey of [...groups.keys()].sort(compareUtf8)) {
    const operations = groups.get(parameterKey)!;
    const numeric = operations.filter((entry) =>
      ["percent_adjust", "flat_adjust", "clamp_add"].includes(entry.operation)
      || (entry.operation === "set" && typeof entry.value === "number")
    );
    const enums = operations.filter((entry) =>
      entry.operation === "enum_add"
      || (entry.operation === "set" && typeof entry.value !== "number")
    );
    if (numeric.length && enums.length) {
      addRuntimeIssue(
        issues,
        "AFFIX_PARAMETER_TYPE_CONFLICT",
        "同一参数混用了数值与枚举操作，已隔离该参数。",
        parameterKey,
        { operationIds: operations.map((entry) => entry.operationId) },
        "ERROR",
      );
      continue;
    }
    const sets = operations.filter((entry) => entry.operation === "set");
    if (sets.length > 1) {
      addRuntimeIssue(
        issues,
        "AFFIX_SET_CONFLICT",
        "同一参数存在多个 set，已隔离该参数。",
        parameterKey,
        { operationIds: sets.map((entry) => entry.operationId) },
        "ERROR",
      );
      continue;
    }
    if (enums.length) {
      let current = values[parameterKey] ?? "";
      if (sets[0]) {
        const before = current;
        current = String(sets[0].value);
        values[parameterKey] = current;
        record(sets[0], "set", String(before), String(sets[0].value), current, "none");
      }
      for (const operation of operations.filter((entry) => entry.operation === "enum_add")) {
        const before = String(values[parameterKey] ?? "");
        const token = String(operation.value ?? "");
        const tokens = before ? before.split("|") : [];
        const after = tokens.includes(token) ? before : [...tokens, token].filter(Boolean).join("|");
        values[parameterKey] = after;
        record(operation, "enum_add", before, token, after, after === before ? "no_effect" : "none");
      }
      continue;
    }

    let current = sets[0]?.value ?? values[parameterKey];
    if (typeof current !== "number" || !Number.isFinite(current)) {
      addRuntimeIssue(
        issues,
        "AFFIX_NUMERIC_INPUT_INVALID",
        "词条目标基础值不是有限 binary64 数值，已隔离该参数。",
        parameterKey,
        { value: current },
      );
      continue;
    }
    if (current < 0) {
      addRuntimeIssue(
        issues,
        "AFFIX_NEGATIVE_BASE",
        "bidirectional_ratio 只接受非负基础值，已隔离该参数。",
        parameterKey,
        { value: current, binary64: numberToBinary64Hex(current) },
        "ERROR",
      );
      continue;
    }
    if (sets[0]) {
      const before = values[parameterKey] ?? null;
      record(sets[0], "set", before as number | string | null, current, current, "none");
    }
    let currentExact = exactNumber(current);
      const foldPool = (
      poolOperations: CanonicalAttributeOperation[],
      direction: "increase" | "decrease",
      stage: string,
    ): { value: number; exact: Rational; valid: boolean } => {
      let total = 0;
      let exact = exactNumber(0);
      for (const operation of poolOperations.filter((entry) => entry.direction === direction)) {
        const magnitude = operation.magnitude;
        const parsedLexical = operation.rawLexical === undefined
          ? magnitude
          : Number(operation.rawLexical);
        const parsedMagnitude = operation.migrationEvidence?.sourceShape === "legacy_signed"
          ? Math.abs(parsedLexical ?? Number.NaN)
          : parsedLexical;
        if (magnitude === undefined || !Number.isFinite(magnitude) || magnitude < 0) {
          addRuntimeIssue(
            issues,
            "AFFIX_MAGNITUDE_INVALID",
            "词条 magnitude 必须是非负有限 binary64 数值，已隔离该参数。",
            parameterKey,
            { operationId: operation.operationId, magnitude },
            "ERROR",
          );
          return { value: total, exact, valid: false };
        }
        if (
          parsedLexical === undefined
          || !Number.isFinite(parsedLexical)
          || parsedMagnitude === undefined
          || numberToBinary64Hex(parsedMagnitude) !== numberToBinary64Hex(magnitude)
        ) {
          addRuntimeIssue(
            issues,
            "AFFIX_NUMERIC_INPUT_INVALID",
            "词条原始字面值无法按 ties-to-even 解析为声明的 binary64 位型，已隔离该参数。",
            parameterKey,
            {
              operationId: operation.operationId,
              rawLexical: operation.rawLexical,
              declaredBinary64: numberToBinary64Hex(magnitude),
              waivable: false,
            },
          );
          return { value: total, exact, valid: false };
        }
        const before = total;
        const nextExact = addExact(exact, exactNumber(magnitude));
        const after = Number(total + magnitude);
        const anomaly = classifyNumeric(nextExact, after);
        record(operation, stage, before, magnitude, after, after === before && magnitude !== 0 ? "no_effect" : anomaly);
        if (anomaly !== "none") {
          addRuntimeIssue(
            issues,
            anomaly === "overflow" ? "AFFIX_NUMERIC_OVERFLOW" : "AFFIX_NUMERIC_UNDERFLOW_TO_ZERO",
            "词条数值折叠出现不可接受的 binary64 异常，已隔离该参数。",
            parameterKey,
            { operationId: operation.operationId, anomaly },
          );
          return { value: after, exact: nextExact, valid: false };
        }
        total = after;
        exact = nextExact;
      }
      return { value: total, exact, valid: true };
    };
    const percentOperations = operations.filter((entry) => entry.operation === "percent_adjust");
    const boosts = foldPool(percentOperations, "increase", "percent_increase_pool");
    const reductions = foldPool(percentOperations, "decrease", "percent_decrease_pool");
    if (!boosts.valid || !reductions.valid) continue;
    const one = exactNumber(1);
    const numeratorExact = multiplyExact(currentExact, addExact(one, boosts.exact));
    const numerator = Number(current * Number(1 + boosts.value));
    let anomaly = classifyNumeric(numeratorExact, numerator);
    if (anomaly !== "none") {
      addRuntimeIssue(issues, anomaly === "overflow" ? "AFFIX_NUMERIC_OVERFLOW" : "AFFIX_NUMERIC_UNDERFLOW_TO_ZERO", "百分比增益阶段出现 binary64 异常。", parameterKey, { anomaly });
      continue;
    }
    const denominatorExact = addExact(one, reductions.exact);
    const denominator = Number(1 + reductions.value);
    const ratioExact = divideExact(numeratorExact, denominatorExact);
    const ratio = Number(numerator / denominator);
    anomaly = classifyNumeric(ratioExact, ratio);
    const synthetic = percentOperations.at(-1) ?? {
      operationId: `ratio:${parameterKey}`,
      operationIndex: -1,
      sourceAffixId: "runtime:bidirectional_ratio",
      sourceAffixRevision: 1,
      parameterKey,
      operation: "percent_adjust" as const,
      direction: "increase" as const,
      magnitude: 0,
    };
    record(synthetic, "bidirectional_ratio", current, reductions.value, ratio, anomaly, `bidirectional_ratio:${parameterKey}`);
    if (anomaly !== "none") {
      addRuntimeIssue(issues, anomaly === "overflow" ? "AFFIX_NUMERIC_OVERFLOW" : "AFFIX_NUMERIC_UNDERFLOW_TO_ZERO", "bidirectional_ratio 结算出现 binary64 异常。", parameterKey, { anomaly });
      continue;
    }
    current = ratio;
    currentExact = ratioExact;

    const flatOperations = operations.filter((entry) => entry.operation === "flat_adjust");
    const flatIncrease = foldPool(flatOperations, "increase", "flat_increase_pool");
    const flatDecrease = foldPool(flatOperations, "decrease", "flat_decrease_pool");
    if (!flatIncrease.valid || !flatDecrease.valid) continue;
    const afterFlatIncreaseExact = addExact(currentExact, flatIncrease.exact);
    const afterFlatIncrease = Number(current + flatIncrease.value);
    anomaly = classifyNumeric(afterFlatIncreaseExact, afterFlatIncrease);
    if (anomaly === "none") {
      const afterFlatExact = subtractExact(afterFlatIncreaseExact, flatDecrease.exact);
      const afterFlat = Number(afterFlatIncrease - flatDecrease.value);
      anomaly = classifyNumeric(afterFlatExact, afterFlat);
      record(synthetic, "flat_adjust_result", current, flatIncrease.value - flatDecrease.value, afterFlat, anomaly, `flat_adjust:${parameterKey}`);
      current = afterFlat;
      currentExact = afterFlatExact;
    }
    if (anomaly !== "none") {
      addRuntimeIssue(issues, anomaly === "overflow" ? "AFFIX_NUMERIC_OVERFLOW" : "AFFIX_NUMERIC_UNDERFLOW_TO_ZERO", "flat_adjust 结算出现 binary64 异常。", parameterKey, { anomaly });
      continue;
    }

    let clampValid = true;
    for (const operation of operations.filter((entry) => entry.operation === "clamp_add")) {
      const magnitude = operation.magnitude;
      if (
        magnitude === undefined
        || !Number.isFinite(magnitude)
        || magnitude < 0
        || operation.direction === undefined
        || (
          operation.clampMin !== undefined
          && operation.clampMax !== undefined
          && operation.clampMin > operation.clampMax
        )
      ) {
        addRuntimeIssue(issues, "AFFIX_MAGNITUDE_INVALID", "clamp_add 参数无效，已隔离该参数。", parameterKey, { operationId: operation.operationId }, "ERROR");
        clampValid = false;
        break;
      }
      const signed = operation.direction === "increase" ? magnitude : -magnitude;
      const addedExact = addExact(currentExact, exactNumber(signed));
      const added = Number(current + signed);
      anomaly = classifyNumeric(addedExact, added);
      if (anomaly !== "none") {
        addRuntimeIssue(issues, anomaly === "overflow" ? "AFFIX_NUMERIC_OVERFLOW" : "AFFIX_NUMERIC_UNDERFLOW_TO_ZERO", "clamp_add 出现 binary64 异常。", parameterKey, { operationId: operation.operationId, anomaly });
        clampValid = false;
        break;
      }
      const after = Math.min(operation.clampMax ?? Infinity, Math.max(operation.clampMin ?? -Infinity, added));
      const afterExact = after === added ? addedExact : exactNumber(after);
      record(operation, "clamp_add", current, signed, after, after === current && signed !== 0 ? "no_effect" : "none");
      current = after;
      currentExact = afterExact;
    }
    if (clampValid) values[parameterKey] = current;
  }
  const traceHash = sha256Text(stableJson({
    policyVersion: input.policy?.version ?? null,
    values,
    trace,
    issues: issues.map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      gate: entry.gate,
      fingerprint: entry.fingerprint,
    })),
  }));
  return {
    values,
    trace,
    issues,
    formalStatus: policyFormal && !issues.some((entry) => entry.severity === "BLOCKER")
      ? "FORMAL"
      : "NON_FORMAL",
    traceHash,
  };
}

function roundTiesToEven(value: number, precision: number): number {
  const factor = 10 ** precision;
  const scaled = value * factor;
  if (!Number.isFinite(scaled)) return value;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const rounded = fraction < 0.5
    ? lower
    : fraction > 0.5
      ? lower + 1
      : lower % 2 === 0 ? lower : lower + 1;
  return rounded / factor;
}

export function applyParameterDefinitions(input: {
  values: Record<string, number | string>;
  definitions: ParameterDefinition[];
  sequenceStart?: number;
}): {
  values: Record<string, number | string>;
  trace: ProjectionTraceContribution[];
  issues: ValidationIssue[];
} {
  const values = structuredClone(input.values);
  const trace: ProjectionTraceContribution[] = [];
  const issues: ValidationIssue[] = [];
  let sequence = input.sequenceStart ?? 0;
  for (const definition of [...input.definitions].sort((a, b) => compareUtf8(a.key, b.key))) {
    const before = values[definition.key];
    if (typeof before !== "number") continue;
    const bounded = definition.targetRange
      ? Math.min(definition.targetRange.max, Math.max(definition.targetRange.min, before))
      : before;
    const after = roundTiesToEven(bounded, definition.precision);
    if (!Number.isFinite(after)) {
      addRuntimeIssue(issues, "AFFIX_NUMERIC_OVERFLOW", "ParameterDefinition 结算结果不是有限 binary64 数值。", definition.key, { before, precision: definition.precision });
      continue;
    }
    sequence += 1;
    values[definition.key] = after;
    trace.push({
      sequence,
      ruleId: `parameter-definition:${definition.key}`,
      sourceId: `parameter-definition:${definition.key}`,
      sourceName: definition.label,
      parameterKey: definition.key,
      operation: "set",
      before,
      operand: definition.precision,
      after,
      numericEvidence: {
        stage: "parameter_definition",
        beforeBinary64: numberToBinary64Hex(before),
        operandBinary64: numberToBinary64Hex(definition.precision),
        afterBinary64: numberToBinary64Hex(after),
        anomaly: before === after ? "no_effect" : "none",
      },
    });
  }
  return { values, trace, issues };
}

export function assertSnapshotReplayPolicyAvailable(input: {
  reductionStackingPolicyVersion?: string;
  availablePolicies: ReductionStackingPolicyVersion[];
  operation: "view" | "audit_archive" | "formal_export";
}): ValidationIssue[] {
  if (input.operation !== "formal_export") return [];
  const available = input.reductionStackingPolicyVersion
    && input.availablePolicies.some((policy) =>
      policy.version === input.reductionStackingPolicyVersion
      && policy.status === "published"
    );
  return available ? [] : [issue(
    "SNAPSHOT_REPLAY_POLICY_MISSING",
    "历史 Snapshot 可继续查看与生成审计归档，但缺少可重放策略版本，禁止正式导出。",
    { reductionStackingPolicyVersion: input.reductionStackingPolicyVersion ?? null },
    "BLOCKER",
    "EXPORT",
  )];
}

export function assertFormalSnapshotHasReplayPolicy(
  snapshot: ConfigurationSnapshot,
): void {
  if (!snapshot.reductionStackingPolicyVersion) {
    throw new Error(
      "[SNAPSHOT_REPLAY_POLICY_MISSING] 历史 Snapshot 可查看和生成审计归档，但缺少冻结的 ReductionStackingPolicyVersion，禁止正式导出。",
    );
  }
}

export function createSnapshotAuditReplayManifest(input: {
  snapshot: ConfigurationSnapshot;
  availablePolicies: ReductionStackingPolicyVersion[];
}): {
  snapshotId: string;
  snapshotContentHash: string;
  replayStatus: "REPLAYABLE" | "POLICY_MISSING";
  formalExportAllowed: boolean;
  issues: ValidationIssue[];
} {
  const issues = assertSnapshotReplayPolicyAvailable({
    reductionStackingPolicyVersion: input.snapshot.reductionStackingPolicyVersion,
    availablePolicies: input.availablePolicies,
    operation: "formal_export",
  });
  return {
    snapshotId: input.snapshot.id,
    snapshotContentHash: input.snapshot.contentHash,
    replayStatus: issues.length ? "POLICY_MISSING" : "REPLAYABLE",
    formalExportAllowed: issues.length === 0,
    issues,
  };
}
