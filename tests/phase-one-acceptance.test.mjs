import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXPECTED_CANONICAL_SHEETS,
  EXPECTED_PHASE_ONE_CAPABILITIES,
  inspectDependencyManifest,
  inspectRuntimePathFilesystem,
  inspectRuntimePaths,
  readSecureEnvironmentFile,
  readSessionCookieFile,
  runAuthenticatedReadOnlySmoke,
  runPreflight,
  runPublicSmoke,
  writeEvidenceFile,
} from "../scripts/phase-one-acceptance.mjs";

function mockFetch(routes) {
  return async (input) => {
    const url = new URL(input);
    const result = routes[url.pathname];
    if (!result) return new Response("missing mock", { status: 500 });
    if (typeof result === "function") return result(url);
    return result.clone();
  };
}

function json(value, status = 200, headers = undefined) {
  return Response.json(value, { status, headers });
}

function smokeEnv(overrides = {}) {
  return {
    FEISHU_ACCOUNTS_BASE_URL: "https://accounts.feishu.cn",
    FEISHU_APP_ID: "cli_public",
    FEISHU_APP_SECRET: "super-secret-value",
    FEISHU_CANONICAL_SPREADSHEET_TOKEN: "workbook-token-secret",
    FEISHU_REDIRECT_URI: "https://tackle.internal/api/auth/feishu/callback",
    FEISHU_TENANT_KEY: "tenant-secret-id",
    FEISHU_OAUTH_SCOPES: "contact:user.base:readonly",
    ...overrides,
  };
}

function canonicalSheets() {
  return [...EXPECTED_CANONICAL_SHEETS].map(([sheetId, name]) => ({ sheetId, name }));
}

function canonicalInspection(overrides = {}) {
  const sourceRevision = {
    id: "feishu-source-revision:4000",
    workbookRefId: "feishu-workbook:tackle-design",
    spreadsheetToken: "workbook-token-secret",
    sourceRevision: "revision-4000",
    registryHash: "registry-hash",
    sheets: canonicalSheets(),
    issues: [],
    ...(overrides.sourceRevision ?? {}),
  };
  const identityRows = overrides.identityRows ?? [
    { sheetId: "d6e928", rowKey: "4", stableId: "weight_template:1" },
    { sheetId: "fATowU", rowKey: "2", stableId: "type:1" },
  ];
  return {
    sourceRevision,
    identityRows,
    identityReport: {
      workbookRefId: "feishu-workbook:tackle-design",
      sourceRevision: sourceRevision.sourceRevision,
      items: identityRows.map((row, index) => ({
        itemId: `identity:${index}`,
        state: "ALREADY_IDENTIFIED",
        requiresHumanConfirmation: false,
      })),
      blockingIssueCodes: [],
      ...(overrides.identityReport ?? {}),
    },
    qualityDraft: {
      sourceRevisionId: sourceRevision.id,
      sourceRevision: sourceRevision.sourceRevision,
      formalStatus: "READY_TO_PUBLISH",
      issues: [],
      ...(overrides.qualityDraft ?? {}),
    },
    pricingDraft: {
      sourceRevisionId: sourceRevision.id,
      sourceRevision: sourceRevision.sourceRevision,
      formalStatus: "TRIAL_READY",
      issues: [],
      ...(overrides.pricingDraft ?? {}),
    },
    pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND",
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => ![
        "sourceRevision",
        "identityRows",
        "identityReport",
        "qualityDraft",
        "pricingDraft",
      ].includes(key)),
    ),
  };
}

