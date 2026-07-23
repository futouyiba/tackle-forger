import { NextRequest, NextResponse } from "next/server";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import { requestUser } from "@/lib/auth";
import {
  previewSkuTargetPullProjectionMatch,
  SkuTargetPullChangeError,
} from "@/lib/sku-target-pull-change";
import { loadWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

interface PreviewRequest {
  skuId?: unknown;
  expectedRevision?: unknown;
  targetPullKg?: unknown;
}

function errorStatus(error: SkuTargetPullChangeError): number {
  if (error.code === "SKU_NOT_FOUND") return 404;
  if (error.code === "REVISION_CONFLICT") return 409;
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
    | PreviewRequest
    | null;
  if (
    !body ||
    typeof body.skuId !== "string" ||
    typeof body.expectedRevision !== "number" ||
    typeof body.targetPullKg !== "number"
  ) {
    return NextResponse.json(
      { error: "skuId、expectedRevision 与 targetPullKg 字段无效。" },
      { status: 400 },
    );
  }
  const current = await loadWorkspaceState();
  try {
    const projectionMatch = previewSkuTargetPullProjectionMatch({
      state: current.state,
      skuId: body.skuId,
      expectedRevision: body.expectedRevision,
      targetPullKg: body.targetPullKg,
    });
    return NextResponse.json({
      projectionMatch,
      revision: current.revision,
      actor: stableAuditActor(user),
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
