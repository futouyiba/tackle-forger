import assert from "node:assert/strict";
import test from "node:test";
import { mergeV23WeightBands, projectV23SeriesGantt, resolveCurrentV23Parts, resolveCurrentV23Skus, selectCurrentPublishedWeightTemplateDraftId, validateV23PreviewSkuHeads } from "../lib/v23-series-gantt";
import type { SeriesPartRevision, SkuDrawerRevision, WorkspaceState } from "../lib/types";

const part = (partId: string, partType: "rod" | "reel" | "line", weightBandIds: string[]): SeriesPartRevision => ({
  partId, seriesId: "series:one", revision: 1, partType, fishingMethodId: "method", materialTypeId: "material",
  functionProfileId: "function", functionIntensity: 1, weightBandIds, defaultEntryRefs: [], technologyRefs: [], inputFingerprint: "a".repeat(64), contentHash: "b".repeat(64),
});
function state(parts: SeriesPartRevision[], heads = parts.map((entry) => ({ seriesId: entry.seriesId, partId: entry.partId, revision: entry.revision }))) {
  return { v23SeriesPartRevisions: parts, v23SeriesPartHeads: heads, v23SkuDrawerHeads: [], v23SkuDrawerRevisions: [] } as unknown as WorkspaceState;
}

test("v23 甘特仅按 01.x 顺序合并相邻重量段，缺口会分裂", () => {
  const rod = part("part:rod", "rod", ["01.1", "01.2", "01.4"]);
  assert.deepEqual(mergeV23WeightBands(rod, ["01.1", "01.2", "01.3", "01.4"]).map((block) => block.weightBandIds), [["01.1", "01.2"], ["01.4"]]);
});

test("同一 Part 即使有缺口也只生成一个 Part view，内含多个合并块", () => {
  const rod = part("part:rod", "rod", ["01.1", "01.3"]);
  const view = projectV23SeriesGantt(state([rod]), "series:one", ["01.1", "01.2", "01.3"]);
  assert.equal(view.parts.length, 1);
  assert.deepEqual(view.parts[0]!.bandBlocks.map((block) => block.weightBandIds), [["01.1"], ["01.3"]]);
});

test("SKU 当前 head 重复或 immutable revision 缺失时整体 fail closed", async () => {
  const { resolveCurrentV23Skus } = await import("../lib/v23-series-gantt");
  const duplicate = state([]); duplicate.v23SkuDrawerHeads = [{ skuId: "sku:one", revision: 1 }, { skuId: "sku:one", revision: 1 }];
  assert.equal(resolveCurrentV23Skus(duplicate, "part:rod").unresolved, true);
});

test("未知或重复 catalog/Part band 都 fail closed，且不改写输入", () => {
  const rod = part("part:rod", "rod", ["01.1", "missing"]); const input = structuredClone(rod);
  assert.equal(projectV23SeriesGantt(state([rod]), "series:one", ["01.1", "01.2"]).unresolved, true);
  assert.equal(projectV23SeriesGantt(state([rod]), "series:one", ["01.1", "01.1"]).unresolved, true);
  assert.deepEqual(rod, input);
});

test("current published 按 version 降序并以 id 稳定决胜", () => {
  const candidate = state([]); candidate.ruleSetVersions = [{ id: "z", version: 2, status: "published", settings: {}, sourceRevisionIds: [], weightTemplateDraftId: "draft:z", createdAt: "" }, { id: "a", version: 2, status: "published", settings: {}, sourceRevisionIds: [], weightTemplateDraftId: "draft:a", createdAt: "" }] as never;
  assert.equal(selectCurrentPublishedWeightTemplateDraftId(candidate), "draft:a");
});

test("preview SKU exact set 拒绝缺项、多项和重复项", () => {
  const sku = { skuId: "sku:one", revision: 1 } as SkuDrawerRevision;
  assert.equal(validateV23PreviewSkuHeads([sku], [sku]), true);
  assert.equal(validateV23PreviewSkuHeads([sku], []), false);
  assert.equal(validateV23PreviewSkuHeads([sku], [sku, sku]), false);
});

test("缺失 Part immutable revision fail closed", () => {
  const rod = part("part:rod", "rod", ["01.1"]);
  assert.equal(resolveCurrentV23Parts(state([rod], [{ seriesId: "series:one", partId: "part:rod", revision: 2 }]), "series:one").unresolved, true);
});

test("多个 SKU 可在同一重量段保持独立 identity", () => {
  const source = state([]); source.v23SkuDrawerHeads = [{ skuId: "a", revision: 1 }, { skuId: "b", revision: 1 }]; source.v23SkuDrawerRevisions = [{ skuId: "a", revision: 1, partId: "part:rod", weightBandId: "01.1" }, { skuId: "b", revision: 1, partId: "part:rod", weightBandId: "01.1" }] as never;
  assert.equal(resolveCurrentV23Skus(source, "part:rod", "01.1").skus.length, 2);
});

test("没有 published RuleSet 时不选择任意历史数组项", () => {
  const empty = state([]); empty.ruleSetVersions = []; assert.equal(selectCurrentPublishedWeightTemplateDraftId(empty), undefined);
});

test("Part weightBandIds 重复时 projection 不产生可点击块", () => {
  const rod = part("part:rod", "rod", ["01.1", "01.1"]);
  assert.deepEqual(projectV23SeriesGantt(state([rod]), "series:one", ["01.1"]).parts, []);
});

test("重复或不可解析 Part head fail closed，绝不猜测最新 revision", () => {
  const rod = part("part:rod", "rod", ["01.1"]);
  const result = resolveCurrentV23Parts(state([rod], [{ seriesId: "series:one", partId: "part:rod", revision: 1 }, { seriesId: "series:one", partId: "part:rod", revision: 1 }]), "series:one");
  assert.equal(result.unresolved, true);
  assert.deepEqual(projectV23SeriesGantt(state([rod], []), "series:one", ["01.1"]).parts, []);
});
