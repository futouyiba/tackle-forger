#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_SCHEMA_VERSION = "phase-one-acceptance-evidence/v1";
const EXPECTED_WORKBOOK_REF_ID = "feishu-workbook:tackle-design";
export const EXPECTED_CANONICAL_SHEETS = new Map([
  ["d6e928", "01_重量模板"],
  ["fATowU", "02_类型材质"],
  ["vviXo0", "03_功能定位"],
  ["zrVOxd", "04_词条"],
  ["RdZv0J", "05_技术"],
  ["9nE3Rx", "06_系列"],
  ["FqD4j7", "07_品质评分"],
  ["u87sRh", "08_价格计算"],
  ["KZv4o2", "10_校验规则"],
]);
const FORBIDDEN_PHASE_ONE_CAPABILITIES = new Set([
  "config.export.commit",
  "config.id.reserve",
  "snapshot.export",
]);
export const EXPECTED_PHASE_ONE_CAPABILITIES = new Set([
  "candidate.dismiss",
  "candidate.generate",
  "candidate.materialize",
  "candidate.select",
  "config.export.preview",
  "data_source.preview",
  "data_source.publish",
  "data_source.resolve",
  "data_source.writeback.commit",
  "data_source.writeback.preview",
  "excel.import",
  "feishu.identity.write",
  "feishu.workbook.read",
  "feishu.workbook.pull",
  "model.edit",
  "model.patch.create",
  "model.patch.review",
  "model.publish",
  "model.read",
  "model.review",
  "patch.absorption.review",
  "patch.create",
  "patch.mirror.pull",
  "patch.mirror.write",
  "patch.rebase",
  "patch.review",
  "revision.read",
  "rules.five_axis.publish",
  "rules.proposal.create",
  "ruleset.draft.create",
  "ruleset.publish",
  "series.edit",
  "series.read",
  "sku.read",
  "snapshot.read",
  "workspace.policy.manage",
  "workspace.save",
]);
const REQUIRED_ENV_KEYS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_CANONICAL_SPREADSHEET_TOKEN",
  "FEISHU_TENANT_KEY",
  "FEISHU_REDIRECT_URI",
  "FEISHU_SESSION_SECRET",
  "FEISHU_SESSION_DATA_DIR",
  "WORKSPACE_DATABASE_PATH",
  "WORKSPACE_FILE_DATA_DIR",
  "WORKSPACE_BACKUP_DIR",
  "PHASE_ONE_CANONICAL_PULL_COMMIT",
  "PHASE_ONE_SCHEMA_V17_COMMIT",
  "PHASE_ONE_NON_FORMAL_COMMIT",
];
const DEPENDENCY_COMMIT_KEYS = [
  "PHASE_ONE_CANONICAL_PULL_COMMIT",
  "PHASE_ONE_SCHEMA_V17_COMMIT",
  "PHASE_ONE_NON_FORMAL_COMMIT",
];
const SECRET_ENV_KEYS = [
  "FEISHU_APP_SECRET",
  "FEISHU_SESSION_SECRET",
  "FEISHU_PROXY_SHARED_SECRET",
  "FANCY_HUB_API_KEY",
  "AI_RETENTION_ENCRYPTION_KEY",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function check(id, status, summary, evidence = undefined) {
  return evidence === undefined
    ? { id, status, summary }
    : { id, status, summary, evidence };
}

function summarize(checks) {
  const counts = { PASS: 0, BLOCKED: 0, FAIL: 0, INFO: 0 };
  for (const item of checks) counts[item.status] += 1;
  return {
    ...counts,
    overall: counts.FAIL > 0 ? "FAIL" : counts.BLOCKED > 0 ? "BLOCKED" : "PASS",
  };
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function isRfc1918Ipv4Hostname(hostname) {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function inspectRedirectUrl(env) {
  try {
    const redirect = new URL(env.FEISHU_REDIRECT_URI ?? "");
    const privateHttp = redirect.protocol === "http:"
      && env.FEISHU_ALLOW_INSECURE_HTTP?.toLowerCase() === "true"
      && isRfc1918Ipv4Hostname(redirect.hostname);
    if (redirect.protocol !== "https:" && !privateHttp) {
      return check(
        "oauth_redirect",
        "BLOCKED",
        "飞书回调必须使用 HTTPS；只有显式启用时允许 RFC 1918 私网 HTTP。",
      );
    }
    if (redirect.pathname !== "/api/auth/feishu/callback") {
      return check(
        "oauth_redirect",
        "BLOCKED",
        "飞书回调路径必须逐字为 /api/auth/feishu/callback。",
      );
    }
    return check("oauth_redirect", "PASS", "飞书回调协议、主机边界和路径符合一期要求。", {
      protocol: redirect.protocol,
      hostname: redirect.hostname,
      callbackPath: redirect.pathname,
    });
  } catch {
    return check("oauth_redirect", "BLOCKED", "FEISHU_REDIRECT_URI 不是有效 URL。");
  }
}

function inspectRuntimePaths(env) {
  const dataRoot = "/opt/tackle-forger/data";
  const entries = [
    ["WORKSPACE_DATABASE_PATH", env.WORKSPACE_DATABASE_PATH],
    ["WORKSPACE_FILE_DATA_DIR", env.WORKSPACE_FILE_DATA_DIR],
    ["WORKSPACE_BACKUP_DIR", env.WORKSPACE_BACKUP_DIR],
    ["FEISHU_SESSION_DATA_DIR", env.FEISHU_SESSION_DATA_DIR],
  ];
  const normalized = entries.map(([key, value]) => [
    key,
    value ? path.resolve(value) : value,
  ]);
  const invalid = normalized.filter(([, value]) => (
    !value
    || !path.isAbsolute(value)
    || path.relative(dataRoot, value).startsWith("..")
    || path.relative(dataRoot, value) === ""
    || value.startsWith("/opt/tackle-forger/current/")
  ));
  const duplicate = new Set(normalized.map(([, value]) => value).filter(Boolean)).size
    !== normalized.filter(([, value]) => Boolean(value)).length;
  if (invalid.length || duplicate) {
    return check(
      "persistent_paths",
      "BLOCKED",
      "生产数据库、文件、备份和会话目录必须是 /opt/tackle-forger/data 下互不相同的绝对路径。",
      { invalidKeys: invalid.map(([key]) => key), duplicate },
    );
  }
  return check("persistent_paths", "PASS", "四类持久数据路径互相隔离且不位于代码发布目录。", {
    keys: entries.map(([key]) => key),
  });
}

async function inspectRuntimePathFilesystem(env) {
  const entries = [
    ["WORKSPACE_DATABASE_PATH", env.WORKSPACE_DATABASE_PATH],
    ["WORKSPACE_FILE_DATA_DIR", env.WORKSPACE_FILE_DATA_DIR],
    ["WORKSPACE_BACKUP_DIR", env.WORKSPACE_BACKUP_DIR],
    ["FEISHU_SESSION_DATA_DIR", env.FEISHU_SESSION_DATA_DIR],
  ];
  const missingKeys = [];
  const outsideRootKeys = [];
  const ownerMismatchKeys = [];
  const writableByOthersKeys = [];
  const canonicalPaths = [];
  let canonicalRoot;
  try {
    canonicalRoot = await realpath("/opt/tackle-forger/data");
  } catch {
    return check(
      "persistent_path_filesystem",
      "BLOCKED",
      "目标服务器尚无可解析的 /opt/tackle-forger/data 持久根。",
    );
  }
  for (const [key, value] of entries) {
    try {
      const canonical = await realpath(value);
      const info = await stat(canonical);
      canonicalPaths.push(canonical);
      const relative = path.relative(canonicalRoot, canonical);
      if (
        relative === ""
        || relative.startsWith("..")
        || path.isAbsolute(relative)
      ) {
        outsideRootKeys.push(key);
      }
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        ownerMismatchKeys.push(key);
      }
      if ((info.mode & 0o022) !== 0) writableByOthersKeys.push(key);
    } catch {
      missingKeys.push(key);
    }
  }
  const duplicateCanonicalPaths = canonicalPaths.length
    !== new Set(canonicalPaths).size;
  if (
    missingKeys.length
    || outsideRootKeys.length
    || ownerMismatchKeys.length
    || writableByOthersKeys.length
    || duplicateCanonicalPaths
  ) {
    return check(
      "persistent_path_filesystem",
      "BLOCKED",
      "持久路径必须真实存在、解析后位于数据根内、归当前服务账号所有且不可由组/其他用户写入。",
      {
        missingKeys,
        outsideRootKeys,
        ownerMismatchKeys,
        writableByOthersKeys,
        duplicateCanonicalPaths,
      },
    );
  }
  return check(
    "persistent_path_filesystem",
    "PASS",
    "持久路径的真实位置、所有者和写权限边界符合部署要求。",
    { keys: entries.map(([key]) => key) },
  );
}

function inspectDisabledFeatures(env) {
  const enabledAi = env.FANCY_HUB_ENABLED?.trim().toLowerCase() === "true";
  const pruningKeys = Object.entries(env)
    .filter(([key, value]) => (
      /(?:PRUN|AUTO.*DELETE|RETENTION_RUN)/iu.test(key)
      && value.trim().toLowerCase() === "true"
    ))
    .map(([key]) => key);
  if (enabledAi || pruningKeys.length) {
    return check(
      "phase_one_feature_flags",
      "BLOCKED",
      "一期必须保持 AI 与 workspace revision 裁剪关闭。",
      { aiEnabled: enabledAi, enabledPruningKeys: pruningKeys },
    );
  }
  return check("phase_one_feature_flags", "PASS", "环境未启用 AI 或 revision 裁剪。");
}

function inspectEnvironmentValues(env) {
  const checks = [];
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]?.trim());
  checks.push(missing.length
    ? check("required_environment", "BLOCKED", "生产环境缺少必要配置键。", { missingKeys: missing })
    : check("required_environment", "PASS", "生产环境的必要配置键均已提供。"));

  checks.push(Buffer.byteLength(env.FEISHU_SESSION_SECRET ?? "", "utf8") >= 32
    ? check("session_secret", "PASS", "会话密钥满足至少 32 字节要求。")
    : check("session_secret", "BLOCKED", "FEISHU_SESSION_SECRET 少于 32 字节。"));

  const ttl = Number.parseInt(env.FEISHU_SESSION_TTL_SECONDS ?? "28800", 10);
  checks.push(Number.isSafeInteger(ttl) && ttl >= 60
    ? check("session_ttl", "PASS", "会话绝对过期时间配置有效。", { ttlSeconds: ttl })
    : check("session_ttl", "BLOCKED", "FEISHU_SESSION_TTL_SECONDS 必须是至少 60 的整数。"));

  checks.push(inspectRedirectUrl(env));
  checks.push(inspectRuntimePaths(env));
  checks.push(inspectDisabledFeatures(env));

  const badHttpsBases = [
    ["FEISHU_OPEN_API_BASE_URL", env.FEISHU_OPEN_API_BASE_URL ?? "https://open.feishu.cn"],
    ["FEISHU_ACCOUNTS_BASE_URL", env.FEISHU_ACCOUNTS_BASE_URL ?? "https://accounts.feishu.cn"],
  ].filter(([, value]) => {
    try {
      return new URL(value).protocol !== "https:";
    } catch {
      return true;
    }
  });
  checks.push(badHttpsBases.length
    ? check("feishu_api_https", "BLOCKED", "飞书 API 与账号服务基址必须是有效 HTTPS URL。", {
      invalidKeys: badHttpsBases.map(([key]) => key),
    })
    : check("feishu_api_https", "PASS", "飞书 API 与账号服务基址使用 HTTPS。"));

  const trustedProxy = env.FEISHU_TRUST_PROXY_HEADERS?.trim().toLowerCase() === "true";
  checks.push(!trustedProxy
    ? check("direct_oauth_topology", "PASS", "可信代理身份模式关闭，使用直接飞书 OAuth。")
    : check(
      "direct_oauth_topology",
      "BLOCKED",
      "#73 一期目标拓扑要求关闭 FEISHU_TRUST_PROXY_HEADERS。",
    ));
  return checks;
}

