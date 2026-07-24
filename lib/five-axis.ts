import { deterministicHash } from "./rule-kernel";
import { jcsSha256Hex } from "./canonical-json";
import { validationIssueLevel } from "./validation-issues";
import type {
  FiveAxisAxisDefinition,
  FiveAxisAxisSummary,
  FiveAxisComparisonView,
  FiveAxisEntityInput,
  FiveAxisMetric,
  FiveAxisSeries,
  FiveAxisSeriesPoint,
  FiveAxisTraceEntry,
  FiveAxisVertexSet,
  FiveAxisViewDefinition,
  FiveAxisDefinitionDisposition,
  FiveAxisDefinitionDispositionCatalogRevision,
  ModelFiveAxisPreview,
  ValidationIssue,
} from "./types";

const FORMAL_SEMANTIC_CONTRACT = "five-axis/open005-2026-07-23/v1" as const;
const FORMAL_HASH_INPUT_SCHEMA = "five-axis-hash-input/v1" as const;
const FORMAL_PROJECTION_SELECTOR = "projection-reference/current-sku-frozen-match/v1" as const;

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

export function orderedFiveAxisDispositionEntries(entries: FiveAxisDefinitionDisposition[]): FiveAxisDefinitionDisposition[] {
  return [...entries].sort((left, right) => compareUtf8(left.definitionId, right.definitionId)
    || compareUtf8(left.definitionVersion, right.definitionVersion));
}

/** Revision identity and decision time are intentionally outside the closed hash input. */
export function fiveAxisDispositionCatalogHash(input: {
  schemaVersion: FiveAxisDefinitionDispositionCatalogRevision["schemaVersion"];
  previousCatalogHash: string | null;
  entries: FiveAxisDefinitionDisposition[];
}): string {
  return jcsSha256Hex({
    schemaVersion: input.schemaVersion,
    previousCatalogHash: input.previousCatalogHash,
    entries: orderedFiveAxisDispositionEntries(input.entries).map((entry) => ({
      definitionId: entry.definitionId, definitionVersion: entry.definitionVersion, definitionHash: entry.definitionHash,
      effectiveUse: entry.effectiveUse, semanticContractVersion: entry.semanticContractVersion,
      supersededByDefinitionId: entry.supersededByDefinitionId,
      supersededByDefinitionVersion: entry.supersededByDefinitionVersion, reasonCode: entry.reasonCode,
    })),
  });
}

export function isOpen005FormalDefinition(definition: FiveAxisViewDefinition): boolean {
  return definition.semanticContractVersion === FORMAL_SEMANTIC_CONTRACT
    && definition.hashInputSchemaVersion === FORMAL_HASH_INPUT_SCHEMA
    && definition.projectionReferenceSelectorVersion === FORMAL_PROJECTION_SELECTOR
    && validateOpen005FormalDefinition(definition).length === 0;
}

const FORMAL_AXES = [
  ["pull", "drag", "higher_better", "max"],
  ["durability", "durability", "higher_better", "max"],
  ["cast", "max_cast_distance", "higher_better", "max"],
  ["sensitivity", "sensitivity", "lower_better", "min"],
  ["control", "energy_cost_factor", "lower_better", "min"],
] as const;
const FORMAL_PARTS = ["part:rod", "part:reel", "part:line"];

/** Exact OPEN-005 shape check for admission to FORMAL_CURRENT; legacy definitions remain readable. */
export function validateOpen005FormalDefinition(definition: FiveAxisViewDefinition): string[] {
  const errors: string[] = [];
  if (!definition.weightBandPolicyVersion || !definition.displayBandConfigId) errors.push("weight-band/display policy missing");
  if (definition.axes.length !== 5) errors.push("axis count");
  for (const [index, [axisId, parameterKey, direction, selector]] of FORMAL_AXES.entries()) {
    const axis = definition.axes[index];
    if (!axis || axis.axisId !== axisId || axis.order !== index + 1
      || axis.sourceParameterKeys.length !== 1 || axis.sourceParameterKeys[0] !== parameterKey
      || axis.direction !== direction || axis.transformId !== "identity"
      || axis.vertexSelectorId !== selector || axis.componentAggregationId !== "per_component_no_aggregate") {
      errors.push(`axis:${axisId}`);
      continue;
    }
    const expectedParts = axisId === "cast" ? ["part:rod"] : FORMAL_PARTS;
    if (axis.applicablePartIds.length !== expectedParts.length
      || expectedParts.some((part, partIndex) => axis.applicablePartIds[partIndex] !== part)) errors.push(`parts:${axisId}`);
    if ((axisId === "cast" && (axis.contextInheritanceId !== "single_applicable_source" || axis.missingPolicy !== "ignore_not_applicable"))
      || (axisId !== "cast" && axis.missingPolicy !== "error")) errors.push(`missing:${axisId}`);
  }
  const baseline = definition.seriesBaselinePolicy;
  if (baseline.mode !== "projection_reference" || baseline.selectorVersion !== FORMAL_PROJECTION_SELECTOR) errors.push("baseline");
  const comparison = definition.comparisonPolicy;
  if (!comparison || comparison.minimumItems !== 2 || !Number.isInteger(comparison.maximumItems)
    || comparison.maximumItems < comparison.minimumItems || !comparison.mixedItemPartsAllowed
    || comparison.referenceRodMode !== "first_rod_by_comparison_order"
    || comparison.outerRingScore !== 100 || comparison.visualOverflowCap !== null) errors.push("comparison");
  return errors;
}

