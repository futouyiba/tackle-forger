import {
  canonicalDecimal,
  compareUnsignedUtf8,
  hashCandidateEvidence,
  hashCandidateSemanticInput,
  hashCandidateSet,
  hashCanonicalJson,
  hashProjectionReferenceSet,
  hashVertexSet,
} from "./five-axis-hash";
import type {
  FiveAxisDefinitionDisposition,
  FiveAxisDefinitionDispositionCatalogRevision,
  FiveAxisEntityInput,
  FiveAxisProjectionReferenceAnchor,
  FiveAxisProjectionReferenceEvidence,
  FiveAxisSeries,
  FiveAxisSeriesPoint,
  FiveAxisVertexCandidateSource,
  FiveAxisVertexGroupKey,
  FiveAxisVertexSet,
  FiveAxisViewDefinition,
  FiveAxisWeightBandPolicy,
  ModelComponentSelection,
  ModelFiveAxisPreview,
  StoredFiveAxisViewDefinition,
} from "./types";

export const FIVE_AXIS_SEMANTIC_CONTRACT_VERSION =
  "five-axis/open005-2026-07-23/v1" as const;
export const FIVE_AXIS_PROJECTION_REFERENCE_SELECTOR_VERSION =
  "projection-reference/current-sku-frozen-match/v1" as const;
export const FIVE_AXIS_DISPOSITION_CATALOG_SCHEMA_VERSION =
  "five-axis-definition-disposition-catalog/v1" as const;

function weightBandPolicyContent(
  policy: Omit<FiveAxisWeightBandPolicy, "contentHash"> | FiveAxisWeightBandPolicy,
): Omit<FiveAxisWeightBandPolicy, "contentHash"> {
  const content = { ...policy } as Partial<FiveAxisWeightBandPolicy>;
  delete content.contentHash;
  return content as Omit<FiveAxisWeightBandPolicy, "contentHash">;
}

export function hashFiveAxisWeightBandPolicy(
  policy: Omit<FiveAxisWeightBandPolicy, "contentHash"> | FiveAxisWeightBandPolicy,
): string {
  return hashCanonicalJson(weightBandPolicyContent(policy) as never);
}

export function createFormalFiveAxisWeightBandPolicy(input?: {
  policyId?: string; version?: string; sourceRevision?: string;
  bands?: Array<{ weightBandId: string; upperBoundKg: string | null }>;
}): FiveAxisWeightBandPolicy {
  const content: Omit<FiveAxisWeightBandPolicy, "contentHash"> = {
    policyId: input?.policyId ?? "weight-band:w6-open005",
    version: input?.version ?? "weight-band:w6-open005-v1",
    publicationState: "PUBLISHED",
    sourceRevision: input?.sourceRevision ?? "feishu-revision-3563",
    bands: input?.bands ?? [
      { weightBandId: "W1", upperBoundKg: "2" }, { weightBandId: "W2", upperBoundKg: "4" },
      { weightBandId: "W3", upperBoundKg: "6" }, { weightBandId: "W4", upperBoundKg: "10" },
      { weightBandId: "W5", upperBoundKg: "15" }, { weightBandId: "W6", upperBoundKg: null },
    ],
  };
  return { ...content, contentHash: hashFiveAxisWeightBandPolicy(content) };
}

/** Only a published, content-hash-bound policy may select an OPEN-005 W band. */
export function resolveFormalFiveAxisWeightBand(input: {
  policy: FiveAxisWeightBandPolicy;
  modelFinalPullKg: number;
}): string {
  const policy = input.policy;
  if (policy.publicationState !== "PUBLISHED"
    || policy.contentHash !== hashFiveAxisWeightBandPolicy(policy)
    || !Number.isFinite(input.modelFinalPullKg) || input.modelFinalPullKg <= 0) {
    throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE：无法按已发布 W 段策略解析最终拉力。");
  }
  let previous = 0;
  for (const band of policy.bands) {
    if (!band.weightBandId || band.upperBoundKg === "" || band.upperBoundKg === undefined) {
      throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE：W 段策略结构不完整。");
    }
    if (band.upperBoundKg === null) return band.weightBandId;
    const upper = Number(band.upperBoundKg);
    if (!Number.isFinite(upper) || upper <= previous) {
      throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE：W 段边界非法或不单调。");
    }
    if (input.modelFinalPullKg <= upper) return band.weightBandId;
    previous = upper;
  }
  throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE：W 段策略缺少开放尾段。");
}

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

