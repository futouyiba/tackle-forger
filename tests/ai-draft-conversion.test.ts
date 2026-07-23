import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceAssessmentRequestProjection,
} from "../lib/ai-assessment-request";
import {
  applyAIDraftArtifactPlan,
  AIDraftConversionError,
  confirmAIRuleSourceChangeDraft,
  planAIDraftConversion,
  type AIDraftConversionCommand,
} from "../lib/ai-draft-conversion";
import { AI_RETENTION_POLICY_VERSION, type AIAssessmentRetentionRecord } from "../lib/ai-retention";
import { describeFancyHubModels, prepareAIRequest } from "../lib/ai-outbound";
import { createSeedState } from "../lib/seed";
import { currentPatchPanelValuesFromWorkspace } from "../lib/patch-authority";
import { buildPatchRevision } from "../lib/patch-ledger";
import type { WorkspaceState } from "../lib/types";

const assessmentId = "assessment:model-draft";
const actorStableId = "user:planner-test";
const now = "2026-07-23T00:00:00.000Z";
const providerModel = describeFancyHubModels([{
  modelId: "model.alpha",
  modelVersion: "2026-07-23",
  deploymentRevision: "deploy.7",
  modelArtifactDigest: "sha256:abc",
}]).models[0]!;

function fixture(): {
  state: WorkspaceState;
  record: AIAssessmentRetentionRecord;
  command: AIDraftConversionCommand;
  parameterKey: string;
} {
  const state = createSeedState();
  state.workspaceId = "workspace:ai-draft-test";
  const model = state.purchasableModels.find((entry) =>
    entry.status !== "published" && !entry.configurationSnapshotId && entry.patchIds.length === 0)!;
  for (const definition of state.parameters) {
    if (definition.allowedOperations?.some((operation) =>
      operation === "set" || operation === "add" || operation === "multiply")) {
      definition.targetRange = { min: -1_000_000_000, max: 1_000_000_000 };
    }
  }
  const projection = buildWorkspaceAssessmentRequestProjection({
    state,
    scope: { scopeType: "model", scopeId: model.id },
    assessmentId,
    model: providerModel,
  });
  const prepared = prepareAIRequest({ envelope: projection.envelope });
  const parameter = projection.parameterKeyMapping.find((mapping) => {
    const definition = state.parameters.find((entry) => entry.key === mapping.parameterKey);
    return definition?.allowedOperations?.includes("add");
  })!;
  const panelValue = projection.envelope.panelValues.find((entry) =>
    entry.parameterKey === parameter.alias)!.value;
  assert.equal(panelValue.kind, "number");
  const scopeAlias = projection.requestAliasMapping.find((entry) =>
    entry.reference.referenceKindCode === "model"
    && entry.reference.stableLocalId === model.id)!.alias;
  const evidence = projection.envelope.evidenceRefs[0]!;
  const evidenceReference = projection.requestAliasMapping.find((entry) =>
    entry.alias === evidence.evidenceAlias)!.reference;
  const recommendation = {
    recommendationCode: "recommendation.model.patch",
    title: "保持数值不变的草稿验证",
    summary: "用 add 0 验证确定性转换边界。",
    subjectAliases: [scopeAlias],
    evidenceAliases: [evidence.evidenceAlias],
    suggestedAction: "create_model_patch_draft" as const,
    suggestedChanges: [{
      changeId: "change.add-zero",
      parameterKey: parameter.alias,
      operation: "add" as const,
      operand: { kind: "number" as const, value: 0 },
      expectedBefore: structuredClone(panelValue),
    }],
  };
  const record: AIAssessmentRetentionRecord = {
    policyVersion: AI_RETENTION_POLICY_VERSION,
    metadata: {
      assessmentId,
      actorStableId,
      scopeStableRef: model.id,
      metadataSchemaVersion: "ai-operation-metadata/v2",
      scope: {
        scopeType: "model",
        scopeId: model.id,
        inputRevision: String(model.revision),
      },
      ruleSetVersion: projection.operationMetadataContext.ruleSetVersion,
      fiveAxisRuleVersion: projection.operationMetadataContext.fiveAxisRuleVersion,
      attempts: [],
      retryCount: 0,
      cancellationStatus: "NOT_REQUESTED",
      modelDescriptor: providerModel,
      promptTemplateVersion: projection.envelope.promptTemplateVersion,
      promptTemplateHash: projection.envelope.promptTemplateHash,
      schemaVersion: projection.envelope.schemaVersion,
      allowlistPolicyVersion: projection.envelope.policyVersion,
      inputHash: prepared.inputHash,
      requestedAt: now,
      completedAt: now,
      resultCode: "SUCCESS",
      state: "ACTIVE",
    },
    semanticContent: {
      findings: [],
      recommendations: [recommendation],
      assumptions: [],
      uncoveredInformation: [],
      evidenceRefs: [structuredClone(evidence)],
      resolvedEvidenceRefs: [{
        evidenceType: evidence.evidenceType,
        evidenceAlias: evidence.evidenceAlias,
        refId: evidenceReference.stableLocalId,
        ...(evidenceReference.stableRevisionId
          ? { revisionId: evidenceReference.stableRevisionId }
          : {}),
        contentHash: evidence.contentHash,
      }],
    },
    visibility: "VISIBLE",
  };
  return {
    state,
    record,
    parameterKey: parameter.parameterKey,
    command: {
      mode: "preview",
      recommendationId: recommendation.recommendationCode,
      assessmentInputHash: prepared.inputHash,
      selectedChangeIds: [recommendation.suggestedChanges[0]!.changeId],
      userReason: "",
      idempotencyKey: "idempotency.preview.1",
      targetModelRef: { entityId: model.id, revisionId: String(model.revision) },
    },
  };
}