export interface ResolvedFormalFiveAxisDefinition {
  definition: FiveAxisViewDefinition;
  catalog: FiveAxisDefinitionDispositionCatalogRevision;
  disposition: FiveAxisDefinitionDisposition;
}

export function formalProjectionReferenceSetHash(input: {
  anchor: NonNullable<ModelFiveAxisPreview["projectionReferenceAnchor"]>;
  references: NonNullable<ModelFiveAxisPreview["projectionReferences"]>;
}): string {
  return jcsSha256Hex({ schemaVersion: "five-axis-hash-input/v1", kind: "projection_reference_set",
    selectorVersion: "projection-reference/current-sku-frozen-match/v1",
    anchor: { baselineSnapshotId: input.anchor.baselineSnapshotId, seriesId: input.anchor.seriesId, skuId: input.anchor.skuId, skuRevisionId: input.anchor.skuRevisionId },
    references: input.references.map((reference) => ({ itemPartId: reference.itemPartId, state: reference.state,
      projectionMatchId: reference.projectionMatchId, projectionMatchRevisionId: reference.projectionMatchRevisionId,
      projectionId: reference.projectionId, projectionRevisionId: reference.projectionRevisionId })), });
}

export function formalFiveAxisPreviewInputHash(preview: ModelFiveAxisPreview): string {
  return jcsSha256Hex({ schemaVersion: "five-axis-hash-input/v1", kind: "five_axis_preview_input",
    modelId: preview.modelId, modelRevision: preview.modelRevision, finalPanelHash: preview.finalPanelHash,
    componentInputs: preview.componentInputs, fiveAxisDefinitionId: preview.fiveAxisDefinitionId,
    fiveAxisDefinitionVersion: preview.fiveAxisDefinitionVersion, fiveAxisDefinitionRevision: preview.fiveAxisDefinitionRevision,
    fiveAxisDefinitionHash: preview.fiveAxisDefinitionHash, fiveAxisRuleVersion: preview.fiveAxisRuleVersion,
    vertexSetHash: preview.vertexSetHash, sourceRevision: preview.sourceRevision,
    projectionReferenceSetHash: preview.projectionReferenceSetHash });
}

