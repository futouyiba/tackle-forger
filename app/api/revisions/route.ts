import { NextRequest, NextResponse } from "next/server";
import { listRevisions, loadRevision } from "@/lib/storage";
import { requestUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const availability = user.actionAvailability.view_revisions;
  if (!availability.enabled) {
    return NextResponse.json(
      { error: availability.disabledReasonText ?? "当前账号不能查看历史版本。", actionAvailability: availability },
      { status: 403 },
    );
  }
  const revision = request.nextUrl.searchParams.get("revision");
  if (revision) {
    const state = await loadRevision(Number(revision));
    if (!state) return NextResponse.json({ error: "找不到该版本。" }, { status: 404 });
    return NextResponse.json({ state, revision: Number(revision) });
  }
  return NextResponse.json({ revisions: await listRevisions() });
}
