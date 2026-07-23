import { deterministicHash } from "./rule-kernel";
import type { EntityRef } from "./interaction-contracts";
import type {
  CalculationTraceItem,
  DerivedProjection,
  FiveAxisTraceEntry,
  ModelFiveAxisPreview,
  ParameterDefinition,
  PatchApplicationTraceItem,
  ProjectionLayer,
  ProjectionWarning,
} from "./types";
import type { PricingTraceEntry, PricingTrialResult } from "./pricing-policy";

export const CALCULATION_TRACE_SCHEMA_VERSION = "calculation-trace/v1" as const;
export const CALCULATION_TRACE_HASH_CONTRACT_VERSION = "json-lossless-fnv1a/v2" as const;
export const CALCULATION_TRACE_REPLAY_CONTRACT_VERSION = "strict-contiguous/v1" as const;

export type CalculationTraceLayer =
  | "weight_template"
  | "method"
  | "type"
  | "function"
  | "quality"
  | "boundary"
  | "attribute_affix"
  | "technology_affix"
  | "series_patch"
  | "sku_patch"
  | "model_patch"
  | "final_review_patch"
  | "rule_suppression"
  | "projection_pin";

export type CalculationTraceEffect = "benefit" | "cost" | "neutral" | "contextual";
export type CalculationTraceOperation =
  | "base"
  | "set"
  | "add"
  | "multiply"
  | "divide"
  | "min"
  | "max"
  | "clear"
  | "no_effect";

export interface CalculationTraceActionLink {
  actionId: string;
  action: "recompute" | "retry" | "view_snapshot" | "review_source";
  label: string;
  enabled: boolean;
  targetRef?: EntityRef;
}

export interface CalculationTraceEntry {
  schemaVersion: typeof CALCULATION_TRACE_SCHEMA_VERSION;
  traceEntryId: string;
  subjectRef: EntityRef;
  parameterKey: string;
  sequence: number;
  layer: CalculationTraceLayer;
  sourceRef: EntityRef | { sourceType: string; sourceId: string };
  sourceVersion: string;
  ruleSetVersion: string;
  before: unknown;
  operation: CalculationTraceOperation;
  operand: unknown;
  after: unknown;
  unit?: string;
  effect: CalculationTraceEffect;
  warningIssueIds: string[];
  actions: CalculationTraceActionLink[];
  inputHash: string;
  outputHash: string;
  /** 兼容适配器保留旧结构原文；重放不读取 evidence。 */
  evidence?: Record<string, unknown>;
}

export interface CalculationTraceStateValue {
  subjectRef: EntityRef;
  parameterKey: string;
  value: unknown;
}

export interface CalculationTraceEntryRef {
  traceEntryId: string;
  sequence: number;
  inputHash: string;
  outputHash: string;
}

export interface CalculationTraceArchive {
  schemaVersion: typeof CALCULATION_TRACE_SCHEMA_VERSION;
  hashContractVersion: typeof CALCULATION_TRACE_HASH_CONTRACT_VERSION;
  replayContractVersion: typeof CALCULATION_TRACE_REPLAY_CONTRACT_VERSION;
  entries: CalculationTraceEntry[];
  entryRefs: CalculationTraceEntryRef[];
  initialState: CalculationTraceStateValue[];
  finalState: CalculationTraceStateValue[];
  traceHash: string;
  replayHash: string;
}

export interface CalculationTraceReplayIssue {
  issueId: string;
  code: "TRACE_REPLAY_MISMATCH";
  severity: "error";
  blocking: true;
  gate: "publish";
  message: string;
  traceEntryId?: string;
  sequence?: number;
  warningIssueIds: string[];
  actions: CalculationTraceActionLink[];
}

export class CalculationTraceReplayError extends Error {
  readonly issue: CalculationTraceReplayIssue;

  constructor(message: string, entry?: CalculationTraceEntry) {
    super(`TRACE_REPLAY_MISMATCH：${message}`);
    this.name = "CalculationTraceReplayError";
    this.issue = {
      issueId: "trace-replay-" + deterministicHash({
        message,
        traceEntryId: entry?.traceEntryId,
        sequence: entry?.sequence,
      }),
      code: "TRACE_REPLAY_MISMATCH",
      severity: "error",
      blocking: true,
      gate: "publish",
      message,
      traceEntryId: entry?.traceEntryId,
      sequence: entry?.sequence,
      warningIssueIds: entry?.warningIssueIds ?? [],
      actions: entry?.actions.length
        ? structuredClone(entry.actions)
        : [{
            actionId: "recompute-calculation-trace",
            action: "recompute",
            label: "重新计算并核对 Trace",
            enabled: true,
          }],
    };
  }
}

