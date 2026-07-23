import {
  canonicalDecimal,
  compareUnsignedUtf8,
  hashCandidateEvidence,
  hashCandidateSemanticInput,
  hashCandidateSet,
  hashCanonicalJson,
  hashVertexSet,
} from "./five-axis-hash";
import type {
  FiveAxisDefinitionDisposition,
  FiveAxisDefinitionDispositionCatalogRevision,
  FiveAxisEntityInput,
  FiveAxisSeries,
  FiveAxisSeriesPoint,
  FiveAxisVertexCandidateSource,
  FiveAxisVertexGroupKey,
  FiveAxisVertexSet,
  FiveAxisViewDefinition,
  StoredFiveAxisViewDefinition,
} from "./types";

export const FIVE_AXIS_SEMANTIC_CONTRACT_VERSION =
  "five-axis/open005-2026-07-23/v1" as const;
export const FIVE_AXIS_PROJECTION_REFERENCE_SELECTOR_VERSION =
  "projection-reference/current-sku-frozen-match/v1" as const;
export const FIVE_AXIS_DISPOSITION_CATALOG_SCHEMA_VERSION =
  "five-axis-definition-disposition-catalog/v1" as const;

const FORMAL_AXIS_CONTRACT = [
  {
    axisId: "pull",
    label: "拉力",
    sourceParameterKeys: ["drag"],
    applicablePartIds: ["part:rod", "part:reel", "part:line"],
    direction: "higher_better",
    transformId: "identity",
    vertexSelectorId: "max",
  },
  {
    axisId: "durability",
    label: "耐久",
    sourceParameterKeys: ["durability"],
    applicablePartIds: ["part:rod", "part:reel", "part:line"],
    direction: "higher_better",
    transformId: "identity",
    vertexSelectorId: "max",
  },
  {
    axisId: "cast",
    label: "抛投",
    sourceParameterKeys: ["max_cast_distance"],
    applicablePartIds: ["part:rod"],
    direction: "higher_better",
    transformId: "identity",
    vertexSelectorId: "max",
  },
  {
    axisId: "sensitivity",
    label: "感度",
    sourceParameterKeys: ["sensitivity"],
    applicablePartIds: ["part:rod", "part:reel", "part:line"],
    direction: "lower_better",
    transformId: "reciprocal",
    vertexSelectorId: "min",
  },
  {
    axisId: "control",
    label: "操控",
    sourceParameterKeys: ["energy_cost_factor"],
    applicablePartIds: ["part:rod", "part:reel", "part:line"],
    direction: "lower_better",
    transformId: "reciprocal",
    vertexSelectorId: "min",
  },
] as const;

function definitionContent(
  definition: Omit<FiveAxisViewDefinition, "definitionHash"> | FiveAxisViewDefinition,
): Omit<FiveAxisViewDefinition, "definitionHash"> {
  const content = { ...definition } as Partial<FiveAxisViewDefinition>;
  delete content.definitionHash;
  return content as Omit<FiveAxisViewDefinition, "definitionHash">;
}

export function hashFiveAxisViewDefinition(
  definition: Omit<FiveAxisViewDefinition, "definitionHash"> | FiveAxisViewDefinition,
): string {
  return hashCanonicalJson(definitionContent(definition) as never);
}

