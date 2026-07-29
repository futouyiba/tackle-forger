import { jcsSha256Hex } from "./canonical-json";
import { matchV23FunctionTemplate, v23MatchedTemplateKey } from "./v23-function-template-matcher";
import {
  deriveV23SkuPull,
  v23EffectiveEntries,
  type V23PullFailureEvidence,
  type V23PullTraceStep,
  type V23ResolvedAffix,
} from "./v23-sku-derivation";
import type {
  ReductionStackingPolicyVersion,
  SeriesDefinition,
  SeriesPartRevision,
  SkuDrawerRevision,
  V23AffixDefinition,
  V23EnabledPartType,
  V23ProjectAffixPayload,
  V23SkuPullDerivationEvidence,
  V23StableContentRef,
  WorkspaceState,
} from "./types";

export type V23WriteAction =
  | "create_series"
  | "update_part_configuration"
  | "create_sku"
  | "create_project_affix"
  | "add_sku_affix"
  | "remove_inherited_affix"
  | "restore_inherited_affix"
  | "copy_sku_local_affix";

export class V23DomainActionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message);
    this.name = "V23DomainActionError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, code = "V23_ACTION_SCHEMA_INVALID"): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new V23DomainActionError(code, "v23 动作载荷必须是封闭对象。", 400);
  }
  return value as JsonRecord;
}

function assertKeys(value: JsonRecord, allowed: readonly string[]) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new V23DomainActionError(
      "V23_ACTION_UNKNOWN_FIELD",
      `v23 动作包含未知字段：${unknown.join("、")}。`,
      400,
    );
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new V23DomainActionError("V23_ACTION_SCHEMA_INVALID", `${field} 必须是非空字符串。`, 400);
  }
  return value.trim();
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new V23DomainActionError("V23_ACTION_SCHEMA_INVALID", `${field} 必须是安全整数。`, 400);
  }
  return value as number;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new V23DomainActionError("V23_ACTION_SCHEMA_INVALID", `${field} 必须是非空字符串数组。`, 400);
  }
  const normalized = value.map((entry) => entry.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new V23DomainActionError("V23_ACTION_DUPLICATE_ID", `${field} 不允许重复稳定 ID。`);
  }
  return normalized;
}

function stableRefs(value: unknown, field: string): V23StableContentRef[] {
  if (!Array.isArray(value)) {
    throw new V23DomainActionError("V23_ACTION_SCHEMA_INVALID", `${field} 必须是稳定引用数组。`, 400);
  }
  return value.map((entry) => {
    const item = record(entry);
    assertKeys(item, ["id", "revision", "contentHash"]);
    const ref = {
      id: text(item.id, `${field}.id`),
      revision: integer(item.revision, `${field}.revision`, 1),
      contentHash: text(item.contentHash, `${field}.contentHash`),
    };
    if (!/^[a-f0-9]{64}$/.test(ref.contentHash)) {
      throw new V23DomainActionError("V23_ACTION_SCHEMA_INVALID", `${field}.contentHash 无效。`, 400);
    }
    return ref;
  });
}

export function v23ActionInputHash(value: Omit<JsonRecord, "inputHash">): string {
  return jcsSha256Hex(value);
}

function requireInputHash(payload: JsonRecord): void {
  const supplied = text(payload.inputHash, "inputHash");
  const canonical = { ...payload };
  delete canonical.inputHash;
  if (supplied !== jcsSha256Hex(canonical)) {
    throw new V23DomainActionError("V23_ACTION_INPUT_HASH_MISMATCH", "v23 动作 inputHash 与规范输入不一致。", 409);
  }
}

function requireWorkspaceRevision(payload: JsonRecord, currentRevision: number): void {
  const expected = integer(payload.expectedWorkspaceRevision, "expectedWorkspaceRevision");
  if (expected !== currentRevision) {
    throw new V23DomainActionError("V23_WORKSPACE_REVISION_CONFLICT", "工作区 revision 已变化。", 409);
  }
}