export function assertCalculationTraceJsonSafe(
  value: unknown,
  path = "calculationTrace",
): void {
  const ancestors = new WeakSet<object>();
  const visit = (candidate: unknown, currentPath: string): void => {
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
    ) return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new CalculationTraceReplayError(
          `${currentPath} 必须是可无损 JSON 持久化的有限数值。`,
        );
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new CalculationTraceReplayError(
        `${currentPath} 包含不可 JSON 持久化的 ${typeof candidate}。`,
      );
    }
    if (ancestors.has(candidate)) {
      throw new CalculationTraceReplayError(`${currentPath} 包含循环引用。`);
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!(index in candidate)) {
          throw new CalculationTraceReplayError(`${currentPath}[${index}] 是稀疏数组空位。`);
        }
        visit(candidate[index], `${currentPath}[${index}]`);
      }
      ancestors.delete(candidate);
      return;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CalculationTraceReplayError(`${currentPath} 必须是普通 JSON 对象。`);
    }
    const ownKeys = Reflect.ownKeys(candidate);
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        throw new CalculationTraceReplayError(`${currentPath} 包含 Symbol key。`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
        throw new CalculationTraceReplayError(`${currentPath}.${key} 不是普通可枚举 JSON 字段。`);
      }
      visit((candidate as Record<string, unknown>)[key], `${currentPath}.${key}`);
    }
    ancestors.delete(candidate);
  };
  visit(value, path);
}

function sameValue(left: unknown, right: unknown): boolean {
  return deterministicHash(left) === deterministicHash(right);
}

function entityKey(ref: EntityRef): string {
  return [ref.workspaceId, ref.entityType, ref.entityId, ref.revisionId].join("\u001f");
}

function stateKey(subjectRef: EntityRef, parameterKey: string): string {
  return `${entityKey(subjectRef)}\u001e${parameterKey}`;
}

function valueHash(subjectRef: EntityRef, parameterKey: string, value: unknown): string {
  return deterministicHash({
    hashContractVersion: CALCULATION_TRACE_HASH_CONTRACT_VERSION,
    subjectRef,
    parameterKey,
    value,
  });
}

function applyOperation(
  before: unknown,
  operation: CalculationTraceOperation,
  operand: unknown,
): unknown {
  if (operation === "no_effect") return before;
  if (operation === "base" || operation === "set") return operand;
  if (operation === "clear") return null;
  if (typeof before !== "number" || typeof operand !== "number") {
    throw new Error(`${operation} 只接受数字。`);
  }
  if (operation === "add") return before + operand;
  if (operation === "multiply") return before * operand;
  if (operation === "divide") {
    if (operand === 0) throw new Error("divide 的 operand 不能为 0。");
    return before / operand;
  }
  if (operation === "min") return Math.min(before, operand);
  return Math.max(before, operand);
}

export interface CreateCalculationTraceEntryInput
  extends Omit<
    CalculationTraceEntry,
    "schemaVersion" | "traceEntryId" | "inputHash" | "outputHash"
  > {
  traceEntryId?: string;
}

