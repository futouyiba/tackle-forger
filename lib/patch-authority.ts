import { deterministicHash } from "./rule-kernel";
import { reviewPatchBatch, reviewPatchRevision, submitPatchRevision } from "./patch-ledger";
import {
  createPatchReviewBatch,
  evaluatePatchFinalRanges,
  findPublishedPatchOffsetPolicy,
  invalidatePatchReviewBatch,
  PatchOffsetPolicyError,
  type PatchFinalRangeContext,
  type PatchRangeEvaluation,
} from "./patch-offset-policy";
import type {
  DerivedProjection,
  ParameterDefinition,
  PatchOffsetPolicyVersion,
  PatchReviewSubjectRef,
  PatchRevisionRecord,
  PatchSnapshotReference,
  RuleSetVersion,
  WorkspaceState,
  WorkspacePolicyRecord,
} from "./types";

export interface AuthoritativePatchDiscreteContext {
  contextId: string;
  itemPartId: string;
  projection: Pick<DerivedProjection, "id" | "ruleSetVersion" | "sourceHash" | "values">;
  finalPanelValues: Record<string, number | string>;
  weightBandId: string;
  skuRef?: string;
  targetPullKg?: number;
}

export interface AuthoritativePatchObject {
  subjectRef: PatchReviewSubjectRef;
  ruleSet: RuleSetVersion;
  parameterDefinitions: ParameterDefinition[];
  patchRevisions: PatchRevisionRecord[];
  contexts: AuthoritativePatchDiscreteContext[];
}

const layerOrder: Record<PatchRevisionRecord["layerType"], number> = {
  derivation: 0,
  series: 1,
  sku: 2,
  model: 3,
  final_review: 4,
  projection_pin: 5,
};

function orderedRevisions(revisions: PatchRevisionRecord[]): PatchRevisionRecord[] {
  return [...revisions].sort((left, right) =>
    layerOrder[left.layerType] - layerOrder[right.layerType]
    || left.subjectEntityId.localeCompare(right.subjectEntityId)
    || left.patchId.localeCompare(right.patchId)
    || left.patchRevision - right.patchRevision);
}

function orderedOperations(revision: PatchRevisionRecord) {
  return [...revision.operations].sort((left, right) =>
    left.operationIndex - right.operationIndex || left.operationId.localeCompare(right.operationId));
}

export function authoritativePatchReferences(
  revisions: PatchRevisionRecord[],
): { references: PatchSnapshotReference[]; patchSetHash: string } {
  const references = orderedRevisions(revisions).map((revision) => ({
    patchId: revision.patchId,
    patchRevision: revision.patchRevision,
    orderedOperationIds: orderedOperations(revision).map((operation) => operation.operationId),
  }));
  return { references, patchSetHash: deterministicHash(references) };
}

function assertAuthorityVersions(object: AuthoritativePatchObject): void {
  if (object.ruleSet.status !== "published" || !object.ruleSet.publishedAt) {
    throw new PatchOffsetPolicyError(
      "PATCH_RULESET_NOT_PUBLISHED",
      `对象 ${object.subjectRef.entityId} 没有可用于正式范围校验的已发布 RuleSetVersion。`,
    );
  }
  for (const context of object.contexts) {
    if (
      context.projection.ruleSetVersion !== object.ruleSet.id
      && context.projection.ruleSetVersion !== String(object.ruleSet.version)
    ) {
      throw new PatchOffsetPolicyError(
        "PATCH_RULESET_VERSION_MISMATCH",
        `Projection ${context.projection.id} 与当前已发布 RuleSetVersion 不一致。`,
      );
    }
  }
  for (const revision of object.patchRevisions) {
    if (
      revision.baseRuleSetVersion !== object.ruleSet.id
      && revision.baseRuleSetVersion !== String(object.ruleSet.version)
    ) {
      throw new PatchOffsetPolicyError(
        "PATCH_RULESET_VERSION_MISMATCH",
        `Patch ${revision.patchId}@${revision.patchRevision} 不是基于当前已发布 RuleSetVersion。`,
      );
    }
  }
}

