import assert from "node:assert/strict";
import test from "node:test";
import {
  ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY,
  APPROVE_VALIDATION_WAIVER_CAPABILITY,
  acknowledgeValidationWarning,
  adaptLegacyValidationIssue,
  approveValidationWaiverDecision,
  assertValidationGateCanProceed,
  createValidationIssue,
  createWaiverPolicyVersion,
  invalidateValidationEvidence,
  verifyValidationAcknowledgement,
  verifyValidationWaiver,
  verifyValidationWaiverDecision,
  ValidationIssueContractError,
} from "../lib/validation-issues";
import type {
  CanonicalValidationIssue,
  ValidationEntityRef,
} from "../lib/types";
import { createSeedState } from "../lib/seed";
import {
  publishConfigurationSnapshot,
  verifySnapshotIntegrity,
} from "../lib/publishing";
import { createExportManifest } from "../lib/config-export";
import { deterministicHash } from "../lib/rule-kernel";

const subject: ValidationEntityRef = {
  workspaceId: "workspace:1",
  entityType: "model",
  entityId: "model:1",
  revisionId: "7",
};

function issue(overrides: Partial<Parameters<typeof createValidationIssue>[0]> = {}) {
  return createValidationIssue({
    code: "RULE_OUT_OF_RANGE",
    source: "patch",
    severity: "ERROR",
    gate: "PUBLISH",
    subjectRef: subject,
    parameterKeys: ["drag"],
    title: "超出合法范围",
    message: "drag 超出范围。",
    ruleRefs: ["ruleset:v7", "range-rule:v2"],
    inputHash: "input:7",
    ...overrides,
  });
}

test("fingerprint 绑定 source/code/subject/规则版本/Gate，EXPORT 额外绑定目标", () => {
  const publish = issue();
  const review = issue({ gate: "REVIEW" });
  const exportA = issue({
    gate: "EXPORT",
    environmentId: "staging",
    channelKey: "steam",
  });
  const exportB = issue({
    gate: "EXPORT",
    environmentId: "production",
    channelKey: "steam",
  });
  assert.notEqual(publish.fingerprint, review.fingerprint);
  assert.notEqual(exportA.fingerprint, exportB.fingerprint);
  assert.equal("blocking" in publish, false);
  assert.throws(
    () => issue({ environmentId: "production", channelKey: "steam" }),
    /不得携带导出目标/,
  );
  assert.throws(
    () => issue({ gate: "EXPORT" }),
    /必须精确绑定/,
  );
});

test("State 不改变 Severity；WARNING 只能确认、BLOCKER 永不可 waive", () => {
  const warning = issue({
    code: "CONFIRM_REQUIRED",
    severity: "WARNING",
    state: "ACKNOWLEDGED",
  });
  assert.equal(warning.severity, "WARNING");
  assert.equal(warning.state, "ACKNOWLEDGED");
  assert.throws(
    () => issue({ severity: "ERROR", state: "ACKNOWLEDGED" }),
    /ACKNOWLEDGED 只适用于 WARNING/,
  );
  assert.throws(
    () => issue({
      severity: "BLOCKER",
      state: "WAIVED",
      waiverRef: "waiver:illegal",
    }),
    /BLOCKER 永远不可 waive/,
  );
});