function publicRoutes() {
  let stateSequence = 0;
  return {
    "/": new Response("<html>ok</html>", { status: 200 }),
    "/api/auth/session": json({
      authenticated: false,
      errorCode: "AUTH-SESSION-001",
    }, 401),
    "/api/auth/feishu/start": () => {
      stateSequence += 1;
      const state = `opaque-state-${stateSequence.toString().padStart(8, "0")}`;
      const redirect = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
      redirect.searchParams.set("client_id", "cli_public");
      redirect.searchParams.set("redirect_uri", "https://tackle.internal/api/auth/feishu/callback");
      redirect.searchParams.set("state", state);
      redirect.searchParams.set("scope", "contact:user.base:readonly");
      return new Response(null, {
        status: 307,
        headers: {
          location: redirect.toString(),
          "set-cookie": `tf_feishu_pending=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    },
    "/api/state": json({ error: "login" }, 401),
    "/api/revisions": json({ error: "login" }, 401),
    "/api/feishu-workbook": json({ error: "login" }, 401),
  };
}

test("未登录 smoke 只读核对入口、OAuth state Cookie 与 API 身份边界", async () => {
  const evidence = await runPublicSmoke({
    baseUrl: "https://tackle.internal",
    env: smokeEnv(),
    fetchImpl: mockFetch(publicRoutes()),
  });
  assert.equal(evidence.summary.overall, "PASS");
  assert.equal(evidence.checks.find((item) => item.id === "oauth_start")?.status, "PASS");
  assert.equal(JSON.stringify(evidence).includes("opaque-state"), false);
  assert.equal(JSON.stringify(evidence).includes("super-secret-value"), false);
});

test("未配置真实 OAuth 时 public smoke 明确 BLOCKED，不冒充环境通过", async () => {
  const routes = publicRoutes();
  routes["/api/auth/session"] = json({
    authenticated: false,
    errorCode: "AUTH-CONFIG-001",
  }, 503);
  routes["/api/auth/feishu/start"] = json({ error: "missing config" }, 503);
  const evidence = await runPublicSmoke({
    baseUrl: "https://tackle.internal",
    env: smokeEnv(),
    fetchImpl: mockFetch(routes),
  });
  assert.equal(evidence.summary.overall, "BLOCKED");
  assert.equal(
    evidence.checks.find((item) => item.id === "anonymous_session")?.status,
    "BLOCKED",
  );
});

test("OAuth 起点拒绝重复 state、错误授权来源和错误登记回调", async () => {
  const routes = publicRoutes();
  routes["/api/auth/feishu/start"] = () => {
    const redirect = new URL("https://attacker.example/open-apis/authen/v1/authorize");
    redirect.searchParams.set("client_id", "cli_public");
    redirect.searchParams.set("redirect_uri", "https://other.internal/api/auth/feishu/callback");
    redirect.searchParams.set("state", "fixed-state-00000000");
    redirect.searchParams.set("scope", "contact:user.base:readonly");
    return new Response(null, {
      status: 307,
      headers: {
        location: redirect.toString(),
        "set-cookie": "tf_feishu_pending=fixed-state-00000000; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
      },
    });
  };
  const evidence = await runPublicSmoke({
    baseUrl: "https://tackle.internal",
    env: smokeEnv(),
    fetchImpl: mockFetch(routes),
  });
  const oauth = evidence.checks.find((item) => item.id === "oauth_start");
  assert.equal(oauth?.status, "FAIL");
  assert.equal(oauth?.evidence?.statesDistinct, false);
  assert.equal(JSON.stringify(evidence).includes("fixed-state-00000000"), false);
});

test("OAuth pending Cookie 必须唯一并精确包含安全属性与 600 秒过期", async () => {
  const routes = publicRoutes();
  let sequence = 0;
  routes["/api/auth/feishu/start"] = () => {
    sequence += 1;
    const state = `cookie-state-${sequence.toString().padStart(8, "0")}`;
    const redirect = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    redirect.searchParams.set("client_id", "cli_public");
    redirect.searchParams.set("redirect_uri", "https://tackle.internal/api/auth/feishu/callback");
    redirect.searchParams.set("state", state);
    redirect.searchParams.set("scope", "contact:user.base:readonly");
    const headers = new Headers({ location: redirect.toString() });
    headers.append(
      "set-cookie",
      `tf_feishu_pending=${state}; Path=/evil; HttpOnlyX; Max-Age=3600; Priority=High`,
    );
    headers.append("set-cookie", "helper=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600");
    return new Response(null, { status: 307, headers });
  };
  const evidence = await runPublicSmoke({
    baseUrl: "https://tackle.internal",
    env: smokeEnv(),
    fetchImpl: mockFetch(routes),
  });
  assert.equal(
    evidence.checks.find((item) => item.id === "oauth_start")?.status,
    "FAIL",
  );
});

test("OAuth 响应 Cookie 中回显配置密钥时验收 FAIL 且不保存密钥", async () => {
  const routes = publicRoutes();
  const start = routes["/api/auth/feishu/start"];
  routes["/api/auth/feishu/start"] = (url) => {
    const response = start(url);
    const headers = new Headers(response.headers);
    headers.append("set-cookie", "debug=super-secret-value; Path=/; HttpOnly");
    return new Response(null, { status: response.status, headers });
  };
  const evidence = await runPublicSmoke({
    baseUrl: "https://tackle.internal",
    env: smokeEnv(),
    fetchImpl: mockFetch(routes),
  });
  assert.equal(evidence.summary.overall, "FAIL");
  assert.equal(evidence.checks.find((item) => item.id === "oauth_start")?.status, "FAIL");
  assert.equal(JSON.stringify(evidence).includes("super-secret-value"), false);
});

test("OAuth 起点必须精确匹配配置的 app id、scope 且参数不可重复", async () => {
  const routes = publicRoutes();
  let sequence = 0;
  routes["/api/auth/feishu/start"] = () => {
    sequence += 1;
    const state = `client-state-${sequence.toString().padStart(8, "0")}`;
    const redirect = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    redirect.searchParams.append("client_id", "attacker-app");
    redirect.searchParams.append("client_id", "cli_public");
    redirect.searchParams.set("redirect_uri", "https://tackle.internal/api/auth/feishu/callback");
    redirect.searchParams.set("state", state);
    redirect.searchParams.set("scope", "contact:user.base:readonly");
    return new Response(null, {
      status: 307,
      headers: {
        location: redirect.toString(),
        "set-cookie": `tf_feishu_pending=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  };
  const evidence = await runPublicSmoke({
    baseUrl: "https://tackle.internal",
    env: smokeEnv(),
    fetchImpl: mockFetch(routes),
  });
  assert.equal(
    evidence.checks.find((item) => item.id === "oauth_start")?.status,
    "FAIL",
  );
});

test("公网 HTTP 与带凭据 base URL 在出网前拒绝", async () => {
  await assert.rejects(
    runPublicSmoke({ baseUrl: "http://example.com", fetchImpl: mockFetch({}) }),
    /HTTPS/u,
  );
  await assert.rejects(
    runPublicSmoke({
      baseUrl: "http://fdattacker.example",
      allowPrivateHttp: true,
      env: smokeEnv({
        FEISHU_ALLOW_INSECURE_HTTP: "true",
        FEISHU_REDIRECT_URI: "http://fdattacker.example/api/auth/feishu/callback",
      }),
      fetchImpl: mockFetch({}),
    }),
    /RFC 1918/u,
  );
  let authenticatedFetchCalls = 0;
  await assert.rejects(
    runAuthenticatedReadOnlySmoke({
      baseUrl: "http://fdattacker.example",
      allowPrivateHttp: true,
      cookieHeader: "tf_session=must-not-leave",
      env: smokeEnv({
        FEISHU_ALLOW_INSECURE_HTTP: "true",
        FEISHU_REDIRECT_URI: "http://fdattacker.example/api/auth/feishu/callback",
      }),
      fetchImpl: async () => {
        authenticatedFetchCalls += 1;
        return new Response("unexpected");
      },
    }),
    /RFC 1918/u,
  );
  assert.equal(authenticatedFetchCalls, 0);
  await assert.rejects(
    runPublicSmoke({
      baseUrl: "http://127.0.0.1",
      allowPrivateHttp: true,
      env: smokeEnv({
        FEISHU_ALLOW_INSECURE_HTTP: "true",
        FEISHU_REDIRECT_URI: "http://127.0.0.1/api/auth/feishu/callback",
      }),
      fetchImpl: mockFetch({}),
    }),
    /RFC 1918/u,
  );
  await assert.rejects(
    runPublicSmoke({ baseUrl: "https://user:pass@example.com", fetchImpl: mockFetch({}) }),
    /凭据/u,
  );
  let privateStateSequence = 0;
  const evidence = await runPublicSmoke({
    baseUrl: "http://192.168.1.157",
    allowPrivateHttp: true,
    env: smokeEnv({
      FEISHU_ALLOW_INSECURE_HTTP: "true",
      FEISHU_REDIRECT_URI: "http://192.168.1.157/api/auth/feishu/callback",
    }),
    fetchImpl: mockFetch({
      ...publicRoutes(),
      "/api/auth/feishu/start": () => {
        privateStateSequence += 1;
        const state = `private-state-${privateStateSequence.toString().padStart(8, "0")}`;
        const redirect = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
        redirect.searchParams.set("client_id", "cli_public");
        redirect.searchParams.set("redirect_uri", "http://192.168.1.157/api/auth/feishu/callback");
        redirect.searchParams.set("state", state);
        redirect.searchParams.set("scope", "contact:user.base:readonly");
        return new Response(null, {
          status: 307,
          headers: {
            location: redirect.toString(),
            "set-cookie": `tf_feishu_pending=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
          },
        });
      },
    }),
  });
  assert.equal(evidence.summary.overall, "PASS");

  const insecureCookieRoutes = publicRoutes();
  let insecureSequence = 0;
  insecureCookieRoutes["/api/auth/feishu/start"] = () => {
    insecureSequence += 1;
    const state = `insecure-state-${insecureSequence.toString().padStart(8, "0")}`;
    const redirect = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    redirect.searchParams.set("client_id", "cli_public");
    redirect.searchParams.set("redirect_uri", "http://192.168.1.157/api/auth/feishu/callback");
    redirect.searchParams.set("state", state);
    redirect.searchParams.set("scope", "contact:user.base:readonly");
    return new Response(null, {
      status: 307,
      headers: {
        location: redirect.toString(),
        "set-cookie": `tf_feishu_pending=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  };
  const insecureCookieEvidence = await runPublicSmoke({
    baseUrl: "http://192.168.1.157",
    allowPrivateHttp: true,
    env: smokeEnv({
      FEISHU_ALLOW_INSECURE_HTTP: "true",
      FEISHU_REDIRECT_URI: "http://192.168.1.157/api/auth/feishu/callback",
    }),
    fetchImpl: mockFetch(insecureCookieRoutes),
  });
  assert.equal(insecureCookieEvidence.summary.overall, "FAIL");
  assert.equal(
    insecureCookieEvidence.checks.find((item) => item.id === "oauth_start")?.status,
    "FAIL",
  );
});

test("已登录只读 smoke 只保存身份与工作簿 token 哈希、计数和冻结引用哈希", async () => {
  const cookie = "tf_session=do-not-print-this-cookie";
  const fetchImpl = mockFetch({
    "/api/auth/session": json({
      authenticated: true,
      user: {
        tenantKey: "tenant-secret-id",
        openId: "user-secret-id",
        sessionExpiresAt: "2026-07-24T00:00:00.000Z",
        capabilities: [...EXPECTED_PHASE_ONE_CAPABILITIES],
      },
    }),
    "/api/state": json({
      revision: 42,
      state: {
        schemaVersion: 17,
        seriesDefinitions: [{ id: "series:1" }],
        skuDrawers: [{ id: "sku:1" }],
        purchasableModels: [{ id: "model:1" }],
        configurationSnapshots: [{ id: "snapshot:1", contentHash: "hash:1" }],
      },
    }),
    "/api/revisions": json({ revisions: [{ revision: 42 }] }),
    "/api/feishu-workbook": json({
      inspection: canonicalInspection(),
    }),
  });
  const evidence = await runAuthenticatedReadOnlySmoke({
    baseUrl: "https://tackle.internal",
    cookieHeader: cookie,
    env: smokeEnv(),
    fetchImpl,
    now: new Date("2026-07-23T00:00:00.000Z"),
  });
  assert.equal(evidence.summary.overall, "PASS");
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(cookie), false);
  assert.equal(serialized.includes("tenant-secret-id"), false);
  assert.equal(serialized.includes("user-secret-id"), false);
  assert.equal(serialized.includes("workbook-token-secret"), false);
  assert.match(serialized, /revision-4000/u);
  assert.match(serialized, /9nE3Rx/u);
});

test("错误租户、过期会话、schema 16 与残缺工作簿全部保持 BLOCKED", async () => {
  const fetchImpl = mockFetch({
    "/api/auth/session": json({
      authenticated: true,
      user: {
        tenantKey: "other-tenant",
        openId: "user",
        sessionExpiresAt: "2026-07-22T23:59:59.000Z",
        capabilities: [...EXPECTED_PHASE_ONE_CAPABILITIES],
      },
    }),
    "/api/state": json({
      revision: 7,
      state: {
        schemaVersion: 16,
        seriesDefinitions: [],
        skuDrawers: [],
        purchasableModels: [],
        configurationSnapshots: [],
      },
    }),
    "/api/revisions": json({ revisions: [] }),
    "/api/feishu-workbook": json({
      inspection: canonicalInspection({
        sourceRevision: {
          workbookRefId: "feishu-workbook:other",
          spreadsheetToken: "wrong-token",
          sourceRevision: "revision",
          registryHash: "registry-hash",
          sheets: [
            { sheetId: "d6e928", name: "01_重量模板" },
            { sheetId: "9nE3Rx", name: "错误名称" },
            { sheetId: "9nE3Rx", name: "06_系列" },
          ],
          issues: [{ code: "SHEET_MISSING", severity: "error" }],
        },
      }),
    }),
  });
  const evidence = await runAuthenticatedReadOnlySmoke({
    baseUrl: "https://tackle.internal",
    cookieHeader: "tf_session=opaque",
    env: smokeEnv(),
    fetchImpl,
    now: new Date("2026-07-23T00:00:00.000Z"),
  });
  assert.equal(evidence.summary.overall, "BLOCKED");
  assert.equal(
    evidence.checks.find((item) => item.id === "authenticated_session")?.status,
    "BLOCKED",
  );
  assert.equal(
    evidence.checks.find((item) => item.id === "workspace_read")?.status,
    "BLOCKED",
  );
  const workbook = evidence.checks.find((item) => item.id === "authoritative_workbook_read");
  assert.equal(workbook?.status, "BLOCKED");
  assert.deepEqual(workbook?.evidence?.duplicateSheetIds, ["9nE3Rx"]);
  assert.ok(workbook?.evidence?.missingSheets.length > 0);
  assert.equal(workbook?.evidence?.spreadsheetTokenMatched, false);
});

test("稳定身份待确认或品质/定价草稿阻断时权威工作簿保持 BLOCKED", async () => {
  const inspection = canonicalInspection({
    identityReport: {
      items: [
        {
          itemId: "identity:0",
          state: "CONFLICT",
          requiresHumanConfirmation: true,
        },
        {
          itemId: "identity:1",
          state: "ALREADY_IDENTIFIED",
          requiresHumanConfirmation: false,
        },
      ],
      blockingIssueCodes: ["SOURCE_STABLE_ID_DUPLICATE"],
    },
    qualityDraft: {
      formalStatus: "NON_FORMAL",
      issues: [{ code: "QUALITY_RANGE_MISSING", severity: "ERROR" }],
    },
    pricingDraft: {
      formalStatus: "INCOMPLETE_DRAFT",
      issues: [{ code: "PRICING_VALUE_INVALID", severity: "error" }],
    },
  });
  const fetchImpl = mockFetch({
    "/api/auth/session": json({
      authenticated: true,
      user: {
        tenantKey: "tenant-secret-id",
        openId: "user",
        sessionExpiresAt: "2026-07-24T00:00:00.000Z",
        capabilities: [...EXPECTED_PHASE_ONE_CAPABILITIES],
      },
    }),
    "/api/state": json({ revision: 17, state: { schemaVersion: 17 } }),
    "/api/revisions": json({ revisions: [{ revision: 17 }] }),
    "/api/feishu-workbook": json({ inspection }),
  });
  const evidence = await runAuthenticatedReadOnlySmoke({
    baseUrl: "https://tackle.internal",
    cookieHeader: "tf_session=opaque",
    env: smokeEnv(),
    fetchImpl,
    now: new Date("2026-07-23T00:00:00.000Z"),
  });
  const workbook = evidence.checks.find((item) => item.id === "authoritative_workbook_read");
  assert.equal(workbook?.status, "BLOCKED");
  assert.equal(workbook?.evidence?.identityReportMatched, false);
  assert.equal(workbook?.evidence?.pendingIdentityCount, 1);
  assert.deepEqual(
    workbook?.evidence?.identityBlockingIssueCodes,
    ["SOURCE_STABLE_ID_DUPLICATE"],
  );
  assert.deepEqual(workbook?.evidence?.qualityBlockingIssueCodes, ["QUALITY_RANGE_MISSING"]);
  assert.deepEqual(workbook?.evidence?.pricingBlockingIssueCodes, ["PRICING_VALUE_INVALID"]);
});

test("响应恶意回显 Cookie 时证据 FAIL 且不会再次序列化该 Cookie", async () => {
  const cookie = "tf_session=must-stay-secret";
  const fetchImpl = mockFetch({
    "/api/auth/session": json({
      authenticated: true,
      user: {
        tenantKey: "must-stay-secret",
        openId: "user",
        sessionExpiresAt: "2026-07-24T00:00:00.000Z",
        capabilities: [cookie],
      },
    }),
    "/api/state": json({
      revision: 17,
      state: {
        schemaVersion: 17,
        seriesDefinitions: [],
        skuDrawers: [],
        purchasableModels: [],
        configurationSnapshots: [],
      },
    }),
    "/api/revisions": json({ revisions: [] }),
    "/api/feishu-workbook": json({
      inspection: canonicalInspection(),
    }),
  });
  const evidence = await runAuthenticatedReadOnlySmoke({
    baseUrl: "https://tackle.internal",
    cookieHeader: cookie,
    env: smokeEnv(),
    fetchImpl,
    now: new Date("2026-07-23T00:00:00.000Z"),
  });
  assert.equal(evidence.summary.overall, "FAIL");
  assert.equal(
    evidence.checks.find((item) => item.id === "response_secret_scan")?.status,
    "FAIL",
  );
  assert.equal(JSON.stringify(evidence).includes(cookie), false);
});

test("真实会话暴露正式提交或 AI Capability 时验收保持 BLOCKED", async () => {
  const fetchImpl = mockFetch({
    "/api/auth/session": json({
      authenticated: true,
      user: {
        tenantKey: "tenant",
        openId: "user",
        sessionExpiresAt: "2026-07-24T00:00:00.000Z",
        capabilities: [
          ...EXPECTED_PHASE_ONE_CAPABILITIES,
          "ai.feishu_proposal_draft.create",
          "ai.provider_policy.manage",
          "config.export.commit",
          "future.unknown",
        ],
      },
    }),
    "/api/state": json({ revision: 1, state: { schemaVersion: 17 } }),
    "/api/revisions": json({ revisions: [] }),
    "/api/feishu-workbook": json({
      inspection: canonicalInspection(),
    }),
  });
  const evidence = await runAuthenticatedReadOnlySmoke({
    baseUrl: "https://tackle.internal",
    cookieHeader: "tf_session=opaque",
    env: smokeEnv({ FEISHU_TENANT_KEY: "tenant" }),
    fetchImpl,
    now: new Date("2026-07-23T00:00:00.000Z"),
  });
  assert.equal(evidence.summary.overall, "BLOCKED");
  assert.deepEqual(
    evidence.checks.find((item) => item.id === "runtime_capability_boundary")?.evidence
      ?.forbiddenCapabilities,
    [
      "ai.feishu_proposal_draft.create",
      "ai.provider_policy.manage",
      "config.export.commit",
      "future.unknown",
    ],
  );
});

test("preflight 对安全 env、源契约和 0600 权限给出可重复证据", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-root-"));
  const envDirectory = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-safe-env-"));
  const envFile = path.join(envDirectory, ".env.local");
  await mkdir(path.join(root, "lib"), { recursive: true });
  await mkdir(path.join(root, "app/api/feishu-workbook"), { recursive: true });
  await mkdir(path.join(root, "deploy"), { recursive: true });
  await writeFile(
    path.join(root, "lib/feishu-identity.ts"),
    `export const PHASE_ONE_CAPABILITIES = ${JSON.stringify([
      ...EXPECTED_PHASE_ONE_CAPABILITIES,
    ])} as const;\n`,
  );
  await writeFile(
    path.join(root, "lib/migrations.ts"),
    "export const CURRENT_WORKSPACE_SCHEMA_VERSION = 17;\n",
  );
  await writeFile(
    path.join(root, "app/api/feishu-workbook/route.ts"),
    "importCanonicalRuleSource(); const canonicalRuleSource = true;\n",
  );
  await writeFile(path.join(root, "deploy/tackle-forger.service"), [
    "ExecStart=npm run start -- --hostname 127.0.0.1 --port 3000",
    "ReadWritePaths=/opt/tackle-forger/data",
  ].join("\n"));
  await writeFile(path.join(root, "deploy/nginx-tackle-forger.conf.example"), [
    'proxy_set_header X-Feishu-Tenant-Key "";',
    'proxy_set_header X-Feishu-Open-Id "";',
    'proxy_set_header X-TF-Proxy-Secret "";',
  ].join("\n"));
  await writeFile(
    path.join(root, "lib/config-export.ts"),
    "interface ConfigPreviewPackage { packageKind: 'CONFIG_PREVIEW'; ref: 'NON_FORMAL:'; }\n",
  );
  await writeFile(path.join(root, "lib/interaction-contracts.ts"), "export {};\n");
  await writeFile(envFile, [
    "FEISHU_APP_ID=cli_test",
    "FEISHU_APP_SECRET=secret",
    "FEISHU_CANONICAL_SPREADSHEET_TOKEN=spreadsheet-token",
    "FEISHU_TENANT_KEY=tenant",
    "FEISHU_REDIRECT_URI=https://tackle.internal/api/auth/feishu/callback",
    `FEISHU_SESSION_SECRET=${"s".repeat(32)}`,
    "FEISHU_SESSION_TTL_SECONDS=28800",
    "FEISHU_SESSION_DATA_DIR=/opt/tackle-forger/data/auth",
    "WORKSPACE_DATABASE_PATH=/opt/tackle-forger/data/workspace.sqlite",
    "WORKSPACE_FILE_DATA_DIR=/opt/tackle-forger/data/files",
    "WORKSPACE_BACKUP_DIR=/opt/tackle-forger/data/backups",
    "FEISHU_TRUST_PROXY_HEADERS=false",
  ].join("\n"), { mode: 0o600 });
  const evidence = await runPreflight({ root, envFile });
  assert.equal(evidence.summary.overall, "BLOCKED");
  assert.equal(
    evidence.checks.find((item) => item.id === "immutable_build_commit")?.status,
    "BLOCKED",
  );
  assert.equal(
    evidence.checks.find((item) => item.id === "phase_one_capability_boundary")?.status,
    "INFO",
  );
  assert.equal(
    evidence.checks.find((item) => item.id === "production_environment_file")?.evidence
      ?.configuredKeys.includes("FEISHU_APP_SECRET"),
    true,
  );
  assert.equal(JSON.stringify(evidence).includes("s".repeat(32)), false);
  await rm(root, { recursive: true, force: true });
  await rm(envDirectory, { recursive: true, force: true });
});

test("三种模式共用的环境 loader 拒绝仓库内、相对、symlink 与宽权限文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-env-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-env-outside-"));
  const insideFile = path.join(root, ".env.local");
  const outsideFile = path.join(outside, ".env.local");
  const symlinkFile = path.join(outside, ".env-link");
  await writeFile(insideFile, "FEISHU_APP_ID=inside\n", { mode: 0o600 });
  await writeFile(outsideFile, "FEISHU_APP_ID=outside\n", { mode: 0o600 });
  await symlink(outsideFile, symlinkFile);
  await assert.rejects(
    readSecureEnvironmentFile({ envFile: insideFile, root }),
    /工作树之外/u,
  );
  await assert.rejects(
    readSecureEnvironmentFile({ envFile: ".env.local", root }),
    /绝对路径/u,
  );
  await assert.rejects(
    readSecureEnvironmentFile({ envFile: symlinkFile, root }),
    /符号链接/u,
  );
  await chmod(outsideFile, 0o644);
  await assert.rejects(
    readSecureEnvironmentFile({ envFile: outsideFile, root }),
    /0600/u,
  );
  await chmod(outsideFile, 0o600);
  assert.equal(
    (await readSecureEnvironmentFile({ envFile: outsideFile, root })).env.FEISHU_APP_ID,
    "outside",
  );

  const evidence = await runPreflight({ root, envFile: insideFile });
  assert.equal(
    evidence.checks.find((item) => item.id === "production_environment_file")?.status,
    "BLOCKED",
  );
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("依赖门禁绑定受版本控制的 Issue/PR 映射、唯一 commit 与审核状态", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-dependencies-"));
  await mkdir(path.join(root, "deploy"), { recursive: true });
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Acceptance Fixture"], { cwd: root });
  const commits = [];
  for (const [index, pr] of [67, 71, 76].entries()) {
    await writeFile(path.join(root, `dependency-${pr}.txt`), `${pr}\n`);
    execFileSync("git", ["add", `dependency-${pr}.txt`], { cwd: root });
    execFileSync("git", ["commit", "-m", `fixture dependency ${index + 1} (#${pr})`], {
      cwd: root,
    });
    commits.push(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
  }
  const manifest = (dependencyCommits) => ({
    schemaVersion: "phase-one-dependency-evidence/v1",
    dependencies: [
      ["canonical_rule_source", 66, 67, dependencyCommits[0]],
      ["schema_v17", 68, 71, dependencyCommits[1]],
      ["non_formal_preview", 72, 76, dependencyCommits[2]],
    ].map(([id, issue, pr, commit]) => ({
      id,
      issue,
      pr,
      commit,
      reviewedHeadCommit: commit,
      merged: true,
      reviewThreadsResolved: true,
      requiredChecksPassed: true,
      evidenceUrl: `https://github.com/futouyiba/tackle-forger/pull/${pr}`,
    })),
  });
  await writeFile(
    path.join(root, "deploy/phase-one-dependencies.json"),
    `${JSON.stringify(manifest([commits[0], commits[0], commits[0]]), null, 2)}\n`,
  );
  const githubPulls = new Map([
    [67, { merge: commits[0], head: commits[0] }],
    [71, { merge: commits[1], head: commits[1] }],
    [76, { merge: commits[2], head: commits[2] }],
  ]);
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/graphql") {
      return json({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } } } } },
      });
    }
    if (url.pathname.endsWith("/actions/runs")) {
      const head = url.searchParams.get("head_sha");
      return json({ workflow_runs: [{
        id: `run-${head}`,
        event: "pull_request",
        head_sha: head,
        name: "CI",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: [...githubPulls.entries()].find(([, value]) => value.head === head)?.[0] }],
      }] });
    }
    if (url.pathname.includes("/actions/runs/") && url.pathname.endsWith("/jobs")) {
      return json({ jobs: [
        "Root v3 app (npm)",
        "Historical workspace (pnpm)",
        "Windows line-ending policy",
      ].map((name) => ({ name, status: "completed", conclusion: "success" })) });
    }
    const pr = Number(url.pathname.split("/").at(-1));
    const expected = githubPulls.get(pr);
    return json({
      number: pr,
      state: "closed",
      merged_at: "2026-07-23T00:00:00Z",
      merge_commit_sha: expected?.merge,
      head: { sha: expected?.head },
    });
  };
  const spoofed = await inspectDependencyManifest(root, { fetchImpl, githubToken: "test-token" });
  assert.equal(spoofed.status, "BLOCKED");
  assert.deepEqual(spoofed.evidence.duplicateCommits, [
    "schema_v17",
    "non_formal_preview",
  ]);

  await writeFile(
    path.join(root, "deploy/phase-one-dependencies.json"),
    `${JSON.stringify(manifest(commits), null, 2)}\n`,
  );
  const missingToken = await inspectDependencyManifest(root, { fetchImpl });
  assert.equal(missingToken.status, "BLOCKED");
  assert.deepEqual(
    missingToken.evidence.githubVerificationFailedIds,
    ["canonical_rule_source", "schema_v17", "non_formal_preview"],
  );
  assert.equal((await inspectDependencyManifest(root, { fetchImpl, githubToken: "test-token" })).status, "PASS");

  const failedCheck = await inspectDependencyManifest(root, {
    githubToken: "test-token",
    fetchImpl: async (input) => new URL(input).pathname.endsWith("/jobs")
      ? json({ jobs: [{ name: "Root v3 app (npm)", status: "completed", conclusion: "failure" }] })
      : fetchImpl(input),
  });
  assert.equal(failedCheck.status, "BLOCKED");
  assert.deepEqual(failedCheck.evidence.githubRequiredCheckVerificationFailedIds, [
    "canonical_rule_source", "schema_v17", "non_formal_preview",
  ]);

  const staleSuccess = await inspectDependencyManifest(root, {
    githubToken: "test-token",
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/actions/runs")) return fetchImpl(input);
      const head = url.searchParams.get("head_sha");
      const pr = [...githubPulls.entries()].find(([, value]) => value.head === head)?.[0];
      return json({ workflow_runs: [
        {
          id: `old-success-${head}`,
          event: "pull_request",
          head_sha: head,
          name: "CI",
          run_number: 1,
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          pull_requests: [{ number: pr }],
        },
        {
          id: `new-failure-${head}`,
          event: "pull_request",
          head_sha: head,
          name: "CI",
          run_number: 2,
          run_attempt: 1,
          status: "completed",
          conclusion: "failure",
          pull_requests: [{ number: pr }],
        },
      ] });
    },
  });
  assert.equal(staleSuccess.status, "BLOCKED");
  assert.deepEqual(staleSuccess.evidence.githubRequiredCheckVerificationFailedIds, [
    "canonical_rule_source", "schema_v17", "non_formal_preview",
  ]);

  const pushOnly = await inspectDependencyManifest(root, {
    githubToken: "test-token",
    fetchImpl: async (input) => new URL(input).pathname.endsWith("/actions/runs")
      ? json({ workflow_runs: [{
        id: "push-run",
        event: "push",
        head_sha: commits[0],
        name: "CI",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        pull_requests: [],
      }] })
      : fetchImpl(input),
  });
  assert.equal(pushOnly.status, "BLOCKED");
  assert.deepEqual(pushOnly.evidence.githubRequiredCheckVerificationFailedIds, [
    "canonical_rule_source", "schema_v17", "non_formal_preview",
  ]);

  const unresolvedThread = await inspectDependencyManifest(root, {
    githubToken: "test-token",
    fetchImpl: async (input) => new URL(input).pathname === "/graphql"
      ? json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } } } } } })
      : fetchImpl(input),
  });
  assert.equal(unresolvedThread.status, "BLOCKED");
  assert.deepEqual(unresolvedThread.evidence.githubReviewThreadVerificationFailedIds, [
    "canonical_rule_source", "schema_v17", "non_formal_preview",
  ]);

  const apiFailure = await inspectDependencyManifest(root, {
    githubToken: "test-token",
    fetchImpl: async (input) => new URL(input).pathname === "/graphql"
      ? new Response("unavailable", { status: 503 })
      : fetchImpl(input),
  });
  assert.equal(apiFailure.status, "BLOCKED");
  assert.deepEqual(apiFailure.evidence.githubReviewThreadVerificationFailedIds, [
    "canonical_rule_source", "schema_v17", "non_formal_preview",
  ]);
  await rm(root, { recursive: true, force: true });
});