export function hashFormalFinalPanelValues(
  values: Record<string, number | string>,
): string {
  return hashCanonicalJson({
    schemaVersion: "five-axis-hash-input/v1",
    kind: "final_panel",
    values: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === "number"
          ? canonicalFiniteNumber(value, `finalPanelValues.${key}`)
          : value,
      ]),
    ),
  } as never);
}

export function hashFormalComponentValues(
  component: Pick<
    ModelComponentSelection,
    "componentId" | "itemPartId" | "values"
  >,
): string {
  return hashCanonicalJson({
    componentId: component.componentId,
    itemPartId: component.itemPartId,
    values: Object.fromEntries(
      Object.entries(component.values).map(([key, value]) => [
        key,
        typeof value === "number"
          ? canonicalFiniteNumber(value, `componentValues.${key}`)
          : value,
      ]),
    ),
  } as never);
}

export function createFormalFiveAxisViewDefinition(input?: {
  definitionId?: string;
  version?: string;
  revision?: number;
  publicationState?: FiveAxisViewDefinition["publicationState"];
  weightBandPolicyVersion?: string;
  weightBandPolicy?: FiveAxisWeightBandPolicy;
  displayBandConfigId?: string;
  fiveAxisRuleVersion?: string;
  sourceRevision?: string;
  maximumItems?: number;
}): FiveAxisViewDefinition {
  const weightBandPolicy = input?.weightBandPolicy ?? createFormalFiveAxisWeightBandPolicy({
    version: input?.weightBandPolicyVersion,
    sourceRevision: input?.sourceRevision,
  });
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
    weightBandPolicyVersion: weightBandPolicy.version,
    weightBandPolicy,
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
  if (
    definition.weightBandPolicyVersion !== definition.weightBandPolicy?.version
    || definition.weightBandPolicy?.publicationState !== "PUBLISHED"
    || definition.weightBandPolicy?.contentHash
      !== hashFiveAxisWeightBandPolicy(definition.weightBandPolicy)
  ) {
    throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE：正式定义缺少可验证的已发布 W 段策略。");
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
    const previousEntry = current?.entries.find((entry) =>
      entry.definitionId === definition.definitionId
      && entry.definitionVersion === definition.version);
    const newlySuperseded = Boolean(
      targetFormal
      && inheritedFormal
      && inheritedFormal.definitionId === definition.definitionId
      && inheritedFormal.definitionVersion === definition.version
      && !formal,
    );
    if (formal) assertFormalFiveAxisViewDefinition(definition);
    const superseded = newlySuperseded
      ? {
          definitionId: definition.definitionId,
          definitionVersion: definition.version,
          definitionHash: definition.definitionHash,
          effectiveUse: "SUPERSEDED" as const,
          semanticContractVersion: FIVE_AXIS_SEMANTIC_CONTRACT_VERSION,
          supersededByDefinitionId: targetFormal!.definitionId,
          supersededByDefinitionVersion: targetFormal!.definitionVersion,
          reasonCode: "OPEN005_FORMAL_SUPERSEDED",
        }
      : previousEntry?.effectiveUse === "SUPERSEDED"
        ? {
            ...structuredClone(previousEntry),
            definitionHash: definition.definitionHash,
          }
        : null;
    if (superseded) return superseded;
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
  const headIdentities = new Set(head.entries.map((entry) =>
    `${entry.definitionId}\u0000${entry.definitionVersion}`));
  if (
    headIdentities.size !== byDefinition.size
    || [...byDefinition.keys()].some((identity) => !headIdentities.has(identity))
  ) {
    throw new Error("FIVE_AXIS_DISPOSITION_CATALOG_CONFLICT：当前目录头未完整分类全部已知定义。");
  }
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
    for (const axis of input.definition.axes) {
      if (!axis.applicablePartIds.includes(source.candidateSemanticKey.itemPartId)) {
        continue;
      }
      const directInputs = source.directInputs.filter((entry) =>
        entry.axisId === axis.axisId);
      if (
        directInputs.length !== 1
        || !axis.sourceParameterKeys.includes(directInputs[0].parameterKey)
      ) {
        throw new Error(
          `FIVE_AXIS_CANDIDATE_INCOMPLETE：${source.candidateSemanticKey.componentEntityId}`
          + ` 缺少或重复 ${axis.axisId} 的合法 direct 输入。`,
        );
      }
      const rawValue = canonicalDecimal(directInputs[0].rawValue);
      if (rawValue === "0" || rawValue.startsWith("-")) {
        throw new Error(
          `FIVE_AXIS_CANDIDATE_INCOMPLETE：${source.candidateSemanticKey.componentEntityId}`
          + ` 的 ${axis.axisId} 必须为大于 0 的 CanonicalDecimal。`,
        );
      }
    }
    return structuredClone(source);
  }).sort((left, right) =>
    compareUnsignedUtf8(
      left.candidateSemanticKey.modelId,
      right.candidateSemanticKey.modelId,
    )
    || compareUnsignedUtf8(
      left.candidateSemanticKey.componentEntityId,
      right.candidateSemanticKey.componentEntityId,
    )
    || compareUnsignedUtf8(
      left.candidateSemanticKey.itemPartId,
      right.candidateSemanticKey.itemPartId,
    ));
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
      axis.applicablePartIds.includes(source.candidateSemanticKey.itemPartId)
        ? source.directInputs
        .filter((entry) => entry.axisId === axis.axisId)
        .map((entry) => canonicalDecimal(entry.rawValue))
        .filter((value) => !value.startsWith("-") && value !== "0")
        : []);
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
    const officialDisplayScore = Math.round(Math.min(100, comparisonScore));
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