test("旧 Issue 安全适配保留原 payload 证据且默认只读 STALE", () => {
  const adapted = adaptLegacyValidationIssue(
    {
      level: "warning",
      code: "LEGACY_WARNING",
      message: "旧记录",
      evidence: { raw: 42 },
    },
    {
      subjectRef: subject,
      inputHash: "legacy-input",
      ruleRefs: ["legacy-adapter/v1"],
    },
  );
  assert.equal(adapted.state, "STALE");
  assert.equal(adapted.severity, "WARNING");
  assert.equal(adapted.gate, "NONE");
  assert.equal(adapted.actions.length, 0);
  assert.equal(adapted.evidenceRefs[0].evidenceType, "validation_issue");
  assert.ok(adapted.evidenceRefs[0].contentHash);

  const activeUnified = adaptLegacyValidationIssue(
    {
      issueId: "legacy-unified:1",
      fingerprint: "legacy-fingerprint",
      code: "LEGACY_BLOCKING_ERROR",
      source: "publish",
      severity: "error",
      blocking: true,
      gate: "publish",
      subjectRef: subject,
      affectedRefs: [],
      parameterKeys: ["drag"],
      title: "旧统一错误",
      message: "必须继续阻断发布。",
      state: "open",
      deny: false,
      actions: [],
    },
    {
      subjectRef: subject,
      inputHash: "legacy-unified-input",
      ruleRefs: ["legacy-unified/v1"],
      mode: "active_gate",
    },
  );
  assert.equal(activeUnified.severity, "ERROR");
  assert.equal(activeUnified.gate, "PUBLISH");
  assert.equal(activeUnified.state, "OPEN");
  const acknowledgedUnified = adaptLegacyValidationIssue(
    {
      issueId: "legacy-unified:2",
      fingerprint: "legacy-fingerprint:2",
      code: "LEGACY_REVIEW_WARNING",
      source: "series_invariant",
      severity: "warning",
      blocking: false,
      gate: "model_review",
      subjectRef: subject,
      affectedRefs: [],
      parameterKeys: [],
      title: "旧确认警告",
      message: "确认状态仍需证据复验。",
      state: "acknowledged",
      deny: false,
      actions: [],
    },
    {
      subjectRef: subject,
      inputHash: "legacy-unified-input:2",
      ruleRefs: ["legacy-unified/v1"],
      mode: "active_gate",
    },
  );
  assert.equal(acknowledgedUnified.severity, "WARNING");
  assert.equal(acknowledgedUnified.gate, "REVIEW");
  assert.equal(acknowledgedUnified.state, "ACKNOWLEDGED");
  assert.throws(
    () => assertValidationGateCanProceed({
      issues: [activeUnified],
      gate: "PUBLISH",
      at: "2026-07-23T03:00:00.000Z",
    }),
    /当前有效 WaiverPolicyVersion/,
  );
});

test("WARNING 确认重验权限/revision/inputHash，并以原幂等 payload 安全重试", () => {
  const open = issue({
    code: "CONFIRM_REQUIRED",
    severity: "WARNING",
  });
  const command = {
    issue: open,
    expectedIssueRevision: open.issueRevision,
    expectedInputHash: open.inputHash,
    reason: "已核对影响并接受。",
    acknowledgedBy: "designer:1",
    acknowledgedAt: "2026-07-23T03:00:00.000Z",
    idempotencyKey: "ack:1",
    capabilities: [ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY],
  };
  assert.throws(
    () => acknowledgeValidationWarning({ ...command, capabilities: [] }),
    /缺少 validation.warning.acknowledge/,
  );
  const first = acknowledgeValidationWarning(command);
  assert.equal(first.issue.state, "ACKNOWLEDGED");
  assert.equal(first.issue.severity, "WARNING");
  assert.equal(first.acknowledgement.state, "FRESH");
  const retry = acknowledgeValidationWarning({
    ...command,
    issue: first.issue,
    existingAcknowledgements: [first.acknowledgement],
  });
  assert.equal(retry.issue.issueRevision, first.issue.issueRevision);
  assert.deepEqual(retry.acknowledgement, first.acknowledgement);
  assert.throws(
    () => acknowledgeValidationWarning({
      ...command,
      reason: "篡改理由",
      existingAcknowledgements: [first.acknowledgement],
    }),
    /相同幂等键/,
  );
  assert.throws(
    () => acknowledgeValidationWarning({
      ...command,
      expectedInputHash: "stale",
    }),
    /expected revision\/inputHash 不匹配/,
  );
});