test("持久数据根检查要求正确类型、仅服务账号权限与安全父目录", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-data-"));
  const databasePath = path.join(dataRoot, "workspace.sqlite");
  const fileDataDir = path.join(dataRoot, "files");
  const backupDir = path.join(dataRoot, "backups");
  const sessionDir = path.join(dataRoot, "auth");
  await writeFile(databasePath, "", { mode: 0o600 });
  await mkdir(fileDataDir, { mode: 0o700 });
  await mkdir(backupDir, { mode: 0o700 });
  await mkdir(sessionDir, { mode: 0o700 });
  const env = {
    WORKSPACE_DATABASE_PATH: databasePath,
    WORKSPACE_FILE_DATA_DIR: fileDataDir,
    WORKSPACE_BACKUP_DIR: backupDir,
    FEISHU_SESSION_DATA_DIR: sessionDir,
  };
  assert.equal(
    (await inspectRuntimePathFilesystem(env, { dataRoot })).status,
    "PASS",
  );
  await chmod(databasePath, 0o644);
  const exposed = await inspectRuntimePathFilesystem(env, { dataRoot });
  assert.equal(exposed.status, "BLOCKED");
  assert.deepEqual(exposed.evidence.exposedPermissionKeys, ["WORKSPACE_DATABASE_PATH"]);
  await chmod(databasePath, 0o600);
  await rm(fileDataDir, { recursive: true });
  await writeFile(fileDataDir, "", { mode: 0o600 });
  const wrongType = await inspectRuntimePathFilesystem(env, { dataRoot });
  assert.equal(wrongType.status, "BLOCKED");
  assert.deepEqual(wrongType.evidence.wrongTypeKeys, ["WORKSPACE_FILE_DATA_DIR"]);
  await rm(dataRoot, { recursive: true, force: true });
});