function currentPart(state: WorkspaceState, partId: string): SeriesPartRevision {
  const heads = state.v23SeriesPartHeads.filter((head) => head.partId === partId);
  if (heads.length !== 1) throw new V23DomainActionError("V23_PART_HEAD_UNRESOLVED", "Part head 不唯一或不存在。", 409);
  const revisions = state.v23SeriesPartRevisions.filter(
    (entry) => entry.partId === partId && entry.revision === heads[0]!.revision,
  );
  if (revisions.length !== 1) throw new V23DomainActionError("V23_PART_HEAD_UNRESOLVED", "Part head 无法解析。", 409);
  return revisions[0]!;
}

function currentSku(state: WorkspaceState, skuId: string): SkuDrawerRevision {
  const heads = state.v23SkuDrawerHeads.filter((head) => head.skuId === skuId);
  if (heads.length !== 1) throw new V23DomainActionError("V23_SKU_HEAD_UNRESOLVED", "SKU head 不唯一或不存在。", 409);
  const revisions = state.v23SkuDrawerRevisions.filter(
    (entry) => entry.skuId === skuId && entry.revision === heads[0]!.revision,
  );
  if (revisions.length !== 1) throw new V23DomainActionError("V23_SKU_HEAD_UNRESOLVED", "SKU head 无法解析。", 409);
  return revisions[0]!;
}

function resolveDefinition(state: WorkspaceState, ref: V23StableContentRef): V23AffixDefinition {
  const matches = state.v23AffixDefinitions.filter(
    (entry) => entry.affixId === ref.id
      && entry.revision === ref.revision
      && entry.contentHash === ref.contentHash,
  );
  if (matches.length !== 1) {
    throw new V23DomainActionError("V23_AFFIX_REF_UNRESOLVED", `词条引用 ${ref.id}@${ref.revision} 无法解析。`);
  }
  return matches[0]!;
}

function resolveEntries(
  state: WorkspaceState,
  refs: readonly V23StableContentRef[],
): V23ResolvedAffix[] {
  return refs.map((ref) => ({ ref, payload: resolveDefinition(state, ref).payload }));
}

function currentReductionPolicy(state: WorkspaceState): ReductionStackingPolicyVersion | null {
  const candidates = state.reductionStackingPolicyVersions
    .filter((entry) => entry.status === "published")
    .sort((left, right) => left.version.localeCompare(right.version));
  return candidates.at(-1) ?? null;
}

function sourceEvidence(entry: V23ResolvedAffix) {
  return {
    ref: entry.ref,
    localCopyId: entry.localCopyId ?? null,
    copyHash: entry.copyHash ?? null,
    payloadHash: jcsSha256Hex(entry.payload),
  };
}

function projectTrace(
  trace: readonly V23PullTraceStep[],
  entries: readonly V23ResolvedAffix[],
) {
  const byId = new Map(entries.map((entry) => [entry.ref.id, entry]));
  const source = (id: string | null) => id === null ? null : sourceEvidence(byId.get(id)!);
  return trace.map((step) => ({
    source: source(step.affixId),
    operationId: step.operationId,
    operationIndex: step.operationIndex,
    operation: step.operation,
    direction: step.direction,
    magnitude: step.magnitude,
    clampMin: step.clampMin,
    clampMax: step.clampMax,
    ratioOperations: step.ratioOperations?.map((entry) => ({
      source: source(entry.affixId)!,
      operationId: entry.operationId,
      operationIndex: entry.operationIndex,
      direction: entry.direction,
      magnitude: entry.magnitude,
    })) ?? null,
    flatComponents: step.flatComponents?.map((entry) => ({
      source: source(entry.affixId)!,
      operationId: entry.operationId,
      operationIndex: entry.operationIndex,
      direction: entry.direction,
      magnitude: entry.magnitude,
      numericEvidence: entry.numericEvidence,
    })) ?? null,
    flatDeltaEvidence: step.flatDeltaEvidence,
    beforeKg: step.beforeKg,
    afterKg: step.afterKg,
    numericEvidence: step.numericEvidence,
  }));
}

