import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { POST as issueActionCommand } from "../app/api/action-commands/route";
import { POST as v23Actions } from "../app/api/v23/actions/route";
import { jcsSha256Hex } from "../lib/canonical-json";
import { deterministicHash } from "../lib/rule-kernel";
import { PHASE_ONE_CAPABILITIES } from "../lib/feishu-identity";
import { importQualityValuePolicyDraft } from "../lib/quality-value-policy";
import {
  importReductionStackingPolicyDraft,
  publishReductionStackingPolicyVersion,
} from "../lib/reduction-stacking-policy";
import { closeSqliteStorage } from "../lib/sqlite-storage";
import { loadWorkspaceState, saveWorkspaceState } from "../lib/storage";
import {
  executeV23DomainAction,
  v23ActionInputHash,
} from "../lib/v23-domain-actions";

const authHeaders = {
  "content-type": "application/json",
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "v23-route-tester",
  "x-feishu-display-name": "v23-route-tester",
  "x-tf-proxy-secret": "v23-route-secret",
};

let root = "";
let databasePath = "";
const previousDatabasePath = process.env.WORKSPACE_DATABASE_PATH;

function commandPayload<T extends Record<string, unknown>>(
  workspaceRevision: number,
  value: T,
) {
  const input = { expectedWorkspaceRevision: workspaceRevision, ...value };
  return { ...input, inputHash: v23ActionInputHash(input) };
}

async function issueQualityCommand(
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  return issueCommand("set_sku_actual_quality", idempotencyKey, payload);
}

async function issueCommand(
  action: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  return issueActionCommand(new NextRequest("http://localhost/api/action-commands", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      action,
      idempotencyKey,
      payload,
    }),
  }));
}

async function invokeCommand(invocation: { actionId: string; payloadRefId: string }) {
  return v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(invocation),
  }));
}

async function prepareAssessedSku() {
  const current = await loadWorkspaceState();
  let state = structuredClone(current.state);
  const sourceRevisionId = "source:v23-api-quality@1";
  state.qualityValuePolicyDrafts = [importQualityValuePolicyDraft({
    sourceRevisionId,
    sourceRevision: "1",
    ranges: [
      ["quality_c_green", 0, 20],
      ["quality_b_blue", 20, 40],
      ["quality_a_purple", 40, 65],
      ["quality_s_orange", 65, 100],
    ].map(([qualityId, minScore, maxScore], index) => ({
      qualityId: qualityId as "quality_c_green",
      minScore: Number(minScore),
      maxScore: Number(maxScore),
      maxInclusive: false,
      source: { sheetId: "27hboC", cell: `B${index + 2}` },
      status: "SOURCE" as const,
    })),
    aliases: [],
    matrixCells: [],
    importedAt: "2026-07-29T00:00:00.000Z",
  })];
  state.functionProfiles = [{
    id: "function:v23-api",
    name: "API 功能",
    rules: [],
    intensityRules: [{
      intensity: 2,
      itemPartId: "part:rod",
      rules: [],
      scoreFactor: 1,
      scoreFactorSourceRef: `16qYVn!F2@${sourceRevisionId}`,
      sourceRowId: "function:v23-api:2",
    }],
    enabled: true,
    sourceRevisionId,
    notes: "",
  }];
  const canonicalContent = {
    parameters: [],
    templates: [],
    methodProfiles: [],
    itemTypeProfiles: [],
    functionProfiles: structuredClone(state.functionProfiles),
    modifiers: [],
    layers: [],
  };
  const canonicalHash = deterministicHash(canonicalContent);
  state.canonicalRuleSourceDrafts = [{
    id: `canonical-rule-draft:${sourceRevisionId}:${canonicalHash}`,
    sourceRevisionId,
    sourceRevision: "1",
    contentHash: canonicalHash,
    importedAt: "2026-07-29T00:00:00.000Z",
    ...canonicalContent,
    issues: [],
  }];
  const reduction = publishReductionStackingPolicyVersion({
    draft: importReductionStackingPolicyDraft({
      sourceRevision: {
        id: sourceRevisionId,
        workbookRefId: "feishu-workbook:tackle-design",
        sourceRevision: "1",
        sheets: [{ sheetId: "23CsXE" }],
      } as never,
      machineRules: [{
        ruleId: "pull",
        parameterKey: "pull",
        strategy: "bidirectional_ratio",
        numericContract: "ieee754-binary64-v1",
        operationOrder: [
          "set", "percent_adjust", "flat_adjust", "clamp_add",
          "final_review_patch", "parameter_definition",
        ],
      }],
      createdAt: "2026-07-29T00:00:00.000Z",
    }),
    publishedAt: "2026-07-29T00:00:00.000Z",
    publishedBy: "test",
  });
  state.reductionStackingPolicyVersions = [reduction];
  const key = {
    partType: "rod" as const,
    weightBandId: "band:v23-api",
    fishingMethodId: "method:v23-api",
    materialTypeId: "material:v23-api",
    functionProfileId: "function:v23-api",
    functionIntensity: 2 as const,
  };
  const baselinePullKg = 5;
  state.v23FunctionTemplates = [{
    ref: {
      templateId: "template:v23-api",
      revisionId: "revision:1",
      contentHash: jcsSha256Hex({
        contractVersion: "v23-function-template/v1",
        key,
        baselinePullKg,
      }),
    },
    key,
    baselinePullKg,
  }];
  const seriesPayload = commandPayload(current.revision, {
    seriesId: "series:v23-quality-api",
    collectionId: null,
    name: "V23 Quality API",
    concept: "set actual quality route",
    parts: [{
      partId: "part:v23-quality-api:rod",
      partType: "rod",
      fishingMethodId: key.fishingMethodId,
      materialTypeId: key.materialTypeId,
      functionProfileId: key.functionProfileId,
      functionIntensity: key.functionIntensity,
      weightBandIds: [key.weightBandId],
      defaultEntryRefs: [],
      technologyRefs: [],
    }],
  });
  state = executeV23DomainAction(
    state,
    current.revision,
    "create_series",
    seriesPayload,
  ).state;
  const skuPayload = commandPayload(current.revision, {
    skuId: "sku:v23-quality-api",
    partId: "part:v23-quality-api:rod",
    expectedPartRevision: 1,
    weightBandId: key.weightBandId,
    displayOrder: 0,
  });
  state = executeV23DomainAction(
    state,
    current.revision,
    "create_sku",
    skuPayload,
  ).state;
  const saved = await saveWorkspaceState({
    state,
    baseRevision: current.revision,
    author: "route-test",
    message: "prepare set_sku_actual_quality API fixture",
  });
  assert.equal(saved.conflict, undefined);
  return loadWorkspaceState();
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-v23-actions-"));
  databasePath = path.join(root, "workspace.sqlite");
  process.env.WORKSPACE_DATABASE_PATH = databasePath;
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "v23-route-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
});