export function createFormalFiveAxisViewDefinition(input?: {
  definitionId?: string;
  version?: string;
  revision?: number;
  publicationState?: FiveAxisViewDefinition["publicationState"];
  weightBandPolicyVersion?: string;
  displayBandConfigId?: string;
  fiveAxisRuleVersion?: string;
  sourceRevision?: string;
  maximumItems?: number;
}): FiveAxisViewDefinition {
  const content: Omit<FiveAxisViewDefinition, "definitionHash"> = {
    definitionId: input?.definitionId ?? "five-axis:open005-v1",
    version: input?.version ?? "1",
    revision: input?.revision ?? 1,
    publicationState: input?.publicationState ?? "PUBLISHED",
    fiveAxisRuleVersion: input?.fiveAxisRuleVersion ?? "open005-2026-07-23-v1",
    sourceRevision: input?.sourceRevision ?? "feishu-revision-3563",
    semanticContractVersion: FIVE_AXIS_SEMANTIC_CONTRACT_VERSION,
    hashInputSchemaVersion: "five-axis-hash-input/v1",
    projectionReferenceSelectorVersion:
      FIVE_AXIS_PROJECTION_REFERENCE_SELECTOR_VERSION,
    axes: FORMAL_AXIS_CONTRACT.map((axis, index) => ({
      ...axis,
      order: index + 1,
      sourceParameterKeys: [...axis.sourceParameterKeys],
      applicablePartIds: [...axis.applicablePartIds],
      vertexSelectorVersion: "open005-v1",
      componentAggregationId: "per_component_no_aggregate",
      missingPolicy: "error",
    })) as FiveAxisViewDefinition["axes"],
    weightBandPolicyVersion:
      input?.weightBandPolicyVersion ?? "weight-band:w6-open005-v1",
    displayBandConfigId:
      input?.displayBandConfigId ?? "five-axis:display-band-open005-v1",
    seriesBaselinePolicy: {
      mode: "projection_reference",
      selectorVersion: FIVE_AXIS_PROJECTION_REFERENCE_SELECTOR_VERSION,
    },
    comparisonPolicy: {
      minimumItems: 2,
      maximumItems: input?.maximumItems ?? 5,
      mixedItemPartsAllowed: true,
      referenceRodMode: "first_rod_by_comparison_order",
      outerRingScore: 100,
      visualOverflowCap: null,
    },
  };
  return { ...content, definitionHash: hashFiveAxisViewDefinition(content) };
}

function equalStringArray(left: string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function isFormalFiveAxisViewDefinition(
  definition: StoredFiveAxisViewDefinition,
): definition is FiveAxisViewDefinition {
  return "semanticContractVersion" in definition;
}

export function assertFormalFiveAxisViewDefinition(
  definition: StoredFiveAxisViewDefinition,
): asserts definition is FiveAxisViewDefinition {
  if (!isFormalFiveAxisViewDefinition(definition)) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：定义不含 OPEN-005 契约。");
  }
  if (
    definition.semanticContractVersion !== FIVE_AXIS_SEMANTIC_CONTRACT_VERSION
    || definition.hashInputSchemaVersion !== "five-axis-hash-input/v1"
    || definition.projectionReferenceSelectorVersion
      !== FIVE_AXIS_PROJECTION_REFERENCE_SELECTOR_VERSION
  ) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：三项正式契约版本不匹配。");
  }
  if (definition.publicationState !== "PUBLISHED") {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：定义尚未发布。");
  }
  if (definition.axes.length !== FORMAL_AXIS_CONTRACT.length) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：正式定义必须恰好五轴。");
  }
  definition.axes.forEach((axis, index) => {
    const expected = FORMAL_AXIS_CONTRACT[index];
    if (
      axis.order !== index + 1
      || axis.axisId !== expected.axisId
      || axis.label !== expected.label
      || !equalStringArray(axis.sourceParameterKeys, expected.sourceParameterKeys)
      || !equalStringArray(axis.applicablePartIds, expected.applicablePartIds)
      || axis.direction !== expected.direction
      || axis.transformId !== expected.transformId
      || axis.vertexSelectorId !== expected.vertexSelectorId
      || !axis.vertexSelectorVersion
      || axis.componentAggregationId !== "per_component_no_aggregate"
      || axis.missingPolicy !== "error"
    ) {
      throw new Error(`FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：第 ${index + 1} 轴不符合 OPEN-005。`);
    }
  });
  if (
    !definition.weightBandPolicyVersion
    || !definition.displayBandConfigId
    || !definition.fiveAxisRuleVersion
    || !definition.sourceRevision
  ) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：必需策略或来源版本缺失。");
  }
  if (
    definition.seriesBaselinePolicy.mode !== "projection_reference"
    || definition.seriesBaselinePolicy.selectorVersion
      !== FIVE_AXIS_PROJECTION_REFERENCE_SELECTOR_VERSION
  ) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：投影参考选择器不匹配。");
  }
  const policy = definition.comparisonPolicy;
  if (
    policy.minimumItems !== 2
    || !Number.isInteger(policy.maximumItems)
    || policy.maximumItems < policy.minimumItems
    || policy.mixedItemPartsAllowed !== true
    || policy.referenceRodMode !== "first_rod_by_comparison_order"
    || policy.outerRingScore !== 100
    || policy.visualOverflowCap !== null
  ) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：比较策略不合法。");
  }
  if (hashFiveAxisViewDefinition(definition) !== definition.definitionHash) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：定义内容哈希不匹配。");
  }
}

