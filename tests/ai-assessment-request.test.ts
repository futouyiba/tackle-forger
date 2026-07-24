import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_ASSESSMENT_PROMPT,
  AI_ASSESSMENT_PROMPT_VERSION,
  buildWorkspaceAssessmentEnvelope,
  buildWorkspaceAssessmentRequestProjection,
  workspaceAssessmentScopeExists,
} from "../lib/ai-assessment-request";
import {
  describeFancyHubModels,
  jcsCanonicalize,
  prepareAIRequest,
  promptTemplateHash,
  sha256Hex,
} from "../lib/ai-outbound";
import { createSeedState } from "../lib/seed";

const providerModel = describeFancyHubModels([{
  modelId: "model.alpha",
  modelVersion: "2026-07-23",
  deploymentRevision: "deploy.7",
  modelArtifactDigest: "sha256:abc",
}]).models[0]!;

test("Series 使用真实不变量证据，已发布 Model 绑定实际 ConfigurationSnapshot", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  const model = state.purchasableModels[0]!;
  const snapshot = state.configurationSnapshots.find((entry) =>
    entry.id === model.configurationSnapshotId)!;

  for (const [scope, expected] of [
    [
      { scopeType: "series" as const, scopeId: series.id },
      {
        evidenceType: "series_invariant",
        refId: `${series.id}:series-invariant`,
        revisionId: String(series.revision),
      },
    ],
    [
      { scopeType: "model" as const, scopeId: model.id },
      {
        evidenceType: "snapshot",
        refId: snapshot.id,
        revisionId: String(snapshot.version),
      },
    ],
  ] as const) {
    assert.equal(workspaceAssessmentScopeExists(state, scope), true);
    const envelope = buildWorkspaceAssessmentEnvelope({
      state,
      scope,
      assessmentId: `assessment:${scope.scopeType}`,
      model: providerModel,
    });
    assert.equal(envelope.promptTemplateVersion, AI_ASSESSMENT_PROMPT_VERSION);
    assert.match(AI_ASSESSMENT_PROMPT, /uncoveredInformation/);
    assert.equal(envelope.evidenceRefs.length, 1);
    assert.equal(envelope.evidenceRefs[0]?.evidenceType, expected.evidenceType);
    assert.match(envelope.evidenceRefs[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(envelope.evidenceRefs[0]?.evidenceAlias, envelope.scope.scopeAlias);
    assert.doesNotThrow(() => prepareAIRequest({ envelope }));

    const retainedProjection = buildWorkspaceAssessmentRequestProjection({
      state,
      scope,
      assessmentId: `assessment:${scope.scopeType}`,
      model: providerModel,
    });
    assert.equal(retainedProjection.prompt, AI_ASSESSMENT_PROMPT);
    assert.equal(
      promptTemplateHash(retainedProjection.prompt),
      retainedProjection.envelope.promptTemplateHash,
    );
    assert.deepEqual(
      retainedProjection.requestAliasMapping.map((entry) => entry.alias),
      [...retainedProjection.requestAliasMapping.map((entry) => entry.alias)].sort(),
    );
    assert.equal(retainedProjection.requestAliasMapping.length, 4);
    const evidenceReference = retainedProjection.requestAliasMapping.find((entry) =>
      entry.alias === retainedProjection.envelope.evidenceRefs[0]?.evidenceAlias)?.reference;
    assert.equal(evidenceReference?.referenceKindCode, "evidence");
    assert.equal(evidenceReference?.stableLocalId, expected.refId);
    assert.equal(evidenceReference?.stableRevisionId, expected.revisionId);
  }
  assert.equal(
    buildWorkspaceAssessmentEnvelope({
      state,
      scope: { scopeType: "model", scopeId: model.id },
      assessmentId: "assessment:model:snapshot-hash",
      model: providerModel,
    }).evidenceRefs[0]?.contentHash,
    sha256Hex(jcsCanonicalize({
      evidenceType: "configuration_snapshot",
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
      snapshotContentHash: snapshot.contentHash,
      modelId: snapshot.modelId,
      modelRevision: snapshot.modelRevision,
    })),
  );

  const mutableModel = state.purchasableModels.find((entry) => !entry.configurationSnapshotId)!;
  const originalModelEnvelope = buildWorkspaceAssessmentEnvelope({
    state,
    scope: { scopeType: "model", scopeId: mutableModel.id },
    assessmentId: "assessment:model:original",
    model: providerModel,
  });
  assert.equal(originalModelEnvelope.evidenceRefs[0]?.evidenceType, "trace");
  const changed = structuredClone(state);
  changed.purchasableModels.find((entry) => entry.id === mutableModel.id)!.price += 1;
  const changedModelEnvelope = buildWorkspaceAssessmentEnvelope({
    state: changed,
    scope: { scopeType: "model", scopeId: mutableModel.id },
    assessmentId: "assessment:model:changed",
    model: providerModel,
  });
  assert.notEqual(
    originalModelEnvelope.evidenceRefs[0]?.contentHash,
    changedModelEnvelope.evidenceRefs[0]?.contentHash,
  );
});

test("冻结 Model 的 Envelope 只读取 Snapshot，未冻结 Model 响应当前 Patch 变化", () => {
  const state = createSeedState();
  state.parameters.find((entry) => entry.key === "杆最大拉力kgf")!.targetRange = {
    min: 0,
    max: 1_000,
  };
  const frozenModel = state.purchasableModels.find((entry) =>
    Boolean(entry.configurationSnapshotId))!;
  const snapshot = state.configurationSnapshots.find((entry) =>
    entry.id === frozenModel.configurationSnapshotId)!;
  const mutableModel = state.purchasableModels.find((entry) =>
    !entry.configurationSnapshotId
    && entry.skuId === frozenModel.skuId)!;
  const frozenAssessmentId = "assessment:frozen-envelope";
  const mutableAssessmentId = "assessment:mutable-envelope";

  const frozenBefore = buildWorkspaceAssessmentRequestProjection({
    state,
    scope: { scopeType: "model", scopeId: frozenModel.id },
    assessmentId: frozenAssessmentId,
    model: providerModel,
  });
  const mutableBefore = buildWorkspaceAssessmentRequestProjection({
    state,
    scope: { scopeType: "model", scopeId: mutableModel.id },
    assessmentId: mutableAssessmentId,
    model: providerModel,
  });
  const pullParameter = frozenBefore.parameterKeyMapping.find((entry) =>
    entry.parameterKey === "杆最大拉力kgf")!;
  const frozenPullBefore = frozenBefore.envelope.panelValues.find((entry) =>
    entry.parameterKey === pullParameter.alias);
  assert.deepEqual(frozenPullBefore?.value, {
    kind: "number",
    value: snapshot.finalPanelValues["杆最大拉力kgf"],
  });

  const changed = structuredClone(state);
  const seriesPatch = changed.patchLedger.revisions.find((entry) =>
    entry.patchId === "patch:series-qinglu-force")!;
  const pullOperation = seriesPatch.operations.find((entry) =>
    entry.parameterKey === "杆最大拉力kgf")!;
  pullOperation.operand = 41;

  const frozenAfter = buildWorkspaceAssessmentRequestProjection({
    state: changed,
    scope: { scopeType: "model", scopeId: frozenModel.id },
    assessmentId: frozenAssessmentId,
    model: providerModel,
  });
  const mutableAfter = buildWorkspaceAssessmentRequestProjection({
    state: changed,
    scope: { scopeType: "model", scopeId: mutableModel.id },
    assessmentId: mutableAssessmentId,
    model: providerModel,
  });
  const preparedFrozenBefore = prepareAIRequest({ envelope: frozenBefore.envelope });
  const preparedFrozenAfter = prepareAIRequest({ envelope: frozenAfter.envelope });
  const preparedMutableBefore = prepareAIRequest({ envelope: mutableBefore.envelope });
  const preparedMutableAfter = prepareAIRequest({ envelope: mutableAfter.envelope });

  assert.deepEqual(preparedFrozenAfter.canonicalBytes, preparedFrozenBefore.canonicalBytes);
  assert.equal(preparedFrozenAfter.inputHash, preparedFrozenBefore.inputHash);
  assert.notDeepEqual(preparedMutableAfter.canonicalBytes, preparedMutableBefore.canonicalBytes);
  assert.notEqual(preparedMutableAfter.inputHash, preparedMutableBefore.inputHash);

  const definitionChanged = structuredClone(state);
  definitionChanged.parameters.find((entry) =>
    entry.key === "杆最大拉力kgf")!.allowedOperations = [];
  const frozenAfterDefinitionChange = prepareAIRequest({
    envelope: buildWorkspaceAssessmentEnvelope({
      state: definitionChanged,
      scope: { scopeType: "model", scopeId: frozenModel.id },
      assessmentId: frozenAssessmentId,
      model: providerModel,
    }),
  });
  const mutableAfterDefinitionChange = prepareAIRequest({
    envelope: buildWorkspaceAssessmentEnvelope({
      state: definitionChanged,
      scope: { scopeType: "model", scopeId: mutableModel.id },
      assessmentId: mutableAssessmentId,
      model: providerModel,
    }),
  });
  assert.deepEqual(
    frozenAfterDefinitionChange.canonicalBytes,
    preparedFrozenBefore.canonicalBytes,
  );
  assert.equal(frozenAfterDefinitionChange.inputHash, preparedFrozenBefore.inputHash);
  assert.notDeepEqual(
    mutableAfterDefinitionChange.canonicalBytes,
    preparedMutableBefore.canonicalBytes,
  );
  assert.notEqual(mutableAfterDefinitionChange.inputHash, preparedMutableBefore.inputHash);
});

test("不存在的 Series/Model scope 在构造出站请求前 fail-closed", () => {
  const state = createSeedState();
  for (const scope of [
    { scopeType: "series" as const, scopeId: "series:missing" },
    { scopeType: "model" as const, scopeId: "model:missing" },
  ]) {
    assert.equal(workspaceAssessmentScopeExists(state, scope), false);
    assert.throws(
      () => buildWorkspaceAssessmentEnvelope({ state, scope, assessmentId: "assessment:missing", model: providerModel }),
      /AI_SCOPE_NOT_FOUND/,
    );
  }
});

test("延期部位和不一致的 Model→SKU→Series→Snapshot 链在出站前 fail-closed", () => {
  const disabledSeriesState = createSeedState();
  const disabledSeries = disabledSeriesState.seriesDefinitions[0]!;
  disabledSeries.itemPartId = "part:hook";
  for (const sku of disabledSeriesState.skuDrawers.filter((entry) =>
    entry.seriesId === disabledSeries.id)) {
    sku.projectionMatch.itemPartId = "part:hook";
  }
  const disabledSeriesScope = {
    scopeType: "series" as const,
    scopeId: disabledSeries.id,
  };
  assert.equal(workspaceAssessmentScopeExists(disabledSeriesState, disabledSeriesScope), false);
  assert.throws(
    () => buildWorkspaceAssessmentEnvelope({
      state: disabledSeriesState,
      scope: disabledSeriesScope,
      assessmentId: "assessment:disabled-series",
      model: providerModel,
    }),
    (error: unknown) =>
      error instanceof Error
      && "code" in error
      && error.code === "ITEM_PART_NOT_ENABLED",
  );

  const disabledModelState = createSeedState();
  const disabledModel = disabledModelState.purchasableModels[0]!;
  const disabledSku = disabledModelState.skuDrawers.find((entry) =>
    entry.id === disabledModel.skuId)!;
  disabledSku.projectionMatch.itemPartId = "part:hook";
  assert.throws(
    () => buildWorkspaceAssessmentEnvelope({
      state: disabledModelState,
      scope: { scopeType: "model", scopeId: disabledModel.id },
      assessmentId: "assessment:disabled-model",
      model: providerModel,
    }),
    (error: unknown) =>
      error instanceof Error
      && "code" in error
      && error.code === "ITEM_PART_NOT_ENABLED",
  );

  const inconsistentSnapshotState = createSeedState();
  const frozenModel = inconsistentSnapshotState.purchasableModels.find((entry) =>
    Boolean(entry.configurationSnapshotId))!;
  const frozenSnapshot = inconsistentSnapshotState.configurationSnapshots.find((entry) =>
    entry.id === frozenModel.configurationSnapshotId)!;
  frozenSnapshot.projectionMatch.itemPartId = "part:reel";
  assert.throws(
    () => buildWorkspaceAssessmentEnvelope({
      state: inconsistentSnapshotState,
      scope: { scopeType: "model", scopeId: frozenModel.id },
      assessmentId: "assessment:inconsistent-snapshot",
      model: providerModel,
    }),
    (error: unknown) =>
      error instanceof Error
      && "code" in error
      && error.code === "ITEM_PART_CHAIN_INCONSISTENT",
  );
});

test("启用 Series 可保留延期 sibling，但安全投影不会带出其拉力规格", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  const enabledSku = state.skuDrawers.find((entry) => entry.seriesId === series.id)!;
  const delayedSku = structuredClone(enabledSku);
  delayedSku.id = `${enabledSku.id}:delayed-hook`;
  delayedSku.projectionMatch.itemPartId = "part:hook";
  delayedSku.targetPullKg = enabledSku.targetPullKg + 99;
  delayedSku.modelIds = [];
  state.skuDrawers.push(delayedSku);
  series.targetPullSpecifications.push({
    targetPullKgf: delayedSku.targetPullKg,
    skuId: delayedSku.id,
  });

  const projection = buildWorkspaceAssessmentRequestProjection({
    state,
    scope: { scopeType: "series", scopeId: series.id },
    assessmentId: "assessment:enabled-series-with-delayed-sibling",
    model: providerModel,
  });
  assert.equal(workspaceAssessmentScopeExists(
    state,
    { scopeType: "series", scopeId: series.id },
  ), true);
  assert.equal(
    projection.envelope.panelValues.some((entry) =>
      entry.parameterKey === "target_pull_kgf"
      && entry.value.kind === "number"
      && entry.value.value === delayedSku.targetPullKg),
    false,
  );
});