function authorityObjectInputHash(
  object: AuthoritativePatchObject,
  references: PatchSnapshotReference[],
): string {
  return deterministicHash({
    subjectRef: object.subjectRef,
    ruleSet: object.ruleSet,
    parameters: [...object.parameterDefinitions].sort((left, right) => left.key.localeCompare(right.key)),
    patchReferences: references,
    patchRevisionInputs: orderedRevisions(object.patchRevisions).map((revision) => ({
      patchId: revision.patchId,
      patchRevision: revision.patchRevision,
      scopeType: revision.scopeType,
      layerType: revision.layerType,
      subjectEntityId: revision.subjectEntityId,
      baseRuleSetVersion: revision.baseRuleSetVersion,
      baseObjectRevision: revision.baseObjectRevision,
      operations: orderedOperations(revision),
    })),
    contexts: [...object.contexts]
      .sort((left, right) => left.contextId.localeCompare(right.contextId))
      .map((context) => ({
        contextId: context.contextId,
        itemPartId: context.itemPartId,
        projectionId: context.projection.id,
        projectionRuleSetVersion: context.projection.ruleSetVersion,
        projectionSourceHash: context.projection.sourceHash,
        projectionValues: context.projection.values,
        finalPanelValues: context.finalPanelValues,
        weightBandId: context.weightBandId,
        skuRef: context.skuRef,
        targetPullKg: context.targetPullKg,
      })),
  });
}

export function deriveAuthoritativePatchContexts(
  object: AuthoritativePatchObject,
): PatchFinalRangeContext[] {
  assertAuthorityVersions(object);
  if (!object.contexts.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_RANGE_CONTEXT_MISSING",
      `对象 ${object.subjectRef.entityId} 没有可校验的真实离散 Projection/最终面板。`,
    );
  }
  const { references, patchSetHash } = authoritativePatchReferences(object.patchRevisions);
  const objectInputHash = authorityObjectInputHash(object, references);
  const trace = orderedRevisions(object.patchRevisions).flatMap((revision) =>
    orderedOperations(revision).map((operation) => ({
      operationId: operation.operationId,
      parameterKey: operation.parameterKey,
      operation: operation.operation,
      before: operation.before,
      operand: operation.operand,
      after: operation.after,
    })));
  const traceHash = deterministicHash(trace);
  const parameterByKey = new Map(object.parameterDefinitions.map((parameter) => [parameter.key, parameter]));
  const patchedParameterKeys = [...new Set(trace.map((entry) => entry.parameterKey))].sort();
  if (!patchedParameterKeys.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_OPERATION_REQUIRED",
      `对象 ${object.subjectRef.entityId} 的 PatchSet 没有可复核操作。`,
    );
  }

  return [...object.contexts]
    .sort((left, right) => left.contextId.localeCompare(right.contextId))
    .flatMap((discrete) => patchedParameterKeys.map((parameterKey): PatchFinalRangeContext => {
      const parameter = parameterByKey.get(parameterKey);
      if (!parameter) {
        throw new PatchOffsetPolicyError(
          "PATCH_PARAMETER_DEFINITION_MISSING",
          `参数 ${parameterKey} 缺少权威 ParameterDefinition。`,
        );
      }
      if (!parameter.targetRange) {
        throw new PatchOffsetPolicyError(
          "PATCH_PARAMETER_RANGE_MISSING",
          `参数 ${parameterKey} 的权威 ParameterDefinition 未发布合法范围。`,
        );
      }
      const finalValue = discrete.finalPanelValues[parameterKey];
      if (typeof finalValue !== "number" || !Number.isFinite(finalValue)) {
        throw new PatchOffsetPolicyError(
          "PATCH_FINAL_VALUE_MISSING",
          `最终面板 ${discrete.contextId} 缺少参数 ${parameterKey} 的有限数值。`,
        );
      }
      return {
        contextId: `${discrete.contextId}:${parameterKey}`,
        scopeType: object.subjectRef.scopeType === "snapshot_batch"
          ? "model"
          : object.subjectRef.scopeType,
        itemPartId: discrete.itemPartId,
        parameterKey,
        standardUnit: parameter.unit,
        subjectRef: structuredClone(object.subjectRef),
        objectInputHash,
        ...(discrete.skuRef ? { skuRef: discrete.skuRef } : {}),
        ...(discrete.targetPullKg !== undefined ? { targetPullKg: discrete.targetPullKg } : {}),
        projectionId: discrete.projection.id,
        weightBandId: discrete.weightBandId,
        constraintRuleRef: `parameter-definition:${parameter.key}:target-range`,
        constraintRuleVersion: deterministicHash({
          ruleSetId: object.ruleSet.id,
          ruleSetVersion: object.ruleSet.version,
          ruleSetPublicationHash: object.ruleSet.publicationHash,
          parameter,
        }),
        finalValue,
        finalValueUnit: parameter.unit,
        validRange: { ...parameter.targetRange, unit: parameter.unit },
        patchReferences: structuredClone(references),
        patchSetHash,
        operationTrace: structuredClone(trace),
        traceHash,
      };
    }));
}