function plan(value = fixture()) {
  return planAIDraftConversion({
    state: value.state,
    record: value.record,
    assessmentId,
    actorStableId,
    actorDisplayName: "Planner Test",
    capabilities: ["ai.patch_draft.create"],
    command: value.command,
    now,
  });
}

function assertCode(code: AIDraftConversionError["code"], operation: () => unknown): void {
  assert.throws(operation, (error: unknown) =>
    error instanceof AIDraftConversionError && error.code === code);
}

test("Model preview 只生成确定性 DRAFT 计划，不修改 workspace", () => {
  const value = fixture();
  const revisionCount = value.state.patchLedger.revisions.length;
  const result = plan(value);

  assert.equal(result.kind, "model_patch");
  assert.equal(result.preview.mode, "preview");
  assert.equal(result.preview.kind, "model_patch");
  assert.equal(result.preview.canCreate, true);
  assert.equal(result.preview.changes.length, 1);
  assert.equal(result.preview.changes[0]?.parameterKey, value.parameterKey);
  assert.equal(result.preview.changes[0]?.before, result.preview.changes[0]?.after);
  assert.equal(result.patch.state, "DRAFT");
  assert.equal(result.patch.operations[0]?.operation, "add");
  assert.match(result.commandHash, /^[a-f0-9]{8}$/);
  assert.match(result.preview.previewHash, /^[a-f0-9]{8}$/);
  assert.equal(value.state.patchLedger.revisions.length, revisionCount);
});

test("stale state 或 assessmentInputHash 不一致时 fail-closed", () => {
  const wrongHash = fixture();
  wrongHash.command.assessmentInputHash = "f".repeat(64);
  assertCode("AI_ASSESSMENT_NOT_ACTIONABLE", () => plan(wrongHash));

  const stale = fixture();
  const model = stale.state.purchasableModels.find((entry) =>
    entry.id === stale.command.targetModelRef!.entityId)!;
  model.price += 1;
  assertCode("AI_ASSESSMENT_NOT_ACTIONABLE", () => plan(stale));
});

