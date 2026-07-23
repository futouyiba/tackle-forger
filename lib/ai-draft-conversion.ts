import {
  buildWorkspaceAssessmentRequestProjection,
  type WorkspaceAssessmentRequestProjection,
} from "./ai-assessment-request";
import type { AIAssessmentRetentionRecord, AIAcceptedArtifactProvenance } from "./ai-retention";
import { evaluateAIAssessmentFreshness } from "./ai-retention";
import { prepareAIRequest, type SafeValue } from "./ai-outbound";
import {
  createAuthoritativePatchObjectFromWorkspace,
  currentPatchPanelValuesFromWorkspace,
  evaluateAuthoritativePatchFinalRanges,
  preparePatchOperationFromWorkspace,
} from "./patch-authority";
import { buildPatchRevision } from "./patch-ledger";
import { findPublishedPatchOffsetPolicy } from "./patch-offset-policy";
import { validateSeriesInvariants } from "./product-model";
import { deriveProjection, deterministicHash } from "./rule-kernel";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
} from "./feishu-workbook";
import type {
  AIDraftEvidenceRef,
  AIArtifactProvenanceSyncRecord,
  AIRuleSourceChangeDraft,
  AdjustmentRule,
  PatchRevisionRecord,
  PurchasableModel,
  ValidationIssue,
  WorkspaceState,
} from "./types";
import type { CapabilityCode } from "./interaction-contracts";
import type { FancyHubRecommendationV1, FancyHubSuggestedChangeV1 } from "./fancy-hub";

export type AIDraftConversionErrorCode =
  | "AI_ASSESSMENT_NOT_ACTIONABLE"
  | "AI_ASSESSMENT_OWNER_MISMATCH"
  | "AI_CAPABILITY_MISSING"
  | "AI_DRAFT_COMMAND_INVALID"
  | "AI_DRAFT_EVIDENCE_INVALID"
  | "AI_DRAFT_IDEMPOTENCY_CONFLICT"
  | "AI_DRAFT_RECOMMENDATION_INVALID"
  | "AI_DRAFT_TARGET_FROZEN"
  | "AI_DRAFT_TARGET_REVISION_CHANGED"
  | "AI_PATCH_CONFLICT_REQUIRES_REBASE"
  | "AI_PATCH_HARD_VALIDATION_CONFLICT"
  | "AI_RULE_IMPACT_PREVIEW_INCOMPLETE"
  | "AI_RULE_SOURCE_REVISION_CHANGED"
  | "AI_RULE_TARGET_INVALID";

export class AIDraftConversionError extends Error {
  constructor(public readonly code: AIDraftConversionErrorCode, message: string) {
    super(message);
    this.name = "AIDraftConversionError";
  }
}

export interface AITargetRuleRef {
  spreadsheetToken: string;
  sheetId: string;
  stableRuleId: string;
  parameterKey: string;
  sourceRevision: string;
}

export interface AIDraftConversionCommand {
  mode: "preview" | "create";
  recommendationId: string;
  assessmentInputHash: string;
  selectedChangeIds: string[];
  userReason: string;
  idempotencyKey: string;
  targetModelRef?: { entityId: string; revisionId: string };
  targetRuleRef?: AITargetRuleRef;
}

export interface AIDeterministicChangePreview {
  changeId: string;
  parameterKey: string;
  before: unknown;
  operation: "set" | "add" | "multiply" | "clear";
  operand: unknown;
  after: unknown;
  traceHash: string;
}

export interface AIDraftDiffPreview {
  validation: {
    beforeIssueCodes: string[];
    afterIssueCodes: string[];
    newBlockingIssueCodes: string[];
  };
  fiveAxis: {
    status: "UNCHANGED" | "AFFECTED_RECALCULATION_REQUIRED";
    affectedAxisIds: string[];
  };
  affinity: { status: "UNCHANGED_BY_PATCH" };
  invariants: {
    beforeIssueCodes: string[];
    afterIssueCodes: string[];
    newBlockingIssueCodes: string[];
  };
}

export interface AIDraftPreview {
  mode: "preview";
  kind: "model_patch" | "rule_source_change_draft";
  assessmentId: string;
  recommendationId: string;
  assessmentInputHash: string;
  previewHash: string;
  targetRef: { entityId: string; revisionId: string } | AITargetRuleRef;
  changes: AIDeterministicChangePreview[];
  diffs: AIDraftDiffPreview;
  evidenceRefs: AIDraftEvidenceRef[];
  canCreate: true;
}

export type AIDraftArtifactPlan =
  | {
      kind: "model_patch";
      preview: AIDraftPreview;
      patch: PatchRevisionRecord;
      artifactRef: {
        artifactType: "model_patch";
        artifactId: string;
        state: "DRAFT";
      };
      commandHash: string;
      provenanceSyncRecord: AIArtifactProvenanceSyncRecord;
    }
  | {
      kind: "rule_source_change_draft";
      preview: AIDraftPreview;
      ruleDraft: AIRuleSourceChangeDraft;
      artifactRef: {
        artifactType: "rule_source_change_draft";
        artifactId: string;
        state: "LOCAL_DRAFT";
      };
      commandHash: string;
      provenanceSyncRecord: AIArtifactProvenanceSyncRecord;
    };

type ParsedSemanticContent = {
  recommendations: FancyHubRecommendationV1[];
  evidenceRefs: Array<{
    evidenceType: AIDraftEvidenceRef["evidenceType"];
    evidenceAlias: string;
    contentHash: string;
  }>;
};

function invalid(message: string): never {
  throw new AIDraftConversionError("AI_DRAFT_COMMAND_INVALID", message);
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) invalid(`${label} 格式无效。`);
}

