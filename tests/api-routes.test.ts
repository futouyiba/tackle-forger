import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { PUT as putState, saveWorkspaceForbiddenResponse } from "../app/api/state/route";
import { POST as issueActionCommand } from "../app/api/action-commands/route";
import { POST as accessDataSources } from "../app/api/data-sources/route";
import { POST as mutateWorkbook } from "../app/api/feishu-workbook/route";
import { POST as importFile } from "../app/api/import-file/route";
import { POST as createSeries } from "../app/api/series/route";
import { POST as assessWithAI } from "../app/api/ai/assessments/route";
import { POST as changeSkuTargetPull } from "../app/api/skus/target-pull/route";
import { POST as previewSkuTargetPull } from "../app/api/skus/target-pull/preview/route";
import {
  resolvePartConstraintSourceRevision,
  resolvePartConstraintSetRef,
} from "../lib/part-constraints";
import { loadWorkspaceState, saveWorkspaceState } from "../lib/storage";
import { closeSqliteStorage } from "../lib/sqlite-storage";
import { CANONICAL_FEISHU_SHEET_REGISTRY, CANONICAL_FEISHU_WORKBOOK } from "../lib/feishu-workbook";
import { setCanonicalRuleWorkbookInspectionForTests, weightTemplateDraftFromCanonicalRuleDraft } from "../lib/rule-workbook-inspection";
import { deterministicHash } from "../lib/rule-kernel";

const authHeaders = {
  "content-type": "application/json",
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "route-tester",
  "x-feishu-display-name": "route-tester",
  "x-tf-proxy-secret": "route-test-secret",
};

let databaseDirectory = "";
let databasePath = "";
const originalDatabasePath = process.env.WORKSPACE_DATABASE_PATH;

before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-api-routes-"));
  databasePath = path.join(databaseDirectory, "workspace.sqlite");
  process.env.WORKSPACE_DATABASE_PATH = databasePath;
});

