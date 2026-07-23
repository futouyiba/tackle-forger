import { aggregateAffixPanel, resolveAffixConfiguration } from "./affix-engine";
import {
  defaultAffinityAxisWeights,
  evaluateAffinity,
  evaluateHardCompatibility,
  evaluateStructuralHardCompatibility,
  structuralCompatibilityContext,
} from "./compatibility";
import {
  calculateModelFiveAxisPreview,
  createFiveAxisVertexSet,
} from "./five-axis";
import { applyLayeredPatches } from "./patch-engine";
import { importLegacyPatchesToLedger } from "./patch-ledger";
import {
  matchNearestProjection,
  structuralPullFromProjection,
} from "./projection-matcher";
import { validateSeriesInvariants } from "./product-model";
import {
  createRuleChangeProposal,
  createUpgradeCandidate,
  publishConfigurationSnapshot,
} from "./publishing";
import { deriveProjection, deterministicHash } from "./rule-kernel";
import { validationIssueLevel } from "./validation-issues";
import type {
  AffinityRule,
  CandidateSearchRecipe,
  CompatibilityContext,
  CompatibilityRule,
  FiveAxisEntityInput,
  FiveAxisViewDefinition,
  ModelComponentSelection,
  ProjectionPatchRuleSource,
  PurchasableModel,
  QualityProfileId,
  RuleSetVersion,
  SeriesDefinition,
  SkuDrawer,
  ValidationIssue,
  WorkspaceState,
} from "./types";

const CREATED_AT = "2026-07-20T00:00:00.000Z";

function componentSelections(
  values: Record<string, number | string>,
  suffix: string,
): ModelComponentSelection[] {
  const pick = (keys: string[]) =>
    Object.fromEntries(
      keys.flatMap((key) => (values[key] === undefined ? [] : [[key, values[key]]])),
    );
  const normalizedFiveAxisSources: Array<[string, string[]]> = [
    ["five_axis_pull", ["杆最大拉力kgf"]],
    ["five_axis_endurance", ["杆耐久度", "杆最大耐力"]],
    ["five_axis_cast", ["杆抛投基础", "杆饵重上限g", "饵重上限g"]],
    ["five_axis_lightness", ["杆自重g"]],
    ["five_axis_reach", ["杆长m", "长度"]],
  ];
  const normalizedFiveAxisValues = Object.fromEntries(normalizedFiveAxisSources.flatMap(([targetKey, sourceKeys]) => {
    const value = sourceKeys
      .map((sourceKey) => values[sourceKey])
      .find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    return typeof value === "number" ? [[targetKey, value]] : [];
  }));
  return [
    {
      itemPartId: "part:rod",
      componentId: "component:rod:" + suffix,
      name: "青芦高强竿体 " + suffix,
      values: {
        ...pick([
          "杆最大拉力kgf",
          "杆自重g",
          "杆长m",
          "长度",
          "饵重上限g",
          "杆最大耐力",
          "杆耐久度",
          "杆抛投基础",
          "杆能量消耗系数",
          "杆感度配置",
          "杆饵重下限g",
          "杆饵重上限g",
        ]),
        ...normalizedFiveAxisValues,
      },
    },
    {
      itemPartId: "part:reel",
      componentId: "component:reel:" + suffix,
      name: "青芦强化轮组 " + suffix,
      values: pick([
        "轮最大拉力kgf",
        "轮自重g",
        "传动比",
        "轮最大耐力",
      ]),
    },
    {
      itemPartId: "part:line",
      componentId: "component:line:" + suffix,
      name: "青芦耐磨线组 " + suffix,
      values: pick(["线最大拉力kgf", "PE线号", "线张力指数"]),
    },
  ];
}

