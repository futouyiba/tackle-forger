import type { FeishuRuntimeConfig } from "./auth-config";

export type FeishuOAuthFailureReason = "network" | "http" | "provider" | "malformed";

export class FeishuOAuthError extends Error {
  constructor(
    public readonly reason: FeishuOAuthFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "FeishuOAuthError";
  }
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  serviceName: string,
): Promise<Response> {
  try {
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      throw new FeishuOAuthError("http", `${serviceName}异常。`);
    }
    return response;
  } catch (error) {
    if (error instanceof FeishuOAuthError) throw error;
    throw new FeishuOAuthError("network", `无法连接${serviceName}。`);
  }
}

async function readJson<T>(response: Response, serviceName: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new FeishuOAuthError("malformed", `${serviceName}返回了无效数据。`);
  }
}

export async function fetchFeishuIdentity(input: {
  code: string;
  config: FeishuRuntimeConfig;
  fetchImpl?: typeof fetch;
  now?: Date;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const tokenResponse = await request(
    fetchImpl,
    `${input.config.openApiBaseUrl}/open-apis/authen/v2/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: input.config.appId,
        client_secret: input.config.appSecret,
        code: input.code,
        redirect_uri: input.config.redirectUri,
      }),
    },
    "飞书令牌服务",
  );
  const token = await readJson<{ code?: number; access_token?: string }>(
    tokenResponse,
    "飞书令牌服务",
  );
  if (token.code !== 0 || !token.access_token) {
    throw new FeishuOAuthError("provider", "飞书拒绝授权。");
  }

  const userResponse = await request(
    fetchImpl,
    `${input.config.openApiBaseUrl}/open-apis/authen/v1/user_info`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
    "飞书用户信息服务",
  );
  const profile = await readJson<{
    code?: number;
    data?: {
      tenant_key?: string;
      open_id?: string;
      name?: string;
      avatar_url?: string;
    };
  }>(userResponse, "飞书用户信息服务");
  if (profile.code !== 0) {
    throw new FeishuOAuthError("provider", "飞书拒绝读取用户信息。");
  }
  if (!profile.data?.tenant_key || !profile.data.open_id) {
    throw new FeishuOAuthError("malformed", "飞书用户信息无效。");
  }

  return {
    tenantKey: profile.data.tenant_key,
    openId: profile.data.open_id,
    displayName: profile.data.name?.trim() || profile.data.open_id,
    avatarUrl: profile.data.avatar_url,
    lastLoginAt: (input.now ?? new Date()).toISOString(),
  };
}