function normalizeCommand(command: AIDraftConversionCommand): AIDraftConversionCommand {
  if (command.mode !== "preview" && command.mode !== "create") invalid("mode 无效。");
  assertSafeIdentifier(command.recommendationId, "recommendationId");
  if (!/^[a-f0-9]{64}$/.test(command.assessmentInputHash)) invalid("assessmentInputHash 无效。");
  if (!Array.isArray(command.selectedChangeIds) || !command.selectedChangeIds.length || command.selectedChangeIds.length > 32) {
    invalid("selectedChangeIds 必须包含 1..32 项。");
  }
  command.selectedChangeIds.forEach((entry) => assertSafeIdentifier(entry, "selectedChangeId"));
  if (new Set(command.selectedChangeIds).size !== command.selectedChangeIds.length) invalid("selectedChangeIds 不能重复。");
  const userReason = command.userReason.trim();
  if ((command.mode === "create" && !userReason) || Buffer.byteLength(userReason, "utf8") > 2_048) {
    invalid("create 的 userReason 必须是 2048 字节以内的非空文本；preview 可为空。");
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(command.idempotencyKey)) invalid("idempotencyKey 格式无效。");
  return { ...structuredClone(command), userReason };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSemanticContent(value: unknown): ParsedSemanticContent {
  if (!plainObject(value) || !Array.isArray(value.recommendations) || !Array.isArray(value.evidenceRefs)) {
    throw new AIDraftConversionError("AI_ASSESSMENT_NOT_ACTIONABLE", "AI 语义结果不存在或格式无效。");
  }
  return value as unknown as ParsedSemanticContent;
}

function safeValue(value: SafeValue): unknown {
  if (!plainObject(value) || !["number", "boolean", "enum", "null"].includes(String(value.kind))) {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "建议变化不是受支持的 SafeValue。");
  }
  if (value.kind === "number" && (typeof value.value !== "number" || !Number.isFinite(value.value))) {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "建议变化包含非有限数。");
  }
  if (value.kind === "null") return null;
  return value.value;
}

function currentInput(
  state: WorkspaceState,
  record: AIAssessmentRetentionRecord,
): { projection: WorkspaceAssessmentRequestProjection; inputHash: string } {
  const metadata = record.metadata;
  if (!metadata?.scope || (metadata.scope.scopeType !== "model" && metadata.scope.scopeType !== "series")) {
    throw new AIDraftConversionError("AI_ASSESSMENT_NOT_ACTIONABLE", "评估缺少可重建的作用域。");
  }
  const projection = buildWorkspaceAssessmentRequestProjection({
    state,
    scope: { scopeType: metadata.scope.scopeType, scopeId: metadata.scope.scopeId },
    assessmentId: metadata.assessmentId,
    model: metadata.modelDescriptor,
  });
  return { projection, inputHash: prepareAIRequest({ envelope: projection.envelope }).inputHash };
}

function resolveEvidence(
  recommendation: FancyHubRecommendationV1,
  semantic: ParsedSemanticContent,
  projection: WorkspaceAssessmentRequestProjection,
): AIDraftEvidenceRef[] {
  if (!recommendation.evidenceAliases.length) {
    throw new AIDraftConversionError("AI_DRAFT_EVIDENCE_INVALID", "AI 建议缺少 EvidenceRef。");
  }
  const currentByAlias = new Map(projection.envelope.evidenceRefs.map((entry) => [entry.evidenceAlias, entry]));
  const semanticByAlias = new Map(semantic.evidenceRefs.map((entry) => [entry.evidenceAlias, entry]));
  const referencesByAlias = new Map(projection.requestAliasMapping.map((entry) => [entry.alias, entry.reference]));
  return recommendation.evidenceAliases.map((alias) => {
    const current = currentByAlias.get(alias);
    const retained = semanticByAlias.get(alias);
    const reference = referencesByAlias.get(alias);
    if (!current || !retained || !reference || reference.referenceKindCode !== "evidence"
      || retained.evidenceType !== current.evidenceType
      || retained.contentHash !== current.contentHash) {
      throw new AIDraftConversionError("AI_DRAFT_EVIDENCE_INVALID", "EvidenceRef 已变化或无法解析。");
    }
    return {
      evidenceType: current.evidenceType,
      refId: reference.stableLocalId,
      ...(reference.stableRevisionId ? { revisionId: reference.stableRevisionId } : {}),
      contentHash: current.contentHash,
    };
  });
}

function selectedChanges(
  recommendation: FancyHubRecommendationV1,
  ids: string[],
): FancyHubSuggestedChangeV1[] {
  const byId = new Map(recommendation.suggestedChanges.map((entry) => [entry.changeId, entry]));
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((entry) => !entry)) {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "选择项不属于该建议。");
  }
  const result = selected as FancyHubSuggestedChangeV1[];
  if (new Set(result.map((entry) => entry.parameterKey)).size !== result.length) {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "同一次草稿转换不能对同一参数提交多个竞争操作。");
  }
  return result;
}

function issueCodes(issues: ValidationIssue[]): string[] {
  return [...new Set(issues.map((entry) => entry.code))].sort();
}

function blockingIssueCodes(issues: ValidationIssue[]): string[] {
  return [...new Set(issues
    .filter((entry) => entry.level === "error" || entry.severity === "ERROR" || entry.severity === "BLOCKER")
    .map((entry) => entry.code))].sort();
}

function newCodes(before: string[], after: string[]): string[] {
  const existing = new Set(before);
  return after.filter((entry) => !existing.has(entry));
}

function modelAndSeries(state: WorkspaceState, modelId: string) {
  const model = state.purchasableModels.find((entry) => entry.id === modelId);
  const sku = state.skuDrawers.find((entry) => entry.id === model?.skuId);
  const series = state.seriesDefinitions.find((entry) => entry.id === sku?.seriesId);
  if (!model || !sku || !series) {
    throw new AIDraftConversionError("AI_DRAFT_TARGET_REVISION_CHANGED", "目标 Model 的父链不存在。");
  }
  return { model, sku, series };
}

