import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { saveImportedFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = requestUser(request);
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "没有收到 Excel 文件。" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "文件超过 20MB 限制。" }, { status: 413 });
  }
  const result = await saveImportedFile(file, user.email);
  return NextResponse.json(result);
}