export function validateFiveAxisDispositionCatalogChain(input: {
  definitions: FiveAxisViewDefinition[];
  catalogRevisions: FiveAxisDefinitionDispositionCatalogRevision[];
  currentCatalogRevisionId?: string;
}): void {
  const unavailable = (): never => { throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE"); };
  if (!input.currentCatalogRevisionId) unavailable();
  const definitionsByIdentity = new Map<string, FiveAxisViewDefinition>();
  for (const definition of input.definitions) {
    const key = `${definition.definitionId}\u0000${definition.version}`;
    if (definitionsByIdentity.has(key)) unavailable();
    definitionsByIdentity.set(key, definition);
  }
  const ids = new Set<string>();
  const byId = new Map<string, FiveAxisDefinitionDispositionCatalogRevision>();
  for (const catalog of input.catalogRevisions) {
    if (ids.has(catalog.catalogRevisionId)) unavailable(); ids.add(catalog.catalogRevisionId); byId.set(catalog.catalogRevisionId, catalog);
  }
  let cursor = byId.get(input.currentCatalogRevisionId!); if (!cursor) unavailable();
  const visited = new Set<string>();
  while (cursor) {
    const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
    const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    const utcMillis = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
    if (visited.has(cursor.catalogRevisionId) || cursor.schemaVersion !== "five-axis-definition-disposition-catalog/v1"
      || !exactKeys(cursor, ["catalogRevisionId", "previousCatalogRevisionId", "previousCatalogHash", "schemaVersion", "entries", "catalogHash", "decidedAt"])
      || !nonEmpty(cursor.catalogRevisionId) || !hash(cursor.catalogHash) || !utcMillis(cursor.decidedAt)
      || !Array.isArray(cursor.entries)
      || (cursor.previousCatalogRevisionId !== null && !nonEmpty(cursor.previousCatalogRevisionId))
      || (cursor.previousCatalogHash !== null && !hash(cursor.previousCatalogHash))
      || cursor.catalogHash !== fiveAxisDispositionCatalogHash(cursor)) unavailable();
    visited.add(cursor.catalogRevisionId);
    const sorted = orderedFiveAxisDispositionEntries(cursor.entries);
    const entryIds = new Set<string>(); let formal = 0;
    for (let index = 0; index < sorted.length; index += 1) {
      const entry = sorted[index]!; if (entry !== cursor.entries[index]) unavailable();
      if (!exactKeys(entry, ["definitionId", "definitionVersion", "definitionHash", "effectiveUse", "semanticContractVersion", "supersededByDefinitionId", "supersededByDefinitionVersion", "reasonCode"])) unavailable();
      if (!nonEmpty(entry.definitionId) || !nonEmpty(entry.definitionVersion) || !nonEmpty(entry.definitionHash)
        || !nonEmpty(entry.reasonCode)
        || (entry.semanticContractVersion !== null && entry.semanticContractVersion !== FORMAL_SEMANTIC_CONTRACT)
        || (entry.supersededByDefinitionId !== null && !nonEmpty(entry.supersededByDefinitionId))
        || (entry.supersededByDefinitionVersion !== null && !nonEmpty(entry.supersededByDefinitionVersion))) unavailable();
      const key = `${entry.definitionId}\u0000${entry.definitionVersion}`;
      if (entryIds.has(key) || definitionsByIdentity.get(key)?.definitionHash !== entry.definitionHash) unavailable();
      entryIds.add(key); if (entry.effectiveUse === "FORMAL_CURRENT") formal += 1;
      if (!["LEGACY_SNAPSHOT_ONLY", "FORMAL_CURRENT", "SUPERSEDED"].includes(entry.effectiveUse)
        || (entry.effectiveUse === "FORMAL_CURRENT" && entry.semanticContractVersion !== FORMAL_SEMANTIC_CONTRACT)
        || (entry.effectiveUse === "LEGACY_SNAPSHOT_ONLY" && entry.semanticContractVersion !== null)
        || ((entry.supersededByDefinitionId === null) !== (entry.supersededByDefinitionVersion === null))
        || (entry.effectiveUse === "SUPERSEDED" && (entry.supersededByDefinitionId === null || entry.supersededByDefinitionVersion === null))
        || (entry.effectiveUse !== "SUPERSEDED" && (entry.supersededByDefinitionId !== null || entry.supersededByDefinitionVersion !== null))) unavailable();
    }
    if (formal > 1 || (cursor.previousCatalogRevisionId === null) !== (cursor.previousCatalogHash === null)) unavailable();
    if (!cursor.previousCatalogRevisionId) break;
    const previous = byId.get(cursor.previousCatalogRevisionId);
    if (!previous || previous.catalogHash !== cursor.previousCatalogHash) unavailable(); cursor = previous;
  }
}

/** Only the explicit immutable catalog head can authorize a new formal snapshot. */
export function resolveFormalFiveAxisDefinition(input: {
  definitions: FiveAxisViewDefinition[];
  catalogRevisions: FiveAxisDefinitionDispositionCatalogRevision[];
  currentCatalogRevisionId?: string;
  definitionId: string;
  definitionVersion: string;
}): ResolvedFormalFiveAxisDefinition {
  const unavailable = (): never => { throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE"); };
  if (!input.currentCatalogRevisionId) unavailable();
  validateFiveAxisDispositionCatalogChain(input);
  const revisionIds = new Set<string>();
  for (const candidate of input.catalogRevisions) {
    if (revisionIds.has(candidate.catalogRevisionId)) unavailable();
    revisionIds.add(candidate.catalogRevisionId);
  }
  const catalogs = input.catalogRevisions.filter((catalog) => catalog.catalogRevisionId === input.currentCatalogRevisionId);
  if (catalogs.length !== 1) unavailable();
  const catalog = catalogs[0]!;
  const byId = new Map(input.catalogRevisions.map((candidate) => [candidate.catalogRevisionId, candidate]));
  const definitionsByIdentity = new Map<string, FiveAxisViewDefinition>();
  for (const definition of input.definitions) {
    const key = `${definition.definitionId}\u0000${definition.version}`;
    if (definitionsByIdentity.has(key)) unavailable();
    definitionsByIdentity.set(key, definition);
  }
  const visited = new Set<string>();
  let cursor: FiveAxisDefinitionDispositionCatalogRevision | undefined = catalog;
  while (cursor) {
    if (visited.has(cursor.catalogRevisionId)
      || cursor.schemaVersion !== "five-axis-definition-disposition-catalog/v1"
      || cursor.catalogHash !== fiveAxisDispositionCatalogHash(cursor)) unavailable();
    visited.add(cursor.catalogRevisionId);
    const sorted = orderedFiveAxisDispositionEntries(cursor.entries);
    if (sorted.some((entry, index) => entry !== cursor!.entries[index])) unavailable();
    const entryIds = new Set<string>();
    let formalCount = 0;
    for (const entry of cursor.entries) {
      const key = `${entry.definitionId}\u0000${entry.definitionVersion}`;
      if (entryIds.has(key) || definitionsByIdentity.get(key)?.definitionHash !== entry.definitionHash) unavailable();
      entryIds.add(key);
      if (entry.effectiveUse === "FORMAL_CURRENT") formalCount += 1;
    }
    if (formalCount > 1) unavailable();
    const hasPreviousId = cursor.previousCatalogRevisionId !== null;
    const hasPreviousHash = cursor.previousCatalogHash !== null;
    if (hasPreviousId !== hasPreviousHash) unavailable();
    if (!hasPreviousId) break;
    const previous = byId.get(cursor.previousCatalogRevisionId!);
    if (!previous || previous.catalogHash !== cursor.previousCatalogHash) unavailable();
    cursor = previous;
  }
  const identities = new Set<string>();
  for (const entry of catalog.entries) {
    const key = `${entry.definitionId}\u0000${entry.definitionVersion}`;
    if (identities.has(key)) unavailable();
    identities.add(key);
  }
  const formal = catalog.entries.filter((entry) => entry.effectiveUse === "FORMAL_CURRENT");
  if (formal.length !== 1) unavailable();
  const disposition = formal[0]!;
  if (disposition.definitionId !== input.definitionId || disposition.definitionVersion !== input.definitionVersion
    || disposition.semanticContractVersion !== FORMAL_SEMANTIC_CONTRACT) unavailable();
  const definition = definitionsByIdentity.get(`${disposition.definitionId}\u0000${disposition.definitionVersion}`);
  if (!definition) unavailable();
  const resolvedDefinition = definition!;
  if (resolvedDefinition.definitionHash !== disposition.definitionHash || !isOpen005FormalDefinition(resolvedDefinition)) unavailable();
  return { definition: resolvedDefinition, catalog, disposition };
}

export function fiveAxisPlotRatio(score: number | null, maxScore = 100): number | null {
  if (score === null || !Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    return null;
  }
  return Math.max(0, Math.min(maxScore, score)) / maxScore;
}

const PRECISION = 12;

function round(value: number, precision = PRECISION): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function orderedAxes(definition: FiveAxisViewDefinition): FiveAxisAxisDefinition[] {
  return [...definition.axes].sort((left, right) =>
    left.order - right.order || left.axisId.localeCompare(right.axisId),
  );
}

export function validateFiveAxisDefinition(
  definition: FiveAxisViewDefinition,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (definition.axes.length !== 5) {
    issues.push({
      level: "error",
      code: "FIVE_AXIS_COUNT_INVALID",
      message: "五轴定义必须且只能包含五个轴。",
    });
  }
  const axisIds = definition.axes.map((axis) => axis.axisId);
  if (new Set(axisIds).size !== axisIds.length) {
    issues.push({
      level: "error",
      code: "FIVE_AXIS_ID_DUPLICATED",
      message: "五轴定义存在重复 axisId。",
    });
  }
  const orders = definition.axes.map((axis) => axis.order);
  if (new Set(orders).size !== orders.length) {
    issues.push({
      level: "error",
      code: "FIVE_AXIS_ORDER_DUPLICATED",
      message: "五轴定义存在重复顺序。",
    });
  }
  for (const axis of definition.axes) {
    if (!axis.sourceParameterKeys.length) {
      issues.push({
        level: "error",
        code: "FIVE_AXIS_SOURCE_EMPTY",
        message: `轴 ${axis.axisId} 未配置输入参数。`,
      });
    }
    if (!axis.applicablePartIds.length) {
      issues.push({
        level: "error",
        code: "FIVE_AXIS_PARTS_EMPTY",
        message: `轴 ${axis.axisId} 未配置适用部件。`,
      });
    }
    if (axis.componentAggregationId !== "component_min_ratio" && axis.componentAggregationId !== "per_component_no_aggregate") {
      issues.push({
        level: "error",
        code: "FIVE_AXIS_AGGREGATION_UNSUPPORTED",
        message: `暂不支持五轴聚合器 ${axis.componentAggregationId}。`,
      });
    }
  }
  return issues;
}

export interface FiveAxisDisplayBand {
  id: string;
  min: number;
  max: number;
  includeMax?: boolean;
}

export function validateFiveAxisDisplayBands(
  bands: FiveAxisDisplayBand[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sorted = [...bands].sort((left, right) => left.min - right.min);
  for (const band of sorted) {
    if (
      !Number.isFinite(band.min) ||
      !Number.isFinite(band.max) ||
      band.min < 0 ||
      band.max > 100 ||
      band.min >= band.max
    ) {
      issues.push({
        level: "warning",
        code: "FIVE_AXIS_BAND_OUT_OF_RANGE",
        message: `档位 ${band.id} 的范围 ${band.min}..${band.max} 不符合 0..100 规则，需人工确认。`,
      });
    }
  }
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (current.max !== next.min) {
      issues.push({
        level: "error",
        code: "FIVE_AXIS_BAND_GAP_OR_OVERLAP",
        message: `档位 ${current.id} 与 ${next.id} 之间存在空洞或重叠。`,
      });
    }
    if (current.includeMax) {
      issues.push({
        level: "error",
        code: "FIVE_AXIS_BAND_BOUNDARY_AMBIGUOUS",
        message: `档位 ${current.id} 的上边界与下一档归属冲突。`,
      });
    }
  }
  if (
    sorted.length &&
    (sorted[0].min !== 0 ||
      sorted[sorted.length - 1].max !== 100 ||
      !sorted[sorted.length - 1].includeMax)
  ) {
    issues.push({
      level: "error",
      code: "FIVE_AXIS_BAND_COVERAGE_INVALID",
      message: "五轴档位必须无空洞覆盖 0..100，且 100 仅归属最后一档。",
    });
  }
  return issues;
}

interface AxisValueResult {
  value: number | null;
  source: FiveAxisSeriesPoint["source"];
  trace: FiveAxisTraceEntry[];
  issue?: ValidationIssue;
}

function readAxisValue(
  axis: FiveAxisAxisDefinition,
  input: FiveAxisEntityInput,
): AxisValueResult {
  if (!axis.applicablePartIds.includes(input.itemPartId)) {
    return {
      value: null,
      source: "not_applicable",
      trace: [{
        step: "applicability",
        message: `${input.itemPartId} 不适用于轴 ${axis.axisId}。`,
      }],
    };
  }
  const sourceValues = axis.sourceParameterKeys.map((key) => input.values[key]);
  const missingKeys = axis.sourceParameterKeys.filter(
    (_key, index) => sourceValues[index] === null || sourceValues[index] === undefined,
  );
  if (missingKeys.length) {
    const isError = axis.missingPolicy === "error";
    return {
      value: null,
      source: isError ? "error" : "missing",
      trace: [{
        step: "input",
        message: `缺少输入：${missingKeys.join("、")}。`,
      }],
      issue: {
        level: isError ? "error" : "warning",
        code: isError ? "FIVE_AXIS_INPUT_MISSING" : "FIVE_AXIS_INPUT_UNAVAILABLE",
        message: `${input.label} 的 ${axis.label} 缺少输入：${missingKeys.join("、")}。`,
        parameterKey: missingKeys[0],
      },
    };
  }
  const numbers = sourceValues.map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) {
    return {
      value: null,
      source: "error",
      trace: [{ step: "input", message: "输入不是有限数字。" }],
      issue: {
        level: "error",
        code: "FIVE_AXIS_INPUT_NOT_FINITE",
        message: `${input.label} 的 ${axis.label} 输入不是有限数字。`,
      },
    };
  }

  let value: number;
  if (axis.transformId === "identity") {
    if (numbers.length !== 1) {
      return {
        value: null,
        source: "error",
        trace: [{ step: "transform", message: "identity 变换只接受一个输入。" }],
        issue: {
          level: "error",
          code: "FIVE_AXIS_TRANSFORM_INPUT_INVALID",
          message: `轴 ${axis.axisId} 的 identity 变换输入数量不正确。`,
        },
      };
    }
    value = numbers[0];
  } else if (axis.transformId === "sum") {
    value = numbers.reduce((total, entry) => total + entry, 0);
  } else if (axis.transformId === "reciprocal") {
    const denominator = numbers.reduce((total, entry) => total + entry, 0);
    if (denominator <= 0) {
      return {
        value: null,
        source: "error",
        trace: [{ step: "transform", message: "倒数分母必须大于 0。", value: denominator }],
        issue: {
          level: "error",
          code: "FIVE_AXIS_RECIPROCAL_DENOMINATOR_INVALID",
          message: `${input.label} 的 ${axis.label} 倒数分母必须大于 0。`,
        },
      };
    }
    value = 1 / denominator;
  } else {
    return {
      value: null,
      source: "error",
      trace: [{ step: "transform", message: `未知变换器 ${axis.transformId}。` }],
      issue: {
        level: "error",
        code: "FIVE_AXIS_TRANSFORM_UNKNOWN",
        message: `轴 ${axis.axisId} 引用了未知变换器 ${axis.transformId}。`,
      },
    };
  }
  if (!Number.isFinite(value)) {
    return {
      value: null,
      source: "error",
      trace: [{ step: "transform", message: "变换结果不是有限数字。" }],
      issue: {
        level: "error",
        code: "FIVE_AXIS_TRANSFORM_RESULT_INVALID",
        message: `${input.label} 的 ${axis.label} 变换结果无效。`,
      },
    };
  }
  return {
    value: round(value),
    source: "direct",
    trace: [
      {
        step: "input",
        message: axis.sourceParameterKeys
          .map((key, index) => `${key}=${numbers[index]}`)
          .join("，"),
      },
      { step: "transform", message: axis.transformId, value: round(value) },
    ],
  };
}

function assertUsableDefinition(definition: FiveAxisViewDefinition): void {
  const errors = validateFiveAxisDefinition(definition).filter(
    (issue) => validationIssueLevel(issue) === "error",
  );
  if (errors.length) {
    throw new Error(errors.map((issue) => issue.message).join("；"));
  }
}

export function createFiveAxisVertexSet(input: {
  definition: FiveAxisViewDefinition;
  fishWeightGradeId: string;
  referenceComponents: FiveAxisEntityInput[];
}): FiveAxisVertexSet {
  assertUsableDefinition(input.definition);
  const values: Record<string, number> = {};
  for (const axis of orderedAxes(input.definition)) {
    const candidates = input.referenceComponents
      .map((component) => readAxisValue(axis, component))
      .filter((entry) => entry.source === "direct" && entry.value !== null)
      .map((entry) => entry.value as number);
    if (!candidates.length) {
      throw new Error(`轴 ${axis.axisId} 无法生成顶点：没有有效参考值。`);
    }
    if (axis.vertexSelectorId === "max") {
      values[axis.axisId] = Math.max(...candidates);
    } else if (axis.vertexSelectorId === "min") {
      values[axis.axisId] = Math.min(...candidates);
    } else {
      throw new Error(`未知顶点选择器 ${axis.vertexSelectorId}。`);
    }
  }
  const content = {
    fishWeightGradeId: input.fishWeightGradeId,
    fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
    definitionId: input.definition.definitionId,
    definitionVersion: input.definition.version,
    values,
  };
  return {
    ...content,
    vertexSetHash: deterministicHash(content),
  };
}

function assertVertexSetMatches(
  definition: FiveAxisViewDefinition,
  vertexSet: FiveAxisVertexSet,
  referenceFishWeightGradeId: string,
): void {
  if (
    vertexSet.definitionId !== definition.definitionId ||
    vertexSet.definitionVersion !== definition.version ||
    vertexSet.fiveAxisRuleVersion !== definition.fiveAxisRuleVersion ||
    vertexSet.fishWeightGradeId !== referenceFishWeightGradeId
  ) {
    throw new Error("五轴定义、规则版本或共同鱼重等级与顶点集合不一致。");
  }
  const content = {
    fishWeightGradeId: vertexSet.fishWeightGradeId,
    fiveAxisRuleVersion: vertexSet.fiveAxisRuleVersion,
    definitionId: vertexSet.definitionId,
    definitionVersion: vertexSet.definitionVersion,
    values: vertexSet.values,
  };
  if (deterministicHash(content) !== vertexSet.vertexSetHash) {
    throw new Error("五轴顶点集合完整性校验失败。");
  }
}

function pointFor(
  axis: FiveAxisAxisDefinition,
  definition: FiveAxisViewDefinition,
  input: FiveAxisEntityInput,
  vertexSet: FiveAxisVertexSet,
): { point: FiveAxisSeriesPoint; issue?: ValidationIssue } {
  const read = readAxisValue(axis, input);
  const base = {
    axisId: axis.axisId,
    axisDefinitionVersion: definition.version,
    rawValue: read.value,
    vertexValue: vertexSet.values[axis.axisId] ?? null,
    unclampedRatio: null,
    normalizedRatio: null,
    officialDisplayScore: null,
    comparisonScore: null,
    overflow: null,
    source: read.source,
    participatesInRanking: read.source === "direct",
    trace: read.trace,
  } satisfies FiveAxisSeriesPoint;
  if (read.source !== "direct" || read.value === null) {
    return { point: base, issue: read.issue };
  }
  const vertex = vertexSet.values[axis.axisId];
  if (!Number.isFinite(vertex) || vertex <= 0 || read.value <= 0) {
    const message = `${input.label} 的 ${axis.label} 原始值或顶点必须大于 0。`;
    return {
      point: {
        ...base,
        source: "error",
        participatesInRanking: false,
        trace: [...base.trace, { step: "ratio", message }],
      },
      issue: {
        level: "error",
        code: "FIVE_AXIS_RATIO_INPUT_INVALID",
        message,
      },
    };
  }
  if (axis.direction === "target_range" || axis.direction === "contextual") {
    const message = `轴 ${axis.axisId} 的方向 ${axis.direction} 尚未注册比值算法。`;
    return {
      point: {
        ...base,
        source: "error",
        participatesInRanking: false,
        trace: [...base.trace, { step: "ratio", message }],
      },
      issue: {
        level: "error",
        code: "FIVE_AXIS_DIRECTION_UNSUPPORTED",
        message,
      },
    };
  }
  const ratio = axis.direction === "higher_better"
    ? read.value / vertex
    : vertex / read.value;
  const normalized = clamp01(ratio);
  const comparisonScore = round(ratio * 100);
  return {
    point: {
      ...base,
      unclampedRatio: round(ratio),
      normalizedRatio: round(normalized),
      officialDisplayScore: Math.round(normalized * 100),
      comparisonScore,
      overflow: round(Math.max(comparisonScore - 100, 0)),
      trace: [
        ...base.trace,
        { step: "vertex", message: "共同鱼重等级顶点", value: vertex },
        { step: "ratio", message: axis.direction, value: round(ratio) },
      ],
    },
  };
}

function seriesFor(
  definition: FiveAxisViewDefinition,
  vertexSet: FiveAxisVertexSet,
  input: FiveAxisEntityInput,
): { series: FiveAxisSeries; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const points = orderedAxes(definition).map((axis) => {
    const result = pointFor(axis, definition, input, vertexSet);
    if (result.issue) issues.push(result.issue);
    return result.point;
  });
  return {
    series: {
      entityId: input.entityId,
      itemPartId: input.itemPartId,
      label: input.label,
      fishWeightGradeId: input.fishWeightGradeId,
      points,
    },
    issues,
  };
}

function inheritContextPoints(
  definition: FiveAxisViewDefinition,
  series: FiveAxisSeries[],
  contextSeries: FiveAxisSeries,
): FiveAxisSeries[] {
  return series.map((entry) => ({
    ...entry,
    points: entry.points.map((point) => {
      const axis = definition.axes.find((candidate) => candidate.axisId === point.axisId)!;
      if (
        point.source !== "not_applicable" ||
        axis.contextInheritanceId !== "single_applicable_source"
      ) {
        return point;
      }
      const contextPoint = contextSeries.points.find(
        (candidate) => candidate.axisId === point.axisId,
      );
      if (!contextPoint || contextPoint.source !== "direct") return point;
      return {
        ...structuredClone(contextPoint),
        source: "context_inherited" as const,
        participatesInRanking: false,
        trace: [
          ...structuredClone(contextPoint.trace),
          {
            step: "context",
            message: `继承自 ${contextSeries.label}；不代表当前部件具有该参数，也不参与排名。`,
          },
        ],
      };
    }),
  }));
}

function axisSummaries(
  definition: FiveAxisViewDefinition,
  series: FiveAxisSeries[],
): FiveAxisAxisSummary[] {
  return orderedAxes(definition).map((axis) => {
    const ranked = series
      .map((entry) => ({
        entityId: entry.entityId,
        point: entry.points.find((point) => point.axisId === axis.axisId),
      }))
      .filter(
        (entry): entry is { entityId: string; point: FiveAxisSeriesPoint } =>
          Boolean(
            entry.point?.participatesInRanking &&
            entry.point.unclampedRatio !== null,
          ),
      );
    if (!ranked.length) {
      return {
        axisId: axis.axisId,
        strongestEntityIds: [],
        weakestEntityIds: [],
        spread: null,
      };
    }
    const values = ranked.map((entry) => entry.point.unclampedRatio as number);
    const max = Math.max(...values);
    const min = Math.min(...values);
    return {
      axisId: axis.axisId,
      strongestEntityIds: ranked
        .filter((entry) => entry.point.unclampedRatio === max)
        .map((entry) => entry.entityId),
      weakestEntityIds: ranked
        .filter((entry) => entry.point.unclampedRatio === min)
        .map((entry) => entry.entityId),
      spread: round(max - min),
    };
  });
}

function modelSummarySeries(
  modelId: string,
  fishWeightGradeId: string,
  definition: FiveAxisViewDefinition,
  componentSeries: FiveAxisSeries[],
): FiveAxisSeries {
  return {
    entityId: modelId,
    itemPartId: "model_summary",
    label: "Model 短板汇总",
    fishWeightGradeId,
    points: orderedAxes(definition).map((axis) => {
      const candidates = componentSeries
        .map((entry) => entry.points.find((point) => point.axisId === axis.axisId))
        .filter(
          (point): point is FiveAxisSeriesPoint =>
            Boolean(point?.source === "direct"),
        );
      const invalid = candidates.find(
        (point) => point.unclampedRatio === null,
      );
      if (invalid || !candidates.length) {
        return {
          axisId: axis.axisId,
          axisDefinitionVersion: definition.version,
          rawValue: null,
          vertexValue: invalid?.vertexValue ?? null,
          unclampedRatio: null,
          normalizedRatio: null,
          officialDisplayScore: null,
          comparisonScore: null,
          overflow: null,
          source: invalid?.source ?? "not_applicable",
          participatesInRanking: false,
          trace: [{ step: "aggregate", message: "没有可用于短板汇总的直接点。" }],
        };
      }
      const weakest = candidates.reduce((current, candidate) =>
        (candidate.unclampedRatio as number) < (current.unclampedRatio as number)
          ? candidate
          : current,
      );
      return {
        ...structuredClone(weakest),
        rawValue: weakest.rawValue,
        participatesInRanking: false,
        trace: [
          ...structuredClone(weakest.trace),
          {
            step: "aggregate",
            message: "component_min_ratio 选择适用部件中的最小未截断占比。",
            value: weakest.unclampedRatio,
          },
        ],
      };
    }),
  };
}

export function buildTackleFitComparison(input: {
  modelId: string;
  referenceFishWeightGradeId: string;
  definition: FiveAxisViewDefinition;
  vertexSet: FiveAxisVertexSet;
  components: FiveAxisEntityInput[];
  scaleMode?: FiveAxisComparisonView["scaleMode"];
}): FiveAxisComparisonView {
  assertUsableDefinition(input.definition);
  assertVertexSetMatches(
    input.definition,
    input.vertexSet,
    input.referenceFishWeightGradeId,
  );
  const calculated = input.components.map((component) =>
    seriesFor(input.definition, input.vertexSet, component),
  );
  const directSeries = calculated.map((entry) => entry.series);
  const contextSeries = directSeries.find((series) =>
    input.definition.axes.some((axis) =>
      axis.contextInheritanceId === "single_applicable_source" &&
      series.points.some(
        (point) => point.axisId === axis.axisId && point.source === "direct",
      ),
    ),
  );
  const inheritedSeries = contextSeries
    ? inheritContextPoints(input.definition, directSeries, contextSeries)
    : directSeries;
  const summary = modelSummarySeries(
    input.modelId,
    input.referenceFishWeightGradeId,
    input.definition,
    directSeries,
  );
  return {
    mode: "tackle_fit",
    referenceFishWeightGradeId: input.referenceFishWeightGradeId,
    fiveAxisDefinitionId: input.definition.definitionId,
    fiveAxisDefinitionVersion: input.definition.version,
    fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
    vertexSetHash: input.vertexSet.vertexSetHash,
    scaleMode: input.scaleMode ?? "official_locked",
    series: [...inheritedSeries, summary],
    axisSummaries: axisSummaries(input.definition, directSeries),
    validationIssues: calculated.flatMap((entry) => entry.issues),
  };
}

export function buildSamePartComparison(input: {
  referenceFishWeightGradeId: string;
  definition: FiveAxisViewDefinition;
  vertexSet: FiveAxisVertexSet;
  entities: FiveAxisEntityInput[];
  referenceContext?: FiveAxisEntityInput;
  comparisonLimit?: number;
  scaleMode?: FiveAxisComparisonView["scaleMode"];
}): FiveAxisComparisonView {
  assertUsableDefinition(input.definition);
  assertVertexSetMatches(
    input.definition,
    input.vertexSet,
    input.referenceFishWeightGradeId,
  );
  if (!input.entities.length) throw new Error("同部位比较至少需要一个对象。");
  if (
    input.comparisonLimit !== undefined &&
    input.entities.length > input.comparisonLimit
  ) {
    throw new Error(`比较对象超过当前策略上限 ${input.comparisonLimit}。`);
  }
  const partIds = new Set(input.entities.map((entry) => entry.itemPartId));
  if (partIds.size !== 1) {
    throw new Error("同部位比较不能混入不同 itemPartId，请新建比较组。");
  }
  const calculated = input.entities.map((entity) =>
    seriesFor(input.definition, input.vertexSet, entity),
  );
  let series = calculated.map((entry) => entry.series);
  const contextCalculated = input.referenceContext
    ? seriesFor(input.definition, input.vertexSet, input.referenceContext)
    : undefined;
  if (contextCalculated) {
    series = inheritContextPoints(
      input.definition,
      series,
      contextCalculated.series,
    );
  }
  return {
    mode: "same_part_compare",
    referenceFishWeightGradeId: input.referenceFishWeightGradeId,
    fiveAxisDefinitionId: input.definition.definitionId,
    fiveAxisDefinitionVersion: input.definition.version,
    fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
    vertexSetHash: input.vertexSet.vertexSetHash,
    scaleMode: input.scaleMode ?? "official_locked",
    series,
    axisSummaries: axisSummaries(input.definition, series),
    validationIssues: [
      ...calculated.flatMap((entry) => entry.issues),
      ...(contextCalculated?.issues ?? []),
    ],
  };
}

export function calculateModelFiveAxisPreview(input: {
  modelId: string;
  modelRevision: number;
  referenceFishWeightGradeId: string;
  definition: FiveAxisViewDefinition;
  vertexSet: FiveAxisVertexSet;
  components: FiveAxisEntityInput[];
  finalPanelHash: string;
}): ModelFiveAxisPreview {
  const tackleFitComparison = buildTackleFitComparison({
    modelId: input.modelId,
    referenceFishWeightGradeId: input.referenceFishWeightGradeId,
    definition: input.definition,
    vertexSet: input.vertexSet,
    components: input.components,
  });
  const summary = tackleFitComparison.series.find(
    (series) => series.itemPartId === "model_summary",
  )!;
  const metrics: FiveAxisMetric[] = orderedAxes(input.definition).map((axis) => {
    const summaryPoint = summary.points.find((point) => point.axisId === axis.axisId)!;
    const directPoints = tackleFitComparison.series
      .filter((series) => series.itemPartId !== "model_summary")
      .map((series) => ({
        entityId: series.entityId,
        point: series.points.find((point) => point.axisId === axis.axisId)!,
      }))
      .filter((entry) => entry.point.source === "direct");
    return {
      axisId: axis.axisId,
      axisDefinitionVersion: input.definition.version,
      componentRawValues: Object.fromEntries(
        directPoints.map((entry) => [entry.entityId, entry.point.rawValue]),
      ),
      componentRatios: Object.fromEntries(
        directPoints.map((entry) => [entry.entityId, entry.point.unclampedRatio]),
      ),
      vertexValue: summaryPoint.vertexValue,
      unclampedModelRatio: summaryPoint.unclampedRatio,
      displayScore: summaryPoint.officialDisplayScore,
      trace: structuredClone(summaryPoint.trace),
    };
  });
  const inputHash = deterministicHash({
    modelRevision: input.modelRevision,
    finalPanelHash: input.finalPanelHash,
    fiveAxisDefinitionId: input.definition.definitionId,
    fiveAxisDefinitionVersion: input.definition.version,
    fiveAxisDefinitionRevision: input.definition.revision,
    fiveAxisDefinitionHash: input.definition.definitionHash,
    vertexSetHash: input.vertexSet.vertexSetHash,
    fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
    components: input.components,
  });
  return {
    modelId: input.modelId,
    modelRevision: input.modelRevision,
    finalPanelHash: input.finalPanelHash,
    componentInputs: structuredClone(input.components),
    fishWeightGradeId: input.referenceFishWeightGradeId,
    fiveAxisDefinitionId: input.definition.definitionId,
    fiveAxisDefinitionVersion: input.definition.version,
    fiveAxisDefinitionRevision: input.definition.revision,
    fiveAxisDefinitionHash: input.definition.definitionHash,
    fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
    vertexSetHash: input.vertexSet.vertexSetHash,
    sourceRevision: input.definition.sourceRevision,
    metrics,
    tackleFitComparison,
    inputHash,
  };
}