function definitionIdentity(definition: StoredFiveAxisViewDefinition): string {
  return `${definition.definitionId}\u0000${definition.version}`;
}

function sortDispositionEntries(
  entries: FiveAxisDefinitionDisposition[],
): FiveAxisDefinitionDisposition[] {
  return [...entries].sort((left, right) =>
    compareUnsignedUtf8(left.definitionId, right.definitionId)
    || compareUnsignedUtf8(left.definitionVersion, right.definitionVersion));
}

export function hashFiveAxisDispositionCatalog(input: {
  previousCatalogHash: string | null;
  entries: FiveAxisDefinitionDisposition[];
}): string {
  return hashCanonicalJson({
    schemaVersion: FIVE_AXIS_DISPOSITION_CATALOG_SCHEMA_VERSION,
    previousCatalogHash: input.previousCatalogHash,
    entries: sortDispositionEntries(input.entries),
  } as never);
}

export function createFiveAxisDispositionCatalogRevision(input: {
  definitions: StoredFiveAxisViewDefinition[];
  existingRevisions: FiveAxisDefinitionDispositionCatalogRevision[];
  currentRevisionId: string | null;
  formalCurrent?: { definitionId: string; definitionVersion: string };
  decidedAt: string;
}): {
  revisions: FiveAxisDefinitionDispositionCatalogRevision[];
  currentRevisionId: string;
  revision: FiveAxisDefinitionDispositionCatalogRevision;
  changed: boolean;
} {
  const byIdentity = new Map<string, StoredFiveAxisViewDefinition>();
  for (const definition of input.definitions) {
    const identity = definitionIdentity(definition);
    const previous = byIdentity.get(identity);
    if (previous && previous.definitionHash !== definition.definitionHash) {
      throw new Error("FIVE_AXIS_DEFINITION_IDENTITY_CONFLICT：同一 ID/版本存在不同 definitionHash。");
    }
    byIdentity.set(identity, definition);
  }
  const current = input.currentRevisionId === null
    ? undefined
    : input.existingRevisions.find((revision) =>
      revision.catalogRevisionId === input.currentRevisionId);
  if (input.currentRevisionId && !current) {
    throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：当前目录头不存在。");
  }
  const inheritedFormal = current?.entries.find((entry) =>
    entry.effectiveUse === "FORMAL_CURRENT");
  const targetFormal = input.formalCurrent ?? (inheritedFormal
    ? {
        definitionId: inheritedFormal.definitionId,
        definitionVersion: inheritedFormal.definitionVersion,
      }
    : undefined);
  const entries = sortDispositionEntries([...byIdentity.values()].map((definition) => {
    const formal = targetFormal?.definitionId === definition.definitionId
      && targetFormal.definitionVersion === definition.version;
    if (formal) assertFormalFiveAxisViewDefinition(definition);
    return {
      definitionId: definition.definitionId,
      definitionVersion: definition.version,
      definitionHash: definition.definitionHash,
      effectiveUse: formal ? "FORMAL_CURRENT" : "LEGACY_SNAPSHOT_ONLY",
      semanticContractVersion: formal ? FIVE_AXIS_SEMANTIC_CONTRACT_VERSION : null,
      supersededByDefinitionId: null,
      supersededByDefinitionVersion: null,
      reasonCode: formal
        ? "OPEN005_FORMAL_CURRENT"
        : "OPEN005_LEGACY_CONTRACT_MISMATCH",
    };
  }));
  if (targetFormal && !entries.some((entry) => entry.effectiveUse === "FORMAL_CURRENT")) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：指定正式定义不存在。");
  }
  const semanticEqual = current
    && JSON.stringify(current.entries) === JSON.stringify(entries);
  if (semanticEqual) {
    validateFiveAxisDispositionCatalog({
      definitions: input.definitions,
      revisions: input.existingRevisions,
      currentRevisionId: current.catalogRevisionId,
    });
    return {
      revisions: input.existingRevisions,
      currentRevisionId: current.catalogRevisionId,
      revision: current,
      changed: false,
    };
  }
  const previousCatalogHash = current?.catalogHash ?? null;
  const catalogHash = hashFiveAxisDispositionCatalog({
    previousCatalogHash,
    entries,
  });
  const revision: FiveAxisDefinitionDispositionCatalogRevision = {
    catalogRevisionId: `five-axis-disposition:${catalogHash.slice(0, 20)}`,
    previousCatalogRevisionId: current?.catalogRevisionId ?? null,
    previousCatalogHash,
    schemaVersion: FIVE_AXIS_DISPOSITION_CATALOG_SCHEMA_VERSION,
    entries,
    catalogHash,
    decidedAt: input.decidedAt,
  };
  const revisions = [...input.existingRevisions, revision];
  validateFiveAxisDispositionCatalog({
    definitions: input.definitions,
    revisions,
    currentRevisionId: revision.catalogRevisionId,
  });
  return {
    revisions,
    currentRevisionId: revision.catalogRevisionId,
    revision,
    changed: true,
  };
}