function invariantDiff(
  state: WorkspaceState,
  model: PurchasableModel,
  afterValues: Record<string, number | string>,
): AIDraftDiffPreview["invariants"] {
  const { series } = modelAndSeries(state, model.id);
  const skus = state.skuDrawers.filter((entry) => entry.seriesId === series.id);
  const models = state.purchasableModels.filter((entry) => skus.some((sku) => sku.id === entry.skuId));
  const beforePanels = models.map((entry) => ({
    modelId: entry.id,
    skuId: entry.skuId,
    values: currentPatchPanelValuesFromWorkspace({ state, scopeType: "model", subjectEntityId: entry.id }),
  }));
  const afterPanels = beforePanels.map((entry) => entry.modelId === model.id
    ? { ...entry, values: structuredClone(afterValues) }
    : entry);
  const base = {
    series,
    skus,
    models,
    projections: state.derivedProjections,
    parameters: state.parameters,
  };
  const before = validateSeriesInvariants({ ...base, resolvedPanels: beforePanels });
  const after = validateSeriesInvariants({ ...base, resolvedPanels: afterPanels });
  const beforeBlocking = blockingIssueCodes(before);
  const afterBlocking = blockingIssueCodes(after);
  return {
    beforeIssueCodes: issueCodes(before),
    afterIssueCodes: issueCodes(after),
    newBlockingIssueCodes: newCodes(beforeBlocking, afterBlocking),
  };
}

function fiveAxisDiff(state: WorkspaceState, changes: AIDeterministicChangePreview[]): AIDraftDiffPreview["fiveAxis"] {
  const definition = [...state.fiveAxisViewDefinitions]
    .filter((entry) => entry.publicationState === "PUBLISHED")
    .sort((left, right) => right.revision - left.revision)[0];
  const changedKeys = new Set(changes.map((entry) => entry.parameterKey));
  const affectedAxisIds = definition?.axes
    .filter((axis) => axis.sourceParameterKeys.some((key) => changedKeys.has(key)))
    .map((axis) => axis.axisId)
    .sort() ?? [];
  return {
    status: affectedAxisIds.length ? "AFFECTED_RECALCULATION_REQUIRED" : "UNCHANGED",
    affectedAxisIds,
  };
}

function patchRangeDiff(
  state: WorkspaceState,
  target: PatchRevisionRecord,
): AIDraftDiffPreview["validation"] {
  const beforeTarget: PatchRevisionRecord = {
    ...structuredClone(target),
    patchId: `${target.patchId}:before`,
    operations: [],
    revisionHash: "before",
  };
  const policy = findPublishedPatchOffsetPolicy(state.workspacePolicies);
  const before = evaluateAuthoritativePatchFinalRanges({
    policy,
    gate: "REVIEW",
    objects: [createAuthoritativePatchObjectFromWorkspace(state, beforeTarget)],
  });
  const after = evaluateAuthoritativePatchFinalRanges({
    policy,
    gate: "REVIEW",
    objects: [createAuthoritativePatchObjectFromWorkspace(state, target)],
  });
  const beforeBlocking = blockingIssueCodes(before.issues);
  const afterBlocking = blockingIssueCodes(after.issues);
  return {
    beforeIssueCodes: issueCodes(before.issues),
    afterIssueCodes: issueCodes(after.issues),
    newBlockingIssueCodes: newCodes(beforeBlocking, afterBlocking),
  };
}

function ensureNoPendingConflict(
  state: WorkspaceState,
  modelId: string,
  changes: AIDeterministicChangePreview[],
  idempotencyKey: string,
  commandHash: string,
): void {
  const parameters = new Set(changes.map((entry) => entry.parameterKey));
  const conflict = state.patchLedger.revisions.some((revision) =>
    revision.subjectEntityId === modelId
    && ["DRAFT", "PENDING_REVIEW", "APPROVED", "REBASE_REQUIRED"].includes(revision.state)
    && !(plainObject(revision.rawPayload)
      && revision.rawPayload.idempotencyKey === idempotencyKey
      && revision.rawPayload.commandHash === commandHash)
    && revision.operations.some((operation) => parameters.has(operation.parameterKey)
      && (operation.operation === "set" || operation.operation === "clear")));
  if (conflict) {
    throw new AIDraftConversionError(
      "AI_PATCH_CONFLICT_REQUIRES_REBASE",
      "目标参数已有未决 set/clear Patch，必须先合并或 rebase。",
    );
  }
}

function createProvenance(
  record: AIAssessmentRetentionRecord,
  recommendation: FancyHubRecommendationV1,
  evidenceRefs: AIDraftEvidenceRef[],
  humanDiff: unknown,
  artifactStableRefs: string[],
): AIAcceptedArtifactProvenance {
  return {
    assessmentId: record.metadata!.assessmentId,
    modelDescriptor: structuredClone(record.metadata!.modelDescriptor),
    selectedRecommendation: structuredClone(recommendation),
    evidenceContentHashes: evidenceRefs.map((entry) => entry.contentHash),
    humanDiff: structuredClone(humanDiff),
    artifactStableRefs: structuredClone(artifactStableRefs),
    retainedWithArtifact: true,
  };
}

function commandIdentity(command: AIDraftConversionCommand): unknown {
  return {
    recommendationId: command.recommendationId,
    assessmentInputHash: command.assessmentInputHash,
    selectedChangeIds: command.selectedChangeIds,
    userReason: command.userReason,
    idempotencyKey: command.idempotencyKey,
    targetModelRef: command.targetModelRef,
    targetRuleRef: command.targetRuleRef,
  };
}

