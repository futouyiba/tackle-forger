#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_SCHEMA_VERSION = "phase-one-acceptance-evidence/v1";
const DEPENDENCY_EVIDENCE_SCHEMA_VERSION = "phase-one-dependency-evidence/v1";
const EXPECTED_WORKBOOK_REF_ID = "feishu-workbook:tackle-design";
const EXPECTED_DEPENDENCIES = new Map([
  ["canonical_rule_source", { issue: 66, pr: 67 }],
  ["schema_v17", { issue: 68, pr: 71 }],
  ["non_formal_preview", { issue: 72, pr: 76 }],
]);
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

export async function readSecureEnvironmentFile({
  envFile,
  root = process.cwd(),
}) {
  if (!path.isAbsolute(envFile)) {
    throw new Error("环境文件必须使用仓库外绝对路径。");
  }
  const info = await lstat(envFile);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("环境文件必须是普通文件，不能是目录或符号链接。");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("环境文件必须为 0600 或更严格。");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("环境文件必须归当前服务账号所有。");
  }
  const [canonicalEnvFile, canonicalRoot] = await Promise.all([
    realpath(envFile),
    realpath(root),
  ]);
  const relativeToRoot = path.relative(canonicalRoot, canonicalEnvFile);
  if (
    relativeToRoot === ""
    || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))
  ) {
    throw new Error("环境文件必须位于仓库工作树之外。");
  }
  const text = await readFile(canonicalEnvFile, "utf8");
  return {
    env: parseEnv(text),
    mode: info.mode & 0o777,
  };
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