function projectFailure(
  failure: V23PullFailureEvidence,
  entries: readonly V23ResolvedAffix[],
) {
  const entry = failure.affixId === null
    ? undefined
    : entries.find((candidate) => candidate.ref.id === failure.affixId);
  return {
    source: entry ? sourceEvidence(entry) : null,
    operationId: failure.operationId,
    operationIndex: failure.operationIndex,
    stage: failure.stage,
    numericEvidence: failure.numericEvidence,
  };
}

function deriveSku(
  state: WorkspaceState,
  part: SeriesPartRevision,
  sku: Omit<SkuDrawerRevision, "match" | "derivation" | "validationSummary" | "contentHash">,
): SkuDrawerRevision {
  const mutableSku = { ...sku } as Partial<SkuDrawerRevision>;
  delete mutableSku.match;
  delete mutableSku.derivation;
  delete mutableSku.validationSummary;
  delete mutableSku.contentHash;
  const key = v23MatchedTemplateKey({ ...part, weightBandId: sku.weightBandId });
  const match = matchV23FunctionTemplate(key, state.v23FunctionTemplates ?? []);
  const validationSummary: SkuDrawerRevision["validationSummary"] = [];
  let derivation: V23SkuPullDerivationEvidence = { status: "UNRESOLVED" };
  if (match.status !== "VALID") {
    validationSummary.push({
      code: match.status,
      severity: "BLOCKER",
      gate: "PUBLISH",
      state: "OPEN",
      message: "重量段必须精确匹配唯一的六键功能模板。",
    });
  } else {
    const inherited = resolveEntries(state, part.defaultEntryRefs);
    const added = sku.addedEntryRefs.map((entry) => ({
      ref: entry.ref,
      payload: resolveDefinition(state, entry.ref).payload,
    }));
    const copies = sku.localEntryCopies.map((entry) => ({
      ref: entry.sourceRef,
      payload: entry.payload,
      localCopyId: entry.localCopyId,
      copyHash: entry.copyHash,
    }));
    const effective = v23EffectiveEntries(
      inherited,
      sku.removedInheritedEntryIds,
      added,
      copies,
    );
    const template = (state.v23FunctionTemplates ?? []).find(
      (entry) => entry.ref.templateId === match.functionTemplateRef.templateId
        && entry.ref.revisionId === match.functionTemplateRef.revisionId
        && entry.ref.contentHash === match.functionTemplateRef.contentHash,
    )!;
    const policy = currentReductionPolicy(state);
    if (!policy) {
      throw new V23DomainActionError(
        "V23_OPEN_001_POLICY_VERSION_REQUIRED",
        "正式 SKU 派生必须绑定已发布的 canonical reduction policy。",
      );
    }
    const derived = deriveV23SkuPull(template.baselinePullKg, effective, {
      formal: true,
      publishedReductionPolicy: policy,
    });
    const policyRef = { id: policy.id, version: policy.version, contentHash: policy.contentHash };
    if (derived.status === "VALID") {
      derivation = {
        status: "VALID",
        templateRef: match.functionTemplateRef,
        reductionPolicyRef: policyRef,
        baselinePullKg: derived.baselinePullKg,
        targetPullKg: derived.targetPullKg,
        effectiveEntries: effective.map(sourceEvidence),
        trace: projectTrace(derived.trace, effective),
        inputHash: derived.inputHash,
      };
    } else {
      derivation = {
        status: "INVALID",
        templateRef: match.functionTemplateRef,
        reductionPolicyRef: policyRef,
        effectiveEntries: effective.map(sourceEvidence),
        code: derived.code,
        failureEvidence: projectFailure(derived.failureEvidence, effective),
        inputHash: derived.inputHash,
      };
      validationSummary.push({
        code: derived.code,
        severity: "BLOCKER",
        gate: "PUBLISH",
        state: "OPEN",
        message: "SKU 拉力派生失败。",
      });
    }
  }
  const withoutHash = {
    ...(mutableSku as Omit<SkuDrawerRevision, "match" | "derivation" | "validationSummary" | "contentHash">),
    match,
    derivation,
    validationSummary,
  };
  return { ...withoutHash, contentHash: jcsSha256Hex(withoutHash) };
}