test("持久路径词法检查拒绝相对路径、.. 越界与规范化后的别名", () => {
  const result = inspectRuntimePaths({
    WORKSPACE_DATABASE_PATH: "data/workspace.sqlite",
    WORKSPACE_FILE_DATA_DIR: "/opt/tackle-forger/data/files/../shared",
    WORKSPACE_BACKUP_DIR: "/opt/tackle-forger/data/shared",
    FEISHU_SESSION_DATA_DIR: "/opt/tackle-forger/data/../current/auth",
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.evidence.invalidKeys, [
    "WORKSPACE_DATABASE_PATH",
    "FEISHU_SESSION_DATA_DIR",
  ]);
  assert.equal(result.evidence.duplicate, true);
});

test("会话 Cookie 文件必须是仓库外绝对路径、0600 普通文件且不能是 symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-cookie-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-cookie-outside-"));
  const insideCookie = path.join(root, "session.cookie");
  const outsideCookie = path.join(outside, "session.cookie");
  const symlinkCookie = path.join(outside, "session-link.cookie");
  await writeFile(insideCookie, "tf_session=inside\n", { mode: 0o600 });
  await writeFile(outsideCookie, "tf_session=outside\n", { mode: 0o600 });
  await symlink(outsideCookie, symlinkCookie);

  await assert.rejects(
    readSessionCookieFile({ cookieFile: insideCookie, root }),
    /工作树之外/u,
  );
  await assert.rejects(
    readSessionCookieFile({ cookieFile: "session.cookie", root }),
    /绝对路径/u,
  );
  await assert.rejects(
    readSessionCookieFile({ cookieFile: symlinkCookie, root }),
    /符号链接/u,
  );
  assert.equal(
    await readSessionCookieFile({ cookieFile: outsideCookie, root }),
    "tf_session=outside",
  );
  await chmod(outsideCookie, 0o644);
  await assert.rejects(
    readSessionCookieFile({ cookieFile: outsideCookie, root }),
    /0600/u,
  );

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("evidence output 可以创建为独立 0600 文件且不覆盖旧证据", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-output-"));
  const output = path.join(directory, "evidence.json");
  await writeEvidenceFile(output, { schemaVersion: "test", checks: [] });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(output, "utf8")).schemaVersion, "test");
  await assert.rejects(
    writeEvidenceFile(output, { schemaVersion: "overwritten" }),
    { code: "EEXIST" },
  );
  assert.equal(JSON.parse(await readFile(output, "utf8")).schemaVersion, "test");
  await rm(directory, { recursive: true, force: true });
});