function canonicalFiniteNumber(value: number, field: string): string {
  if (!Number.isFinite(value)) {
    throw new Error(`FIVE_AXIS_FORMAL_PREVIEW_INVALID：${field} 必须是有限数值。`);
  }
  return canonicalDecimal(String(Object.is(value, -0) ? 0 : value));
}

function formalSeriesHashInput(series: FiveAxisSeries): object {
  return {
    entityId: series.entityId,
    itemPartId: series.itemPartId,
    modelFinalPullKg: series.modelFinalPullKg === undefined
      ? null
      : canonicalFiniteNumber(series.modelFinalPullKg, "series.modelFinalPullKg"),
    weightBandId: series.weightBandId ?? null,
    comparisonOrder: series.comparisonOrder ?? null,
    points: series.points.map((point) => ({
      axisId: point.axisId,
      axisDefinitionVersion: point.axisDefinitionVersion,
      source: point.source,
      rawValue: point.rawValue === null
        ? null
        : canonicalFiniteNumber(point.rawValue, `${point.axisId}.rawValue`),
      vertexValue: point.vertexValue === null
        ? null
        : canonicalFiniteNumber(point.vertexValue, `${point.axisId}.vertexValue`),
      componentRatio: point.unclampedRatio === null
        ? null
        : canonicalFiniteNumber(point.unclampedRatio, `${point.axisId}.componentRatio`),
      normalizedRatio: point.normalizedRatio === null
        ? null
        : canonicalFiniteNumber(point.normalizedRatio, `${point.axisId}.normalizedRatio`),
      comparisonScore: point.comparisonScore === null
        ? null
        : canonicalFiniteNumber(point.comparisonScore, `${point.axisId}.comparisonScore`),
      officialDisplayScore: point.officialDisplayScore,
      overflow: point.overflow === null
        ? null
        : canonicalFiniteNumber(point.overflow, `${point.axisId}.overflow`),
      trace: (() => {
        if (!Array.isArray(point.trace) || point.trace.length === 0) {
          throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：正式点必须冻结非空计算 Trace。");
        }
        return point.trace.map((entry) => ({
          step: entry.step,
          message: entry.message,
          value: entry.value === undefined ? null : entry.value,
        }));
      })(),
    })),
  };
}