export function createCalculationTraceEntry(
  input: CreateCalculationTraceEntryInput,
): CalculationTraceEntry {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new Error("CalculationTraceEntry.sequence 必须是从 1 开始的正整数。");
  }
  assertCalculationTraceJsonSafe(input.before, "CalculationTraceEntry.before");
  assertCalculationTraceJsonSafe(input.operand, "CalculationTraceEntry.operand");
  assertCalculationTraceJsonSafe(input.after, "CalculationTraceEntry.after");
  let calculatedAfter: unknown;
  try {
    calculatedAfter = applyOperation(input.before, input.operation, input.operand);
  } catch (error) {
    throw new CalculationTraceReplayError(
      error instanceof Error ? error.message : "Trace operation 无法执行。",
    );
  }
  if (!sameValue(calculatedAfter, input.after)) {
    throw new CalculationTraceReplayError("创建 Trace 时 before、operation、operand 与 after 不一致。");
  }
  const identity = {
    schemaVersion: CALCULATION_TRACE_SCHEMA_VERSION,
    subjectRef: input.subjectRef,
    parameterKey: input.parameterKey,
    sequence: input.sequence,
    layer: input.layer,
    sourceRef: input.sourceRef,
    sourceVersion: input.sourceVersion,
    ruleSetVersion: input.ruleSetVersion,
    before: input.before,
    operation: input.operation,
    operand: input.operand,
    after: input.after,
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    effect: input.effect,
    warningIssueIds: [...input.warningIssueIds].sort(),
    actions: input.actions,
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  };
  assertCalculationTraceJsonSafe(identity, "CalculationTraceEntry");
  return {
    ...identity,
    traceEntryId: input.traceEntryId ?? "trace-" + deterministicHash(identity),
    inputHash: valueHash(input.subjectRef, input.parameterKey, input.before),
    outputHash: valueHash(input.subjectRef, input.parameterKey, input.after),
  };
}

function stateArray(values: Map<string, CalculationTraceStateValue>): CalculationTraceStateValue[] {
  return [...values.values()].sort((left, right) =>
    stateKey(left.subjectRef, left.parameterKey).localeCompare(
      stateKey(right.subjectRef, right.parameterKey),
    ),
  );
}

function stateMap(values: CalculationTraceStateValue[]): Map<string, CalculationTraceStateValue> {
  const result = new Map<string, CalculationTraceStateValue>();
  for (const entry of values) {
    const key = stateKey(entry.subjectRef, entry.parameterKey);
    if (result.has(key)) {
      throw new CalculationTraceReplayError(`初始状态重复：${entry.parameterKey}。`);
    }
    result.set(key, structuredClone(entry));
  }
  return result;
}

export function replayCalculationTrace(input: {
  entries: CalculationTraceEntry[];
  initialState: CalculationTraceStateValue[];
}): { finalState: CalculationTraceStateValue[]; replayHash: string } {
  assertCalculationTraceJsonSafe(input, "CalculationTraceReplayInput");
  const entries = [...input.entries].sort((left, right) => left.sequence - right.sequence);
  const values = stateMap(input.initialState);
  entries.forEach((entry, index) => {
    if (entry.schemaVersion !== CALCULATION_TRACE_SCHEMA_VERSION) {
      throw new CalculationTraceReplayError(`不支持的 Trace schema：${entry.schemaVersion}。`, entry);
    }
    if (entry.sequence !== index + 1) {
      throw new CalculationTraceReplayError(
        `sequence 必须全局唯一且连续；期望 ${index + 1}，实际 ${entry.sequence}。`,
        entry,
      );
    }
    const key = stateKey(entry.subjectRef, entry.parameterKey);
    const current = values.get(key);
    if (!current) {
      throw new CalculationTraceReplayError(`初始状态缺失：${entry.parameterKey}。`, entry);
    }
    if (
      !sameValue(current.value, entry.before)
      || valueHash(entry.subjectRef, entry.parameterKey, current.value) !== entry.inputHash
    ) {
      throw new CalculationTraceReplayError(`before 或 inputHash 不一致：${entry.parameterKey}。`, entry);
    }
    let after: unknown;
    try {
      after = applyOperation(current.value, entry.operation, entry.operand);
    } catch (error) {
      throw new CalculationTraceReplayError(
        error instanceof Error ? error.message : `operation 无法重放：${entry.parameterKey}。`,
        entry,
      );
    }
    if (
      !sameValue(after, entry.after)
      || valueHash(entry.subjectRef, entry.parameterKey, after) !== entry.outputHash
    ) {
      throw new CalculationTraceReplayError(`after 或 outputHash 不一致：${entry.parameterKey}。`, entry);
    }
    values.set(key, {
      subjectRef: structuredClone(entry.subjectRef),
      parameterKey: entry.parameterKey,
      value: structuredClone(after),
    });
  });
  const finalState = stateArray(values);
  return {
    finalState,
    replayHash: deterministicHash({
      replayContractVersion: CALCULATION_TRACE_REPLAY_CONTRACT_VERSION,
      entries,
      finalState,
    }),
  };
}

