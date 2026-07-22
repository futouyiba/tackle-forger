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
import { buildPatchRevision, emptyPatchLedger, orderedPatchReferences, reviewPatchBatch } from "../lib/patch-ledger";
import { publishConfigurationSnapshot, verifySnapshotIntegrity } from "../lib/publishing";
import { createExportManifest } from "../lib/config-export";
import { deterministicHash } from "../lib/rule-kernel";
import { createSeedState } from "../lib/seed";
import type {
  PatchOffsetPolicyVersion,
  PatchReviewSubjectRef,
  PatchRevisionRecord,
} from "../lib/types";

const NOW = "2026-07-23T08:00:00.000Z";

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
  const approved = reviewPatchBatch({
    ledger,
    reviewBatch: batch,
    policy: policy(),
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
  const projection = state.derivedProjections.find((entry) => entry.id === oldSnapshot.projectionId)!;
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
  const operationTrace = governedRevision.operations.map((operation) => ({
    operationId: operation.operationId,
    parameterKey: operation.parameterKey,
    operation: operation.operation,
    before: operation.before,
    operand: operation.operand,
    after: operation.after,
  }));
  const objectInputHash = deterministicHash({
    modelRevision: model.revision,
    finalPanelValues: oldSnapshot.finalPanelValues,
    patchSetHash: frozen.patchSetHash,
  });
  const publishContext = context({
    contextId: `${model.id}/${numericEntry[0]}`,
    parameterKey: numericEntry[0],
    standardUnit: "ratio",
    subjectRef: { scopeType: "model", entityId: model.id, revision: model.revision },
    objectInputHash,
    skuRef: sku.id,
    targetPullKg: sku.targetWeightKg,
    projectionId: projection.id,
    weightBandId: projection.weightTemplateId,
    constraintRuleRef: `range:${numericEntry[0]}`,
    constraintRuleVersion: projection.ruleSetVersion,
    finalValue: numericEntry[1],
    finalValueUnit: "ratio",
    validRange: { min: numericEntry[1] - 1, max: numericEntry[1] + 1, unit: "ratio" },
    patchReferences: frozen.references,
    patchSetHash: frozen.patchSetHash,
    operationTrace,
    traceHash: deterministicHash(operationTrace),
  });
  const rangeEvaluation = evaluatePatchFinalRanges({
    policy: publishedPolicy,
    gate: "PUBLISH",
    contexts: [publishContext],
  });
  const reviewBatch = createPatchReviewBatch({
    evaluation: rangeEvaluation,
    reviewedBy: "publisher",
    reviewedAt: NOW,
  });
  const snapshot = publishConfigurationSnapshot({
    publicationMode: "new_formal",
    model,
    sku,
    series,
    projection,
    finalPanelValues: oldSnapshot.finalPanelValues,
    componentSelections: oldSnapshot.componentSelections,
    patches: [],
    patchRevisions,
    patchOffsetGovernance: {
      policy: publishedPolicy,
      rangeEvaluation,
      reviewBatch,
      objectInputHash,
    },
    attributeAffixIds: oldSnapshot.attributeAffixIds,
    passiveAffixIds: oldSnapshot.passiveAffixIds,
    technologyIds: oldSnapshot.technologyIds,
    passiveAffixPayloads: oldSnapshot.passiveAffixPayloads,
    compatibilityReport: oldSnapshot.compatibilityReport,
    affinityReport: oldSnapshot.affinityReport,
    qualityReport: oldSnapshot.qualityReport,
    qualityValueAssessment: {
      modelRevisionId: `${model.id}@${model.revision}`,
      selectedQualityId: series.qualityId,
      baseAffixScore: 1,
      combinationScore: 0,
      functionScoreFactor: 1,
      performanceScoreFactor: 1,
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
      pricingWeightBandId: "band:1",
      pricingBasketId: "basket:1",
      repairPriceUnrounded: 100,
      purchasePriceUnrounded: 100,
      purchasePrice: 100,
      trace: [],
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

  const exportEvaluation = evaluatePatchFinalRanges({
    policy: publishedPolicy,
    gate: "EXPORT",
    environmentId: "online",
    channelKey: "1001",
    contexts: [{
      ...publishContext,
      finalValue: numericEntry[1] + 2,
    }],
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
    scopeRef: publishContext.subjectRef,
    objectInputHash,
    patchSetHash: frozen.patchSetHash,
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
    environmentId: "online",
    channelKey: "1001",
    patchOffsetGovernance: {
      policy: publishedPolicy,
      rangeEvaluation: exportEvaluation,
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