function parsePart(
  value: unknown,
  seriesId: string,
  revision: number,
): SeriesPartRevision {
  const part = record(value);
  assertKeys(part, [
    "partId", "partType", "fishingMethodId", "materialTypeId", "functionProfileId",
    "functionIntensity", "weightBandIds", "defaultEntryRefs", "technologyRefs",
  ]);
  const partType = text(part.partType, "partType");
  if (!["rod", "reel", "line"].includes(partType)) {
    throw new V23DomainActionError("V23_PART_TYPE_INVALID", "Part 只允许 rod、reel、line。");
  }
  const input = {
    partId: text(part.partId, "partId"),
    seriesId,
    revision,
    partType: partType as V23EnabledPartType,
    fishingMethodId: text(part.fishingMethodId, "fishingMethodId"),
    materialTypeId: text(part.materialTypeId, "materialTypeId"),
    functionProfileId: text(part.functionProfileId, "functionProfileId"),
    functionIntensity: integer(part.functionIntensity, "functionIntensity", 1) as 1 | 2 | 3,
    weightBandIds: stringArray(part.weightBandIds, "weightBandIds"),
    defaultEntryRefs: stableRefs(part.defaultEntryRefs, "defaultEntryRefs"),
    technologyRefs: stableRefs(part.technologyRefs, "technologyRefs"),
  };
  if (input.functionIntensity > 3 || input.weightBandIds.length === 0) {
    throw new V23DomainActionError("V23_PART_CONFIGURATION_INVALID", "Part 强度或重量段无效。");
  }
  const inputFingerprint = jcsSha256Hex(input);
  return {
    ...input,
    inputFingerprint,
    contentHash: jcsSha256Hex({ ...input, inputFingerprint }),
  };
}

