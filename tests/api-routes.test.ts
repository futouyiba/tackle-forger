import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { PUT as putState } from "../app/api/state/route";
import { POST as accessDataSources } from "../app/api/data-sources/route";
import { POST as createSeries } from "../app/api/series/route";
import {
  resolvePartConstraintSourceRevision,
  resolvePartConstraintSetRef,
} from "../lib/part-constraints";
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

test("Series 路由拒绝扩展部位并且不产生 revision、Series 或 SKU 副作用", { concurrency: false }, async () => {
  withTrustedProxy();
  const before = await loadWorkspaceState();
  const projection = before.state.derivedProjections[0]!;
  const response = await createSeries(new NextRequest("http://localhost/api/series", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
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
    }),
  }));
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
  const send = (value: typeof body) => createSeries(new NextRequest("http://localhost/api/series", {
    method: "POST", headers: authHeaders, body: JSON.stringify(value),
  }));

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
  const retryPayload = await retry.json() as { series: { id: string }; revision: number; idempotent: boolean };
  assert.equal(retryPayload.idempotent, true);
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
  assert.equal(((await recovered.json()) as { idempotent?: boolean }).idempotent, true);
});