export function inspectRuntimePaths(env) {
  const dataRoot = "/opt/tackle-forger/data";
  const entries = [
    ["WORKSPACE_DATABASE_PATH", env.WORKSPACE_DATABASE_PATH],
    ["WORKSPACE_FILE_DATA_DIR", env.WORKSPACE_FILE_DATA_DIR],
    ["WORKSPACE_BACKUP_DIR", env.WORKSPACE_BACKUP_DIR],
    ["FEISHU_SESSION_DATA_DIR", env.FEISHU_SESSION_DATA_DIR],
  ];
  const normalized = entries.map(([key, value]) => [
    key,
    value,
    value ? path.resolve(value) : value,
  ]);
  const invalid = normalized.filter(([, original, canonical]) => (
    !original
    || !path.isAbsolute(original)
    || path.relative(dataRoot, canonical).startsWith("..")
    || path.relative(dataRoot, canonical) === ""
    || canonical.startsWith("/opt/tackle-forger/current/")
  ));
  const duplicate = new Set(normalized.map(([, , canonical]) => canonical).filter(Boolean)).size
    !== normalized.filter(([, , canonical]) => Boolean(canonical)).length;
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

export async function inspectRuntimePathFilesystem(
  env,
  { dataRoot = "/opt/tackle-forger/data" } = {},
) {
  const entries = [
    ["WORKSPACE_DATABASE_PATH", env.WORKSPACE_DATABASE_PATH, "file"],
    ["WORKSPACE_FILE_DATA_DIR", env.WORKSPACE_FILE_DATA_DIR, "directory"],
    ["WORKSPACE_BACKUP_DIR", env.WORKSPACE_BACKUP_DIR, "directory"],
    ["FEISHU_SESSION_DATA_DIR", env.FEISHU_SESSION_DATA_DIR, "directory"],
  ];
  const missingKeys = [];
  const outsideRootKeys = [];
  const ownerMismatchKeys = [];
  const exposedPermissionKeys = [];
  const wrongTypeKeys = [];
  const symbolicLinkKeys = [];
  const parentBoundaryKeys = new Set();
  const canonicalPaths = [];
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(dataRoot);
    const rootInfo = await stat(canonicalRoot);
    if (
      !rootInfo.isDirectory()
      || (typeof process.getuid === "function" && rootInfo.uid !== process.getuid())
      || (rootInfo.mode & 0o077) !== 0
      || (rootInfo.mode & 0o700) !== 0o700
    ) {
      parentBoundaryKeys.add(dataRoot);
    }
  } catch {
    return check(
      "persistent_path_filesystem",
      "BLOCKED",
      "目标服务器尚无可解析的持久数据根。",
    );
  }
  for (const [key, value, expectedType] of entries) {
    try {
      const originalInfo = await lstat(value);
      if (originalInfo.isSymbolicLink()) symbolicLinkKeys.push(key);
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
      const typeMatched = expectedType === "file" ? info.isFile() : info.isDirectory();
      if (!typeMatched) wrongTypeKeys.push(key);
      const requiredOwnerMode = expectedType === "file" ? 0o600 : 0o700;
      if (
        (info.mode & 0o077) !== 0
        || (info.mode & requiredOwnerMode) !== requiredOwnerMode
      ) {
        exposedPermissionKeys.push(key);
      }
      let parent = path.dirname(canonical);
      while (
        parent === canonicalRoot
        || (!path.relative(canonicalRoot, parent).startsWith("..")
          && !path.isAbsolute(path.relative(canonicalRoot, parent)))
      ) {
        const parentInfo = await stat(parent);
        if (
          !parentInfo.isDirectory()
          || (typeof process.getuid === "function" && parentInfo.uid !== process.getuid())
          || (parentInfo.mode & 0o077) !== 0
          || (parentInfo.mode & 0o700) !== 0o700
        ) {
          parentBoundaryKeys.add(key);
        }
        if (parent === canonicalRoot) break;
        parent = path.dirname(parent);
      }
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
    || exposedPermissionKeys.length
    || wrongTypeKeys.length
    || symbolicLinkKeys.length
    || parentBoundaryKeys.size
    || duplicateCanonicalPaths
  ) {
    return check(
      "persistent_path_filesystem",
      "BLOCKED",
      "持久路径及父目录必须真实存在、类型正确、位于数据根内、归服务账号所有且仅该账号可访问。",
      {
        missingKeys,
        outsideRootKeys,
        ownerMismatchKeys,
        exposedPermissionKeys,
        wrongTypeKeys,
        symbolicLinkKeys,
        parentBoundaryKeys: [...parentBoundaryKeys].sort(),
        duplicateCanonicalPaths,
      },
    );
  }
  return check(
    "persistent_path_filesystem",
    "PASS",
    "持久路径的真实位置、文件类型、所有者和仅服务账号访问边界符合部署要求。",
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

export async function inspectDependencyManifest(root, { fetchImpl = fetch } = {}) {
  const manifestPath = path.join(root, "deploy/phase-one-dependencies.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const dependencies = Array.isArray(manifest?.dependencies) ? manifest.dependencies : [];
    const duplicateIds = dependencies.length !== new Set(
      dependencies.map((dependency) => dependency?.id),
    ).size;
    const observedIds = new Set(dependencies.map((dependency) => dependency?.id));
    const missingIds = [...EXPECTED_DEPENDENCIES.keys()]
      .filter((id) => !observedIds.has(id));
    const unexpectedIds = [...observedIds]
      .filter((id) => !EXPECTED_DEPENDENCIES.has(id));
    const invalidMappings = [];
    const invalidCommits = [];
    const invalidReviewedHeadCommits = [];
    const duplicateCommits = [];
    const nonAncestorIds = [];
    const commitMessageMismatchIds = [];
    const incompleteReviewIds = [];
    const githubVerificationFailedIds = [];
    const evidence = [];
    const seenCommits = new Set();

    for (const dependency of dependencies) {
      const expected = EXPECTED_DEPENDENCIES.get(dependency?.id);
      if (!expected) continue;
      const expectedUrl = `https://github.com/futouyiba/tackle-forger/pull/${expected.pr}`;
      if (
        dependency.issue !== expected.issue
        || dependency.pr !== expected.pr
        || dependency.evidenceUrl !== expectedUrl
      ) {
        invalidMappings.push(dependency.id);
      }
      const commit = typeof dependency.commit === "string"
        ? dependency.commit.trim()
        : "";
      const reviewedHeadCommit = typeof dependency.reviewedHeadCommit === "string"
        ? dependency.reviewedHeadCommit.trim()
        : "";
      if (!/^[0-9a-f]{40}$/u.test(commit)) {
        invalidCommits.push(dependency.id);
      } else {
        if (seenCommits.has(commit)) duplicateCommits.push(dependency.id);
        seenCommits.add(commit);
        if (!gitSucceeds(root, ["merge-base", "--is-ancestor", commit, "HEAD"])) {
          nonAncestorIds.push(dependency.id);
        }
        const subject = safeGit(root, ["show", "-s", "--format=%s", commit]);
        if (!new RegExp(`(?:#${expected.pr}\\b|\\(#${expected.pr}\\))`, "u").test(subject)) {
          commitMessageMismatchIds.push(dependency.id);
        }
      }
      if (!/^[0-9a-f]{40}$/u.test(reviewedHeadCommit)) {
        invalidReviewedHeadCommits.push(dependency.id);
      }
      if (
        dependency.merged !== true
        || dependency.reviewThreadsResolved !== true
        || dependency.requiredChecksPassed !== true
      ) {
        incompleteReviewIds.push(dependency.id);
      }
      if (
        /^[0-9a-f]{40}$/u.test(commit)
        && /^[0-9a-f]{40}$/u.test(reviewedHeadCommit)
        && dependency.merged === true
      ) {
        try {
          const response = await fetchImpl(
            `https://api.github.com/repos/futouyiba/tackle-forger/pulls/${expected.pr}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            },
          );
          const pullRequest = response.ok ? await response.json() : undefined;
          if (
            pullRequest?.number !== expected.pr
            || pullRequest?.state !== "closed"
            || typeof pullRequest?.merged_at !== "string"
            || pullRequest?.merge_commit_sha !== commit
            || pullRequest?.head?.sha !== reviewedHeadCommit
          ) {
            githubVerificationFailedIds.push(dependency.id);
          }
        } catch {
          githubVerificationFailedIds.push(dependency.id);
        }
      }
      evidence.push({
        id: dependency.id,
        issue: expected.issue,
        pr: expected.pr,
        commit: commit || null,
        reviewedHeadCommit: reviewedHeadCommit || null,
        merged: dependency.merged === true,
        reviewThreadsResolved: dependency.reviewThreadsResolved === true,
        requiredChecksPassed: dependency.requiredChecksPassed === true,
        evidenceUrl: expectedUrl,
      });
    }

    const invalid = (
      manifest?.schemaVersion !== DEPENDENCY_EVIDENCE_SCHEMA_VERSION
      || duplicateIds
      || missingIds.length > 0
      || unexpectedIds.length > 0
      || invalidMappings.length > 0
      || invalidCommits.length > 0
      || invalidReviewedHeadCommits.length > 0
      || duplicateCommits.length > 0
      || nonAncestorIds.length > 0
      || commitMessageMismatchIds.length > 0
      || incompleteReviewIds.length > 0
      || githubVerificationFailedIds.length > 0
    );
    return invalid
      ? check(
        "merged_dependency_commits",
        "BLOCKED",
        "受版本控制的依赖证据尚未证明 #67、#71、#76 已审核、CI 通过并合入待部署 HEAD。",
        {
          manifestSchemaMatched:
            manifest?.schemaVersion === DEPENDENCY_EVIDENCE_SCHEMA_VERSION,
          duplicateIds,
          missingIds,
          unexpectedIds,
          invalidMappings,
          invalidCommits,
          invalidReviewedHeadCommits,
          duplicateCommits,
          nonAncestorIds,
          commitMessageMismatchIds,
          incompleteReviewIds,
          githubVerificationFailedIds,
          dependencies: evidence,
        },
      )
      : check(
        "merged_dependency_commits",
        "PASS",
        "依赖证据已与 GitHub PR head/merge commit 精确核对，且唯一 merge commit 均包含于待部署 HEAD。",
        { dependencies: evidence },
      );
  } catch (error) {
    return check(
      "merged_dependency_commits",
      "BLOCKED",
      "无法读取受版本控制的一期依赖证据清单。",
      {
        errorCode: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "INVALID_MANIFEST",
      },
    );
  }
}

function safeNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return {
    value: process.versions.node,
    supported: major > 22 || (major === 22 && minor >= 16),
  };
}

async function environmentFileChecks(envFile, root = process.cwd()) {
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
    const { env, mode } = await readSecureEnvironmentFile({
      envFile,
      root,
    });
    return {
      env,
      checks: [
        check("production_environment_file", "PASS", "已安全读取仓库外目标环境文件；证据不包含配置值。", {
          configuredKeys: Object.keys(env).sort(),
        }),
        check("environment_file_permissions", "PASS", "环境文件为当前账号所有的 0600 或更严格普通文件。", {
          mode: mode.toString(8).padStart(3, "0"),
        }),
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
  const environment = await environmentFileChecks(envFile, root);
  checks.push(...environment.checks);
  checks.push(await inspectDependencyManifest(root));
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
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") ?? "")
      .split(/,(?=\s*[^;,=\s]+=[^;,]*)/u)
      .map((value) => value.trim())
      .filter(Boolean);
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
    setCookies,
  };
}

function parseSetCookie(value) {
  const [nameValue, ...rawAttributes] = value.split(";").map((part) => part.trim());
  const separator = nameValue.indexOf("=");
  if (separator <= 0) return undefined;
  const attributes = new Map();
  for (const rawAttribute of rawAttributes) {
    const attributeSeparator = rawAttribute.indexOf("=");
    const name = (
      attributeSeparator >= 0 ? rawAttribute.slice(0, attributeSeparator) : rawAttribute
    ).trim().toLowerCase();
    if (!name || attributes.has(name)) return undefined;
    attributes.set(
      name,
      attributeSeparator >= 0 ? rawAttribute.slice(attributeSeparator + 1).trim() : null,
    );
  }
  return {
    name: nameValue.slice(0, separator).trim(),
    value: nameValue.slice(separator + 1).trim(),
    attributes,
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
  const singleParameter = (url, name) => {
    const values = url?.searchParams.getAll(name) ?? [];
    return values.length === 1 ? values[0] : "";
  };
  const states = redirects.map((redirect) => singleParameter(redirect, "state"));
  const redirectValid = redirects.every((redirect, index) => {
    if (!redirect || !configuredRedirect || !configuredAuthorization) return false;
    let returnedCallback;
    try {
      returnedCallback = new URL(singleParameter(redirect, "redirect_uri"));
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
      && singleParameter(redirect, "client_id") === env.FEISHU_APP_ID
      && singleParameter(redirect, "scope") === (
        env.FEISHU_OAUTH_SCOPES ?? "contact:user.base:readonly"
      )
      && states[index].length >= 16
    );
  }) && states[0] !== states[1];
  const cookieValid = starts.every((start, index) => {
    const pendingCookies = (start.setCookies ?? [])
      .map(parseSetCookie)
      .filter((cookie) => cookie?.name === "tf_feishu_pending");
    if (pendingCookies.length !== 1) return false;
    const cookie = pendingCookies[0];
    const attributes = cookie.attributes;
    return (
      cookie.value === states[index]
      && attributes.get("httponly") === null
      && attributes.get("samesite")?.toLowerCase() === "lax"
      && attributes.get("path") === "/"
      && attributes.get("max-age") === "600"
      && (target.protocol === "http:" || attributes.get("secure") === null)
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
  checks.push(check(
    "oauth_pending_state_side_effect",
    "INFO",
    "OAuth 起点会创建两条最长 600 秒的临时 pending login 记录；不写业务工作区。",
    { attemptedPendingRecords: 2, maxAgeSeconds: 600 },
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
  const identityItems = Array.isArray(inspection?.identityReport?.items)
    ? inspection.identityReport.items
    : [];
  const identityRows = Array.isArray(inspection?.identityRows) ? inspection.identityRows : [];
  const qualityIssues = Array.isArray(inspection?.qualityDraft?.issues)
    ? inspection.qualityDraft.issues
    : [];
  const pricingIssues = Array.isArray(inspection?.pricingDraft?.issues)
    ? inspection.pricingDraft.issues
    : [];
  return {
    sourceRevision: source?.sourceRevision ?? null,
    spreadsheetTokenHash: hashIdentity(source?.spreadsheetToken),
    sheets: sheets
      .map((sheet) => ({ sheetId: sheet.sheetId, name: sheet.name ?? null }))
      .sort((left, right) => String(left.sheetId).localeCompare(String(right.sheetId))),
    identityRowCount: identityRows.length,
    identityItemCount: identityItems.length,
    pendingIdentityCount: identityItems.filter((item) => (
      item?.requiresHumanConfirmation === true || item?.state !== "ALREADY_IDENTIFIED"
    )).length,
    identityBlockingIssueCodes: (
      Array.isArray(inspection?.identityReport?.blockingIssueCodes)
        ? inspection.identityReport.blockingIssueCodes
        : []
    ).map(String).sort(),
    qualityDraftStatus: inspection?.qualityDraft?.formalStatus ?? null,
    qualityBlockingIssueCodes: qualityIssues
      .filter((issue) => issue?.severity === "ERROR" || issue?.severity === "BLOCKER")
      .map((issue) => String(issue.code ?? "UNKNOWN"))
      .sort(),
    pricingDraftStatus: inspection?.pricingDraft?.formalStatus ?? null,
    pricingBlockingIssueCodes: pricingIssues
      .filter((issue) => issue?.severity === "error")
      .map((issue) => String(issue.code ?? "UNKNOWN"))
      .sort(),
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
  const identityRows = Array.isArray(inspection?.identityRows) ? inspection.identityRows : [];
  const stableIds = identityRows.map((row) => (
    typeof row?.stableId === "string" ? row.stableId.trim() : ""
  ));
  const missingStableIdentityCount = stableIds.filter((stableId) => !stableId).length;
  const duplicateStableIdentityCount = stableIds.length - new Set(stableIds).size;
  const identityReport = inspection?.identityReport;
  const identityItems = Array.isArray(identityReport?.items) ? identityReport.items : [];
  const identityBlockingIssueCodes = Array.isArray(identityReport?.blockingIssueCodes)
    ? identityReport.blockingIssueCodes.map(String).sort()
    : ["IDENTITY_REPORT_MISSING"];
  const pendingIdentityCount = identityItems.filter((item) => (
    item?.requiresHumanConfirmation === true || item?.state !== "ALREADY_IDENTIFIED"
  )).length;
  const identityReportMatched = (
    identityReport?.workbookRefId === EXPECTED_WORKBOOK_REF_ID
    && identityReport?.sourceRevision === source?.sourceRevision
    && identityRows.length > 0
    && identityItems.length === identityRows.length
    && missingStableIdentityCount === 0
    && duplicateStableIdentityCount === 0
    && identityBlockingIssueCodes.length === 0
    && pendingIdentityCount === 0
  );
  const qualityDraft = inspection?.qualityDraft;
  const qualityBlockingIssueCodes = (
    Array.isArray(qualityDraft?.issues) ? qualityDraft.issues : []
  )
    .filter((issue) => issue?.severity === "ERROR" || issue?.severity === "BLOCKER")
    .map((issue) => String(issue.code ?? "UNKNOWN"))
    .sort();
  const qualityDraftMatched = (
    qualityDraft?.sourceRevisionId === source?.id
    && qualityDraft?.sourceRevision === source?.sourceRevision
    && qualityDraft?.formalStatus === "READY_TO_PUBLISH"
    && qualityBlockingIssueCodes.length === 0
  );
  const pricingDraft = inspection?.pricingDraft;
  const pricingBlockingIssueCodes = (
    Array.isArray(pricingDraft?.issues) ? pricingDraft.issues : []
  )
    .filter((issue) => issue?.severity === "error")
    .map((issue) => String(issue.code ?? "UNKNOWN"))
    .sort();
  const pricingDraftMatched = (
    pricingDraft?.sourceRevisionId === source?.id
    && pricingDraft?.sourceRevision === source?.sourceRevision
    && ["TRIAL_READY", "READY_TO_PUBLISH"].includes(pricingDraft?.formalStatus)
    && pricingBlockingIssueCodes.length === 0
    && inspection?.pricingWeightBandPolicy === "MATCHED_STRUCTURAL_SOURCE_BAND"
  );
  const valid = (
    source?.workbookRefId === EXPECTED_WORKBOOK_REF_ID
    && typeof source?.id === "string"
    && source.id.trim().length > 0
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
    && identityReportMatched
    && qualityDraftMatched
    && pricingDraftMatched
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
      identityReportMatched,
      missingStableIdentityCount,
      duplicateStableIdentityCount,
      pendingIdentityCount,
      identityBlockingIssueCodes,
      qualityDraftMatched,
      qualityDraftStatus: qualityDraft?.formalStatus ?? null,
      qualityBlockingIssueCodes,
      pricingDraftMatched,
      pricingDraftStatus: pricingDraft?.formalStatus ?? null,
      pricingBlockingIssueCodes,
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
      "已核对规范工作簿、完整稳定表、稳定身份及品质/定价草稿阻断；token 只保留哈希。",
      canonicalWorkbookEvidence,
    )
    : check(
      "authoritative_workbook_read",
      "BLOCKED",
      "工作簿身份、token、稳定表、稳定身份或品质/定价草稿不满足权威契约。",
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
    "脚本不写业务工作区，不会拉取、发布、退出会话、部署或裁剪 revision。",
    "public-smoke 会调用两次 OAuth start，并创建两条最长 600 秒的临时 pending login 记录。",
  ].join("\n");
}

async function readOptionalEnv(envFile) {
  return envFile
    ? (await readSecureEnvironmentFile({ envFile, root: process.cwd() })).env
    : {};
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