function placeholderSeries(payload: JsonRecord, seriesId: string): SeriesDefinition {
  const now = new Date(0).toISOString();
  return {
    id: seriesId,
    collectionId: typeof payload.collectionId === "string" && payload.collectionId.trim()
      ? payload.collectionId.trim()
      : undefined,
    revision: 1,
    name: text(payload.name, "name"),
    concept: text(payload.concept, "concept"),
    fishingMethodId: "",
    typeId: "",
    qualityId: "quality_c_green",
    coreFunctionId: "",
    functionIntensityPolicy: { mode: "fixed", intensity: 1 },
    coreAffixIds: [],
    secondaryAffixPoolIds: [],
    forbiddenAffixIds: [],
    targetPullSpecifications: [],
    signature: [],
    patchIds: [],
    skuIds: [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

function expectedEntityRevision(payload: JsonRecord, field: string, actual: number) {
  const expected = integer(payload[field], field, 1);
  if (expected !== actual) {
    throw new V23DomainActionError("V23_ENTITY_REVISION_CONFLICT", `${field} 已变化。`, 409);
  }
}

function replacePartHead(state: WorkspaceState, part: SeriesPartRevision): WorkspaceState {
  return {
    ...state,
    v23SeriesPartRevisions: [...state.v23SeriesPartRevisions, part],
    v23SeriesPartHeads: state.v23SeriesPartHeads.map(
      (head) => head.partId === part.partId ? { ...head, revision: part.revision } : head,
    ),
  };
}

function replaceSkuHeads(state: WorkspaceState, skus: readonly SkuDrawerRevision[]): WorkspaceState {
  const nextRevisionById = new Map(skus.map((sku) => [sku.skuId, sku.revision]));
  return {
    ...state,
    v23SkuDrawerRevisions: [...state.v23SkuDrawerRevisions, ...skus],
    v23SkuDrawerHeads: state.v23SkuDrawerHeads.map((head) => {
      const revision = nextRevisionById.get(head.skuId);
      return revision === undefined ? head : { ...head, revision };
    }),
  };
}

export function previewWeightBandSkus(
  state: WorkspaceState,
  input: unknown,
): { match: ReturnType<typeof matchV23FunctionTemplate>; skuHeads: SkuDrawerRevision[] } {
  const payload = record(input);
  assertKeys(payload, ["partId", "expectedPartRevision", "weightBandId"]);
  const part = currentPart(state, text(payload.partId, "partId"));
  expectedEntityRevision(payload, "expectedPartRevision", part.revision);
  const weightBandId = text(payload.weightBandId, "weightBandId");
  if (!part.weightBandIds.includes(weightBandId)) {
    throw new V23DomainActionError("V23_WEIGHT_BAND_NOT_SELECTED", "重量段不属于当前 Part。");
  }
  return {
    match: matchV23FunctionTemplate(
      v23MatchedTemplateKey({ ...part, weightBandId }),
      state.v23FunctionTemplates ?? [],
    ),
    skuHeads: state.v23SkuDrawerHeads
      .map((head) => currentSku(state, head.skuId))
      .filter((sku) => sku.partId === part.partId && sku.weightBandId === weightBandId),
  };
}

export function executeV23DomainAction(
  state: WorkspaceState,
  workspaceRevision: number,
  action: V23WriteAction,
  input: unknown,
): { state: WorkspaceState; result: JsonRecord } {
  const payload = record(input);
  requireInputHash(payload);
  requireWorkspaceRevision(payload, workspaceRevision);

  if (action === "create_series") {
    assertKeys(payload, [
      "expectedWorkspaceRevision", "inputHash", "seriesId", "collectionId", "name", "concept", "parts",
    ]);
    const seriesId = text(payload.seriesId, "seriesId");
    if (state.seriesDefinitions.some((series) => series.id === seriesId)) {
      throw new V23DomainActionError("V23_SERIES_ID_CONFLICT", "Series 稳定 ID 已存在。", 409);
    }
    if (!Array.isArray(payload.parts) || payload.parts.length < 1 || payload.parts.length > 3) {
      throw new V23DomainActionError("V23_SERIES_PART_COUNT_INVALID", "Series 必须包含 1–3 个 Part。");
    }
    const parts = payload.parts.map((entry) => parsePart(entry, seriesId, 1));
    if (new Set(parts.map((entry) => entry.partId)).size !== parts.length
      || new Set(parts.map((entry) => entry.partType)).size !== parts.length) {
      throw new V23DomainActionError("V23_SERIES_PART_DUPLICATE", "同一 Series 的 Part ID 与类型必须唯一。");
    }
    parts.forEach((part) => {
      part.defaultEntryRefs.forEach((ref) => resolveDefinition(state, ref));
      if (part.technologyRefs.length) {
        throw new V23DomainActionError("V23_TECHNOLOGY_REF_WRITE_UNAVAILABLE", "当前版本不允许新写 Technology 引用。");
      }
    });
    const series = placeholderSeries(payload, seriesId);
    return {
      state: {
        ...state,
        seriesDefinitions: [...state.seriesDefinitions, series],
        v23SeriesPartRevisions: [...state.v23SeriesPartRevisions, ...parts],
        v23SeriesPartHeads: [
          ...state.v23SeriesPartHeads,
          ...parts.map((part) => ({ seriesId, partId: part.partId, revision: part.revision })),
        ],
      },
      result: { seriesId, partIds: parts.map((part) => part.partId) },
    };
  }

  if (action === "update_part_configuration") {
    assertKeys(payload, [
      "expectedWorkspaceRevision", "inputHash", "partId", "expectedPartRevision", "configuration",
    ]);
    const existing = currentPart(state, text(payload.partId, "partId"));
    expectedEntityRevision(payload, "expectedPartRevision", existing.revision);
    const nextPart = parsePart(payload.configuration, existing.seriesId, existing.revision + 1);
    if (nextPart.partId !== existing.partId || nextPart.partType !== existing.partType) {
      throw new V23DomainActionError("V23_PART_IDENTITY_IMMUTABLE", "Part 稳定 ID 与类型不可改写。");
    }
    const withPart = replacePartHead(state, nextPart);
    const affected = withPart.v23SkuDrawerHeads
      .map((head) => currentSku(withPart, head.skuId))
      .filter((sku) => sku.partId === nextPart.partId)
      .map((sku) => deriveSku(withPart, nextPart, {
        ...sku,
        revision: sku.revision + 1,
        partRevision: nextPart.revision,
      }));
    return {
      state: replaceSkuHeads(withPart, affected),
      result: {
        partId: nextPart.partId,
        partRevision: nextPart.revision,
        rederivedSkuIds: affected.map((sku) => sku.skuId),
      },
    };
  }

  if (action === "create_sku") {
    assertKeys(payload, [
      "expectedWorkspaceRevision", "inputHash", "skuId", "partId", "expectedPartRevision",
      "weightBandId", "displayOrder",
    ]);
    const part = currentPart(state, text(payload.partId, "partId"));
    expectedEntityRevision(payload, "expectedPartRevision", part.revision);
    const skuId = text(payload.skuId, "skuId");
    if (state.v23SkuDrawerHeads.some((head) => head.skuId === skuId)) {
      throw new V23DomainActionError("V23_SKU_ID_CONFLICT", "SKU 稳定 ID 已存在。", 409);
    }
    const weightBandId = text(payload.weightBandId, "weightBandId");
    if (!part.weightBandIds.includes(weightBandId)) {
      throw new V23DomainActionError("V23_WEIGHT_BAND_NOT_SELECTED", "重量段不属于当前 Part。");
    }
    const sku = deriveSku(state, part, {
      skuId,
      revision: 1,
      seriesId: part.seriesId,
      partId: part.partId,
      partRevision: part.revision,
      weightBandId,
      removedInheritedEntryIds: [],
      addedEntryRefs: [],
      localEntryCopies: [],
      technologyRefs: [],
      quality: { status: "UNASSESSED" },
      skuPatchIds: [],
      modelIds: [],
      defaultModelId: null,
      displayOrder: integer(payload.displayOrder, "displayOrder"),
      status: "draft",
    });
    return {
      state: {
        ...state,
        v23SkuDrawerRevisions: [...state.v23SkuDrawerRevisions, sku],
        v23SkuDrawerHeads: [...state.v23SkuDrawerHeads, { skuId, revision: 1 }],
      },
      result: { skuId, skuRevision: 1 },
    };
  }

  if (action === "create_project_affix") {
    assertKeys(payload, [
      "expectedWorkspaceRevision", "inputHash", "affixId", "affixPayload",
    ]);
    const affixId = text(payload.affixId, "affixId");
    if (state.v23AffixDefinitions.some((entry) => entry.affixId === affixId)) {
      throw new V23DomainActionError("V23_AFFIX_ID_CONFLICT", "词条稳定 ID 已存在。", 409);
    }
    const affixPayload = structuredClone(record(payload.affixPayload)) as unknown as V23ProjectAffixPayload;
    const definition = {
      affixId,
      revision: 1,
      payload: affixPayload,
      contentHash: jcsSha256Hex({ affixId, revision: 1, payload: affixPayload }),
    };
    return {
      state: { ...state, v23AffixDefinitions: [...state.v23AffixDefinitions, definition] },
      result: { affixId, affixRevision: 1, contentHash: definition.contentHash },
    };
  }

  const commonSkuKeys = ["expectedWorkspaceRevision", "inputHash", "skuId", "expectedSkuRevision"];
  if (action === "add_sku_affix") assertKeys(payload, [...commonSkuKeys, "affixRef"]);
  else if (action === "remove_inherited_affix" || action === "restore_inherited_affix") {
    assertKeys(payload, [...commonSkuKeys, "inheritedEntryId"]);
  } else {
    assertKeys(payload, [...commonSkuKeys, "affixRef", "localCopyId"]);
  }
  const existing = currentSku(state, text(payload.skuId, "skuId"));
  expectedEntityRevision(payload, "expectedSkuRevision", existing.revision);
  const part = currentPart(state, existing.partId);
  let addedEntryRefs = structuredClone(existing.addedEntryRefs);
  let removedInheritedEntryIds = [...existing.removedInheritedEntryIds];
  let localEntryCopies = structuredClone(existing.localEntryCopies);

  if (action === "add_sku_affix") {
    const [ref] = stableRefs([payload.affixRef], "affixRef");
    resolveDefinition(state, ref!);
    if (addedEntryRefs.some((entry) => entry.ref.id === ref!.id)
      || part.defaultEntryRefs.some((entry) => entry.id === ref!.id)
      || localEntryCopies.some((entry) => entry.sourceRef.id === ref!.id)) {
      throw new V23DomainActionError("V23_SKU_AFFIX_DUPLICATE", "SKU 已包含同一稳定词条贡献。", 409);
    }
    addedEntryRefs = [...addedEntryRefs, { kind: "STABLE_AFFIX_REF", ref: ref! }];
  } else if (action === "remove_inherited_affix") {
    const inheritedEntryId = text(payload.inheritedEntryId, "inheritedEntryId");
    if (!part.defaultEntryRefs.some((entry) => entry.id === inheritedEntryId)
      || removedInheritedEntryIds.includes(inheritedEntryId)) {
      throw new V23DomainActionError("V23_INHERITED_AFFIX_NOT_ACTIVE", "继承词条不存在或已移除。", 409);
    }
    removedInheritedEntryIds = [...removedInheritedEntryIds, inheritedEntryId];
  } else if (action === "restore_inherited_affix") {
    const inheritedEntryId = text(payload.inheritedEntryId, "inheritedEntryId");
    if (!removedInheritedEntryIds.includes(inheritedEntryId)) {
      throw new V23DomainActionError("V23_INHERITED_AFFIX_NOT_REMOVED", "继承词条当前未被移除。", 409);
    }
    removedInheritedEntryIds = removedInheritedEntryIds.filter((id) => id !== inheritedEntryId);
  } else {
    const [sourceRef] = stableRefs([payload.affixRef], "affixRef");
    const source = resolveDefinition(state, sourceRef!);
    const localCopyId = text(payload.localCopyId, "localCopyId");
    if (localEntryCopies.some((entry) => entry.localCopyId === localCopyId)
      || localEntryCopies.some((entry) => entry.sourceRef.id === sourceRef!.id)) {
      throw new V23DomainActionError("V23_LOCAL_AFFIX_COPY_CONFLICT", "本地词条副本身份或来源重复。", 409);
    }
    const copyHash = jcsSha256Hex({ localCopyId, sourceRef, payload: source.payload });
    localEntryCopies = [
      ...localEntryCopies,
      { kind: "LOCAL_AFFIX_COPY", localCopyId, sourceRef: sourceRef!, payload: source.payload, copyHash },
    ];
  }

  const next = deriveSku(state, part, {
    ...existing,
    revision: existing.revision + 1,
    addedEntryRefs,
    removedInheritedEntryIds,
    localEntryCopies,
  });
  return {
    state: replaceSkuHeads(state, [next]),
    result: { skuId: next.skuId, skuRevision: next.revision },
  };
}
