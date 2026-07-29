import { NextRequest, NextResponse } from "next/server";
import { ActionCommandPayloadError } from "@/lib/action-command-payloads";
import { requestUser } from "@/lib/auth";
import { ensureWorkflowFields } from "@/lib/workflow";
import {
  executeProductionWorkspaceCommand,
  WorkspaceCommandTransientHttpError,
  type RoutedWorkspaceAction,
} from "@/lib/production-action-commands";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import {
  executeV23DomainAction,
  previewWeightBandSkus,
  V23DomainActionError,
  type V23WriteAction,
} from "@/lib/v23-domain-actions";

export const dynamic = "force-dynamic";

const WRITE_ACTIONS = [
  "create_series",
  "update_part_configuration",
  "create_sku",
  "create_project_affix",
  "add_sku_affix",
  "remove_inherited_affix",
  "restore_inherited_affix",
  "copy_sku_local_affix",
] as const satisfies readonly V23WriteAction[];

function commandErrorStatus(error: ActionCommandPayloadError): number {
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
  const body = await request.json().catch(() => null) as
    | { action?: unknown; payload?: unknown; actionId?: unknown; payloadRefId?: unknown }
    | null;
  if (body?.action === "preview_weight_band_skus") {
    if (Object.keys(body).some((key) => key !== "action" && key !== "payload")
      || !Object.prototype.hasOwnProperty.call(body, "payload")) {
      return NextResponse.json(
        { error: "preview 只允许 action 与 payload 顶层字段。" },
        { status: 400 },
      );
    }
    const availability = user.actionAvailability.preview_weight_band_skus;
    if (!availability?.enabled) {
      return NextResponse.json(
        {
          error: availability?.disabledReasonText ?? "当前账号不能预览重量段 SKU。",
          actionAvailability: availability,
        },
        { status: 403 },
      );
    }
    try {
      const current = await loadWorkspaceState();
      return NextResponse.json({
        ...previewWeightBandSkus(current.state, body.payload),
        revision: current.revision,
        user,
      });
    } catch (error) {
      if (error instanceof V23DomainActionError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      throw error;
    }
  }
  const current = await loadWorkspaceState();
  const actor = stableAuditActor(user);
  try {
    const execution = await executeProductionWorkspaceCommand({
      expectedAction: WRITE_ACTIONS as readonly RoutedWorkspaceAction[],
      invocation: body,
      user,
      current,
      execute: async (storedPayload, storedAction) => {
        try {
          const action = storedAction as V23WriteAction;
          const changed = executeV23DomainAction(
            current.state,
            current.revision,
            action,
            storedPayload,
          );
          const committed = ensureWorkflowFields(changed.state);
          const saved = await saveWorkspaceState({
            state: committed,
            baseRevision: current.revision,
            author: actor,
            message: `执行 v23 领域动作 ${action}`,
          });
          if (saved.conflict) {
            return {
              status: 409,
              body: { error: "工作区已变化，请刷新后重试。", code: "V23_WORKSPACE_REVISION_CONFLICT" },
            };
          }
          const readback = await loadWorkspaceState();
          if (readback.revision !== saved.revision) {
            throw new Error("V23_WRITE_READBACK_REVISION_MISMATCH");
          }
          return {
            status: 200,
            body: { ...changed.result, revision: saved.revision },
          };
        } catch (error) {
          if (error instanceof V23DomainActionError) {
            return { status: error.status, body: { error: error.message, code: error.code } };
          }
          if (error instanceof Error && /^V23_/u.test(error.message)) {
            return {
              status: 422,
              body: { error: "v23 领域状态未通过封闭契约验证。", code: error.message },
            };
          }
          throw error;
        }
      },
    });
    return NextResponse.json(
      { ...(execution.result.body as Record<string, unknown>), user, replayed: execution.replayed },
      { status: execution.result.status },
    );
  } catch (error) {
    if (error instanceof WorkspaceCommandTransientHttpError) {
      return NextResponse.json(error.result.body, { status: error.result.status });
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
