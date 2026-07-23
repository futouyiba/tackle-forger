import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_ASSESSMENT_PROMPT,
  AI_ASSESSMENT_PROMPT_VERSION,
  buildWorkspaceAssessmentEnvelope,
  buildWorkspaceAssessmentRequestProjection,
  workspaceAssessmentScopeExists,
} from "../lib/ai-assessment-request";
import { describeFancyHubModels, prepareAIRequest, promptTemplateHash } from "../lib/ai-outbound";
import { createSeedState } from "../lib/seed";

const providerModel = describeFancyHubModels([{
  modelId: "model.alpha",
  modelVersion: "2026-07-23",
  deploymentRevision: "deploy.7",
  modelArtifactDigest: "sha256:abc",
}]).models[0]!;

test("Series 与 Model 评估请求绑定真实且随源投影变化的 snapshot EvidenceRef", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  const model = state.purchasableModels[0]!;

  for (const scope of [
    { scopeType: "series" as const, scopeId: series.id },
    { scopeType: "model" as const, scopeId: model.id },
  ]) {
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
    assert.equal(envelope.evidenceRefs[0]?.evidenceType, "snapshot");
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
    assert.ok(retainedProjection.requestAliasMapping.some(
      (entry) => entry.reference.stableLocalId === scope.scopeId,
    ));
  }

  const originalModelEnvelope = buildWorkspaceAssessmentEnvelope({
    state,
    scope: { scopeType: "model", scopeId: model.id },
    assessmentId: "assessment:model:original",
    model: providerModel,
  });
  const changed = structuredClone(state);
  changed.purchasableModels.find((entry) => entry.id === model.id)!.price += 1;
  const changedModelEnvelope = buildWorkspaceAssessmentEnvelope({
    state: changed,
    scope: { scopeType: "model", scopeId: model.id },
    assessmentId: "assessment:model:changed",
    model: providerModel,
  });
  assert.notEqual(
    originalModelEnvelope.evidenceRefs[0]?.contentHash,
    changedModelEnvelope.evidenceRefs[0]?.contentHash,
  );
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
