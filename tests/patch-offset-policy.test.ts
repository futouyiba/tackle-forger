import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPatchGateCanProceed,
  assertPatchRangeEvaluationIntegrity,
  assertPatchReviewCoverage,
  assertPublishedPatchOffsetPolicy,
  assertSeriesDiscreteRangeCoverage,
  createCanonicalPatchOffsetPolicyVersion,
  createPatchReviewBatch,
  createPatchValidationWaiverDecision,
  evaluatePatchFinalRanges,
  expectedSeriesDiscreteRangeContexts,
  findPatchReviewEvidence,
  findPublishedPatchOffsetPolicy,
  invalidatePatchReviewBatch,
  nextPatchStateAfterBaseChange,
  PatchOffsetPolicyError,
  type PatchFinalRangeContext,
} from "../lib/patch-offset-policy";
import { buildPatchRevision, emptyPatchLedger, orderedPatchReferences, PatchLedgerError, reviewPatchBatch } from "../lib/patch-ledger";
import { publishConfigurationSnapshot, verifySnapshotIntegrity } from "../lib/publishing";
import { createExportManifest } from "../lib/config-export";
import {
  assertPatchEvaluationMatchesAuthority,
  authoritativeObjectIdentity,
  createAuthoritativePatchObjectFromWorkspace,
  createWorkspacePatchReview,
  deriveAuthoritativePatchContexts,
  evaluateAuthoritativePatchFinalRanges,
  preparePatchOperationFromWorkspace,
  reviewWorkspacePatchRevision,
  type AuthoritativePatchObject,
} from "../lib/patch-authority";
import { deterministicHash } from "../lib/rule-kernel";
import {
  formalAffixRuntimeEvidence,
  formalProjection,
  testReductionPolicy,
} from "./helpers/reduction-policy";
import { createSeedState } from "../lib/seed";
import type {
  PatchOffsetPolicyVersion,
  PatchReviewSubjectRef,
  PatchRevisionRecord,
  ProjectionTraceStep,
} from "../lib/types";

const NOW = "2026-07-23T08:00:00.000Z";

function finalSettlementTrace(values: Record<string, number | string>): ProjectionTraceStep[] {
  return [{
    layer: "final_review_patch",
    sourceIds: ["test:final-settlement"],
    contributions: Object.entries(values).map(([parameterKey, value], index) => ({
      sequence: index + 1, ruleId: `test:${parameterKey}`, sourceId: "test:final-settlement",
      sourceName: "最终结算", parameterKey, operation: "base", before: null, operand: value, after: value,
    })),
  }];
}

function policy(): PatchOffsetPolicyVersion {
  return createCanonicalPatchOffsetPolicyVersion({
    createdAt: NOW,
    publishedAt: NOW,
    publishedBy: "policy-owner",
  });
}

function refs(id = "patch:model:1") {
  const references = [{
    patchId: id,
    patchRevision: 1,
    orderedOperationIds: [`${id}:op:1`, `${id}:op:2`],
  }];
  return { references, patchSetHash: deterministicHash(references) };
}

function context(overrides: Partial<PatchFinalRangeContext> = {}): PatchFinalRangeContext {
  const frozen = refs();
  const base: PatchFinalRangeContext = {
    contextId: "model:1/pull:15/force",
    scopeType: "model",
    itemPartId: "part:rod",
    parameterKey: "force",
    standardUnit: "kg",
    subjectRef: { scopeType: "model", entityId: "model:1", revision: 3 },
    objectInputHash: "input:model:1:r3",
    skuRef: "sku:15",
    targetPullKg: 15,
    projectionId: "projection:15",
    weightBandId: "weight-band:15",
    constraintRuleRef: "range:rod:force:15",
    constraintRuleVersion: "ruleset:7",
    finalValue: 12,
    finalValueUnit: "kg",
    validRange: { min: 8, max: 12, unit: "kg" },
    patchReferences: frozen.references,
    patchSetHash: frozen.patchSetHash,
    operationTrace: [],
    traceHash: "",
    ...overrides,
  };
  const operationTrace = overrides.operationTrace ?? base.patchReferences
    .flatMap((reference) => reference.orderedOperationIds)
    .map((operationId) => ({
      operationId,
      parameterKey: "force",
      operation: "add" as const,
      before: 10,
      operand: 0,
      after: 10,
    }));
  return {
    ...base,
    operationTrace,
    traceHash: overrides.traceHash ?? deterministicHash(operationTrace),
  };
}

