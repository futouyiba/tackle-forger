import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  ConfigPreviewSnapshotError,
  createConfigPreviewPackage,
} from "@/lib/config-preview-package";
import {
  assertFormalConfigExportAllowed,
  ConfigExportStageError,
  type FormalConfigExportAuthorization,
} from "@/lib/config-export-stage";
import { loadWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

type ConfigExportRequest =
  | {
      action: "preview";
      packageId: string;
      snapshotIds: string[];
    }
  | {
      action: "commit";
      formalAuthorization?: FormalConfigExportAuthorization;
    };

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const body = (await request.json().catch(() => null)) as ConfigExportRequest | null;
  if (!body || (body.action !== "preview" && body.action !== "commit")) {
    return NextResponse.json({ error: "配置导出请求无效。" }, { status: 400 });
  }

  if (body.action === "commit") {
    const availability = user.actionAvailability.commit_config_export;
    if (!availability.enabled) {
      return NextResponse.json(
        {
          error: availability.disabledReasonText ?? "正式配置提交未启用。",
          code: availability.disabledReasonCode ?? "CONFIG_EXPORT_PHASE_DISABLED",
          actionAvailability: availability,
        },
        { status: 403 },
      );
    }
    try {
      await assertFormalConfigExportAllowed(body.formalAuthorization, undefined);
    } catch (error) {
      if (error instanceof ConfigExportStageError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: 422 },
        );
      }
      throw error;
    }
    return NextResponse.json(
      {
        error: "1.5 期正式执行器由 Issue #55/#56 实现；当前没有可执行提交路径。",
        code: "CONFIG_EXPORT_RUNTIME_NOT_IMPLEMENTED",
      },
      { status: 501 },
    );
  }

  const availability = user.actionAvailability.preview_config_export;
  if (!availability.enabled) {
    return NextResponse.json(
      {
        error: availability.disabledReasonText ?? "当前账号不能生成配置预览。",
        actionAvailability: availability,
      },
      { status: 403 },
    );
  }
  if (
    typeof body.packageId !== "string"
    || !Array.isArray(body.snapshotIds)
    || !body.snapshotIds.length
    || body.snapshotIds.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return NextResponse.json(
      { error: "NON_FORMAL 预览必须指定 packageId 和至少一个 Snapshot。" },
      { status: 400 },
    );
  }
  const current = await loadWorkspaceState();
  const requested = new Set(body.snapshotIds);
  const snapshots = current.state.configurationSnapshots.filter((snapshot) =>
    requested.has(snapshot.id));
  if (snapshots.length !== requested.size) {
    return NextResponse.json(
      { error: "请求包含不存在或重复的 ConfigurationSnapshot。" },
      { status: 404 },
    );
  }
  try {
    const previewPackage = createConfigPreviewPackage({
      packageId: body.packageId,
      workspaceId: user.tenantKey ?? "workspace",
      snapshots,
    });
    return NextResponse.json({ previewPackage });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "生成 NON_FORMAL 预览失败。",
        ...(error instanceof ConfigPreviewSnapshotError ? { code: error.code } : {}),
      },
      { status: 422 },
    );
  }
}
