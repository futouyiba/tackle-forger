import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { FeishuApiError, type FeishuApiErrorInfo } from "@/lib/feishu-api-error";
import { loadWorkspaceState } from "@/lib/storage";
import { exportWorkspaceToFeishuSheet } from "@/lib/feishu-sheet-export";

export const dynamic = "force-dynamic";

/**
 * 方向 A（受控写入导出）：把当前工作区数据**复制**写到一张**新的**飞书电子表格。
 *
 * 治理边界（与 CLAUDE.md / v3 规范一致）：
 * - 鉴权：未登录返回 401；并复核 feishu.sheet.export.write 能力（403）。
 * - 受控写入 gate：即便登录用户持有能力，也必须在部署环境中显式设置
 *   FEISHU_EXPORT_TO_SHEET_ENABLED=true（默认关闭）。路由层独立复核，不信 UI。
 * - 独立动作：只创建新表 + 写 cells；不调用 inspect/pull/draft/publish，不写回
 *   canonical 规则源，不绕过 stable ID，不修改 CANONICAL_FEISHU_* 常量，不自动
 *   发布。本路由不产生工作区新 revision。
 * - 错误可观测：飞书接口失败抛 FeishuApiError → 返回 502 + 脱敏 errorInfo；
 *   token/app secret 不进响应体或日志。
 *
 * 开放决策（默认值见 lib/feishu-sheet-export.ts 注释，并在返回 manifest 中回显）：
 *  请求体可选 { folderToken?: string }；默认空表示创建到应用根目录。
 *  其余开放事项（目标文件夹、sheet 命名、默认 sheet 清理、部分失败恢复）见
 *  manifest.openQuestions，需用户确认。
 */
function feishuSheetExportEnabled() {
  return process.env.FEISHU_EXPORT_TO_SHEET_ENABLED?.trim().toLowerCase() === "true";
}

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  if (!user.capabilities.includes("feishu.sheet.export.write")) {
    return NextResponse.json(
      { error: "缺少导出到飞书表的能力（feishu.sheet.export.write）。" },
      { status: 403 },
    );
  }
  if (!feishuSheetExportEnabled()) {
    return NextResponse.json(
      {
        error: "导出到飞书表默认关闭。请在部署环境中设置 FEISHU_EXPORT_TO_SHEET_ENABLED=true 后重试。",
        disabledReasonCode: "FEISHU_EXPORT_TO_SHEET_DISABLED",
      },
      { status: 503 },
    );
  }

  let folderToken: string | undefined;
  try {
    const body = (await request.json()) as { folderToken?: unknown };
    if (typeof body?.folderToken === "string") folderToken = body.folderToken.trim() || undefined;
  } catch {
    // 允许空请求体；folderToken 留空走默认（应用根目录）。
  }

  const { state, revision } = await loadWorkspaceState();
  try {
    const manifest = await exportWorkspaceToFeishuSheet({ state, revision, folderToken });
    return NextResponse.json(manifest, { status: 200 });
  } catch (error) {
    if (error instanceof FeishuApiError) {
      const errorInfo: FeishuApiErrorInfo = error.toErrorInfo();
      // 服务端日志可记录完整 reason；响应体只含脱敏 errorInfo。
      console.error("[export-to-feishu-sheet] FeishuApiError", {
        reason: error.message,
        endpoint: error.endpoint,
        tokenContext: error.tokenContext,
      });
      return NextResponse.json(
        { error: error.message, errorInfo },
        { status: 502 },
      );
    }
    throw error;
  }
}
