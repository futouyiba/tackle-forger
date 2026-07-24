import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import { CANONICAL_FEISHU_SHEET_REGISTRY, CANONICAL_FEISHU_WORKBOOK } from "@/lib/feishu-workbook";
import { readFeishuSheetRange } from "@/lib/feishu-sheets";
import { FeishuApiError, type FeishuApiErrorInfo } from "@/lib/feishu-api-error";
import { loadWorkspaceState } from "@/lib/storage";
import {
  buildFeishuSourceExportRequests,
  feishuSourceExportFilename,
  serializeFeishuSourceExport,
  type FeishuSourceRangeFailure,
  type FeishuSourceRangeRead,
} from "@/lib/feishu-source-xlsx-export";

export const dynamic = "force-dynamic";

/**
 * 方向 B（只读派生下载）：把应用从飞书规则源实际读到的原始 range/values 导出为
 * 多 sheet .xlsx。
 *
 * 治理边界（与 CLAUDE.md / v3 规范一致）：
 * - 走与 /api/state 一致的读取鉴权：未登录返回 401；并复核 feishu.workbook.read
 *   能力（与「检视工作簿」同口径）。
 * - 只读派生：仅基于工作区**已记录的** FeishuSourceRevision 读取各 sheet 的原始
 *   range/values（飞书 GET /values 接口，纯读）。不触发 inspect/pull、不创建
 *   草稿、不发布、不写回 stable ID、不修改任何正式数据/快照/规则源常量、不产生
 *   新 revision。
 * - 不调用 inspectCanonicalRuleWorkbook/pullFeishuWorkbookRevision：避免与
 *   「检视/拉取/草稿/发布」治理动作混淆。若工作区未记录任何源修订，返回 409
 *   并提示先执行「检视工作簿」或「拉取」。
 * - 凭据不进导出/日志：spreadsheetToken 在导出元信息中脱敏；服务端日志只记录
 *   脱敏后的 FeishuApiErrorInfo。
 * - 确定性：相同工作区源修订 + 相同远端返回产生相同 sheet 顺序与单元格内容；
 *   文件名仅依赖源 revision，不含时间戳。
 *
 * 开放决策（默认值见此与 lib/feishu-source-xlsx-export.ts 注释，需用户确认）：
 *  1. 默认仅导出 role=rule_source 的 sheet；开发计划(09_甘特图)、暂存输出
 *     (14-17_Rods/Reels/Lines/Item)默认不导出。
 *  2. sheet 缺 grid 元信息时用保守上限 500 行 × 60 列回退读取。
 *  3. 部分.sheet 读取失败时，其余成功 sheet 仍会导出，失败明细写入「源数据说明」。
 */
export async function GET(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  if (!user.capabilities.includes("feishu.workbook.read")) {
    return NextResponse.json(
      { error: "缺少读取飞书工作簿的能力（feishu.workbook.read）。" },
      { status: 403 },
    );
  }

  const { state } = await loadWorkspaceState();
  // 优先取 canonical 工作簿的源修订；若无，回退到最新一条已记录修订。
  const canonicalRevisions = state.feishuSourceRevisions.filter(
    (entry) => entry.workbookRefId === CANONICAL_FEISHU_WORKBOOK.id,
  );
  const sourceRevision =
    canonicalRevisions[canonicalRevisions.length - 1] ??
    state.feishuSourceRevisions[state.feishuSourceRevisions.length - 1];
  if (!sourceRevision) {
    return NextResponse.json(
      {
        error: "工作区尚未记录任何飞书源修订。请先在「飞书工作簿」页执行检视或拉取，再下载源数据。",
        action: "inspect_feishu_workbook",
      },
      { status: 409 },
    );
  }

  const requests = buildFeishuSourceExportRequests(sourceRevision, CANONICAL_FEISHU_SHEET_REGISTRY);
  // 逐 sheet 读取并用 allSettled：成功的进入导出，失败的在元信息 sheet 透明化，
  // 不让单个 sheet 的权限/网络问题阻断其余 sheet 的下载。
  const settled = await Promise.all(
    requests.map(async (request) => {
      try {
        const valueRange = await readFeishuSheetRange({
          spreadsheetToken: sourceRevision.spreadsheetToken,
          sheetId: request.sheetId,
          range: request.range,
        });
        return { ok: true as const, request, valueRange };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false as const, request, error: message, raw: error };
      }
    }),
  );

  const registryById = new Map(CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => [entry.sheetId, entry]));
  const sheetById = new Map(sourceRevision.sheets.map((sheet) => [sheet.sheetId, sheet]));
  const reads: FeishuSourceRangeRead[] = [];
  const failures: FeishuSourceRangeFailure[] = [];
  let lastErrorInfo: FeishuApiErrorInfo | undefined;
  for (const result of settled) {
    const expectedName = registryById.get(result.request.sheetId)?.expectedName;
    const observedName = sheetById.get(result.request.sheetId)?.name;
    if (result.ok) {
      reads.push({
        sheetId: result.request.sheetId,
        range: result.request.range,
        valueRange: result.valueRange,
        expectedName,
        observedName,
      });
    } else {
      if (result.raw instanceof FeishuApiError) lastErrorInfo = result.raw.toErrorInfo();
      failures.push({
        sheetId: result.request.sheetId,
        range: result.request.range,
        expectedName,
        observedName,
        error: result.error,
      });
    }
  }

  // 即便有部分失败，只要读到至少一个 sheet 就返回 xlsx；否则返回错误响应。
  if (!reads.length) {
    return NextResponse.json(
      {
        error: "未能从飞书源读取任何 sheet。请检查应用权限与网络后重试。",
        errorInfo: lastErrorInfo,
        failures,
      },
      { status: 502 },
    );
  }

  const exportInput = { sourceRevision, registry: CANONICAL_FEISHU_SHEET_REGISTRY, reads, failures };
  const buffer = serializeFeishuSourceExport(exportInput);
  const filename = feishuSourceExportFilename(exportInput);
  const encoded = encodeURIComponent(filename);
  const asciiFallback = `feishu-source-r${sourceRevision.sourceRevision}.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "no-store",
    },
  });
}
