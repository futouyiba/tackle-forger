import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSamePartComparison,
  fiveAxisPlotRatio,
  buildTackleFitComparison,
  calculateModelFiveAxisPreview,
  createFiveAxisVertexSet,
  validateFiveAxisDisplayBands,
} from "../lib/five-axis";

test("五维绘图缺失值保持缺失，不会落到零点", () => {
  assert.equal(fiveAxisPlotRatio(null), null);
  assert.equal(fiveAxisPlotRatio(Number.NaN), null);
  assert.equal(fiveAxisPlotRatio(0), 0);
  assert.equal(fiveAxisPlotRatio(120), 1);
  assert.equal(fiveAxisPlotRatio(75, 150), 0.5);
});
import { deterministicHash } from "../lib/rule-kernel";
import {
  publishConfigurationSnapshot,
  verifySnapshotIntegrity,
} from "../lib/publishing";
import { createSeedState } from "../lib/seed";
import { migrateWorkspaceState } from "../lib/migrations";
import { hydrateV3Seed } from "../lib/v3-seed";
import {
  buildFormalComponentSelectionsFixture,
  buildFormalPreviewFixture,
} from "./helpers/formal-five-axis";
import type {
  FiveAxisEntityInput,
  FiveAxisViewDefinition,
  ProjectionTraceStep,
} from "../lib/types";

const PARTS = ["part:rod", "part:reel", "part:line"];

function finalSettlementTrace(values: Record<string, number | string>): ProjectionTraceStep[] {
  return [{
    layer: "final_review_patch",
    sourceIds: ["test:final-settlement"],
    contributions: Object.entries(values).map(([parameterKey, value], index) => ({
      sequence: index + 1, ruleId: `test:${parameterKey}`, sourceId: "test:final-settlement",
      sourceName: "最终结算", parameterKey, operation: "base", before: null, operand: value, after: value,
    })),
  }];
}

function definition(): FiveAxisViewDefinition {
  const content: Omit<FiveAxisViewDefinition, "definitionHash"> = {
    definitionId: "five-axis:test",
    version: "1.0.0",
    revision: 1,
    publicationState: "PUBLISHED",
    fiveAxisRuleVersion: "feishu-3563-test",
    sourceRevision: "3563",
    axes: [
      {
        axisId: "drag",
        label: "拉力",
        order: 1,
        sourceParameterKeys: ["drag"],
        applicablePartIds: PARTS,
        direction: "higher_better",
        transformId: "identity",
        vertexSelectorId: "max",
        componentAggregationId: "component_min_ratio",
        missingPolicy: "error",
      },
      {
        axisId: "durability",
        label: "耐久",
        order: 2,
        sourceParameterKeys: ["durability"],
        applicablePartIds: PARTS,
        direction: "higher_better",
        transformId: "identity",
        vertexSelectorId: "max",
        componentAggregationId: "component_min_ratio",
        missingPolicy: "error",
      },
      {
        axisId: "cast",
        label: "抛投",
        order: 3,
        sourceParameterKeys: ["max_cast_distance"],
        applicablePartIds: ["part:rod"],
        direction: "higher_better",
        transformId: "identity",
        vertexSelectorId: "max",
        componentAggregationId: "component_min_ratio",
        contextInheritanceId: "single_applicable_source",
        missingPolicy: "ignore_not_applicable",
      },
      {
        axisId: "sensitivity",
        label: "感度",
        order: 4,
        sourceParameterKeys: ["sensitivity"],
        applicablePartIds: PARTS,
        direction: "lower_better",
        transformId: "sum",
        vertexSelectorId: "min",
        componentAggregationId: "component_min_ratio",
        missingPolicy: "error",
      },
      {
        axisId: "control",
        label: "操控",
        order: 5,
        sourceParameterKeys: ["energy_cost_factor"],
        applicablePartIds: PARTS,
        direction: "lower_better",
        transformId: "identity",
        vertexSelectorId: "min",
        componentAggregationId: "component_min_ratio",
        missingPolicy: "error",
      },
    ],
    seriesBaselinePolicy: { mode: "explicit_model", required: true },
  };
  return { ...content, definitionHash: deterministicHash(content) };
}

function component(
  entityId: string,
  itemPartId: string,
  fishWeightGradeId: string,
  values: FiveAxisEntityInput["values"],
): FiveAxisEntityInput {
  return {
    entityId,
    itemPartId,
    label: entityId,
    fishWeightGradeId,
    revision: 1,
    values,
  };
}

