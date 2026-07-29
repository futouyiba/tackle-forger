import assert from "node:assert/strict";
import test from "node:test";
import { mergeV23WeightBands, projectV23SeriesGantt, resolveCurrentV23Parts, resolveCurrentV23Skus, resolveCurrentV23Technologies, resolveV23CatalogOrder, resolveV23InheritedAffixRefs, resolveV23TechnologySurface, selectCurrentPublishedWeightTemplateDraftId, validateV23PreviewSkuHeads } from "../lib/v23-series-gantt";
import { v23CanApplyReadback, v23LatestGeneration, v23WritePreflight } from "../lib/v23-ui-actions";
import { v23TechnologyContentHash } from "../lib/v23-technology";
import type { SeriesPartRevision, SkuDrawerRevision, V23TechnologyDefinition, WorkspaceState } from "../lib/types";

const part = (partId: string, partType: "rod" | "reel" | "line", weightBandIds: string[]): SeriesPartRevision => ({
  partId, seriesId: "series:one", revision: 1, partType, fishingMethodId: "method", materialTypeId: "material",
  functionProfileId: "function", functionIntensity: 1, weightBandIds, defaultEntryRefs: [], technologyRefs: [], inputFingerprint: "a".repeat(64), contentHash: "b".repeat(64),
});
function state(parts: SeriesPartRevision[], heads = parts.map((entry) => ({ seriesId: entry.seriesId, partId: entry.partId, revision: entry.revision }))) {
  return { v23SeriesPartRevisions: parts, v23SeriesPartHeads: heads, v23SkuDrawerHeads: [], v23SkuDrawerRevisions: [], v23AffixDefinitions: [], v23TechnologyDefinitions: [], v23TechnologyHeads: [] } as unknown as WorkspaceState;
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

test("最高 published version 并列时 fail closed，不以 id 打破语义歧义", () => {
  const candidate = state([]); candidate.ruleSetVersions = [{ id: "z", version: 2, status: "published", settings: {}, sourceRevisionIds: [], weightTemplateDraftId: "draft:z", createdAt: "" }, { id: "a", version: 2, status: "published", settings: {}, sourceRevisionIds: [], weightTemplateDraftId: "draft:a", createdAt: "" }] as never;
  assert.equal(selectCurrentPublishedWeightTemplateDraftId(candidate), undefined);
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

test("写入预检拒绝 dirty、revision 漂移并仅接受精确 baseline", () => {
  assert.deepEqual(v23WritePreflight({ dirty: true, revision: 4, expectedWorkspaceRevision: 4 }), { allowed: false, reason: "dirty" });
  assert.deepEqual(v23WritePreflight({ dirty: false, revision: 4, expectedWorkspaceRevision: 3 }), { allowed: false, reason: "revision" });
  assert.deepEqual(v23WritePreflight({ dirty: false, revision: 4, expectedWorkspaceRevision: 4 }), { allowed: true });
});

test("旧 generation 与 dirty/revision drift readback 不得覆盖当前状态", () => {
  assert.equal(v23LatestGeneration(3, 2), false); assert.equal(v23LatestGeneration(3, 3), true);
  assert.equal(v23CanApplyReadback({ current: { dirty: true, revision: 4 }, baselineRevision: 4, returnedRevision: 5 }), false);
  assert.equal(v23CanApplyReadback({ current: { dirty: false, revision: 5 }, baselineRevision: 4, returnedRevision: 5 }), false);
  assert.equal(v23CanApplyReadback({ current: { dirty: false, revision: 4 }, baselineRevision: 4, returnedRevision: 5 }), true);
});

test("01.x catalog 严格拒绝缺失、空白、重复 ID 与无效 sourceRow", () => {
  for (const bad of [[{ sourceRow: 1 }], [{ id: "", sourceRow: 1 }], [{ id: " 01.1", sourceRow: 1 }], [{ id: "01.1", sourceRow: 1 }, { id: "01.1", sourceRow: 2 }], [{ id: "01.1" }], [{ id: "01.1", sourceRow: 0 }], [{ id: "01.1", sourceRow: 1 }, { id: "01.2", sourceRow: 1 }]]) assert.equal(resolveV23CatalogOrder(bad), undefined);
});

test("01.x catalog 按唯一正 sourceRow 排序，不按 ID 猜测", () => {
  assert.deepEqual(resolveV23CatalogOrder([{ id: "01.10", sourceRow: 10 }, { id: "01.2", sourceRow: 2 }]), ["01.2", "01.10"]);
});

test("重复或不可解析 Part head fail closed，绝不猜测最新 revision", () => {
  const rod = part("part:rod", "rod", ["01.1"]);
  const result = resolveCurrentV23Parts(state([rod], [{ seriesId: "series:one", partId: "part:rod", revision: 1 }, { seriesId: "series:one", partId: "part:rod", revision: 1 }]), "series:one");
  assert.equal(result.unresolved, true);
  assert.deepEqual(projectV23SeriesGantt(state([rod], []), "series:one", ["01.1"]).parts, []);
});

test("Technology surface 只消费唯一 current head，并仅展开稳定成员词条贡献", () => {
  const source = state([]);
  const memberRef = { id: "affix:member", revision: 1, contentHash: "a".repeat(64) };
  source.v23AffixDefinitions = [{
    affixId: memberRef.id,
    revision: memberRef.revision,
    contentHash: memberRef.contentHash,
    payload: {
      name: "稳定成员",
      category: "passive",
      itemPartId: "part:rod",
      semanticContributionKey: "member:stable",
      stackingPolicy: "dedupe",
      generationPolicy: "technology_only",
      rarity: "ultra_rare",
      valueScore: 9,
      tags: [],
      description: "只由成员贡献",
      enabled: true,
      operations: [],
      passivePayload: {
        skillId: "skill:member", name: "稳定成员", itemPartId: "part:rod",
        triggerType: "display", triggerDescription: "展示", effectTarget: "展示",
        effectLogicDescription: "不执行", exampleParameters: {}, durationDescription: "不执行",
        cooldownDescription: "不执行", resetDescription: "不执行", stackingDescription: "不执行",
        playerDescription: "展示", simulatorReferenceKey: null,
      },
    },
  }];
  const input: Omit<V23TechnologyDefinition, "contentHash"> = {
    technologyId: "technology:one", revision: 1, itemPartId: "part:rod",
    name: "工艺一", description: "组合包", memberAffixRefs: [memberRef], enabled: true,
  };
  const technology = { ...input, contentHash: v23TechnologyContentHash(input) };
  source.v23TechnologyDefinitions = [technology];
  source.v23TechnologyHeads = [{ technologyId: technology.technologyId, revision: technology.revision }];
  assert.deepEqual(resolveCurrentV23Technologies(source, "part:rod").technologies.map((entry) => entry.name), ["工艺一"]);
  const surface = resolveV23TechnologySurface(source, [{ id: technology.technologyId, revision: technology.revision, contentHash: technology.contentHash }], "part:rod");
  assert.equal(surface.unresolved, false);
  assert.deepEqual(surface.members.map((entry) => entry.payload.name), ["稳定成员"]);
  assert.equal(surface.technologies.length, 1);
  const rod = part("part:rod", "rod", ["01.1"]);
  rod.defaultEntryRefs = [memberRef];
  rod.technologyRefs = [{ id: technology.technologyId, revision: technology.revision, contentHash: technology.contentHash }];
  const inherited = resolveV23InheritedAffixRefs(source, rod);
  assert.equal(inherited.unresolved, false);
  assert.deepEqual(inherited.refs, [memberRef], "直接引用与 Technology 成员按稳定 affix identity 去重");
  const conflict = structuredClone(rod);
  conflict.defaultEntryRefs = [{ id: memberRef.id, revision: 2, contentHash: "b".repeat(64) }];
  assert.equal(resolveV23InheritedAffixRefs(source, conflict).unresolved, true);
});

test("Technology duplicate head、错误 revision 与跨部位引用均 fail closed", () => {
  const source = state([]);
  source.v23TechnologyHeads = [{ technologyId: "technology:one", revision: 1 }, { technologyId: "technology:one", revision: 1 }];
  assert.equal(resolveCurrentV23Technologies(source, "part:rod").unresolved, true);
  assert.equal(resolveV23TechnologySurface(source, [{ id: "technology:missing", revision: 1, contentHash: "a".repeat(64) }], "part:rod").unresolved, true);
  const rod = part("part:rod", "rod", ["01.1"]);
  rod.technologyRefs = [{ id: "technology:missing", revision: 1, contentHash: "a".repeat(64) }];
  assert.deepEqual(resolveV23InheritedAffixRefs(source, rod).refs, []);
  assert.equal(resolveV23InheritedAffixRefs(source, rod).unresolved, true);
});