test("留存 EvidenceRef 的稳定引用被篡改时 fail-closed", () => {
  const changedRef = fixture();
  changedRef.record.semanticContent!.resolvedEvidenceRefs![0]!.refId = "trace:other";
  assertCode("AI_DRAFT_EVIDENCE_INVALID", () => plan(changedRef));

  const changedHash = fixture();
  changedHash.record.semanticContent!.resolvedEvidenceRefs![0]!.contentHash = "f".repeat(64);
  assertCode("AI_DRAFT_EVIDENCE_INVALID", () => plan(changedHash));
});

test("目标 revision 与冻结状态均在计划阶段阻断", () => {
  const changedRevision = fixture();
  changedRevision.command.targetModelRef!.revisionId = "999";
  assertCode("AI_DRAFT_TARGET_REVISION_CHANGED", () => plan(changedRevision));

  const frozen = fixture();
  const model = frozen.state.purchasableModels.find((entry) =>
    entry.id === frozen.command.targetModelRef!.entityId)!;
  model.configurationSnapshotId = "snapshot:frozen";
  assertCode("AI_DRAFT_TARGET_FROZEN", () => plan(frozen));
});

test("已发布 Model 的规则源草稿以冻结快照面板为基线，缺快照字段则 fail-closed", () => {
  const state = createSeedState();
  state.workspaceId = "workspace:ai-draft-test";
  const model = state.purchasableModels.find((entry) => entry.configurationSnapshotId)!;
  const snapshot = state.configurationSnapshots.find((entry) => entry.id === model.configurationSnapshotId)!;
  const projection = buildWorkspaceAssessmentRequestProjection({
    state, scope: { scopeType: "model", scopeId: model.id }, assessmentId, model: providerModel,
  });
  const parameter = projection.parameterKeyMapping.find((entry) =>
    state.parameters.find((definition) => definition.key === entry.parameterKey)?.allowedOperations?.includes("add"))!;
  for (const definition of state.parameters) {
    if (definition.allowedOperations?.some((operation) =>
      operation === "set" || operation === "add" || operation === "multiply")) {
      definition.targetRange = { min: -1_000_000_000, max: 1_000_000_000 };
    }
  }
  const snapshotValue = snapshot.finalPanelValues[parameter.parameterKey]!;
  const scopeAlias = projection.requestAliasMapping.find((entry) =>
    entry.reference.referenceKindCode === "model" && entry.reference.stableLocalId === model.id)!.alias;
  const evidence = projection.envelope.evidenceRefs[0]!;
  const evidenceReference = projection.requestAliasMapping.find((entry) => entry.alias === evidence.evidenceAlias)!.reference;
  const recommendation = {
    recommendationCode: "recommendation.published.rule", title: "冻结快照规则建议", summary: "", subjectAliases: [scopeAlias], evidenceAliases: [evidence.evidenceAlias],
    suggestedAction: "create_rule_source_change_draft" as const,
    suggestedChanges: [{ changeId: "change.snapshot.before", parameterKey: parameter.alias, operation: "add" as const, operand: { kind: "number" as const, value: 0 }, expectedBefore: { kind: "number" as const, value: snapshotValue as number } }],
  };
  const prepared = prepareAIRequest({ envelope: projection.envelope });
  const record: AIAssessmentRetentionRecord = {
    policyVersion: AI_RETENTION_POLICY_VERSION,
    metadata: { assessmentId, actorStableId, scopeStableRef: model.id, metadataSchemaVersion: "ai-operation-metadata/v2", scope: { scopeType: "model", scopeId: model.id, inputRevision: String(model.revision) }, ruleSetVersion: projection.operationMetadataContext.ruleSetVersion, fiveAxisRuleVersion: projection.operationMetadataContext.fiveAxisRuleVersion, attempts: [], retryCount: 0, cancellationStatus: "NOT_REQUESTED", modelDescriptor: providerModel, promptTemplateVersion: projection.envelope.promptTemplateVersion, promptTemplateHash: projection.envelope.promptTemplateHash, schemaVersion: projection.envelope.schemaVersion, allowlistPolicyVersion: projection.envelope.policyVersion, inputHash: prepared.inputHash, requestedAt: now, completedAt: now, resultCode: "SUCCESS", state: "ACTIVE" },
    semanticContent: { findings: [], recommendations: [recommendation], assumptions: [], uncoveredInformation: [], evidenceRefs: [structuredClone(evidence)], resolvedEvidenceRefs: [{ evidenceType: evidence.evidenceType, evidenceAlias: evidence.evidenceAlias, refId: evidenceReference.stableLocalId, ...(evidenceReference.stableRevisionId ? { revisionId: evidenceReference.stableRevisionId } : {}), contentHash: evidence.contentHash }] }, visibility: "VISIBLE",
  };
  const command: AIDraftConversionCommand = { mode: "preview", recommendationId: recommendation.recommendationCode, assessmentInputHash: prepared.inputHash, selectedChangeIds: ["change.snapshot.before"], userReason: "", idempotencyKey: "published-snapshot-before", targetModelRef: { entityId: model.id, revisionId: String(model.revision) }, targetRuleRef: { spreadsheetToken: "invalid", sheetId: "invalid", stableRuleId: "invalid", parameterKey: parameter.parameterKey, sourceRevision: "invalid" } };
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const currentProjection = state.derivedProjections.find((entry) => entry.id === sku.projectionMatch.projectionId)!;
  currentProjection.values[parameter.parameterKey] = (snapshotValue as number) + 999;
  // Current derived values are irrelevant for a published model; an invalid
  // rule target is reached only after expectedBefore matched the snapshot.
  assertCode("AI_RULE_SOURCE_REVISION_CHANGED", () => planAIDraftConversion({ state, record, assessmentId, actorStableId, actorDisplayName: "Planner Test", capabilities: ["ai.rule_source_change_draft.create"], command, now }));
  delete snapshot.finalPanelValues[parameter.parameterKey];
  assertCode("AI_ASSESSMENT_NOT_ACTIONABLE", () => planAIDraftConversion({ state, record, assessmentId, actorStableId, actorDisplayName: "Planner Test", capabilities: ["ai.rule_source_change_draft.create"], command, now }));
});

