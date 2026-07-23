import { NextRequest, NextResponse } from "next/server";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import { requestUser } from "@/lib/auth";
import {
  changeSkuTargetPull,
  SkuTargetPullChangeError,
} from "@/lib/sku-target-pull-change";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import type { ProjectionMatch } from "@/lib/types";
import { ensureWorkflowFields } from "@/lib/workflow";
import {
  ActionCommandPayloadError,
  type JsonObject,
} from "@/lib/action-command-payloads";
import {
  executeProductionWorkspaceCommand,
  WorkspaceCommandTransientHttpError,
} from "@/lib/production-action-commands";

export const dynamic = "force-dynamic";

interface ChangeRequest {
  skuId?: unknown;
  expectedRevision?: unknown;
  targetPullKg?: unknown;
  projectionMatch?: unknown;
  expectedMode?: unknown;
  publishedDescendantFingerprint?: unknown;
  replacementSkuId?: unknown;
  deprecateOriginal?: unknown;
  idempotencyKey?: unknown;
}

function errorStatus(error: SkuTargetPullChangeError): number {
  if (error.code === "SKU_NOT_FOUND") return 404;
  if (
    error.code === "REVISION_CONFLICT" ||
    error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "IDEMPOTENCY_RESULT_MISSING" ||
    error.code === "PREVIEW_STALE" ||
    error.code === "TARGET_PULL_DUPLICATE" ||
    error.code === "REPLACEMENT_SKU_ID_CONFLICT"
  ) {
    return 409;
  }
  return 422;
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

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const availability = user.actionAvailability.change_sku_target_pull;
  if (!availability?.enabled) {
    return NextResponse.json(
      {
        error:
          availability?.disabledReasonText ??
          "当前账号没有修改 SKU 目标拉力的权限。",
        actionAvailability: availability,
      },
      { status: 403 },
    );
  }
  const invocation = await request.json().catch(() => null);
  const actor = stableAuditActor(user);
  const current = await loadWorkspaceState();
  try {
    const execution = await executeProductionWorkspaceCommand({
      expectedAction: "change_sku_target_pull",
      invocation,
      user,
      current,
      execute: async (storedPayload) => {
        const body = storedPayload as JsonObject & ChangeRequest;
        if (
          typeof body.skuId !== "string"
          || typeof body.expectedRevision !== "number"
          || typeof body.targetPullKg !== "number"
          || !body.projectionMatch
          || typeof body.projectionMatch !== "object"
          || (body.expectedMode !== "SAME_SKU_NEW_REVISION"
            && body.expectedMode !== "REPLACEMENT_SKU")
          || typeof body.publishedDescendantFingerprint !== "string"
          || typeof body.idempotencyKey !== "string"
          || (body.replacementSkuId !== undefined
            && typeof body.replacementSkuId !== "string")
          || (body.deprecateOriginal !== undefined
            && typeof body.deprecateOriginal !== "boolean")
        ) {
          return {
            status: 400,
            body: {
              error:
                "skuId、expectedRevision、targetPullKg、projectionMatch、expectedMode、publishedDescendantFingerprint 或 idempotencyKey 字段无效。",
            },
          };
        }
        const occurredAt = new Date().toISOString();
        const changed = changeSkuTargetPull(current.state, {
          skuId: body.skuId,
          expectedRevision: body.expectedRevision,
          targetPullKg: body.targetPullKg,
        projectionMatch: body.projectionMatch as ProjectionMatch,
        expectedMode: body.expectedMode,
        publishedDescendantFingerprint:
          body.publishedDescendantFingerprint,
        replacementSkuId: body.replacementSkuId,
        deprecateOriginal: body.deprecateOriginal,
        idempotencyKey: body.idempotencyKey,
          actor,
          occurredAt,
        });
        if (changed.idempotent) {
          return {
            status: 200,
            body: { ...changed, revision: current.revision },
          };
        }
        const committed = ensureWorkflowFields(changed.state);
        const saved = await saveWorkspaceState({
          state: committed,
          baseRevision: current.revision,
          author: actor,
          message:
            changed.mode === "REPLACEMENT_SKU"
              ? `为 ${changed.originalSku.id} 创建新的目标拉力 SKU ${changed.sku.id}`
              : `修改 SKU ${changed.sku.id} 的目标拉力`,
        });
        if (saved.conflict) {
          const latest = await loadWorkspaceState();
          const recovered = changeSkuTargetPull(latest.state, {
            skuId: body.skuId,
            expectedRevision: body.expectedRevision,
            targetPullKg: body.targetPullKg,
            projectionMatch: body.projectionMatch as ProjectionMatch,
            expectedMode: body.expectedMode,
            publishedDescendantFingerprint:
              body.publishedDescendantFingerprint,
            replacementSkuId: body.replacementSkuId,
            deprecateOriginal: body.deprecateOriginal,
            idempotencyKey: body.idempotencyKey,
            actor,
            occurredAt,
          });
          if (recovered.idempotent) {
            return {
              status: 200,
              body: { ...recovered, revision: latest.revision },
            };
          }
          return {
            status: 409,
            body: {
              error: "其他成员已保存新版本，请刷新并重新预览后再提交。",
              revision: saved.revision,
            },
          };
        }
        return {
          status: 200,
          body: {
            ...changed,
            state: committed,
            revision: saved.revision,
          },
        };
      },
    });
    return NextResponse.json(
      {
        ...(execution.result.body as Record<string, unknown>),
        user,
        replayed: execution.replayed,
      },
      { status: execution.result.status },
    );
  } catch (error) {
    if (error instanceof WorkspaceCommandTransientHttpError) {
      return NextResponse.json(
        error.result.body,
        { status: error.result.status },
      );
    }
    if (error instanceof SkuTargetPullChangeError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: errorStatus(error) },
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
