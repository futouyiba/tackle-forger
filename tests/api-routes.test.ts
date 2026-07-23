import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { PUT as putState } from "../app/api/state/route";
import { POST as issueActionCommand } from "../app/api/action-commands/route";
import { POST as accessDataSources } from "../app/api/data-sources/route";
import { POST as mutateWorkbook } from "../app/api/feishu-workbook/route";
import { POST as importFile } from "../app/api/import-file/route";
import { POST as createSeries } from "../app/api/series/route";
import { POST as changeSkuTargetPull } from "../app/api/skus/target-pull/route";
import { POST as previewSkuTargetPull } from "../app/api/skus/target-pull/preview/route";
import { loadWorkspaceState, saveWorkspaceState } from "../lib/storage";
import { closeSqliteStorage } from "../lib/sqlite-storage";

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

async function issueAndInvoke(input: {
  action:
    | "save_workspace"
    | "create_series"
    | "change_sku_target_pull"
    | "publish_data_source"
    | "commit_data_source_writeback";
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
    [{ performanceId: "performance:missing" }, "性能方向"],
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
    idempotencyKey: "route-idempotency:create-1",
    seriesId: "series:route-idempotency-1",
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
    idempotencyKey: "route-idempotency:concurrent-1",
    seriesId: "series:route-idempotency-concurrent-1",
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
