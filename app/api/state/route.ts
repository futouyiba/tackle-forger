import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import type { WorkspaceState } from "@/lib/types";
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from "@/lib/migrations";
import {
  changesOnlyReadOnlyLegacyHistory,
  findGovernedStateChanges,
  findReadOnlyLegacyProductChanges,
  stableAuditActor,
} from "@/lib/api-command-boundaries";
import {
  assertFrozenConfigIdentityTransition,
  ConfigIdGovernanceError,
} from "@/lib/config-id-governance";

export const dynamic = "force-dynamic";

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
  if (!saveAvailability.enabled) {
    return NextResponse.json(
      { error: saveAvailability.disabledReasonText ?? "当前账号没有保存工作区的权限。", actionAvailability: saveAvailability },
      { status: 403 },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    state?: WorkspaceState;
    baseRevision?: number;
    message?: string;
  } | null;
  if (
    !body ||
    !body.state ||
    !Number.isInteger(body.state.schemaVersion) ||
    body.state.schemaVersion < 1 ||
    body.state.schemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION ||
    typeof body.baseRevision !== "number"
  ) {
    return NextResponse.json({ error: "配置数据或版本号无效。" }, { status: 400 });
  }

  const current = await loadWorkspaceState();
  if (body.baseRevision !== current.revision) {
    return NextResponse.json(
      { error: "其他成员已保存新版本，请刷新后再合并。", revision: current.revision },
      { status: 409 },
    );
  }
  try {
    assertFrozenConfigIdentityTransition(current.state, body.state);
  } catch (error) {
    if (error instanceof ConfigIdGovernanceError) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.details },
        { status: 422 },
      );
    }
    throw error;
  }
  const governedChanges = findGovernedStateChanges(current.state, body.state);
  if (governedChanges.length) {
    const legacyHistoryChanges = findReadOnlyLegacyProductChanges(
      current.state,
      body.state,
    );
    const legacyHistoryOnly = changesOnlyReadOnlyLegacyHistory(governedChanges);
    return NextResponse.json(
      {
        error: legacyHistoryOnly
          ? "旧配方、候选、OfficialSku 与明细覆盖已转为只读历史，只能查看、导出或通过迁移流程处理。"
          : "受治理的状态只能通过对应领域命令修改。",
        code: legacyHistoryOnly
          ? "LEGACY_HISTORY_READ_ONLY"
          : "DOMAIN_COMMAND_REQUIRED",
        governedChanges,
        legacyHistoryChanges,
      },
      { status: 422 },
    );
  }

  const result = await saveWorkspaceState({
    state: body.state,
    baseRevision: body.baseRevision,
    author: stableAuditActor(user),
    message: body.message?.trim() || "保存配置修改",
  });
  if (result.conflict) {
    return NextResponse.json(
      { error: "其他成员已保存新版本，请刷新后再合并。", revision: result.revision },
      { status: 409 },
    );
  }
  return NextResponse.json({ revision: result.revision, user });
}
