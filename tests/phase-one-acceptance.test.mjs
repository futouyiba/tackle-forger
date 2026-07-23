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
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXPECTED_CANONICAL_SHEETS,
  EXPECTED_PHASE_ONE_CAPABILITIES,
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
    FEISHU_APP_SECRET: "super-secret-value",
    FEISHU_CANONICAL_SPREADSHEET_TOKEN: "workbook-token-secret",
    FEISHU_REDIRECT_URI: "https://tackle.internal/api/auth/feishu/callback",
    FEISHU_TENANT_KEY: "tenant-secret-id",
    ...overrides,
  };
}

function canonicalSheets() {
  return [...EXPECTED_CANONICAL_SHEETS].map(([sheetId, name]) => ({ sheetId, name }));
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
      return new Response(null, {
        status: 307,
        headers: {
          location: redirect.toString(),
          "set-cookie": `tf_feishu_pending=${state}; Path=/; HttpOnly; Secure; SameSite=Lax`,
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
    return new Response(null, {
      status: 307,
      headers: {
        location: redirect.toString(),
        "set-cookie": "tf_feishu_pending=fixed-state-00000000; Path=/; HttpOnly; Secure; SameSite=Lax",
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
        return new Response(null, {
          status: 307,
          headers: {
            location: redirect.toString(),
            "set-cookie": `tf_feishu_pending=${state}; Path=/; HttpOnly; SameSite=Lax`,
          },
        });
      },
    }),
  });
  assert.equal(evidence.summary.overall, "PASS");
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
      inspection: {
        sourceRevision: {
          workbookRefId: "feishu-workbook:tackle-design",
          spreadsheetToken: "workbook-token-secret",
          sourceRevision: "revision-4000",
          registryHash: "registry-hash",
          sheets: canonicalSheets(),
          issues: [],
        },
      },
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
      inspection: {
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
      },
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

test("响应恶意回显 Cookie 时证据 FAIL 且不会再次序列化该 Cookie", async () => {
  const cookie = "tf_session=must-stay-secret";
  const fetchImpl = mockFetch({
    "/api/auth/session": json({
      authenticated: true,
      user: {
        tenantKey: cookie,
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
      inspection: {
        sourceRevision: {
          workbookRefId: "feishu-workbook:tackle-design",
          spreadsheetToken: "workbook-token-secret",
          sourceRevision: "revision",
          registryHash: "registry-hash",
          sheets: canonicalSheets(),
          issues: [],
        },
      },
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
      inspection: {
        sourceRevision: {
          workbookRefId: "feishu-workbook:tackle-design",
          spreadsheetToken: "workbook-token-secret",
          sourceRevision: "revision",
          registryHash: "registry-hash",
          sheets: canonicalSheets(),
          issues: [],
        },
      },
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
  const envFile = path.join(root, ".env.local");
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
});

test("preflight 不会把宽权限环境文件或生产目录混用判为通过", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tf-phase-one-env-"));
  const envFile = path.join(root, ".env.local");
  await writeFile(envFile, [
    "FEISHU_APP_ID=cli_test",
    "FEISHU_APP_SECRET=secret",
    "FEISHU_CANONICAL_SPREADSHEET_TOKEN=spreadsheet-token",
    "FEISHU_TENANT_KEY=tenant",
    "FEISHU_REDIRECT_URI=http://public.example/api/auth/feishu/callback",
    "FEISHU_SESSION_SECRET=short",
    "FEISHU_SESSION_DATA_DIR=/opt/tackle-forger/current/auth",
    "WORKSPACE_DATABASE_PATH=/opt/tackle-forger/data/../current/workspace.sqlite",
    "WORKSPACE_FILE_DATA_DIR=/opt/tackle-forger/data/files/../shared",
    "WORKSPACE_BACKUP_DIR=/opt/tackle-forger/data/shared",
    "FANCY_HUB_ENABLED=true",
    "WORKSPACE_AUTO_PRUNE=true",
    "FEISHU_TRUST_PROXY_HEADERS=true",
  ].join("\n"), { mode: 0o644 });
  const evidence = await runPreflight({ root, envFile });
  assert.equal(evidence.summary.overall, "FAIL");
  const statuses = new Map(evidence.checks.map((item) => [item.id, item.status]));
  assert.equal(statuses.get("environment_file_permissions"), "BLOCKED");
  assert.equal(statuses.get("oauth_redirect"), "BLOCKED");
  assert.equal(statuses.get("persistent_paths"), "BLOCKED");
  assert.equal(statuses.get("phase_one_feature_flags"), "BLOCKED");
  assert.equal(statuses.get("direct_oauth_topology"), "BLOCKED");
  await rm(root, { recursive: true, force: true });
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
