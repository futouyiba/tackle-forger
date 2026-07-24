import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getState } from "../app/api/state/route";
import { GET as getRevisions } from "../app/api/revisions/route";
import { POST as importFile } from "../app/api/import-file/route";
import { POST as accessDataSources } from "../app/api/data-sources/route";
import { GET as inspectWorkbook } from "../app/api/feishu-workbook/route";
import { POST as configExport } from "../app/api/config-export/route";
import { POST as postAssessment } from "../app/api/ai/assessments/route";
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
  feishuRuntimeConfig,
  safeReturnTo,
  type FeishuRuntimeConfig,
} from "../lib/auth-config";
import {
  FeishuOAuthError,
  fetchFeishuIdentity,
} from "../lib/feishu-oauth";
import { PHASE_ONE_CAPABILITIES } from "../lib/feishu-identity";
import { actionAvailability } from "../lib/interaction-contracts";
import { resolveSessionDataDir, sanitizeWorktreeName, detectGitWorktreeName } from "../lib/session-path";

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

test("HTTP 降级只接受显式启用的 RFC 1918 数值 IPv4，或开发环境的 127.0.0.1", async () => {
  const baseEnvironment = {
    FEISHU_ALLOW_INSECURE_HTTP: "true",
    FEISHU_APP_ID: oauthConfig.appId,
    FEISHU_APP_SECRET: oauthConfig.appSecret,
    FEISHU_TENANT_KEY: oauthConfig.tenantKey,
    FEISHU_SESSION_SECRET: oauthConfig.sessionSecret,
  };
  await withEnvironment({
    ...baseEnvironment,
    FEISHU_REDIRECT_URI: "http://10.20.30.40/api/auth/feishu/callback",
  }, async () => {
    assert.equal(
      feishuRuntimeConfig().redirectUri,
      "http://10.20.30.40/api/auth/feishu/callback",
    );
  });
  await withEnvironment({
    ...baseEnvironment,
    NODE_ENV: "development",
    FEISHU_REDIRECT_URI: "http://127.0.0.1:43198/api/auth/feishu/callback",
  }, async () => {
    assert.equal(
      feishuRuntimeConfig().redirectUri,
      "http://127.0.0.1:43198/api/auth/feishu/callback",
    );
  });
  for (const nodeEnv of [undefined, "production"]) {
    await withEnvironment({
      ...baseEnvironment,
      NODE_ENV: nodeEnv,
      FEISHU_REDIRECT_URI: "http://127.0.0.1/api/auth/feishu/callback",
    }, async () => {
      assert.throws(() => feishuRuntimeConfig(), /HTTPS|RFC 1918|127\.0\.0\.1/u);
    });
  }
  for (const hostname of ["localhost", "127.0.0.2", "fdattacker.example", "fc00::1"]) {
    const literal = hostname.includes(":") ? `[${hostname}]` : hostname;
    await withEnvironment({
      ...baseEnvironment,
      NODE_ENV: "development",
      FEISHU_REDIRECT_URI: `http://${literal}/api/auth/feishu/callback`,
    }, async () => {
      assert.throws(() => feishuRuntimeConfig(), /HTTPS|RFC 1918|127\.0\.0\.1/u);
    });
  }
  await withEnvironment({
    ...baseEnvironment,
    NODE_ENV: "development",
    FEISHU_ALLOW_INSECURE_HTTP: "false",
    FEISHU_REDIRECT_URI: "http://127.0.0.1/api/auth/feishu/callback",
  }, async () => {
    assert.throws(() => feishuRuntimeConfig(), /HTTPS|RFC 1918|127\.0\.0\.1/u);
  });
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
      configExport(new NextRequest("http://localhost/api/config-export", { method: "POST" })),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401, 401, 401]);
  });
});

// ---------------------------------------------------------------------------
// Session path derivation (pure function, no filesystem side effects)
// ---------------------------------------------------------------------------

test("resolveSessionDataDir 返回默认 .data/auth (无参数)", () => {
  const result = resolveSessionDataDir({ _cwd: "/tmp/project" });
  assert.equal(result, path.join("/tmp/project", ".data/auth"));
});