export function tryReplayCalculationTrace(input: {
  entries: CalculationTraceEntry[];
  initialState: CalculationTraceStateValue[];
}):
  | { ok: true; finalState: CalculationTraceStateValue[]; replayHash: string }
  | { ok: false; issue: CalculationTraceReplayIssue } {
  try {
    return { ok: true, ...replayCalculationTrace(input) };
  } catch (error) {
    if (error instanceof CalculationTraceReplayError) {
      return { ok: false, issue: error.issue };
    }
    const wrapped = new CalculationTraceReplayError(
      error instanceof Error ? error.message : "Trace 重放失败。",
    );
    return { ok: false, issue: wrapped.issue };
  }
}

function inferInitialState(entries: CalculationTraceEntry[]): CalculationTraceStateValue[] {
  const seen = new Set<string>();
  const initial = new Map<string, CalculationTraceStateValue>();
  for (const entry of [...entries].sort((left, right) => left.sequence - right.sequence)) {
    const key = stateKey(entry.subjectRef, entry.parameterKey);
    if (seen.has(key)) continue;
    seen.add(key);
    initial.set(key, {
      subjectRef: structuredClone(entry.subjectRef),
      parameterKey: entry.parameterKey,
      value: structuredClone(entry.before),
    });
  }
  return stateArray(initial);
}

export function createCalculationTraceArchive(
  entries: CalculationTraceEntry[],
): CalculationTraceArchive {
  assertCalculationTraceJsonSafe(entries, "CalculationTraceArchive.entries");
  const frozenEntries = structuredClone(
    [...entries].sort((left, right) => left.sequence - right.sequence),
  );
  const initialState = inferInitialState(frozenEntries);
  const replay = replayCalculationTrace({ entries: frozenEntries, initialState });
  const entryRefs = frozenEntries.map((entry) => ({
    traceEntryId: entry.traceEntryId,
    sequence: entry.sequence,
    inputHash: entry.inputHash,
    outputHash: entry.outputHash,
  }));
  const hashContent = {
    schemaVersion: CALCULATION_TRACE_SCHEMA_VERSION,
    hashContractVersion: CALCULATION_TRACE_HASH_CONTRACT_VERSION,
    replayContractVersion: CALCULATION_TRACE_REPLAY_CONTRACT_VERSION,
    entries: frozenEntries,
    entryRefs,
    initialState,
    finalState: replay.finalState,
  };
  return {
    ...hashContent,
    traceHash: deterministicHash(hashContent),
    replayHash: replay.replayHash,
  };
}

export function verifyCalculationTraceArchive(archive: CalculationTraceArchive): boolean {
  if (
    archive.schemaVersion !== CALCULATION_TRACE_SCHEMA_VERSION
    || archive.hashContractVersion !== CALCULATION_TRACE_HASH_CONTRACT_VERSION
    || archive.replayContractVersion !== CALCULATION_TRACE_REPLAY_CONTRACT_VERSION
  ) return false;
  try {
    assertCalculationTraceJsonSafe(archive, "CalculationTraceArchive");
    const recreated = createCalculationTraceArchive(archive.entries);
    return (
      recreated.traceHash === archive.traceHash
      && recreated.replayHash === archive.replayHash
      && sameValue(recreated.entryRefs, archive.entryRefs)
      && sameValue(recreated.initialState, archive.initialState)
      && sameValue(recreated.finalState, archive.finalState)
    );
  } catch {
    return false;
  }
}

function sameEntityRef(left: EntityRef, right: EntityRef): boolean {
  return entityKey(left) === entityKey(right);
}

function isAuxiliaryTraceEntry(entry: CalculationTraceEntry): boolean {
  const sourceType = "sourceType" in entry.sourceRef
    ? entry.sourceRef.sourceType
    : undefined;
  return (
    entry.evidence?.adapter === "pricing_trace/v1"
    && entry.parameterKey.startsWith("pricing:")
    && sourceType === "pricing_cell"
  ) || (
    entry.evidence?.adapter === "five_axis_trace/v1"
    && entry.parameterKey.startsWith("five_axis:")
    && sourceType === "five_axis_definition"
  );
}

