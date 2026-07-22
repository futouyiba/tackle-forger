import { NextResponse, type NextRequest } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  actionAvailability,
  type CapabilityCode,
} from "@/lib/interaction-contracts";
import {
  querySeriesGantt,
  paginateSeriesGantt,
  seriesGanttQueryFromSearchParams,
} from "@/lib/series-gantt-query";
import { loadWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json({
      error: "请使用公司飞书账号登录。",
      action: actionAvailability("open_series", []),
    }, { status: 401 });
  }
  const capabilities = user.capabilities as CapabilityCode[];
  const readActions = [
    actionAvailability("open_series", capabilities),
    actionAvailability("open_sku", capabilities),
    actionAvailability("preview_model", capabilities),
  ];
  const blockedRead = readActions.find((action) => !action.enabled);
  if (blockedRead) {
    return NextResponse.json({
      error: "甘特图读取需要完整的 Series、SKU 与 Model 读取能力，不返回部分谱系。",
      code: "SERIES_GANTT_READ_CAPABILITY_INCOMPLETE",
      action: blockedRead,
      actions: readActions,
    }, { status: 403 });
  }
  const current = await loadWorkspaceState();
  const query = seriesGanttQueryFromSearchParams(request.nextUrl.searchParams);
  const blocks = querySeriesGantt({
    query,
    series: current.state.seriesDefinitions,
    skus: current.state.skuDrawers,
    models: current.state.purchasableModels,
    itemTypes: current.state.itemTypeProfiles,
    upgrades: current.state.upgradeCandidates,
  });
  let page;
  try {
    page = paginateSeriesGantt({ items: blocks, query, workspaceRevision: current.revision });
  } catch (error) {
    if (error instanceof Error && error.message === "SERIES_GANTT_CURSOR_STALE") {
      return NextResponse.json({
        error: "甘特图数据已变化，旧游标不能与新聚合拼接。",
        code: "SERIES_GANTT_CURSOR_STALE",
        recovery: "保留筛选条件并从第一页重新加载。",
      }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({
    revision: current.revision,
    query,
    blocks: page.items,
    page: {
      nextCursor: page.nextCursor,
      totalMatched: page.totalMatched,
      pageSize: page.pageSize,
    },
    actions: [
      actionAvailability("open_series", capabilities),
      actionAvailability("open_sku", capabilities),
      actionAvailability("preview_model", capabilities),
      actionAvailability("generate_candidates", capabilities),
      actionAvailability("run_ai_assessment", capabilities, {
        code: "AI_DISABLED",
        text: "OPEN-006 尚未确认，AI 服务一期保持禁用。",
      }),
    ],
  });
}