export function evaluateAuthoritativePatchFinalRanges(input: {
  policy?: WorkspacePolicyRecord | PatchOffsetPolicyVersion;
  gate: PatchRangeEvaluation["gate"];
  environmentId?: string;
  channelKey?: string;
  objects: AuthoritativePatchObject[];
}): PatchRangeEvaluation {
  const contexts = input.objects.flatMap(deriveAuthoritativePatchContexts);
  return evaluatePatchFinalRanges({
    policy: input.policy,
    gate: input.gate,
    environmentId: input.environmentId,
    channelKey: input.channelKey,
    contexts,
  });
}

export function assertPatchEvaluationMatchesAuthority(input: {
  evaluation: PatchRangeEvaluation;
  policy?: WorkspacePolicyRecord | PatchOffsetPolicyVersion;
  objects: AuthoritativePatchObject[];
}): void {
  const expected = evaluateAuthoritativePatchFinalRanges({
    policy: input.policy,
    gate: input.evaluation.gate,
    environmentId: input.evaluation.environmentId,
    channelKey: input.evaluation.channelKey,
    objects: input.objects,
  });
  if (deterministicHash(expected) !== deterministicHash(input.evaluation)) {
    throw new PatchOffsetPolicyError(
      "PATCH_RANGE_EVALUATION_AUTHORITY_MISMATCH",
      "Patch 范围评估与当前权威对象、RuleSet、ParameterDefinition、Projection/最终面板不一致。",
    );
  }
}

export function authoritativeObjectIdentity(object: AuthoritativePatchObject): {
  objectInputHash: string;
  patchSetHash: string;
  patchReferences: PatchSnapshotReference[];
} {
  const { references, patchSetHash } = authoritativePatchReferences(object.patchRevisions);
  return {
    objectInputHash: authorityObjectInputHash(object, references),
    patchSetHash,
    patchReferences: references,
  };
}

function currentPublishedRuleSet(state: WorkspaceState): RuleSetVersion {
  const ruleSet = [...state.ruleSetVersions]
    .filter((entry) => entry.status === "published")
    .sort((left, right) => right.version - left.version)[0];
  if (!ruleSet) {
    throw new PatchOffsetPolicyError("PATCH_RULESET_NOT_PUBLISHED", "当前工作区没有已发布 RuleSetVersion。");
  }
  return ruleSet;
}

function currentRevisionByPatchId(
  state: WorkspaceState,
  patchIds: string[],
  target: PatchRevisionRecord,
): PatchRevisionRecord[] {
  return [...new Set(patchIds)].flatMap((patchId) => {
    if (patchId === target.patchId) return [target];
    const latest = state.patchLedger.revisions
      .filter((revision) => revision.patchId === patchId)
      .sort((left, right) => right.patchRevision - left.patchRevision)[0];
    return latest && latest.state === "ACTIVE" ? [latest] : [];
  });
}