test("OPEN-004 策略固定为最终范围、无独立阈值、包含端点", () => {
  const published = policy();
  assert.doesNotThrow(() => assertPublishedPatchOffsetPolicy(published));

  const hiddenThreshold = structuredClone(published) as PatchOffsetPolicyVersion & {
    value: PatchOffsetPolicyVersion["value"] & { warningThreshold: number };
  };
  hiddenThreshold.value.warningThreshold = 0.2;
  const content = structuredClone(hiddenThreshold) as Partial<typeof hiddenThreshold>;
  delete content.contentHash;
  hiddenThreshold.contentHash = deterministicHash(content);
  assert.throws(
    () => assertPublishedPatchOffsetPolicy(hiddenThreshold),
    (error: unknown) => error instanceof PatchOffsetPolicyError
      && error.code === "PATCH_OFFSET_POLICY_INVALID",
  );
});

test("缺少已发布策略时允许计算证据但以 BLOCKER 关闭正式关口", () => {
  const evaluation = evaluatePatchFinalRanges({
    gate: "PUBLISH",
    contexts: [context()],
  });
  assert.equal(evaluation.results.length, 1);
  assert.ok(evaluation.issues.some((issue) =>
    issue.code === "PATCH_OFFSET_POLICY_MISSING"
    && issue.severity === "BLOCKER"));
  assert.throws(
    () => assertPatchGateCanProceed({ evaluation }),
    (error: unknown) => error instanceof PatchOffsetPolicyError
      && error.code === "PATCH_OFFSET_POLICY_MISSING",
  );
});

test("发布门禁拒绝空范围评估、被改写结果和空 Patch revision 兼容旁路", () => {
  const empty = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "PUBLISH",
    contexts: [],
  });
  assert.throws(
    () => assertPatchRangeEvaluationIntegrity({
      evaluation: empty,
      policy: policy(),
      expectedSubjectRef: context().subjectRef,
      expectedPatchSetHash: context().patchSetHash,
      expectedPatchReferences: context().patchReferences,
      expectedObjectInputHash: context().objectInputHash,
    }),
    (error: unknown) => error instanceof PatchOffsetPolicyError
      && error.code === "PATCH_RANGE_EVALUATION_SUBJECT_MISSING",
  );

  const tampered = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "PUBLISH",
    contexts: [context({ finalValue: 13 })],
  });
  tampered.issues = [];
  assert.throws(
    () => assertPatchRangeEvaluationIntegrity({
      evaluation: tampered,
      policy: policy(),
      expectedSubjectRef: context().subjectRef,
      expectedPatchSetHash: context().patchSetHash,
      expectedPatchReferences: context().patchReferences,
      expectedObjectInputHash: context().objectInputHash,
    }),
    (error: unknown) => error instanceof PatchOffsetPolicyError
      && error.code === "PATCH_RANGE_EVALUATION_HASH_MISMATCH",
  );

  assert.throws(
    () => publishConfigurationSnapshot({
      publicationMode: "new_formal",
      patches: [{}],
      patchRevisions: [],
    } as never),
    /必须使用可冻结 operation 顺序的 Patch revision/,
  );
});

test("只校验当前关口累计最终值，端点包含且先归一到标准单位", () => {
  const endpoint = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "REVIEW",
    contexts: [context({ finalValue: 12_000, finalValueUnit: "g" })],
  });
  assert.equal(endpoint.results[0].finalValue, 12);
  assert.equal(endpoint.results[0].valid, true);
  assert.equal(endpoint.issues.length, 0);
  assert.doesNotThrow(() => assertPatchGateCanProceed({ evaluation: endpoint }));

  const below = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "REVIEW",
    contexts: [context({ finalValue: 7.999 })],
  });
  assert.equal(below.results[0].valid, false);
  assert.equal(below.issues[0].code, "PATCH_FINAL_VALUE_OUT_OF_RANGE");
  assert.equal(below.issues[0].severity, "ERROR");

  const invalidTrace = context();
  invalidTrace.operationTrace[0].after = 99;
  invalidTrace.traceHash = deterministicHash(invalidTrace.operationTrace);
  const blocked = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "PUBLISH",
    contexts: [invalidTrace],
  });
  assert.ok(blocked.issues.some((issue) =>
    issue.code === "PATCH_TRACE_REPLAY_MISMATCH"
    && issue.severity === "BLOCKER"));
});