export function planAIDraftConversion(input: {
  state: WorkspaceState;
  record: AIAssessmentRetentionRecord;
  assessmentId: string;
  actorStableId: string;
  actorDisplayName: string;
  capabilities: Iterable<CapabilityCode>;
  command: AIDraftConversionCommand;
  now: string;
}): AIDraftArtifactPlan {
  const command = normalizeCommand(input.command);
  const metadata = input.record.metadata;
  if (!metadata || metadata.assessmentId !== input.assessmentId || metadata.actorStableId !== input.actorStableId) {
    throw new AIDraftConversionError("AI_ASSESSMENT_OWNER_MISMATCH", "评估不存在或不属于当前用户。");
  }
  const semantic = parseSemanticContent(input.record.semanticContent);
  const scope = metadata.scope;
  if (!scope) {
    throw new AIDraftConversionError("AI_ASSESSMENT_NOT_ACTIONABLE", "评估缺少可重建的作用域。");
  }
  const { projection, inputHash } = currentInput(input.state, input.record);
  const freshness = evaluateAIAssessmentFreshness(metadata, {
    scopeType: projection.operationMetadataContext.scopeType,
    scopeId: projection.operationMetadataContext.scopeId,
    inputRevision: projection.operationMetadataContext.scopeRevision,
    ruleSetVersion: projection.operationMetadataContext.ruleSetVersion,
    fiveAxisRuleVersion: projection.operationMetadataContext.fiveAxisRuleVersion,
    inputHash,
  }, { semanticContentAvailable: true });
  if (!freshness.canCreateDraft || command.assessmentInputHash !== metadata.inputHash || inputHash !== metadata.inputHash) {
    throw new AIDraftConversionError("AI_ASSESSMENT_NOT_ACTIONABLE", "评估已 stale，必须重新评估。");
  }
  const recommendation = semantic.recommendations.find((entry) => entry.recommendationCode === command.recommendationId);
  if (!recommendation) {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "recommendationId 不存在。");
  }
  const modelScopeAlias = projection.requestAliasMapping.find((entry) =>
    entry.reference.referenceKindCode === scope.scopeType
    && entry.reference.stableLocalId === scope.scopeId)?.alias;
  if (!modelScopeAlias || !recommendation.subjectAliases.includes(modelScopeAlias)) {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "建议没有绑定当前作用域。");
  }
  const evidenceRefs = resolveEvidence(recommendation, semantic, projection);
  const suggestedChanges = selectedChanges(recommendation, command.selectedChangeIds);
  const parameterMapping = new Map(projection.parameterKeyMapping.map((entry) => [entry.alias, entry.parameterKey]));
  if (scope.scopeType !== "model") {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "Series 评估没有可转换的 typed 参数目标，只能 preview_only。");
  }
  const { model } = modelAndSeries(input.state, scope.scopeId);
  if (!command.targetModelRef || command.targetModelRef.entityId !== model.id
    || command.targetModelRef.revisionId !== String(model.revision)) {
    throw new AIDraftConversionError("AI_DRAFT_TARGET_REVISION_CHANGED", "目标 Model revision 已变化。");
  }
  const requiredCapability: CapabilityCode = recommendation.suggestedAction === "create_model_patch_draft"
    ? "ai.patch_draft.create"
    : "ai.rule_source_change_draft.create";
  if (!new Set(input.capabilities).has(requiredCapability)) {
    throw new AIDraftConversionError("AI_CAPABILITY_MISSING", `缺少能力：${requiredCapability}。`);
  }
  if (recommendation.suggestedAction === "create_model_patch_draft"
    && (model.configurationSnapshotId || model.status === "published")) {
    throw new AIDraftConversionError("AI_DRAFT_TARGET_FROZEN", "冻结 Model / Snapshot 不允许创建 Model Patch 草稿。");
  }
  const changes = suggestedChanges.map((entry): AIDeterministicChangePreview => {
    const parameterKey = parameterMapping.get(entry.parameterKey);
    if (!parameterKey) {
      throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "建议参数不属于当前 inputHash 的 typed 参数映射。");
    }
    const definition = input.state.parameters.find((parameter) => parameter.key === parameterKey);
    if (!definition) throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "参数定义不存在。");
    if (entry.operation !== "clear" && !definition.allowedOperations?.includes(entry.operation)) {
      throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "参数不允许该 Patch operation。");
    }
    const operand = safeValue(entry.operand);
    const expectedBefore = safeValue(entry.expectedBefore);
    if (typeof expectedBefore !== "number"
      || (entry.operation !== "clear" && typeof operand !== "number")
      || (entry.operation === "clear" && operand !== null)) {
      throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "当前 Model Patch 只接受数值参数和规范 clear。");
    }
    const calculated = preparePatchOperationFromWorkspace({
      state: input.state,
      scopeType: "model",
      subjectEntityId: model.id,
      parameterKey,
      operation: entry.operation,
      operand,
    });
    if (deterministicHash(expectedBefore) !== deterministicHash(calculated.before)) {
      throw new AIDraftConversionError("AI_DRAFT_TARGET_REVISION_CHANGED", "建议 expectedBefore 与当前确定性基线不一致。");
    }
    return {
      changeId: entry.changeId,
      parameterKey,
      before: calculated.before,
      operation: entry.operation,
      operand,
      after: calculated.after,
      traceHash: calculated.traceHash,
    };
  });
  const currentRuleSet = projection.operationMetadataContext.ruleSetVersion;
  const commandHash = deterministicHash(commandIdentity(command));
  const artifactHash = deterministicHash({
    assessmentId: input.assessmentId,
    recommendationId: recommendation.recommendationCode,
    commandHash,
    changes,
  });
  const patchId = `ai-patch:${artifactHash}`;
  const patch = buildPatchRevision({
    patchId,
    patchRevision: 1,
    scopeType: "model",
    layerType: "model",
    subjectEntityId: model.id,
    subjectName: model.name,
    baseRuleSetVersion: currentRuleSet,
    baseObjectRevision: model.revision,
    state: "DRAFT",
    mirrorSyncState: "NOT_SYNCED",
    attentionStates: [],
    reason: command.userReason,
    evidence: evidenceRefs.map((entry) => entry.contentHash),
    createdBy: input.actorDisplayName,
    createdAt: input.now,
    snapshotRefs: [],
    operations: changes.map((change, index) => ({
      patchId,
      patchRevision: 1,
      operationId: `${patchId}:op:${change.changeId}`,
      operationIndex: index,
      parameterKey: change.parameterKey,
      operation: change.operation,
      operand: change.operand,
      before: change.before,
      after: change.after,
    })),
    rawPayload: {
      schemaVersion: "ai-model-patch-draft-provenance/v1",
      assessmentId: input.assessmentId,
      recommendationId: recommendation.recommendationCode,
      assessmentInputHash: command.assessmentInputHash,
      selectedRecommendation: structuredClone(recommendation),
      evidenceRefs: structuredClone(evidenceRefs),
      humanDiff: { selectedChangeIds: command.selectedChangeIds, userReason: command.userReason },
      idempotencyKey: command.idempotencyKey,
      commandHash,
      modelDescriptor: structuredClone(metadata.modelDescriptor),
    },
  });
  ensureNoPendingConflict(input.state, model.id, changes, command.idempotencyKey, commandHash);
  const validation = patchRangeDiff(input.state, patch);
  const panel = currentPatchPanelValuesFromWorkspace({ state: input.state, scopeType: "model", subjectEntityId: model.id });
  for (const change of changes) {
    if (change.operation === "clear") delete panel[change.parameterKey];
    else panel[change.parameterKey] = change.after as number | string;
  }
  const invariants = invariantDiff(input.state, model, panel);
  const diffs: AIDraftDiffPreview = {
    validation,
    fiveAxis: fiveAxisDiff(input.state, changes),
    affinity: { status: "UNCHANGED_BY_PATCH" },
    invariants,
  };
  if (recommendation.suggestedAction === "preview_only") {
    throw new AIDraftConversionError("AI_DRAFT_RECOMMENDATION_INVALID", "preview_only 建议不能创建草稿。");
  }
  if (recommendation.suggestedAction === "create_model_patch_draft") {
    const newBlocking = [...validation.newBlockingIssueCodes, ...invariants.newBlockingIssueCodes];
    if (newBlocking.length) {
      throw new AIDraftConversionError(
        "AI_PATCH_HARD_VALIDATION_CONFLICT",
        `建议产生新的确定性阻断：${[...new Set(newBlocking)].join("、")}。`,
      );
    }
    const previewContent = {
      kind: "model_patch" as const,
      assessmentId: input.assessmentId,
      recommendationId: recommendation.recommendationCode,
      assessmentInputHash: command.assessmentInputHash,
      targetRef: structuredClone(command.targetModelRef!),
      changes,
      diffs,
      evidenceRefs,
    };
    const preview: AIDraftPreview = {
      mode: "preview",
      ...previewContent,
      previewHash: deterministicHash(previewContent),
      canCreate: true,
    };
    const artifactStableRefs = [patchId];
    const provenance = createProvenance(
      input.record,
      recommendation,
      evidenceRefs,
      { selectedChangeIds: command.selectedChangeIds, userReason: command.userReason },
      artifactStableRefs,
    );
    return {
      kind: "model_patch",
      preview,
      patch,
      artifactRef: { artifactType: "model_patch", artifactId: patchId, state: "DRAFT" },
      commandHash,
      provenanceSyncRecord: provenanceSyncRecord(input, provenance, commandHash, artifactStableRefs),
    };
  }
  const ruleTarget = normalizeRuleTarget(input.state, command.targetRuleRef, changes);
  const ruleImpact = sandboxRuleImpact({
    state: input.state,
    target: ruleTarget,
    change: changes[0]!,
    targetModelId: model.id,
  });
  const rulePreviewContent = {
    kind: "rule_source_change_draft" as const,
    assessmentId: input.assessmentId,
    recommendationId: recommendation.recommendationCode,
    assessmentInputHash: command.assessmentInputHash,
    targetRef: ruleTarget,
    changes: [ruleImpact.change],
    diffs: ruleImpact.diffs,
    evidenceRefs,
  };
  const rulePreview: AIDraftPreview = {
    mode: "preview",
    ...rulePreviewContent,
    previewHash: deterministicHash(rulePreviewContent),
    canCreate: true,
  };
  const changeDraftId = `ai-rule-source-change:${artifactHash}`;
  const artifactStableRefs = [changeDraftId];
  const provenance = createProvenance(
    input.record,
    recommendation,
    evidenceRefs,
    {
      selectedChangeIds: command.selectedChangeIds,
      userReason: command.userReason,
      targetRuleRef: ruleTarget,
    },
    artifactStableRefs,
  );
  const ruleDraft: AIRuleSourceChangeDraft = {
    changeDraftId,
    originAssessmentId: input.assessmentId,
    originRecommendationId: recommendation.recommendationCode,
    sourceObjectRefs: [{
      workspaceId: "default",
      entityType: "model",
      entityId: model.id,
      revisionId: String(model.revision),
    }],
    targetRuleRef: structuredClone(ruleTarget),
    proposedChange: {
      changeId: ruleImpact.change.changeId,
      parameterKey: ruleImpact.change.parameterKey,
      operation: ruleImpact.change.operation,
      operand: ruleImpact.change.operand,
      expectedBefore: ruleImpact.change.before,
    },
    evidenceRefs: structuredClone(evidenceRefs),
    impactPreview: ruleImpact.impactPreview,
    state: "LOCAL_DRAFT",
    idempotencyKey: command.idempotencyKey,
    commandHash,
    createdBy: input.actorDisplayName,
    createdAt: input.now,
    provenance: {
      assessmentInputHash: command.assessmentInputHash,
      modelDescriptor: structuredClone(metadata.modelDescriptor),
      selectedRecommendation: structuredClone(recommendation),
      evidenceContentHashes: evidenceRefs.map((entry) => entry.contentHash),
      humanDiff: {
        selectedChangeIds: command.selectedChangeIds,
        userReason: command.userReason,
        targetRuleRef: ruleTarget,
      },
    },
  };
  return {
    kind: "rule_source_change_draft",
    preview: rulePreview,
    ruleDraft,
    artifactRef: {
      artifactType: "rule_source_change_draft",
      artifactId: changeDraftId,
      state: "LOCAL_DRAFT",
    },
    commandHash,
    provenanceSyncRecord: provenanceSyncRecord(input, provenance, commandHash, artifactStableRefs),
  };
}

