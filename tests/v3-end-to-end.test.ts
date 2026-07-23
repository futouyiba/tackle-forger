import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateAffixPanel,
  evaluateAffixQuality,
  resolveAffixConfiguration,
} from "../lib/affix-engine";
import {
  defaultAffinityAxisWeights,
  evaluateAffinity,
  evaluateHardCompatibility,
} from "../lib/compatibility";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { applyLayeredPatches, previewPatchRebase } from "../lib/patch-engine";
import {
  matchNearestProjection,
  projectionPullDistance,
  structuralPullFromProjection,
  type ProjectionMatchCandidate,
} from "../lib/projection-matcher";
import {
  createPurchaseReference,
  validateSeriesInvariants,
} from "../lib/product-model";
import {
  createUpgradeCandidate,
  publishConfigurationSnapshot,
  verifySnapshotIntegrity,
} from "../lib/publishing";
import { createSeedState } from "../lib/seed";
import type {
  AffinityRule,
  CompatibilityContext,
  CompatibilityRule,
  DerivedProjection,
  ProjectionPatchRuleSource,
  QualityProfileId,
  V3Affix,
} from "../lib/types";
import workspaceV1 from "./fixtures/workspace-v1.json";

function context(targetPullKg: number): CompatibilityContext {
  return {
    methodId: "method:lure",
    typeId: "type:structure:水滴+枪柄",
    targetPullKg,
    functionId: "function:障碍强攻",
    functionIntensity: 2,
    qualityId: "quality_a_purple",
    componentIds: [],
    tags: ["qinglu_obstacle"],
  };
}

function matchCandidates(
  targetPullKg: number,
  allowed = true,
): ProjectionMatchCandidate[] {
  const state = createSeedState();
  return state.derivedProjections
    .filter((projection) => !projection.id.endsWith("-next"))
    .map((projection) => ({
      projection,
      weightTemplate: state.templates.find(
        (template) => template.id === projection.weightTemplateId,
      )!,
      itemPartId: "part:rod",
      derivedPullKg: structuralPullFromProjection(projection, "part:rod") ?? state.templates.find(
        (template) => template.id === projection.weightTemplateId,
      )!.nominalFishKg,
      compatibility: allowed
        ? evaluateHardCompatibility(context(targetPullKg), state.compatibilityRules)
        : {
            allowed: false,
            matchedRules: [],
            decisiveRuleIds: ["deny-test"],
            failures: [
              {
                ruleId: "deny-test",
                code: "DENIED" as const,
                message: "测试硬拒绝",
                suggestion: "更换类型",
              },
            ],
            suggestions: ["更换类型"],
          },
      affinity: evaluateAffinity(
        context(targetPullKg),
        state.affinityRules,
        state.affinityAxisWeights,
      ),
    }));
}

test("M-01/M-03 最近模板精确命中，1.5kg 与 1.8kg 共享基底但 Patch 独立", () => {
  const state = createSeedState();
  const projection = state.derivedProjections.find(
    (candidate) => candidate.weightTemplateId === "T04" && !candidate.id.endsWith("-next"),
  )!;
  const structuralPull = structuralPullFromProjection(projection, "part:rod")!;
  const exact = matchNearestProjection(
    {
      itemPartId: "part:rod",
      targetPullKg: structuralPull,
      methodId: projection.methodId,
      typeId: projection.typeId,
      functionId: projection.functionId,
      functionIntensity: projection.functionIntensity,
      performanceId: projection.performanceId,
      qualityId: projection.qualityId,
    },
    matchCandidates(structuralPull),
    state.parameters,
  );
  assert.equal(exact.weightTemplateId, "T04");
  assert.equal(structuralPull, exact.matchedStructuralPullKg);
  assert.equal(exact.pullDistance, 0);
  assert.equal(state.skuDrawers[0].projectionMatch.projectionId, state.skuDrawers[1].projectionMatch.projectionId);
  assert.notDeepEqual(state.skuDrawers[0].patchIds, state.skuDrawers[1].patchIds);
});