function applyRevisions(
  base: Record<string, number | string>,
  revisions: PatchRevisionRecord[],
): Record<string, number | string> {
  const values: Record<string, number | string> = structuredClone(base);
  for (const revision of orderedRevisions(revisions)) {
    for (const operation of orderedOperations(revision)) {
      const before = values[operation.parameterKey];
      if (operation.operation === "clear") {
        delete values[operation.parameterKey];
      } else if (operation.operation === "set") {
        if (typeof operation.operand !== "number" && typeof operation.operand !== "string") {
          throw new PatchOffsetPolicyError("PATCH_OPERATION_INVALID", `操作 ${operation.operationId} 的 set 值无效。`);
        }
        values[operation.parameterKey] = operation.operand;
      } else {
        if (typeof before !== "number" || typeof operation.operand !== "number") {
          throw new PatchOffsetPolicyError(
            "PATCH_NUMERIC_OPERATION_INVALID",
            `操作 ${operation.operationId} 无法应用到当前权威面板。`,
          );
        }
        values[operation.parameterKey] = operation.operation === "add"
          ? before + operation.operand
          : before * operation.operand;
      }
    }
  }
  return values;
}

function subjectChain(state: WorkspaceState, target: PatchRevisionRecord) {
  if (target.scopeType === "series") {
    const series = state.seriesDefinitions.find((entry) => entry.id === target.subjectEntityId);
    if (!series) throw new PatchOffsetPolicyError("PATCH_SUBJECT_MISSING", "Patch 的 Series 对象不存在。");
    return { series, revision: series.revision, patchIds: series.patchIds };
  }
  if (target.scopeType === "sku") {
    const sku = state.skuDrawers.find((entry) => entry.id === target.subjectEntityId);
    const series = state.seriesDefinitions.find((entry) => entry.id === sku?.seriesId);
    if (!sku || !series) throw new PatchOffsetPolicyError("PATCH_SUBJECT_MISSING", "Patch 的 SKU/Series 版本链不存在。");
    return { series, sku, revision: sku.revision, patchIds: [...series.patchIds, ...sku.patchIds] };
  }
  const model = state.purchasableModels.find((entry) => entry.id === target.subjectEntityId);
  const sku = state.skuDrawers.find((entry) => entry.id === model?.skuId);
  const series = state.seriesDefinitions.find((entry) => entry.id === sku?.seriesId);
  if (!model || !sku || !series) {
    throw new PatchOffsetPolicyError("PATCH_SUBJECT_MISSING", "Patch 的 Model/SKU/Series 版本链不存在。");
  }
  return {
    series,
    sku,
    model,
    revision: model.revision,
    patchIds: [...series.patchIds, ...sku.patchIds, ...model.patchIds],
  };
}

export function currentPatchSubjectRef(
  state: WorkspaceState,
  target: PatchRevisionRecord,
): PatchReviewSubjectRef {
  const chain = subjectChain(state, target);
  return {
    scopeType: target.scopeType === "derivation" ? "model" : target.scopeType,
    entityId: target.subjectEntityId,
    revision: chain.revision,
  };
}

