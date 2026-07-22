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
  const readAvailability = actionAvailability("open_series", capabilities);
  if (!readAvailability.enabled) {
    return NextResponse.json({
      error: readAvailability.disabledReasonText,
      action: readAvailability,
    }, { status: 403 });
  }
  const current = await loadWorkspaceState();
  const query = seriesGanttQueryFromSearchParams(request.nextUrl.searchParams);
  const visibility = {
    seriesIds: capabilities.includes("series.read") ? current.state.seriesDefinitions.map((series) => series.id) : [],
    skuIds: capabilities.includes("sku.read") ? current.state.skuDrawers.map((sku) => sku.id) : [],
    modelIds: capabilities.includes("model.read") ? current.state.purchasableModels.map((model) => model.id) : [],
    discloseTotalModelCount: capabilities.includes("series.read") && capabilities.includes("model.read"),
  };
  const blocks = querySeriesGantt({
    query,
    series: current.state.seriesDefinitions,
    skus: current.state.skuDrawers,
    models: current.state.purchasableModels,
    itemTypes: current.state.itemTypeProfiles,
    upgrades: current.state.upgradeCandidates,
    visibility,
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
      totalVisible: page.totalVisible,
      pageSize: page.pageSize,
    },
    actions: [
      actionAvailability("open_series", capabilities),
      actionAvailability("open_sku", capabilities),
      actionAvailability("preview_model", capabilities),
      actionAvailability("generate_candidates", capabilities),
      actionAvailability("run_ai_assessment", capabilities, {
        code: "AI_DISABLED",
        text: "Fancy Hub 真实连接器默认关闭；完成独立部署配置与启用准入前不会发送数据。",
      }),
    ],
  });
}
