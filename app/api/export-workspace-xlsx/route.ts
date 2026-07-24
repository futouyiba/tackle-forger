import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { loadWorkspaceState } from "@/lib/storage";
import {
  serializeWorkspaceExport,
  workspaceExportFilename,
} from "@/lib/workspace-xlsx-export";

export const dynamic = "force-dynamic";

/**
 * 只读导出当前工作区数据为 .xlsx 下载，用于与飞书规则源逐表对照、排查数据
 * 结构不一致。
 *
 * - 走与 /api/state 一致的读取鉴权：未登录返回 401。
 * - 仅调用 loadWorkspaceState（只读），不触发任何写操作或新 revision。
 * - 敏感字段在 lib/workspace-xlsx-export 中统一脱敏；本路由不再接触凭据。
 */
export async function GET(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }

  const { state, revision } = await loadWorkspaceState();
  const input = { state, revision };
  const buffer = serializeWorkspaceExport(input);
  const filename = workspaceExportFilename(input);
  // 中文文件名用 RFC 5987 编码，并给出 ASCII 回退。
  const encoded = encodeURIComponent(filename);
  const asciiFallback = `workspace-export-r${revision}.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "no-store",
    },
  });
}
