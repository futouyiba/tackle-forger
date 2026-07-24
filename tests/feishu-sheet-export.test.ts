import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../app/api/export-to-feishu-sheet/route";
import { loadWorkspaceState } from "../lib/storage";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
} from "../lib/feishu-workbook";
import { FeishuApiError } from "../lib/feishu-api-error";
import { exportWorkspaceToFeishuSheet } from "../lib/feishu-sheet-export";

// feishuTenantAccessToken 在调用 fetch 前校验这两个环境变量；测试里给占位值，
// 真正的 HTTP 由各用例 mock 的 global.fetch 返回。
process.env.FEISHU_APP_ID = "sheet-export-test-app";
process.env.FEISHU_APP_SECRET = "sheet-export-test-secret";

const authHeaders = {
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "sheet-export-tester",
  "x-feishu-display-name": "sheet-export-tester",
  "x-tf-proxy-secret": "route-test-secret",
};

function withTrustedProxy() {
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "route-test-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
}

function disableTrustedProxy() {
  delete process.env.FEISHU_TRUST_PROXY_HEADERS;
  delete process.env.FEISHU_PROXY_SHARED_SECRET;
  delete process.env.FEISHU_TENANT_KEY;
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchMockOptions {
  createFail?: boolean;
  valuesFail?: boolean;
  /** 创建接口返回的 token/url，用于断言。 */
  spreadsheetToken?: string;
  spreadsheetUrl?: string;
}

function makeFetchMock(options: FetchMockOptions = {}): typeof fetch {
  const token = options.spreadsheetToken ?? "TOKEN123";
  const url = options.spreadsheetUrl ?? `https://example.com/sheets/${token}`;
  return (async (input, init) => {
    const u = String(input);
    const method = init?.method ?? "GET";
    if (u.includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "t-sheet-export", expire: 7200 });
    }
    if (u.endsWith("/open-apis/sheets/v3/spreadsheets") && method === "POST") {
      if (options.createFail) {
        return jsonResponse({ code: 99999, msg: "应用无创建电子表格权限" });
      }
      return jsonResponse({
        code: 0,
        data: { spreadsheet: { title: "Tackle Forger 工作区导出", url, spreadsheet_token: token } },
      });
    }
    if (u.includes("/sheets/query")) {
      return jsonResponse({
        code: 0,
        data: { sheets: [{ sheet_id: "default1", title: "Sheet1", index: 0 }] },
      });
    }
    if (u.includes("/sheets/batch_update")) {
      const body = JSON.parse(String(init?.body)) as { requests: Array<Record<string, unknown>> };
      const replies = body.requests.map((request, index) => {
        if (request.addSheet) {
          const title = (request.addSheet as { properties?: { title?: string } }).properties?.title ?? `Sheet${index}`;
          return { addReply: { properties: { sheetId: `add-${index}`, title } } };
        }
        return {};
      });
      return jsonResponse({ code: 0, data: { replies } });
    }
    if (u.includes("/values_batch_update")) {
      if (options.valuesFail) {
        return jsonResponse({ code: 99999, msg: "写入单元格失败" });
      }
      return jsonResponse({ code: 0, data: { totalUpdatedRows: 1, totalUpdatedCells: 1 } });
    }
    return jsonResponse({ code: 0, data: {} });
  }) as typeof fetch;
}

let originalFetch: typeof fetch;

before(() => {
  originalFetch = global.fetch;
});

after(() => {
  global.fetch = originalFetch;
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  delete process.env.FEISHU_EXPORT_TO_SHEET_ENABLED;
  disableTrustedProxy();
});

