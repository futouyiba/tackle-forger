import { NextRequest, NextResponse } from "next/server";
import {
  authCookieSecure,
  feishuRuntimeConfig,
  safeReturnTo,
} from "@/lib/auth-config";
import { newOpaqueId, savePendingLogin } from "@/lib/auth-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = feishuRuntimeConfig();
    const state = newOpaqueId();
    const returnTo = safeReturnTo(request.nextUrl.searchParams.get("return_to"));
    await savePendingLogin({ state, secret: config.sessionSecret, returnTo });

    const authorizationUrl = new URL(
      "/open-apis/authen/v1/authorize",
      config.accountsBaseUrl,
    );
    authorizationUrl.searchParams.set("client_id", config.appId);
    authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("scope", config.oauthScopes);

    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set("tf_feishu_pending", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: authCookieSecure(),
      maxAge: 600,
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: "飞书登录尚未正确配置。" },
      { status: 503 },
    );
  }
}
