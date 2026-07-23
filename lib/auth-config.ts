import { isIP } from "node:net";

export interface FeishuRuntimeConfig {
  appId: string;
  appSecret: string;
  tenantKey: string;
  redirectUri: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  openApiBaseUrl: string;
  accountsBaseUrl: string;
  oauthScopes: string;
}

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_OAUTH_SCOPES = "contact:user.base:readonly";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少必要配置 ${name}。`);
  return value;
}

function httpsBaseUrl(name: string, fallback: string) {
  const parsed = new URL(process.env[name]?.trim() || fallback);
  if (parsed.protocol !== "https:") throw new Error(`${name} 必须使用 HTTPS。`);
  return parsed.toString().replace(/\/$/, "");
}

function isRfc1918Ipv4Hostname(hostname: string) {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

let sessionDeploymentTargetWarned = false;
function warnSessionDeploymentTarget() {
  if (sessionDeploymentTargetWarned) return;
  sessionDeploymentTargetWarned = true;
  if (process.env.VERCEL) {
    console.warn(
      "[tackle-forger] 会话存储基于本地文件锁，正式部署目标为持久磁盘的单实例服务器（Dell R730）。检测到 VERCEL 运行环境：会话不跨实例共享且重启后丢失，仅可作为评审入口，不得作为正式会话存储。",
    );
  }
}

export function feishuRuntimeConfig(): FeishuRuntimeConfig {
  warnSessionDeploymentTarget();
  const ttlText = process.env.FEISHU_SESSION_TTL_SECONDS?.trim();
  const sessionTtlSeconds = ttlText ? Number.parseInt(ttlText, 10) : DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60) {
    throw new Error("FEISHU_SESSION_TTL_SECONDS 必须是至少 60 秒的整数。");
  }
  const redirect = new URL(required("FEISHU_REDIRECT_URI"));
  const privateHttp = redirect.protocol === "http:"
    && process.env.FEISHU_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === "true"
    && isRfc1918Ipv4Hostname(redirect.hostname);
  if (redirect.protocol !== "https:" && !privateHttp) {
    throw new Error(
      "FEISHU_REDIRECT_URI 必须使用 HTTPS；仅显式启用时允许 RFC 1918 数值 IPv4 HTTP。",
    );
  }
  const sessionSecret = required("FEISHU_SESSION_SECRET");
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("FEISHU_SESSION_SECRET 至少需要 32 字节的高熵随机值。");
  }
  return {
    appId: required("FEISHU_APP_ID"),
    appSecret: required("FEISHU_APP_SECRET"),
    tenantKey: required("FEISHU_TENANT_KEY"),
    redirectUri: redirect.toString(),
    sessionSecret,
    sessionTtlSeconds,
    openApiBaseUrl: httpsBaseUrl("FEISHU_OPEN_API_BASE_URL", "https://open.feishu.cn"),
    accountsBaseUrl: httpsBaseUrl("FEISHU_ACCOUNTS_BASE_URL", "https://accounts.feishu.cn"),
    oauthScopes: process.env.FEISHU_OAUTH_SCOPES?.trim() || DEFAULT_OAUTH_SCOPES,
  };
}

export function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://tackle-forger.invalid");
    return parsed.origin === "https://tackle-forger.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function authCookieSecure() {
  try {
    return new URL(process.env.FEISHU_REDIRECT_URI?.trim() || "https://invalid").protocol === "https:";
  } catch {
    return true;
  }
}

export function publicSupportUrl() {
  const value = process.env.TACKLE_FORGER_SUPPORT_URL?.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "mailto:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