function sampleCompatibilityRules(ruleSetVersion: string): CompatibilityRule[] {
  return [
    {
      id: "compat-lure-baitcast-allow",
      axis: "method_type",
      effect: "allow",
      selector: {
        methodId: "method:lure",
        typeId: "type:structure:水滴+枪柄",
      },
      requirements: [],
      priority: 100,
      ruleSetVersion,
      reason: "路亚与水滴枪柄结构明确兼容。",
      suggestion: "",
      enabled: true,
    },
    {
      id: "compat-baitcast-ultralight-deny",
      axis: "type_weight",
      effect: "deny",
      selector: {
        typeId: "type:structure:水滴+枪柄",
        maxPullKg: 0.5,
      },
      requirements: [],
      priority: 80,
      ruleSetVersion,
      reason: "当前水滴枪柄组件库不支持 0.5kg 以下微物规格。",
      suggestion: "改用纺车直柄，或提高目标拉力。",
      enabled: true,
    },
    {
      id: "compat-obstacle-core-require",
      axis: "model_component",
      effect: "require",
      selector: {
        functionId: "function:障碍强攻",
        tags: ["model_review"],
      },
      requirements: [
        {
          kind: "tag",
          key: "reinforced_core",
          message: "障碍强攻 Model 必须带有 reinforced_core 标记。",
        },
      ],
      priority: 90,
      ruleSetVersion,
      reason: "障碍强攻需要强化芯材闭环。",
      suggestion: "添加高韧芯材或选择强化组件。",
      enabled: true,
    },
  ];
}

function sampleAffinityRules(ruleSetVersion: string): AffinityRule[] {
  return [
    {
      id: "affinity-lure-baitcast",
      axis: "method_type",
      selector: {
        methodId: "method:lure",
        typeId: "type:structure:水滴+枪柄",
      },
      score: 2,
      priority: 50,
      ruleSetVersion,
      reason: "水滴枪柄适合路亚精准操控。",
      enabled: true,
    },
    {
      id: "affinity-baitcast-midweight",
      axis: "type_weight",
      selector: {
        typeId: "type:structure:水滴+枪柄",
        minPullKg: 1,
        maxPullKg: 4,
      },
      score: 3,
      priority: 60,
      ruleSetVersion,
      reason: "1–4kg 重量段与当前水滴轮规格强协同。",
      enabled: true,
    },
    {
      id: "affinity-obstacle-high-strength",
      axis: "function_performance",
      selector: {
        functionId: "function:障碍强攻",
      },
      score: 2,
      priority: 50,
      ruleSetVersion,
      reason: "障碍强攻与高强工艺方向明显适配。",
      enabled: true,
    },
    {
      id: "affinity-series-coherence",
      axis: "series_coherence",
      selector: {
        tags: ["qinglu_obstacle"],
      },
      score: 3,
      priority: 100,
      ruleSetVersion,
      reason: "保持青芦障碍系列的核心方向与词条身份。",
      enabled: true,
    },
  ];
}

function baseContext(targetPullKg: number): CompatibilityContext {
  return {
    methodId: "method:lure",
    typeId: "type:structure:水滴+枪柄",
    targetPullKg,
    functionId: "function:障碍强攻",
    functionIntensity: 2,
    performanceId: undefined,
    qualityId: "quality_a_purple",
    componentIds: [],
    tags: ["qinglu_obstacle"],
  };
}

function modelPatch(
  id: string,
  scope: "series" | "sku" | "model",
  scopeId: string,
  baseProjectionId: string,
  ruleSetVersion: string,
  order: number,
  path: string,
  op: "add" | "multiply",
  value: number,
  reason: string,
): ProjectionPatchRuleSource {
  return {
    id,
    scope,
    scopeId,
    reason,
    author: "seed-designer",
    createdAt: CREATED_AT,
    baseProjectionId,
    baseRuleSetVersion: ruleSetVersion,
    status: "approved",
    order,
    rules: [
      {
        id: id + "-legacy-rule",
        parameterKey: path,
        operation: op,
        value,
      },
    ],
    operations: [
      op === "add"
        ? { op: "add", path, value }
        : { op: "multiply", path, value },
    ],
  };
}

