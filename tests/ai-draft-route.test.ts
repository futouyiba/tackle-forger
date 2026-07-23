import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as convertAssessmentDraft } from "../app/api/ai/assessments/[assessmentId]/drafts/route";
import { POST as dismissAssessmentRecommendation } from "../app/api/ai/assessments/[assessmentId]/feedback/route";
import { buildWorkspaceAssessmentRequestProjection } from "../lib/ai-assessment-request";
import { AI_RETENTION_POLICY_VERSION, type AIAssessmentRetentionRecord } from "../lib/ai-retention";
import { createAIRuntimeStoreFromEnvironment } from "../lib/ai-runtime-store";
import { describeFancyHubModels, prepareAIRequest } from "../lib/ai-outbound";
import { currentPatchPanelValuesFromWorkspace } from "../lib/patch-authority";
import { loadWorkspaceState, saveWorkspaceState } from "../lib/storage";

const authHeaders = {
  "content-type": "application/json",
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "draft-route-tester",
  "x-feishu-display-name": "draft-route-tester",
  "x-tf-proxy-secret": "draft-route-secret",
};

function configureAuth(): void {
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "draft-route-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
}

test("AI 草稿路由先预览、只建 DRAFT，并以同幂等键恢复永久来源", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-draft-route-"));
  const previousDatabase = process.env.WORKSPACE_DATABASE_PATH;
  const previousRetention = process.env.AI_RETENTION_DATA_DIR;
  const previousKey = process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
  const previousKeyVersion = process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
  try {
    configureAuth();
    process.env.WORKSPACE_DATABASE_PATH = path.join(root, "workspace.sqlite");
    process.env.AI_RETENTION_DATA_DIR = path.join(root, "ai-retention");
    process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 23).toString("base64");
    process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "draft-route-test-v1";

    const initial = await loadWorkspaceState();
    const model = initial.state.purchasableModels.find((entry) =>
      entry.status !== "published" && !entry.configurationSnapshotId)!;
    const panels = currentPatchPanelValuesFromWorkspace({
      state: initial.state,
      scopeType: "model",
      subjectEntityId: model.id,
    });
    for (const definition of initial.state.parameters) {
      if (definition.allowedOperations?.some((operation) =>
        operation === "set" || operation === "add" || operation === "multiply")) {
        definition.targetRange = { min: -1_000_000, max: 1_000_000 };
      }
    }
    const parameter = initial.state.parameters.find((entry) =>
      typeof panels[entry.key] === "number" && entry.allowedOperations?.includes("add"))!;
    const preparedState = structuredClone(initial.state);
    const saved = await saveWorkspaceState({
      state: preparedState,
      baseRevision: initial.revision,
      author: "draft-route-test",
      message: "prepare authoritative parameter range",
    });
    assert.equal(saved.conflict, undefined);

    const current = await loadWorkspaceState();
    const assessmentId = "assessment-draft-route";
    const modelDescriptor = describeFancyHubModels([{
      modelId: "model.alpha",
      modelVersion: "2026-07-23",
      deploymentRevision: "deploy.7",
      modelArtifactDigest: "sha256:route",
    }]).models[0]!;
    const projection = buildWorkspaceAssessmentRequestProjection({
      state: current.state,
      scope: { scopeType: "model", scopeId: model.id },
      assessmentId,
      model: modelDescriptor,
    });
    const request = prepareAIRequest({ envelope: projection.envelope });
    const parameterMapping = projection.parameterKeyMapping.find((entry) =>
      entry.parameterKey === parameter.key)!;
    const panel = projection.envelope.panelValues.find((entry) =>
      entry.parameterKey === parameterMapping.alias)!;
    const scopeAlias = projection.requestAliasMapping.find((entry) =>
      entry.reference.referenceKindCode === "model"
      && entry.reference.stableLocalId === model.id)!.alias;
    const evidence = projection.envelope.evidenceRefs[0]!;
    const recommendation = {
      recommendationCode: "recommendation.route.patch",
      title: "Route patch",
      summary: "Add zero after deterministic preview.",
      subjectAliases: [scopeAlias],
      evidenceAliases: [evidence.evidenceAlias],
      suggestedAction: "create_model_patch_draft" as const,
      suggestedChanges: [{
        changeId: "change.route.add-zero",
        parameterKey: parameterMapping.alias,
        operation: "add" as const,
        operand: { kind: "number" as const, value: 0 },
        expectedBefore: structuredClone(panel.value),
      }],
    };
    const now = "2026-07-23T00:00:00.000Z";
    const record: AIAssessmentRetentionRecord = {
      policyVersion: AI_RETENTION_POLICY_VERSION,
      metadata: {
        assessmentId,
        actorStableId: "draft-route-tester",
        scopeStableRef: model.id,
        metadataSchemaVersion: "ai-operation-metadata/v2",
        scope: { scopeType: "model", scopeId: model.id, inputRevision: String(model.revision) },
        ruleSetVersion: projection.operationMetadataContext.ruleSetVersion,
        fiveAxisRuleVersion: projection.operationMetadataContext.fiveAxisRuleVersion,
        attempts: [],
        retryCount: 0,
        cancellationStatus: "NOT_REQUESTED",
        modelDescriptor,
        promptTemplateVersion: projection.envelope.promptTemplateVersion,
        promptTemplateHash: projection.envelope.promptTemplateHash,
        schemaVersion: projection.envelope.schemaVersion,
        allowlistPolicyVersion: projection.envelope.policyVersion,
        inputHash: request.inputHash,
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
      },
      semanticContentCreatedAt: now,
      visibility: "VISIBLE",
    };
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    await store.saveAssessment(record);

    const send = (body: Record<string, unknown>) => convertAssessmentDraft(
      new NextRequest(`http://localhost/api/ai/assessments/${assessmentId}/drafts`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ assessmentId }) },
    );
    const command = {
      recommendationId: recommendation.recommendationCode,
      assessmentInputHash: request.inputHash,
      selectedChangeIds: [recommendation.suggestedChanges[0]!.changeId],
      targetModelRef: { entityId: model.id, revisionId: String(model.revision) },
    };
    const beforePreview = await loadWorkspaceState();
    const previewResponse = await send({
      ...command,
      mode: "preview",
      userReason: "",
      idempotencyKey: "draft-route.preview.1",
    });
    assert.equal(previewResponse.status, 200, JSON.stringify(await previewResponse.clone().json()));
    const preview = await previewResponse.json() as {
      mode: string;
      kind: string;
      changes: unknown[];
      canCreate: boolean;
    };
    assert.equal(preview.mode, "preview");
    assert.equal(preview.kind, "model_patch");
    assert.equal(preview.changes.length, 1);
    assert.equal(preview.canCreate, true);
    assert.equal((await loadWorkspaceState()).revision, beforePreview.revision);

    const createBody = {
      ...command,
      mode: "create",
      userReason: "route idempotency test",
      idempotencyKey: "draft-route.create.1",
    };
    const firstResponse = await send(createBody);
    assert.equal(firstResponse.status, 200, JSON.stringify(await firstResponse.clone().json()));
    const first = await firstResponse.json() as {
      artifactRef: { artifactId: string; state: string };
      revision: number;
      state: {
        patchLedger: { revisions: Array<{ patchId: string; state: string }> };
        aiArtifactProvenanceSyncRecords: Array<{ idempotencyKey: string; state: string }>;
      };
      provenanceSyncState: string;
      idempotent: boolean;
    };
    assert.equal(first.artifactRef.state, "DRAFT");
    assert.equal(first.provenanceSyncState, "SYNCED");
    assert.equal(first.idempotent, false);
    assert.equal(first.state.patchLedger.revisions.filter(
      (entry) => entry.patchId === first.artifactRef.artifactId && entry.state === "DRAFT",
    ).length, 1);
    assert.equal(first.state.aiArtifactProvenanceSyncRecords.find(
      (entry) => entry.idempotencyKey === createBody.idempotencyKey)?.state, "SYNCED");

    const retryResponse = await send(createBody);
    assert.equal(retryResponse.status, 200, JSON.stringify(await retryResponse.clone().json()));
    const retry = await retryResponse.json() as {
      artifactRef: { artifactId: string };
      idempotent: boolean;
      state: { patchLedger: { revisions: Array<{ patchId: string }> } };
    };
    assert.equal(retry.idempotent, true);
    assert.equal(retry.artifactRef.artifactId, first.artifactRef.artifactId);
    assert.equal(retry.state.patchLedger.revisions.filter(
      (entry) => entry.patchId === first.artifactRef.artifactId,
    ).length, 1);

    const retained = await store.readAssessmentForActor({
      assessmentId,
      actorStableId: "draft-route-tester",
    });
    assert.equal(retained?.metadata?.state, "ACCEPTED");
    assert.deepEqual(retained?.acceptedArtifactProvenance?.artifactStableRefs, [
      first.artifactRef.artifactId,
    ]);

    const dismissResponse = await dismissAssessmentRecommendation(
      new NextRequest(`http://localhost/api/ai/assessments/${assessmentId}/feedback`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ recommendationId: recommendation.recommendationCode }),
      }),
      { params: Promise.resolve({ assessmentId }) },
    );
    assert.equal(dismissResponse.status, 200);
    const afterDismiss = await store.readAssessmentForActor({
      assessmentId,
      actorStableId: "draft-route-tester",
    });
    assert.equal(
      afterDismiss?.semanticContent?.feedback?.recommendations[0]?.recommendationId,
      recommendation.recommendationCode,
    );

    const conflicting = await send({ ...createBody, userReason: "same key, different command" });
    assert.equal(conflicting.status, 422);
    assert.equal(((await conflicting.json()) as { code?: string }).code, "AI_DRAFT_IDEMPOTENCY_CONFLICT");

    const malformed = await send({ ...createBody, selectedChangeIds: [1] });
    assert.equal(malformed.status, 400);
  } finally {
    if (previousDatabase === undefined) delete process.env.WORKSPACE_DATABASE_PATH;
    else process.env.WORKSPACE_DATABASE_PATH = previousDatabase;
    if (previousRetention === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previousRetention;
    if (previousKey === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previousKey;
    if (previousKeyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previousKeyVersion;
  }
});
