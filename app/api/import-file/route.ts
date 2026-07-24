import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { loadWorkspaceState, saveImportedFile } from "@/lib/storage";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import { ActionCommandPayloadError } from "@/lib/action-command-payloads";
import {
  executeProductionWorkspaceCommand,
  WorkspaceCommandTransientHttpError,
} from "@/lib/production-action-commands";

export const dynamic = "force-dynamic";

function commandErrorStatus(error: ActionCommandPayloadError): number {
  if (error.code === "ACTION_COMMAND_PAYLOAD_NOT_FOUND") return 404;
  if (error.code === "ACTION_COMMAND_CAPABILITY_CHANGED") return 403;
  if (
    error.code === "ACTION_COMMAND_REVISION_CONFLICT"
    || error.code === "ACTION_COMMAND_INPUT_HASH_MISMATCH"
    || error.code === "STALE_FENCING_TOKEN"
    || error.code === "IDEMPOTENCY_KEY_REUSED"
  ) return 409;
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
  const availability = user.actionAvailability.import_excel;
  if (!availability.enabled) {
    return NextResponse.json(
      { error: availability.disabledReasonText ?? "当前账号不能导入 Excel。", actionAvailability: availability },
      { status: 403 },
    );
  }
  const form = await request.formData();
  const file = form.get("file");
  const actionId = form.get("actionId");
  const payloadRefId = form.get("payloadRefId");
  if (
    typeof actionId !== "string"
    || !actionId
    || typeof payloadRefId !== "string"
    || !payloadRefId
  ) {
    return NextResponse.json(
      {
        error: "Excel 导入必须只使用服务端签发的命令引用绑定文件内容。",
        code: "ACTION_COMMAND_PAYLOAD_REQUIRED",
      },
      { status: 422 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "没有收到 Excel 文件。" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "文件超过 20MB 限制。" }, { status: 413 });
  }
  const current = await loadWorkspaceState();
  try {
    const execution = await executeProductionWorkspaceCommand({
      expectedAction: "import_excel",
      invocation: { actionId, payloadRefId },
      user,
      current,
      execute: async (storedPayload) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const contentHash = createHash("sha256").update(bytes).digest("hex");
        if (
          storedPayload.fileName !== file.name
          || storedPayload.contentType !== (file.type || "application/octet-stream")
          || storedPayload.size !== file.size
          || storedPayload.contentHash !== contentHash
        ) {
          throw new ActionCommandPayloadError(
            "ACTION_COMMAND_INPUT_HASH_MISMATCH",
            "上传文件与服务端签发命令绑定的名称、类型、大小或内容 hash 不一致。",
          );
        }
        const result = await saveImportedFile(file, stableAuditActor(user));
        return { status: 200, body: result };
      },
    });
    return NextResponse.json({
      ...(execution.result.body as Record<string, unknown>),
      replayed: execution.replayed,
    }, { status: execution.result.status });
  } catch (error) {
    if (error instanceof WorkspaceCommandTransientHttpError) {
      return NextResponse.json(
        error.result.body,
        { status: error.result.status },
      );
    }
    if (error instanceof ActionCommandPayloadError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: commandErrorStatus(error) },
      );
    }
    throw error;
  }
}