function parseCapabilityLiterals(source) {
  const block = /PHASE_ONE_CAPABILITIES\s*=\s*\[(?<body>[\s\S]*?)\]\s*as const/u.exec(source)?.groups?.body ?? "";
  return [...block.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]);
}

function activeConfigLines(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function inspectSourceContracts(sources) {
  const checks = [];
  const capabilities = parseCapabilityLiterals(sources.capabilities);
  const forbidden = capabilities.filter((capability) => (
    capability.startsWith("ai.")
    || FORBIDDEN_PHASE_ONE_CAPABILITIES.has(capability)
    || !EXPECTED_PHASE_ONE_CAPABILITIES.has(capability)
  ));
  const missing = [...EXPECTED_PHASE_ONE_CAPABILITIES]
    .filter((capability) => !capabilities.includes(capability));
  checks.push(forbidden.length || missing.length
    ? check(
      "phase_one_capability_boundary",
      "BLOCKED",
      "一期 Capability 未精确匹配允许集合，或仍暴露 AI/正式导出/未知动作。",
      { forbiddenCapabilities: forbidden.sort(), missingCapabilities: missing.sort() },
    )
    : check("phase_one_capability_boundary", "INFO", "源码 Capability 标记精确匹配允许集合。", {
      capabilityCount: capabilities.length,
      advisoryOnly: true,
    }));

  const schemaVersion = Number.parseInt(
    /CURRENT_WORKSPACE_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(sources.migrations)?.[1] ?? "",
    10,
  );
  checks.push(Number.isInteger(schemaVersion) && schemaVersion >= 17
    ? check("schema_v17_read_compatibility", "INFO", "源码声明 schema v17；运行证据仍单独核对。", {
      currentWorkspaceSchemaVersion: schemaVersion,
      advisoryOnly: true,
    })
    : check(
      "schema_v17_read_compatibility",
      "BLOCKED",
      "运行时尚未声明生产 schema v17 读取兼容；#68/#71 仍是部署阻断。",
      { currentWorkspaceSchemaVersion: Number.isInteger(schemaVersion) ? schemaVersion : null },
    ));

  const canonicalPullImplemented = (
    sources.workbookRoute.includes("importCanonicalRuleSource")
    && sources.workbookRoute.includes("canonicalRuleSource")
  );
  checks.push(canonicalPullImplemented
    ? check(
      "canonical_rule_source_chain",
      "INFO",
      "源码包含规范规则源导入标记；该静态提示不能替代依赖 commit、测试与 review 门禁。",
      { advisoryOnly: true },
    )
    : check(
      "canonical_rule_source_chain",
      "BLOCKED",
      "显式拉取尚未把权威 01/02/03 机器区接入展示与计算；#66/#67 仍是部署阻断。",
    ));

  const nonFormalContract = (
    sources.repositoryText.includes("ConfigPreviewPackage")
    && sources.repositoryText.includes("CONFIG_PREVIEW")
    && sources.repositoryText.includes("NON_FORMAL:")
  );
  checks.push(nonFormalContract
    ? check(
      "non_formal_preview_contract",
      "INFO",
      "源码包含 NON_FORMAL 契约标记；该静态提示不能替代可执行测试与依赖门禁。",
      { advisoryOnly: true },
    )
    : check(
      "non_formal_preview_contract",
      "BLOCKED",
      "一期固定 ConfigPreviewPackage/NON_FORMAL 契约尚未落地；#72 仍是部署阻断。",
    ));

  const systemdLines = activeConfigLines(sources.systemd);
  const execStart = systemdLines.find((line) => line.startsWith("ExecStart="))?.slice(10) ?? "";
  const readWritePaths = systemdLines
    .filter((line) => line.startsWith("ReadWritePaths="))
    .flatMap((line) => line.slice("ReadWritePaths=".length).split(/\s+/u));
  const serviceOk = /(?:^|\s)--hostname\s+127\.0\.0\.1(?:\s|$)/u.test(execStart)
    && readWritePaths.length === 1
    && readWritePaths[0] === "/opt/tackle-forger/data";
  checks.push(serviceOk
    ? check("systemd_isolation", "PASS", "应用只监听回环地址，systemd 仅开放持久数据根写权限。")
    : check("systemd_isolation", "BLOCKED", "systemd 模板未满足回环监听或持久目录隔离。"));

  const nginxHeaders = new Map(activeConfigLines(sources.nginx).flatMap((line) => {
    const match = /^proxy_set_header\s+(\S+)\s+"";$/u.exec(line);
    return match ? [[match[1].toLowerCase(), ""]] : [];
  }));
  const nginxOk = [
    "x-feishu-tenant-key",
    "x-feishu-open-id",
    "x-tf-proxy-secret",
  ].every((header) => nginxHeaders.has(header));
  checks.push(nginxOk
    ? check("nginx_identity_header_strip", "PASS", "Nginx 模板清除客户端身份与代理密钥头。")
    : check("nginx_identity_header_strip", "BLOCKED", "Nginx 模板未完整清除身份/代理密钥头。"));
  return checks;
}

async function loadSourceContracts(root) {
  const read = (relative) => readFile(path.join(root, relative), "utf8");
  const [
    capabilities,
    migrations,
    workbookRoute,
    systemd,
    nginx,
    configExport,
    interactionContracts,
  ] = await Promise.all([
    read("lib/feishu-identity.ts"),
    read("lib/migrations.ts"),
    read("app/api/feishu-workbook/route.ts"),
    read("deploy/tackle-forger.service"),
    read("deploy/nginx-tackle-forger.conf.example"),
    read("lib/config-export.ts"),
    read("lib/interaction-contracts.ts"),
  ]);
  return {
    capabilities,
    migrations,
    workbookRoute,
    systemd,
    nginx,
    repositoryText: `${configExport}\n${interactionContracts}`,
  };
}

function safeGit(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function gitSucceeds(root, args) {
  try {
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function inspectDependencyCommits(root, env) {
  const invalidKeys = [];
  const nonAncestorKeys = [];
  for (const key of DEPENDENCY_COMMIT_KEYS) {
    const commit = env[key]?.trim() ?? "";
    if (!/^[0-9a-f]{40}$/u.test(commit)) {
      invalidKeys.push(key);
      continue;
    }
    if (!gitSucceeds(root, ["merge-base", "--is-ancestor", commit, "HEAD"])) {
      nonAncestorKeys.push(key);
    }
  }
  return invalidKeys.length || nonAncestorKeys.length
    ? check(
      "merged_dependency_commits",
      "BLOCKED",
      "未证明 #67、#71、#72 的已审核实现 commit 均包含在待部署 HEAD 中。",
      { invalidKeys, nonAncestorKeys },
    )
    : check(
      "merged_dependency_commits",
      "PASS",
      "三项依赖 commit 均为待部署 HEAD 的祖先；GitHub review/CI 仍需人工核对。",
      { keys: [...DEPENDENCY_COMMIT_KEYS] },
    );
}

function safeNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return {
    value: process.versions.node,
    supported: major > 22 || (major === 22 && minor >= 16),
  };
}

async function environmentFileChecks(envFile) {
  if (!envFile) {
    return {
      env: {},
      checks: [
        check(
          "production_environment_file",
          "BLOCKED",
          "未提供 --env-file；尚未核对目标服务器配置、权限和持久路径。",
        ),
      ],
    };
  }
  try {
    const [text, info] = await Promise.all([readFile(envFile, "utf8"), stat(envFile)]);
    const mode = info.mode & 0o777;
    const permissionCheck = (mode & 0o077) === 0
      ? check("environment_file_permissions", "PASS", "环境文件没有组/其他用户权限。", {
        mode: mode.toString(8).padStart(3, "0"),
      })
      : check("environment_file_permissions", "BLOCKED", "环境文件权限必须收敛到 0600 或更严格。", {
        mode: mode.toString(8).padStart(3, "0"),
      });
    const env = parseEnv(text);
    return {
      env,
      checks: [
        check("production_environment_file", "PASS", "已读取目标环境文件；证据不包含配置值。", {
          configuredKeys: Object.keys(env).sort(),
        }),
        permissionCheck,
        ...inspectEnvironmentValues(env),
        await inspectRuntimePathFilesystem(env),
      ],
    };
  } catch (error) {
    return {
      env: {},
      checks: [
        check("production_environment_file", "BLOCKED", "无法读取目标环境文件。", {
          errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : "READ_FAILED",
        }),
      ],
    };
  }
}

export async function runPreflight({ root = process.cwd(), envFile } = {}) {
  const generatedAt = new Date().toISOString();
  const node = safeNodeVersion();
  const gitCommit = safeGit(root, ["rev-parse", "HEAD"]);
  const dirty = Boolean(safeGit(root, ["status", "--porcelain"]));
  const checks = [
    node.supported
      ? check("node_version", "PASS", "Node.js 满足 22.16.0+。", { version: node.value })
      : check("node_version", "BLOCKED", "Node.js 必须为 22.16.0 或更新版本。", { version: node.value }),
    gitCommit
      ? check("immutable_build_commit", "PASS", "已解析不可变构建 commit。", { commit: gitCommit })
      : check("immutable_build_commit", "BLOCKED", "无法解析不可变构建 commit。"),
    dirty
      ? check("clean_release_tree", "BLOCKED", "发布工作树存在未提交变更。")
      : check("clean_release_tree", "PASS", "发布工作树无未提交变更。"),
  ];
  try {
    checks.push(...inspectSourceContracts(await loadSourceContracts(root)));
  } catch {
    checks.push(check("repository_contracts", "FAIL", "无法读取一期部署契约文件。"));
  }
  const environment = await environmentFileChecks(envFile);
  checks.push(...environment.checks);
  checks.push(inspectDependencyCommits(root, environment.env));
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    mode: "preflight",
    generatedAt,
    target: { repositoryRootHash: sha256(path.resolve(root)) },
    checks,
    summary: summarize(checks),
  };
}

function secretCandidates(env) {
  return SECRET_ENV_KEYS
    .map((key) => env[key]?.trim())
    .filter((value) => typeof value === "string" && value.length >= 8);
}

function containsSecret(value, secrets) {
  return secrets.some((secret) => value.includes(secret));
}

async function responseEvidence(response, secrets) {
  const body = await response.text();
  const headers = [...response.headers.entries()]
    .filter(([key]) => key.toLowerCase() !== "set-cookie")
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    status: response.status,
    bodyHash: sha256(body),
    bodyBytes: Buffer.byteLength(body),
    leakedConfiguredSecret: containsSecret(`${body}\n${JSON.stringify(headers)}`, secrets),
    json: (() => {
      try {
        return JSON.parse(body);
      } catch {
        return undefined;
      }
    })(),
    location: response.headers.get("location"),
    setCookie: response.headers.get("set-cookie"),
  };
}

function configuredRedirectUrl(env) {
  try {
    return new URL(env.FEISHU_REDIRECT_URI ?? "");
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(value, {
  allowPrivateHttp = false,
  env = {},
  requireConfiguredOrigin = false,
} = {}) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("base URL 必须只包含 origin，不得包含凭据、路径、查询参数或 fragment。");
  }
  const privateHttp = url.protocol === "http:"
    && allowPrivateHttp
    && env.FEISHU_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === "true"
    && isRfc1918Ipv4Hostname(url.hostname);
  if (url.protocol !== "https:" && !privateHttp) {
    throw new Error(
      "base URL 必须使用 HTTPS；RFC 1918 HTTP 同时要求 CLI 开关和 FEISHU_ALLOW_INSECURE_HTTP=true。",
    );
  }
  const redirect = configuredRedirectUrl(env);
  if (
    requireConfiguredOrigin
    && (
      !redirect
      || redirect.origin !== url.origin
      || redirect.pathname !== "/api/auth/feishu/callback"
    )
  ) {
    throw new Error("携带会话前，base URL 必须与已配置飞书回调 origin 精确一致。");
  }
  return url;
}

async function fetchProbe(fetchImpl, baseUrl, pathname, options, secrets) {
  const response = await fetchImpl(new URL(pathname, baseUrl), {
    redirect: "manual",
    cache: "no-store",
    ...options,
  });
  return responseEvidence(response, secrets);
}

export async function runPublicSmoke({
  baseUrl,
  allowPrivateHttp = false,
  env = {},
  fetchImpl = fetch,
} = {}) {
  const generatedAt = new Date().toISOString();
  const target = normalizeBaseUrl(baseUrl, { allowPrivateHttp, env });
  const secrets = secretCandidates(env);
  const checks = [];

  const root = await fetchProbe(fetchImpl, target, "/", {}, secrets);
  checks.push(root.status >= 200 && root.status < 400 && !root.leakedConfiguredSecret
    ? check("root_reachable", "PASS", "内网页面入口可达且未回显已配置密钥。", {
      status: root.status, bodyHash: root.bodyHash,
    })
    : check("root_reachable", "FAIL", "内网页面入口不可用或响应疑似包含已配置密钥。", {
      status: root.status, leakedConfiguredSecret: root.leakedConfiguredSecret,
    }));

  const session = await fetchProbe(fetchImpl, target, "/api/auth/session", {}, secrets);
  if (
    session.status === 401
    && session.json?.errorCode === "AUTH-SESSION-001"
    && !session.leakedConfiguredSecret
  ) {
    checks.push(check("anonymous_session", "PASS", "未登录会话按预期返回 401。", {
      status: session.status, errorCode: session.json.errorCode,
    }));
  } else if (session.status === 503 && session.json?.errorCode === "AUTH-CONFIG-001") {
    checks.push(check(
      "anonymous_session",
      "BLOCKED",
      "目标环境仍缺少飞书 OAuth/会话配置，真实登录不可验收。",
      {
        status: session.status,
        errorCode: session.leakedConfiguredSecret ? null : session.json.errorCode,
        leakedConfiguredSecret: session.leakedConfiguredSecret,
      },
    ));
  } else {
    checks.push(check("anonymous_session", "FAIL", "未登录会话端点返回了非预期结果。", {
      status: session.status,
      errorCode: session.leakedConfiguredSecret ? null : session.json?.errorCode ?? null,
      leakedConfiguredSecret: session.leakedConfiguredSecret,
    }));
  }

  const starts = await Promise.all([0, 1].map(() => fetchProbe(
    fetchImpl,
    target,
    "/api/auth/feishu/start?return_to=%2F",
    {},
    secrets,
  )));
  const redirects = starts.map((start) => {
    try {
      return new URL(start.location ?? "");
    } catch {
      return undefined;
    }
  });
  const configuredRedirect = configuredRedirectUrl(env);
  let configuredAuthorization;
  try {
    configuredAuthorization = new URL(
      "/open-apis/authen/v1/authorize",
      env.FEISHU_ACCOUNTS_BASE_URL ?? "https://accounts.feishu.cn",
    );
  } catch {
    configuredAuthorization = undefined;
  }
  const states = redirects.map((redirect) => redirect?.searchParams.get("state") ?? "");
  const redirectValid = redirects.every((redirect, index) => {
    if (!redirect || !configuredRedirect || !configuredAuthorization) return false;
    let returnedCallback;
    try {
      returnedCallback = new URL(redirect.searchParams.get("redirect_uri") ?? "");
    } catch {
      return false;
    }
    return (
      [302, 303, 307, 308].includes(starts[index].status)
      && configuredAuthorization.protocol === "https:"
      && redirect.protocol === "https:"
      && redirect.origin === configuredAuthorization.origin
      && redirect.pathname === configuredAuthorization.pathname
      && configuredRedirect.origin === target.origin
      && configuredRedirect.pathname === "/api/auth/feishu/callback"
      && returnedCallback.toString() === configuredRedirect.toString()
      && redirect.searchParams.has("client_id")
      && states[index].length >= 16
    );
  }) && states[0] !== states[1];
  const cookieValid = starts.every((start, index) => {
    const cookie = start.setCookie ?? "";
    const pendingState = /(?:^|;\s*)tf_feishu_pending=([^;]+)/iu.exec(cookie)?.[1] ?? "";
    return (
      pendingState === states[index]
      && /HttpOnly/iu.test(cookie)
      && /SameSite=Lax/iu.test(cookie)
      && /Path=\//iu.test(cookie)
      && (target.protocol === "http:" || /Secure/iu.test(cookie))
    );
  });
  const leakedConfiguredSecret = starts.some((start) => start.leakedConfiguredSecret);
  const configurationMissing = starts.some((start) => start.status === 503)
    || !configuredRedirect
    || !configuredAuthorization;
  checks.push(redirectValid && cookieValid && !leakedConfiguredSecret
    ? check("oauth_start", "PASS", "两次 OAuth 起点返回不同 state、精确回调和安全短期 Cookie。", {
      statuses: starts.map((start) => start.status),
      authorizationOrigin: configuredAuthorization.origin,
      callbackOrigin: configuredRedirect.origin,
      callbackPath: configuredRedirect.pathname,
      statesDistinct: true,
      secureCookie: target.protocol === "https:",
    })
    : check(
      "oauth_start",
      configurationMissing ? "BLOCKED" : "FAIL",
      "OAuth 起点未满足授权来源、精确回调、state 新鲜性或 Cookie 契约。",
      {
        statuses: starts.map((start) => start.status),
        redirectValid,
        cookieValid,
        statesDistinct: Boolean(states[0] && states[1] && states[0] !== states[1]),
        leakedConfiguredSecret,
      },
    ));

  for (const [id, pathname] of [
    ["anonymous_state", "/api/state"],
    ["anonymous_revisions", "/api/revisions"],
    ["anonymous_workbook", "/api/feishu-workbook"],
  ]) {
    const probe = await fetchProbe(fetchImpl, target, pathname, {}, secrets);
    checks.push(probe.status === 401 && !probe.leakedConfiguredSecret
      ? check(id, "PASS", `${pathname} 对未登录请求返回 401。`, { status: probe.status })
      : check(id, "FAIL", `${pathname} 未按一期身份边界拒绝未登录请求。`, {
        status: probe.status,
        leakedConfiguredSecret: probe.leakedConfiguredSecret,
      }));
  }

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    mode: "public-smoke",
    generatedAt,
    target: { origin: target.origin },
    checks,
    summary: summarize(checks),
  };
}

