import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import type { WorkspaceState } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = requestUser(request);
  const current = await loadWorkspaceState();
  return NextResponse.json({ ...current, user });
}

export async function PUT(request: NextRequest) {
  const user = requestUser(request);
  const body = (await request.json()) as {
    state?: WorkspaceState;
    baseRevision?: number;
    message?: string;
  };
  if (!body.state || body.state.schemaVersion !== 1 || typeof body.baseRevision !== "number") {
    return NextResponse.json({ error: "配置数据或版本号无效。" }, { status: 400 });
  }

  const result = await saveWorkspaceState({
    state: body.state,
    baseRevision: body.baseRevision,
    author: user.name || user.email,
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