test("exportWorkspaceToFeishuSheet 成功路径：创建新表并写入多个 sheet", async () => {
  global.fetch = makeFetchMock({});
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
  assert.equal(manifest.spreadsheetToken, "TOKEN123");
  assert.equal(manifest.url, "https://example.com/sheets/TOKEN123");
  assert.equal(manifest.failedCount, 0);
  assert.ok(manifest.sheetResults.length > 10, "应写入与 Excel 导出同构的多个 sheet");
  assert.ok(manifest.totalRowsWritten > 0, "应写入数据行");
  assert.ok(manifest.sheetResults.every((r) => r.result === "written" || r.result === "skipped_empty"));
  assert.ok(manifest.openQuestions.length > 0, "应在 manifest 回显开放决策");
  assert.equal(manifest.defaults.batchCellCap, 4000);
  assert.equal(manifest.defaults.overwritePolicy.includes("创建新表"), true);
});

test("exportWorkspaceToFeishuSheet 创建失败时抛 FeishuApiError 携带 code/endpoint", async () => {
  global.fetch = makeFetchMock({ createFail: true });
  const { state, revision } = await loadWorkspaceState();
  await assert.rejects(
    () => exportWorkspaceToFeishuSheet({ state, revision }),
    (error: unknown) => {
      assert.ok(error instanceof FeishuApiError, "应为 FeishuApiError");
      assert.equal((error as FeishuApiError).code, 99999);
      assert.equal((error as FeishuApiError).endpoint, "/open-apis/sheets/v3/spreadsheets");
      return true;
    },
  );
});

test("exportWorkspaceToFeishuSheet 单元格写入失败时各 sheet 标记 failed 但不中断", async () => {
  global.fetch = makeFetchMock({ valuesFail: true });
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
  assert.equal(manifest.failedCount, manifest.sheetResults.length);
  assert.ok(manifest.sheetResults.every((r) => r.result === "failed"));
  assert.ok(manifest.sheetResults.every((r) => r.error && r.error.endpoint.includes("values_batch_update")));
});

test("exportWorkspaceToFeishuSheet 写入 payload 正确：标题与 sheet 名确定性", async () => {
  let capturedCreate: { name?: string } | undefined;
  let capturedBatchTitles: string[] = [];
  global.fetch = (async (input, init) => {
    const u = String(input);
    const method = init?.method ?? "GET";
    if (u.includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "t-payload", expire: 7200 });
    }
    if (u.endsWith("/open-apis/sheets/v3/spreadsheets") && method === "POST") {
      capturedCreate = JSON.parse(String(init?.body)) as { name?: string };
      return jsonResponse({
        code: 0,
        data: { spreadsheet: { title: "x", url: "https://example.com/sheets/PAYLOAD", spreadsheet_token: "PAYLOAD" } },
      });
    }
    if (u.includes("/sheets/query")) {
      return jsonResponse({ code: 0, data: { sheets: [{ sheet_id: "d", title: "S", index: 0 }] } });
    }
    if (u.includes("/sheets/batch_update")) {
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ addSheet?: { properties?: { title?: string } }; updateSheet?: { properties?: { title?: string } } }> };
      capturedBatchTitles = body.requests.map((r) => r.updateSheet?.properties?.title ?? r.addSheet?.properties?.title ?? "");
      return jsonResponse({
        code: 0,
        data: { replies: body.requests.map((_, i) => ({ addReply: { properties: { sheetId: `s-${i}`, title: "x" } } })) },
      });
    }
    if (u.includes("/values_batch_update")) {
      return jsonResponse({ code: 0, data: { totalUpdatedRows: 1 } });
    }
    return jsonResponse({ code: 0, data: {} });
  }) as typeof fetch;
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
  // 标题仅依赖 revision（确定性，不含时钟）。
  assert.ok(capturedCreate?.name?.includes(`r${revision}`), "创建标题应包含 revision");
  // 第一个数据 sheet 复用默认 sheet（updateSheet），其余 addSheet。
  assert.ok(capturedBatchTitles.length > 10);
  assert.equal(manifest.spreadsheetToken, "PAYLOAD");
});