after(async () => {
  await closeSqliteStorage(databasePath);
  await rm(databaseDirectory, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.WORKSPACE_DATABASE_PATH;
  else process.env.WORKSPACE_DATABASE_PATH = originalDatabasePath;
});

function withTrustedProxy() {
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "route-test-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
}

function routeAIConfiguration(dataDir: string) {
  return {
    FANCY_HUB_ENABLED: "true",
    FANCY_HUB_BASE_URL: "https://fancy-hub.invalid/",
    FANCY_HUB_API_TOKEN: "route-ai-token",
    FANCY_HUB_PRIMARY_MODEL_ID: "model.alpha",
    FANCY_HUB_PROVIDER_MAX_INPUT_TOKENS: "50000",
    FANCY_HUB_PROVIDER_MAX_OUTPUT_TOKENS: "8000",
    FANCY_HUB_PROVIDER_MAX_CONCURRENT_REQUESTS: "4",
    FANCY_HUB_PROVIDER_MAX_REQUESTS_PER_MINUTE: "60",
    FANCY_HUB_PROVIDER_REQUEST_TIMEOUT_MS: "30000",
    FANCY_HUB_PROVIDER_MAX_COST_MICRO_USD_PER_REQUEST: "200000",
    FANCY_HUB_TENANT_MAX_INPUT_TOKENS: "50000",
    FANCY_HUB_TENANT_MAX_OUTPUT_TOKENS: "8000",
    FANCY_HUB_TENANT_MAX_CONCURRENT_REQUESTS: "4",
    FANCY_HUB_TENANT_MAX_REQUESTS_PER_MINUTE: "60",
    FANCY_HUB_REQUEST_TIMEOUT_MS: "30000",
    FANCY_HUB_TENANT_MAX_COST_MICRO_USD_PER_REQUEST: "200000",
    FANCY_HUB_ASSESSMENT_MAX_OUTPUT_TOKENS: "1000",
    FANCY_HUB_MAX_INPUT_COST_MICRO_USD_PER_1K_TOKENS: "1000",
    FANCY_HUB_MAX_OUTPUT_COST_MICRO_USD_PER_1K_TOKENS: "1000",
    AI_RETENTION_DATA_DIR: dataDir,
    AI_RETENTION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
    AI_RETENTION_ENCRYPTION_KEY_VERSION: "route-test-v1",
  } as const;
}

test("action-command 路由保留坏行重量草稿，并在发布路由明确阻断", { concurrency: false }, async () => {
  withTrustedProxy();
  const beforeState = await loadWorkspaceState();
  const sourceRevision = {
    id: "feishu-revision:route-bad-weight", workbookRefId: CANONICAL_FEISHU_WORKBOOK.id, sourceRevision: "route-bad-weight", spreadsheetToken: "route-sheet", pulledAt: "2026-07-24T00:00:00.000Z", pulledBy: "route-tester", syncScope: "workbook" as const, registryHash: "route", sheets: CANONICAL_FEISHU_SHEET_REGISTRY.map((sheet) => ({ sheetId: sheet.sheetId, name: sheet.expectedName, rowCount: sheet.sheetId === "d6e928" ? 66 : 100, columnCount: sheet.sheetId === "d6e928" ? 60 : 60 })), issues: [], state: "PULLED" as const,
  };
  const content = { parameters: beforeState.state.parameters, templates: [...beforeState.state.templates, { ...beforeState.state.templates[0]!, id: "wtpl_route_valid", sourceRow: 2 }], methodProfiles: beforeState.state.methodProfiles, itemTypeProfiles: beforeState.state.itemTypeProfiles, functionProfiles: beforeState.state.functionProfiles, modifiers: beforeState.state.modifiers, layers: beforeState.state.layers };
  const canonicalRuleDraft = { id: "canonical-route-bad-weight", sourceRevisionId: sourceRevision.id, sourceRevision: sourceRevision.sourceRevision, contentHash: deterministicHash(content), importedAt: sourceRevision.pulledAt, ...content, issues: [{ level: "error" as const, code: "WEIGHT_TEMPLATE_ID_MISSING", message: "缺少机器 ID", sheetId: "d6e928", row: 3 }] };
  const weightValues = [["机器ID（勿改）", "重量段", "最小拉力", "最大拉力"], ["wtpl_route_valid", "轻", 1, 2], ["", "中", "", 3]];
  const weightTemplateDraft = weightTemplateDraftFromCanonicalRuleDraft({ sourceRevision, canonicalRuleDraft, weightValues, importedAt: sourceRevision.pulledAt });
  setCanonicalRuleWorkbookInspectionForTests(async () => ({ observedAt: sourceRevision.pulledAt, sourceRevision, identityRows: [], identityReport: { reportId: "identity-route-bad-weight", workbookRefId: sourceRevision.workbookRefId, sourceRevision: sourceRevision.sourceRevision, mode: "CONTINUOUS_SYNC", generatedAt: sourceRevision.pulledAt, items: [], blockingIssueCodes: [], inputHash: "identity" }, canonicalRuleDraft, weightTemplateDraft, qualityDraft: { id: "quality-route", sourceRevisionId: sourceRevision.id, sourceRevision: sourceRevision.sourceRevision, qualitySheetId: "FqD4j7", affixSheetId: "zrVOxd", ranges: [], combinationRules: [], issues: [], formalStatus: "NON_FORMAL", inputHash: "quality", importedAt: sourceRevision.pulledAt }, pricingDraft: { id: "pricing-route", sourceRevisionId: sourceRevision.id, sourceRevision: sourceRevision.sourceRevision, pricingSheetId: "u87sRh", qualitySheetId: "FqD4j7", typeMaterialSheetId: "fATowU", pricingBaskets: [], maintenanceConsumptionRates: [], partAllocationRatios: [], repairCoefficients: [], totalLossTimes: [], purchaseCoefficients: [], partsToWholeRatios: [], qualityMappings: [], qualityPriceFactorRanges: [], issues: [], formalStatus: "NON_FORMAL", inputHash: "pricing", importedAt: sourceRevision.pulledAt }, pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND" } as never));
  try {
    const pull = await issueAndInvoke({ action: "pull_feishu_workbook", url: "http://localhost/api/feishu-workbook", method: "POST", invoke: mutateWorkbook, payload: { action: "pull", baseRevision: beforeState.revision } });
    assert.equal(pull.status, 200);
    const pulled = await pull.json() as { state: typeof beforeState.state; revision: number };
    assert.equal(pulled.state.weightTemplatePolicyDrafts[0]?.formalStatus, "NON_FORMAL");
    assert.ok(pulled.state.weightTemplatePolicyDrafts[0]?.issues.some((issue) => issue.code === "WEIGHT_TEMPLATE_ID_MISSING"));
    const draft = await issueAndInvoke({ action: "create_ruleset_draft", url: "http://localhost/api/feishu-workbook", method: "POST", invoke: mutateWorkbook, payload: { action: "create_ruleset_draft", baseRevision: pulled.revision, sourceRevisionId: sourceRevision.id } });
    assert.equal(draft.status, 200);
    const drafted = await draft.json() as { revision: number; ruleSetDraft: { id: string } };
    const publish = await issueAndInvoke({ action: "publish_ruleset", url: "http://localhost/api/feishu-workbook", method: "POST", invoke: mutateWorkbook, payload: { action: "publish_ruleset", baseRevision: drafted.revision, ruleSetDraftId: drafted.ruleSetDraft.id } });
    assert.equal(publish.status, 422);
    assert.match((await publish.json() as { error: string }).error, /重量模板源草稿存在阻断错误/);
  } finally {
    setCanonicalRuleWorkbookInspectionForTests();
  }
});

async function issueAndInvoke(input: {
  action:
    | "save_workspace"
    | "create_series"
    | "change_sku_target_pull"
    | "publish_data_source"
    | "commit_data_source_writeback"
    | "pull_feishu_workbook"
    | "create_ruleset_draft"
    | "publish_ruleset";
  url: string;
  method: "POST" | "PUT";
  payload: Record<string, unknown>;
  invoke: (request: NextRequest) => Promise<Response>;
  idempotencyKey?: string;
}) {
  const idempotencyKey = input.idempotencyKey
    ?? (typeof input.payload.idempotencyKey === "string"
      ? input.payload.idempotencyKey
      : `route-command:${crypto.randomUUID()}`);
  const issuedResponse = await issueActionCommand(new NextRequest(
    "http://localhost/api/action-commands",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: input.action,
        idempotencyKey,
        payload: input.payload,
      }),
    },
  ));
  if (!issuedResponse.ok) return issuedResponse;
  const issued = await issuedResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  return input.invoke(new NextRequest(input.url, {
    method: input.method,
    headers: authHeaders,
    body: JSON.stringify({
      actionId: issued.actionId,
      payloadRefId: issued.commandPayloadRef.payloadRefId,
    }),
  }));
}

test("已认证整包 PUT 不能绕过 Series 领域命令", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const state = structuredClone(current.state);
  state.seriesDefinitions.push({ ...state.seriesDefinitions[0]!, id: "series:put-bypass" });
  const response = await issueAndInvoke({
    action: "save_workspace",
    url: "http://localhost/api/state",
    method: "PUT",
    payload: { state, baseRevision: current.revision },
    invoke: putState,
  });
  assert.equal(response.status, 422);
  const payload = await response.json() as { code?: string; governedChanges?: string[] };
  assert.equal(payload.code, "DOMAIN_COMMAND_REQUIRED");
  assert.deepEqual(payload.governedChanges, ["seriesDefinitions"]);
});

