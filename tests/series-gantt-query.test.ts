import assert from "node:assert/strict";
import test from "node:test";
import {
  querySeriesGantt,
  paginateSeriesGantt,
  paginateSeriesGanttChildren,
  seriesGanttQueryFromSearchParams,
  seriesGanttQueryToSearchParams,
  type SeriesGanttQuery,
} from "../lib/series-gantt-query";
import { createSeedState } from "../lib/seed";
import { hydrateV3Seed } from "../lib/v3-seed";

function state() {
  return hydrateV3Seed(createSeedState());
}

test("SeriesGanttQuery 同字段 OR、不同字段 AND，并保留真实离散 SKU", () => {
  const workspace = state();
  const target = workspace.seriesDefinitions[0];
  const result = querySeriesGantt({
    query: {
      qualityIds: [target.qualityId, "quality_s_orange"],
      typeIds: [target.typeId],
      exactTargetWeightKg: target.targetWeightsKg.slice(0, 1),
    },
    series: workspace.seriesDefinitions,
    skus: workspace.skuDrawers,
    models: workspace.purchasableModels,
    itemTypes: workspace.itemTypeProfiles,
    upgrades: workspace.upgradeCandidates,
  });
  assert.ok(result.some((entry) => entry.seriesId === target.id));
  const selected = result.find((entry) => entry.seriesId === target.id)!;
  assert.deepEqual(
    selected.skuNodes.map((node) => node.targetWeightKg),
    workspace.skuDrawers
      .filter((sku) => sku.seriesId === target.id)
      .map((sku) => sku.targetWeightKg)
      .sort((left, right) => left - right),
  );
});

test("SeriesGanttQuery 聚合阻断、warning、升级候选和主状态且不吞副状态", () => {
  const workspace = state();
  const upgrade = workspace.upgradeCandidates.find((entry) => entry.status === "pending");
  assert.ok(upgrade);
  const model = workspace.purchasableModels.find((entry) => entry.id === upgrade.modelId);
  assert.ok(model);
  const sku = workspace.skuDrawers.find((entry) => entry.id === model.skuId);
  assert.ok(sku);
  sku.validationSummary.push({ level: "warning", code: "QUERY_WARNING", message: "查询聚合告警。" });
  const [entry] = querySeriesGantt({
    query: { hasUpgradeCandidate: true },
    series: workspace.seriesDefinitions,
    skus: workspace.skuDrawers,
    models: workspace.purchasableModels,
    itemTypes: workspace.itemTypeProfiles,
    upgrades: workspace.upgradeCandidates,
  }).filter((item) => item.seriesId === sku.seriesId);
  assert.ok(entry);
  assert.ok(entry.aggregate.attention.includes("HAS_UPGRADE_CANDIDATE"));
  assert.equal(entry.aggregate.validationState, "WARNING");
  assert.equal(entry.aggregate.primary, "WARNING");
  assert.equal(entry.aggregate.pendingUpgradeCount >= 1, true);
});

test("SeriesGanttQuery 可按规范 BLOCKER 严重度筛选并兼容旧 level", () => {
  const workspace = state();
  const sku = workspace.skuDrawers[0];
  sku.validationSummary.push({
    level: "error",
    severity: "BLOCKER",
    code: "QUERY_BLOCKER",
    message: "绝对阻断。",
  });
  const blocker = querySeriesGantt({
    query: { issueSeverities: ["BLOCKER"] },
    series: workspace.seriesDefinitions,
    skus: workspace.skuDrawers,
    models: workspace.purchasableModels,
    itemTypes: workspace.itemTypeProfiles,
    upgrades: workspace.upgradeCandidates,
  });
  assert.ok(blocker.some((entry) => entry.seriesId === sku.seriesId));
  const errors = querySeriesGantt({
    query: { issueSeverities: ["ERROR"] },
    series: workspace.seriesDefinitions,
    skus: workspace.skuDrawers,
    models: workspace.purchasableModels,
    itemTypes: workspace.itemTypeProfiles,
    upgrades: workspace.upgradeCandidates,
  });
  assert.equal(errors.some((entry) => entry.seriesId === sku.seriesId), false);
});

test("SeriesGanttQuery URL 往返保留多选、精确重量、升级筛选和排序", () => {
  const source: SeriesGanttQuery = {
    text: "青芦",
    qualityIds: ["quality_c_green", "quality_a_purple"],
    exactTargetWeightKg: [1.5, 1.8],
    attentionStates: ["SOURCE_STALE", "HAS_UPGRADE_CANDIDATE"],
    issueSeverities: ["ERROR", "WARNING"],
    hasUpgradeCandidate: true,
    sort: "quality_type" as const,
  };
  const params = seriesGanttQueryToSearchParams(source);
  const parsed = seriesGanttQueryFromSearchParams(params);
  assert.equal(parsed.text, source.text);
  assert.deepEqual(parsed.qualityIds, source.qualityIds);
  assert.deepEqual(parsed.exactTargetWeightKg, source.exactTargetWeightKg);
  assert.deepEqual(parsed.attentionStates, [...(source.attentionStates ?? [])]);
  assert.deepEqual(parsed.issueSeverities, [...(source.issueSeverities ?? [])]);
  assert.equal(parsed.hasUpgradeCandidate, true);
  assert.equal(parsed.sort, "quality_type");
});