function hashIdentity(value) {
  return typeof value === "string" && value ? sha256(value) : null;
}

function capabilityBoundary(capabilities) {
  const unique = [...new Set(capabilities)];
  const forbidden = unique.filter((capability) => (
    capability.startsWith("ai.")
    || FORBIDDEN_PHASE_ONE_CAPABILITIES.has(capability)
    || !EXPECTED_PHASE_ONE_CAPABILITIES.has(capability)
  )).sort();
  const missing = [...EXPECTED_PHASE_ONE_CAPABILITIES]
    .filter((capability) => !unique.includes(capability))
    .sort();
  return {
    valid: forbidden.length === 0
      && missing.length === 0
      && unique.length === capabilities.length,
    forbidden,
    missing,
    duplicateCount: capabilities.length - unique.length,
  };
}

function workbookEvidence(inspection) {
  const source = inspection?.sourceRevision;
  const sheets = Array.isArray(source?.sheets) ? source.sheets : [];
  return {
    sourceRevision: source?.sourceRevision ?? null,
    spreadsheetTokenHash: hashIdentity(source?.spreadsheetToken),
    sheets: sheets
      .map((sheet) => ({ sheetId: sheet.sheetId, name: sheet.name ?? null }))
      .sort((left, right) => String(left.sheetId).localeCompare(String(right.sheetId))),
  };
}