export function validateFiveAxisDispositionCatalog(input: {
  definitions: StoredFiveAxisViewDefinition[];
  revisions: FiveAxisDefinitionDispositionCatalogRevision[];
  currentRevisionId: string | null;
}): FiveAxisDefinitionDispositionCatalogRevision {
  if (!input.currentRevisionId) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：处置目录尚未迁移。");
  }
  const byId = new Map(input.revisions.map((revision) =>
    [revision.catalogRevisionId, revision]));
  const byDefinition = new Map<string, StoredFiveAxisViewDefinition>();
  for (const definition of input.definitions) {
    const identity = definitionIdentity(definition);
    const previous = byDefinition.get(identity);
    if (previous && previous.definitionHash !== definition.definitionHash) {
      throw new Error("FIVE_AXIS_DEFINITION_IDENTITY_CONFLICT：同一 ID/版本存在不同 definitionHash。");
    }
    byDefinition.set(identity, definition);
  }
  let current = byId.get(input.currentRevisionId);
  if (!current) throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：目录头不存在。");
  const head = current;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.catalogRevisionId)) {
      throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：目录链存在循环。");
    }
    visited.add(current.catalogRevisionId);
    if (current.schemaVersion !== FIVE_AXIS_DISPOSITION_CATALOG_SCHEMA_VERSION) {
      throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：目录 Schema 不受支持。");
    }
    if (hashFiveAxisDispositionCatalog({
      previousCatalogHash: current.previousCatalogHash,
      entries: current.entries,
    }) !== current.catalogHash) {
      throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：catalogHash 不匹配。");
    }
    const seen = new Set<string>();
    for (const entry of current.entries) {
      const identity = `${entry.definitionId}\u0000${entry.definitionVersion}`;
      if (seen.has(identity)) {
        throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：目录含重复定义身份。");
      }
      seen.add(identity);
      const definition = byDefinition.get(identity);
      if (!definition || definition.definitionHash !== entry.definitionHash) {
        throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：目录与定义内容哈希不一致。");
      }
    }
    if (current.entries.filter((entry) =>
      entry.effectiveUse === "FORMAL_CURRENT").length > 1) {
      throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：存在多个 FORMAL_CURRENT。");
    }
    if (current.previousCatalogRevisionId === null) {
      if (current.previousCatalogHash !== null) {
        throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：首修订前驱字段不一致。");
      }
      break;
    }
    const previous = byId.get(current.previousCatalogRevisionId);
    if (!previous || previous.catalogHash !== current.previousCatalogHash) {
      throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：前驱 ID/hash 不一致。");
    }
    current = previous;
  }
  return head;
}