test("exportWorkspaceToFeishuSheet 不触碰 canonical 规则源常量", async () => {
  global.fetch = makeFetchMock({});
  const workbookBefore = JSON.stringify(CANONICAL_FEISHU_WORKBOOK);
  const registryBefore = JSON.stringify(CANONICAL_FEISHU_SHEET_REGISTRY);
  const { state, revision } = await loadWorkspaceState();
  await exportWorkspaceToFeishuSheet({ state, revision });
  assert.equal(JSON.stringify(CANONICAL_FEISHU_WORKBOOK), workbookBefore, "CANONICAL_FEISHU_WORKBOOK 被修改");
  assert.equal(JSON.stringify(CANONICAL_FEISHU_SHEET_REGISTRY), registryBefore, "CANONICAL_FEISHU_SHEET_REGISTRY 被修改");
});

test("manifest 不泄露 FEISHU_APP_SECRET", async () => {
  process.env.FEISHU_APP_SECRET = "SUPER_SECRET_VALUE_MARKER";
  global.fetch = makeFetchMock({});
  try {
    const { state, revision } = await loadWorkspaceState();
    const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
    const serialized = JSON.stringify(manifest);
    assert.ok(!serialized.includes("SUPER_SECRET_VALUE_MARKER"), "app secret 不应进入 manifest");
  } finally {
    process.env.FEISHU_APP_SECRET = "sheet-export-test-secret";
  }
});

test("路由未登录返回 401", async () => {
  disableTrustedProxy();
  delete process.env.FEISHU_EXPORT_TO_SHEET_ENABLED;
  const response = await POST(new NextRequest("http://localhost/api/export-to-feishu-sheet", { method: "POST", body: "{}" }));
  assert.equal(response.status, 401);
  const payload = (await response.json()) as { action?: string };
  assert.equal(payload.action, "feishu_login");
});

test("路由在未启用 FEISHU_EXPORT_TO_SHEET_ENABLED 时返回 503（受控写入 gate）", async () => {
  withTrustedProxy();
  delete process.env.FEISHU_EXPORT_TO_SHEET_ENABLED;
  const response = await POST(
    new NextRequest("http://localhost/api/export-to-feishu-sheet", { method: "POST", body: "{}", headers: authHeaders }),
  );
  assert.equal(response.status, 503);
  const payload = (await response.json()) as { disabledReasonCode?: string };
  assert.equal(payload.disabledReasonCode, "FEISHU_EXPORT_TO_SHEET_DISABLED");
});

test("路由启用后成功返回 manifest", async () => {
  withTrustedProxy();
  process.env.FEISHU_EXPORT_TO_SHEET_ENABLED = "true";
  global.fetch = makeFetchMock({});
  try {
    const response = await POST(
      new NextRequest("http://localhost/api/export-to-feishu-sheet", { method: "POST", body: "{}", headers: authHeaders }),
    );
    assert.equal(response.status, 200);
    const manifest = (await response.json()) as { url?: string; sheetResults?: unknown[] };
    assert.equal(manifest.url, "https://example.com/sheets/TOKEN123");
    assert.ok((manifest.sheetResults?.length ?? 0) > 0);
  } finally {
    delete process.env.FEISHU_EXPORT_TO_SHEET_ENABLED;
  }
});

test("路由在飞书接口失败时返回 502 与脱敏 errorInfo", async () => {
  withTrustedProxy();
  process.env.FEISHU_EXPORT_TO_SHEET_ENABLED = "true";
  global.fetch = makeFetchMock({ createFail: true });
  try {
    const response = await POST(
      new NextRequest("http://localhost/api/export-to-feishu-sheet", { method: "POST", body: "{}", headers: authHeaders }),
    );
    assert.equal(response.status, 502);
    const payload = (await response.json()) as { error?: string; errorInfo?: { endpoint?: string; code?: number } };
    assert.ok(payload.errorInfo);
    assert.equal(payload.errorInfo?.endpoint, "/open-apis/sheets/v3/spreadsheets");
    assert.equal(payload.errorInfo?.code, 99999);
    // 响应体不含 spreadsheet token 任何信息。
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("TOKEN123"));
  } finally {
    delete process.env.FEISHU_EXPORT_TO_SHEET_ENABLED;
  }
});
