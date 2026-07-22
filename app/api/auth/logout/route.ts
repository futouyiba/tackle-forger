import { NextRequest, NextResponse } from "next/server";
import { authCookieSecure, feishuRuntimeConfig } from "@/lib/auth-config";
import { revokeSession } from "@/lib/auth-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const sessionId = request.cookies.get("tf_session")?.value;
  if (sessionId) {
    try {
      await revokeSession({
        sessionId,
        secret: feishuRuntimeConfig().sessionSecret,
      });
    } catch {
      // 即使服务端会话已经失效或存储不可用，也必须清理浏览器 Cookie。
    }
  }
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set("tf_session", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: authCookieSecure(),
    maxAge: 0,
    path: "/",
  });
  return response;
}