export function hashFormalFiveAxisPreviewInput(
  preview: ModelFiveAxisPreview,
): string {
  if (
    preview.modelFinalPullKg === undefined
    || !preview.weightBandId
    || !preview.weightBandPolicyVersion
    || !preview.hashInputSchemaVersion
    || !preview.candidateSources
    || !preview.candidateSetHash
    || !preview.candidateEvidenceHash
    || !preview.componentSeries
    || !preview.tackleFitComparison.projectionReferenceAnchor
    || !preview.tackleFitComparison.projectionReferenceSetHash
    || !preview.tackleFitComparison.projectionReferences
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：正式预览证据不完整。");
  }
  return hashCanonicalJson({
    schemaVersion: preview.hashInputSchemaVersion,
    kind: "formal_model_preview",
    modelId: preview.modelId,
    modelFinalPullKg: canonicalFiniteNumber(
      preview.modelFinalPullKg,
      "modelFinalPullKg",
    ),
    vertexGroupKey: {
      weightBandId: preview.weightBandId,
      weightBandPolicyVersion: preview.weightBandPolicyVersion,
      fiveAxisDefinitionId: preview.fiveAxisDefinitionId,
      fiveAxisDefinitionVersion: preview.fiveAxisDefinitionVersion,
      fiveAxisRuleVersion: preview.fiveAxisRuleVersion,
    },
    fiveAxisDefinitionRevision: preview.fiveAxisDefinitionRevision ?? null,
    fiveAxisDefinitionHash: preview.fiveAxisDefinitionHash ?? null,
    sourceRevision: preview.sourceRevision,
    vertexSetHash: preview.vertexSetHash,
    candidateSetHash: preview.candidateSetHash,
    candidateEvidenceHash: preview.candidateEvidenceHash,
    candidateSources: preview.candidateSources,
    componentSeries: preview.componentSeries.map(formalSeriesHashInput),
    projectionReferenceAnchor:
      preview.tackleFitComparison.projectionReferenceAnchor,
    projectionReferenceSetHash:
      preview.tackleFitComparison.projectionReferenceSetHash,
    projectionReferences:
      preview.tackleFitComparison.projectionReferences,
  } as never);
}

function almostEqual(left: number | null, right: number, tolerance = 1e-9): boolean {
  return left !== null
    && Number.isFinite(left)
    && Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(right));
}

function assertFormalSeriesPoint(input: {
  definition: FiveAxisViewDefinition;
  vertexSet: FiveAxisVertexSet;
  series: FiveAxisSeries;
  point: FiveAxisSeriesPoint;
  axisIndex: number;
  referenceRod: FiveAxisSeries;
}): void {
  const axis = input.definition.axes[input.axisIndex];
  const expectedVersion = `${input.definition.definitionId}@${input.definition.version}`;
  if (
    input.point.axisId !== axis.axisId
    || input.point.axisDefinitionVersion !== expectedVersion
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：逐部件曲线的轴身份或顺序不匹配。");
  }
  const directlyApplicable = axis.applicablePartIds.includes(input.series.itemPartId);
  if (!directlyApplicable) {
    const referencePoint = input.referenceRod.points[input.axisIndex];
    if (
      axis.axisId !== "cast"
      || input.series.itemPartId === "part:rod"
      || input.point.source !== "context_inherited"
      || !referencePoint
      || referencePoint.source !== "direct"
      || input.point.rawValue !== referencePoint.rawValue
      || input.point.vertexValue !== referencePoint.vertexValue
      || input.point.unclampedRatio !== referencePoint.unclampedRatio
      || input.point.normalizedRatio !== referencePoint.normalizedRatio
      || input.point.comparisonScore !== referencePoint.comparisonScore
      || input.point.officialDisplayScore !== referencePoint.officialDisplayScore
      || input.point.overflow !== referencePoint.overflow
      || input.point.participatesInRanking
    ) {
      throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：继承抛投证据与参考竿不一致。");
    }
    const expectedTrace = [
      ...referencePoint.trace,
      {
        step: "context_inherited",
        message: "此抛投值继承自比较顺序中的第一根竿，仅用于完整展示。",
        value: input.referenceRod.entityId,
      },
    ];
    if (JSON.stringify(input.point.trace) !== JSON.stringify(expectedTrace)) {
      throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：继承抛投的 Trace 链不可重放。");
    }
    return;
  }
  const vertex = input.vertexSet.vertices[input.axisIndex];
  const rawValue = input.point.rawValue;
  const vertexValue = Number(vertex?.vertexRawValue);
  if (
    input.point.source !== "direct"
    || !input.point.participatesInRanking
    || rawValue === null
    || !Number.isFinite(rawValue)
    || rawValue <= 0
    || !Number.isFinite(vertexValue)
    || vertexValue <= 0
    || input.point.vertexValue !== vertexValue
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：正式 direct 点缺少合法原始值或顶点。");
  }
  const ratio = axis.direction === "lower_better"
    ? vertexValue / rawValue
    : rawValue / vertexValue;
  const comparisonScore = ratio * 100;
  if (
    !almostEqual(input.point.unclampedRatio, ratio)
    || !almostEqual(input.point.normalizedRatio, ratio)
    || !almostEqual(input.point.comparisonScore, comparisonScore)
    || input.point.officialDisplayScore
      !== Math.round(Math.min(100, comparisonScore))
    || !almostEqual(input.point.overflow, Math.max(0, comparisonScore - 100))
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：正式点的比例或分值证据不可重放。");
  }
  const parameterKey = axis.sourceParameterKeys[0];
  const expectedTrace = [
    { step: "direct_input", message: `读取 ${parameterKey}。`, value: rawValue },
    {
      step: axis.direction === "lower_better" ? "vertex_over_raw" : "raw_over_vertex",
      message: "按已发布定义计算未封顶比例。",
      value: ratio,
    },
  ];
  if (JSON.stringify(input.point.trace) !== JSON.stringify(expectedTrace)) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：正式 direct 点的 Trace 不可重放。");
  }
}

