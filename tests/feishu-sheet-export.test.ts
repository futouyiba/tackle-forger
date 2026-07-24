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
  /** 回读（GET /values）失败，使 verified:false。 */
  verifyFail?: boolean;
  /** 回读返回行数不足（写入不一致），使 verified:false。 */
  verifyDrift?: boolean;
  /** 创建接口返回的 token/url，用于断言。 */
  spreadsheetToken?: string;
  spreadsheetUrl?: string;
}

function makeFetchMock(options: FetchMockOptions = {}): typeof fetch & { capturedVerifyRanges: string[] } {
  const token = options.spreadsheetToken ?? "TOKEN123";
  const url = options.spreadsheetUrl ?? `https://example.com/sheets/${token}`;
  // 记录每个 sheet 累积写入的行（用于回读 echo，使核对一致 → verified:true）。
  const written = new Map<string, unknown[][]>();
  // 精确捕获每次回读 GET 的实际请求范围字符串（URL 解码后），用于断言「单 sheetId 前缀」。
  // 生产飞书对双前缀 sheetId!sheetId!A1:... 会返回错误/空 → 回读全部失败；旧 mock 按
  // split('!')[0] 宽松解析掩盖了这个 bug，这里改为精确记录原始请求范围。
  const capturedVerifyRanges: string[] = [];
  const fetchMock = (async (input, init) => {
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
      const body = JSON.parse(String(init?.body)) as { valueRanges?: Array<{ range?: string; values?: unknown[][] }> };
      for (const vr of body.valueRanges ?? []) {
        const sheetId = String(vr.range ?? "").split("!")[0] ?? "";
        const existing = written.get(sheetId) ?? [];
        for (const row of vr.values ?? []) existing.push(row);
        written.set(sheetId, existing);
      }
      return jsonResponse({ code: 0, data: { totalUpdatedRows: 1, totalUpdatedCells: 1 } });
    }
    if (u.includes("/values/") && method === "GET") {
      const match = u.match(/\/values\/([^?]+)/);
      const rangePart = match ? decodeURIComponent(match[1]) : "";
      // 精确记录实际发出的回读范围字符串（生产正确性关键），即便 verifyFail 也记录，
      // 以断言失败路径的请求范围同样是单前缀。
      capturedVerifyRanges.push(rangePart);
      if (options.verifyFail) {
        return jsonResponse({ code: 1254040, msg: "读取单元格失败" });
      }
      const sheetId = rangePart.split("!")[0] ?? "";
      let values = written.get(sheetId) ?? [];
      if (options.verifyDrift) {
        // 回读不一致：只返回首行，无论写入多少，触发行数核对失败。
        values = values.slice(0, 1);
      }
      return jsonResponse({ code: 0, data: { revision: 42, valueRange: { revision: 42, values } } });
    }
    return jsonResponse({ code: 0, data: {} });
  }) as typeof fetch & { capturedVerifyRanges: string[] };
  fetchMock.capturedVerifyRanges = capturedVerifyRanges;
  return fetchMock;
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

test("exportWorkspaceToFeishuSheet 成功路径：创建新表并写入多个 sheet，回读核对通过", async () => {
  const fetchMock = makeFetchMock({});
  global.fetch = fetchMock;
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
  // 保守默认：不单独返回 spreadsheet_token，用户通过 url 访问新表。
  assert.equal("spreadsheetToken" in manifest, false, "不应单独返回 spreadsheet_token 字段");
  assert.equal(manifest.url, "https://example.com/sheets/TOKEN123");
  assert.equal(manifest.failedCount, 0);
  assert.ok(manifest.sheetResults.length > 10, "应写入与 Excel 导出同构的多个 sheet");
  assert.ok(manifest.totalRowsWritten > 0, "应写入数据行");
  assert.ok(manifest.sheetResults.every((r) => r.result === "written" || r.result === "skipped_empty"));
  // 写入后回读核对：每个 written sheet 应 verified=true（echo mock 回放写入数据）。
  const written = manifest.sheetResults.filter((r) => r.result === "written");
  assert.ok(written.length > 0);
  assert.ok(written.every((r) => r.verified === true), "written sheet 回读核对应通过");
  assert.ok(manifest.openQuestions.length > 0, "应在 manifest 回显开放决策");
  assert.equal(manifest.defaults.batchCellCap, 4000);
  assert.equal(manifest.defaults.overwritePolicy.includes("创建新表"), true);
  // 回读请求范围必须是单 sheetId 前缀 `sheetId!A1:...`，不得出现双重前缀
  // `sheetId!sheetId!A1:...`。生产飞书对双前缀会返回错误/空，导致回读全部失败
  // （这是本次修复的 HIGH 阻断 bug；旧 mock 按 split('!')[0] 宽松解析掩盖了它）。
  assert.ok(fetchMock.capturedVerifyRanges.length > 0, "成功路径应至少发起一次回读 GET");
  for (const rangePart of fetchMock.capturedVerifyRanges) {
    assert.ok(!rangePart.includes("!!"), `回读范围不得含双重 sheetId 前缀：${rangePart}`);
    assert.equal(
      (rangePart.match(/!/g) ?? []).length,
      1,
      `回读范围应恰好含一个 '!'（单 sheetId 前缀）：${rangePart}`,
    );
  }
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
  // errorInfo.endpoint 不得含 raw spreadsheet token，应脱敏为 <redacted>。
  assert.ok(
    manifest.sheetResults.every((r) => !JSON.stringify(r.error ?? {}).includes("TOKEN123")),
    "errorInfo 不得含 raw spreadsheet token",
  );
  assert.ok(
    manifest.sheetResults.every((r) => r.error?.endpoint.includes("<redacted>")),
    "endpoint 应脱敏为 <redacted>",
  );
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
    if (u.includes("/values/") && method === "GET") {
      // 回读核对：返回空 values（本用例只校验写入 payload，不关心核对结论）。
      return jsonResponse({ code: 0, data: { revision: 42, valueRange: { revision: 42, values: [] } } });
    }
    return jsonResponse({ code: 0, data: {} });
  }) as typeof fetch;
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
  // 标题仅依赖 revision（确定性，不含时钟）。
  assert.ok(capturedCreate?.name?.includes(`r${revision}`), "创建标题应包含 revision");
  // 第一个数据 sheet 复用默认 sheet（updateSheet），其余 addSheet。
  assert.ok(capturedBatchTitles.length > 10);
  assert.equal(manifest.url, "https://example.com/sheets/PAYLOAD");
  assert.equal("spreadsheetToken" in manifest, false, "不应单独返回 spreadsheet_token");
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