test("save_workspace capability 禁用时返回403且不触发任何保存", { concurrency: false }, async () => {
  const current = await loadWorkspaceState();
  const forbidden = saveWorkspaceForbiddenResponse({
    enabled: false,
    disabledReasonText: "缺少 workspace.save Capability。",
  });
  assert.equal(forbidden?.status, 403);
  assert.equal(forbidden?.body.error, "缺少 workspace.save Capability。");
  const after = await loadWorkspaceState();
  assert.equal(after.revision, current.revision);
  assert.deepEqual(after.state, current.state);
});

test("整包 PUT 拒绝修改只读历史并保留 payload 与 Trace", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const before = structuredClone({
    recipes: current.state.recipes,
    candidates: current.state.candidates,
    officialSkus: current.state.officialSkus,
    detailOverrides: current.state.detailOverrides,
  });
  const state = structuredClone(current.state);
  state.recipes[0] = { ...state.recipes[0]!, name: "越权修改旧配方" };
  state.candidates[0]!.calculated.trace.push({ source: "越权改写 Trace" } as never);

  const response = await issueAndInvoke({
    action: "save_workspace",
    url: "http://localhost/api/state",
    method: "PUT",
    payload: { state, baseRevision: current.revision },
    invoke: putState,
  });
  assert.equal(response.status, 422);
  const payload = await response.json() as {
    code?: string;
    governedChanges?: string[];
    legacyHistoryChanges?: string[];
  };
  assert.equal(payload.code, "LEGACY_HISTORY_READ_ONLY");
  assert.deepEqual(payload.governedChanges, ["recipes", "candidates"]);
  assert.deepEqual(payload.legacyHistoryChanges, ["recipes", "candidates"]);

  const after = await loadWorkspaceState();
  assert.deepEqual({
    recipes: after.state.recipes,
    candidates: after.state.candidates,
    officialSkus: after.state.officialSkus,
    detailOverrides: after.state.detailOverrides,
  }, before);
});

test("整包 PUT 允许常规工作台字段(templates)编辑保存", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const state = structuredClone(current.state);
  const sample = state.templates[0] ?? { id: "t", name: "", values: {} };
  const probeId = "template:put-allowed-probe";
  state.templates = [...state.templates, { ...sample, id: probeId, name: "PUT 允许测试" }];
  const response = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state, baseRevision: current.revision, message: "测试:加重量段" }, invoke: putState,
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as { revision: number };
  const after = await loadWorkspaceState();
  assert.ok(after.state.templates.some((entry) => entry.id === probeId), "重量段应已保存");
  const restored = structuredClone(after.state);
  restored.templates = restored.templates.filter((entry) => entry.id !== probeId);
  await saveWorkspaceState({
    state: restored,
    baseRevision: payload.revision,
    author: "route-test-cleanup",
    message: "清理 PUT 允许测试",
  });
});

