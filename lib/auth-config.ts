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

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return octets[0] === 10 || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function feishuRuntimeConfig(): FeishuRuntimeConfig {
  const ttlText = process.env.FEISHU_SESSION_TTL_SECONDS?.trim();
  const sessionTtlSeconds = ttlText ? Number.parseInt(ttlText, 10) : DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60) {
    throw new Error("FEISHU_SESSION_TTL_SECONDS 必须是至少 60 秒的整数。");
  }
  const redirect = new URL(required("FEISHU_REDIRECT_URI"));
  const privateHttp = redirect.protocol === "http:"
    && process.env.FEISHU_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === "true"
    && isPrivateHostname(redirect.hostname);
  if (redirect.protocol !== "https:" && !privateHttp) {
    throw new Error("FEISHU_REDIRECT_URI 必须使用 HTTPS；仅显式启用时允许私网 HTTP。");
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