function normalizeRuleTarget(
  state: WorkspaceState,
  value: AITargetRuleRef | undefined,
  changes: AIDeterministicChangePreview[],
): AITargetRuleRef {
  if (!value || changes.length !== 1) {
    throw new AIDraftConversionError("AI_RULE_TARGET_INVALID", "RuleSourceChangeDraft 必须选择一个精确目标规则和一个变化。");
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value.spreadsheetToken)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sheetId)
    || !value.stableRuleId.trim()
    || Buffer.byteLength(value.stableRuleId, "utf8") > 256
    || /[\u0000-\u001f\u007f]/.test(value.stableRuleId)
    || !value.parameterKey.trim()
    || !value.sourceRevision.trim()) {
    throw new AIDraftConversionError("AI_RULE_TARGET_INVALID", "targetRuleRef 格式无效。");
  }
  const latest = [...state.feishuSourceRevisions]
    .filter((entry) => entry.spreadsheetToken === value.spreadsheetToken)
    .sort((left, right) => right.pulledAt.localeCompare(left.pulledAt) || right.id.localeCompare(left.id))[0];
  if (!latest || latest.sourceRevision !== value.sourceRevision) {
    throw new AIDraftConversionError("AI_RULE_SOURCE_REVISION_CHANGED", "飞书规则源 revision 已变化，必须重新预览。");
  }
  const registry = CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) =>
    entry.sheetId === value.sheetId && entry.role === "rule_source" && entry.importsRules);
  if (!registry || !latest.sheets.some((entry) => entry.sheetId === value.sheetId)
    || value.parameterKey !== changes[0]?.parameterKey) {
    throw new AIDraftConversionError("AI_RULE_TARGET_INVALID", "目标 sheet 或 parameterKey 不是当前可写的规则源目标。");
  }
  return {
    spreadsheetToken: value.spreadsheetToken,
    sheetId: value.sheetId,
    stableRuleId: value.stableRuleId,
    parameterKey: value.parameterKey.trim(),
    sourceRevision: value.sourceRevision.trim(),
  };
}