function validateCanonicalWorkbook(inspection, expectedSpreadsheetToken) {
  const source = inspection?.sourceRevision;
  const sheets = Array.isArray(source?.sheets) ? source.sheets : [];
  const sheetIds = sheets.map((sheet) => String(sheet?.sheetId ?? ""));
  const duplicateSheetIds = [...new Set(
    sheetIds.filter((sheetId, index) => sheetId && sheetIds.indexOf(sheetId) !== index),
  )].sort();
  const observedById = new Map(sheets.map((sheet) => [
    String(sheet?.sheetId ?? ""),
    String(sheet?.name ?? ""),
  ]));
  const missingSheets = [...EXPECTED_CANONICAL_SHEETS.keys()]
    .filter((sheetId) => !observedById.has(sheetId));
  const renamedSheets = [...EXPECTED_CANONICAL_SHEETS]
    .filter(([sheetId, expectedName]) => (
      observedById.has(sheetId) && observedById.get(sheetId) !== expectedName
    ))
    .map(([sheetId]) => sheetId);
  const blockingIssueCodes = (Array.isArray(source?.issues) ? source.issues : [])
    .filter((issue) => issue?.severity === "error")
    .map((issue) => String(issue.code ?? "UNKNOWN"))
    .sort();
  const valid = (
    source?.workbookRefId === EXPECTED_WORKBOOK_REF_ID
    && typeof source?.sourceRevision === "string"
    && source.sourceRevision.trim().length > 0
    && typeof source?.registryHash === "string"
    && source.registryHash.trim().length > 0
    && typeof source?.spreadsheetToken === "string"
    && source.spreadsheetToken === expectedSpreadsheetToken
    && duplicateSheetIds.length === 0
    && missingSheets.length === 0
    && renamedSheets.length === 0
    && blockingIssueCodes.length === 0
  );
  return {
    valid,
    evidence: {
      ...workbookEvidence(inspection),
      workbookRefMatched: source?.workbookRefId === EXPECTED_WORKBOOK_REF_ID,
      spreadsheetTokenMatched: source?.spreadsheetToken === expectedSpreadsheetToken,
      duplicateSheetIds,
      missingSheets,
      renamedSheets,
      blockingIssueCodes,
    },
  };
}