export function resolveFormalFiveAxisDefinition(input: {
  definitions: StoredFiveAxisViewDefinition[];
  revisions: FiveAxisDefinitionDispositionCatalogRevision[];
  currentRevisionId: string | null;
}): {
  definition: FiveAxisViewDefinition;
  catalogRevision: FiveAxisDefinitionDispositionCatalogRevision;
  disposition: FiveAxisDefinitionDisposition;
} {
  const catalogRevision = validateFiveAxisDispositionCatalog(input);
  const formal = catalogRevision.entries.filter((entry) =>
    entry.effectiveUse === "FORMAL_CURRENT");
  if (formal.length !== 1) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：没有唯一 FORMAL_CURRENT。");
  }
  const disposition = formal[0];
  const definition = input.definitions.find((entry) =>
    entry.definitionId === disposition.definitionId
    && entry.version === disposition.definitionVersion);
  if (!definition) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：目录指向的定义不存在。");
  }
  assertFormalFiveAxisViewDefinition(definition);
  if (definition.definitionHash !== disposition.definitionHash) {
    throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：定义与处置哈希不一致。");
  }
  return { definition, catalogRevision, disposition };
}

function assertVertexIdentity(
  definition: FiveAxisViewDefinition,
  groupKey: FiveAxisVertexGroupKey,
): void {
  if (
    groupKey.fiveAxisDefinitionId !== definition.definitionId
    || groupKey.fiveAxisDefinitionVersion !== definition.version
    || groupKey.fiveAxisRuleVersion !== definition.fiveAxisRuleVersion
    || groupKey.weightBandPolicyVersion !== definition.weightBandPolicyVersion
  ) {
    throw new Error("FIVE_AXIS_VERTEX_VERSION_CONFLICT：顶点组与定义版本链不一致。");
  }
}

function comparePositiveDecimal(left: string, right: string): number {
  const normalizedLeft = canonicalDecimal(left);
  const normalizedRight = canonicalDecimal(right);
  if (normalizedLeft.startsWith("-") || normalizedRight.startsWith("-")) {
    throw new Error("顶点候选值必须大于 0。");
  }
  const [leftInteger, leftFraction = ""] = normalizedLeft.split(".");
  const [rightInteger, rightFraction = ""] = normalizedRight.split(".");
  if (leftInteger.length !== rightInteger.length) {
    return leftInteger.length - rightInteger.length;
  }
  const integerComparison = leftInteger.localeCompare(rightInteger);
  if (integerComparison) return integerComparison;
  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(fractionLength, "0")
    .localeCompare(rightFraction.padEnd(fractionLength, "0"));
}

