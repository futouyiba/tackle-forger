import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../app/api/feishu-workbook/route";
import { FeishuApiError, type FeishuApiErrorInfo } from "../lib/feishu-api-error";
import { readFeishuSheetRange, resolveWikiSpreadsheetToken } from "../lib/feishu-sheets";
import { setCanonicalRuleWorkbookInspectionForTests } from "../lib/rule-workbook-inspection";

// feishuTenantAccessToken 在调用 fetch 前校验这两个环境变量；测试里给占位值，
// 真正的 HTTP 由各用例 mock 的 global.fetch 返回。
process.env.FEISHU_APP_ID = "obs-test-app-id";
process.env.FEISHU_APP_SECRET = "obs-test-app-secret";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenFetchMock(): typeof fetch {
  return (async (url) => {
    const u = String(url);
    if (u.includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "t-obs", expire: 7200 });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
}

const trustedProxyEnv = {
  FEISHU_TRUST_PROXY_HEADERS: process.env.FEISHU_TRUST_PROXY_HEADERS,
  FEISHU_PROXY_SHARED_SECRET: process.env.FEISHU_PROXY_SHARED_SECRET,
  FEISHU_TENANT_KEY: process.env.FEISHU_TENANT_KEY,
};

before(() => {
  // 提前填充 tenant_access_token 缓存，避免后续用例因 env/cache 顺序抖动。
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "obs-test-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
});

after(() => {
  setCanonicalRuleWorkbookInspectionForTests();
  for (const [key, value] of Object.entries(trustedProxyEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("readFeishuSheetRange：飞书返回非 0 code 时抛 FeishuApiError 携带 code/endpoint/tokenContext", async () => {
  const originalFetch = global.fetch;
  global.fetch = tokenFetchMock();
  try {
    const fetcher = (async (url) => {
      const u = String(url);
      if (u.includes("/values/")) {
        return jsonResponse({ code: 1254030, msg: "无权限读取该电子表格" }, 200);
      }
      return jsonResponse({ code: 0 });
    }) as typeof fetch;
    await assert.rejects(
      readFeishuSheetRange({
        spreadsheetToken: "SPREAD1234567890ABCDEFG",
        sheetId: "sh",
        range: "A1:A1",
        fetcher,
      }),
      (error: unknown) => {
        assert.ok(error instanceof FeishuApiError, "应当抛出 FeishuApiError");
        const apiError = error as FeishuApiError;
        assert.equal(apiError.code, 1254030);
        assert.equal(apiError.feishuMsg, "无权限读取该电子表格");
        assert.equal(apiError.httpStatus, 200);
        assert.match(apiError.endpoint, /^\/open-apis\/sheets\/v2\/spreadsheets\/.+\/values\//);
        assert.match(apiError.tokenContext ?? "", /^spreadsheet:SPREAD.*DEFG$/);
        assert.match(apiError.message, /飞书电子表格接口失败/);
        assert.match(apiError.message, /code=1254030/);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveWikiSpreadsheetToken：wiki get_node 失败抛 FeishuApiError 携带 wiki tokenContext", async () => {
  const originalFetch = global.fetch;
  global.fetch = tokenFetchMock();
  try {
    const fetcher = (async (url) => {
      const u = String(url);
      if (u.includes("/wiki/v2/spaces/get_node")) {
        return jsonResponse({ code: 1254003, msg: "节点不存在或无权限" }, 200);
      }
      return jsonResponse({ code: 0 });
    }) as typeof fetch;
    await assert.rejects(
      resolveWikiSpreadsheetToken({ wikiToken: "WIKITOKEN12345678" } as never, fetcher),
      (error: unknown) => {
        assert.ok(error instanceof FeishuApiError, "应当抛出 FeishuApiError");
        const apiError = error as FeishuApiError;
        assert.equal(apiError.code, 1254003);
        assert.equal(apiError.feishuMsg, "节点不存在或无权限");
        // query string 必须被剥离，端点只保留 open-apis 路径
        assert.equal(apiError.endpoint, "/open-apis/wiki/v2/spaces/get_node");
        assert.match(apiError.tokenContext ?? "", /^wiki:WIKITO.+5678$/);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET /api/feishu-workbook：飞书接口失败时返回 502 含 errorInfo 并写 server 日志", async () => {
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = ((...args: unknown[]) => {
    logged.push(args);
  }) as typeof console.error;

  const feishuError = new FeishuApiError({
    reason: "飞书电子表格接口失败",
    code: 1254030,
    msg: "无权限",
    httpStatus: 200,
    endpoint: "/open-apis/sheets/v3/spreadsheets/TOKEN/sheets/query",
    tokenContext: "spreadsheet:TOKEN",
  });
  setCanonicalRuleWorkbookInspectionForTests(async () => {
    throw feishuError;
  });

  try {
    const request = new NextRequest("http://localhost/api/feishu-workbook", {
      headers: {
        "content-type": "application/json",
        "x-feishu-tenant-key": "tenant",
        "x-feishu-open-id": "obs-tester",
        "x-feishu-display-name": "obs-tester",
        "x-tf-proxy-secret": "obs-test-secret",
      },
    });
    const response = await GET(request);
    assert.equal(response.status, 502, "失败仍 fail-closed 返回 502");
    const body = (await response.json()) as { error: string; errorInfo: FeishuApiErrorInfo };
    assert.match(body.error, /飞书电子表格接口失败/);
    // errorInfo 携带结构化诊断字段，但不含任何 tokenContext
    assert.deepEqual(body.errorInfo, {
      code: 1254030,
      msg: "无权限",
      endpoint: "/open-apis/sheets/v3/spreadsheets/TOKEN/sheets/query",
      httpStatus: 200,
    });
    assert.equal("tokenContext" in body.errorInfo, false, "errorInfo 不得泄露 tokenContext");

    assert.ok(logged.length > 0, "必须写 server 日志 (console.error)");
    const serialized = JSON.stringify(logged);
    assert.ok(serialized.includes("1254030"), "server 日志应包含飞书 code");
    assert.ok(
      serialized.includes("/open-apis/sheets/v3/spreadsheets/TOKEN/sheets/query"),
      "server 日志应包含出错的 endpoint",
    );
    assert.ok(serialized.includes("spreadsheet:TOKEN"), "server 日志应包含脱敏 tokenContext");
  } finally {
    setCanonicalRuleWorkbookInspectionForTests();
    console.error = originalError;
  }
});

test("GET /api/feishu-workbook：非 FeishuApiError 的普通错误也写 server 日志且 errorInfo 缺省", async () => {
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = ((...args: unknown[]) => {
    logged.push(args);
  }) as typeof console.error;
  setCanonicalRuleWorkbookInspectionForTests(async () => {
    throw new Error("飞书未返回工作簿 revision。");
  });
  try {
    const request = new NextRequest("http://localhost/api/feishu-workbook", {
      headers: {
        "content-type": "application/json",
        "x-feishu-tenant-key": "tenant",
        "x-feishu-open-id": "obs-tester-2",
        "x-feishu-display-name": "obs-tester-2",
        "x-tf-proxy-secret": "obs-test-secret",
      },
    });
    const response = await GET(request);
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string; errorInfo?: FeishuApiErrorInfo };
    assert.match(body.error, /飞书未返回工作簿 revision/);
    assert.equal(body.errorInfo, undefined, "普通错误的 errorInfo 缺省");
    assert.ok(logged.length > 0, "普通错误同样要写 server 日志");
  } finally {
    setCanonicalRuleWorkbookInspectionForTests();
    console.error = originalError;
  }
});