test("Waiver 单 Gate 生效，EXPORT 还必须精确匹配环境与渠道", () => {
  const publishEvaluation = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "PUBLISH",
    contexts: [context({ finalValue: 13 })],
  });
  const issue = publishEvaluation.issues[0];
  const approved = createPatchValidationWaiverDecision({
    issues: publishEvaluation.issues,
    requested: [{ issueFingerprint: issue.fingerprint!, gate: "PUBLISH" }],
    policyVersion: policy().version,
    scopeRef: context().subjectRef,
    objectInputHash: context().objectInputHash,
    patchSetHash: context().patchSetHash,
    reason: "保留当前设计取舍",
    approvedBy: "reviewer",
    approvedAt: NOW,
  });
  assert.doesNotThrow(() => assertPatchGateCanProceed({
    evaluation: publishEvaluation,
    waivers: approved.waivers,
  }));

  const reviewEvaluation = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "REVIEW",
    contexts: [context({ finalValue: 13 })],
  });
  assert.throws(() => assertPatchGateCanProceed({
    evaluation: reviewEvaluation,
    waivers: approved.waivers,
  }), /REVIEW/);

  const exportEvaluation = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "EXPORT",
    environmentId: "online",
    channelKey: "1001",
    contexts: [context({ finalValue: 13 })],
  });
  assert.throws(
    () => createPatchValidationWaiverDecision({
      issues: exportEvaluation.issues,
      requested: [{
        issueFingerprint: exportEvaluation.issues[0].fingerprint!,
        gate: "EXPORT",
        environmentId: "test",
        channelKey: "1001",
      }],
      policyVersion: policy().version,
      scopeRef: context().subjectRef,
      objectInputHash: context().objectInputHash,
      patchSetHash: context().patchSetHash,
      reason: "错误目标",
      approvedBy: "reviewer",
      approvedAt: NOW,
    }),
    /不允许/,
  );
});

test("Series 必须覆盖每个真实 SKU；没有 SKU 时覆盖每个声明拉力", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const skus = state.skuDrawers.filter((sku) => sku.seriesId === series.id);
  const expected = expectedSeriesDiscreteRangeContexts({ series, skus });
  assert.ok(expected.length >= 2);
  const contexts = expected.map((entry, index) => context({
    contextId: `series:${series.id}:${index}`,
    scopeType: "series",
    subjectRef: { scopeType: "series", entityId: series.id, revision: series.revision },
    skuRef: entry.skuRef,
    targetPullKg: entry.targetPullKg,
  }));
  assert.doesNotThrow(() => assertSeriesDiscreteRangeCoverage({ expected, contexts }));
  assert.throws(
    () => assertSeriesDiscreteRangeCoverage({ expected, contexts: contexts.slice(0, -1) }),
    /缺少离散上下文/,
  );

  const declared = expectedSeriesDiscreteRangeContexts({ series, skus: [] });
  assert.deepEqual(
    declared.map((entry) => entry.targetPullKg),
    [...series.targetPullSpecifications]
      .sort((left, right) => left.targetPullKgf - right.targetPullKgf)
      .map((entry) => entry.targetPullKgf),
  );
  assert.ok(declared.every((entry) => entry.skuRef === undefined));
});

test("Series 范围上下文排除 superseded 历史 SKU，并在没有当前 SKU 时回退声明拉力", () => {
  const state = createSeedState();
  const series = structuredClone(state.seriesDefinitions[0]!);
  const historicalSku = structuredClone(state.skuDrawers.find(
    (sku) => sku.id === "sku:qinglu-obstacle-1.5",
  )!);
  historicalSku.status = "superseded";
  series.targetPullSpecifications = series.targetPullSpecifications.filter(
    (entry) => entry.skuId !== historicalSku.id,
  );
  series.skuIds = series.skuIds.filter((skuId) => skuId !== historicalSku.id);
  const currentSku = state.skuDrawers.find(
    (sku) => sku.id === "sku:qinglu-obstacle-1.8",
  )!;

  assert.deepEqual(
    expectedSeriesDiscreteRangeContexts({
      series,
      skus: [historicalSku, currentSku],
    }),
    [{ skuRef: currentSku.id, targetPullKg: currentSku.targetPullKg }],
  );
  assert.deepEqual(
    expectedSeriesDiscreteRangeContexts({
      series,
      skus: [historicalSku],
    }),
    [{ targetPullKg: 1.8 }],
  );
});