test("SeriesGanttQuery 空 URL 不会把缺失拉力范围解析为 0..0", () => {
  const parsed = seriesGanttQueryFromSearchParams(new URLSearchParams());
  assert.equal(parsed.minTargetPullKg, undefined);
  assert.equal(parsed.maxTargetPullKg, undefined);
  const whitespace = seriesGanttQueryFromSearchParams(
    new URLSearchParams({ minTargetPullKg: " ", maxTargetPullKg: "" }),
  );
  assert.equal(whitespace.minTargetPullKg, undefined);
  assert.equal(whitespace.maxTargetPullKg, undefined);
});

test("SeriesGanttQuery 在聚合前裁剪不可见 Series、SKU 与 Model 且不泄露总数", () => {
  const workspace = state();
  const series = workspace.seriesDefinitions[0];
  const visibleSku = workspace.skuDrawers.find((sku) => sku.seriesId === series.id)!;
  const visibleModelId = visibleSku.modelIds[0];
  const [entry] = querySeriesGantt({
    query: {},
    series: workspace.seriesDefinitions,
    skus: workspace.skuDrawers,
    models: workspace.purchasableModels,
    itemTypes: workspace.itemTypeProfiles,
    upgrades: workspace.upgradeCandidates,
    visibility: {
      seriesIds: [series.id],
      skuIds: [visibleSku.id],
      modelIds: [visibleModelId],
      discloseTotalModelCount: false,
    },
  });
  assert.equal(entry.seriesId, series.id);
  assert.equal(entry.skuNodes.length, 1);
  assert.deepEqual(entry.skuNodes[0].modelIds, [visibleModelId]);
  assert.equal(entry.aggregate.modelCountVisible, 1);
  assert.equal(entry.aggregate.modelCountTotal, undefined);
  const hiddenSeries = { ...series, id: "series:hidden", name: "权限外系列", skuIds: [] };
  assert.equal(querySeriesGantt({
    query: { text: hiddenSeries.name },
    series: [...workspace.seriesDefinitions, hiddenSeries],
    skus: workspace.skuDrawers,
    models: workspace.purchasableModels,
    itemTypes: workspace.itemTypeProfiles,
    upgrades: workspace.upgradeCandidates,
    visibility: { seriesIds: [series.id] },
  }).length, 0);
});

test("SeriesGanttQuery 游标绑定 workspace revision 与查询 hash，变化时拒绝拼接", () => {
  const workspace = state();
  const items = querySeriesGantt({
    query: {},
    series: workspace.seriesDefinitions,
    skus: workspace.skuDrawers,
    models: workspace.purchasableModels,
    itemTypes: workspace.itemTypeProfiles,
    upgrades: workspace.upgradeCandidates,
  });
  const first = paginateSeriesGantt({ items, query: { pageSize: 1 }, workspaceRevision: 7 });
  if (items.length > 1) {
    assert.ok(first.nextCursor);
    const second = paginateSeriesGantt({ items, query: { pageSize: 1, cursor: first.nextCursor }, workspaceRevision: 7 });
    assert.equal(second.items.length, 1);
    assert.throws(
      () => paginateSeriesGantt({ items, query: { pageSize: 1, cursor: first.nextCursor }, workspaceRevision: 8 }),
      /SERIES_GANTT_CURSOR_STALE/,
    );
    assert.throws(
      () => paginateSeriesGantt({ items, query: { pageSize: 2, cursor: first.nextCursor }, workspaceRevision: 7 }),
      /SERIES_GANTT_CURSOR_STALE/,
    );
  }
});

test("SeriesGanttQuery 子对象游标绑定父对象、页大小与 revision", () => {
  const items = [{ id: "sku:1" }, { id: "sku:2" }, { id: "sku:3" }];
  const first = paginateSeriesGanttChildren({
    items,
    kind: "skus",
    parentId: "series:1",
    pageSize: 1,
    workspaceRevision: 9,
  });
  assert.equal(first.items[0]?.id, "sku:1");
  assert.ok(first.nextCursor);
  assert.equal(paginateSeriesGanttChildren({
    items,
    kind: "skus",
    parentId: "series:1",
    pageSize: 1,
    cursor: first.nextCursor,
    workspaceRevision: 9,
  }).items[0]?.id, "sku:2");
  assert.throws(() => paginateSeriesGanttChildren({
    items,
    kind: "models",
    parentId: "sku:1",
    pageSize: 1,
    cursor: first.nextCursor,
    workspaceRevision: 9,
  }), /SERIES_GANTT_CURSOR_STALE/);
  assert.throws(() => paginateSeriesGanttChildren({
    items,
    kind: "skus",
    parentId: "series:1",
    pageSize: 1,
    cursor: first.nextCursor,
    workspaceRevision: 10,
  }), /SERIES_GANTT_CURSOR_STALE/);
});
