import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getState } from "../app/api/state/route";
import { GET as getRevisions } from "../app/api/revisions/route";
import { POST as importFile } from "../app/api/import-file/route";
import { POST as accessDataSources } from "../app/api/data-sources/route";
import { GET as inspectWorkbook } from "../app/api/feishu-workbook/route";
import { GET as startLogin } from "../app/api/auth/feishu/start/route";
import { requestUser } from "../lib/auth";
import {
  consumePendingLogin,
  createSession,
  findSession,
  newOpaqueId,
  savePendingLogin,
} from "../lib/auth-store";
import {
  safeReturnTo,
  type FeishuRuntimeConfig,
} from "../lib/auth-config";
import {
  FeishuOAuthError,
  fetchFeishuIdentity,
} from "../lib/feishu-oauth";
import { PHASE_ONE_CAPABILITIES } from "../lib/feishu-identity";
import { actionAvailability } from "../lib/interaction-contracts";

const authDataDir = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-auth-"));
process.env.FEISHU_SESSION_DATA_DIR = authDataDir;
test.after(async () => {
  await rm(authDataDir, { recursive: true, force: true });
});

const oauthConfig: FeishuRuntimeConfig = {
  appId: "app-id",
  appSecret: "app-secret",
  tenantKey: "tenant",
  redirectUri: "https://tackle.example/api/auth/feishu/callback",
  sessionSecret: "s".repeat(32),
  sessionTtlSeconds: 3600,
  openApiBaseUrl: "https://open.feishu.example",
  accountsBaseUrl: "https://accounts.feishu.example",
  oauthScopes: "contact:user.base:readonly",
};

function sequenceFetch(...steps: Array<Response | Error>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const step = steps.shift();
    if (!step) throw new Error("缺少 mock 响应");
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

async function withEnvironment(
  values: Record<string, string | undefined>,
  operation: () => Promise<void>,
) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
    await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
  }
}

test("登录回跳只允许本站相对路径", () => {
  assert.equal(safeReturnTo("/?page=overview"), "/?page=overview");
  assert.equal(safeReturnTo("//evil.example"), "/");
  assert.equal(safeReturnTo("https://evil.example"), "/");
  assert.equal(safeReturnTo("/\\evil.example"), "/");
});

test("OAuth state 支持正常消费、过期和防重放", async () => {
  const state = newOpaqueId();
  const secret = "x".repeat(32);
  const now = new Date("2026-07-22T00:00:00Z");
  await savePendingLogin({ state, secret, returnTo: "/safe", ttlSeconds: 60, now });
  assert.equal(
    await consumePendingLogin({ state: "wrong", secret, now }),
    undefined,
  );
  assert.equal(
    (await consumePendingLogin({ state, secret, now: new Date(now.getTime() + 59_000) }))?.returnTo,
    "/safe",
  );
  assert.equal(await consumePendingLogin({ state, secret, now }), undefined);

  const expired = newOpaqueId();
  await savePendingLogin({ state: expired, secret, returnTo: "/", ttlSeconds: 60, now });
  assert.equal(
    await consumePendingLogin({ state: expired, secret, now: new Date(now.getTime() + 60_000) }),
    undefined,
  );
});

test("会话使用不透明 ID、可持久读取并在绝对时间过期", async () => {
  const sessionId = newOpaqueId();
  const secret = "y".repeat(32);
  const now = new Date("2026-07-22T00:00:00Z");
  assert.ok(sessionId.length >= 40);
  await createSession({
    sessionId,
    secret,
    ttlSeconds: 60,
    now,
    identity: {
      tenantKey: "tenant",
      openId: "user",
      displayName: "用户",
      lastLoginAt: now.toISOString(),
    },
  });
  assert.ok(await findSession({ sessionId, secret, now: new Date(now.getTime() + 59_000) }));
  assert.equal(
    await findSession({ sessionId, secret, now: new Date(now.getTime() + 60_000) }),
    undefined,
  );
});