test("ERROR 默认不可 waive，只有完整且精确命中的已发布策略可以原子批准", () => {
  const publishIssue = issue();
  const exportIssue = issue({
    gate: "EXPORT",
    environmentId: "production",
    channelKey: "steam",
  });
  const policy = createWaiverPolicyVersion({
    policyId: "validation-waiver-policy",
    version: "validation-waiver/v1",
    status: "PUBLISHED",
    publishedAt: "2026-07-23T02:00:00.000Z",
    rules: [{
      source: "patch",
      code: "RULE_OUT_OF_RANGE",
      gates: ["PUBLISH", "EXPORT"],
      scopeEntityTypes: ["model"],
      scopeRefs: [subject],
      validFrom: "2026-07-23T00:00:00.000Z",
      validUntil: "2026-07-24T00:00:00.000Z",
    }],
  });
  const command = {
    issues: [publishIssue, exportIssue],
    requestedWaivers: [{
      issueFingerprint: publishIssue.fingerprint,
      expectedIssueRevision: publishIssue.issueRevision,
      expectedInputHash: publishIssue.inputHash,
      gate: "PUBLISH" as const,
    }, {
      issueFingerprint: exportIssue.fingerprint,
      expectedIssueRevision: exportIssue.issueRevision,
      expectedInputHash: exportIssue.inputHash,
      gate: "EXPORT" as const,
      environmentId: "production",
      channelKey: "steam",
    }],
    policy,
    scopeRef: subject,
    reason: "已审阅越界影响，按当前版本保留意见通过。",
    approvedBy: "lead:1",
    approvedAt: "2026-07-23T03:00:00.000Z",
    idempotencyKey: "waiver:1",
    capabilities: [APPROVE_VALIDATION_WAIVER_CAPABILITY],
  };
  const approved = approveValidationWaiverDecision(command);
  assert.equal(approved.waivers.length, 2);
  assert.equal(approved.issues.every((entry) => entry.state === "WAIVED"), true);
  assert.notEqual(approved.waivers[0].waiverId, approved.waivers[1].waiverId);
  assert.deepEqual(new Set(approved.waivers.map((entry) => entry.gate)), new Set(["EXPORT", "PUBLISH"]));
  const retry = approveValidationWaiverDecision({
    ...command,
    issues: approved.issues,
    existingDecisions: [approved.decision],
    existingWaivers: approved.waivers,
  });
  assert.deepEqual(retry.decision, approved.decision);
  assert.deepEqual(
    retry.issues.map((entry) => entry.issueRevision),
    approved.issues.map((entry) => entry.issueRevision),
  );
  assert.equal(verifyValidationWaiverDecision(approved.decision), true);
  assert.equal(
    verifyValidationWaiverDecision({
      ...approved.decision,
      waiverIds: approved.decision.waiverIds.slice(1),
    }),
    false,
  );
  assert.throws(
    () => approveValidationWaiverDecision({
      ...command,
      issues: approved.issues,
      existingDecisions: [{
        ...approved.decision,
        waiverIds: approved.decision.waiverIds.slice(1),
      }],
      existingWaivers: approved.waivers,
    }),
    /WaiverDecision 完整性校验失败/,
  );

  assert.doesNotThrow(() => assertValidationGateCanProceed({
    issues: approved.issues,
    gate: "PUBLISH",
    waivers: approved.waivers,
    activeWaiverPolicies: [policy],
    at: "2026-07-23T03:30:00.000Z",
  }));
  assert.throws(
    () => assertValidationGateCanProceed({
      issues: approved.issues,
      gate: "PUBLISH",
      waivers: approved.waivers,
      at: "2026-07-23T03:30:00.000Z",
    }),
    /当前有效 WaiverPolicyVersion/,
  );
  const changedPolicy = createWaiverPolicyVersion({
    policyId: policy.policyId,
    version: policy.version,
    status: "PUBLISHED",
    publishedAt: policy.publishedAt,
    rules: [{
      source: "quality",
      code: "CHANGED_RULE",
      gates: ["PUBLISH"],
    }],
  });
  assert.throws(
    () => assertValidationGateCanProceed({
      issues: approved.issues,
      gate: "PUBLISH",
      waivers: approved.waivers,
      activeWaiverPolicies: [changedPolicy],
      at: "2026-07-23T03:30:00.000Z",
    }),
    /当前有效 WaiverPolicyVersion/,
  );
  const retiredPolicy = createWaiverPolicyVersion({
    policyId: policy.policyId,
    version: policy.version,
    status: "RETIRED",
    publishedAt: policy.publishedAt,
    rules: policy.rules,
  });
  assert.throws(
    () => assertValidationGateCanProceed({
      issues: approved.issues,
      gate: "PUBLISH",
      waivers: approved.waivers,
      activeWaiverPolicies: [retiredPolicy],
      at: "2026-07-23T03:30:00.000Z",
    }),
    /当前有效 WaiverPolicyVersion/,
  );
  const invalidatedByPolicy = invalidateValidationEvidence({
    issues: approved.issues,
    waivers: approved.waivers,
    activeFingerprints: approved.issues.map((entry) => entry.fingerprint),
    activeWaiverPolicies: [retiredPolicy],
    at: "2026-07-23T03:30:00.000Z",
  });
  assert.equal(invalidatedByPolicy.waivers.every((entry) => entry.state === "STALE"), true);
  assert.equal(invalidatedByPolicy.waivers.every(verifyValidationWaiver), true);
  assert.deepEqual(
    invalidatedByPolicy.waivers.map((entry) => entry.recordHash),
    approved.waivers.map((entry) => entry.recordHash),
  );
  assert.equal(
    invalidatedByPolicy.waivers.every(
      (entry, index) => entry.stateHash !== approved.waivers[index].stateHash,
    ),
    true,
  );
  assert.equal(
    verifyValidationWaiver({
      ...invalidatedByPolicy.waivers[0],
      stateHash: "tampered",
    }),
    false,
  );
  const invalidatedByPolicyRetry = invalidateValidationEvidence({
    issues: invalidatedByPolicy.issues,
    waivers: invalidatedByPolicy.waivers,
    activeFingerprints: invalidatedByPolicy.issues.map((entry) => entry.fingerprint),
    activeWaiverPolicies: [retiredPolicy],
    at: "2026-07-23T03:30:00.000Z",
  });
  assert.deepEqual(invalidatedByPolicyRetry.waivers, invalidatedByPolicy.waivers);
  const legacyWaiverContent = structuredClone(approved.waivers[0]);
  Reflect.deleteProperty(legacyWaiverContent, "recordHashVersion");
  Reflect.deleteProperty(legacyWaiverContent, "stateHashVersion");
  Reflect.deleteProperty(legacyWaiverContent, "stateHash");
  Reflect.deleteProperty(legacyWaiverContent, "recordHash");
  const legacyWaiver = {
    ...legacyWaiverContent,
    recordHash: deterministicHash(legacyWaiverContent),
  };
  assert.equal(verifyValidationWaiver(legacyWaiver), true);
  const migratedLegacyWaiver = invalidateValidationEvidence({
    issues: [approved.issues[0]],
    waivers: [legacyWaiver],
    activeFingerprints: [],
  }).waivers[0];
  assert.equal(migratedLegacyWaiver.state, "STALE");
  assert.equal(migratedLegacyWaiver.recordHash, legacyWaiver.recordHash);
  assert.equal(verifyValidationWaiver(migratedLegacyWaiver), true);

  const defaultDenyPolicy = createWaiverPolicyVersion({
    policyId: "validation-waiver-policy",
    version: "validation-waiver/v2",
    status: "PUBLISHED",
    publishedAt: "2026-07-23T02:00:00.000Z",
    rules: [{
      source: "quality",
      code: "OTHER_ERROR",
      gates: ["PUBLISH"],
    }],
  });
  assert.throws(
    () => approveValidationWaiverDecision({
      ...command,
      issues: [publishIssue],
      requestedWaivers: [command.requestedWaivers[0]],
      policy: defaultDenyPolicy,
      idempotencyKey: "waiver:default-deny",
    }),
    /未显式允许/,
  );
  assert.throws(
    () => approveValidationWaiverDecision({
      ...command,
      requestedWaivers: [{
        ...command.requestedWaivers[1],
        channelKey: "epic",
      }],
      idempotencyKey: "waiver:wrong-target",
    }),
    /版本\/目标已变化/,
  );
});