test("非法 operation、before drift 与非法 selection 均阻断", () => {
  const illegalOperation = fixture();
  const definition = illegalOperation.state.parameters.find((entry) =>
    entry.key === illegalOperation.parameterKey)!;
  definition.allowedOperations = definition.allowedOperations?.filter((entry) => entry !== "add");
  assertCode("AI_DRAFT_RECOMMENDATION_INVALID", () => plan(illegalOperation));

  const beforeDrift = fixture();
  const recommendation = beforeDrift.record.semanticContent!.recommendations[0] as {
    suggestedChanges: Array<{ expectedBefore: { kind: "number"; value: number } }>;
  };
  recommendation.suggestedChanges[0]!.expectedBefore.value += 1;
  assertCode("AI_DRAFT_TARGET_REVISION_CHANGED", () => plan(beforeDrift));

  const invalidSelection = fixture();
  invalidSelection.command.selectedChangeIds = ["change.not-in-recommendation"];
  assertCode("AI_DRAFT_RECOMMENDATION_INVALID", () => plan(invalidSelection));
});

test("相同幂等命令产生相同 plan hash，不同幂等键只改变 artifact identity", () => {
  const value = fixture();
  const first = plan(value);
  const replay = plan(structuredClone(value));
  assert.equal(first.commandHash, replay.commandHash);
  assert.equal(first.preview.previewHash, replay.preview.previewHash);
  assert.equal(first.artifactRef.artifactId, replay.artifactRef.artifactId);

  const differentKey = structuredClone(value);
  differentKey.command.idempotencyKey = "idempotency.preview.2";
  const changed = plan(differentKey);
  assert.notEqual(first.commandHash, changed.commandHash);
  assert.equal(first.preview.previewHash, changed.preview.previewHash);
  assert.notEqual(first.artifactRef.artifactId, changed.artifactRef.artifactId);
});

