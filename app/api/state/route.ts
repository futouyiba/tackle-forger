import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import type { WorkspaceState } from "@/lib/types";
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from "@/lib/migrations";
import {
  ActionCommandPayloadError,
  type JsonObject,
} from "@/lib/action-command-payloads";
import {
  executeProductionWorkspaceCommand,
  WorkspaceCommandTransientHttpError,
} from "@/lib/production-action-commands";
import {
  changesOnlyReadOnlyLegacyHistory,
  findGovernedStateChanges,
  findReadOnlyLegacyProductChanges,
  governedStateFieldDetails,
  stableAuditActor,
} from "@/lib/api-command-boundaries";
import {
  assertFrozenConfigIdentityTransition,
  ConfigIdGovernanceError,
} from "@/lib/config-id-governance";

export const dynamic = "force-dynamic";

export function saveWorkspaceForbiddenResponse(saveAvailability: {
  enabled: boolean;
  disabledReasonText?: string;
}) {
  if (saveAvailability.enabled) return undefined;
  return {
    status: 403,
    body: {
      error: saveAvailability.disabledReasonText ?? "当前账号没有保存工作区的权限。",
      actionAvailability: saveAvailability,
    },
  };
}

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

export async function GET(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const current = await loadWorkspaceState();
  return NextResponse.json({ ...current, user });
}

export async function PUT(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const saveAvailability = user.actionAvailability.save_workspace;
  const forbidden = saveWorkspaceForbiddenResponse(saveAvailability);
  if (forbidden) {
    return NextResponse.json(
      forbidden.body,
      { status: forbidden.status },
    );
  }
  const invocation = await request.json().catch(() => null);
  const current = await loadWorkspaceState();
  try {
    const execution = await executeProductionWorkspaceCommand({
      expectedAction: "save_workspace",
      invocation,
      user,
      current,
      execute: async (storedPayload) => {
        const body = storedPayload as JsonObject & {
          state?: unknown;
          baseRevision?: unknown;
          message?: unknown;
        };
        const proposed = body.state as WorkspaceState | undefined;
        if (
          !proposed
          || !Number.isInteger(proposed.schemaVersion)
          || proposed.schemaVersion < 1
          || proposed.schemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION
          || typeof body.baseRevision !== "number"
        ) {
          return { status: 400, body: { error: "配置数据或版本号无效。" } };
        }
        if (body.baseRevision !== current.revision) {
          return {
            status: 409,
            body: {
              error: "其他成员已保存新版本，请刷新后再合并。",
              revision: current.revision,
            },
          };
        }
        try {
          assertFrozenConfigIdentityTransition(current.state, proposed);
        } catch (error) {
          if (error instanceof ConfigIdGovernanceError) {
            const frozenField = error.code === "PUBLISHED_CONFIGURATION_SNAPSHOT_FROZEN"
              ? "configurationSnapshots"
              : error.code === "MODEL_CONFIG_IDENTITY_FROZEN"
                ? "purchasableModels"
                : "configIdGovernance";
            return {
              status: 422,
              body: {
                error: error.message,
                code: error.code,
                details: error.details,
                governedChanges: [frozenField],
                governedFields: governedStateFieldDetails([frozenField]),
              },
            };
          }
          throw error;
        }
        const governedChanges = findGovernedStateChanges(current.state, proposed);
        if (governedChanges.length) {
          const legacyHistoryChanges = findReadOnlyLegacyProductChanges(
            current.state,
            proposed,
          );
          const legacyHistoryOnly = changesOnlyReadOnlyLegacyHistory(governedChanges);
          const governedFields = governedStateFieldDetails(governedChanges);
          return {
            status: 422,
            body: {
              error: legacyHistoryOnly
                ? "旧配方、候选、OfficialSku 与明细覆盖已转为只读历史，只能查看、导出或通过迁移流程处理。"
                : "受治理的状态只能通过对应领域命令修改。",
              code: legacyHistoryOnly
                ? "LEGACY_HISTORY_READ_ONLY"
                : "DOMAIN_COMMAND_REQUIRED",
              governedChanges,
              governedFields,
              legacyHistoryChanges,
            },
          };
        }
        const result = await saveWorkspaceState({
          state: proposed,
          baseRevision: body.baseRevision,
          author: stableAuditActor(user),
          message: typeof body.message === "string" && body.message.trim()
            ? body.message.trim()
            : "保存配置修改",
        });
        if (result.conflict) {
          return {
            status: 409,
            body: {
              error: "其他成员已保存新版本，请刷新后再合并。",
              revision: result.revision,
            },
          };
        }
        return { status: 200, body: { revision: result.revision } };
      },
    });
    const body = execution.result.body as Record<string, unknown>;
    return NextResponse.json(
      { ...body, user, replayed: execution.replayed },
      { status: execution.result.status },
    );
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