after(async () => {
  await closeSqliteStorage(databasePath);
  await rm(root, { recursive: true, force: true });
  if (previousDatabasePath === undefined) delete process.env.WORKSPACE_DATABASE_PATH;
  else process.env.WORKSPACE_DATABASE_PATH = previousDatabasePath;
});

test("v23 write requires issued command and replay returns the one atomic result", { concurrency: false }, async () => {
  const current = await loadWorkspaceState();
  const unsigned = {
    expectedWorkspaceRevision: current.revision,
    seriesId: "series:v23-api",
    collectionId: null,
    name: "V23 API",
    concept: "Command boundary",
    parts: [{
      partId: "part:v23-api:rod",
      partType: "rod",
      fishingMethodId: "method:lure",
      materialTypeId: "material:carbon",
      functionProfileId: "function:cast",
      functionIntensity: 2,
      weightBandIds: ["band:light"],
      defaultEntryRefs: [],
      technologyRefs: [],
    }],
  };
  const payload = { ...unsigned, inputHash: v23ActionInputHash(unsigned) };
  const issuedResponse = await issueActionCommand(new NextRequest(
    "http://localhost/api/action-commands",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: "create_series",
        idempotencyKey: "v23-api-create-series",
        payload,
      }),
    },
  ));
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const invocation = {
    actionId: issued.actionId,
    payloadRefId: issued.commandPayloadRef.payloadRefId,
  };
  const first = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(invocation),
  }));
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { replayed?: boolean; revision?: number };
  assert.equal(firstBody.replayed, false);

  const replay = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(invocation),
  }));
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { replayed?: boolean; revision?: number };
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.revision, firstBody.revision);

  const readback = await loadWorkspaceState();
  assert.equal(
    readback.state.seriesDefinitions.filter((entry) => entry.id === "series:v23-api").length,
    1,
  );
  assert.deepEqual(
    readback.state.v23SeriesPartHeads.filter((entry) => entry.seriesId === "series:v23-api"),
    [{ seriesId: "series:v23-api", partId: "part:v23-api:rod", revision: 1 }],
  );
});