test("M-02 比例距离中点优先较高 derivedPullKg，不做插值且忽略商品层维度", () => {
  const state = createSeedState();
  const source = state.derivedProjections.find(
    (projection) => !projection.id.endsWith("-next"),
  )!;
  const makeProjection = (id: string, templateId: string): DerivedProjection => ({
    ...structuredClone(source),
    id,
    weightTemplateId: templateId,
  });
  const targetPullKg = 2;
  const compatibility = evaluateHardCompatibility(context(targetPullKg), []);
  const affinity = evaluateAffinity(
    context(targetPullKg),
    [],
    defaultAffinityAxisWeights,
  );
  const candidates: ProjectionMatchCandidate[] = [
    {
      projection: {
        ...makeProjection("projection-b", "template-b"),
        functionIntensity: 3,
        performanceId: "performance:ignored",
        qualityId: "quality_c_green",
      },
      weightTemplate: {
        id: "template-b",
        name: "B",
        fishMinKg: 4,
        fishMaxKg: 5,
        nominalFishKg: 4,
        tier: "",
        values: source.values,
        notes: "",
      },
      itemPartId: "part:rod",
      derivedPullKg: 4,
      compatibility,
      affinity: { ...affinity, score: -100 },
    },
    {
      projection: makeProjection("projection-a", "template-a"),
      weightTemplate: {
        id: "template-a",
        name: "A",
        fishMinKg: 0.5,
        fishMaxKg: 5,
        nominalFishKg: 1,
        tier: "",
        values: source.values,
        notes: "",
      },
      itemPartId: "part:rod",
      derivedPullKg: 1,
      compatibility,
      affinity: { ...affinity, score: 100 },
    },
  ];
  assert.equal(projectionPullDistance(2, 1), projectionPullDistance(2, 4));
  const match = matchNearestProjection(
    {
      itemPartId: "part:rod",
      targetPullKg,
      methodId: source.methodId,
      typeId: source.typeId,
      functionId: source.functionId,
      functionIntensity: source.functionIntensity,
      performanceId: source.performanceId,
      qualityId: source.qualityId,
      targetValues: { "杆最大拉力kgf": 1 },
    },
    candidates,
  );
  assert.equal(match.projectionId, "projection-b");
  assert.equal(match.matchedStructuralPullKg, 4);
  assert.equal(match.trace.some((entry) => entry.stage === "range"), false);
  assert.equal(match.trace.some((entry) => entry.stage === "affinity"), false);
  assert.equal(match.trace.some((entry) => entry.stage === "attribute_distance"), false);
  assert.ok(match.trace.some((entry) => entry.stage === "stable_id"));
});

test("M-02b 部位严格隔离，模板优先级仅在 derivedPullKg 也相同时决胜", () => {
  const base = matchCandidates(1.5)[0];
  const candidate = (id: string, itemPartId: string, priority: number): ProjectionMatchCandidate => ({
    ...structuredClone(base),
    projection: { ...structuredClone(base.projection), id },
    weightTemplate: { ...structuredClone(base.weightTemplate), id: `template:${id}` },
    itemPartId,
    derivedPullKg: 1.5,
    templatePriority: priority,
  });
  const match = matchNearestProjection({
    itemPartId: "part:rod",
    targetPullKg: 1.5,
    methodId: base.projection.methodId,
    typeId: base.projection.typeId,
    functionId: base.projection.functionId,
  }, [
    candidate("reel-closest", "part:reel", 999),
    candidate("rod-low", "part:rod", 1),
    candidate("rod-high", "part:rod", 2),
  ]);
  assert.equal(match.projectionId, "rod-high");
  assert.equal(match.itemPartId, "part:rod");
  assert.ok(match.trace.some((entry) => entry.stage === "template_priority"));
});

test("M-04 人工 pin 保留选择并进入 Trace", () => {
  const candidates = matchCandidates(1.5);
  const pinnedId = candidates.find(
    (candidate) => candidate.weightTemplate.id === "T05",
  )!.projection.id;
  const source = candidates[0].projection;
  const match = matchNearestProjection(
    {
      itemPartId: "part:rod",
      targetPullKg: 1.5,
      methodId: source.methodId,
      typeId: source.typeId,
      functionId: source.functionId,
      functionIntensity: source.functionIntensity,
      performanceId: source.performanceId,
      qualityId: source.qualityId,
      pinnedProjectionId: pinnedId,
    },
    candidates,
  );
  assert.equal(match.projectionId, pinnedId);
  assert.equal(match.pinnedByUser, true);
  assert.ok(match.trace.some((entry) => entry.stage === "pin"));
});

