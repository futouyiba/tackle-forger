import assert from "node:assert/strict";
import test from "node:test";
import { commitFeishuWriteback, feishuWritebackFieldsMatch } from "../lib/feishu";
import type { DataSourceProfile } from "../lib/types";

// feishuTenantAccessToken 在调用 fetch 前校验这两个环境变量；测试里给占位值，
// 真正的 HTTP 由各用例 mock 的 global.fetch 返回。
process.env.FEISHU_APP_ID = "test-app-id";
process.env.FEISHU_APP_SECRET = "test-app-secret";

const source: DataSourceProfile = {
  id: "s1",
  name: "测试源",
  provider: "feishu_bitable",
  dataset: "weight_templates",
  appToken: "app",
  tableId: "tbl",
  viewId: "",
  shareUrl: "",
  enabled: true,
  notes: "",
};

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordsResponse(items: Array<{ record_id: string; fields: Record<string, unknown> }>): unknown {
  return { code: 0, data: { items, has_more: false, page_token: "" } };
}

test("feishuWritebackFieldsMatch：命中、不命中与缺失", () => {
  assert.equal(feishuWritebackFieldsMatch({ a: 1, b: 2 }, { a: 1 }), true);
  assert.equal(feishuWritebackFieldsMatch({ a: 1 }, { a: 2 }), false);
  assert.equal(feishuWritebackFieldsMatch(undefined, { a: 1 }), false);
  assert.equal(feishuWritebackFieldsMatch({ list: [1, 2] }, { list: [1, 2] }), true);
  assert.equal(feishuWritebackFieldsMatch({ list: [1, 2] }, { list: [2, 1] }), false);
});

test("commitFeishuWriteback：写前回读已全部命中时跳过写入（幂等）", async () => {
  const original = global.fetch;
  let batchUpdateCalled = false;
  global.fetch = (async (url) => {
    const u = String(url);
    if (u.includes("tenant_access_token")) return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
    if (u.includes("/records/batch_update")) {
      batchUpdateCalled = true;
      return jsonResponse({ code: 0 });
    }
    if (u.includes("/records")) return jsonResponse(recordsResponse([{ record_id: "r1", fields: { f: 9 } }]));
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
  try {
    const result = await commitFeishuWriteback(source, [
      { entityId: "e1", recordId: "r1", fieldNames: ["f"], fields: { f: 9 } },
    ]);
    assert.equal(result.result, "alreadyApplied");
    assert.equal(batchUpdateCalled, false);
    assert.equal(result.evidence[0]?.matched, true);
  } finally {
    global.fetch = original;
  }
});

test("commitFeishuWriteback：写入成功并回读核实为 written", async () => {
  const original = global.fetch;
  let batchUpdateCalled = false;
  global.fetch = (async (url) => {
    const u = String(url);
    if (u.includes("tenant_access_token")) return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
    if (u.includes("/records/batch_update")) {
      batchUpdateCalled = true;
      return jsonResponse({ code: 0 });
    }
    if (u.includes("/records")) return jsonResponse(recordsResponse([{ record_id: "r1", fields: { f: 9 } }]));
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
  try {
    const result = await commitFeishuWriteback(source, [
      { entityId: "e1", recordId: "r1", fieldNames: ["f"], fields: { f: 9, g: 1 } },
    ]);
    assert.equal(result.result, "written");
    assert.equal(batchUpdateCalled, true);
  } finally {
    global.fetch = original;
  }
});

test("commitFeishuWriteback：写入抛错且回读确认已落地为 recovered", async () => {
  const original = global.fetch;
  let recordsCallCount = 0;
  global.fetch = (async (url) => {
    const u = String(url);
    if (u.includes("tenant_access_token")) return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
    if (u.includes("/records/batch_update")) return jsonResponse({ code: 99999, msg: "boom" });
    if (u.includes("/records")) {
      recordsCallCount += 1;
      // 写前不命中（f=1），写后命中（f=9）：模拟写入实际已落地但响应报错。
      const f = recordsCallCount === 1 ? 1 : 9;
      return jsonResponse(recordsResponse([{ record_id: "r1", fields: { f } }]));
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
  try {
    const result = await commitFeishuWriteback(source, [
      { entityId: "e1", recordId: "r1", fieldNames: ["f"], fields: { f: 9 } },
    ]);
    assert.equal(result.result, "recovered");
    assert.equal(result.evidence[0]?.matched, true);
    assert.ok(result.error);
  } finally {
    global.fetch = original;
  }
});

test("commitFeishuWriteback：写入抛错且回读仍未落地为 failed", async () => {
  const original = global.fetch;
  global.fetch = (async (url) => {
    const u = String(url);
    if (u.includes("tenant_access_token")) return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
    if (u.includes("/records/batch_update")) return jsonResponse({ code: 99999, msg: "boom" });
    // 写前、写后都不命中（始终 f=1，目标 9）。
    if (u.includes("/records")) return jsonResponse(recordsResponse([{ record_id: "r1", fields: { f: 1 } }]));
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
  try {
    const result = await commitFeishuWriteback(source, [
      { entityId: "e1", recordId: "r1", fieldNames: ["f"], fields: { f: 9 } },
    ]);
    assert.equal(result.result, "failed");
    assert.equal(result.evidence[0]?.matched, false);
    assert.ok(result.error);
  } finally {
    global.fetch = original;
  }
});