function stateEvidence(payload) {
  const state = payload?.state;
  const snapshots = Array.isArray(state?.configurationSnapshots) ? state.configurationSnapshots : [];
  const snapshotRefs = snapshots
    .map((snapshot) => ({ id: snapshot.id, contentHash: snapshot.contentHash ?? null }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    revision: payload?.revision ?? null,
    schemaVersion: state?.schemaVersion ?? null,
    seriesCount: Array.isArray(state?.seriesDefinitions) ? state.seriesDefinitions.length : 0,
    skuCount: Array.isArray(state?.skuDrawers) ? state.skuDrawers.length : 0,
    modelCount: Array.isArray(state?.purchasableModels) ? state.purchasableModels.length : 0,
    snapshotCount: snapshots.length,
    snapshotRefSetHash: sha256(JSON.stringify(snapshotRefs)),
  };
}

export async function runAuthenticatedReadOnlySmoke({
  baseUrl,
  cookieHeader,
  allowPrivateHttp = false,
  env = {},
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const generatedAt = new Date().toISOString();
  const expectedTenant = env.FEISHU_TENANT_KEY?.trim();
  const expectedSpreadsheetToken = env.FEISHU_CANONICAL_SPREADSHEET_TOKEN?.trim();
  if (!expectedTenant || !expectedSpreadsheetToken) {
    throw new Error(
      "authenticated-read-only 需要环境中的 FEISHU_TENANT_KEY 和 FEISHU_CANONICAL_SPREADSHEET_TOKEN。",
    );
  }
  if (!/^tf_session=[^;\s]+$/u.test(cookieHeader ?? "")) {
    throw new Error("authenticated-read-only 需要单一不透明 tf_session Cookie。");
  }
  const target = normalizeBaseUrl(baseUrl, {
    allowPrivateHttp,
    env,
    requireConfiguredOrigin: true,
  });
  const secrets = [...secretCandidates(env), cookieHeader].filter(Boolean);
  const headers = { cookie: cookieHeader };
  const checks = [];

  const session = await fetchProbe(fetchImpl, target, "/api/auth/session", { headers }, secrets);
  const user = session.json?.user;
  const capabilities = !session.leakedConfiguredSecret && Array.isArray(user?.capabilities)
    ? user.capabilities
    : [];
  const tenantMatched = user?.tenantKey === expectedTenant;
  const expiresAtMs = Date.parse(user?.sessionExpiresAt ?? "");
  const sessionUnexpired = Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime();
  checks.push(
    !session.leakedConfiguredSecret
      && session.status === 200
      && session.json?.authenticated === true
      && tenantMatched
      && user?.openId
      && sessionUnexpired
    ? check("authenticated_session", "PASS", "已登录会话有效，证据仅保留身份哈希。", {
      tenantKeyHash: hashIdentity(user.tenantKey),
      openIdHash: hashIdentity(user.openId),
      sessionExpiresAt: user.sessionExpiresAt,
      tenantMatched: true,
      sessionUnexpired: true,
    })
    : check(
      "authenticated_session",
      "BLOCKED",
      "会话无效、租户不匹配或已经过期，不能作为公司飞书验收身份。",
      {
        status: session.status,
        errorCode: session.leakedConfiguredSecret ? null : session.json?.errorCode ?? null,
        tenantMatched,
        sessionUnexpired,
        leakedConfiguredSecret: session.leakedConfiguredSecret,
      },
    ),
  );

  const runtimeCapabilities = capabilityBoundary(capabilities);
  checks.push(!runtimeCapabilities.valid
    ? check("runtime_capability_boundary", "BLOCKED", "真实会话未精确匹配一期 Capability 允许集合。", {
      forbiddenCapabilities: runtimeCapabilities.forbidden,
      missingCapabilities: runtimeCapabilities.missing,
      duplicateCount: runtimeCapabilities.duplicateCount,
    })
    : check("runtime_capability_boundary", "PASS", "真实会话只获得一期已启用业务 Capability。", {
      capabilityCount: capabilities.length,
    }));

  const state = await fetchProbe(fetchImpl, target, "/api/state", { headers }, secrets);
  const validWorkspace = state.status === 200
    && Number.isInteger(state.json?.revision)
    && state.json?.state?.schemaVersion === 17;
  checks.push(validWorkspace
    ? check(
      "workspace_read",
      "PASS",
      "已只读读取 schema 17 工作区并生成去敏计数/哈希证据。",
      stateEvidence(state.json),
    )
    : check("workspace_read", "BLOCKED", "目标工作区不是可验证的 schema 17 revision。", {
      status: state.status,
      revisionValid: Number.isInteger(state.json?.revision),
      schemaVersion: state.json?.state?.schemaVersion ?? null,
    }));

  const revisions = await fetchProbe(fetchImpl, target, "/api/revisions", { headers }, secrets);
  const revisionList = revisions.json?.revisions;
  checks.push(revisions.status === 200 && Array.isArray(revisionList)
    ? check("revision_read", "PASS", "已只读确认 workspace revision 可访问；本脚本不执行裁剪。", {
      revisionCountVisible: revisionList.length,
    })
    : check("revision_read", "BLOCKED", "无法只读读取 workspace revision。", {
      status: revisions.status,
    }));

  const workbook = await fetchProbe(fetchImpl, target, "/api/feishu-workbook", { headers }, secrets);
  const canonicalWorkbook = validateCanonicalWorkbook(
    workbook.json?.inspection,
    expectedSpreadsheetToken,
  );
  const canonicalWorkbookEvidence = workbook.leakedConfiguredSecret
    ? { leakedConfiguredSecret: true }
    : canonicalWorkbook.evidence;
  checks.push(
    workbook.status === 200
      && canonicalWorkbook.valid
      && !workbook.leakedConfiguredSecret
    ? check(
      "authoritative_workbook_read",
      "PASS",
      "已只读核对规范工作簿身份、完整稳定表集合和阻断 issue；token 只保留哈希。",
      canonicalWorkbookEvidence,
    )
    : check(
      "authoritative_workbook_read",
      "BLOCKED",
      "工作簿身份、token、稳定表集合或 inspection issue 不满足权威契约。",
      { status: workbook.status, ...canonicalWorkbookEvidence },
    ),
  );

  const leaked = [session, state, revisions, workbook].some((probe) => probe.leakedConfiguredSecret);
  checks.push(leaked
    ? check("response_secret_scan", "FAIL", "只读响应疑似回显会话或已配置密钥。")
    : check("response_secret_scan", "PASS", "只读响应未回显会话 Cookie 或已配置密钥。"));

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    mode: "authenticated-read-only",
    generatedAt,
    target: { origin: target.origin },
    checks,
    summary: summarize(checks),
  };
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const values = { mode };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--allow-private-http") {
      values.allowPrivateHttp = true;
      continue;
    }
    if (!item.startsWith("--") || index + 1 >= rest.length) {
      throw new Error(`无法识别参数 ${item}`);
    }
    values[item.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = rest[index + 1];
    index += 1;
  }
  return values;
}