test("P-01 Series/SKU/Model Patch 固定优先级得到唯一结果", () => {
  const patches: ProjectionPatchRuleSource[] = [
    {
      id: "model",
      scope: "model",
      scopeId: "m",
      reason: "model",
      author: "test",
      baseProjectionId: "p",
      baseRuleSetVersion: "r",
      status: "approved",
      order: 1,
      rules: [],
      operations: [{ op: "add", path: "force", value: 5 }],
    },
    {
      id: "series",
      scope: "series",
      scopeId: "s",
      reason: "series",
      author: "test",
      baseProjectionId: "p",
      baseRuleSetVersion: "r",
      status: "approved",
      order: 1,
      rules: [],
      operations: [{ op: "multiply", path: "force", value: 2 }],
    },
    {
      id: "sku",
      scope: "sku",
      scopeId: "k",
      reason: "sku",
      author: "test",
      baseProjectionId: "p",
      baseRuleSetVersion: "r",
      status: "approved",
      order: 1,
      rules: [],
      operations: [{ op: "set", path: "force", value: 30 }],
    },
  ];
  const result = applyLayeredPatches({ force: 10 }, patches, {
    expectedProjectionId: "p",
    expectedRuleSetVersion: "r",
  });
  assert.equal(result.value.force, 35);
  assert.deepEqual(result.appliedPatchIds, ["series", "sku", "model"]);
});

test("P-01b 不同实体 scopeId 的同路径 set 不会误报冲突", () => {
  const patches: ProjectionPatchRuleSource[] = ["sku:a", "sku:b"].map((scopeId, index) => ({
    id: `patch:${index}`,
    scope: "sku",
    scopeId,
    reason: "批量不同实体",
    author: "test",
    baseProjectionId: "p",
    baseRuleSetVersion: "r",
    status: "approved",
    order: index,
    rules: [],
    operations: [{ op: "set", path: "force", value: 20 + index }],
  }));
  const result = applyLayeredPatches({ force: 10 }, patches);
  assert.equal(result.issues.some((issue) => issue.code === "PATCH_SET_CONFLICT"), false);
  const sameScope = applyLayeredPatches({ force: 10 }, [
    patches[0],
    { ...patches[1], id: "patch:same", scopeId: "sku:a" },
  ]);
  assert.equal(sameScope.issues.some((issue) => issue.code === "PATCH_SET_CONFLICT"), true);
});

test("P-01c clear 恢复同层继承值并与 set 冲突，运行时拒绝旧操作", () => {
  const common={
    scope:"model" as const,scopeId:"model:a",reason:"test",author:"test",
    baseProjectionId:"p",baseRuleSetVersion:"r",status:"approved" as const,rules:[],
  };
  const result=applyLayeredPatches({force:10},[
    {...common,id:"patch:add",order:0,operations:[{op:"add" as const,path:"force",value:5}]},
    {...common,id:"patch:clear",order:1,operations:[{op:"clear" as const,path:"force"}]},
    {...common,id:"patch:set",order:2,operations:[{op:"set" as const,path:"force",value:20}]},
    {...common,id:"patch:legacy",order:3,operations:[{op:"remove",path:"force"}]},
  ] as never);
  assert.equal(result.value.force,20);
  assert.ok(result.trace.some((entry)=>entry.patchId==="patch:clear"&&entry.after===10));
  assert.ok(result.issues.some((issue)=>issue.code==="PATCH_SET_CLEAR_CONFLICT"));
  assert.ok(result.issues.some((issue)=>issue.patchId==="patch:legacy"&&issue.code==="PATCH_OPERATION_UNSUPPORTED"));
});

test("P-02/P-03 上游更新生成 rebase 差异，set 基础变化要求复核", () => {
  const patches: ProjectionPatchRuleSource[] = [
    {
      id: "add",
      scope: "series",
      scopeId: "s",
      reason: "可重放",
      author: "test",
      baseProjectionId: "old",
      baseRuleSetVersion: "r1",
      status: "approved",
      order: 1,
      rules: [],
      operations: [{ op: "add", path: "force", value: 2 }],
    },
    {
      id: "set",
      scope: "model",
      scopeId: "m",
      reason: "需复核",
      author: "test",
      baseProjectionId: "old",
      baseRuleSetVersion: "r1",
      status: "approved",
      order: 1,
      rules: [],
      operations: [{ op: "set", path: "weight", value: 90 }],
    },
  ];
  const preview = previewPatchRebase({
    oldBase: { force: 10, weight: 100 },
    newBase: { force: 12, weight: 110 },
    patches,
    oldProjectionId: "old",
    newProjectionId: "new",
    oldRuleSetVersion: "r1",
    newRuleSetVersion: "r2",
  });
  assert.equal(preview.oldResult.force, 12);
  assert.equal(preview.newResult.force, 14);
  assert.equal(preview.newResult.weight, 90);
  assert.equal(preview.requiresReview, true);
  assert.ok(preview.differences.some((difference) => difference.path === "force"));
  assert.ok(
    preview.issues.some(
      (issue) => issue.path === "weight" && issue.requiresReview,
    ),
  );
});

