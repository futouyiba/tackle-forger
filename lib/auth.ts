import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { feishuRuntimeConfig } from "./auth-config";
import { findSession } from "./auth-store";
import { feishuCapabilities } from "./feishu-identity";
import { fancyHubConfigFromEnvironment, fancyHubEnablement } from "./fancy-hub";
import { aiRuntimeStoreEnablement } from "./ai-runtime-store";
import {
  actionAvailability,
  buildActionAvailabilityMap,
  type CapabilityCode,
} from "./interaction-contracts";

export interface RequestIdentity {
  email: string;
  name: string;
  avatarUrl?: string;
  role: "admin" | "editor" | "viewer";
  authenticated: boolean;
  provider: "feishu" | "none";
  tenantKey?: string;
  openId?: string;
  capabilities: CapabilityCode[];
  sessionExpiresAt?: string;
}

function withActions<T extends RequestIdentity>(identity: T) {
  const actionAvailabilityMap = buildActionAvailabilityMap(identity.capabilities);
  const connector = fancyHubEnablement(fancyHubConfigFromEnvironment());
  const runtimeStore = aiRuntimeStoreEnablement();
  actionAvailabilityMap.run_ai_assessment = actionAvailability(
    "run_ai_assessment",
    identity.capabilities,
    connector.enabled && runtimeStore.enabled ? undefined : {
      code: connector.code ?? runtimeStore.code ?? "AI_CONNECTOR_DISABLED",
      text: "Fancy Hub 连接器未通过服务端启用准入。",
    },
  );
  return {
    ...identity,
    actionAvailability: actionAvailabilityMap,
  };
}

function anonymousIdentity() {
  return withActions({
    email: "",
    name: "未登录",
    role: "viewer" as const,
    authenticated: false,
    provider: "none" as const,
    capabilities: [],
  });
}

function equalSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function trustedProxyIdentity(request: NextRequest) {
  if (process.env.FEISHU_TRUST_PROXY_HEADERS?.trim().toLowerCase() !== "true") {
    return undefined;
  }
  const sharedSecret = process.env.FEISHU_PROXY_SHARED_SECRET?.trim();
  if (!sharedSecret || !equalSecret(request.headers.get("x-tf-proxy-secret"), sharedSecret)) {
    return undefined;
  }
  const configuredTenant = process.env.FEISHU_TENANT_KEY?.trim();
  const tenantKey = request.headers.get("x-feishu-tenant-key")?.trim();
  const openId = request.headers.get("x-feishu-open-id")?.trim();
  if (!configuredTenant || tenantKey !== configuredTenant || !openId) return undefined;
  const capabilities = feishuCapabilities(openId, aiProviderAdminOpenIds());
  return withActions({
    email: "",
    name: request.headers.get("x-feishu-display-name")?.trim() || openId,
    role: capabilities.includes("ai.provider_policy.manage") ? "admin" as const : "editor" as const,
    authenticated: true,
    provider: "feishu" as const,
    tenantKey,
    openId,
    capabilities,
  });
}

function aiProviderAdminOpenIds(): string[] {
  return (process.env.AI_PROVIDER_ADMIN_OPEN_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function requestUser(request: NextRequest) {
  const sessionId = request.cookies.get("tf_session")?.value;
  if (sessionId) {
    try {
      const config = feishuRuntimeConfig();
      const session = await findSession({ sessionId, secret: config.sessionSecret });
      if (session && session.identity.tenantKey === config.tenantKey) {
        const capabilities = feishuCapabilities(session.identity.openId, aiProviderAdminOpenIds());
        return withActions({
          email: "",
          name: session.identity.displayName,
          avatarUrl: session.identity.avatarUrl,
          role: capabilities.includes("ai.provider_policy.manage") ? "admin" as const : "editor" as const,
          authenticated: true,
          provider: "feishu" as const,
          tenantKey: session.identity.tenantKey,
          openId: session.identity.openId,
          capabilities,
          sessionExpiresAt: session.expiresAt,
        });
      }
    } catch {
      // 配置或存储异常绝不能授予访问权限。
    }
  }
  return trustedProxyIdentity(request) ?? anonymousIdentity();
}
