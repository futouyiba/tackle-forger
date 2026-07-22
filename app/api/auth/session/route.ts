import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  authCookieSecure,
  feishuRuntimeConfig,
  publicSupportUrl,
} from "@/lib/auth-config";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    feishuRuntimeConfig();
  } catch {
    return NextResponse.json(
      {
        authenticated: false,
        error: "登录服务尚未正确配置。",
        errorCode: "AUTH-CONFIG-001",
        supportUrl: publicSupportUrl(),
      },
      { status: 503 },
    );
  }

  const user = await requestUser(request);
  if (!user.authenticated) {
    const response = NextResponse.json(
      {
        authenticated: false,
        error: "登录会话不存在或已过期。",
        errorCode: "AUTH-SESSION-001",
        action: "feishu_login",
        supportUrl: publicSupportUrl(),
      },
      { status: 401 },
    );
    response.cookies.set("tf_session", "", {
      httpOnly: true,
      sameSite: "lax",
      secure: authCookieSecure(),
      maxAge: 0,
      path: "/",
    });
    return response;
  }

  return NextResponse.json(
    { authenticated: true, user },
    { headers: { "cache-control": "no-store" } },
  );
}