test("方向 A 成功 manifest 不泄露 spreadsheet_token 与 folder_token（url 除外）", async () => {
  const rawSheetToken = "RAW_NEW_SHEET_TOKEN_9999";
  const rawFolderToken = "RAW_FOLDER_TOKEN_8888";
  global.fetch = makeFetchMock({
    spreadsheetToken: rawSheetToken,
    spreadsheetUrl: `https://example.com/sheets/${rawSheetToken}`,
  });
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision, folderToken: rawFolderToken });
  // spreadsheet_token 不作为独立字段暴露（保守默认：仅返回 url）。
  assert.equal("spreadsheetToken" in manifest, false, "不应单独返回 spreadsheet_token 字段");
  // url 允许含资源句柄（用户跳转用）。
  assert.equal(manifest.url, `https://example.com/sheets/${rawSheetToken}`);
  // raw folder_token 不得出现在 manifest 任何位置（含 defaults）。
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes(rawFolderToken), "raw folder_token 不得进入 manifest");
  // defaults.folderToken 必须脱敏（maskToken 形式），非 raw。
  assert.notEqual(manifest.defaults.folderToken, rawFolderToken);
  assert.ok(manifest.defaults.folderToken.length > 0, "defaults.folderToken 应脱敏回显");
  assert.ok(manifest.defaults.folderToken.includes("…"), "defaults.folderToken 应为 maskToken 脱敏形式");
  // sheet error 不得含 raw spreadsheet token。
  for (const r of manifest.sheetResults) {
    assert.ok(!JSON.stringify(r.error ?? {}).includes(rawSheetToken), "sheet error 不得含 raw spreadsheet token");
  }
});

test("方向 A 回读不一致时 verified=false 并记录证据，但不阻断", async () => {
  const fetchMock = makeFetchMock({ verifyDrift: true });
  global.fetch = fetchMock;
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
  const written = manifest.sheetResults.filter((r) => r.result === "written");
  assert.ok(written.length > 0, "应至少有一个 written sheet");
  // 多行 sheet 的回读被裁剪到 1 行 → 行数不足 → verified:false。
  const mismatched = written.filter((r) => r.verified === false);
  assert.ok(mismatched.length > 0, "回读不一致应使受影响 sheet verified:false");
  assert.ok(
    mismatched.every((r) => typeof r.verifyEvidence === "string" && r.verifyEvidence.length > 0),
    "应提供核对证据",
  );
  assert.ok(
    mismatched.every((r) => !(r.verifyEvidence ?? "").includes("TOKEN123")),
    "核对证据不得含 raw spreadsheet token",
  );
  // 写入本身成功：不阻断，failedCount 仍为 0。
  assert.equal(manifest.failedCount, 0, "回读不一致不应计入 failedCount");
  // 即使回读不一致，请求范围也必须是单前缀（确认不是双前缀导致的行为）。
  assert.ok(fetchMock.capturedVerifyRanges.length > 0, "应至少发起一次回读 GET");
  for (const rangePart of fetchMock.capturedVerifyRanges) {
    assert.ok(!rangePart.includes("!!"), `回读范围不得含双重 sheetId 前缀：${rangePart}`);
    assert.equal(
      (rangePart.match(/!/g) ?? []).length,
      1,
      `回读范围应恰好含一个 '!'（单 sheetId 前缀）：${rangePart}`,
    );
  }
});

test("方向 A 回读请求失败时 verified=false 并记录证据", async () => {
  const fetchMock = makeFetchMock({ verifyFail: true });
  global.fetch = fetchMock;
  const { state, revision } = await loadWorkspaceState();
  const manifest = await exportWorkspaceToFeishuSheet({ state, revision });
  const written = manifest.sheetResults.filter((r) => r.result === "written");
  assert.ok(written.length > 0);
  assert.ok(written.every((r) => r.verified === false), "回读失败应标记 verified:false");
  assert.ok(
    written.every((r) => (r.verifyEvidence ?? "").includes("回读失败")),
    "证据应说明回读失败",
  );
  assert.ok(
    written.every((r) => !(r.verifyEvidence ?? "").includes("TOKEN123")),
    "核对证据不得含 raw spreadsheet token",
  );
  // 回读失败不阻断：写入本身成功，failedCount 仍为 0。
  assert.equal(manifest.failedCount, 0);
  // 即便飞书返回错误，请求范围构造仍必须是单前缀（确认失败源于飞书侧而非本地构造错误）。
  assert.ok(fetchMock.capturedVerifyRanges.length > 0, "应至少发起一次回读 GET");
  for (const rangePart of fetchMock.capturedVerifyRanges) {
    assert.ok(!rangePart.includes("!!"), `回读范围不得含双重 sheetId 前缀：${rangePart}`);
    assert.equal(
      (rangePart.match(/!/g) ?? []).length,
      1,
      `回读范围应恰好含一个 '!'（单 sheetId 前缀）：${rangePart}`,
    );
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