export function assertCalculationTraceMatchesFinalPanel(input: {
  archive: CalculationTraceArchive;
  subjectRef: EntityRef;
  finalPanelValues: Record<string, number | string>;
}): void {
  assertCalculationTraceJsonSafe(input.finalPanelValues, "finalPanelValues");
  const expectedKeys = new Set(Object.keys(input.finalPanelValues));
  for (const entry of input.archive.entries) {
    if (
      sameEntityRef(entry.subjectRef, input.subjectRef)
      && !entry.parameterKey.startsWith("__")
      && !isAuxiliaryTraceEntry(entry)
    ) {
      expectedKeys.add(entry.parameterKey);
    }
  }
  const finalValues = new Map(
    input.archive.finalState
      .filter((entry) => sameEntityRef(entry.subjectRef, input.subjectRef))
      .map((entry) => [entry.parameterKey, entry.value]),
  );
  for (const parameterKey of [...expectedKeys].sort()) {
    if (!Object.hasOwn(input.finalPanelValues, parameterKey)) {
      throw new CalculationTraceReplayError(
        `finalPanelValues 缺少 Trace 面板参数：${parameterKey}。`,
      );
    }
    if (!finalValues.has(parameterKey)) {
      throw new CalculationTraceReplayError(
        `canonical Trace 未覆盖最终面板参数：${parameterKey}。`,
      );
    }
    if (!sameValue(finalValues.get(parameterKey), input.finalPanelValues[parameterKey])) {
      throw new CalculationTraceReplayError(
        `canonical Trace 终态与 finalPanelValues 不一致：${parameterKey}。`,
      );
    }
  }
}

function warningId(warning: ProjectionWarning): string {
  return `projection-warning-${deterministicHash(warning)}`;
}

function canonicalLayer(layer: ProjectionLayer | string): CalculationTraceLayer {
  if (layer === "base_weight_template") return "weight_template";
  if (layer === "item_type") return "type";
  if (layer === "performance" || layer === "validation") return "boundary";
  const supported: CalculationTraceLayer[] = [
    "weight_template", "method", "type", "function", "quality", "boundary",
    "attribute_affix", "technology_affix", "series_patch", "sku_patch",
    "model_patch", "final_review_patch", "rule_suppression", "projection_pin",
  ];
  return supported.includes(layer as CalculationTraceLayer)
    ? layer as CalculationTraceLayer
    : "boundary";
}

function parameterMap(definitions: ParameterDefinition[] = []): Map<string, ParameterDefinition> {
  return new Map(definitions.map((definition) => [definition.key, definition]));
}

function effectFor(
  definition: ParameterDefinition | undefined,
  before: unknown,
  after: unknown,
): CalculationTraceEffect {
  if (sameValue(before, after)) return "neutral";
  if (!definition || definition.benefitMode === "contextual" || definition.benefitMode === "target_range") {
    return "contextual";
  }
  if (typeof before !== "number" || typeof after !== "number") return "contextual";
  const improved = definition.benefitMode === "lower_better" ? after < before : after > before;
  return improved ? "benefit" : "cost";
}

function normalizedOperation(operation: string): CalculationTraceOperation {
  if (operation === "base") return "base";
  if (operation === "set") return "set";
  if (operation === "add" || operation === "flat_bonus") return "add";
  if (operation === "multiply" || operation === "percent_bonus") return "multiply";
  if (operation === "min") return "min";
  if (operation === "max") return "max";
  if (operation === "remove" || operation === "clear") return "clear";
  return "set";
}

function executableOperation(
  originalOperation: string,
  before: unknown,
  operand: unknown,
  after: unknown,
): { operation: CalculationTraceOperation; operand: unknown } {
  const operation = normalizedOperation(originalOperation);
  const candidateOperand = operation === "clear" ? null : operand;
  try {
    if (sameValue(applyOperation(before, operation, candidateOperand), after)) {
      return { operation, operand: candidateOperand };
    }
  } catch {
    // 旧 Trace 的 operation 可能是展示语义；适配器以 set 保留可重放结果。
  }
  return { operation: "set", operand: after };
}