test("assessment 级 Workspace reservation 使陈旧并发计划只能提交一个草稿", () => {
  const firstInput = fixture();
  firstInput.command.mode = "create";
  firstInput.command.userReason = "first concurrent artifact";
  firstInput.command.idempotencyKey = "idempotency.concurrent.1";
  const secondInput = structuredClone(firstInput);
  secondInput.command.userReason = "second concurrent artifact";
  secondInput.command.idempotencyKey = "idempotency.concurrent.2";

  const firstPlan = plan(firstInput);
  const staleSecondPlan = plan(secondInput);
  const winner = applyAIDraftArtifactPlan(firstInput.state, firstPlan);
  assert.equal(winner.idempotent, false);
  assert.equal(winner.state.aiArtifactProvenanceSyncRecords.length, 1);
  assert.equal(winner.state.aiArtifactProvenanceSyncRecords[0]?.state, "PENDING");
  assert.equal(winner.state.patchLedger.revisions.filter((entry) =>
    entry.patchId === firstPlan.artifactRef.artifactId).length, 1);

  assertCode("AI_ASSESSMENT_ARTIFACT_PROVENANCE_CONFLICT", () =>
    applyAIDraftArtifactPlan(winner.state, staleSecondPlan));
  assert.equal(winner.state.aiArtifactProvenanceSyncRecords.length, 1);
  assert.equal(winner.state.aiArtifactProvenanceSyncRecords.some((entry) =>
    entry.idempotencyKey === secondInput.command.idempotencyKey), false);
  assert.equal(winner.state.patchLedger.revisions.some((entry) =>
    entry.patchId === staleSecondPlan.artifactRef.artifactId), false);

  const replay = applyAIDraftArtifactPlan(winner.state, firstPlan);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.state.aiArtifactProvenanceSyncRecords.length, 1);
  assert.equal(replay.state.patchLedger.revisions.filter((entry) =>
    entry.patchId === firstPlan.artifactRef.artifactId).length, 1);
});

test("AI Model Patch 首次持久化绑定目标 Model，激活后进入权威重放且重试不重复", () => {
  const value = fixture();
  const recommendation = value.record.semanticContent!.recommendations[0]! as {
    suggestedChanges: Array<{ operand: { kind: "number"; value: number } }>;
  };
  recommendation.suggestedChanges[0]!.operand = { kind: "number", value: 1 };
  const draft = plan(value);
  assert.equal(draft.kind, "model_patch");
  const baseline = currentPatchPanelValuesFromWorkspace({ state: value.state, scopeType: "model", subjectEntityId: draft.patch.subjectEntityId });
  const persisted = applyAIDraftArtifactPlan(value.state, draft);
  const model = persisted.state.purchasableModels.find((entry) => entry.id === draft.patch.subjectEntityId)!;
  assert.deepEqual(model.patchIds.filter((id) => id === draft.patch.patchId), [draft.patch.patchId]);
  const active = structuredClone(persisted.state);
  active.patchLedger.revisions.find((entry) => entry.patchId === draft.patch.patchId)!.state = "ACTIVE";
  const replayed = currentPatchPanelValuesFromWorkspace({ state: active, scopeType: "model", subjectEntityId: draft.patch.subjectEntityId });
  assert.equal(replayed[draft.patch.operations[0]!.parameterKey], (baseline[draft.patch.operations[0]!.parameterKey] as number) + 1);
  const retried = applyAIDraftArtifactPlan(persisted.state, draft);
  assert.equal(retried.idempotent, true);
  assert.equal(retried.state.purchasableModels.find((entry) => entry.id === draft.patch.subjectEntityId)!.patchIds.filter((id) => id === draft.patch.patchId).length, 1);

  const changedRevision = structuredClone(value.state);
  changedRevision.purchasableModels.find((entry) => entry.id === draft.patch.subjectEntityId)!.revision += 1;
  assertCode("AI_DRAFT_TARGET_REVISION_CHANGED", () => applyAIDraftArtifactPlan(changedRevision, draft));
  const frozen = structuredClone(value.state);
  frozen.purchasableModels.find((entry) => entry.id === draft.patch.subjectEntityId)!.configurationSnapshotId = "snapshot:late-freeze";
  assertCode("AI_DRAFT_TARGET_FROZEN", () => applyAIDraftArtifactPlan(frozen, draft));
});