test("C-01 硬 deny 不能被高 Affinity 覆盖", () => {
  const hardRules: CompatibilityRule[] = [
    {
      id: "deny",
      axis: "method_type",
      effect: "deny",
      selector: { methodId: "method:lure" },
      requirements: [],
      priority: 1,
      ruleSetVersion: "r",
      reason: "硬拒绝",
      suggestion: "调整组合",
      enabled: true,
    },
  ];
  const affinityRules: AffinityRule[] = [
    {
      id: "high",
      axis: "method_type",
      selector: { methodId: "method:lure" },
      score: 3,
      priority: 1,
      ruleSetVersion: "r",
      reason: "强协同",
      enabled: true,
    },
  ];
  const hard = evaluateHardCompatibility(context(1.5), hardRules);
  const affinity = evaluateAffinity(
    context(1.5),
    affinityRules,
    defaultAffinityAxisWeights,
  );
  assert.equal(hard.allowed, false);
  assert.ok(affinity.score > 0);
  const candidates = matchCandidates(1.5).map((candidate) => ({
    ...candidate,
    compatibility: hard,
    affinity,
  }));
  assert.throws(
    () =>
      matchNearestProjection(
        {
          itemPartId: "part:rod",
          targetPullKg: 1.5,
          methodId: candidates[0].projection.methodId,
          typeId: candidates[0].projection.typeId,
          functionId: candidates[0].projection.functionId,
          functionIntensity: candidates[0].projection.functionIntensity,
          performanceId: candidates[0].projection.performanceId,
          qualityId: candidates[0].projection.qualityId,
        },
        candidates,
      ),
    /硬兼容/,
  );
});

test("C-02 硬兼容但低 Affinity 仍允许生成", () => {
  const lowRule: AffinityRule = {
    id: "low",
    axis: "method_type",
    selector: { methodId: "method:lure" },
    score: -3,
    priority: 1,
    ruleSetVersion: "r",
    reason: "允许但强冲突",
    enabled: true,
  };
  const hard = evaluateHardCompatibility(context(1.5), []);
  const affinity = evaluateAffinity(
    context(1.5),
    [lowRule],
    defaultAffinityAxisWeights,
  );
  assert.equal(hard.allowed, true);
  assert.ok(affinity.score < 0);
});

test("C-03 同一 Affinity 轴只采用最具体规则", () => {
  const result = evaluateAffinity(
    context(1.5),
    [
      {
        id: "broad",
        axis: "type_weight",
        selector: { typeId: "type:structure:水滴+枪柄" },
        score: -1,
        priority: 100,
        ruleSetVersion: "r",
        reason: "宽泛",
        enabled: true,
      },
      {
        id: "specific",
        axis: "type_weight",
        selector: {
          typeId: "type:structure:水滴+枪柄",
          minPullKg: 1,
          maxPullKg: 2,
        },
        score: 3,
        priority: 1,
        ruleSetVersion: "r",
        reason: "具体",
        enabled: true,
      },
    ],
    defaultAffinityAxisWeights,
  );
  const axis = result.contributions.find(
    (contribution) => contribution.axis === "type_weight",
  )!;
  assert.equal(axis.ruleId, "specific");
  assert.equal(axis.score, 3);
});

test("S-01 SKU 类型偏离 Series 时阻断", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const sku = state.skuDrawers[0];
  const projection = state.derivedProjections.find(
    (candidate) => candidate.id === sku.projectionMatch.projectionId,
  )!;
  const invalidProjection = {
    ...projection,
    typeId: "type:invalid",
  };
  const issues = validateSeriesInvariants({
    series,
    skus: [sku],
    models: state.purchasableModels.filter((model) => model.skuId === sku.id),
    projections: state.derivedProjections.map((candidate) =>
      candidate.id === projection.id ? invalidProjection : candidate,
    ),
  });
  assert.ok(issues.some((issue) => issue.code === "SERIES_TYPE_MISMATCH"));
});