export function createFormalFiveAxisVertexSet(input: {
  definition: FiveAxisViewDefinition;
  groupKey: FiveAxisVertexGroupKey;
  candidateSources: FiveAxisVertexCandidateSource[];
}): FiveAxisVertexSet {
  assertFormalFiveAxisViewDefinition(input.definition);
  assertVertexIdentity(input.definition, input.groupKey);
  if (!input.candidateSources.length) {
    throw new Error("FIVE_AXIS_VERTEX_UNAVAILABLE：候选池为空。");
  }
  const sources = input.candidateSources.map((source) => {
    const calculated = hashCandidateSemanticInput({
      finalPanelHash: source.finalPanelHash,
      modelFinalPullKg: source.modelFinalPullKg,
      directInputs: source.directInputs.map((entry) => ({
        ...entry,
        axisOrder: input.definition.axes.find((axis) =>
          axis.axisId === entry.axisId)?.order,
      })),
    });
    if (calculated.hash !== source.semanticInputHash) {
      throw new Error("FIVE_AXIS_CANDIDATE_INTEGRITY_ERROR：semanticInputHash 不匹配。");
    }
    return structuredClone(source);
  });
  const candidateSetHash = hashCandidateSet({
    vertexGroupKey: input.groupKey,
    candidates: sources.map((source) => ({
      key: source.candidateSemanticKey,
      semanticInputHash: source.semanticInputHash,
    })),
  });
  const candidateEvidenceHash = hashCandidateEvidence({
    vertexGroupKey: input.groupKey,
    candidates: sources.map((source) => ({
      key: source.candidateSemanticKey,
      snapshotId: source.snapshotId,
      modelRevisionId: source.modelRevisionId,
      semanticInputHash: source.semanticInputHash,
    })),
  });
  const vertices = input.definition.axes.map((axis) => {
    const values = sources.flatMap((source) =>
      source.directInputs
        .filter((entry) => entry.axisId === axis.axisId)
        .map((entry) => canonicalDecimal(entry.rawValue))
        .filter((value) => !value.startsWith("-") && value !== "0"));
    if (!values.length) {
      throw new Error(`FIVE_AXIS_VERTEX_UNAVAILABLE：${axis.axisId} 没有合法 direct 候选。`);
    }
    const vertexRawValue = [...values].sort(comparePositiveDecimal)[
      axis.vertexSelectorId === "max" ? values.length - 1 : 0
    ];
    return {
      axisId: axis.axisId,
      vertexRawValue,
      vertexSelectorId: axis.vertexSelectorId,
      vertexSelectorVersion: axis.vertexSelectorVersion,
    };
  });
  const vertexSetHash = hashVertexSet({
    vertexGroupKey: input.groupKey,
    candidateSetHash,
    vertices: vertices.map((vertex, index) => ({
      ...vertex,
      axisOrder: input.definition.axes[index].order,
    })),
  });
  return {
    vertexSetId: `five-axis-vertex:${vertexSetHash.slice(0, 20)}`,
    weightBandId: input.groupKey.weightBandId,
    weightBandPolicyVersion: input.groupKey.weightBandPolicyVersion,
    fiveAxisDefinitionId: input.groupKey.fiveAxisDefinitionId,
    fiveAxisDefinitionVersion: input.groupKey.fiveAxisDefinitionVersion,
    fiveAxisRuleVersion: input.groupKey.fiveAxisRuleVersion,
    hashInputSchemaVersion: "five-axis-hash-input/v1",
    candidateSources: sources,
    candidateSetHash,
    candidateEvidenceHash,
    vertices,
    vertexSetHash,
  };
}

function unavailablePoint(
  definition: FiveAxisViewDefinition,
  axisIndex: number,
  source: FiveAxisSeriesPoint["source"],
  message: string,
): FiveAxisSeriesPoint {
  const axis = definition.axes[axisIndex];
  return {
    axisId: axis.axisId,
    axisDefinitionVersion: `${definition.definitionId}@${definition.version}`,
    rawValue: null,
    vertexValue: null,
    unclampedRatio: null,
    normalizedRatio: null,
    officialDisplayScore: null,
    comparisonScore: null,
    overflow: null,
    source,
    participatesInRanking: false,
    trace: [{ step: source, message }],
  };
}