test("AI clear 预览、持久化和激活均复用 canonical replay 的完整面板", () => {
  const value = fixture();
  const model = value.state.purchasableModels.find((entry) => entry.id === value.command.targetModelRef!.entityId)!;
  const key = value.parameterKey;
  const baseline = currentPatchPanelValuesFromWorkspace({ state: value.state, scopeType: "model", subjectEntityId: model.id });
  const inherited = baseline[key] as number;
  const activeAdd = buildPatchRevision({
    patchId: "patch:model:active-add",
    patchRevision: 1,
    scopeType: "model", layerType: "model", subjectEntityId: model.id, subjectName: model.name,
    baseRuleSetVersion: value.state.ruleSetVersions.find((entry) => entry.status === "published")!.id,
    baseObjectRevision: model.revision, state: "ACTIVE", mirrorSyncState: "NOT_SYNCED", attentionStates: [],
    reason: "existing same-layer add", evidence: [], createdBy: "tester", createdAt: now, snapshotRefs: [],
    operations: [{ patchId: "patch:model:active-add", patchRevision: 1, operationId: "patch:model:active-add:op", operationIndex: 0, parameterKey: key, operation: "add", operand: 1, before: inherited, after: inherited + 1 }],
  });
  value.state.patchLedger.revisions.push(activeAdd);
  model.patchIds.push(activeAdd.patchId);
  const refreshed = prepareAIRequest({ envelope: buildWorkspaceAssessmentRequestProjection({
    state: value.state,
    scope: { scopeType: "model", scopeId: model.id },
    assessmentId,
    model: providerModel,
  }).envelope });
  value.record.metadata!.inputHash = refreshed.inputHash;
  value.command.assessmentInputHash = refreshed.inputHash;
  const recommendation = value.record.semanticContent!.recommendations[0]! as { suggestedChanges: Array<Record<string, unknown>> };
  recommendation.suggestedChanges[0] = {
    ...recommendation.suggestedChanges[0], operation: "clear", operand: { kind: "null", value: null },
    expectedBefore: { kind: "number", value: inherited + 1 },
  };
  const draft = plan(value);
  assert.equal(draft.kind, "model_patch");
  assert.equal(draft.preview.changes[0]?.after, inherited);
  assert.equal(draft.preview.diffs.invariants.newBlockingIssueCodes.length, 0);
  const persisted = applyAIDraftArtifactPlan(value.state, draft);
  const activated = structuredClone(persisted.state);
  activated.patchLedger.revisions.find((entry) => entry.patchId === draft.patch.patchId)!.state = "ACTIVE";
  const replayed = currentPatchPanelValuesFromWorkspace({ state: activated, scopeType: "model", subjectEntityId: model.id });
  assert.equal(replayed[key], inherited);
  assert.equal(Object.hasOwn(replayed, key), true);
});