test("v23 preview is authenticated read-only and direct write payload is rejected", { concurrency: false }, async () => {
  const before = await loadWorkspaceState();
  const preview = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      action: "preview_weight_band_skus",
      payload: {
        partId: "part:v23-api:rod",
        expectedPartRevision: 1,
        weightBandId: "band:light",
      },
    }),
  }));
  assert.equal(preview.status, 200);
  const afterPreview = await loadWorkspaceState();
  assert.equal(afterPreview.revision, before.revision);
  for (const extra of [
    { unexpected: true },
    { actionId: "action:forged" },
    { payloadRefId: "payload:forged" },
  ]) {
    const rejected = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: "preview_weight_band_skus",
        payload: {
          partId: "part:v23-api:rod",
          expectedPartRevision: 1,
          weightBandId: "band:light",
        },
        ...extra,
      }),
    }));
    assert.equal(rejected.status, 400);
    assert.equal((await loadWorkspaceState()).revision, before.revision);
  }

  const bypass = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      action: "create_sku",
      payload: {
        skuId: "sku:bypass",
        partId: "part:v23-api:rod",
      },
    }),
  }));
  assert.equal(bypass.status, 422);
  assert.equal(
    ((await bypass.json()) as { code?: string }).code,
    "ACTION_COMMAND_PAYLOAD_REQUIRED",
  );
  assert.equal((await loadWorkspaceState()).revision, before.revision);
});

test("Technology write uses the issued command, atomic save, replay and readback boundary", { concurrency: false }, async () => {
  const current = await loadWorkspaceState();
  const affixId = "affix:v23-technology-api";
  const affixPayload = {
    name: "Technology API member",
    category: "attribute",
    itemPartId: "part:rod",
    semanticContributionKey: "technology-api",
    stackingPolicy: "dedupe",
    generationPolicy: "technology_only",
    rarity: "common",
    valueScore: 1,
    tags: [],
    description: "Technology API fixture",
    enabled: true,
    operations: [{
      operationId: "operation:v23-technology-api",
      operationIndex: 0,
      sourceAffixId: affixId,
      sourceAffixRevision: 1,
      parameterKey: "pull",
      operation: "set",
      value: 5,
    }],
    passivePayload: null,
  };
  const withAffix = executeV23DomainAction(
    current.state,
    current.revision,
    "create_project_affix",
    commandPayload(current.revision, { affixId, affixPayload }),
  ).state;
  const saved = await saveWorkspaceState({
    state: withAffix,
    baseRevision: current.revision,
    author: "route-test",
    message: "prepare Technology API member",
  });
  assert.equal(saved.conflict, undefined);
  const prepared = await loadWorkspaceState();
  const member = prepared.state.v23AffixDefinitions.find((entry) => entry.affixId === affixId)!;
  const payload = commandPayload(prepared.revision, {
    technologyId: "technology:v23-api",
    itemPartId: "part:rod",
    name: "Technology API",
    description: "",
    memberAffixRefs: [{
      id: member.affixId,
      revision: member.revision,
      contentHash: member.contentHash,
    }],
    enabled: true,
  });
  const issuedResponse = await issueCommand(
    "create_technology",
    "v23-api-create-technology",
    payload,
  );
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const invocation = {
    actionId: issued.actionId,
    payloadRefId: issued.commandPayloadRef.payloadRefId,
  };
  const first = await invokeCommand(invocation);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { replayed?: boolean }).replayed, false);
  const readback = await loadWorkspaceState();
  assert.deepEqual(readback.state.v23TechnologyHeads, [{
    technologyId: "technology:v23-api",
    revision: 1,
  }]);
  assert.equal(readback.state.v23TechnologyDefinitions.length, 1);
  const replay = await invokeCommand(invocation);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { replayed?: boolean }).replayed, true);
  assert.equal((await loadWorkspaceState()).revision, readback.revision);
});

