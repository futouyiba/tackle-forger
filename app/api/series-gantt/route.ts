import { NextResponse, type NextRequest } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  actionAvailability,
  type CapabilityCode,
} from "@/lib/interaction-contracts";
import {
  querySeriesGantt,
  paginateSeriesGantt,
  paginateSeriesGanttChildren,
  seriesGanttQueryFromSearchParams,
} from "@/lib/series-gantt-query";
import { loadWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

function staleCursorResponse() {
  return NextResponse.json({
    error: "甘特图数据已变化，旧游标不能与新聚合拼接。",
    code: "SERIES_GANTT_CURSOR_STALE",
    recovery: "保留筛选条件并从第一页重新加载。",
  }, { status: 409 });
}

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
  const view = request.nextUrl.searchParams.get("view") ?? "series";
  const query = seriesGanttQueryFromSearchParams(request.nextUrl.searchParams);
  const visibility = {
    seriesIds: capabilities.includes("series.read") ? current.state.seriesDefinitions.map((series) => series.id) : [],
    skuIds: capabilities.includes("sku.read") ? current.state.skuDrawers.map((sku) => sku.id) : [],
    modelIds: capabilities.includes("model.read") ? current.state.purchasableModels.map((model) => model.id) : [],
    discloseTotalModelCount: capabilities.includes("series.read") && capabilities.includes("sku.read") && capabilities.includes("model.read"),
  };
  const visibleSeriesIds = new Set(visibility.seriesIds);
  const visibleSkuIds = new Set(visibility.skuIds);
  const visibleModelIds = new Set(visibility.modelIds);

  if (view === "skus") {
    const availability = actionAvailability("open_sku", capabilities);
    if (!availability.enabled) {
      return NextResponse.json({ error: availability.disabledReasonText, action: availability }, { status: 403 });
    }
    const seriesId = request.nextUrl.searchParams.get("seriesId")?.trim();
    if (!seriesId || !visibleSeriesIds.has(seriesId)) {
      return NextResponse.json({ error: "Series 不存在或当前用户不可见。" }, { status: 404 });
    }
    const skus = current.state.skuDrawers
      .filter((sku) => sku.seriesId === seriesId && visibleSkuIds.has(sku.id))
      .sort((left, right) => left.targetWeightKg - right.targetWeightKg || left.id.localeCompare(right.id));
    try {
      const page = paginateSeriesGanttChildren({
        items: skus,
        kind: "skus",
        parentId: seriesId,
        cursor: query.cursor,
        pageSize: query.pageSize,
        workspaceRevision: current.revision,
      });
      return NextResponse.json({
        revision: current.revision,
        seriesId,
        skus: page.items,
        page: { nextCursor: page.nextCursor, totalVisible: page.totalVisible, pageSize: page.pageSize },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SERIES_GANTT_CURSOR_STALE") return staleCursorResponse();
      throw error;
    }
  }

  if (view === "models") {
    const availability = actionAvailability("preview_model", capabilities);
    if (!availability.enabled) {
      return NextResponse.json({ error: availability.disabledReasonText, action: availability }, { status: 403 });
    }
    const skuId = request.nextUrl.searchParams.get("skuId")?.trim();
    const sku = skuId && visibleSkuIds.has(skuId)
      ? current.state.skuDrawers.find((entry) => entry.id === skuId && visibleSeriesIds.has(entry.seriesId))
      : undefined;
    if (!sku) {
      return NextResponse.json({ error: "SKU 抽屉不存在或当前用户不可见。" }, { status: 404 });
    }
    const models = current.state.purchasableModels
      .filter((model) => model.skuId === sku.id && visibleModelIds.has(model.id))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    try {
      const page = paginateSeriesGanttChildren({
        items: models,
        kind: "models",
        parentId: sku.id,
        cursor: query.cursor,
        pageSize: query.pageSize,
        workspaceRevision: current.revision,
      });
      return NextResponse.json({
        revision: current.revision,
        skuId: sku.id,
        models: page.items,
        page: { nextCursor: page.nextCursor, totalVisible: page.totalVisible, pageSize: page.pageSize },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SERIES_GANTT_CURSOR_STALE") return staleCursorResponse();
      throw error;
    }
  }

  if (view !== "series") {
    return NextResponse.json({ error: "未知的甘特图视图。", code: "SERIES_GANTT_VIEW_INVALID" }, { status: 400 });
  }
  const blocks = querySeriesGantt({
    query,
    series: current.state.seriesDefinitions,
    skus: current.state.skuDrawers,
    models: current.state.purchasableModels,
    itemTypes: current.state.itemTypeProfiles,
    upgrades: current.state.upgradeCandidates,
    visibility,
  });
  const visibleCatalog = querySeriesGantt({
    query: { sort: "quality_type" },
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
      return staleCursorResponse();
    }
    throw error;
  }
  return NextResponse.json({
    revision: current.revision,
    query,
    blocks: page.items,
    ...(request.nextUrl.searchParams.get("anchorSeriesId") && blocks.some((block) => block.seriesId === request.nextUrl.searchParams.get("anchorSeriesId"))
      ? { anchorBlock: blocks.find((block) => block.seriesId === request.nextUrl.searchParams.get("anchorSeriesId")) }
      : {}),
    page: {
      nextCursor: page.nextCursor,
      totalVisible: page.totalVisible,
      pageSize: page.pageSize,
    },
    facets: {
      weights: [...new Set(visibleCatalog.flatMap((block) => block.skuNodes.map((node) => node.targetWeightKg)))].sort((left, right) => left - right),
      typeIds: [...new Set(visibleCatalog.map((block) => block.typeId))].sort(),
      issueCodes: [...new Set(visibleCatalog.flatMap((block) => block.aggregate.issueCodes))].sort(),
      ruleSetVersions: [...new Set(visibleCatalog.flatMap((block) => block.aggregate.ruleSetVersions))].sort(),
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
