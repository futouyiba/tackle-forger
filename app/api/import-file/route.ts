import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { saveImportedFile } from "@/lib/storage";
import { stableAuditActor } from "@/lib/api-command-boundaries";

export const dynamic = "force-dynamic";

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
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "没有收到 Excel 文件。" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "文件超过 20MB 限制。" }, { status: 413 });
  }
  const result = await saveImportedFile(file, stableAuditActor(user));
  return NextResponse.json(result);
}