export function adaptRuleTraceToCanonical(input: {
  projection: DerivedProjection;
  subjectRef: EntityRef;
  parameterDefinitions?: ParameterDefinition[];
  sequenceStart?: number;
}): CalculationTraceEntry[] {
  const definitions = parameterMap(input.parameterDefinitions);
  let sequence = input.sequenceStart ?? 1;
  const entries: CalculationTraceEntry[] = [];
  if (!input.projection.trace.length) {
    entries.push(createCalculationTraceEntry({
      subjectRef: input.subjectRef,
      parameterKey: "__trace_summary__:projection",
      sequence,
      layer: "boundary",
      sourceRef: { sourceType: "projection", sourceId: input.projection.id },
      sourceVersion: input.projection.ruleSetVersion,
      ruleSetVersion: input.projection.ruleSetVersion,
      before: null,
      operation: "no_effect",
      operand: null,
      after: null,
      effect: "neutral",
      warningIssueIds: input.projection.warnings.map(warningId).sort(),
      actions: [],
      evidence: { adapter: "projection_trace/v1", noEffectReason: "projection_trace_empty" },
    }));
    return entries;
  }
  for (const step of input.projection.trace) {
    const contributions = [...step.contributions].sort((left, right) =>
      left.sequence - right.sequence || left.ruleId.localeCompare(right.ruleId),
    );
    if (!contributions.length) {
      const parameterKey = `__layer_summary__:${step.layer}`;
      entries.push(createCalculationTraceEntry({
        subjectRef: input.subjectRef,
        parameterKey,
        sequence: sequence++,
        layer: canonicalLayer(step.layer),
        sourceRef: {
          sourceType: step.layer === "base_weight_template" ? "weight_template" : "rule_layer",
          sourceId: step.sourceIds.join(",") || step.layer,
        },
        sourceVersion: input.projection.ruleSetVersion,
        ruleSetVersion: input.projection.ruleSetVersion,
        before: null,
        operation: "no_effect",
        operand: null,
        after: null,
        effect: "neutral",
        warningIssueIds: input.projection.warnings
          .filter((warning) => warning.layer === step.layer)
          .map(warningId)
          .sort(),
        actions: [],
        evidence: { adapter: "projection_trace/v1", legacyLayer: step.layer, sourceIds: step.sourceIds },
      }));
      continue;
    }
    for (const contribution of contributions) {
      const definition = definitions.get(contribution.parameterKey);
      const executable = executableOperation(
        contribution.operation,
        contribution.before,
        contribution.operand,
        contribution.after,
      );
      const relatedWarnings = input.projection.warnings.filter((warning) =>
        warning.layer === step.layer
        && (!warning.parameterKey || warning.parameterKey === contribution.parameterKey)
        && (!warning.sourceId || warning.sourceId === contribution.sourceId),
      );
      entries.push(createCalculationTraceEntry({
        subjectRef: input.subjectRef,
        parameterKey: contribution.parameterKey,
        sequence: sequence++,
        layer: canonicalLayer(step.layer),
        sourceRef: {
          sourceType: contribution.operation === "base" ? "weight_template" : "rule",
          sourceId: contribution.sourceId || contribution.ruleId,
        },
        sourceVersion: input.projection.ruleSetVersion,
        ruleSetVersion: input.projection.ruleSetVersion,
        before: contribution.before,
        operation: executable.operation,
        operand: executable.operand,
        after: contribution.after,
        ...(definition?.unit ? { unit: definition.unit } : {}),
        effect: effectFor(definition, contribution.before, contribution.after),
        warningIssueIds: relatedWarnings.map(warningId).sort(),
        actions: [],
        evidence: {
          adapter: "projection_trace/v1",
          legacySequence: contribution.sequence,
          ruleId: contribution.ruleId,
          sourceName: contribution.sourceName,
          legacyOperation: contribution.operation,
          legacyOperand: structuredClone(contribution.operand),
          ...(contribution.operation === "formula" ? {
            formula: {
              formulaId: contribution.ruleId,
              formulaVersion: input.projection.ruleSetVersion,
              operand: structuredClone(contribution.operand),
            },
          } : {}),
        },
      }));
    }
  }
  return entries;
}

export const adaptProjectionTraceToCanonical = adaptRuleTraceToCanonical;

function pricingLayer(entry: PricingTraceEntry): CalculationTraceLayer {
  if (/quality|score|factor/i.test(entry.formulaStep)) return "quality";
  return "boundary";
}