export function assertFormalModelFiveAxisPreview(input: {
  definition: FiveAxisViewDefinition;
  preview: ModelFiveAxisPreview;
  expectedCandidateSources: FiveAxisVertexCandidateSource[];
  expectedModelId: string;
  expectedModelRevisionId: string;
  expectedSnapshotId: string;
  expectedSeriesId: string;
  expectedSkuId: string;
  expectedSkuRevisionId: string;
  expectedProjectionReferences: FiveAxisProjectionReferenceEvidence[];
  expectedFinalPanelHash: string;
  expectedComponentSelections: Array<
    Pick<ModelComponentSelection, "itemPartId" | "componentId" | "values">
  >;
  expectedModelFinalPullKg: number;
}): FiveAxisVertexSet {
  assertFormalFiveAxisViewDefinition(input.definition);
  const preview = input.preview;
  const resolvedWeightBandId = resolveFormalFiveAxisWeightBand({
    policy: input.definition.weightBandPolicy,
    modelFinalPullKg: input.expectedModelFinalPullKg,
  });
  if (
    preview.modelId !== input.expectedModelId
    || preview.modelFinalPullKg !== input.expectedModelFinalPullKg
    || preview.weightBandPolicyVersion !== input.definition.weightBandPolicyVersion
    || preview.hashInputSchemaVersion !== input.definition.hashInputSchemaVersion
    || !preview.weightBandId
    || preview.weightBandId !== resolvedWeightBandId
    || preview.fiveAxisDefinitionId !== input.definition.definitionId
    || preview.fiveAxisDefinitionVersion !== input.definition.version
    || preview.fiveAxisDefinitionRevision !== input.definition.revision
    || preview.fiveAxisDefinitionHash !== input.definition.definitionHash
    || preview.fiveAxisRuleVersion !== input.definition.fiveAxisRuleVersion
    || preview.sourceRevision !== input.definition.sourceRevision
    || preview.metrics.length !== 0
    || !preview.candidateSources?.length
    || !preview.candidateSetHash
    || !preview.candidateEvidenceHash
    || !preview.componentSeries
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：预览不是完整 OPEN-005 正式结果。");
  }
  const groupKey: FiveAxisVertexGroupKey = {
    weightBandId: preview.weightBandId,
    weightBandPolicyVersion: preview.weightBandPolicyVersion,
    fiveAxisDefinitionId: preview.fiveAxisDefinitionId,
    fiveAxisDefinitionVersion: preview.fiveAxisDefinitionVersion,
    fiveAxisRuleVersion: preview.fiveAxisRuleVersion,
  };
  const vertexSet = createFormalFiveAxisVertexSet({
    definition: input.definition,
    groupKey,
    candidateSources: preview.candidateSources,
  });
  const expectedVertexSet = createFormalFiveAxisVertexSet({
    definition: input.definition,
    groupKey,
    candidateSources: input.expectedCandidateSources,
  });
  if (
    vertexSet.vertexSetHash !== preview.vertexSetHash
    || vertexSet.candidateSetHash !== preview.candidateSetHash
    || vertexSet.candidateEvidenceHash !== preview.candidateEvidenceHash
    || expectedVertexSet.vertexSetHash !== vertexSet.vertexSetHash
    || expectedVertexSet.candidateSetHash !== vertexSet.candidateSetHash
    || expectedVertexSet.candidateEvidenceHash !== vertexSet.candidateEvidenceHash
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：预览未绑定完整权威候选池，或候选/顶点哈希不可重放。");
  }

  const expectedParts = ["part:rod", "part:reel", "part:line"];
  if (
    preview.componentSeries.length !== expectedParts.length
    || preview.componentSeries.some((series, index) =>
      series.itemPartId !== expectedParts[index]
      || series.weightBandId !== preview.weightBandId
      || series.fishWeightGradeId !== preview.weightBandId
      || series.modelFinalPullKg !== preview.modelFinalPullKg
      || series.comparisonOrder !== index)
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：逐部件曲线必须按竿、轮、线冻结。");
  }
  const expectedSelections = new Map(
    input.expectedComponentSelections.map((selection) =>
      [selection.itemPartId, selection] as const),
  );
  if (
    expectedSelections.size !== expectedParts.length
    || expectedParts.some((partId, index) =>
      expectedSelections.get(partId)?.componentId
        !== preview.componentSeries![index].entityId)
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：逐部件曲线与 Model 组件选择不一致。");
  }
  const referenceRod = preview.componentSeries[0];
  for (const series of preview.componentSeries) {
    if (series.points.length !== input.definition.axes.length) {
      throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：逐部件曲线缺少正式轴。");
    }
    series.points.forEach((point, axisIndex) =>
      assertFormalSeriesPoint({
        definition: input.definition,
        vertexSet,
        series,
        point,
        axisIndex,
        referenceRod,
      }));
  }

  const currentSources = preview.candidateSources.filter((source) =>
    source.candidateSemanticKey.modelId === input.expectedModelId);
  if (
    currentSources.length !== expectedParts.length
    || currentSources.some((source) => {
      const series = preview.componentSeries!.find((entry) =>
        entry.entityId === source.candidateSemanticKey.componentEntityId
        && entry.itemPartId === source.candidateSemanticKey.itemPartId);
      const expectedSelection = expectedSelections.get(
        source.candidateSemanticKey.itemPartId,
      );
      const expectedInputHash = expectedSelection
        ? hashFormalComponentValues(expectedSelection)
        : null;
      return !series
        || !expectedSelection
        || expectedSelection.componentId
          !== source.candidateSemanticKey.componentEntityId
        || source.snapshotId !== input.expectedSnapshotId
        || source.modelRevisionId !== input.expectedModelRevisionId
        || source.finalPanelHash !== input.expectedFinalPanelHash
        || canonicalDecimal(source.modelFinalPullKg)
          !== canonicalDecimal(String(input.expectedModelFinalPullKg))
        || source.directInputs.some((directInput) => {
          const point = series.points.find((entry) =>
            entry.axisId === directInput.axisId);
          const axis = input.definition.axes.find((entry) =>
            entry.axisId === directInput.axisId);
          const expectedValue =
            expectedSelection.values[directInput.parameterKey];
          const expectedRawValue =
            typeof expectedValue === "number" || typeof expectedValue === "string"
              ? canonicalDecimal(String(expectedValue))
              : null;
          return Boolean(
            !axis
            || directInput.inputHash !== expectedInputHash
            || expectedRawValue === null
            || canonicalDecimal(directInput.rawValue) !== expectedRawValue
            || (
              axis.applicablePartIds.includes(series.itemPartId)
              && (!point
                || point.source !== "direct"
                || canonicalDecimal(directInput.rawValue)
                  !== canonicalDecimal(String(point.rawValue)))
            ),
          );
        });
    })
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：当前 Model 的冻结候选证据不一致。");
  }

  const comparison = preview.tackleFitComparison;
  const anchor = comparison.projectionReferenceAnchor;
  const references = comparison.projectionReferences;
  const expectedReferenceParts = ["part:rod", "part:reel", "part:line"];
  if (
    comparison.mode !== "tackle_fit"
    || comparison.referenceFishWeightGradeId !== preview.weightBandId
    || comparison.weightBandPolicyVersion !== preview.weightBandPolicyVersion
    || comparison.fiveAxisDefinitionId !== preview.fiveAxisDefinitionId
    || comparison.fiveAxisDefinitionVersion !== preview.fiveAxisDefinitionVersion
    || comparison.fiveAxisRuleVersion !== preview.fiveAxisRuleVersion
    || comparison.vertexSetHash !== preview.vertexSetHash
    || comparison.referenceRodEntityId !== referenceRod.entityId
    || JSON.stringify(comparison.series) !== JSON.stringify(preview.componentSeries)
    || comparison.validationIssues.some((issue) => issue.level === "error")
    || !anchor
    || anchor.baselineSnapshotId !== input.expectedSnapshotId
    || anchor.seriesId !== input.expectedSeriesId
    || anchor.skuId !== input.expectedSkuId
    || anchor.skuRevisionId !== input.expectedSkuRevisionId
    || anchor.selectorVersion !== FIVE_AXIS_PROJECTION_REFERENCE_SELECTOR_VERSION
    || !references
    || references.length !== expectedReferenceParts.length
    || input.expectedProjectionReferences.length !== expectedReferenceParts.length
    || references.some((reference, index) =>
      reference.itemPartId !== expectedReferenceParts[index])
    || input.expectedProjectionReferences.some((reference, index) =>
      reference.itemPartId !== expectedReferenceParts[index])
    || JSON.stringify(references)
      !== JSON.stringify(input.expectedProjectionReferences)
    || references.some((reference) =>
      reference.state === "error" || reference.state === "not_selected")
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：钓组或投影引用证据不完整。");
  }
  const projectionReferenceSetHash = hashProjectionReferenceSet({
    selectorVersion: anchor.selectorVersion,
    anchor: {
      baselineSnapshotId: anchor.baselineSnapshotId,
      seriesId: anchor.seriesId,
      skuId: anchor.skuId,
      skuRevisionId: anchor.skuRevisionId,
    },
    references: references as Array<{
      itemPartId: string;
      state: "available" | "missing" | "error";
      projectionMatchId: string | null;
      projectionMatchRevisionId: string | null;
      projectionId: string | null;
      projectionRevisionId: string | null;
    }>,
  });
  if (
    comparison.projectionReferenceSetHash !== projectionReferenceSetHash
    || preview.inputHash !== hashFormalFiveAxisPreviewInput(preview)
  ) {
    throw new Error("FIVE_AXIS_FORMAL_PREVIEW_INVALID：投影引用或预览 inputHash 不匹配。");
  }
  return vertexSet;
}