test("OAuth 仅返回最小身份，令牌不会进入返回值", async () => {
  const mocks = sequenceFetch(
    Response.json({ code: 0, access_token: "access-secret" }),
    Response.json({
      code: 0,
      data: {
        tenant_key: "tenant",
        open_id: "open-id",
        name: "策划",
      },
    }),
  );
  const identity = await fetchFeishuIdentity({
    code: "authorization-code",
    config: oauthConfig,
    fetchImpl: mocks.fetchImpl,
    now: new Date("2026-07-22T00:00:00Z"),
  });
  assert.deepEqual(identity, {
    tenantKey: "tenant",
    openId: "open-id",
    displayName: "策划",
    avatarUrl: undefined,
    lastLoginAt: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(identity).includes("access-secret"), false);
  assert.equal(mocks.calls[1]?.init?.headers instanceof Headers, false);
  assert.deepEqual(mocks.calls[1]?.init?.headers, {
    authorization: "Bearer access-secret",
  });
});

test("OAuth 将网络、HTTP、供应方和畸形响应分开处理", async () => {
  const cases: Array<{ steps: Array<Response | Error>; reason: FeishuOAuthError["reason"] }> = [
    { steps: [new Error("network")], reason: "network" },
    { steps: [new Response("", { status: 502 })], reason: "http" },
    { steps: [Response.json({ code: 1 })], reason: "provider" },
    { steps: [new Response("{", { status: 200 })], reason: "malformed" },
    {
      steps: [Response.json({ code: 0, access_token: "token" }), new Error("network")],
      reason: "network",
    },
    {
      steps: [Response.json({ code: 0, access_token: "token" }), Response.json({ code: 0, data: {} })],
      reason: "malformed",
    },
  ];
  for (const entry of cases) {
    const mocks = sequenceFetch(...entry.steps);
    await assert.rejects(
      fetchFeishuIdentity({ code: "code", config: oauthConfig, fetchImpl: mocks.fetchImpl }),
      (error) => error instanceof FeishuOAuthError && error.reason === entry.reason,
    );
  }
});

test("伪造飞书身份头默认无效，可信代理必须同时匹配共享密钥和租户", async () => {
  const headers = {
    "x-feishu-tenant-key": "tenant",
    "x-feishu-open-id": "user",
    "x-feishu-display-name": "planner",
    "x-tf-proxy-secret": "proxy-secret",
  };
  await withEnvironment({
    FEISHU_TRUST_PROXY_HEADERS: undefined,
    FEISHU_PROXY_SHARED_SECRET: "proxy-secret",
    FEISHU_TENANT_KEY: "tenant",
  }, async () => {
    const user = await requestUser(new NextRequest("http://localhost", { headers }));
    assert.equal(user.authenticated, false);
  });
  await withEnvironment({
    FEISHU_TRUST_PROXY_HEADERS: "true",
    FEISHU_PROXY_SHARED_SECRET: "proxy-secret",
    FEISHU_TENANT_KEY: "tenant",
  }, async () => {
    const user = await requestUser(new NextRequest("http://localhost", { headers }));
    assert.equal(user.authenticated, true);
    assert.equal(user.openId, "user");
    assert.equal(user.actionAvailability.run_ai_assessment.enabled, false);
    assert.equal(user.actionAvailability.run_ai_assessment.disabledReasonCode, "AI_CONNECTOR_DISABLED");
    for (const action of [
      "create_ai_patch_draft",
      "create_ai_rule_source_change_draft",
    ] as const) {
      assert.equal(user.actionAvailability[action].enabled, false);
      assert.equal(user.actionAvailability[action].disabledReasonCode, "AI_RETENTION_CONFIG_INVALID");
    }
  });
});

test("Fancy Hub 暂停时仍可从可用留存创建草稿，只有新评估被阻断", async () => {
  const headers = {
    "x-feishu-tenant-key": "tenant",
    "x-feishu-open-id": "user",
    "x-feishu-display-name": "planner",
    "x-tf-proxy-secret": "proxy-secret",
  };
  await withEnvironment({
    FEISHU_TRUST_PROXY_HEADERS: "true",
    FEISHU_PROXY_SHARED_SECRET: "proxy-secret",
    FEISHU_TENANT_KEY: "tenant",
    FANCY_HUB_ENABLED: undefined,
    AI_RETENTION_DATA_DIR: "/tmp/tackle-forger-auth-retention",
    AI_RETENTION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 19).toString("base64"),
    AI_RETENTION_ENCRYPTION_KEY_VERSION: "auth-test-v1",
  }, async () => {
    const user = await requestUser(new NextRequest("http://localhost", { headers }));
    assert.equal(user.actionAvailability.run_ai_assessment.enabled, false);
    assert.equal(user.actionAvailability.run_ai_assessment.disabledReasonCode, "AI_CONNECTOR_DISABLED");
    assert.equal(user.actionAvailability.create_ai_patch_draft.enabled, true);
    assert.equal(user.actionAvailability.create_ai_rule_source_change_draft.enabled, true);
  });
});

test("统一业务 Capability 不会向普通公司用户开放部署管理员 AI 安全配置", () => {
  assert.equal(new Set<string>(PHASE_ONE_CAPABILITIES).has("ai.provider_policy.manage"), false);
  const ordinary = actionAvailability("manage_ai_provider_policy", PHASE_ONE_CAPABILITIES);
  assert.equal(ordinary.enabled, false);
  assert.equal(ordinary.disabledReasonCode, "CAPABILITY_MISSING");
  assert.deepEqual(ordinary.requiredCapabilities, ["ai.provider_policy.manage"]);
  assert.equal(
    actionAvailability("manage_ai_provider_policy", ["ai.provider_policy.manage"]).enabled,
    true,
  );
});

test("OAuth 起点设置安全的短期 HttpOnly Cookie", async () => {
  await withEnvironment({
    FEISHU_APP_ID: oauthConfig.appId,
    FEISHU_APP_SECRET: oauthConfig.appSecret,
    FEISHU_TENANT_KEY: oauthConfig.tenantKey,
    FEISHU_REDIRECT_URI: oauthConfig.redirectUri,
    FEISHU_SESSION_SECRET: oauthConfig.sessionSecret,
    FEISHU_OPEN_API_BASE_URL: oauthConfig.openApiBaseUrl,
    FEISHU_ACCOUNTS_BASE_URL: oauthConfig.accountsBaseUrl,
    FEISHU_OAUTH_SCOPES: oauthConfig.oauthScopes,
  }, async () => {
    const response = await startLogin(
      new NextRequest("https://tackle.example/api/auth/feishu/start?return_to=%2F%3Fpage%3Doverview"),
    );
    assert.equal(response.status, 307);
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /tf_feishu_pending=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /Path=\//i);
    assert.equal(cookie.includes(oauthConfig.appSecret), false);
  });
});

test("所有业务 API 对未登录统一返回 401，而不是服务不可用", async () => {
  await withEnvironment({ FEISHU_TRUST_PROXY_HEADERS: "false" }, async () => {
    const requests: Array<Promise<Response>> = [
      getState(new NextRequest("http://localhost/api/state")),
      getRevisions(new NextRequest("http://localhost/api/revisions")),
      importFile(new NextRequest("http://localhost/api/import-file", { method: "POST" })),
      accessDataSources(new NextRequest("http://localhost/api/data-sources", { method: "POST" })),
      inspectWorkbook(new NextRequest("http://localhost/api/feishu-workbook")),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401, 401]);
  });
});