export function adaptPricingTraceToCanonical(input: {
  pricing: PricingTrialResult;
  subjectRef: EntityRef;
  ruleSetVersion: string;
  sequenceStart?: number;
}): CalculationTraceEntry[] {
  let sequence = input.sequenceStart ?? 1;
  return [...input.pricing.trace]
    .sort((left, right) => left.sequence - right.sequence || left.formulaStep.localeCompare(right.formulaStep))
    .map((entry) => {
      const executable = executableOperation(
        entry.operation,
        entry.before,
        entry.operand,
        entry.after,
      );
      return createCalculationTraceEntry({
        subjectRef: input.subjectRef,
        parameterKey: `pricing:${entry.formulaStep}:${entry.sequence}`,
        sequence: sequence++,
        layer: pricingLayer(entry),
        sourceRef: {
          sourceType: "pricing_cell",
          sourceId: `${entry.source.sheetId}:${entry.source.cell}:${entry.source.rowKey ?? ""}`,
        },
        sourceVersion: entry.sourceRevision,
        ruleSetVersion: input.ruleSetVersion,
        before: entry.before,
        operation: executable.operation,
        operand: executable.operand,
        after: entry.after,
        ...(input.pricing.moneyUnit ? { unit: input.pricing.moneyUnit } : {}),
        effect: "contextual",
        warningIssueIds: input.pricing.issues
          .map((issue) => `pricing-issue-${deterministicHash(issue)}`)
          .sort(),
        actions: [],
        evidence: { adapter: "pricing_trace/v1", ...entry },
      });
    });
}

function flattenFiveAxisTrace(preview: ModelFiveAxisPreview): Array<{
  parameterKey: string;
  sourceId: string;
  trace: FiveAxisTraceEntry;
}> {
  const flattened: Array<{ parameterKey: string; sourceId: string; trace: FiveAxisTraceEntry }> = [];
  for (const metric of [...preview.metrics].sort((left, right) => left.axisId.localeCompare(right.axisId))) {
    metric.trace.forEach((trace, index) => flattened.push({
      parameterKey: `five_axis:metric:${metric.axisId}:${index + 1}`,
      sourceId: metric.axisId,
      trace,
    }));
  }
  for (const series of [...preview.tackleFitComparison.series].sort((left, right) =>
    left.entityId.localeCompare(right.entityId),
  )) {
    for (const point of [...series.points].sort((left, right) => left.axisId.localeCompare(right.axisId))) {
      point.trace.forEach((trace, index) => flattened.push({
        parameterKey: `five_axis:point:${series.entityId}:${point.axisId}:${index + 1}`,
        sourceId: `${series.entityId}:${point.axisId}`,
        trace,
      }));
    }
  }
  return flattened;
}

export function adaptFiveAxisTraceToCanonical(input: {
  preview: ModelFiveAxisPreview;
  subjectRef: EntityRef;
  ruleSetVersion: string;
  sequenceStart?: number;
}): CalculationTraceEntry[] {
  let sequence = input.sequenceStart ?? 1;
  return flattenFiveAxisTrace(input.preview).map((entry) => {
    const hasValue = entry.trace.value !== undefined;
    return createCalculationTraceEntry({
      subjectRef: input.subjectRef,
      parameterKey: entry.parameterKey,
      sequence: sequence++,
      layer: "boundary",
      sourceRef: { sourceType: "five_axis_definition", sourceId: entry.sourceId },
      sourceVersion: input.preview.sourceRevision,
      ruleSetVersion: input.ruleSetVersion,
      before: null,
      operation: hasValue ? "set" : "no_effect",
      operand: hasValue ? entry.trace.value : null,
      after: hasValue ? entry.trace.value : null,
      effect: "contextual",
      warningIssueIds: input.preview.tackleFitComparison.validationIssues
        .map((issue) => `five-axis-issue-${deterministicHash(issue)}`)
        .sort(),
      actions: [],
      evidence: { adapter: "five_axis_trace/v1", ...entry.trace },
    });
  });
}