function usage() {
  return [
    "用法：",
    "  npm run acceptance:phase-one -- preflight [--env-file /opt/tackle-forger/.env.local] [--output audit-output/preflight.json]",
    "  npm run acceptance:phase-one -- public-smoke --base-url https://tackle.internal [--env-file /opt/tackle-forger/.env.local] [--output ...]",
    "  npm run acceptance:phase-one -- authenticated-read-only --base-url https://tackle.internal --cookie-file /run/user/.../cookie --env-file /opt/tackle-forger/.env.local [--output ...]",
    "",
    "脚本只执行读取和 HTTP GET；不会拉取、发布、写入工作区、退出会话、部署或裁剪 revision。",
  ].join("\n");
}

async function readOptionalEnv(envFile) {
  return envFile ? parseEnv(await readFile(envFile, "utf8")) : {};
}

export async function readSessionCookieFile({ cookieFile, root = process.cwd() }) {
  if (!path.isAbsolute(cookieFile)) {
    throw new Error("cookie 文件必须使用仓库外绝对路径。");
  }
  const info = await lstat(cookieFile);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("cookie 文件必须是普通文件，不能是目录或符号链接。");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("cookie 文件必须为 0600 或更严格，且不得提交仓库。");
  }
  const [canonicalCookie, canonicalRoot] = await Promise.all([
    realpath(cookieFile),
    realpath(root),
  ]);
  const relativeToRoot = path.relative(canonicalRoot, canonicalCookie);
  if (
    relativeToRoot === ""
    || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))
  ) {
    throw new Error("cookie 文件必须位于仓库工作树之外。");
  }
  const cookieHeader = (await readFile(canonicalCookie, "utf8")).trim();
  if (!/^tf_session=[^;\s]+$/u.test(cookieHeader)) {
    throw new Error("cookie 文件只能包含单行 tf_session=<opaque-id>。");
  }
  return cookieHeader;
}