export function hydrateV3Seed(input: WorkspaceState): WorkspaceState {
  if (input.collections.length || input.seriesDefinitions.length) return input;
  const state = structuredClone(input);
  const method = state.methodProfiles.find((profile) => profile.id === "method:lure");
  const type = state.itemTypeProfiles.find(
    (profile) => profile.id === "type:structure:水滴+枪柄",
  );
  const fn = state.functionProfiles.find(
    (profile) => profile.id === "function:障碍强攻",
  );
  const performance =
    state.performanceProfiles.find((profile) => profile.name.includes("高强")) ??
    state.performanceProfiles[0];
  const quality = state.qualityProfiles.find(
    (profile) => profile.id === "quality_a_purple",
  );
  const ruleSet = state.ruleSetVersions.find(
    (version) => version.status === "published",
  );
  const templates = ["T03", "T04", "T05"]
    .map((id) => state.templates.find((template) => template.id === id))
    .filter((template): template is NonNullable<typeof template> => Boolean(template));
  if (!method || !type || !fn || !quality || !ruleSet || templates.length < 3) {
    return state;
  }

  const compatibilityRules = sampleCompatibilityRules(ruleSet.id);
  const affinityRules = sampleAffinityRules(ruleSet.id);
  const projections = templates.map((weightTemplate) =>
    deriveProjection({
      weightTemplate,
      methodProfile: method,
      itemTypeProfile: type,
      functionProfile: fn,
      functionIntensity: 2,
      performanceProfile: performance,
      qualityProfile: quality,
      ruleSet,
    }),
  );
  const candidatesFor = (targetPullKg: number) =>
    projections.map((projection) => {
      const context = {
        ...baseContext(targetPullKg),
        performanceId: performance?.id,
      };
      return {
        projection,
        weightTemplate: templates.find(
          (template) => template.id === projection.weightTemplateId,
        ) as (typeof templates)[number],
        itemPartId: "part:rod",
        derivedPullKg: structuralPullFromProjection(projection, "part:rod") ??
          (templates.find(
            (template) => template.id === projection.weightTemplateId,
          ) as (typeof templates)[number]).nominalFishKg,
        compatibility: evaluateStructuralHardCompatibility(structuralCompatibilityContext({ methodId: method.id, typeId: type.id, functionId: fn.id, itemPartId: "part:rod" }), compatibilityRules),
        affinity: evaluateAffinity(
          context,
          affinityRules,
          defaultAffinityAxisWeights,
        ),
      };
    });
  const match15 = matchNearestProjection(
    {
      itemPartId: "part:rod",
      targetPullKg: 1.5,
      methodId: method.id,
      typeId: type.id,
      functionId: fn.id,
      functionIntensity: 2,
      performanceId: performance?.id,
      qualityId: quality.id,
    },
    candidatesFor(1.5),
    state.parameters,
  );
  const match18 = matchNearestProjection(
    {
      itemPartId: "part:rod",
      targetPullKg: 1.8,
      methodId: method.id,
      typeId: type.id,
      functionId: fn.id,
      functionIntensity: 2,
      performanceId: performance?.id,
      qualityId: quality.id,
    },
    candidatesFor(1.8),
    state.parameters,
  );

  const seriesId = "series:qinglu-obstacle";
  const sku15Id = "sku:qinglu-obstacle-1.5";
  const sku18Id = "sku:qinglu-obstacle-1.8";
  const modelIds = {
    fast15: "model:qinglu-1.5-fast",
    long15: "model:qinglu-1.5-long",
    fast18: "model:qinglu-1.8-fast",
    long18: "model:qinglu-1.8-long",
  };
  const series: SeriesDefinition = {
    id: seriesId,
    collectionId: "collection:qinglu",
    revision: 1,
    name: "青芦·障碍",
    concept: "中轻量障碍区强攻，保持拉力、耐力与可控代价的清晰方向。",
    fishingMethodId: method.id,
    typeId: type.id,
    itemPartId: "part:rod",
    qualityId: "quality_a_purple",
    coreFunctionId: fn.id,
    functionIntensityPolicy: { mode: "fixed", intensity: 2 },
    performanceProfileId: performance?.id,
    performanceIntensityPolicy: performance?.legacyIntensityLabel
      ? { mode: "legacy_label", label: performance.legacyIntensityLabel }
      : undefined,
    coreAffixIds: ["v3:affix-impact"],
    secondaryAffixPoolIds: [
      "v3:affix-core",
      "v3:affix-light",
      "v3:affix-thermal",
    ],
    forbiddenAffixIds: ["v3:affix-distance"],
    planningPullRange: { minKgf: 1.5, maxKgf: 1.8 },
    targetPullSpecifications: [
      { targetPullKgf: 1.5, skuId: sku15Id },
      { targetPullKgf: 1.8, skuId: sku18Id },
    ],
    signature: [
      {
        parameterGroup: "杆最大拉力kgf",
        expectedDirection: "positive",
        importance: 1,
        tolerance: 0.02,
      },
      {
        parameterGroup: "杆自重g",
        expectedDirection: "positive",
        importance: 0.6,
        tolerance: 0.04,
      },
    ],
    patchIds: ["patch:series-qinglu-force"],
    skuIds: [sku15Id, sku18Id],
    status: "approved",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const sku15: SkuDrawer = {
    id: sku15Id,
    revision: 1,
    seriesId,
    targetPullKg: 1.5,
    projectionMatch: match15,
    patchIds: ["patch:sku-15-force"],
    modelIds: [modelIds.fast15, modelIds.long15],
    defaultModelId: modelIds.fast15,
    displayOrder: 1,
    validationSummary: [],
    status: "approved",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const sku18: SkuDrawer = {
    ...sku15,
    id: sku18Id,
    targetPullKg: 1.8,
    projectionMatch: match18,
    patchIds: ["patch:sku-18-force"],
    modelIds: [modelIds.fast18, modelIds.long18],
    defaultModelId: modelIds.fast18,
    displayOrder: 2,
  };

  const baseProjection = projections.find(
    (projection) => projection.id === match15.projectionId,
  ) as (typeof projections)[number];
  const patches = [
    modelPatch(
      "patch:series-qinglu-force",
      "series",
      seriesId,
      baseProjection.id,
      ruleSet.id,
      1,
      "杆最大拉力kgf",
      "multiply",
      1.03,
      "系列核心强攻方向：拉力小幅上调。",
    ),
    modelPatch(
      "patch:sku-15-force",
      "sku",
      sku15Id,
      baseProjection.id,
      ruleSet.id,
      1,
      "杆最大拉力kgf",
      "add",
      0.2,
      "1.5kg 规格精调。",
    ),
    modelPatch(
      "patch:sku-18-force",
      "sku",
      sku18Id,
      baseProjection.id,
      ruleSet.id,
      1,
      "杆最大拉力kgf",
      "add",
      0.4,
      "1.8kg 规格精调。",
    ),
    modelPatch(
      "patch:model-long-weight",
      "model",
      modelIds.long15,
      baseProjection.id,
      ruleSet.id,
      1,
      "杆自重g",
      "multiply",
      1.04,
      "长竿版本以少量自重换取操作半径。",
    ),
  ];

  const seedPatchLedger = importLegacyPatchesToLedger(state.patchLedger, patches);
  const directAttributeIds = ["v3:affix-light"];
  const passiveIds = [
    "v3:affix-impact",
    "v3:affix-core",
    "v3:affix-thermal",
  ];
  const technologyIds = state.technologies.length
    ? [state.technologies[0].id]
    : [];
  const buildModel = (
    id: string,
    skuId: string,
    name: string,
    action: string,
    lengthM: number,
    extraPatchIds: string[],
  ): { model: PurchasableModel; values: Record<string, number | string> } => {
    const sku = skuId === sku15Id ? sku15 : sku18;
    const projection = projections.find(
      (candidate) => candidate.id === sku.projectionMatch.projectionId,
    ) as (typeof projections)[number];
    const configuration = resolveAffixConfiguration(
      state.v3Affixes,
      state.technologies,
      [...directAttributeIds, ...passiveIds],
      technologyIds,
    );
    const selectedPatches = patches.filter(
      (patch) =>
        series.patchIds.includes(patch.id) ||
        sku.patchIds.includes(patch.id) ||
        extraPatchIds.includes(patch.id),
    );
    // 权威执行顺序（规范 §21.1）：Series/SKU/Model Patch 先于 Affix/Technology 结算。
    const patched = applyLayeredPatches(projection.values, selectedPatches, {
      expectedProjectionId: projection.id,
      expectedRuleSetVersion: ruleSet.id,
    });
    const aggregate = aggregateAffixPanel(
      patched.value,
      configuration,
      ruleSet.settings.reductionStackingMode,
      quality.id as QualityProfileId,
    );
    const model: PurchasableModel = {
      id,
      revision: 1,
      skuId,
      name,
      action,
      hardness: "MH",
      lengthM,
      fishWeightGradeId: skuId === sku15Id ? "fish-weight-grade:1.5kg" : "fish-weight-grade:1.8kg",
      componentSelections: componentSelections(aggregate.values, id.split(":").pop() ?? id),
      technologyIds,

    attributeAffixIds: directAttributeIds,
      passiveAffixIds: passiveIds,
      patchIds: extraPatchIds,
      price: skuId === sku15Id ? 1280 : 1380,
      unlockPolicyRef: "unlock:angler-level-18",
      commercePolicyRef: "commerce:standard",
      status: "approved",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    return { model, values: aggregate.values };
  };
  const built = [
    buildModel(modelIds.fast15, sku15Id, "1.5F 快调短竿", "Fast", 2.03, []),
    buildModel(
      modelIds.long15,
      sku15Id,
      "1.5L 中快长竿",
      "Moderate Fast",
      2.18,
      ["patch:model-long-weight"],
    ),
    buildModel(modelIds.fast18, sku18Id, "1.8F 快调短竿", "Fast", 2.08, []),
    buildModel(modelIds.long18, sku18Id, "1.8L 中快长竿", "Moderate Fast", 2.24, []),
  ];
  const models = built.map((entry) => entry.model);
  const resolvedPanels = built.map((entry) => ({
    modelId: entry.model.id,
    skuId: entry.model.skuId,
    values: entry.values,
  }));
  const compatibilityByModelId = Object.fromEntries(
    models.map((model) => [
      model.id,
      evaluateHardCompatibility(
        {
          ...baseContext(
            model.skuId === sku15Id ? sku15.targetPullKg : sku18.targetPullKg,
          ),
          performanceId: performance?.id,
          componentIds: model.componentSelections.map(
            (component) => component.componentId,
          ),
          tags: ["qinglu_obstacle", "model_review", "reinforced_core"],
        },
        compatibilityRules,
      ),
    ]),
  );
  const seriesIssues = validateSeriesInvariants({
    series,
    skus: [sku15, sku18],
    models,
    projections,
    resolvedPanels,
    hardCompatibilityByModelId: compatibilityByModelId,
    patchOffsetLimits: state.ruleSettings.patchOffsetLimits,
    neutralValuesBySkuId: {
      [sku15Id]: baseProjection.values,
      [sku18Id]: baseProjection.values,
    },
  });
  sku15.validationSummary = structuredClone(seriesIssues);
  sku18.validationSummary = structuredClone(seriesIssues);

  const publishTarget = built[0];
  const fiveAxisDefinitionContent: Omit<FiveAxisViewDefinition, "definitionHash"> = {
    definitionId: "five-axis:seed-rod-v1",
    version: "1.0.0",
    revision: 1,
    publicationState: "PUBLISHED",
    fiveAxisRuleVersion: "seed-v3-five-axis-1",
    sourceRevision: "seed-v3-2026-07-21",
    axes: [
      ["pull", "拉力强度", "five_axis_pull", "higher_better", "max"],
      ["endurance", "耐久可靠", "five_axis_endurance", "higher_better", "max"],
      ["cast", "抛投能力", "five_axis_cast", "higher_better", "max"],
      ["lightness", "轻量表现", "five_axis_lightness", "lower_better", "min"],
      ["reach", "操作半径", "five_axis_reach", "higher_better", "max"],
    ].map(([axisId, label, sourceParameterKey, direction, vertexSelectorId], index) => ({
      axisId,
      label,
      order: index + 1,
      sourceParameterKeys: [sourceParameterKey],
      applicablePartIds: ["part:rod"],
      direction: direction as "higher_better" | "lower_better",
      transformId: "identity",
      vertexSelectorId: vertexSelectorId as "max" | "min",
      componentAggregationId: "component_min_ratio",
      contextInheritanceId: "single_applicable_source",
      missingPolicy: "ignore_not_applicable",
    })) as FiveAxisViewDefinition["axes"],
    seriesBaselinePolicy: { mode: "explicit_model", required: true },
  };
  const fiveAxisDefinition: FiveAxisViewDefinition = {
    ...fiveAxisDefinitionContent,
    definitionHash: deterministicHash(fiveAxisDefinitionContent),
  };
  const fiveAxisGradeId = "fish-weight-grade:1.5kg";
  const toFiveAxisEntity = (
    component: ModelComponentSelection,
  ): FiveAxisEntityInput => ({
    entityId: component.componentId,
    itemPartId: component.itemPartId,
    label: component.name,
    fishWeightGradeId: fiveAxisGradeId,
    revision: 1,
    values: Object.fromEntries(
      Object.entries(component.values).flatMap(([key, value]) =>
        typeof value === "number" ? [[key, value]] : []),
    ) as Record<string, number>,
  });
  const fiveAxisReferenceComponents = built
    .filter((entry) => entry.model.skuId === sku15Id)
    .flatMap((entry) => entry.model.componentSelections)
    .map(toFiveAxisEntity);
  const fiveAxisVertexSet = createFiveAxisVertexSet({
    definition: fiveAxisDefinition,
    fishWeightGradeId: fiveAxisGradeId,
    referenceComponents: fiveAxisReferenceComponents,
  });
  const fiveAxisPreview = calculateModelFiveAxisPreview({
    modelId: publishTarget.model.id,
    modelRevision: publishTarget.model.revision,
    referenceFishWeightGradeId: fiveAxisGradeId,
    definition: fiveAxisDefinition,
    vertexSet: fiveAxisVertexSet,
    components: publishTarget.model.componentSelections.map(toFiveAxisEntity),
    finalPanelHash: deterministicHash(publishTarget.values),
  });
  const affixConfiguration = resolveAffixConfiguration(
    state.v3Affixes,
    state.technologies,
    [...directAttributeIds, ...passiveIds],
    technologyIds,
  );
  const aggregated = aggregateAffixPanel(
    baseProjection.values,
    affixConfiguration,
    ruleSet.settings.reductionStackingMode,
    quality.id as QualityProfileId,
  );
  const publishCompatibility = compatibilityByModelId[publishTarget.model.id];
  const publishAffinity = evaluateAffinity(
    {
      ...baseContext(1.5),
      performanceId: performance?.id,
      componentIds: publishTarget.model.componentSelections.map(
        (component) => component.componentId,
      ),
      tags: ["qinglu_obstacle", "model_review", "reinforced_core"],
    },
    affinityRules,
    defaultAffinityAxisWeights,
  );
  const publishIssues: ValidationIssue[] = seriesIssues.filter(
    (entry) => validationIssueLevel(entry) !== "error",
  );
  const snapshotPatchIds = new Set([...series.patchIds, ...sku15.patchIds, ...publishTarget.model.patchIds]);
  const snapshot = publishConfigurationSnapshot({
    publicationMode: "historical_import",
    model: publishTarget.model,
    sku: sku15,
    series,
    seriesSkus: [sku15, sku18],
    projection: baseProjection,
    finalPanelValues: publishTarget.values,
    componentSelections: publishTarget.model.componentSelections,
    patches: patches.filter(
      (patch) =>
        series.patchIds.includes(patch.id) || sku15.patchIds.includes(patch.id),
    ),
    patchRevisions: seedPatchLedger.revisions.filter((revision) => snapshotPatchIds.has(revision.patchId)),
    attributeAffixIds: directAttributeIds,
    passiveAffixIds: passiveIds,
    technologyIds,
    passiveAffixPayloads: aggregated.passivePayloads,
    compatibilityReport: publishCompatibility,
    affinityReport: publishAffinity,
    qualityReport: aggregated.quality,
    validationReport: publishIssues,
    warningConfirmations: Object.fromEntries(
      publishIssues
        .filter((entry) => validationIssueLevel(entry) === "warning")
        .map((entry) => [entry.code, "种子数据已由策划确认。"]),
    ),
    fiveAxisPreview,
    publishedBy: "seed-designer",
    publishedAt: CREATED_AT,
  });
  const frozenPatchLedger = {
    ...seedPatchLedger,
    revisions: seedPatchLedger.revisions.map((revision) => snapshotPatchIds.has(revision.patchId)
      ? { ...revision, snapshotRefs: [...new Set([...revision.snapshotRefs, snapshot.id])] }
      : revision),
  };
  const publishedModels = models.map((model) =>
    model.id === publishTarget.model.id
      ? {
          ...model,
          status: "published" as const,
          configurationSnapshotId: snapshot.id,
        }
      : model,
  );

  const nextRuleSet: RuleSetVersion = {
    ...ruleSet,
    id: "ruleset-v3-upgrade-candidate",
    version: ruleSet.version + 1,
    status: "draft",
    createdAt: CREATED_AT,
    publishedAt: undefined,
    notes: "用于展示上游规则变化后的升级候选。",
  };
  const proposedProjection = {
    ...baseProjection,
    id: baseProjection.id + "-next",
    ruleSetVersion: nextRuleSet.id,
    values: {
      ...baseProjection.values,
      "杆最大拉力kgf":
        Number(baseProjection.values["杆最大拉力kgf"] ?? 0) * 1.02,
    },
    sourceHash: deterministicHash({
      source: baseProjection.sourceHash,
      ruleSet: nextRuleSet.id,
    }),
    createdAt: CREATED_AT,
  };
  const upgrade = createUpgradeCandidate({
    id: "upgrade:qinglu-fast15-v2",
    modelId: publishTarget.model.id,
    currentSnapshot: snapshot,
    proposedProjection,
    proposedValues: proposedProjection.values,
    patches: patches.filter(
      (patch) =>
        series.patchIds.includes(patch.id) || sku15.patchIds.includes(patch.id),
    ),
    validationReport: [],
    createdAt: CREATED_AT,
  });
  const proposal = createRuleChangeProposal({
    id: "proposal:qinglu-force-generalization",
    title: "青芦障碍系列拉力修正提案",
    description: "评估是否把跨重量稳定出现的拉力修正晋升为通用规则。",
    patches: patches.filter((patch) => patch.scope !== "model"),
    targetRuleSetVersion: nextRuleSet.id,
    impactEntityIds: [seriesId, sku15Id, sku18Id],
    expectedChanges: upgrade.differences,
    conflicts: [],
    createdBy: "seed-designer",
    createdAt: CREATED_AT,
  });

  return {
    ...state,
    compatibilityRules,
    affinityRules,
    affinityAxisWeights: structuredClone(defaultAffinityAxisWeights),
    derivedProjections: [...projections, proposedProjection],
    projectionMatches: [match15, match18],
    projectionPatches: [...state.projectionPatches, ...patches],
    patchLedger: frozenPatchLedger,
    collections: [
      {
        id: "collection:qinglu",
        name: "青芦",
        brandStory: "面向淡水路亚的清晰功能系列，以可解释的优势与代价建立产品身份。",
        seriesIds: [seriesId],
        notes: "v3 端到端示例产品族。",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
    seriesDefinitions: [series],
    skuDrawers: [sku15, sku18],
    purchasableModels: publishedModels,
    candidateSearchRecipes: state.candidateSearchRecipes.some(
      (recipe) => recipe.id === "candidate-recipe:qinglu-obstacle",
    )
      ? state.candidateSearchRecipes
      : [
          ...state.candidateSearchRecipes,
          {
            id: "candidate-recipe:qinglu-obstacle",
            revision: 1,
            name: "青芦障碍 Model 路线",
            methodIds: [method.id],
            typeIds: [type.id],
            functionIds: [fn.id],
            performanceIds: performance ? [performance.id] : [],
            qualityIds: [quality.id as CandidateSearchRecipe["qualityIds"][number]],
            targetPullRangeKg: { min: 1.5, max: 1.8 },
            maxCandidates: 16,
            notes: "V3 示例链的确定性候选搜索配方，仅用于演示与验收。",
          },
        ],
    configurationSnapshots: [snapshot],
    fiveAxisViewDefinitions: state.fiveAxisViewDefinitions.some(
      (definition) => definition.definitionId === fiveAxisDefinition.definitionId
        && definition.version === fiveAxisDefinition.version,
    )
      ? state.fiveAxisViewDefinitions
      : [...state.fiveAxisViewDefinitions, fiveAxisDefinition],
    fiveAxisVertexSets: state.fiveAxisVertexSets.some(
      (vertexSet) => vertexSet.vertexSetHash === fiveAxisVertexSet.vertexSetHash,
    )
      ? state.fiveAxisVertexSets
      : [...state.fiveAxisVertexSets, fiveAxisVertexSet],
    upgradeCandidates: [upgrade],
    ruleChangeProposals: [proposal],
    governanceAuditLog: [
      {
        id: "audit:snapshot-qinglu-fast15",
        action: "publish_snapshot",
        entityType: "ConfigurationSnapshot",
        entityId: snapshot.id,
        actor: "seed-designer",
        occurredAt: CREATED_AT,
        details: { contentHash: snapshot.contentHash },
      },
      {
        id: "audit:upgrade-qinglu-fast15",
        action: "create_upgrade",
        entityType: "UpgradeCandidate",
        entityId: upgrade.id,
        actor: "seed-designer",
        occurredAt: CREATED_AT,
        details: { fromSnapshotId: snapshot.id },
      },
    ],
    exportTargetProfiles: state.exportTargetProfiles.length
      ? state.exportTargetProfiles
      : [
          {
            profileId: "profile:configs-design-channel",
            label: "数值频道（示例）",
            executorKind: "local_companion",
            projectRoot: "D:\\workOnSsd\\configsDesign",
            relativeWorkbookRoot: "xlsx_channel\\numerical",
            configTomlPath: "config.toml",
            enabled: false,
          },
          {
            profileId: "profile:configs-design-main",
            label: "主配置（示例）",
            executorKind: "local_companion",
            projectRoot: "D:\\workOnSsd\\configsDesign",
            relativeWorkbookRoot: "xlsx",
            configTomlPath: "config.toml",
            enabled: false,
          },
        ],
    workspacePolicies: state.workspacePolicies.some(
      (policy) => policy.policyType === "aiServicePolicy",
    )
      ? state.workspacePolicies
      : [
          ...state.workspacePolicies,
          {
            policyId: "policy:ai-service-disabled",
            policyType: "aiServicePolicy",
            version: "1",
            status: "published",
            value: {
              enabled: false,
              provider: null,
              model: null,
              allowedFieldPaths: [],
              externalDataEgressConfirmed: false,
            },
            createdAt: CREATED_AT,
            publishedAt: CREATED_AT,
          },
        ],
    ruleSetVersions: [...state.ruleSetVersions, nextRuleSet],
  };
}
