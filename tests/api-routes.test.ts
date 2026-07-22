import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { PUT as putState } from "../app/api/state/route";
import { POST as accessDataSources } from "../app/api/data-sources/route";
import { POST as createSeries } from "../app/api/series/route";
import { GET as getSeriesGantt } from "../app/api/series-gantt/route";
import { loadWorkspaceState, saveWorkspaceState } from "../lib/storage";

const authHeaders = {
  "content-type": "application/json",
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "route-tester",
  "x-feishu-display-name": "route-tester",
  "x-tf-proxy-secret": "route-test-secret",
};

function withTrustedProxy() {
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "route-test-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
}

test("Series 甘特路由要求认证，主列表只返回服务端投影", { concurrency: false }, async () => {
  withTrustedProxy();
  const anonymous = await getSeriesGantt(new NextRequest("http://localhost/api/series-gantt?view=series&pageSize=1"));
  assert.equal(anonymous.status, 401);

  const response = await getSeriesGantt(new NextRequest("http://localhost/api/series-gantt?view=series&pageSize=1", {
    headers: authHeaders,
  }));
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    state?: unknown;
    revision: number;
    blocks: Array<{ seriesId: string; skuNodes: Array<{ skuId: string }> }>;
    page: { nextCursor?: string; totalVisible: number; pageSize: number };
    facets: { weights: number[] };
  };
  assert.equal(payload.state, undefined);
  assert.equal(payload.blocks.length, Math.min(1, payload.page.totalVisible));
  assert.equal(payload.page.pageSize, 1);
  assert.ok(Array.isArray(payload.facets.weights));

  if (payload.page.nextCursor) {
    const stale = await getSeriesGantt(new NextRequest(`http://localhost/api/series-gantt?view=series&pageSize=2&cursor=${encodeURIComponent(payload.page.nextCursor)}`, {
      headers: authHeaders,
    }));
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code?: string }).code, "SERIES_GANTT_CURSOR_STALE");
  }
});

test("Series 甘特路由按父对象按需加载 SKU/Model 且隐藏父对象返回404", { concurrency: false }, async () => {
  withTrustedProxy();
  const { state } = await loadWorkspaceState();
  const series = state.seriesDefinitions.find((entry) => state.skuDrawers.some((sku) => sku.seriesId === entry.id))!;
  const skuResponse = await getSeriesGantt(new NextRequest(`http://localhost/api/series-gantt?view=skus&seriesId=${encodeURIComponent(series.id)}&pageSize=1`, {
    headers: authHeaders,
  }));
  assert.equal(skuResponse.status, 200);
  const skuPayload = await skuResponse.json() as {
    skus: Array<{ id: string; seriesId: string }>;
    page: { nextCursor?: string };
  };
  assert.ok(skuPayload.skus.every((sku) => sku.seriesId === series.id));
  const sku = skuPayload.skus[0]!;

  const modelResponse = await getSeriesGantt(new NextRequest(`http://localhost/api/series-gantt?view=models&skuId=${encodeURIComponent(sku.id)}&pageSize=1`, {
    headers: authHeaders,
  }));
  assert.equal(modelResponse.status, 200);
  const modelPayload = await modelResponse.json() as { models: Array<{ skuId: string }> };
  assert.ok(modelPayload.models.every((model) => model.skuId === sku.id));

  const hidden = await getSeriesGantt(new NextRequest("http://localhost/api/series-gantt?view=skus&seriesId=series%3Ahidden", {
    headers: authHeaders,
  }));
  assert.equal(hidden.status, 404);
});

test("AUD-024 甘特 GET API 不输出历史目标重量字段", { concurrency: false }, async () => {
  withTrustedProxy();
  const response = await getSeriesGantt(new NextRequest(
    "http://localhost/api/series-gantt?exactTargetPullKg=1.5",
    { headers: authHeaders },
  ));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("targetWeightKg"), false);
  assert.equal(text.includes("exactTargetWeightKg"), false);
  assert.equal(text.includes("targetPullKg"), true);
});

test("已认证整包 PUT 不能绕过 Series 领域命令", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const state = structuredClone(current.state);
  state.seriesDefinitions.push({ ...state.seriesDefinitions[0]!, id: "series:put-bypass" });
  const response = await putState(new NextRequest("http://localhost/api/state", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ state, baseRevision: current.revision }),
  }));
  assert.equal(response.status, 422);
  const payload = await response.json() as { code?: string; governedChanges?: string[] };
  assert.equal(payload.code, "DOMAIN_COMMAND_REQUIRED");
  assert.deepEqual(payload.governedChanges, ["seriesDefinitions"]);
});

test("已认证整包 PUT 可保存工作台通用配置编辑", { concurrency: false }, async () => {
  withTrustedProxy();
  const current = await loadWorkspaceState();
  const state = structuredClone(current.state);
  state.notes = `route-save-${current.revision}`;
  state.templates[0] = { ...state.templates[0]!, notes: "route-level workbench save" };
  const response = await putState(new NextRequest("http://localhost/api/state", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ state, baseRevision: current.revision }),
  }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { revision?: number };
  assert.equal(payload.revision, current.revision + 1);
  const saved = await loadWorkspaceState();
  assert.equal(saved.state.notes, state.notes);
  assert.equal(saved.state.templates[0]?.notes, "route-level workbench save");
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

  const response = await putState(new NextRequest("http://localhost/api/state", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ state, baseRevision: current.revision }),
  }));
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

    const publishResponse = await accessDataSources(new NextRequest("http://localhost/api/data-sources", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: "publish",
        source,
        baseRevision: current.revision,
        checksum: previewPayload.preview.checksum,
        sourceFingerprint: previewPayload.preview.sourceFingerprint,
      }),
    }));
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

test("整包 PUT 的畸形 JSON 返回400", { concurrency: false }, async () => {
  withTrustedProxy();
  const response = await putState(new NextRequest("http://localhost/api/state", {
    method: "PUT", headers: authHeaders, body: "{",
  }));
  assert.equal(response.status, 400);
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
    const response = await createSeries(new NextRequest("http://localhost/api/series", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...base, ...change }),
    }));
    assert.equal(response.status, 422);
    const payload = await response.json() as { error: string };
    assert.match(payload.error, new RegExp(expectedField));
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
    const response = await createSeries(new NextRequest("http://localhost/api/series", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...validShape, [field]: value }),
    }));
    assert.equal(response.status, 400, field);
    assert.equal(((await response.json()) as { field?: string }).field, field);
  }
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
  const send = (value: typeof body) => createSeries(new NextRequest("http://localhost/api/series", {
    method: "POST", headers: authHeaders, body: JSON.stringify(value),
  }));

  const first = await send(body);
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  const firstPayload = await first.json() as { series: { id: string }; revision: number };
  const retry = await send(body);
  assert.equal(retry.status, 200);
  const retryPayload = await retry.json() as { series: { id: string }; revision: number; idempotent: boolean };
  assert.equal(retryPayload.idempotent, true);
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
  assert.equal(((await recovered.json()) as { idempotent?: boolean }).idempotent, true);
});