function references(): FiveAxisEntityInput[] {
  return [
    component("ref:rod", "part:rod", "grade:15", {
      drag: 100,
      durability: 100,
      max_cast_distance: 100,
      sensitivity: 1,
      energy_cost_factor: 1,
    }),
    component("ref:reel", "part:reel", "grade:15", {
      drag: 120,
      durability: 110,
      sensitivity: 0.8,
      energy_cost_factor: 0.9,
    }),
    component("ref:line", "part:line", "grade:15", {
      drag: 110,
      durability: 90,
      sensitivity: 1.1,
      energy_cost_factor: 0.7,
    }),
  ];
}

function modelComponents(): FiveAxisEntityInput[] {
  return [
    component("model:rod", "part:rod", "grade:10", {
      drag: 120,
      durability: 88,
      max_cast_distance: 130,
      sensitivity: 1,
      energy_cost_factor: 0.7,
    }),
    component("model:reel", "part:reel", "grade:20", {
      drag: 96,
      durability: 121,
      sensitivity: 0.8,
      energy_cost_factor: 0.875,
    }),
    component("model:line", "part:line", "grade:30", {
      drag: 144,
      durability: 77,
      sensitivity: 1.2,
      energy_cost_factor: 0.84,
    }),
  ];
}

function setup() {
  const def = definition();
  const vertexSet = createFiveAxisVertexSet({
    definition: def,
    fishWeightGradeId: "grade:15",
    referenceComponents: references(),
  });
  return { def, vertexSet };
}

function point(
  view: ReturnType<typeof buildTackleFitComparison>,
  entityId: string,
  axisId: string,
) {
  return view.series
    .find((series) => series.entityId === entityId)!
    .points.find((entry) => entry.axisId === axisId)!;
}

test("五轴顶点按共同鱼重等级生成并保持确定性", () => {
  const first = setup();
  const second = setup();
  assert.deepEqual(first.vertexSet.values, {
    drag: 120,
    durability: 110,
    cast: 100,
    sensitivity: 0.8,
    control: 0.7,
  });
  assert.equal(first.vertexSet.vertexSetHash, second.vertexSet.vertexSetHash);
});

test("钓组模式使用共同顶点、保留超顶点值并按部件短板汇总", () => {
  const { def, vertexSet } = setup();
  const view = buildTackleFitComparison({
    modelId: "model:test",
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: modelComponents(),
  });

  assert.equal(point(view, "model:rod", "drag").comparisonScore, 100);
  assert.equal(point(view, "model:line", "drag").officialDisplayScore, 100);
  assert.equal(point(view, "model:line", "drag").comparisonScore, 120);
  assert.equal(point(view, "model:line", "drag").overflow, 20);

  const summary = view.series.find((series) => series.itemPartId === "model_summary")!;
  assert.equal(
    summary.points.find((entry) => entry.axisId === "drag")!.officialDisplayScore,
    80,
  );
  assert.equal(
    summary.points.find((entry) => entry.axisId === "durability")!.officialDisplayScore,
    70,
  );
  assert.equal(
    summary.points.find((entry) => entry.axisId === "cast")!.officialDisplayScore,
    100,
  );
  assert.equal(
    summary.points.find((entry) => entry.axisId === "control")!.officialDisplayScore,
    80,
  );
  assert.equal(
    view.axisSummaries.find((entry) => entry.axisId === "drag")!.spread,
    0.4,
  );
  assert.equal(view.validationIssues.length, 0);
});

test("抛投只由竿直接计算，轮线继承且不参与匹配差值", () => {
  const { def, vertexSet } = setup();
  const view = buildTackleFitComparison({
    modelId: "model:test",
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: modelComponents(),
  });
  assert.equal(point(view, "model:rod", "cast").source, "direct");
  assert.equal(point(view, "model:reel", "cast").source, "context_inherited");
  assert.equal(point(view, "model:line", "cast").source, "context_inherited");
  assert.equal(point(view, "model:reel", "cast").comparisonScore, 130);
  assert.equal(point(view, "model:reel", "cast").participatesInRanking, false);
  assert.equal(
    view.axisSummaries.find((entry) => entry.axisId === "cast")!.spread,
    0,
  );
});