export function createAuthoritativePatchObjectFromWorkspace(
  state: WorkspaceState,
  target: PatchRevisionRecord,
): AuthoritativePatchObject {
  const chain = subjectChain(state, target);
  const ruleSet = currentPublishedRuleSet(state);
  const revisions = currentRevisionByPatchId(state, [...chain.patchIds, target.patchId], target);
  const skus: import("./types").SkuDrawer[] = "sku" in chain && chain.sku
    ? [chain.sku]
    : state.skuDrawers
      .filter((sku) => sku.seriesId === chain.series.id)
      .sort((left, right) => left.targetPullKg - right.targetPullKg || left.id.localeCompare(right.id));
  if (!skus.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_SERIES_DISCRETE_CONTEXT_MISSING",
      "Series 尚无真实离散 SKU，当前工作区也没有可绑定的权威 Projection 上下文。",
    );
  }
  const contexts = skus.map((sku): AuthoritativePatchDiscreteContext => {
    const projection = state.derivedProjections.find((entry) => entry.id === sku.projectionMatch.projectionId);
    if (!projection) {
      throw new PatchOffsetPolicyError(
        "PATCH_PROJECTION_MISSING",
        `SKU ${sku.id} 引用的 Projection ${sku.projectionMatch.projectionId} 不存在。`,
      );
    }
    return {
      contextId: `${target.subjectEntityId}:${sku.id}:${projection.id}`,
      itemPartId: sku.projectionMatch.itemPartId || chain.series.itemPartId || "",
      projection,
      finalPanelValues: applyRevisions(projection.values, revisions),
      weightBandId: sku.projectionMatch.weightTemplateId,
      skuRef: sku.id,
      targetPullKg: sku.projectionMatch.targetPullKg,
    };
  });
  return {
    subjectRef: currentPatchSubjectRef(state, target),
    ruleSet,
    parameterDefinitions: state.parameters,
    patchRevisions: revisions,
    contexts,
  };
}

export function preparePatchOperationFromWorkspace(input: {
  state: WorkspaceState;
  scopeType: "series" | "sku" | "model";
  subjectEntityId: string;
  parameterKey: string;
  operation: "set" | "add" | "multiply" | "clear";
  operand: unknown;
}): { before: unknown; after: unknown; traceHash: string } {
  const placeholder: PatchRevisionRecord = {
    patchId: "__draft__",
    patchRevision: 1,
    scopeType: input.scopeType,
    layerType: input.scopeType,
    subjectEntityId: input.subjectEntityId,
    subjectName: input.subjectEntityId,
    baseRuleSetVersion: currentPublishedRuleSet(input.state).id,
    baseObjectRevision: 1,
    state: "DRAFT",
    mirrorSyncState: "NOT_SYNCED",
    attentionStates: [],
    reason: "draft",
    evidence: [],
    createdBy: "draft",
    createdAt: "1970-01-01T00:00:00.000Z",
    snapshotRefs: [],
    operations: [],
    revisionHash: "draft",
  };
  const chain = subjectChain(input.state, placeholder);
  const active = currentRevisionByPatchId(input.state, chain.patchIds, placeholder)
    .filter((revision) => revision.patchId !== placeholder.patchId);
  const sku = "sku" in chain
    ? chain.sku
    : input.state.skuDrawers
      .filter((entry) => entry.seriesId === chain.series.id)
      .sort((left, right) => left.targetPullKg - right.targetPullKg || left.id.localeCompare(right.id))[0];
  const projection = input.state.derivedProjections.find((entry) => entry.id === sku?.projectionMatch.projectionId);
  if (!projection) throw new PatchOffsetPolicyError("PATCH_PROJECTION_MISSING", "当前对象没有权威 Projection 基线。");
  const panel = applyRevisions(projection.values, active);
  const before = panel[input.parameterKey];
  let after: unknown;
  if (input.operation === "set") after = input.operand;
  else if (input.operation === "clear") after = before;
  else {
    if (typeof before !== "number" || typeof input.operand !== "number") {
      throw new PatchOffsetPolicyError("PATCH_NUMERIC_OPERATION_INVALID", "add/multiply 必须作用于当前面板有限数值。");
    }
    after = input.operation === "add" ? before + input.operand : before * input.operand;
  }
  if (typeof after === "number" && !Number.isFinite(after)) {
    throw new PatchOffsetPolicyError("PATCH_NON_FINITE_VALUE", "Patch 结果必须是有限数值。");
  }
  return {
    before,
    after,
    traceHash: deterministicHash({ parameterKey: input.parameterKey, operation: input.operation, before, operand: input.operand, after }),
  };
}