test("resolveSessionDataDir 返回默认 .data/auth (空字符串与纯空白)", () => {
  // Empty AND whitespace-only values must trim to "" and be treated as the
  // default.  This is the regression anchor for start-dev.ps1's mirror of
  // `isDefaultPath`: a whitespace-only `FEISHU_SESSION_DATA_DIR` must NOT be
  // misread as an explicit override (which would silently disable worktree
  // isolation).  Each variant falls through to the default ".data/auth".
  for (const explicitEnvPath of ["", "   ", "  \t  ", "\n"]) {
    const result = resolveSessionDataDir({ explicitEnvPath, _cwd: "/tmp/project" });
    assert.equal(result, path.join("/tmp/project", ".data/auth"));
  }
});

test("resolveSessionDataDir 默认路径不被视为显式覆盖", () => {
  // ".data/auth" is the built-in default; auto-isolation should still apply.
  const result = resolveSessionDataDir({
    explicitEnvPath: ".data/auth",
    worktreeName: "my-feature",
    port: 3001,
    _cwd: "/tmp/project",
  });
  assert.equal(result, path.join("/tmp/project", ".data/auth-my-feature-3001"));
});

test("resolveSessionDataDir 纯空白仍走 worktree+port 隔离 (与 start-dev.ps1 等价)", () => {
  // A whitespace-only `FEISHU_SESSION_DATA_DIR` trims to "" and is treated as
  // the default, so worktree+port isolation MUST still apply.  This is the
  // exact regression for the start-dev.ps1 bug where `[string]::IsNullOrEmpty`
  // on the untrimmed value let "   " through as a false explicit override.
  // Covers all the ps1/TS equivalence rows: null / "" / "   " / ".data/auth"
  // (with or without surrounding spaces) are default; absolute and custom
  // relative paths are intentional overrides.
  for (const explicitEnvPath of ["   ", "  .data/auth  "]) {
    const result = resolveSessionDataDir({
      explicitEnvPath,
      worktreeName: "my-feature",
      port: 3001,
      _cwd: "/tmp/project",
    });
    assert.equal(result, path.join("/tmp/project", ".data/auth-my-feature-3001"));
  }
});

test("resolveSessionDataDir 显式非默认路径覆盖所有", () => {
  const result = resolveSessionDataDir({
    explicitEnvPath: "/opt/app/data/auth",
    worktreeName: "my-feature",
    port: 3001,
    _cwd: "/tmp/project",
  });
  // Absolute path — resolved via path.resolve(cwd, path) so platform-
  // dependent drive-letter prefix may appear on Windows.
  assert.equal(result, path.resolve("/opt/app/data/auth"));
});

test("resolveSessionDataDir 显式相对路径不被默认覆盖", () => {
  const result = resolveSessionDataDir({
    explicitEnvPath: "custom/auth/path",
    worktreeName: "ignored",
    port: 9999,
    _cwd: "/tmp/project",
  });
  assert.equal(result, path.resolve("/tmp/project", "custom/auth/path"));
});

test("resolveSessionDataDir worktree+port 隔离", () => {
  const result = resolveSessionDataDir({
    worktreeName: "v3-work",
    port: 3000,
    _cwd: "/tmp/project",
  });
  assert.equal(result, path.join("/tmp/project", ".data/auth-v3-work-3000"));
});

test("resolveSessionDataDir 不同端口产生不同路径", () => {
  const r1 = resolveSessionDataDir({ worktreeName: "feat-a", port: 3000, _cwd: "/tmp" });
  const r2 = resolveSessionDataDir({ worktreeName: "feat-a", port: 3001, _cwd: "/tmp" });
  assert.notEqual(r1, r2);
});

