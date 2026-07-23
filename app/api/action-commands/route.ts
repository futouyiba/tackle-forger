import { NextRequest, NextResponse } from "next/server";
import {
  ActionCommandPayloadError,
  type JsonObject,
} from "@/lib/action-command-payloads";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import { requestUser } from "@/lib/auth";
import {
  issueProductionWorkspaceCommand,
  ROUTED_WORKSPACE_ACTIONS,
} from "@/lib/production-action-commands";
import { loadWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

function statusFor(error: ActionCommandPayloadError) {
  if (error.code === "IDEMPOTENCY_KEY_REUSED") return 409;
  if (error.code === "ACTION_COMMAND_CAPABILITY_CHANGED") return 403;
  return 422;
}

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const body = (await request.json().catch(() => null)) as
    | {
      action?: unknown;
      idempotencyKey?: unknown;
      payload?: unknown;
    }
    | null;
  if (
    !body
    || typeof body.action !== "string"
    || !(ROUTED_WORKSPACE_ACTIONS as readonly string[]).includes(body.action)
    || typeof body.idempotencyKey !== "string"
    || !body.idempotencyKey.trim()
    || !body.payload
    || typeof body.payload !== "object"
    || Array.isArray(body.payload)
    || Object.keys(body).some(
      (key) => !["action", "idempotencyKey", "payload"].includes(key),
    )
  ) {
    return NextResponse.json(
      { error: "签发请求必须包含受支持的 action、幂等键和结构化业务载荷。" },
      { status: 400 },
    );
  }
  if (JSON.stringify(body.payload).length > 4 * 1024 * 1024) {
    return NextResponse.json(
      { error: "命令业务载荷超过 4 MiB 上限。" },
      { status: 413 },
    );
  }
  const action = body.action as (typeof ROUTED_WORKSPACE_ACTIONS)[number];
  const availability = user.actionAvailability[action];
  if (!availability?.enabled) {
    return NextResponse.json(
      {
        error: availability?.disabledReasonText ?? "当前账号不能签发该状态写命令。",
        actionAvailability: availability,
      },
      { status: 403 },
    );
  }
  const current = await loadWorkspaceState();
  try {
    const issued = await issueProductionWorkspaceCommand({
      action,
      payload: body.payload as JsonObject,
      idempotencyKey: body.idempotencyKey,
      actorId: stableAuditActor(user),
      capabilities: user.capabilities,
      workspaceRevision: current.revision,
    });
    return NextResponse.json(issued);
  } catch (error) {
    if (error instanceof ActionCommandPayloadError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: statusFor(error) },
      );
    }
    throw error;
  }
}