test("输入变化后旧 Issue、确认与 Waiver 一起 STALE，旧证据不被改写删除", () => {
  const warning = issue({ code: "CONFIRM_REQUIRED", severity: "WARNING" });
  const acknowledged = acknowledgeValidationWarning({
    issue: warning,
    expectedIssueRevision: warning.issueRevision,
    expectedInputHash: warning.inputHash,
    reason: "已确认",
    acknowledgedBy: "designer:1",
    acknowledgedAt: "2026-07-23T03:00:00.000Z",
    idempotencyKey: "ack:stale",
    capabilities: [ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY],
  });
  const invalidated = invalidateValidationEvidence({
    issues: [acknowledged.issue],
    acknowledgements: [acknowledged.acknowledgement],
    activeFingerprints: ["new-fingerprint"],
  });
  assert.equal(invalidated.issues[0].state, "STALE");
  assert.equal(invalidated.acknowledgements[0].state, "STALE");
  assert.equal(invalidated.acknowledgements[0].reason, "已确认");
  assert.equal(invalidated.acknowledgements.length, 1);
  assert.equal(verifyValidationAcknowledgement(invalidated.acknowledgements[0]), true);
  assert.equal(
    invalidated.acknowledgements[0].recordHash,
    acknowledged.acknowledgement.recordHash,
  );
  assert.notEqual(
    invalidated.acknowledgements[0].stateHash,
    acknowledged.acknowledgement.stateHash,
  );
  assert.equal(
    verifyValidationAcknowledgement({
      ...invalidated.acknowledgements[0],
      stateHash: "tampered",
    }),
    false,
  );
  const invalidatedRetry = invalidateValidationEvidence({
    issues: invalidated.issues,
    acknowledgements: invalidated.acknowledgements,
    activeFingerprints: ["new-fingerprint"],
  });
  assert.deepEqual(invalidatedRetry.acknowledgements, invalidated.acknowledgements);
  const legacyAcknowledgementContent = structuredClone(acknowledged.acknowledgement);
  Reflect.deleteProperty(legacyAcknowledgementContent, "acknowledgementId");
  Reflect.deleteProperty(legacyAcknowledgementContent, "recordHashVersion");
  Reflect.deleteProperty(legacyAcknowledgementContent, "stateHashVersion");
  Reflect.deleteProperty(legacyAcknowledgementContent, "stateHash");
  Reflect.deleteProperty(legacyAcknowledgementContent, "recordHash");
  const legacyAcknowledgementRecordHash = deterministicHash(legacyAcknowledgementContent);
  const legacyAcknowledgement = {
    ...legacyAcknowledgementContent,
    acknowledgementId: `validation-ack:${legacyAcknowledgementRecordHash}`,
    recordHash: legacyAcknowledgementRecordHash,
  };
  assert.equal(verifyValidationAcknowledgement(legacyAcknowledgement), true);
  const migratedLegacyAcknowledgement = invalidateValidationEvidence({
    issues: [acknowledged.issue],
    acknowledgements: [legacyAcknowledgement],
    activeFingerprints: [],
  }).acknowledgements[0];
  assert.equal(migratedLegacyAcknowledgement.state, "STALE");
  assert.equal(
    migratedLegacyAcknowledgement.recordHash,
    legacyAcknowledgement.recordHash,
  );
  assert.equal(verifyValidationAcknowledgement(migratedLegacyAcknowledgement), true);
});