test("RuleSourceChangeDraft 使用全工作区沙盒影响预览并只保存 LOCAL_DRAFT", () => {
  const value = fixture();
  const model = value.state.purchasableModels.find((entry) =>
    entry.id === value.command.targetModelRef?.entityId)!;
  const sku = value.state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const projection = value.state.derivedProjections.find((entry) =>
    entry.id === sku.projectionMatch.projectionId)!;
  const candidates = [
    ...value.state.methodProfiles
      .filter((profile) => profile.id === projection.methodId)
      .flatMap((profile) => profile.rules.map((rule) => ({ rule, sheetId: "fATowU" }))),
    ...value.state.itemTypeProfiles
      .filter((profile) => profile.id === projection.typeId)
      .flatMap((profile) => profile.rules.map((rule) => ({ rule, sheetId: "fATowU" }))),
    ...value.state.functionProfiles
      .filter((profile) => profile.id === projection.functionId)
      .flatMap((profile) => [
        ...profile.rules.map((rule) => ({ rule, sheetId: "vviXo0" })),
        ...profile.intensityRules
          .filter((entry) => entry.intensity === projection.functionIntensity)
          .flatMap((entry) => entry.rules.map((rule) => ({ rule, sheetId: "vviXo0" }))),
      ]),
    ...value.state.qualityProfiles
      .filter((profile) => profile.id === projection.qualityId)
      .flatMap((profile) => profile.rules.map((rule) => ({ rule, sheetId: "FqD4j7" }))),
  ];
  const source = candidates.find((entry) =>
    value.state.parameters.some((parameter) =>
      parameter.key === entry.rule.parameterKey
      && parameter.targetRange
      && parameter.allowedOperations?.includes("add")));
  assert.ok(source, "fixture must contain a supported current rule target");
  const currentProjection = buildWorkspaceAssessmentRequestProjection({
    state: value.state,
    scope: { scopeType: "model", scopeId: model.id },
    assessmentId,
    model: providerModel,
  });
  const mapping = currentProjection.parameterKeyMapping.find((entry) =>
    entry.parameterKey === source.rule.parameterKey)!;
  const panelValue = currentProjection.envelope.panelValues.find((entry) =>
    entry.parameterKey === mapping.alias)!.value;
  const recommendation = (value.record.semanticContent!.recommendations as Array<Record<string, unknown>>)[0]!;
  recommendation.suggestedAction = "create_rule_source_change_draft";
  recommendation.suggestedChanges = [{
    changeId: "change.rule.add-zero",
    parameterKey: mapping.alias,
    operation: "add",
    operand: { kind: "number", value: 0 },
    expectedBefore: structuredClone(panelValue),
  }];
  value.state.feishuSourceRevisions = [{
    id: "feishu-revision:rule-preview",
    workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: "source-revision-1",
    spreadsheetToken: "spreadsheet-token-1",
    pulledAt: now,
    pulledBy: "planner-test",
    syncScope: "workbook",
    registryHash: "registry-hash",
    sheets: [{ sheetId: source.sheetId, name: source.sheetId }],
    issues: [],
    state: "PULLED",
  }];
  value.command = {
    ...value.command,
    mode: "create",
    selectedChangeIds: ["change.rule.add-zero"],
    userReason: "验证规则源沙盒影响",
    idempotencyKey: "idempotency.rule.1",
    targetRuleRef: {
      spreadsheetToken: "spreadsheet-token-1",
      sheetId: source.sheetId,
      stableRuleId: source.rule.id,
      parameterKey: source.rule.parameterKey,
      sourceRevision: "source-revision-1",
    },
  };

  const result = planAIDraftConversion({
    state: value.state,
    record: value.record,
    assessmentId,
    actorStableId,
    actorDisplayName: "Planner Test",
    capabilities: ["ai.rule_source_change_draft.create"],
    command: value.command,
    now,
  });
  assert.equal(result.kind, "rule_source_change_draft");
  assert.equal(result.ruleDraft.state, "LOCAL_DRAFT");
  assert.equal(result.ruleDraft.impactPreview.coverage.complete, true);
  assert.equal(result.ruleDraft.impactPreview.coverage.evaluatedModels, value.state.purchasableModels.length);
  assert.equal(result.ruleDraft.impactPreview.publishedSnapshotsChanged, 0);
  const applied = applyAIDraftArtifactPlan(value.state, result);
  assert.equal(applied.idempotent, false);
  assert.equal(applied.state.aiRuleSourceChangeDrafts.at(-1)?.changeDraftId, result.ruleDraft.changeDraftId);
  assert.equal(
    applied.state.ruleSetVersions.filter((entry) => entry.status === "published").length,
    value.state.ruleSetVersions.filter((entry) => entry.status === "published").length,
  );
  const reloaded = structuredClone(applied.state);
  const discoverable = reloaded.aiRuleSourceChangeDrafts.find((entry) =>
    entry.changeDraftId === result.ruleDraft.changeDraftId);
  assert.ok(discoverable, "persisted AI rule draft must remain discoverable after reload");
  assert.equal(discoverable.state, "LOCAL_DRAFT");

  const confirmed = confirmAIRuleSourceChangeDraft({
    state: reloaded,
    changeDraftId: discoverable.changeDraftId,
    actorStableId,
    confirmedAt: "2026-07-23T00:01:00.000Z",
    expectedCommandHash: discoverable.commandHash,
    idempotencyKey: "confirm-rule-draft:1",
    capabilities: ["feishu.rule_change.confirm_write"],
  });
  const reviewed = confirmed.state.aiRuleSourceChangeDrafts.find((entry) =>
    entry.changeDraftId === discoverable.changeDraftId)!;
  assert.equal(reviewed.state, "CONFIRMED");
  assert.deepEqual(reviewed.humanReview, {
    confirmedBy: actorStableId,
    confirmedAt: "2026-07-23T00:01:00.000Z",
    reviewedCommandHash: reviewed.commandHash,
    reviewedSourceRevision: "source-revision-1",
  });
  assert.equal(applied.state.aiRuleSourceChangeDrafts.at(-1)?.state, "LOCAL_DRAFT");
  const retried = confirmAIRuleSourceChangeDraft({
    state: confirmed.state,
    changeDraftId: discoverable.changeDraftId,
    actorStableId,
    confirmedAt: "2026-07-23T00:05:00.000Z",
    expectedCommandHash: discoverable.commandHash,
    idempotencyKey: "confirm-rule-draft:1",
    capabilities: ["feishu.rule_change.confirm_write"],
  });
  assert.equal(retried.idempotent, true);
  assert.equal(retried.draft.humanReview?.confirmedAt, "2026-07-23T00:01:00.000Z");
  assert.throws(() => confirmAIRuleSourceChangeDraft({
    state: reloaded,
    changeDraftId: discoverable.changeDraftId,
    actorStableId,
    confirmedAt: "2026-07-23T00:01:00.000Z",
    expectedCommandHash: discoverable.commandHash,
    idempotencyKey: "confirm-rule-draft:permission",
    capabilities: ["ai.rule_source_change_draft.create"],
  }), (error: unknown) => error instanceof AIDraftConversionError
    && error.code === "AI_DRAFT_PERMISSION_DENIED");

  const changedSource = structuredClone(reloaded);
  changedSource.feishuSourceRevisions.push({
    ...structuredClone(changedSource.feishuSourceRevisions[0]!),
    id: "feishu-revision:rule-preview-newer",
    sourceRevision: "source-revision-2",
    pulledAt: "2026-07-23T00:02:00.000Z",
  });
  assert.throws(
    () => confirmAIRuleSourceChangeDraft({
      state: changedSource,
      changeDraftId: discoverable.changeDraftId,
      actorStableId,
      confirmedAt: "2026-07-23T00:03:00.000Z",
      expectedCommandHash: discoverable.commandHash,
      idempotencyKey: "confirm-rule-draft:2",
      capabilities: ["feishu.rule_change.confirm_write"],
    }),
    (error: unknown) => error instanceof AIDraftConversionError
      && error.code === "AI_RULE_SOURCE_REVISION_CHANGED",
  );
});