export function createWorkspacePatchReview(input: {
  state: WorkspaceState;
  target: PatchRevisionRecord;
  reviewedBy: string;
  reviewedAt: string;
}): { evaluation: PatchRangeEvaluation; batch: import("./types").PatchReviewBatch } {
  const policy = findPublishedPatchOffsetPolicy(input.state.workspacePolicies);
  const object = createAuthoritativePatchObjectFromWorkspace(input.state, input.target);
  const evaluation = evaluateAuthoritativePatchFinalRanges({
    policy,
    gate: "REVIEW",
    objects: [object],
  });
  const batch = createPatchReviewBatch({
    evaluation,
    reviewedBy: input.reviewedBy,
    reviewedAt: input.reviewedAt,
  });
  return { evaluation, batch };
}

export function currentPatchApprovalEvidence(
  state: WorkspaceState,
  target: PatchRevisionRecord,
): {
  policy: PatchOffsetPolicyVersion;
  reviewBatch: import("./types").PatchReviewBatch;
  waivers: import("./types").PatchValidationWaiver[];
  subjectRef: PatchReviewSubjectRef;
  objectInputHash: string;
  patchSetHash: string;
} | undefined {
  let policy: PatchOffsetPolicyVersion | undefined;
  let object: AuthoritativePatchObject;
  try {
    policy = findPublishedPatchOffsetPolicy(state.workspacePolicies);
    if (!policy) return undefined;
    object = createAuthoritativePatchObjectFromWorkspace(state, target);
  } catch {
    return undefined;
  }
  const identity = authoritativeObjectIdentity(object);
  let currentEvaluation: PatchRangeEvaluation;
  try {
    currentEvaluation = evaluateAuthoritativePatchFinalRanges({
      policy,
      gate: "REVIEW",
      objects: [object],
    });
  } catch {
    return undefined;
  }
  const currentHashes = {
    [`${object.subjectRef.scopeType}:${object.subjectRef.entityId}@${object.subjectRef.revision}`]: identity.objectInputHash,
  };
  const reviewBatch = [...state.patchReviewBatches]
    .filter((entry) => entry.gate === "REVIEW" && entry.policyVersion === policy.version)
    .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))
    .map((entry) => invalidatePatchReviewBatch({ batch: entry, currentObjectInputHashes: currentHashes }))
    .find((entry) => {
      let expected: import("./types").PatchReviewBatch;
      try {
        expected = createPatchReviewBatch({
          evaluation: currentEvaluation,
          reviewedBy: entry.reviewedBy,
          reviewedAt: entry.reviewedAt,
        });
      } catch {
        return false;
      }
      return expected.inputHash === entry.inputHash
        && expected.batchId === entry.batchId
        && entry.objectEvidence.some((evidence) =>
          evidence.state === "FRESH"
          && evidence.subjectRef.scopeType === object.subjectRef.scopeType
          && evidence.subjectRef.entityId === object.subjectRef.entityId
          && evidence.subjectRef.revision === object.subjectRef.revision
          && evidence.objectInputHash === identity.objectInputHash
          && evidence.patchSetHash === identity.patchSetHash
          && evidence.patchReferences.some((reference) =>
            reference.patchId === target.patchId && reference.patchRevision === target.patchRevision));
    });
  if (!reviewBatch) return undefined;
  return {
    policy,
    reviewBatch,
    waivers: state.patchValidationWaivers,
    subjectRef: object.subjectRef,
    objectInputHash: identity.objectInputHash,
    patchSetHash: identity.patchSetHash,
  };
}