test("Gate 只接受匹配 fingerprint 的冻结确认/Waiver 证据", () => {
  const warning = issue({ code: "CONFIRM_REQUIRED", severity: "WARNING" });
  const acknowledged = acknowledgeValidationWarning({
    issue: warning,
    expectedIssueRevision: warning.issueRevision,
    expectedInputHash: warning.inputHash,
    reason: "已确认",
    acknowledgedBy: "designer:1",
    acknowledgedAt: "2026-07-23T03:00:00.000Z",
    idempotencyKey: "ack:gate",
    capabilities: [ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY],
  });
  assert.doesNotThrow(() => assertValidationGateCanProceed({
    issues: [acknowledged.issue],
    gate: "PUBLISH",
    acknowledgements: [acknowledged.acknowledgement],
  }));
  assert.throws(
    () => assertValidationGateCanProceed({
      issues: [acknowledged.issue],
      gate: "PUBLISH",
      acknowledgements: [{
        ...acknowledged.acknowledgement,
        issueFingerprint: "tampered",
      }],
    }),
    (error: unknown) =>
      error instanceof ValidationIssueContractError
      && error.code === "VALIDATION_WARNING_NOT_ACKNOWLEDGED",
  );
});

test("未处理的 REVIEW Issue 继续约束 PUBLISH，状态写动作缺少 #48 payload 时 fail-closed", () => {
  const reviewWarning = issue({
    code: "REVIEW_CONFIRM_REQUIRED",
    severity: "WARNING",
    gate: "REVIEW",
  });
  assert.throws(
    () => assertValidationGateCanProceed({
      issues: [reviewWarning],
      gate: "PUBLISH",
    }),
    /尚无有效 WARNING 确认证据/,
  );
  assert.throws(
    () => createValidationIssue({
      code: "ACTION_PAYLOAD_REQUIRED",
      source: "publish",
      severity: "WARNING",
      gate: "PUBLISH",
      subjectRef: subject,
      title: "需要确认",
      message: "必须使用不可变 payload。",
      ruleRefs: ["publish:v1"],
      inputHash: "action-input",
      actions: [{
        actionId: "action:1",
        action: "acknowledge_validation_warning",
        label: "确认",
        enabled: true,
        requiredCapabilities: [ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY],
      }],
    }),
    /必须绑定 #48 统一的不可变 commandPayloadRef/,
  );
});