test("S-02 旧属性偏移阈值不再参与运行时校验", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const sku = state.skuDrawers[0];
  const model = state.purchasableModels.find((item) => item.skuId === sku.id)!;
  const projection = state.derivedProjections.find(
    (candidate) => candidate.id === sku.projectionMatch.projectionId,
  )!;
  const issues = validateSeriesInvariants({
    series,
    skus: [sku],
    models: [model],
    projections: state.derivedProjections,
    resolvedPanels: [
      {
        modelId: model.id,
        skuId: sku.id,
        values: { force: 150 },
      },
    ],
    neutralValuesBySkuId: { [sku.id]: { force: 100 } },
    patchOffsetLimits: { warning: 0.2, error: 0.4 },
  });
  assert.equal(issues.some((issue) => issue.code.startsWith("PATCH_OFFSET_")), false);
  assert.equal(projection.typeId, series.typeId);
});

test("A-01 Technology 成员与直接词条重复时只计算一次", () => {
  const state = createSeedState();
  const technology = state.technologies[0];
  const memberId = technology.affixIds[0];
  const technologyOnly = resolveAffixConfiguration(
    state.v3Affixes,
    state.technologies,
    [],
    [technology.id],
  );
  const duplicated = resolveAffixConfiguration(
    state.v3Affixes,
    state.technologies,
    [memberId],
    [technology.id],
  );
  assert.equal(duplicated.affixes.length, technologyOnly.affixes.length);
  assert.ok(duplicated.warnings.some((warning) => warning.includes("去重")));
  const base = state.templates[3].values;
  assert.deepEqual(
    aggregateAffixPanel(base, duplicated, state.ruleSettings.reductionStackingMode, "quality_a_purple").values,
    aggregateAffixPanel(base, technologyOnly, state.ruleSettings.reductionStackingMode, "quality_a_purple").values,
  );
});

test("A-02 被动词条参与品质评分但不改变面板", () => {
  const state = createSeedState();
  const passive = state.v3Affixes.filter((affix) => affix.category === "passive");
  const configuration = resolveAffixConfiguration(
    state.v3Affixes,
    state.technologies,
    passive.map((affix) => affix.id),
    [],
  );
  const base = { force: 10 };
  const aggregated = aggregateAffixPanel(
    base,
    configuration,
    state.ruleSettings.reductionStackingMode,
    "quality_a_purple",
  );
  assert.deepEqual(aggregated.values, base);
  assert.ok(aggregated.quality.passiveAffixScore > 0);
  assert.ok(aggregated.passivePayloads.length > 0);
});

function syntheticAffix(id: string, score: number): V3Affix {
  return {
    id,
    version: 1,
    name: id,
    category: "attribute",
    itemPartId: "part:rod",
    generationPolicy: "normal",
    rarity: "common",
    valueScore: score,
    tags: [],
    attributeEffects: [],
    description: "",
    enabled: true,
  };
}

test("Q-01 品质由设计人员显式选择，不按词条分数自动改变", () => {
  const evaluate = (score: number, qualityId: QualityProfileId) =>
    evaluateAffixQuality(
      resolveAffixConfiguration([syntheticAffix("a", score)], [], ["a"], []),
      qualityId,
    );
  assert.deepEqual(
    [evaluate(0, "quality_c_green").letter, evaluate(5, "quality_b_blue").letter, evaluate(20, "quality_a_purple").letter, evaluate(35, "quality_s_orange").letter],
    ["C", "B", "A", "S"],
  );
  assert.deepEqual(
    [evaluate(100, "quality_c_green").colorName, evaluate(0, "quality_b_blue").colorName, evaluate(0, "quality_a_purple").colorName, evaluate(0, "quality_s_orange").colorName],
    ["绿", "蓝", "紫", "橙"],
  );
});

test("F-01 上游变化不修改旧 Snapshot，只创建升级候选", () => {
  const state = createSeedState();
  const snapshot = structuredClone(state.configurationSnapshots[0]);
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  const projection = state.derivedProjections.find((item) => item.id.endsWith("-next"))!;
  const before = JSON.stringify(snapshot);
  const upgrade = createUpgradeCandidate({
    id: "upgrade:test",
    modelId: snapshot.modelId,
    currentSnapshot: snapshot,
    proposedProjection: projection,
    proposedValues: projection.values,
    patches: state.projectionPatches.filter((patch) =>
      snapshot.patchSetHash ? patch.status === "approved" : false,
    ),
    validationReport: [],
    createdAt: "2026-07-20T01:00:00.000Z",
  });
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(upgrade.fromSnapshotId, snapshot.id);
  assert.equal(upgrade.status, "pending");
});