export function reviewWorkspacePatchRevision(input: {
  state: WorkspaceState;
  patchId: string;
  patchRevision: number;
  nextState: "APPROVED" | "ACTIVE" | "WITHDRAWN";
  reviewer: string;
  reviewedAt: string;
  capabilities: Iterable<string>;
}): WorkspaceState {
  const target = input.state.patchLedger.revisions.find((revision) =>
    revision.patchId === input.patchId && revision.patchRevision === input.patchRevision);
  if (!target) {
    throw new PatchOffsetPolicyError("PATCH_REVISION_NOT_FOUND", "Patch revision 不存在。");
  }
  const approvalEvidence = input.nextState === "WITHDRAWN"
    ? undefined
    : currentPatchApprovalEvidence(input.state, target);
  if (input.nextState !== "WITHDRAWN" && !findPublishedPatchOffsetPolicy(input.state.workspacePolicies)) {
    throw new PatchOffsetPolicyError("PATCH_OFFSET_POLICY_MISSING", "批准 Patch 前缺少已发布 PatchOffsetPolicyVersion。");
  }
  if (input.nextState !== "WITHDRAWN" && !approvalEvidence) {
    throw new PatchOffsetPolicyError(
      "PATCH_REVIEW_EVIDENCE_STALE",
      "当前对象 revision、RuleSet、输入或 PatchSet 已变化，必须重新生成整体复核证据。",
    );
  }
  return {
    ...input.state,
    patchLedger: reviewPatchRevision({
      ledger: input.state.patchLedger,
      patchId: input.patchId,
      patchRevision: input.patchRevision,
      nextState: input.nextState,
      reviewer: input.reviewer,
      reviewedAt: input.reviewedAt,
      capabilities: input.capabilities,
      approvalEvidence,
    }),
  };
}

export function submitWorkspacePatchRevision(input: {
  state: WorkspaceState;
  patchId: string;
  patchRevision: number;
  capabilities: Iterable<string>;
}): WorkspaceState {
  return {
    ...input.state,
    patchLedger: submitPatchRevision({
      ledger: input.state.patchLedger,
      patchId: input.patchId,
      patchRevision: input.patchRevision,
      capabilities: input.capabilities,
    }),
  };
}

export function reviewWorkspacePatchBatch(input: {
  state: WorkspaceState;
  batchId: string;
  nextState: "APPROVED" | "ACTIVE";
  reviewer: string;
  reviewedAt: string;
  capabilities: Iterable<string>;
}): WorkspaceState {
  const batch = input.state.patchReviewBatches.find((entry) => entry.batchId === input.batchId);
  if (!batch) throw new PatchOffsetPolicyError("PATCH_REVIEW_EVIDENCE_MISSING", "整体复核批次不存在。");
  const policy = findPublishedPatchOffsetPolicy(input.state.workspacePolicies);
  if (!policy) throw new PatchOffsetPolicyError("PATCH_OFFSET_POLICY_MISSING", "当前工作区缺少已发布 PatchOffsetPolicyVersion。");
  const authorities = batch.objectEvidence.map((evidence) => {
    const reference = evidence.patchReferences[0];
    const target = reference && input.state.patchLedger.revisions.find((revision) =>
      revision.patchId === reference.patchId && revision.patchRevision === reference.patchRevision);
    if (!target) throw new PatchOffsetPolicyError("PATCH_REVISION_EVIDENCE_MISSING", "批次引用的 Patch revision 不存在。");
    return createAuthoritativePatchObjectFromWorkspace(input.state, target);
  });
  const currentEvaluation = evaluateAuthoritativePatchFinalRanges({
    policy,
    gate: "REVIEW",
    objects: authorities,
  });
  const expectedBatch = createPatchReviewBatch({
    evaluation: currentEvaluation,
    reviewedBy: batch.reviewedBy,
    reviewedAt: batch.reviewedAt,
  });
  if (expectedBatch.inputHash !== batch.inputHash || expectedBatch.batchId !== batch.batchId) {
    throw new PatchOffsetPolicyError(
      "PATCH_REVIEW_EVIDENCE_STALE",
      "整体复核批次与当前权威对象、RuleSet、ParameterDefinition、最终面板或 PatchSet 不一致。",
    );
  }
  const currentObjects = authorities.map((object) => {
    const identity = authoritativeObjectIdentity(object);
    return {
      subjectRef: object.subjectRef,
      objectInputHash: identity.objectInputHash,
      patchSetHash: identity.patchSetHash,
    };
  });
  return {
    ...input.state,
    patchLedger: reviewPatchBatch({
      ledger: input.state.patchLedger,
      reviewBatch: batch,
      policy,
      waivers: input.state.patchValidationWaivers,
      currentObjects,
      nextState: input.nextState,
      reviewer: input.reviewer,
      reviewedAt: input.reviewedAt,
      capabilities: input.capabilities,
    }),
  };
}