export function calculateFormalFiveAxisComponentSeries(input: {
  definition: FiveAxisViewDefinition;
  vertexSet: FiveAxisVertexSet;
  entity: FiveAxisEntityInput;
  referenceRodSeries?: FiveAxisSeries;
}): FiveAxisSeries {
  assertFormalFiveAxisViewDefinition(input.definition);
  assertVertexIdentity(input.definition, {
    weightBandId: input.vertexSet.weightBandId,
    weightBandPolicyVersion: input.vertexSet.weightBandPolicyVersion,
    fiveAxisDefinitionId: input.vertexSet.fiveAxisDefinitionId,
    fiveAxisDefinitionVersion: input.vertexSet.fiveAxisDefinitionVersion,
    fiveAxisRuleVersion: input.vertexSet.fiveAxisRuleVersion,
  });
  if (input.vertexSet.hashInputSchemaVersion !== "five-axis-hash-input/v1") {
    throw new Error("FIVE_AXIS_VERTEX_VERSION_CONFLICT：顶点哈希 Schema 不匹配。");
  }
  const recalculatedHash = hashVertexSet({
    vertexGroupKey: {
      weightBandId: input.vertexSet.weightBandId,
      weightBandPolicyVersion: input.vertexSet.weightBandPolicyVersion,
      fiveAxisDefinitionId: input.vertexSet.fiveAxisDefinitionId,
      fiveAxisDefinitionVersion: input.vertexSet.fiveAxisDefinitionVersion,
      fiveAxisRuleVersion: input.vertexSet.fiveAxisRuleVersion,
    },
    candidateSetHash: input.vertexSet.candidateSetHash,
    vertices: input.vertexSet.vertices.map((vertex, index) => ({
      ...vertex,
      axisOrder: input.definition.axes[index]?.order,
    })),
  });
  if (recalculatedHash !== input.vertexSet.vertexSetHash) {
    throw new Error("FIVE_AXIS_VERTEX_INTEGRITY_ERROR：vertexSetHash 不匹配。");
  }
  const points = input.definition.axes.map((axis, axisIndex): FiveAxisSeriesPoint => {
    if (!axis.applicablePartIds.includes(input.entity.itemPartId)) {
      if (axis.axisId === "cast" && input.entity.itemPartId !== "part:rod") {
        const inherited = input.referenceRodSeries?.points.find((point) =>
          point.axisId === axis.axisId && point.source === "direct");
        if (inherited) {
          return {
            ...structuredClone(inherited),
            source: "context_inherited",
            participatesInRanking: false,
            trace: [
              ...structuredClone(inherited.trace),
              {
                step: "context_inherited",
                message: "此抛投值继承自比较顺序中的第一根竿，仅用于完整展示。",
                value: input.referenceRodSeries?.entityId,
              },
            ],
          };
        }
      }
      return unavailablePoint(
        input.definition,
        axisIndex,
        "not_applicable",
        "该部位不直接适用此轴，且没有可用参考竿。",
      );
    }
    const parameterKey = axis.sourceParameterKeys[0];
    const raw = input.entity.values[parameterKey];
    if (raw === null || raw === undefined) {
      return unavailablePoint(
        input.definition,
        axisIndex,
        "missing",
        `缺少直接输入 ${parameterKey}。`,
      );
    }
    const vertex = input.vertexSet.vertices.find((entry) =>
      entry.axisId === axis.axisId);
    const vertexValue = vertex ? Number(vertex.vertexRawValue) : Number.NaN;
    if (!Number.isFinite(raw) || !Number.isFinite(vertexValue) || raw <= 0 || vertexValue <= 0) {
      return unavailablePoint(
        input.definition,
        axisIndex,
        "error",
        "直接输入或顶点不是大于 0 的有限值。",
      );
    }
    const ratio = axis.direction === "lower_better"
      ? vertexValue / raw
      : raw / vertexValue;
    const comparisonScore = ratio * 100;
    const officialDisplayScore = Math.min(100, comparisonScore);
    return {
      axisId: axis.axisId,
      axisDefinitionVersion: `${input.definition.definitionId}@${input.definition.version}`,
      rawValue: raw,
      vertexValue,
      unclampedRatio: ratio,
      normalizedRatio: ratio,
      officialDisplayScore,
      comparisonScore,
      overflow: Math.max(0, comparisonScore - 100),
      source: "direct",
      participatesInRanking: true,
      trace: [
        { step: "direct_input", message: `读取 ${parameterKey}。`, value: raw },
        {
          step: axis.direction === "lower_better" ? "vertex_over_raw" : "raw_over_vertex",
          message: "按已发布定义计算未封顶比例。",
          value: ratio,
        },
      ],
    };
  });
  return {
    entityId: input.entity.entityId,
    itemPartId: input.entity.itemPartId,
    label: input.entity.label,
    fishWeightGradeId: input.vertexSet.weightBandId,
    points,
  };
}