test("同部位比较拒绝混合部位，并在无参考竿时把轮抛投标为不适用", () => {
  const { def, vertexSet } = setup();
  const reels = modelComponents().filter((entry) => entry.itemPartId === "part:reel");
  reels.push(
    component("model:reel:2", "part:reel", "grade:40", {
      drag: 132,
      durability: 99,
      sensitivity: 0.9,
      energy_cost_factor: 0.7,
    }),
  );
  const view = buildSamePartComparison({
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    entities: reels,
    comparisonLimit: 3,
  });
  const cast = view.series[0].points.find((entry) => entry.axisId === "cast")!;
  assert.equal(cast.source, "not_applicable");
  assert.equal(cast.officialDisplayScore, null);
  assert.equal(
    view.axisSummaries.find((entry) => entry.axisId === "drag")!.strongestEntityIds[0],
    "model:reel:2",
  );
  assert.throws(
    () =>
      buildSamePartComparison({
        referenceFishWeightGradeId: "grade:15",
        definition: def,
        vertexSet,
        entities: [modelComponents()[0], modelComponents()[1]],
      }),
    /不能混入不同 itemPartId/,
  );
});

test("同部位轮比较可显式继承参考竿，继承点不进入排名", () => {
  const { def, vertexSet } = setup();
  const reels = modelComponents().filter((entry) => entry.itemPartId === "part:reel");
  const referenceRod = modelComponents()[0];
  const view = buildSamePartComparison({
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    entities: reels,
    referenceContext: referenceRod,
  });
  const cast = view.series[0].points.find((entry) => entry.axisId === "cast")!;
  assert.equal(cast.source, "context_inherited");
  assert.equal(cast.participatesInRanking, false);
  assert.deepEqual(
    view.axisSummaries.find((entry) => entry.axisId === "cast")!.strongestEntityIds,
    [],
  );
});

test("切换比较刻度不改变五轴领域分值", () => {
  const { def, vertexSet } = setup();
  const locked = buildTackleFitComparison({
    modelId: "model:test",
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: modelComponents(),
    scaleMode: "official_locked",
  });
  const expanded = buildTackleFitComparison({
    modelId: "model:test",
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: modelComponents(),
    scaleMode: "comparison_expanded",
  });
  assert.deepEqual(
    locked.series.map((series) => series.points),
    expanded.series.map((series) => series.points),
  );
});

test("缺失、无效与不适用状态不会被画成 0", () => {
  const { def, vertexSet } = setup();
  const broken = modelComponents();
  delete broken[0].values.sensitivity;
  broken[1].values.energy_cost_factor = 0;
  const view = buildTackleFitComparison({
    modelId: "model:test",
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: broken,
  });
  assert.equal(point(view, "model:rod", "sensitivity").source, "error");
  assert.equal(point(view, "model:rod", "sensitivity").officialDisplayScore, null);
  assert.equal(point(view, "model:reel", "control").source, "error");
  assert.equal(point(view, "model:line", "cast").source, "context_inherited");
  assert.ok(view.validationIssues.some((issue) => issue.level === "error"));
});

test("五轴预览相同输入产生相同哈希和轨迹", () => {
  const { def, vertexSet } = setup();
  const input = {
    modelId: "model:test",
    modelRevision: 3,
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: modelComponents(),
    finalPanelHash: deterministicHash({ panel: 1 }),
  };
  assert.deepEqual(
    calculateModelFiveAxisPreview(input),
    calculateModelFiveAxisPreview(structuredClone(input)),
  );
});

test("非法 50..800 档位产生导入警告，不固化为永久边界", () => {
  const issues = validateFiveAxisDisplayBands([
    { id: "weak", min: 0, max: 50 },
    { id: "medium", min: 50, max: 800 },
    { id: "strong", min: 800, max: 100, includeMax: true },
  ]);
  assert.ok(
    issues.some((issue) => issue.code === "FIVE_AXIS_BAND_OUT_OF_RANGE"),
  );
});