test("整体复核冻结 Patch 明细；变化只使受影响对象 STALE", () => {
  const secondSubject: PatchReviewSubjectRef = {
    scopeType: "model",
    entityId: "model:2",
    revision: 5,
  };
  const evaluation = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "PUBLISH",
    contexts: [
      context(),
      context({
        contextId: "model:2/pull:20/force",
        subjectRef: secondSubject,
        objectInputHash: "input:model:2:r5",
        patchReferences: refs("patch:model:2").references,
        patchSetHash: refs("patch:model:2").patchSetHash,
      }),
    ],
  });
  const batch = createPatchReviewBatch({
    evaluation,
    reviewedBy: "reviewer",
    reviewedAt: NOW,
  });
  assert.equal(batch.objectEvidence.length, 2);
  assert.ok(findPatchReviewEvidence({
    batch,
    subjectRef: context().subjectRef,
    objectInputHash: context().objectInputHash,
    patchSetHash: context().patchSetHash,
    patchReference: context().patchReferences[0],
  }));

  const invalidated = invalidatePatchReviewBatch({
    batch,
    currentObjectInputHashes: {
      "model:model:1@3": "input:model:1:r4",
      "model:model:2@5": "input:model:2:r5",
    },
  });
  assert.equal(invalidated.status, "PARTIALLY_STALE");
  assert.equal(invalidated.objectEvidence.find((entry) => entry.subjectRef.entityId === "model:1")?.state, "STALE");
  assert.equal(invalidated.objectEvidence.find((entry) => entry.subjectRef.entityId === "model:2")?.state, "FRESH");
  assert.doesNotThrow(() => assertPatchReviewCoverage({
    batch: invalidated,
    policyVersion: policy().version,
    subjectRef: secondSubject,
    objectInputHash: "input:model:2:r5",
    patchSetHash: refs("patch:model:2").patchSetHash,
  }));
  const tampered = structuredClone(batch);
  tampered.objectEvidence[0].finalValues[Object.keys(tampered.objectEvidence[0].finalValues)[0]] += 1;
  assert.throws(() => assertPatchReviewCoverage({
    batch: tampered,
    policyVersion: policy().version,
    subjectRef: context().subjectRef,
    objectInputHash: context().objectInputHash,
    patchSetHash: context().patchSetHash,
  }), /完整性校验失败/);
});

test("一次批量复核可以原子批准多个对象的完整 Patch 集合", () => {
  const makeRevision = (id: string, subjectEntityId: string) => buildPatchRevision({
    patchId: id,
    patchRevision: 1,
    scopeType: "model",
    layerType: "model",
    subjectEntityId,
    subjectName: subjectEntityId,
    baseRuleSetVersion: "ruleset:7",
    baseObjectRevision: 1,
    state: "PENDING_REVIEW",
    mirrorSyncState: "NOT_SYNCED",
    attentionStates: [],
    reason: "batch review",
    evidence: [],
    createdBy: "designer",
    createdAt: NOW,
    snapshotRefs: [],
    operations: [{
      operationId: `${id}:op:1`,
      operationIndex: 0,
      parameterKey: "force",
      operation: "add",
      operand: 1,
      before: 10,
      after: 11,
    }],
  });
  const first = makeRevision("patch:batch:1", "model:batch:1");
  const second = makeRevision("patch:batch:2", "model:batch:2");
  const firstFrozen = orderedPatchReferences([first]);
  const secondFrozen = orderedPatchReferences([second]);
  const evaluation = evaluatePatchFinalRanges({
    policy: policy(),
    gate: "REVIEW",
    contexts: [
      context({
        contextId: "model:batch:1/force",
        subjectRef: { scopeType: "model", entityId: "model:batch:1", revision: 1 },
        objectInputHash: "input:batch:1",
        patchReferences: firstFrozen.references,
        patchSetHash: firstFrozen.patchSetHash,
      }),
      context({
        contextId: "model:batch:2/force",
        subjectRef: { scopeType: "model", entityId: "model:batch:2", revision: 1 },
        objectInputHash: "input:batch:2",
        patchReferences: secondFrozen.references,
        patchSetHash: secondFrozen.patchSetHash,
      }),
    ],
  });
  const batch = createPatchReviewBatch({ evaluation, reviewedBy: "reviewer", reviewedAt: NOW });
  const ledger = { ...emptyPatchLedger(), revisions: [first, second] };
  assert.throws(() => reviewPatchBatch({
    ledger,
    reviewBatch: batch,
    policy: policy(),
    currentObjects: batch.objectEvidence.map((evidence, index) => ({
      subjectRef: index === 0 ? { ...evidence.subjectRef, revision: evidence.subjectRef.revision + 1 } : evidence.subjectRef,
      objectInputHash: evidence.objectInputHash,
      patchSetHash: evidence.patchSetHash,
    })),
    nextState: "APPROVED",
    reviewer: "reviewer",
    reviewedAt: NOW,
    capabilities: ["patch.review"],
  }), (error: unknown) => error instanceof PatchLedgerError && error.code === "PATCH_REVIEW_EVIDENCE_STALE");
  const approved = reviewPatchBatch({
    ledger,
    reviewBatch: batch,
    policy: policy(),
    currentObjects: batch.objectEvidence.map((evidence) => ({
      subjectRef: evidence.subjectRef,
      objectInputHash: evidence.objectInputHash,
      patchSetHash: evidence.patchSetHash,
    })),
    nextState: "APPROVED",
    reviewer: "reviewer",
    reviewedAt: NOW,
    capabilities: ["patch.review"],
  });
  assert.deepEqual(approved.revisions.map((revision) => revision.state), ["APPROVED", "APPROVED"]);
  assert.deepEqual(ledger.revisions.map((revision) => revision.state), ["PENDING_REVIEW", "PENDING_REVIEW"]);
});