test("整包 PUT 默认保存多个普通字段和未来字段，并在混合治理改动时原子拒绝", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const state = structuredClone(current.state) as typeof current.state & Record<string, unknown>;
  const probeId = "template:multi-field-probe";
  const sample = state.templates[0] ?? { id: "t", name: "", values: {} };
  state.templates = [...state.templates, { ...sample, id: probeId, name: "多字段保存" }];
  state.notes = "ordinary notes persist";
  state.compatibilityRules = [];
  state.futureWorkspaceField = { nested: { preserved: true } };
  const allowed = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state, baseRevision: current.revision, message: "测试多普通字段" }, invoke: putState,
  });
  assert.equal(allowed.status, 200);
  const allowedPayload = await allowed.json() as { revision: number };
  const afterAllowed = await loadWorkspaceState();
  assert.equal(afterAllowed.state.notes, "ordinary notes persist");
  assert.ok(afterAllowed.state.templates.some((entry) => entry.id === probeId));
  assert.deepEqual((afterAllowed.state as unknown as Record<string, unknown>).futureWorkspaceField, { nested: { preserved: true } });

  const mixed = structuredClone(afterAllowed.state);
  mixed.notes = "must not partially save";
  mixed.seriesDefinitions.push({ ...mixed.seriesDefinitions[0]!, id: "series:atomic-probe" });
  const beforeMixed = structuredClone(afterAllowed.state);
  const rejected = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state: mixed, baseRevision: allowedPayload.revision }, invoke: putState,
  });
  assert.equal(rejected.status, 422);
  const rejection = await rejected.json() as {
    code?: string; governedChanges?: string[];
    governedFields?: Array<{ field: string; action: string; actionLabel: string; reason: string }>;
  };
  assert.equal(rejection.code, "DOMAIN_COMMAND_REQUIRED");
  assert.deepEqual(rejection.governedChanges, ["seriesDefinitions"]);
  assert.deepEqual(rejection.governedFields?.[0], {
    field: "seriesDefinitions", reason: "domain_command",
    action: "POST /api/series（create_series）", actionLabel: "使用创建 Series",
  });
  const afterRejected = await loadWorkspaceState();
  assert.equal(afterRejected.revision, allowedPayload.revision, "拒绝不得创建 partial revision");
  assert.deepEqual(afterRejected.state.notes, beforeMixed.notes, "普通字段也不得部分保存");
  assert.equal(afterRejected.state.governanceAuditLog.length, beforeMixed.governanceAuditLog.length);
  assert.equal(afterRejected.state.commandIdempotencyRecords.length, beforeMixed.commandIdempotencyRecords.length);
});

test("整包 PUT 拒绝嵌套约束、Recipe 与迁移复核证据，且混合请求无副作用", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const state = structuredClone(current.state);
  state.templates[0]!.notes = "must not partially save";
  state.partConstraintSets = [...state.partConstraintSets, { nested: { changed: true } } as never];
  state.candidateSearchRecipes = [...state.candidateSearchRecipes, { nested: { changed: true } } as never];
  state.migrationReviewItems = [...state.migrationReviewItems, { nested: { changed: true } } as never];
  const before = structuredClone(current.state);
  const rejected = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state, baseRevision: current.revision }, invoke: putState,
  });
  assert.equal(rejected.status, 422);
  const body = await rejected.json() as { governedChanges?: string[]; governedFields?: Array<{ action: string }> };
  assert.deepEqual(body.governedChanges, ["partConstraintSets", "candidateSearchRecipes", "migrationReviewItems"]);
  assert.match(body.governedFields?.[0]?.action ?? "", /只读/);
  const after = await loadWorkspaceState();
  assert.equal(after.revision, current.revision);
  assert.deepEqual(after.state.templates, before.templates);
  assert.deepEqual(after.state.migrationReviewItems, before.migrationReviewItems);
});

test("整包 PUT 保留 revision 冲突、授权与已发布 Snapshot 冻结", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const stale = structuredClone(current.state);
  stale.notes = "stale save";
  const advanced = structuredClone(current.state);
  advanced.notes = "advance revision";
  const advancedSave = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state: advanced, baseRevision: current.revision }, invoke: putState,
  });
  assert.equal(advancedSave.status, 200);
  const staleSave = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state: stale, baseRevision: current.revision }, invoke: putState,
  });
  assert.equal(staleSave.status, 409);

  const latest = await loadWorkspaceState();
  const frozen = structuredClone(latest.state);
  frozen.configurationSnapshots.push({ id: "snapshot:put-bypass" } as never);
  const frozenSave = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state: frozen, baseRevision: latest.revision }, invoke: putState,
  });
  assert.equal(frozenSave.status, 422);
  const frozenPayload = await frozenSave.json() as { governedFields?: Array<{ field: string; action: string }> };
  assert.equal(frozenPayload.governedFields?.[0]?.field, "configurationSnapshots");

  const configGovernance = structuredClone(latest.state);
  configGovernance.configIdGovernance = {
    ...configGovernance.configIdGovernance,
    auditLog: [...configGovernance.configIdGovernance.auditLog, { forged: true } as never],
  };
  const governanceSave = await issueAndInvoke({
    action: "save_workspace", url: "http://localhost/api/state", method: "PUT",
    payload: { state: configGovernance, baseRevision: latest.revision }, invoke: putState,
  });
  assert.equal(governanceSave.status, 422);
  const governancePayload = await governanceSave.json() as {
    governedFields?: Array<{ field: string; reason: string; action: string; actionLabel: string; route?: string }>;
  };
  assert.deepEqual(governancePayload.governedFields?.[0], {
    field: "configIdGovernance", reason: "audit_or_reserved_identity",
    action: "config.id.* ActionCode", actionLabel: "使用配置身份预留、导入或策略发布动作",
    route: "/api/action-commands",
  });

  const unauthenticated = await putState(new NextRequest("http://localhost/api/state", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: latest.state, baseRevision: latest.revision }),
  }));
  assert.equal(unauthenticated.status, 401);
});