test("F-02 新 Snapshot 缺正式品质评估或正式定价策略时阻断，历史快照保持有效", () => {
  const state = createSeedState();
  const existing = state.configurationSnapshots[0];
  const model = state.purchasableModels.find((entry) => entry.id === existing.modelId)!;
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const projection = state.derivedProjections.find((entry) => entry.id === existing.projectionId)!;
  assert.equal(verifySnapshotIntegrity(existing), true);
  assert.throws(() => publishConfigurationSnapshot({
    publicationMode: "new_formal",
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
    warningConfirmations: {},
    publishedBy: "tester",
    publishedAt: "2026-07-22T00:00:00.000Z",
  }), /正式品质评分结果.*已发布 PricingPolicyVersion|新 Snapshot 必须绑定/);
  assert.equal(verifySnapshotIntegrity(existing), true);
});

test("D-01 v1 状态顺序迁移到当前版本，两次迁移无额外变化", () => {
  const once = migrateWorkspaceState(workspaceV1);
  const twice = migrateWorkspaceState(once);
  assert.equal(once.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.deepEqual(once.fiveAxisViewDefinitions, []);
  assert.deepEqual(once.fiveAxisVertexSets, []);
  assert.equal(
    once.workspacePolicies.filter((policy) => policy.policyType === "patchOffsetPolicy").length,
    1,
  );
  assert.deepEqual(once.aiAssessments, []);
  assert.deepEqual(once.exportTargetProfiles, []);
  assert.deepEqual(once.identityAuditLog, []);
  assert.deepEqual(once.commandIdempotencyRecords, []);
  assert.deepEqual(twice, once);
  assert.equal(once.candidates[0].overrides["杆最大拉力kgf"], 12);
});

test("WP8 全链路种子包含 Series→SKU→Model→Snapshot→Upgrade", () => {
  const state = createSeedState();
  assert.equal(state.collections.length, 1);
  assert.equal(state.seriesDefinitions.length, 1);
  assert.equal(state.skuDrawers.length, 2);
  assert.equal(state.purchasableModels.length, 4);
  assert.equal(
    state.purchasableModels.every((model) => Boolean(model.fishWeightGradeId)),
    true,
    "每个 Model 必须显式携带五维计算所需的鱼重档位，界面不得从 SKU 拉力猜测",
  );
  assert.deepEqual(
    new Set(state.purchasableModels.map((model) => model.fishWeightGradeId)),
    new Set(["fish-weight-grade:1.5kg", "fish-weight-grade:1.8kg"]),
  );
  assert.equal(state.configurationSnapshots.length, 1);
  assert.equal(
    state.configurationSnapshots[0].modelFinalPullKg,
    state.configurationSnapshots[0].finalPanelValues["杆最大拉力kgf"],
  );
  assert.equal(
    Object.hasOwn(state.configurationSnapshots[0].projectionMatch as unknown as object, "targetWeightKg"),
    false,
  );
  assert.equal(state.fiveAxisViewDefinitions.length, 1);
  assert.equal(state.fiveAxisVertexSets.length, 1);
  assert.equal(state.configurationSnapshots[0].fiveAxisPreview?.metrics.length, 5);
  assert.equal(state.upgradeCandidates.length, 1);
  assert.equal(state.exportTargetProfiles.length, 2);
  assert.equal(
    state.exportTargetProfiles.every((profile) => profile.enabled === false),
    true,
  );
  const aiPolicy = state.workspacePolicies.find(
    (policy) => policy.policyType === "aiServicePolicy",
  );
  assert.equal(aiPolicy?.value.enabled, false);
  const published = state.purchasableModels.find(
    (model) => model.status === "published",
  )!;
  const purchase = createPurchaseReference(published);
  assert.equal(purchase.modelId, published.id);
  assert.equal(purchase.configurationSnapshotId, published.configurationSnapshotId);
  assert.equal(
    state.skuDrawers.find((sku) => sku.id === published.skuId)?.modelIds.includes(
      published.id,
    ),
    true,
  );
});