export function adaptPatchTraceToCanonical(input: {
  trace: PatchApplicationTraceItem[];
  subjectRef: EntityRef;
  sourceVersion: string;
  ruleSetVersion: string;
  parameterDefinitions?: ParameterDefinition[];
  sequenceStart?: number;
}): CalculationTraceEntry[] {
  const definitions = parameterMap(input.parameterDefinitions);
  let sequence = input.sequenceStart ?? 1;
  return input.trace.map((entry) => {
    const parameterKey = entry.path.replace(/^values\./, "");
    const definition = definitions.get(parameterKey);
    const removedValue = entry.operation === "remove" && entry.after === undefined;
    const canonicalAfter = removedValue ? null : entry.after;
    const executable = executableOperation(
      entry.operation,
      entry.before,
      entry.operand,
      canonicalAfter,
    );
    const legacyUndefinedFields = (["before", "operand", "after"] as const)
      .filter((field) => entry[field] === undefined);
    return createCalculationTraceEntry({
      subjectRef: input.subjectRef,
      parameterKey,
      sequence: sequence++,
      layer: canonicalLayer(`${entry.scope}_patch`),
      sourceRef: { sourceType: "adjustment_patch", sourceId: entry.patchId },
      sourceVersion: input.sourceVersion,
      ruleSetVersion: input.ruleSetVersion,
      before: entry.before,
      operation: executable.operation,
      operand: executable.operand,
      after: canonicalAfter,
      ...(definition?.unit ? { unit: definition.unit } : {}),
      effect: effectFor(definition, entry.before, canonicalAfter),
      warningIssueIds: [],
      actions: [],
      evidence: {
        adapter: "patch_trace/v1",
        patchId: entry.patchId,
        scope: entry.scope,
        scopeId: entry.scopeId,
        path: entry.path,
        operation: entry.operation,
        ...(entry.before !== undefined ? { before: structuredClone(entry.before) } : {}),
        ...(entry.operand !== undefined ? { operand: structuredClone(entry.operand) } : {}),
        ...(entry.after !== undefined ? { after: structuredClone(entry.after) } : {}),
        ...(legacyUndefinedFields.length ? { legacyUndefinedFields } : {}),
      },
    });
  });
}

export function adaptLegacyCalculationTraceToCanonical(input: {
  trace: CalculationTraceItem[];
  subjectRef: EntityRef;
  sourceVersion: string;
  ruleSetVersion: string;
  parameterDefinitions?: ParameterDefinition[];
  sequenceStart?: number;
}): CalculationTraceEntry[] {
  const definitions = parameterMap(input.parameterDefinitions);
  let sequence = input.sequenceStart ?? 1;
  return input.trace.map((entry) => {
    const definition = definitions.get(entry.parameterKey);
    const executable = executableOperation(
      entry.operation,
      entry.before,
      entry.operand,
      entry.after,
    );
    return createCalculationTraceEntry({
      subjectRef: input.subjectRef,
      parameterKey: entry.parameterKey,
      sequence: sequence++,
      layer: canonicalLayer(entry.layer),
      sourceRef: { sourceType: "legacy_trace_source", sourceId: entry.source },
      sourceVersion: input.sourceVersion,
      ruleSetVersion: input.ruleSetVersion,
      before: entry.before,
      operation: executable.operation,
      operand: executable.operand,
      after: entry.after,
      ...(definition?.unit ? { unit: definition.unit } : {}),
      effect: effectFor(definition, entry.before, entry.after),
      warningIssueIds: [],
      actions: [],
      evidence: { adapter: "legacy_calculation_trace/v1", ...entry },
    });
  });
}

export interface LegacyUnifiedTraceEntry {
  traceEntryId: string;
  subjectRef: EntityRef;
  parameterKey: string;
  sequence: number;
  layer: string;
  sourceVersion: string;
  ruleSetVersion: string;
  before: unknown;
  operation: "set" | "add" | "multiply" | "no_effect";
  operand: unknown;
  after: unknown;
  inputHash: string;
  outputHash: string;
}

export function adaptLegacyUnifiedTraceToCanonical(
  entries: LegacyUnifiedTraceEntry[],
): CalculationTraceEntry[] {
  return [...entries]
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => createCalculationTraceEntry({
      traceEntryId: entry.traceEntryId,
      subjectRef: entry.subjectRef,
      parameterKey: entry.parameterKey,
      sequence: entry.sequence,
      layer: canonicalLayer(entry.layer),
      sourceRef: { sourceType: "legacy_unified_trace", sourceId: entry.traceEntryId },
      sourceVersion: entry.sourceVersion,
      ruleSetVersion: entry.ruleSetVersion,
      before: entry.before,
      operation: entry.operation,
      operand: entry.operand,
      after: entry.after,
      effect: sameValue(entry.before, entry.after) ? "neutral" : "contextual",
      warningIssueIds: [],
      actions: [],
      evidence: {
        adapter: "legacy_unified_trace/v1",
        legacyInputHash: entry.inputHash,
        legacyOutputHash: entry.outputHash,
        legacySequence: entry.sequence,
      },
    }));
}