test("发布快照冻结五轴预览，后续输入变化不改写历史内容", () => {
  const state = createSeedState();
  const existing = state.configurationSnapshots[0];
  const model = state.purchasableModels.find((entry) => entry.id === existing.modelId)!;
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const projection = state.derivedProjections.find(
    (entry) => entry.id === existing.projectionId,
  )!;
  const { def, vertexSet } = setup();
  const preview = calculateModelFiveAxisPreview({
    modelId: model.id,
    modelRevision: model.revision,
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: modelComponents(),
    finalPanelHash: deterministicHash(existing.finalPanelValues),
  });
  const snapshot = publishConfigurationSnapshot({
    publicationMode: "historical_import",
    model,
    sku,
    series,
    seriesSkus: state.skuDrawers,
    projection,
    finalPanelValues: existing.finalPanelValues,
    componentSelections: existing.componentSelections,
    patches: [],
    attributeAffixIds: existing.attributeAffixIds,
    passiveAffixIds: existing.passiveAffixIds,
    technologyIds: existing.technologyIds,
    passiveAffixPayloads: existing.passiveAffixPayloads,
    compatibilityReport: existing.compatibilityReport,
    affinityReport: existing.affinityReport,
    qualityReport: existing.qualityReport,
    validationReport: [],
    fiveAxisPreview: preview,
    warningConfirmations: {},
    publishedBy: "five-axis-test",
    publishedAt: "2026-07-20T02:00:00.000Z",
    snapshotId: "snapshot:five-axis-test",
  });
  const frozen = structuredClone(snapshot.fiveAxisPreview);
  preview.metrics[0].displayScore = 1;
  assert.deepEqual(snapshot.fiveAxisPreview, frozen);
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  assert.equal(verifySnapshotIntegrity(existing), true);
});