test("set_sku_actual_quality enforces authorization, concurrency, idempotency, recovery, and readback", { concurrency: false }, async () => {
  let current = await prepareAssessedSku();
  const initialRevision = current.revision;
  const skuId = "sku:v23-quality-api";
  const initialHead = current.state.v23SkuDrawerHeads.find((entry) => entry.skuId === skuId);
  assert.equal(initialHead?.revision, 1);

  const unauthenticated = await v23Actions(new NextRequest(
    "http://localhost/api/v23/actions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: "action:unauthenticated", payloadRefId: "payload:unauthenticated" }),
    },
  ));
  assert.equal(unauthenticated.status, 401);
  assert.equal((await loadWorkspaceState()).revision, initialRevision);

  const capabilityPayload = commandPayload(current.revision, {
    skuId,
    expectedSkuRevision: 1,
    selectedQualityId: "quality_b_blue",
    reason: "API capability boundary",
  });
  const capabilityIssuedResponse = await issueQualityCommand(
    "v23-api-quality-capability-change",
    capabilityPayload,
  );
  assert.equal(capabilityIssuedResponse.status, 200);
  const capabilityIssued = await capabilityIssuedResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const mutableCapabilities = PHASE_ONE_CAPABILITIES as unknown as string[];
  const skuEditIndex = mutableCapabilities.indexOf("sku.edit");
  assert.notEqual(skuEditIndex, -1);
  mutableCapabilities.splice(skuEditIndex, 1);
  try {
    const denied = await invokeCommand({
      actionId: capabilityIssued.actionId,
      payloadRefId: capabilityIssued.commandPayloadRef.payloadRefId,
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code?: string }).code, "ACTION_COMMAND_CAPABILITY_CHANGED");
  } finally {
    mutableCapabilities.splice(skuEditIndex, 0, "sku.edit");
  }
  assert.equal((await loadWorkspaceState()).revision, initialRevision);

  const staleSkuResponse = await issueQualityCommand(
    "v23-api-quality-stale-sku",
    commandPayload(current.revision, {
      skuId,
      expectedSkuRevision: 999,
      selectedQualityId: "quality_b_blue",
      reason: "stale SKU",
    }),
  );
  assert.equal(staleSkuResponse.status, 200);
  const staleSku = await staleSkuResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const staleSkuInvocation = await invokeCommand({
    actionId: staleSku.actionId,
    payloadRefId: staleSku.commandPayloadRef.payloadRefId,
  });
  assert.equal(staleSkuInvocation.status, 409);
  assert.equal(
    (await staleSkuInvocation.json() as { code?: string }).code,
    "V23_ENTITY_REVISION_CONFLICT",
  );
  assert.equal((await loadWorkspaceState()).revision, initialRevision);

  const staleWorkspaceResponse = await issueQualityCommand(
    "v23-api-quality-stale-workspace",
    commandPayload(current.revision, {
      skuId,
      expectedSkuRevision: 1,
      selectedQualityId: "quality_b_blue",
      reason: "stale workspace",
    }),
  );
  assert.equal(staleWorkspaceResponse.status, 200);
  const staleWorkspace = await staleWorkspaceResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const revisionBump = await saveWorkspaceState({
    state: current.state,
    baseRevision: current.revision,
    author: "route-test",
    message: "advance workspace revision for stale command coverage",
  });
  assert.equal(revisionBump.conflict, undefined);
  const staleWorkspaceInvocation = await invokeCommand({
    actionId: staleWorkspace.actionId,
    payloadRefId: staleWorkspace.commandPayloadRef.payloadRefId,
  });
  assert.equal(staleWorkspaceInvocation.status, 409);
  assert.equal(
    (await staleWorkspaceInvocation.json() as { code?: string }).code,
    "ACTION_COMMAND_REVISION_CONFLICT",
  );

  current = await loadWorkspaceState();
  const idempotencyPayload = commandPayload(current.revision, {
    skuId,
    expectedSkuRevision: 1,
    selectedQualityId: "quality_b_blue",
    reason: "first idempotent payload",
  });
  const firstIdempotent = await issueQualityCommand(
    "v23-api-quality-idempotency-conflict",
    idempotencyPayload,
  );
  assert.equal(firstIdempotent.status, 200);
  const idempotencyConflict = await issueQualityCommand(
    "v23-api-quality-idempotency-conflict",
    commandPayload(current.revision, {
      skuId,
      expectedSkuRevision: 1,
      selectedQualityId: "quality_b_blue",
      reason: "different payload with same key",
    }),
  );
  assert.equal(idempotencyConflict.status, 409);
  assert.equal(
    (await idempotencyConflict.json() as { code?: string }).code,
    "IDEMPOTENCY_KEY_REUSED",
  );

  const staleFenceResponse = await issueQualityCommand(
    "v23-api-quality-stale-fence",
    commandPayload(current.revision, {
      skuId,
      expectedSkuRevision: 1,
      selectedQualityId: "quality_b_blue",
      reason: "superseded fencing token",
    }),
  );
  assert.equal(staleFenceResponse.status, 200);
  const staleFence = await staleFenceResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const winningResponse = await issueQualityCommand(
    "v23-api-quality-success",
    commandPayload(current.revision, {
      skuId,
      expectedSkuRevision: 1,
      selectedQualityId: "quality_b_blue",
      reason: "explicit API override",
    }),
  );
  assert.equal(winningResponse.status, 200);
  const winning = await winningResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const staleFenceInvocation = await invokeCommand({
    actionId: staleFence.actionId,
    payloadRefId: staleFence.commandPayloadRef.payloadRefId,
  });
  assert.equal(staleFenceInvocation.status, 409);
  assert.equal(
    (await staleFenceInvocation.json() as { code?: string }).code,
    "STALE_FENCING_TOKEN",
  );

  const invocation = {
    actionId: winning.actionId,
    payloadRefId: winning.commandPayloadRef.payloadRefId,
  };
  const first = await invokeCommand(invocation);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as {
    replayed?: boolean;
    revision?: number;
    skuId?: string;
    skuRevision?: number;
  };
  assert.equal(firstBody.replayed, false);
  assert.equal(firstBody.skuId, skuId);
  assert.equal(firstBody.skuRevision, 2);
  const afterSuccess = await loadWorkspaceState();
  assert.equal(afterSuccess.revision, firstBody.revision);
  assert.deepEqual(
    afterSuccess.state.v23SkuDrawerHeads.find((entry) => entry.skuId === skuId),
    { skuId, revision: 2 },
  );
  const qualityAfterSuccess = afterSuccess.state.v23SkuDrawerRevisions.find(
    (entry) => entry.skuId === skuId && entry.revision === 2,
  )?.quality;
  assert.equal(qualityAfterSuccess?.status, "ASSESSED");
  if (qualityAfterSuccess?.status !== "ASSESSED") {
    assert.fail("set_sku_actual_quality must persist an assessed result");
  }
  assert.equal(qualityAfterSuccess.assessment.selectedQualityId, "quality_b_blue");
  assert.equal(qualityAfterSuccess.assessment.qualityOverrideReason, "explicit API override");

  const replay = await invokeCommand(invocation);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as {
    replayed?: boolean;
    revision?: number;
    skuRevision?: number;
  };
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.revision, firstBody.revision);
  assert.equal(replayBody.skuRevision, firstBody.skuRevision);
  assert.equal((await loadWorkspaceState()).revision, afterSuccess.revision);

  const recoveryResponse = await issueQualityCommand(
    "v23-api-quality-persistence-recovery",
    commandPayload(afterSuccess.revision, {
      skuId,
      expectedSkuRevision: 2,
      selectedQualityId: "quality_c_green",
      reason: null,
    }),
  );
  assert.equal(recoveryResponse.status, 200);
  const recovery = await recoveryResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const recoveryInvocation = {
    actionId: recovery.actionId,
    payloadRefId: recovery.commandPayloadRef.payloadRefId,
  };
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TRIGGER force_workspace_save_failure
      BEFORE UPDATE ON workspace_state
      BEGIN
        SELECT RAISE(ABORT, 'forced workspace save failure');
      END;
    `);
    await assert.rejects(
      invokeCommand(recoveryInvocation),
      /forced workspace save failure/u,
    );
  } finally {
    database.exec("DROP TRIGGER IF EXISTS force_workspace_save_failure;");
    database.close();
  }
  const afterFailure = await loadWorkspaceState();
  assert.equal(afterFailure.revision, afterSuccess.revision);
  assert.deepEqual(
    afterFailure.state.v23SkuDrawerHeads.find((entry) => entry.skuId === skuId),
    { skuId, revision: 2 },
  );

  const recovered = await invokeCommand(recoveryInvocation);
  assert.equal(recovered.status, 200);
  const recoveredBody = await recovered.json() as {
    replayed?: boolean;
    revision?: number;
    skuRevision?: number;
  };
  assert.equal(recoveredBody.replayed, false);
  assert.equal(recoveredBody.skuRevision, 3);
  const recoveryReadback = await loadWorkspaceState();
  assert.equal(recoveryReadback.revision, recoveredBody.revision);
  assert.deepEqual(
    recoveryReadback.state.v23SkuDrawerHeads.find((entry) => entry.skuId === skuId),
    { skuId, revision: 3 },
  );
});