test("基底变化按 add/multiply、set、clear 与 FinalReview 语义进入复核或 rebase", () => {
  const revision = (operation: PatchRevisionRecord["operations"][number]["operation"], scopeType: PatchRevisionRecord["scopeType"] = "model") => ({
    scopeType,
    operations: [{ operation }],
  }) as PatchRevisionRecord;
  assert.equal(nextPatchStateAfterBaseChange({
    revision: revision("add"),
    parameterTypeAndUnitCompatible: true,
    clearStillMeansInheritedOverride: true,
  }), "PENDING_REVIEW");
  assert.equal(nextPatchStateAfterBaseChange({
    revision: revision("set"),
    parameterTypeAndUnitCompatible: true,
    clearStillMeansInheritedOverride: true,
  }), "REBASE_REQUIRED");
  assert.equal(nextPatchStateAfterBaseChange({
    revision: revision("clear"),
    parameterTypeAndUnitCompatible: true,
    clearStillMeansInheritedOverride: false,
  }), "REBASE_REQUIRED");
  assert.equal(nextPatchStateAfterBaseChange({
    revision: revision("multiply", "final_review"),
    parameterTypeAndUnitCompatible: true,
    clearStillMeansInheritedOverride: true,
  }), "PENDING_REVIEW");
});

test("实际工作区命令计算 Trace、包含端点，并在伪造或当前版本变化时 fail-closed", () => {
  const state = createSeedState();
  const model = state.purchasableModels[0];
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const projection = state.derivedProjections.find((entry) => entry.id === sku.projectionMatch.projectionId)!;
  const numeric = Object.entries(projection.values)
    .find((entry): entry is [string, number] => typeof entry[1] === "number")!;
  series.patchIds = [];
  sku.patchIds = [];
  model.patchIds = [];
  state.parameters = state.parameters.map((parameter) => parameter.key === numeric[0]
    ? { ...parameter, targetRange: { min: numeric[1], max: numeric[1] } }
    : parameter);
  const prepared = preparePatchOperationFromWorkspace({
    state,
    scopeType: "model",
    subjectEntityId: model.id,
    parameterKey: numeric[0],
    operation: "add",
    operand: 0,
  });
  assert.equal(prepared.before, numeric[1]);
  assert.equal(prepared.after, numeric[1]);
  const ruleSet = [...state.ruleSetVersions].filter((entry) => entry.status === "published")
    .sort((left, right) => right.version - left.version)[0];
  const revision = buildPatchRevision({
    patchId: "patch:model:ui-command",
    patchRevision: 1,
    scopeType: "model",
    layerType: "model",
    subjectEntityId: model.id,
    subjectName: model.name,
    baseRuleSetVersion: ruleSet.id,
    baseObjectRevision: model.revision,
    state: "PENDING_REVIEW",
    mirrorSyncState: "NOT_SYNCED",
    attentionStates: [],
    reason: "actual UI command chain",
    evidence: [prepared.traceHash],
    createdBy: "designer",
    createdAt: NOW,
    snapshotRefs: [],
    operations: [{
      operationId: "patch:model:ui-command:op:1",
      operationIndex: 0,
      parameterKey: numeric[0],
      operation: "add",
      operand: 0,
      before: prepared.before,
      after: prepared.after,
    }],
  });
  state.patchLedger.revisions.push(revision);
  model.patchIds.push(revision.patchId);
  const authority = createAuthoritativePatchObjectFromWorkspace(state, revision);
  const forgedEvaluation = evaluatePatchFinalRanges({
    policy: findPublishedPatchOffsetPolicy(state.workspacePolicies),
    gate: "REVIEW",
    contexts: deriveAuthoritativePatchContexts(authority).map((entry) => ({
      ...entry,
      finalValue: entry.finalValue + 100,
      validRange: { min: entry.finalValue + 99, max: entry.finalValue + 101, unit: entry.validRange.unit },
    })),
  });
  assert.throws(
    () => assertPatchEvaluationMatchesAuthority({
      evaluation: forgedEvaluation,
      policy: findPublishedPatchOffsetPolicy(state.workspacePolicies),
      objects: [authority],
    }),
    (error: unknown) => error instanceof PatchOffsetPolicyError
      && error.code === "PATCH_RANGE_EVALUATION_AUTHORITY_MISMATCH",
  );
  const forgedBatch = createPatchReviewBatch({
    evaluation: forgedEvaluation,
    reviewedBy: "reviewer",
    reviewedAt: NOW,
  });
  state.patchReviewBatches.push(forgedBatch);
  assert.throws(
    () => reviewWorkspacePatchRevision({
      state,
      patchId: revision.patchId,
      patchRevision: revision.patchRevision,
      nextState: "APPROVED",
      reviewer: "reviewer",
      reviewedAt: NOW,
      capabilities: ["patch.review"],
    }),
    (error: unknown) => error instanceof PatchOffsetPolicyError && error.code === "PATCH_REVIEW_EVIDENCE_STALE",
  );
  state.patchReviewBatches = [];
  const review = createWorkspacePatchReview({ state, target: revision, reviewedBy: "reviewer", reviewedAt: NOW });
  assert.equal(review.evaluation.results[0].valid, true);
  assert.equal(review.evaluation.results[0].min, numeric[1]);
  assert.equal(review.evaluation.results[0].max, numeric[1]);
  state.patchReviewBatches.push(review.batch);
  const approved = reviewWorkspacePatchRevision({
    state,
    patchId: revision.patchId,
    patchRevision: revision.patchRevision,
    nextState: "APPROVED",
    reviewer: "reviewer",
    reviewedAt: NOW,
    capabilities: ["patch.review"],
  });
  assert.equal(approved.patchLedger.revisions.find((entry) => entry.patchId === revision.patchId)?.state, "APPROVED");
  const active = reviewWorkspacePatchRevision({
    state: approved,
    patchId: revision.patchId,
    patchRevision: revision.patchRevision,
    nextState: "ACTIVE",
    reviewer: "reviewer",
    reviewedAt: NOW,
    capabilities: ["patch.review"],
  });
  assert.equal(active.patchLedger.revisions.find((entry) => entry.patchId === revision.patchId)?.state, "ACTIVE");

  model.revision += 1;
  assert.throws(
    () => reviewWorkspacePatchRevision({
      state,
      patchId: revision.patchId,
      patchRevision: revision.patchRevision,
      nextState: "APPROVED",
      reviewer: "reviewer",
      reviewedAt: NOW,
      capabilities: ["patch.review"],
    }),
    (error: unknown) => error instanceof PatchOffsetPolicyError && error.code === "PATCH_REVIEW_EVIDENCE_STALE",
  );
  model.revision -= 1;
  ruleSet.status = "superseded";
  state.ruleSetVersions.push({
    ...ruleSet,
    id: `${ruleSet.id}:next`,
    version: ruleSet.version + 1,
    status: "published",
    publishedAt: NOW,
  });
  assert.throws(
    () => reviewWorkspacePatchRevision({
      state,
      patchId: revision.patchId,
      patchRevision: revision.patchRevision,
      nextState: "APPROVED",
      reviewer: "reviewer",
      reviewedAt: NOW,
      capabilities: ["patch.review"],
    }),
    (error: unknown) => error instanceof PatchOffsetPolicyError && error.code === "PATCH_REVIEW_EVIDENCE_STALE",
  );
});