test("旧 PUBLISHED 五维定义只能用于历史重放，不能服务新正式快照", () => {
  const state = createSeedState();
  const existing = state.configurationSnapshots[0];
  const model = state.purchasableModels.find((entry) => entry.id === existing.modelId)!;
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const projection = state.derivedProjections.find((entry) => entry.id === existing.projectionId)!;
  const { def, vertexSet } = setup();
  const preview = calculateModelFiveAxisPreview({
    modelId: model.id,
    modelRevision: model.revision,
    referenceFishWeightGradeId: "grade:15",
    definition: def,
    vertexSet,
    components: modelComponents(),
    finalPanelHash: deterministicHash(projection.values),
  });
  const common = {
    publicationMode: "new_formal" as const,
    workspaceId: "workspace:test",
    model, sku, series, projection,
    seriesSkus: state.skuDrawers,
    finalPanelValues: projection.values,
    componentSelections: existing.componentSelections,
    patches: [],
    attributeAffixIds: existing.attributeAffixIds,
    passiveAffixIds: existing.passiveAffixIds,
    technologyIds: existing.technologyIds,
    technologyDefinitions: state.technologies,
    finalSettlementTrace: finalSettlementTrace(projection.values),
    passiveAffixPayloads: existing.passiveAffixPayloads,
    compatibilityReport: existing.compatibilityReport,
    affinityReport: existing.affinityReport,
    qualityReport: existing.qualityReport,
    qualityValueAssessment: {
      modelRevisionId: `${model.id}@${model.revision}`, selectedQualityId: series.qualityId,
      baseAffixScore: 1, combinationScore: 0, functionScoreFactor: 1,
      finalValueScore: 1, affixBreakdown: [],
      combinationBreakdown: [], qualityRangePolicyVersion: "q:1",
      scoringPolicyVersion: "s:1", inSelectedQualityRange: true, formal: true,
      issues: [], trace: [], inputHash: "quality-hash",
    },
    pricingPolicyVersion: "pricing:1",
    automaticPricing: {
      formal: true, pricingPolicyRef: "pricing:1", pricingWeightBandId: "band:1",
      valueScore: 1,
      pricingBasketId: "basket:1", repairPriceUnrounded: 100,
      purchasePriceUnrounded: 100, purchasePrice: 100, trace: [{
        sequence: 1,
        formulaStep: "purchasePrice",
        sourceRevision: "pricing:test",
        source: { sheetId: "pricing:test", cell: "A1" },
        before: 100,
        operation: "multiply" as const,
        operand: 1,
        after: 100,
        inputStatus: "CONFIRMED" as const,
      }], issues: [],
      warnings: [], inputHash: "pricing-hash",
    },
    validationReport: [], fiveAxisPreview: preview, warningConfirmations: {},
    publishedBy: "tester", publishedAt: "2026-07-22T00:00:00.000Z",
    snapshotId: "snapshot:formal-gate",
    fiveAxisDefinitions: state.fiveAxisViewDefinitions,
    fiveAxisDispositionCatalogRevisions:
      state.fiveAxisDispositionCatalogRevisions,
    currentFiveAxisDispositionCatalogRevisionId:
      state.currentFiveAxisDispositionCatalogRevisionId,
  };
  assert.throws(
    () => publishConfigurationSnapshot({ ...common, fiveAxisDefinition: def }),
    /FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE/,
  );
  const formalDefinition = state.fiveAxisViewDefinitions.find(
    (definition) => "semanticContractVersion" in definition,
  )!;
  const formalComponentSelections = buildFormalComponentSelectionsFixture(
    existing.componentSelections,
  );
  assert.throws(
    () => publishConfigurationSnapshot({
      ...common,
      fiveAxisPreview: undefined,
      fiveAxisDefinition: formalDefinition,
    }),
    /FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE/,
  );
  const formalPreview = buildFormalPreviewFixture({
    definition: formalDefinition,
    snapshotId: common.snapshotId,
    modelId: model.id,
    modelRevision: model.revision,
    seriesId: series.id,
    skuId: sku.id,
    skuRevision: sku.revision,
    modelFinalPullKg: existing.modelFinalPullKg!,
    finalPanelValues: existing.finalPanelValues,
    componentSelections: formalComponentSelections,
  });
  const formalSnapshot = publishConfigurationSnapshot({
    ...common,
    sku: {
      ...sku,
      fiveAxisProjectionReferences: structuredClone(
        formalPreview.tackleFitComparison.projectionReferences!,
      ),
    },
    componentSelections: formalComponentSelections,
    fiveAxisPreview: formalPreview,
    fiveAxisAuthorityState: {
      purchasableModels: state.purchasableModels,
      configurationSnapshots: state.configurationSnapshots,
    },
    fiveAxisDefinition: formalDefinition,
  });
  assert.equal(
    formalSnapshot.fiveAxisDispositionEvidence?.disposition.effectiveUse,
    "FORMAL_CURRENT",
  );
  assert.equal(verifySnapshotIntegrity(formalSnapshot), true);
  const snapshot = publishConfigurationSnapshot({
    ...common,
    publicationMode: "historical_import",
    fiveAxisDefinition: def,
  });
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  assert.ok(snapshot.calculationTrace?.entries.some((entry) =>
    entry.evidence?.adapter === "five_axis_trace/v1"));
  const traceTampered = structuredClone(snapshot);
  const frozenFiveAxisTrace = traceTampered.fiveAxisPreview!.metrics
    .flatMap((metric) => metric.trace)[0];
  assert.ok(frozenFiveAxisTrace);
  frozenFiveAxisTrace.value = typeof frozenFiveAxisTrace.value === "number"
    ? frozenFiveAxisTrace.value + 1
    : "tampered";
  traceTampered.contentHash = deterministicHash(
    Object.fromEntries(Object.entries(traceTampered).filter(([key]) => key !== "contentHash")),
  );
  assert.equal(verifySnapshotIntegrity(traceTampered), false);
  const frozen = structuredClone(snapshot);
  def.axes[0].label = "changed after publish";
  assert.deepEqual(snapshot, frozen);
});

test("历史五维预览缺少定义修订哈希时保持原 Snapshot hash，不被迁移补写", () => {
  const state = hydrateV3Seed(createSeedState());
  const existing = structuredClone(
    state.configurationSnapshots.find((entry) => entry.fiveAxisPreview)!,
  );
  delete existing.fiveAxisPreview!.fiveAxisDefinitionRevision;
  delete existing.fiveAxisPreview!.fiveAxisDefinitionHash;
  const legacyContent = Object.fromEntries(
    Object.entries(existing).filter(([key]) => key !== "contentHash"),
  );
  existing.contentHash = deterministicHash(legacyContent);
  assert.equal(existing.calculationTrace, undefined);
  const legacyHash = existing.contentHash;
  state.configurationSnapshots = [existing];
  const migrated = migrateWorkspaceState(state);
  assert.equal(migrated.configurationSnapshots[0].contentHash, legacyHash);
  assert.equal(migrated.configurationSnapshots[0].fiveAxisPreview?.fiveAxisDefinitionRevision, undefined);
  assert.equal(migrated.configurationSnapshots[0].fiveAxisPreview?.fiveAxisDefinitionHash, undefined);
  assert.equal(verifySnapshotIntegrity(migrated.configurationSnapshots[0]), true);
});
