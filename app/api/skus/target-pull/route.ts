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
  const body = (await request.json().catch(() => null)) as
    | ChangeRequest
    | null;
  if (
    !body ||
    typeof body.skuId !== "string" ||
    typeof body.expectedRevision !== "number" ||
    typeof body.targetPullKg !== "number" ||
    !body.projectionMatch ||
    typeof body.projectionMatch !== "object" ||
    (body.expectedMode !== "SAME_SKU_NEW_REVISION" &&
      body.expectedMode !== "REPLACEMENT_SKU") ||
    typeof body.publishedDescendantFingerprint !== "string" ||
    typeof body.idempotencyKey !== "string" ||
    (body.replacementSkuId !== undefined &&
      typeof body.replacementSkuId !== "string") ||
    (body.deprecateOriginal !== undefined &&
      typeof body.deprecateOriginal !== "boolean")
  ) {
    return NextResponse.json(
      {
        error:
          "skuId、expectedRevision、targetPullKg、projectionMatch、expectedMode、publishedDescendantFingerprint 或 idempotencyKey 字段无效。",
      },
      { status: 400 },
    );
  }
  const actor = stableAuditActor(user);
  const occurredAt = new Date().toISOString();
  const current = await loadWorkspaceState();
  try {
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
      return NextResponse.json({
        ...changed,
        revision: current.revision,
        user,
      });
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
        return NextResponse.json({
          ...recovered,
          revision: latest.revision,
          user,
        });
      }
      return NextResponse.json(
        {
          error: "其他成员已保存新版本，请刷新并重新预览后再提交。",
          revision: saved.revision,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ...changed,
      state: committed,
      revision: saved.revision,
      user,
    });
  } catch (error) {
    if (error instanceof SkuTargetPullChangeError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: errorStatus(error) },
      );
    }
    throw error;
  }
}