export async function writeEvidenceFile(output, evidence) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(output, serialized, { mode: 0o600, flag: "wx" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode || args.mode === "help" || args.mode === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let evidence;
  if (args.mode === "preflight") {
    evidence = await runPreflight({ root: process.cwd(), envFile: args.envFile });
  } else if (args.mode === "public-smoke") {
    if (!args.baseUrl) throw new Error("public-smoke 需要 --base-url。");
    evidence = await runPublicSmoke({
      baseUrl: args.baseUrl,
      allowPrivateHttp: Boolean(args.allowPrivateHttp),
      env: await readOptionalEnv(args.envFile),
    });
  } else if (args.mode === "authenticated-read-only") {
    if (!args.baseUrl || !args.cookieFile || !args.envFile) {
      throw new Error(
        "authenticated-read-only 需要 --base-url、--cookie-file 和 --env-file。",
      );
    }
    const cookieHeader = await readSessionCookieFile({
      cookieFile: args.cookieFile,
      root: process.cwd(),
    });
    evidence = await runAuthenticatedReadOnlySmoke({
      baseUrl: args.baseUrl,
      cookieHeader,
      allowPrivateHttp: Boolean(args.allowPrivateHttp),
      env: await readOptionalEnv(args.envFile),
    });
  } else {
    throw new Error(`未知模式 ${args.mode}。\n${usage()}`);
  }

  if (args.output) {
    await writeEvidenceFile(args.output, evidence);
    process.stdout.write(`验收证据已写入 ${args.output}（新文件，0600）。\n`);
  } else {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (evidence.summary.overall !== "PASS") process.exitCode = 2;
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    process.stderr.write(`phase-one acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  });
}