test("新正式 Snapshot 只接受并冻结指纹绑定的确认记录，旧 code 理由字典不能替代证据", () => {
  const state = createSeedState();
  const existing = state.configurationSnapshots[0];
  const model = state.purchasableModels.find((entry) => entry.id === existing.modelId)!;
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const projection = state.derivedProjections.find((entry) => entry.id === existing.projectionId)!;
  const warning = issue({
    code: "PUBLISH_CONFIRM_REQUIRED",
    source: "publish",
    severity: "WARNING",
    subjectRef: {
      workspaceId: "workspace:1",
      entityType: "model",
      entityId: model.id,
      revisionId: String(model.revision),
    },
    ruleRefs: [projection.ruleSetVersion],
    inputHash: "publish-warning-input",
  });
  const acknowledged = acknowledgeValidationWarning({
    issue: warning,
    expectedIssueRevision: warning.issueRevision,
    expectedInputHash: warning.inputHash,
    reason: "已确认发布影响。",
    acknowledgedBy: "designer:1",
    acknowledgedAt: "2026-07-23T03:00:00.000Z",
    idempotencyKey: "ack:snapshot",
    capabilities: [ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY],
  });
  const common = {
    publicationMode: "new_formal" as const,
    model,
    sku,
    series,
    seriesSkus: state.skuDrawers,
    projection,
    finalPanelValues: existing.finalPanelValues,
    componentSelections: existing.componentSelections,
    patches: [],
    attributeAffixIds: existing.attributeAffixIds,
    passiveAffixIds: existing.passiveAffixIds,
    technologyIds: existing.technologyIds,
    passiveAffixPayloads: existing.passiveAffixPayloads,
    compatibilityReport: existing.compatibilityReport,
    affinityReport: existing.affinityReport,
    qualityReport: existing.qualityReport,
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
      qualityRangePolicyVersion: "quality:v1",
      scoringPolicyVersion: "quality-score:v1",
      inSelectedQualityRange: true,
      formal: true,
      issues: [],
      trace: [],
      inputHash: "quality-input",
    },
    pricingPolicyVersion: "pricing:v1",
    automaticPricing: {
      formal: true,
      pricingPolicyRef: "pricing:v1",
      pricingWeightBandId: "band:1",
      pricingBasketId: "basket:1",
      repairPriceUnrounded: 100,
      purchasePriceUnrounded: 100,
      purchasePrice: 100,
      trace: [],
      issues: [],
      warnings: [],
      inputHash: "pricing-input",
    },
    validationReport: [acknowledged.issue],
    warningConfirmations: {
      PUBLISH_CONFIRM_REQUIRED: "旧 code 理由不构成新证据",
    },
    publishedBy: "publisher:1",
    publishedAt: "2026-07-23T04:00:00.000Z",
    snapshotId: "snapshot:validation-evidence",
  };
  assert.throws(
    () => publishConfigurationSnapshot(common),
    /尚无有效 WARNING 确认证据/,
  );
  const snapshot = publishConfigurationSnapshot({
    ...common,
    validationAcknowledgements: [acknowledged.acknowledgement],
  });
  assert.equal(snapshot.validationReport[0].state, "ACKNOWLEDGED");
  assert.equal(snapshot.validationAcknowledgements?.[0].acknowledgementId, acknowledged.acknowledgement.acknowledgementId);
  assert.deepEqual(snapshot.validationWaivers, []);
  assert.deepEqual(snapshot.validationWaiverDecisions, []);
  assert.equal(
    snapshot.validationReport.some((entry) => entry.code === "WARNING_CONFIRMED_PUBLISH_CONFIRM_REQUIRED"),
    false,
  );
  assert.equal(verifySnapshotIntegrity(snapshot), true);
});