type SupportedRuleLocator =
  | { kind: "method"; profileId: string; expectedSheetId: "fATowU" }
  | { kind: "item_type"; profileId: string; expectedSheetId: "fATowU" }
  | { kind: "function"; profileId: string; expectedSheetId: "vviXo0" }
  | { kind: "function_intensity"; profileId: string; intensity: 1 | 2 | 3; expectedSheetId: "vviXo0" }
  | { kind: "quality"; profileId: string; expectedSheetId: "FqD4j7" };

function matchingRuleLocator(
  state: WorkspaceState,
  target: AITargetRuleRef,
): SupportedRuleLocator {
  const matches: SupportedRuleLocator[] = [];
  const hasRule = (rules: AdjustmentRule[]) => rules.some((rule) =>
    rule.id === target.stableRuleId && rule.parameterKey === target.parameterKey);
  for (const profile of state.methodProfiles) {
    if (hasRule(profile.rules)) matches.push({ kind: "method", profileId: profile.id, expectedSheetId: "fATowU" });
  }
  for (const profile of state.itemTypeProfiles) {
    if (hasRule(profile.rules)) matches.push({ kind: "item_type", profileId: profile.id, expectedSheetId: "fATowU" });
  }
  for (const profile of state.functionProfiles) {
    if (hasRule(profile.rules)) matches.push({ kind: "function", profileId: profile.id, expectedSheetId: "vviXo0" });
    for (const intensity of profile.intensityRules) {
      if (hasRule(intensity.rules)) {
        matches.push({
          kind: "function_intensity",
          profileId: profile.id,
          intensity: intensity.intensity,
          expectedSheetId: "vviXo0",
        });
      }
    }
  }
  for (const profile of state.qualityProfiles) {
    if (hasRule(profile.rules)) matches.push({ kind: "quality", profileId: profile.id, expectedSheetId: "FqD4j7" });
  }
  if (matches.length !== 1 || matches[0]!.expectedSheetId !== target.sheetId) {
    throw new AIDraftConversionError(
      "AI_RULE_TARGET_INVALID",
      "stableRuleId 必须在所选权威规则页中唯一存在，并与 parameterKey 一致。",
    );
  }
  return matches[0]!;
}

function mutateRuleList(
  rules: AdjustmentRule[],
  target: AITargetRuleRef,
  change: AIDeterministicChangePreview,
): void {
  const index = rules.findIndex((rule) =>
    rule.id === target.stableRuleId && rule.parameterKey === target.parameterKey);
  if (index < 0) {
    throw new AIDraftConversionError("AI_RULE_TARGET_INVALID", "沙盒中找不到目标规则。");
  }
  if (change.operation === "clear") {
    rules.splice(index, 1);
    return;
  }
  if (typeof change.operand !== "number" || !Number.isFinite(change.operand)) {
    throw new AIDraftConversionError("AI_RULE_TARGET_INVALID", "规则源变化只接受有限数 operand。");
  }
  rules[index] = {
    ...rules[index]!,
    operation: change.operation,
    value: change.operand,
  };
}

function applyRuleChangeToSandbox(
  state: WorkspaceState,
  locator: SupportedRuleLocator,
  target: AITargetRuleRef,
  change: AIDeterministicChangePreview,
): void {
  if (locator.kind === "method") {
    mutateRuleList(state.methodProfiles.find((entry) => entry.id === locator.profileId)!.rules, target, change);
    return;
  }
  if (locator.kind === "item_type") {
    mutateRuleList(state.itemTypeProfiles.find((entry) => entry.id === locator.profileId)!.rules, target, change);
    return;
  }
  if (locator.kind === "function") {
    mutateRuleList(state.functionProfiles.find((entry) => entry.id === locator.profileId)!.rules, target, change);
    return;
  }
  if (locator.kind === "function_intensity") {
    const profile = state.functionProfiles.find((entry) => entry.id === locator.profileId)!;
    mutateRuleList(profile.intensityRules.find((entry) => entry.intensity === locator.intensity)!.rules, target, change);
    return;
  }
  mutateRuleList(state.qualityProfiles.find((entry) => entry.id === locator.profileId)!.rules, target, change);
}