function buildAxisSummaries(
  definition: FiveAxisViewDefinition,
  series: FiveAxisSeries[],
) {
  return definition.axes.map((axis) => {
    const direct = series.flatMap((entry) => {
      const point = entry.points.find((candidate) => candidate.axisId === axis.axisId);
      return point?.source === "direct" && point.comparisonScore !== null
        ? [{ entityId: entry.entityId, score: point.comparisonScore }]
        : [];
    });
    const scores = direct.map((entry) => entry.score);
    const strongest = scores.length ? Math.max(...scores) : null;
    const weakest = scores.length ? Math.min(...scores) : null;
    return {
      axisId: axis.axisId,
      strongestEntityIds: strongest === null
        ? []
        : direct.filter((entry) => entry.score === strongest).map((entry) => entry.entityId),
      weakestEntityIds: weakest === null
        ? []
        : direct.filter((entry) => entry.score === weakest).map((entry) => entry.entityId),
      spread: scores.length < 2 || strongest === null || weakest === null
        ? null
        : (strongest - weakest) / 100,
    };
  });
}

export function createFormalModelFiveAxisPreview(input: {
  definition: FiveAxisViewDefinition;
  vertexSet: FiveAxisVertexSet;
  modelId: string;
  modelRevisionId: string;
  modelFinalPullKg: number;
  finalPanelHash: string;
  componentSelections: Array<
    Pick<ModelComponentSelection, "itemPartId" | "componentId" | "values">
  >;
  componentSeries: FiveAxisSeries[];
  projectionReferenceAnchor: FiveAxisProjectionReferenceAnchor;
  projectionReferences: Array<
    FiveAxisProjectionReferenceEvidence & {
      state: "available" | "missing" | "error";
    }
  >;
}): ModelFiveAxisPreview {
  const componentSeries = input.componentSeries.map((series, comparisonOrder) => ({
    ...structuredClone(series),
    fishWeightGradeId: input.vertexSet.weightBandId,
    modelFinalPullKg: input.modelFinalPullKg,
    weightBandId: input.vertexSet.weightBandId,
    comparisonOrder,
  }));
  const projectionReferenceSetHash = hashProjectionReferenceSet({
    selectorVersion: input.projectionReferenceAnchor.selectorVersion,
    anchor: {
      baselineSnapshotId: input.projectionReferenceAnchor.baselineSnapshotId,
      seriesId: input.projectionReferenceAnchor.seriesId,
      skuId: input.projectionReferenceAnchor.skuId,
      skuRevisionId: input.projectionReferenceAnchor.skuRevisionId,
    },
    references: input.projectionReferences,
  });
  const preview: ModelFiveAxisPreview = {
    modelId: input.modelId,
    modelFinalPullKg: input.modelFinalPullKg,
    weightBandId: input.vertexSet.weightBandId,
    weightBandPolicyVersion: input.vertexSet.weightBandPolicyVersion,
    hashInputSchemaVersion: input.vertexSet.hashInputSchemaVersion,
    fishWeightGradeId: input.vertexSet.weightBandId,
    fiveAxisDefinitionId: input.definition.definitionId,
    fiveAxisDefinitionVersion: input.definition.version,
    fiveAxisDefinitionRevision: input.definition.revision,
    fiveAxisDefinitionHash: input.definition.definitionHash,
    fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
    vertexSetHash: input.vertexSet.vertexSetHash,
    sourceRevision: input.definition.sourceRevision,
    metrics: [],
    candidateSources: structuredClone(input.vertexSet.candidateSources),
    candidateSetHash: input.vertexSet.candidateSetHash,
    candidateEvidenceHash: input.vertexSet.candidateEvidenceHash,
    componentSeries,
    tackleFitComparison: {
      mode: "tackle_fit",
      referenceFishWeightGradeId: input.vertexSet.weightBandId,
      weightBandPolicyVersion: input.vertexSet.weightBandPolicyVersion,
      fiveAxisDefinitionId: input.definition.definitionId,
      fiveAxisDefinitionVersion: input.definition.version,
      fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
      vertexSetHash: input.vertexSet.vertexSetHash,
      scaleMode: "comparison_expanded",
      referenceRodEntityId: componentSeries[0]?.entityId ?? null,
      projectionReferenceAnchor: structuredClone(input.projectionReferenceAnchor),
      projectionReferenceSetHash,
      projectionReferences: structuredClone(input.projectionReferences),
      series: structuredClone(componentSeries),
      axisSummaries: buildAxisSummaries(input.definition, componentSeries),
      validationIssues: [],
    },
    inputHash: "",
  };
  preview.inputHash = hashFormalFiveAxisPreviewInput(preview);
  assertFormalModelFiveAxisPreview({
    definition: input.definition,
    preview,
    expectedCandidateSources: input.vertexSet.candidateSources,
    expectedModelId: input.modelId,
    expectedModelRevisionId: input.modelRevisionId,
    expectedSnapshotId: input.projectionReferenceAnchor.baselineSnapshotId,
    expectedSeriesId: input.projectionReferenceAnchor.seriesId,
    expectedSkuId: input.projectionReferenceAnchor.skuId,
    expectedSkuRevisionId: input.projectionReferenceAnchor.skuRevisionId,
    expectedProjectionReferences: input.projectionReferences,
    expectedFinalPanelHash: input.finalPanelHash,
    expectedComponentSelections: input.componentSelections,
    expectedModelFinalPullKg: input.modelFinalPullKg,
  });
  return preview;
}