test("ExportManifest 只冻结精确环境×渠道命中的统一 Issue 与证据引用", () => {
  const snapshot = createSeedState().configurationSnapshots[0];
  const exportWarning = issue({
    code: "EXPORT_CONFIRM_REQUIRED",
    source: "config_relationship",
    severity: "WARNING",
    gate: "EXPORT",
    environmentId: "production",
    channelKey: "steam",
  });
  const acknowledged = acknowledgeValidationWarning({
    issue: exportWarning,
    expectedIssueRevision: exportWarning.issueRevision,
    expectedInputHash: exportWarning.inputHash,
    reason: "已确认 production/steam 导出影响。",
    acknowledgedBy: "publisher:1",
    acknowledgedAt: "2026-07-23T03:00:00.000Z",
    idempotencyKey: "ack:export",
    capabilities: [ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY],
  });
  const common = {
    packageId: "package:validation-evidence",
    generatorVersion: "1",
    mapping: {
      mappingId: "mapping:validation-evidence",
      version: "1",
      logicalTables: {},
      rows: [],
      enumReferenceField: "id" as const,
    },
    profile: {
      profileId: "profile:production:steam",
      label: "production/steam",
      executorKind: "local_companion" as const,
      projectRoot: "/configs",
      relativeWorkbookRoot: "xlsx",
      configTomlPath: "config.toml",
      enabled: true,
    },
    snapshot,
    originalFileHashes: {},
    entries: [{
      logicalTable: "item",
      workbook: "item.xlsx",
      sheet: "Item",
      businessKey: snapshot.modelId,
      operation: "update" as const,
    }],
    environmentId: "production",
    channelKey: "steam",
    createdAt: "2026-07-23T04:00:00.000Z",
  };
  const snapshotWithFrozenIssue = structuredClone(snapshot);
  snapshotWithFrozenIssue.validationReport = [exportWarning];
  const snapshotContent = structuredClone(snapshotWithFrozenIssue);
  Reflect.deleteProperty(snapshotContent, "contentHash");
  snapshotWithFrozenIssue.contentHash = deterministicHash(snapshotContent);
  assert.throws(
    () => createExportManifest({
      ...common,
      snapshot: snapshotWithFrozenIssue,
    }),
    /缺少对应确认证据/,
  );
  assert.throws(
    () => createExportManifest({
      ...common,
      snapshot: snapshotWithFrozenIssue,
      validationGovernance: {
        issues: [exportWarning],
      },
    }),
    /尚无有效 WARNING 确认证据/,
  );
  assert.throws(
    () => createExportManifest({
      ...common,
      snapshot: snapshotWithFrozenIssue,
      validationGovernance: {
        issues: [{
          ...acknowledged.issue,
          severity: "INFO",
          state: "RESOLVED",
        }],
        acknowledgements: [acknowledged.acknowledgement],
      },
    }),
    /规范内容与 Snapshot 冻结版本不一致/,
  );
  assert.throws(
    () => createExportManifest({
      ...common,
      snapshot: snapshotWithFrozenIssue,
      validationGovernance: {
        issues: [{
          ...acknowledged.issue,
          state: "RESOLVED",
        }],
        acknowledgements: [acknowledged.acknowledgement],
      },
    }),
    /未从 Snapshot 冻结 revision 产生可验证的确认或 Waiver/,
  );
  const manifest = createExportManifest({
    ...common,
    snapshot: snapshotWithFrozenIssue,
    validationGovernance: {
      issues: [acknowledged.issue],
      acknowledgements: [acknowledged.acknowledgement],
    },
  });
  assert.deepEqual(manifest.validationIssueFingerprints, [exportWarning.fingerprint]);
  assert.deepEqual(
    manifest.validationAcknowledgementRefs,
    [acknowledged.acknowledgement.acknowledgementId],
  );
  assert.deepEqual(manifest.validationWaiverRefs, []);
  assert.deepEqual(manifest.validationWaiverDecisionRefs, []);
});