function rederiveSandboxProjections(state: WorkspaceState): void {
  state.derivedProjections = state.derivedProjections.map((projection) => {
    const weightTemplate = state.templates.find((entry) => entry.id === projection.weightTemplateId);
    const methodProfile = state.methodProfiles.find((entry) => entry.id === projection.methodId);
    const itemTypeProfile = state.itemTypeProfiles.find((entry) => entry.id === projection.typeId);
    const functionProfile = state.functionProfiles.find((entry) => entry.id === projection.functionId);
    const performanceProfile = projection.performanceId
      ? state.performanceProfiles.find((entry) => entry.id === projection.performanceId)
      : undefined;
    const qualityProfile = projection.qualityId
      ? state.qualityProfiles.find((entry) => entry.id === projection.qualityId)
      : undefined;
    const ruleSet = state.ruleSetVersions.find((entry) => entry.id === projection.ruleSetVersion);
    if (!weightTemplate || !methodProfile || !itemTypeProfile || !functionProfile || !ruleSet
      || (projection.performanceId && !performanceProfile)
      || (projection.qualityId && !qualityProfile)) {
      throw new AIDraftConversionError(
        "AI_RULE_IMPACT_PREVIEW_INCOMPLETE",
        `Projection ${projection.id} 缺少完整冻结输入，不能完成规则源沙盒重算。`,
      );
    }
    return deriveProjection({
      id: projection.id,
      weightTemplate,
      methodProfile,
      itemTypeProfile,
      functionProfile,
      functionIntensity: projection.functionIntensity,
      performanceProfile,
      qualityProfile,
      ruleSet,
      createdAt: projection.createdAt,
    });
  });
}

function seriesInvariantIssues(
  state: WorkspaceState,
  seriesId: string,
  panelsByModelId: ReadonlyMap<string, Record<string, number | string>>,
): ValidationIssue[] {
  const series = state.seriesDefinitions.find((entry) => entry.id === seriesId);
  if (!series) return [];
  const skus = state.skuDrawers.filter((entry) => entry.seriesId === series.id);
  const skuIds = new Set(skus.map((entry) => entry.id));
  const models = state.purchasableModels.filter((entry) => skuIds.has(entry.skuId));
  return validateSeriesInvariants({
    series,
    skus,
    models,
    projections: state.derivedProjections,
    parameters: state.parameters,
    resolvedPanels: models.map((entry) => ({
      modelId: entry.id,
      skuId: entry.skuId,
      values: panelsByModelId.get(entry.id) ?? {},
    })),
  });
}

function countIssueChanges(
  before: ValidationIssue[],
  after: ValidationIssue[],
): { newErrors: number; resolvedErrors: number } {
  const fingerprint = (issue: ValidationIssue) => deterministicHash({
    code: issue.code,
    message: issue.message,
    level: issue.level,
    severity: issue.severity,
  });
  const beforeErrors = new Set(before.filter((issue) =>
    issue.level === "error" || issue.severity === "ERROR" || issue.severity === "BLOCKER").map(fingerprint));
  const afterErrors = new Set(after.filter((issue) =>
    issue.level === "error" || issue.severity === "ERROR" || issue.severity === "BLOCKER").map(fingerprint));
  return {
    newErrors: [...afterErrors].filter((entry) => !beforeErrors.has(entry)).length,
    resolvedErrors: [...beforeErrors].filter((entry) => !afterErrors.has(entry)).length,
  };
}

function sandboxRuleImpact(input: {
  state: WorkspaceState;
  target: AITargetRuleRef;
  change: AIDeterministicChangePreview;
  targetModelId: string;
}): {
  change: AIDeterministicChangePreview;
  diffs: AIDraftDiffPreview;
  impactPreview: AIRuleSourceChangeDraft["impactPreview"];
} {
  const locator = matchingRuleLocator(input.state, input.target);
  const sandbox = structuredClone(input.state);
  applyRuleChangeToSandbox(sandbox, locator, input.target, input.change);
  rederiveSandboxProjections(sandbox);

  const beforePanels = new Map<string, Record<string, number | string>>();
  const afterPanels = new Map<string, Record<string, number | string>>();
  const unavailableModelIds: string[] = [];
  for (const model of input.state.purchasableModels) {
    try {
      beforePanels.set(model.id, currentPatchPanelValuesFromWorkspace({
        state: input.state,
        scopeType: "model",
        subjectEntityId: model.id,
      }));
      afterPanels.set(model.id, currentPatchPanelValuesFromWorkspace({
        state: sandbox,
        scopeType: "model",
        subjectEntityId: model.id,
      }));
    } catch {
      unavailableModelIds.push(model.id);
    }
  }
  if (unavailableModelIds.length) {
    throw new AIDraftConversionError(
      "AI_RULE_IMPACT_PREVIEW_INCOMPLETE",
      `有 ${unavailableModelIds.length} 个 Model 无法完成规则源沙盒重算。`,
    );
  }
  const affectedModelIds = input.state.purchasableModels
    .filter((model) => deterministicHash(beforePanels.get(model.id)) !== deterministicHash(afterPanels.get(model.id)))
    .map((model) => model.id);
  const affectedModels = new Set(affectedModelIds);
  const affectedSkuIds = new Set(input.state.purchasableModels
    .filter((model) => affectedModels.has(model.id))
    .map((model) => model.skuId));
  const affectedSeriesIds = new Set(input.state.skuDrawers
    .filter((sku) => affectedSkuIds.has(sku.id))
    .map((sku) => sku.seriesId));

  let newErrors = 0;
  let resolvedErrors = 0;
  const allSeriesIds = [...new Set(input.state.seriesDefinitions.map((entry) => entry.id))];
  let targetBeforeIssues: ValidationIssue[] = [];
  let targetAfterIssues: ValidationIssue[] = [];
  const targetSku = input.state.skuDrawers.find((entry) =>
    entry.id === input.state.purchasableModels.find((model) => model.id === input.targetModelId)?.skuId);
  for (const seriesId of allSeriesIds) {
    const before = seriesInvariantIssues(input.state, seriesId, beforePanels);
    const after = seriesInvariantIssues(sandbox, seriesId, afterPanels);
    const counts = countIssueChanges(before, after);
    newErrors += counts.newErrors;
    resolvedErrors += counts.resolvedErrors;
    if (seriesId === targetSku?.seriesId) {
      targetBeforeIssues = before;
      targetAfterIssues = after;
    }
  }

  const targetBefore = beforePanels.get(input.targetModelId);
  const targetAfter = afterPanels.get(input.targetModelId);
  if (!targetBefore || !targetAfter) {
    throw new AIDraftConversionError("AI_RULE_IMPACT_PREVIEW_INCOMPLETE", "目标 Model 缺少沙盒前后面板。");
  }
  const beforeValue = targetBefore[input.change.parameterKey];
  const afterValue = targetAfter[input.change.parameterKey];
  const targetChange = {
    ...input.change,
    before: beforeValue,
    after: afterValue,
    traceHash: deterministicHash({
      targetRuleRef: input.target,
      modelId: input.targetModelId,
      before: beforeValue,
      after: afterValue,
    }),
  };
  const targetBeforeCodes = issueCodes(targetBeforeIssues);
  const targetAfterCodes = issueCodes(targetAfterIssues);
  const targetBeforeBlocking = blockingIssueCodes(targetBeforeIssues);
  const targetAfterBlocking = blockingIssueCodes(targetAfterIssues);
  const oldProjection = input.state.derivedProjections.find((projection) =>
    projection.id === targetSku?.projectionMatch.projectionId);
  const newProjection = sandbox.derivedProjections.find((projection) =>
    projection.id === targetSku?.projectionMatch.projectionId);
  const beforeProjectionIssues = oldProjection?.warnings.map((warning) => ({
    level: warning.level,
    code: warning.code,
    message: warning.message,
  } satisfies ValidationIssue)) ?? [];
  const afterProjectionIssues = newProjection?.warnings.map((warning) => ({
    level: warning.level,
    code: warning.code,
    message: warning.message,
  } satisfies ValidationIssue)) ?? [];
  const diffs: AIDraftDiffPreview = {
    validation: {
      beforeIssueCodes: issueCodes(beforeProjectionIssues),
      afterIssueCodes: issueCodes(afterProjectionIssues),
      newBlockingIssueCodes: newCodes(
        blockingIssueCodes(beforeProjectionIssues),
        blockingIssueCodes(afterProjectionIssues),
      ),
    },
    fiveAxis: fiveAxisDiff(input.state, [targetChange]),
    affinity: { status: "UNCHANGED_BY_PATCH" },
    invariants: {
      beforeIssueCodes: targetBeforeCodes,
      afterIssueCodes: targetAfterCodes,
      newBlockingIssueCodes: newCodes(targetBeforeBlocking, targetAfterBlocking),
    },
  };
  const sampleDiffRefs = affectedModelIds.slice(0, 20).map((modelId) => deterministicHash({
    modelId,
    before: beforePanels.get(modelId),
    after: afterPanels.get(modelId),
  }));
  return {
    change: targetChange,
    diffs,
    impactPreview: {
      evaluatedRuleSetVersion: input.state.ruleSetVersions.find((entry) => entry.status === "published")!.id,
      affectedSeries: affectedSeriesIds.size,
      affectedSkus: affectedSkuIds.size,
      affectedModels: affectedModelIds.length,
      newErrors,
      resolvedErrors,
      sampleDiffRefs,
      publishedSnapshotsChanged: 0,
      upgradeCandidatesExpected: input.state.purchasableModels.filter((model) =>
        affectedModels.has(model.id) && Boolean(model.configurationSnapshotId)).length,
      coverage: {
        evaluatedModels: input.state.purchasableModels.length,
        totalModels: input.state.purchasableModels.length,
        complete: true,
        unavailableModelIds: [],
      },
    },
  };
}