test("v16 发布规范策略并隔离旧阈值，正式 Snapshot 冻结治理证据且旧快照不变", () => {
  const state = createSeedState();
  const publishedPolicy = findPublishedPatchOffsetPolicy(state.workspacePolicies);
  assert.ok(publishedPolicy);
  assert.deepEqual(state.ruleSettings.patchOffsetLimits, {});

  const oldSnapshot = state.configurationSnapshots[0];
  const oldSnapshotBytes = JSON.stringify(oldSnapshot);
  const model = state.purchasableModels.find((entry) => entry.id === oldSnapshot.modelId)!;
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const reductionStackingPolicy = testReductionPolicy();
  const projection = formalProjection(
    state.derivedProjections.find((entry) => entry.id === oldSnapshot.projectionId)!,
    reductionStackingPolicy,
    oldSnapshot.finalPanelValues,
  );
  const numericEntry = Object.entries(oldSnapshot.finalPanelValues)
    .find((entry): entry is [string, number] => typeof entry[1] === "number")!;
  const governedRevision = buildPatchRevision({
    patchId: "patch:open004:publish",
    patchRevision: 1,
    scopeType: "model",
    layerType: "model",
    subjectEntityId: model.id,
    subjectName: model.name,
    baseRuleSetVersion: projection.ruleSetVersion,
    baseObjectRevision: model.revision,
    state: "ACTIVE",
    mirrorSyncState: "NOT_SYNCED",
    attentionStates: [],
    reason: "OPEN-004 formal publication fixture",
    evidence: [],
    createdBy: "publisher",
    createdAt: NOW,
    snapshotRefs: [],
    operations: [{
      operationId: "patch:open004:publish:op:1",
      operationIndex: 0,
      parameterKey: numericEntry[0],
      operation: "add",
      operand: 0,
      before: numericEntry[1],
      after: numericEntry[1],
    }],
  });
  const patchRevisions = [governedRevision];
  const frozen = orderedPatchReferences(patchRevisions);
  const ruleSet = state.ruleSetVersions.find((entry) =>
    entry.id === projection.ruleSetVersion || String(entry.version) === projection.ruleSetVersion)!;
  const parameterDefinitions = state.parameters.map((parameter) =>
    parameter.key === numericEntry[0]
      ? { ...parameter, targetRange: { min: numericEntry[1] - 2, max: numericEntry[1] - 1 } }
      : parameter);
  const publishAuthority: AuthoritativePatchObject = {
    subjectRef: { scopeType: "model", entityId: model.id, revision: model.revision },
    ruleSet,
    parameterDefinitions,
    patchRevisions,
    contexts: [{
      contextId: `${model.id}:${sku.id}:${projection.id}`,
      itemPartId: sku.projectionMatch.itemPartId,
      projection,
      finalPanelValues: oldSnapshot.finalPanelValues,
      weightBandId: sku.projectionMatch.weightTemplateId,
      skuRef: sku.id,
      targetPullKg: sku.projectionMatch.targetPullKg,
    }],
  };
  const publishIdentity = authoritativeObjectIdentity(publishAuthority);
  const rangeEvaluation = evaluateAuthoritativePatchFinalRanges({
    policy: publishedPolicy,
    gate: "PUBLISH",
    objects: [publishAuthority],
  });
  const reviewBatch = createPatchReviewBatch({
    evaluation: rangeEvaluation,
    reviewedBy: "publisher",
    reviewedAt: NOW,
  });
  const publishWaiver = createPatchValidationWaiverDecision({
    issues: rangeEvaluation.issues,
    requested: [{ issueFingerprint: rangeEvaluation.issues[0].fingerprint!, gate: "PUBLISH" }],
    policyVersion: publishedPolicy.version,
    scopeRef: publishAuthority.subjectRef,
    objectInputHash: publishIdentity.objectInputHash,
    patchSetHash: publishIdentity.patchSetHash,
    reason: "发布保留意见通过",
    approvedBy: "publisher",
    approvedAt: NOW,
  });
  const snapshot = publishConfigurationSnapshot({
    publicationMode: "new_formal",
    workspaceId: "workspace:test",
    model,
    sku,
    seriesSkus: state.skuDrawers.filter((entry) => entry.seriesId === series.id),
    series,
    projection,
    reductionStackingPolicy,
    affixRuntimeEvidence: formalAffixRuntimeEvidence(
      projection,
      reductionStackingPolicy,
      oldSnapshot.finalPanelValues,
    ),
    finalPanelValues: oldSnapshot.finalPanelValues,
    componentSelections: oldSnapshot.componentSelections,
    patches: [],
    patchRevisions,
    patchOffsetGovernance: {
      policy: publishedPolicy,
      ruleSet,
      parameterDefinitions,
      reviewBatch,
      waivers: publishWaiver.waivers,
    },
    attributeAffixIds: oldSnapshot.attributeAffixIds,
    passiveAffixIds: oldSnapshot.passiveAffixIds,
    technologyIds: oldSnapshot.technologyIds,
    technologyDefinitions: state.technologies,
    finalSettlementTrace: finalSettlementTrace(oldSnapshot.finalPanelValues),
    passiveAffixPayloads: oldSnapshot.passiveAffixPayloads,
    compatibilityReport: oldSnapshot.compatibilityReport,
    affinityReport: oldSnapshot.affinityReport,
    qualityReport: { ...oldSnapshot.qualityReport, blockingIssues: [] },
    qualityValueAssessment: {
      modelRevisionId: `${model.id}@${model.revision}`,
      selectedQualityId: series.qualityId,
      baseAffixScore: 1,
      combinationScore: 0,
      functionScoreFactor: 1,
      finalValueScore: 1,
      affixBreakdown: [],
      combinationBreakdown: [],
      qualityRangePolicyVersion: "quality:published-v1",
      scoringPolicyVersion: "quality-scoring:v1",
      inSelectedQualityRange: true,
      formal: true,
      issues: [],
      trace: [],
      inputHash: "quality-hash",
    },
    pricingPolicyVersion: "pricing:published-v1",
    automaticPricing: {
      formal: true,
      pricingPolicyRef: "pricing:published-v1",
      valueScore: 1,
      pricingWeightBandId: "band:1",
      pricingBasketId: "basket:1",
      repairPriceUnrounded: 100,
      purchasePriceUnrounded: 100,
      purchasePrice: 100,
      trace: [{
        sequence: 1,
        formulaStep: "purchasePrice",
        sourceRevision: "pricing:test",
        source: { sheetId: "pricing:test", cell: "A1" },
        before: 100,
        operation: "multiply",
        operand: 1,
        after: 100,
        inputStatus: "CONFIRMED",
      }],
      issues: [],
      warnings: [],
      inputHash: "pricing-hash",
    },
    validationReport: [],
    warningConfirmations: {},
    publishedBy: "publisher",
    publishedAt: NOW,
    snapshotId: "snapshot:open004-v1",
    version: oldSnapshot.version + 1,
  });
  assert.equal(snapshot.patchOffsetPolicyVersion, publishedPolicy.version);
  assert.equal(snapshot.patchReviewBatchRef, reviewBatch.batchId);
  assert.equal(snapshot.patchSetHash, frozen.patchSetHash);
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  assert.equal(JSON.stringify(oldSnapshot), oldSnapshotBytes);
  assert.equal(verifySnapshotIntegrity(oldSnapshot), true);

  const exportAuthority: AuthoritativePatchObject = {
    subjectRef: { scopeType: "model", entityId: snapshot.modelId, revision: snapshot.modelRevision },
    ruleSet,
    parameterDefinitions,
    patchRevisions,
    contexts: [{
      contextId: `${snapshot.modelId}:${snapshot.projectionId}:snapshot`,
      itemPartId: snapshot.projectionMatch.itemPartId,
      projection: {
        id: snapshot.projectionId,
        ruleSetVersion: snapshot.ruleSetVersion,
        sourceHash: snapshot.contentHash,
        values: snapshot.finalPanelValues,
      },
      finalPanelValues: snapshot.finalPanelValues,
      weightBandId: snapshot.projectionMatch.weightTemplateId,
      targetPullKg: snapshot.projectionMatch.targetPullKg,
    }],
  };
  const exportIdentity = authoritativeObjectIdentity(exportAuthority);
  const exportEvaluation = evaluateAuthoritativePatchFinalRanges({
    policy: publishedPolicy,
    gate: "EXPORT",
    environmentId: "online",
    channelKey: "1001",
    objects: [exportAuthority],
  });
  const exportWaiver = createPatchValidationWaiverDecision({
    issues: exportEvaluation.issues,
    requested: [{
      issueFingerprint: exportEvaluation.issues[0].fingerprint!,
      gate: "EXPORT",
      environmentId: "online",
      channelKey: "1001",
    }],
    policyVersion: publishedPolicy.version,
    scopeRef: exportAuthority.subjectRef,
    objectInputHash: exportIdentity.objectInputHash,
    patchSetHash: exportIdentity.patchSetHash,
    reason: "仅对 online/1001 保留意见通过",
    approvedBy: "publisher",
    approvedAt: NOW,
  });
  const manifest = createExportManifest({
    packageId: "package:open004",
    generatorVersion: "1",
    mapping: { mappingId: "mapping:open004", version: "1", logicalTables: {}, rows: [], enumReferenceField: "name" },
    profile: { profileId: "profile:online:1001", label: "online/1001", executorKind: "local_companion", projectRoot: "/configs", relativeWorkbookRoot: "xlsx", configTomlPath: "config.toml", enabled: true },
    snapshot,
    availableReductionPolicies: [reductionStackingPolicy],
    environmentId: "online",
    channelKey: "1001",
    patchOffsetGovernance: {
      policy: publishedPolicy,
      ruleSet,
      parameterDefinitions,
      patchRevisions,
      waivers: exportWaiver.waivers,
    },
    originalFileHashes: {},
    entries: [{ logicalTable: "item", workbook: "item.xlsx", sheet: "Item", businessKey: model.id, operation: "update" }],
    createdAt: NOW,
  });
  assert.deepEqual(manifest.patchValidationWaiverRefs, exportWaiver.waivers.map((waiver) => waiver.waiverId));
  assert.deepEqual(manifest.patchValidationWaiverDecisionRefs, [exportWaiver.decision.waiverDecisionId]);
  assert.equal(manifest.environmentId, "online");
  assert.equal(manifest.channelKey, "1001");
});
