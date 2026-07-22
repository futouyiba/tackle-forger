import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  authCookieSecure,
  feishuRuntimeConfig,
  safeReturnTo,
} from "@/lib/auth-config";
import {
  consumePendingLogin,
  createSession,
  newOpaqueId,
} from "@/lib/auth-store";
import { FeishuOAuthError, fetchFeishuIdentity } from "@/lib/feishu-oauth";

export const dynamic = "force-dynamic";

function equalState(actual?: string, expected?: string | null) {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function clearPendingCookie(response: NextResponse) {
  response.cookies.set("tf_feishu_pending", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: authCookieSecure(),
    maxAge: 0,
    path: "/",
  });
}

function failureRedirect(request: NextRequest, returnTo: string, errorCode: string) {
  const location = new URL(safeReturnTo(returnTo), request.url);
  location.searchParams.set("auth_error", errorCode);
  const response = NextResponse.redirect(location);
  clearPendingCookie(response);
  return response;
}

export async function GET(request: NextRequest) {
  let config;
  try {
    config = feishuRuntimeConfig();
  } catch {
    return failureRedirect(request, "/", "configuration");
  }

  const cookieState = request.cookies.get("tf_feishu_pending")?.value;
  const returnedState = request.nextUrl.searchParams.get("state");
  if (!equalState(cookieState, returnedState)) {
    return failureRedirect(request, "/", "state");
  }

  let pending;
  try {
    pending = await consumePendingLogin({
      state: cookieState!,
      secret: config.sessionSecret,
    });
  } catch {
    return failureRedirect(request, "/", "callback");
  }
  if (!pending) return failureRedirect(request, "/", "state");
  if (request.nextUrl.searchParams.get("error")) {
    return failureRedirect(request, pending.returnTo, "denied");
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code) return failureRedirect(request, pending.returnTo, "callback");

  try {
    const identity = await fetchFeishuIdentity({ code, config });
    if (identity.tenantKey !== config.tenantKey) {
      return failureRedirect(request, pending.returnTo, "tenant");
    }

    const sessionId = newOpaqueId();
    await createSession({
      sessionId,
      secret: config.sessionSecret,
      identity,
      ttlSeconds: config.sessionTtlSeconds,
    });
    const response = NextResponse.redirect(new URL(pending.returnTo, request.url));
    clearPendingCookie(response);
    response.cookies.set("tf_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: authCookieSecure(),
      maxAge: config.sessionTtlSeconds,
      path: "/",
    });
    return response;
  } catch (error) {
    return failureRedirect(
      request,
      pending.returnTo,
      error instanceof FeishuOAuthError ? error.reason : "callback",
    );
  }
}