function provenanceSyncRecord(
  input: {
    assessmentId: string;
    actorStableId: string;
    command: AIDraftConversionCommand;
    now: string;
  },
  provenance: AIAcceptedArtifactProvenance,
  commandHash: string,
  artifactStableRefs: string[],
): AIArtifactProvenanceSyncRecord {
  return {
    syncRecordId: `ai-provenance-sync:${deterministicHash({
      assessmentId: input.assessmentId,
      idempotencyKey: input.command.idempotencyKey,
    })}`,
    assessmentId: input.assessmentId,
    actorStableId: input.actorStableId,
    artifactStableRefs: structuredClone(artifactStableRefs),
    acceptedArtifactProvenance: structuredClone(provenance),
    idempotencyKey: input.command.idempotencyKey,
    commandHash,
    state: "PENDING",
    attempts: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function applyAIDraftArtifactPlan(
  state: WorkspaceState,
  plan: AIDraftArtifactPlan,
): { state: WorkspaceState; idempotent: boolean } {
  const existingSync = state.aiArtifactProvenanceSyncRecords.find((entry) =>
    entry.idempotencyKey === plan.provenanceSyncRecord.idempotencyKey);
  if (existingSync) {
    if (existingSync.commandHash !== plan.provenanceSyncRecord.commandHash
      || deterministicHash(existingSync.artifactStableRefs)
        !== deterministicHash(plan.provenanceSyncRecord.artifactStableRefs)) {
      throw new AIDraftConversionError("AI_DRAFT_IDEMPOTENCY_CONFLICT", "idempotencyKey 已绑定不同命令。");
    }
    return { state, idempotent: true };
  }
  const next = structuredClone(state);
  if (plan.kind === "model_patch") {
    const duplicate = next.patchLedger.revisions.find((entry) =>
      entry.patchId === plan.patch.patchId && entry.patchRevision === plan.patch.patchRevision);
    if (duplicate && duplicate.revisionHash !== plan.patch.revisionHash) {
      throw new AIDraftConversionError("AI_DRAFT_IDEMPOTENCY_CONFLICT", "Patch revision 身份冲突。");
    }
    if (!duplicate) next.patchLedger.revisions.push(structuredClone(plan.patch));
  } else {
    const duplicate = next.aiRuleSourceChangeDrafts.find((entry) => entry.changeDraftId === plan.ruleDraft.changeDraftId);
    if (duplicate && deterministicHash(duplicate) !== deterministicHash(plan.ruleDraft)) {
      throw new AIDraftConversionError("AI_DRAFT_IDEMPOTENCY_CONFLICT", "RuleSourceChangeDraft 身份冲突。");
    }
    if (!duplicate) next.aiRuleSourceChangeDrafts.push(structuredClone(plan.ruleDraft));
  }
  next.aiArtifactProvenanceSyncRecords.push(structuredClone(plan.provenanceSyncRecord));
  return { state: next, idempotent: false };
}
