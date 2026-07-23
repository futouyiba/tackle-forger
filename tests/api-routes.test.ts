import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { PUT as putState } from "../app/api/state/route";
import { POST as createSeries } from "../app/api/series/route";
import { POST as assessWithAI } from "../app/api/ai/assessments/route";
import { loadWorkspaceState } from "../lib/storage";

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

test("整包 PUT 的畸形 JSON 返回400", { concurrency: false }, async () => {
  withTrustedProxy();
  const response = await putState(new NextRequest("http://localhost/api/state", {
    method: "PUT", headers: authHeaders, body: "{",
  }));
  assert.equal(response.status, 400);
});

test("AI 评估对不存在的 Series/Model 在连接器初始化和出网前返回404", { concurrency: false }, async () => {
  withTrustedProxy();
  const configuration = {
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
    AI_RETENTION_DATA_DIR: path.join(tmpdir(), `tackle-forger-route-ai-unused-${process.pid}`),
    AI_RETENTION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
    AI_RETENTION_ENCRYPTION_KEY_VERSION: "route-test-v1",
  } as const;
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