test("批量 Waiver 任一目标 stale 时整组失败，不产生半组结果", () => {
  const first = issue();
  const second = issue({ code: "SECOND_ERROR", inputHash: "input:8" });
  const policy = createWaiverPolicyVersion({
    policyId: "validation-waiver-policy",
    version: "validation-waiver/atomic-v1",
    status: "PUBLISHED",
    rules: [
      { source: "patch", code: first.code, gates: ["PUBLISH"] },
      { source: "patch", code: second.code, gates: ["PUBLISH"] },
    ],
  });
  const issuesBefore: CanonicalValidationIssue[] = [first, second];
  assert.throws(
    () => approveValidationWaiverDecision({
      issues: issuesBefore,
      requestedWaivers: [{
        issueFingerprint: first.fingerprint,
        expectedIssueRevision: first.issueRevision,
        expectedInputHash: first.inputHash,
        gate: "PUBLISH",
      }, {
        issueFingerprint: second.fingerprint,
        expectedIssueRevision: "stale-revision",
        expectedInputHash: second.inputHash,
        gate: "PUBLISH",
      }],
      policy,
      scopeRef: subject,
      reason: "批量审批",
      approvedBy: "lead:1",
      approvedAt: "2026-07-23T03:00:00.000Z",
      idempotencyKey: "waiver:atomic",
      capabilities: [APPROVE_VALIDATION_WAIVER_CAPABILITY],
    }),
    /版本\/目标已变化/,
  );
  assert.equal(issuesBefore.every((entry) => entry.state === "OPEN"), true);
});