test("resolveSessionDataDir 不同 worktree 产生不同路径", () => {
  const r1 = resolveSessionDataDir({ worktreeName: "feat-a", port: 3000, _cwd: "/tmp" });
  const r2 = resolveSessionDataDir({ worktreeName: "feat-b", port: 3000, _cwd: "/tmp" });
  assert.notEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// sanitizeWorktreeName
// ---------------------------------------------------------------------------

test("sanitizeWorktreeName 保持安全字符", () => {
  assert.equal(sanitizeWorktreeName("my-feature_branch.v3"), "my-feature_branch.v3");
});

test("sanitizeWorktreeName 替换不安全字符", () => {
  assert.equal(sanitizeWorktreeName("bad/name:3000?"), "bad_name_3000_");
});

test("sanitizeWorktreeName 空字符串返回 fallback", () => {
  assert.equal(sanitizeWorktreeName(""), "unknown-worktree");
});

// ---------------------------------------------------------------------------
// detectGitWorktreeName
// ---------------------------------------------------------------------------

test("detectGitWorktreeName 主检出返回 undefined", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-main-"));
  await rm(tmp, { recursive: true, force: true });
  // No .git at all → undefined
  assert.equal(detectGitWorktreeName(tmp), undefined);
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

test("detectGitWorktreeName worktree 文件返回正确名称", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-wt-"));
  try {
    const gitFile = path.join(tmp, ".git");
    await writeFile(
      gitFile,
      "gitdir: E:/DocsHDD/tackleForger/.git/worktrees/agent-a606cb391fdc5dbaa\n",
      "utf8",
    );
    assert.equal(detectGitWorktreeName(tmp), "agent-a606cb391fdc5dbaa");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectGitWorktreeName 解析 Windows 反斜杠路径", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-wt2-"));
  try {
    const gitFile = path.join(tmp, ".git");
    await writeFile(
      gitFile,
      "gitdir: E:\\DocsHDD\\tackleForger\\.git\\worktrees\\v3-work\n",
      "utf8",
    );
    assert.equal(detectGitWorktreeName(tmp), "v3-work");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// auth-store 使用 resolveSessionDataDir (indirect coverage)
// ---------------------------------------------------------------------------

test("auth-store 使用 resolveSessionDataDir 确定会话目录", async () => {
  // When FEISHU_SESSION_DATA_DIR is set, auth-store should write into that dir.
  const dir = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-auth-indirect-"));
  try {
    await withEnvironment({ FEISHU_SESSION_DATA_DIR: dir }, async () => {
      // Trigger auth-store operations that touch the filesystem.
      const { createSession, findSession, newOpaqueId } = await import("../lib/auth-store");
      const sessionId = newOpaqueId();
      const now = new Date("2026-07-24T00:00:00Z");
      await createSession({
        sessionId,
        secret: "s".repeat(32),
        ttlSeconds: 60,
        now,
        identity: {
          tenantKey: "tenant",
          openId: "user",
          displayName: "test",
          lastLoginAt: now.toISOString(),
        },
      });
      const found = await findSession({ sessionId, secret: "s".repeat(32), now });
      assert.ok(found);
      assert.equal(found.identity.displayName, "test");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Mock OAuth flow (no real Feishu network)
// ---------------------------------------------------------------------------

test("Mock OAuth 完整流程不访问真实飞书", async () => {
  const { consumePendingLogin, createSession, findSession, newOpaqueId, savePendingLogin }
    = await import("../lib/auth-store");
  const { fetchFeishuIdentity } = await import("../lib/feishu-oauth");

  const config = {
    appId: "mock-app",
    appSecret: "mock-secret",
    tenantKey: "mock-tenant",
    redirectUri: "https://mock.example/callback",
    sessionSecret: "z".repeat(32),
    sessionTtlSeconds: 3600,
    openApiBaseUrl: "https://open.feishu.mock",
    accountsBaseUrl: "https://accounts.feishu.mock",
    oauthScopes: "contact:user.base:readonly",
  };

  // Simulate OAuth token exchange with mock fetch.
  const tokenResponse = Response.json({ code: 0, access_token: "mock-access-token" });
  const userResponse = Response.json({
    code: 0,
    data: {
      tenant_key: "mock-tenant",
      open_id: "mock-open-id",
      name: "Mock User",
    },
  });

  let fetchCallCount = 0;
  const mockFetch = async (input: URL | RequestInfo, _init?: RequestInit) => {
    fetchCallCount++;
    const url = String(input);
    if (url.includes("oauth/token")) return tokenResponse;
    if (url.includes("user_info")) return userResponse;
    throw new Error("unexpected fetch");
  };

  const identity = await fetchFeishuIdentity({
    code: "mock-auth-code",
    config,
    fetchImpl: mockFetch as typeof fetch,
  });
  assert.equal(fetchCallCount, 2);
  assert.equal(identity.tenantKey, "mock-tenant");
  assert.equal(identity.openId, "mock-open-id");
  assert.equal(identity.displayName, "Mock User");

  // Complete the flow: save pending login → create session → find session.
  const secret = config.sessionSecret;
  const state = newOpaqueId();
  await savePendingLogin({ state, secret, returnTo: "/" });
  assert.ok(await consumePendingLogin({ state, secret }));

  const sessionId = newOpaqueId();
  await createSession({
    sessionId,
    secret,
    ttlSeconds: 60,
    identity,
    now: new Date("2026-07-24T00:00:00Z"),
  });
  const found = await findSession({
    sessionId,
    secret,
    now: new Date("2026-07-24T00:00:00Z"),
  });
  assert.ok(found);
  assert.equal(found.identity.openId, "mock-open-id");
});

// ---------------------------------------------------------------------------
// 403: authenticated but lacking a required capability
// ---------------------------------------------------------------------------

test("可信代理已登录但缺少 capability 时返回 403", async () => {
  // The trusted-proxy identity gets PHASE_ONE_CAPABILITIES but NOT
  // "ai.provider_policy.manage", so an action that requires it must
  // be disabled with CAPABILITY_MISSING.
  await withEnvironment({
    FEISHU_TRUST_PROXY_HEADERS: "true",
    FEISHU_PROXY_SHARED_SECRET: "test-secret",
    FEISHU_TENANT_KEY: "tenant",
  }, async () => {
    const user = await requestUser(new NextRequest("http://localhost", {
      headers: {
        "x-feishu-tenant-key": "tenant",
        "x-feishu-open-id": "user",
        "x-feishu-display-name": "tester",
        "x-tf-proxy-secret": "test-secret",
      },
    }));
    assert.equal(user.authenticated, true);
    const action = user.actionAvailability.manage_ai_provider_policy;
    assert.equal(action.enabled, false);
    assert.equal(action.disabledReasonCode, "CAPABILITY_MISSING");
  });
});

test("已登录身份调用受保护写路由被拦截：真实 HTTP 403 且无写副作用", async () => {
  // The trusted-proxy identity is authenticated, but `run_ai_assessment` is
  // disabled (AI connector not enabled in this environment).  POSTing to the
  // protected assessment write route must return a REAL HTTP 403 from the
  // route handler, BEFORE any assessment is persisted — i.e. no write side
  // effects.  This complements the ActionAvailability-only assertion above
  // with an end-to-end gate check.
  const retentionDir = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-403-retention-"));
  try {
    await withEnvironment({
      FEISHU_TRUST_PROXY_HEADERS: "true",
      FEISHU_PROXY_SHARED_SECRET: "test-secret",
      FEISHU_TENANT_KEY: "tenant",
      // Fancy Hub / AI runtime intentionally NOT enabled → run_ai_assessment
      // disabled → the route must 403.  AI_RETENTION_DATA_DIR is pointed at a
      // temp dir so we can prove the 403 gate prevented any assessment write.
      FANCY_HUB_ENABLED: undefined,
      AI_RETENTION_DATA_DIR: retentionDir,
    }, async () => {
      const request = new NextRequest("http://localhost/api/ai/assessments", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-feishu-tenant-key": "tenant",
          "x-feishu-open-id": "user",
          "x-feishu-display-name": "tester",
          "x-tf-proxy-secret": "test-secret",
        },
        body: JSON.stringify({ scopeType: "series", scopeId: "series-test" }),
      });
      const response = await postAssessment(request);
      assert.equal(response.status, 403);
      const body = (await response.json()) as { actionAvailability?: { enabled?: boolean } };
      assert.equal(body.actionAvailability?.enabled, false);
      // The 403 must fire before the assessment is stored: no records may be
      // written to the retention directory.
      const entries = await readdir(retentionDir);
      assert.deepEqual(entries, [], "受 403 拦截的评估请求不得写入留存目录");
    });
  } finally {
    await rm(retentionDir, { recursive: true, force: true });
  }
});