test("数据源发布更新规则但不重算或改写四组历史产品数据", { concurrency: false }, async () => {
  withTrustedProxy();
  const originalFeishuAppId = process.env.FEISHU_APP_ID;
  const originalFeishuAppSecret = process.env.FEISHU_APP_SECRET;
  process.env.FEISHU_APP_ID = "route-test-app";
  process.env.FEISHU_APP_SECRET = "route-test-secret";
  const originalFetch = globalThis.fetch;
  let restore: { state: Awaited<ReturnType<typeof loadWorkspaceState>>["state"]; baseRevision: number } | undefined;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("tenant_access_token")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        tenant_access_token: "route-test-token",
        expire: 7200,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/records?")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          items: [{
            record_id: "route-template-1",
            fields: {
              模板ID: "T01",
              名称: "数据源路由只读历史验证",
              鱼重下限kg: 0.5,
              鱼重上限kg: 2,
              标称鱼重kg: 1,
              档位: "轻量",
            },
          }],
          has_more: false,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected test fetch: ${url}`);
  };

  try {
    const current = await loadWorkspaceState();
    const historyBefore = structuredClone({
      recipes: current.state.recipes,
      candidates: current.state.candidates,
      officialSkus: current.state.officialSkus,
      detailOverrides: current.state.detailOverrides,
    });
    const source = {
      ...current.state.dataSources[0]!,
      appToken: "route-test-app-token",
      tableId: "route-test-table",
      viewId: "",
      shareUrl: "https://example.feishu.cn/base/route-test-app-token",
      enabled: true,
    };
    const previewResponse = await accessDataSources(new NextRequest("http://localhost/api/data-sources", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action: "preview", source }),
    }));
    assert.equal(previewResponse.status, 200);
    const previewPayload = await previewResponse.json() as {
      preview: { checksum: string; sourceFingerprint: string };
    };

    const publishResponse = await issueAndInvoke({
      action: "publish_data_source",
      url: "http://localhost/api/data-sources",
      method: "POST",
      invoke: accessDataSources,
      idempotencyKey: `publish-data-source:${current.revision}:${previewPayload.preview.checksum}`,
      payload: {
        action: "publish",
        source,
        baseRevision: current.revision,
        checksum: previewPayload.preview.checksum,
        sourceFingerprint: previewPayload.preview.sourceFingerprint,
      },
    });
    assert.equal(publishResponse.status, 200);
    const after = await loadWorkspaceState();
    restore = { state: current.state, baseRevision: after.revision };
    assert.equal(after.state.templates[0]?.name, "数据源路由只读历史验证");
    assert.deepEqual({
      recipes: after.state.recipes,
      candidates: after.state.candidates,
      officialSkus: after.state.officialSkus,
      detailOverrides: after.state.detailOverrides,
    }, historyBefore);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFeishuAppId === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = originalFeishuAppId;
    if (originalFeishuAppSecret === undefined) delete process.env.FEISHU_APP_SECRET;
    else process.env.FEISHU_APP_SECRET = originalFeishuAppSecret;
    if (restore) {
      await saveWorkspaceState({
        state: restore.state,
        baseRevision: restore.baseRevision,
        author: "route-test-cleanup",
        message: "恢复数据源路由测试基线",
      });
    }
  }
});

test("整包 PUT 的畸形 JSON 与缺 payload ref 都 fail-closed", { concurrency: false }, async () => {
  withTrustedProxy();
  const response = await putState(new NextRequest("http://localhost/api/state", {
    method: "PUT", headers: authHeaders, body: "{",
  }));
  assert.equal(response.status, 422);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "ACTION_COMMAND_PAYLOAD_REQUIRED",
  );
});

test("三条生产写路由拒绝客户端直传业务载荷且不产生 revision", { concurrency: false }, async () => {
  withTrustedProxy();
  const before = await loadWorkspaceState();
  const rawRequests = [
    putState(new NextRequest("http://localhost/api/state", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        state: { ...before.state, notes: "不得直接写入" },
        baseRevision: before.revision,
      }),
    })),
    createSeries(new NextRequest("http://localhost/api/series", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        idempotencyKey: "raw-create-series",
        seriesId: "series:raw-bypass",
      }),
    })),
    changeSkuTargetPull(new NextRequest("http://localhost/api/skus/target-pull", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        skuId: before.state.skuDrawers[0]?.id,
        targetPullKg: 999,
      }),
    })),
  ];
  const responses = await Promise.all(rawRequests);
  for (const response of responses) {
    assert.equal(response.status, 422);
    assert.equal(
      ((await response.json()) as { code?: string }).code,
      "ACTION_COMMAND_PAYLOAD_REQUIRED",
    );
  }
  const after = await loadWorkspaceState();
  assert.equal(after.revision, before.revision);
  assert.equal(after.state.seriesDefinitions.some(
    (entry) => entry.id === "series:raw-bypass",
  ), false);
  assert.equal(after.state.notes, before.state.notes);
});

test("其余工作区与文件写入口同样拒绝缺 payload ref 的直传请求", { concurrency: false }, async () => {
  withTrustedProxy();
  const before = await loadWorkspaceState();
  const source = before.state.dataSources[0]!;
  const form = new FormData();
  form.append(
    "file",
    new File(["raw-bypass"], "raw-bypass.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const formAuthHeaders = Object.fromEntries(
    Object.entries(authHeaders).filter(([key]) => key !== "content-type"),
  );
  const responses = await Promise.all([
    accessDataSources(new NextRequest("http://localhost/api/data-sources", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: "publish",
        source,
        baseRevision: before.revision,
      }),
    })),
    mutateWorkbook(new NextRequest("http://localhost/api/feishu-workbook", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: "pull",
        baseRevision: before.revision,
      }),
    })),
    importFile(new NextRequest("http://localhost/api/import-file", {
      method: "POST",
      headers: formAuthHeaders,
      body: form,
    })),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 422);
    assert.equal(
      ((await response.json()) as { code?: string }).code,
      "ACTION_COMMAND_PAYLOAD_REQUIRED",
    );
  }
  assert.equal((await loadWorkspaceState()).revision, before.revision);
});

test("AI 评估对不存在的 Series/Model 在连接器初始化和出网前返回404", { concurrency: false }, async () => {
  withTrustedProxy();
  const configuration = routeAIConfiguration(
    path.join(os.tmpdir(), `tackle-forger-route-ai-unused-${process.pid}`),
  );
  const previous = new Map(Object.keys(configuration).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(configuration)) process.env[name] = value;
    for (const body of [
      { scopeType: "series", scopeId: "series:missing" },
      { scopeType: "model", scopeId: "model:missing" },
    ]) {
      const response = await assessWithAI(new NextRequest("http://localhost/api/ai/assessments", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body),
      }));
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { code?: string }).code, "AI_SCOPE_NOT_FOUND");
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("AI 评估对延期部位在留存初始化和出网前返回稳定门禁错误", { concurrency: false }, async () => {
  withTrustedProxy();
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-route-ai-disabled-part-"));
  const configuration = {
    ...routeAIConfiguration(path.join(root, "ai-retention")),
    WORKSPACE_DATABASE_PATH: path.join(root, "workspace.sqlite"),
  };
  const previous = new Map(Object.keys(configuration).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(configuration)) process.env[name] = value;
    const initial = await loadWorkspaceState();
    const state = structuredClone(initial.state);
    const series = state.seriesDefinitions[0]!;
    series.itemPartId = "part:hook";
    for (const sku of state.skuDrawers.filter((entry) => entry.seriesId === series.id)) {
      sku.projectionMatch.itemPartId = "part:hook";
    }
    const saved = await saveWorkspaceState({
      state,
      baseRevision: initial.revision,
      author: "route-test",
      message: "prepare delayed part assessment scope",
    });
    assert.equal(saved.conflict, undefined);

    const before = await loadWorkspaceState();
    const response = await assessWithAI(new NextRequest("http://localhost/api/ai/assessments", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ scopeType: "series", scopeId: series.id }),
    }));
    assert.equal(response.status, 422);
    const payload = await response.json() as { code?: string; itemPartId?: string; policyMode?: string };
    assert.equal(payload.code, "ITEM_PART_NOT_ENABLED");
    assert.equal(payload.itemPartId, "part:hook");
    assert.equal(payload.policyMode, "OPEN_003_FAIL_CLOSED");
    assert.equal((await loadWorkspaceState()).revision, before.revision);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Series 路由拒绝非法强度、品质引用和拉力 token", { concurrency: false }, async () => {
  withTrustedProxy();
  const { state } = await loadWorkspaceState();
  const method = state.methodProfiles.find((entry) => entry.enabled)!;
  const itemPart = state.itemParts[0]!;
  const type = state.itemTypeProfiles.find((entry) =>
    entry.enabled && entry.methodIds.includes(method.id) && entry.itemPartIds.includes(itemPart.id))!;
  const fn = state.functionProfiles.find((entry) => entry.enabled)!;
  const base = {
    idempotencyKey: "route-validation:base",
    seriesId: "series:route-validation",
    name: "路由验证",
    concept: "验证运行时引用",
    itemPartId: itemPart.id,
    methodId: method.id,
    typeId: type.id,
    functionId: fn.id,
    qualityId: state.qualityProfiles[0]!.id,
    functionIntensity: 2,
    discretePulls: "1.5, 3.8",
  };
  for (const [change, expectedField] of [
    [{ functionIntensity: 4 }, "功能专精强度"],
    [{ itemPartId: "part:missing" }, "部位"],
    [{ methodId: "method:missing" }, "钓法"],
    [{ typeId: "type:missing" }, "类型"],
    [{ functionId: "function:missing" }, "功能定位"],
    [{ qualityId: "quality:missing" }, "品质"],
    [{ collectionId: "collection:missing" }, "Collection"],
    [{ performanceId: "performance:missing" }, "Performance"],
    [{ discretePulls: "1.5, abc, 1.5" }, "非法或重复项"],
  ] as const) {
    const commandPayload = { ...base, ...change };
    const response = await issueAndInvoke({
      action: "create_series",
      url: "http://localhost/api/series",
      method: "POST",
      payload: commandPayload,
      invoke: createSeries,
      idempotencyKey: `route-validation:${expectedField}:${crypto.randomUUID()}`,
    });
    assert.equal(response.status, 422);
    const errorPayload = await response.json() as { error: string };
    assert.match(errorPayload.error, new RegExp(expectedField));
  }
});

test("Series 路由对恶意JSON字段类型稳定返回400", { concurrency: false }, async () => {
  withTrustedProxy();
  const validShape = {
    idempotencyKey: "malicious-json",
    seriesId: "series:malicious-json",
    name: "类型测试",
    concept: "字段类型必须在trim和split前验证",
    itemPartId: "part:rod",
    methodId: "method:lure",
    typeId: "type:any",
    functionId: "function:any",
    qualityId: "quality_c_green",
    functionIntensity: 2,
    discretePulls: "1.5",
  };
  for (const [field, value] of [
    ["name", 1],
    ["idempotencyKey", {}],
    ["seriesId", 3],
    ["methodId", []],
    ["collectionId", 4],
    ["performanceId", false],
    ["discretePulls", []],
    ["planningMinKgf", 1],
    ["planningMaxKgf", {}],
  ] as const) {
    const response = await issueAndInvoke({
      action: "create_series",
      url: "http://localhost/api/series",
      method: "POST",
      payload: { ...validShape, [field]: value },
      invoke: createSeries,
      idempotencyKey: `malicious-json:${field}`,
    });
    assert.equal(response.status, 400, field);
    assert.equal(((await response.json()) as { field?: string }).field, field);
  }
});

test("Series 路由拒绝扩展部位并且不产生 revision、Series 或 SKU 副作用", { concurrency: false }, async () => {
  withTrustedProxy();
  const before = await loadWorkspaceState();
  const projection = before.state.derivedProjections[0]!;
  const response = await issueAndInvoke({
    action: "create_series",
    url: "http://localhost/api/series",
    method: "POST",
    invoke: createSeries,
    payload: {
      idempotencyKey: "route-disabled-part:hook",
      seriesId: "series:disabled-hook",
      name: "不应创建的钩系列",
      concept: "验证 OPEN-003 服务端门禁",
      itemPartId: "part:hook",
      methodId: projection.methodId,
      typeId: projection.typeId,
      functionId: projection.functionId,
      qualityId: projection.qualityId,
      functionIntensity: projection.functionIntensity,
      discretePulls: "1.5",
    },
  });
  assert.equal(response.status, 422);
  const payload = await response.json() as { code?: string; itemPartId?: string; policyMode?: string; error?: string };
  assert.equal(payload.code, "ITEM_PART_NOT_ENABLED");
  assert.equal(payload.itemPartId, "part:hook");
  assert.equal(payload.policyMode, "OPEN_003_FAIL_CLOSED");
  assert.match(payload.error ?? "", /部位未启用/);
  const after = await loadWorkspaceState();
  assert.equal(after.revision, before.revision);
  assert.equal(after.state.seriesDefinitions.some((entry) => entry.id === "series:disabled-hook"), false);
  assert.equal(after.state.skuDrawers.some((entry) => entry.seriesId === "series:disabled-hook"), false);
  assert.equal(after.state.commandIdempotencyRecords.some((entry) => entry.key === "route-disabled-part:hook"), false);
});

test("Series 创建相同幂等键恢复原结果，不同输入冲突", { concurrency: false }, async () => {
  withTrustedProxy();
  const { state } = await loadWorkspaceState();
  const projection = state.derivedProjections[0]!;
  const type = state.itemTypeProfiles.find((entry) => entry.id === projection.typeId)!;
  const itemPartId = type.itemPartIds[0]!;
  const body = {
    idempotencyKey: "route-idempotency:create-v18-ref-v2",
    seriesId: "series:route-idempotency-v18-ref-v2",
    name: "幂等创建验证",
    concept: "响应丢失后恢复原结果",
    itemPartId,
    methodId: projection.methodId,
    typeId: projection.typeId,
    functionId: projection.functionId,
    qualityId: projection.qualityId,
    performanceId: projection.performanceId,
    functionIntensity: projection.functionIntensity,
    discretePulls: "1.5",
  };
  const send = (value: typeof body) => issueAndInvoke({
    action: "create_series",
    url: "http://localhost/api/series",
    method: "POST",
    payload: value,
    invoke: createSeries,
  });

  const first = await send(body);
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  const firstPayload = await first.json() as { series: { id: string }; revision: number };
  const afterFirst = await loadWorkspaceState();
  const createdSeries = afterFirst.state.seriesDefinitions.find(
    (entry) => entry.id === body.seriesId,
  );
  assert.ok(createdSeries?.partConstraintSetRef);
  const createdConstraintSet = resolvePartConstraintSetRef(
    afterFirst.state.partConstraintSets,
    createdSeries.partConstraintSetRef,
  );
  assert.equal(createdConstraintSet.sourceRef.sourceId, body.seriesId);
  assert.equal(createdConstraintSet.reviewStatus, "NEEDS_REVIEW");
  assert.equal(
    resolvePartConstraintSourceRevision(
      afterFirst.state.seriesDefinitions,
      createdConstraintSet.sourceRef,
    ).id,
    body.seriesId,
  );
  const retry = await send(body);
  assert.equal(retry.status, 200);
  const retryPayload = await retry.json() as { series: { id: string }; revision: number; replayed: boolean };
  assert.equal(retryPayload.replayed, true);
  assert.equal(retryPayload.series.id, firstPayload.series.id);
  assert.equal(retryPayload.revision, firstPayload.revision);

  const conflict = await send({ ...body, name: "同键不同输入" });
  assert.equal(conflict.status, 409);

  const concurrentBody = {
    ...body,
    idempotencyKey: "route-idempotency:concurrent-v18-ref-v2",
    seriesId: "series:route-idempotency-concurrent-v18-ref-v2",
    name: "并发幂等创建验证",
  };
  const concurrent = await Promise.all([send(concurrentBody), send(concurrentBody)]);
  assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
  const afterConcurrent = await loadWorkspaceState();
  assert.equal(afterConcurrent.state.seriesDefinitions.filter(
    (entry) => entry.id === concurrentBody.seriesId,
  ).length, 1);
  const recovered = await send(concurrentBody);
  assert.equal(recovered.status, 200);
  assert.equal(((await recovered.json()) as { replayed?: boolean }).replayed, true);
});

test("Series 创建在拒绝新 Performance 输入前恢复旧幂等命令", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const state = structuredClone(current.state);
  const series = state.seriesDefinitions[0]!;
  const projection = state.derivedProjections.find(
    (entry) => entry.id === state.skuDrawers.find((sku) => sku.seriesId === series.id)?.projectionMatch.projectionId,
  )!;
  const body = {
    idempotencyKey: "route-idempotency:legacy-performance",
    seriesId: series.id,
    name: series.name,
    concept: series.concept,
    collectionId: series.collectionId || null,
    itemPartId: series.itemPartId!,
    methodId: series.fishingMethodId,
    typeId: series.typeId,
    functionId: series.coreFunctionId,
    qualityId: series.qualityId,
    performanceId: "performance:legacy",
    functionIntensity: projection.functionIntensity,
    planningMinKgf: null,
    planningMaxKgf: null,
    pulls: [1.5],
  };
  const inputHash = createHash("sha256").update(JSON.stringify({
    seriesId: body.seriesId,
    name: body.name,
    concept: body.concept,
    collectionId: body.collectionId,
    itemPartId: body.itemPartId,
    methodId: body.methodId,
    typeId: body.typeId,
    functionId: body.functionId,
    qualityId: body.qualityId,
    performanceId: body.performanceId,
    functionIntensity: body.functionIntensity,
    planningMinKgf: body.planningMinKgf,
    planningMaxKgf: body.planningMaxKgf,
    pulls: body.pulls,
  })).digest("hex");
  state.commandIdempotencyRecords.push({
    key: body.idempotencyKey,
    inputHash,
    resultRef: series.id,
  });
  const saved = await saveWorkspaceState({
    state,
    baseRevision: current.revision,
    author: "route-tester",
    message: "注入旧 Series 幂等记录",
  });
  assert.equal(saved.conflict, undefined);
  const response = await issueAndInvoke({
    action: "create_series",
    url: "http://localhost/api/series",
    method: "POST",
    idempotencyKey: "payload-ref:legacy-performance",
    invoke: createSeries,
    payload: {
      idempotencyKey: body.idempotencyKey,
      seriesId: body.seriesId,
      name: body.name,
      concept: body.concept,
      collectionId: body.collectionId,
      itemPartId: body.itemPartId,
      methodId: body.methodId,
      typeId: body.typeId,
      functionId: body.functionId,
      qualityId: body.qualityId,
      performanceId: body.performanceId,
      functionIntensity: body.functionIntensity,
      discretePulls: "1.5",
    },
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(((await response.json()) as { idempotent?: boolean }).idempotent, true);
});

test("SKU 拉力提交拒绝与预览不一致的冻结分支并返回409", { concurrency: false }, async () => {
  withTrustedProxy();
  const { state } = await loadWorkspaceState();
  const sku = state.skuDrawers.find(
    (entry) =>
      entry.status !== "superseded" &&
      !state.configurationSnapshots.some((snapshot) =>
        state.purchasableModels.some(
          (model) =>
            model.id === snapshot.modelId && model.skuId === entry.id,
        )),
  )!;
  assert.ok(sku);
  const targetPullKg = sku.targetPullKg + 0.37;
  const previewResponse = await previewSkuTargetPull(new NextRequest(
    "http://localhost/api/skus/target-pull/preview",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        skuId: sku.id,
        expectedRevision: sku.revision,
        targetPullKg,
      }),
    },
  ));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as {
    projectionMatch: unknown;
    mode: "SAME_SKU_NEW_REVISION" | "REPLACEMENT_SKU";
    publishedDescendantFingerprint: string;
  };
  const response = await issueAndInvoke({
    action: "change_sku_target_pull",
    url: "http://localhost/api/skus/target-pull",
    method: "POST",
    invoke: changeSkuTargetPull,
    payload: {
        skuId: sku.id,
        expectedRevision: sku.revision,
        targetPullKg,
        projectionMatch: preview.projectionMatch,
        expectedMode: preview.mode === "SAME_SKU_NEW_REVISION"
          ? "REPLACEMENT_SKU"
          : "SAME_SKU_NEW_REVISION",
        publishedDescendantFingerprint:
          preview.publishedDescendantFingerprint,
        replacementSkuId: "sku:must-not-be-created",
        deprecateOriginal: true,
        idempotencyKey: "route:sku-preview-drift",
    },
  });
  assert.equal(response.status, 409);
  const payload = await response.json() as { code?: string };
  assert.equal(payload.code, "PREVIEW_STALE");
});
