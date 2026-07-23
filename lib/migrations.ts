import type {
  AdjustmentRule,
  AffinityRule,
  Affix,
  AttributeAffixEffect,
  CandidateSearchRecipe,
  CompatibilityRule,
  ProjectionMatch,
  RuleChangeProposal,
  Technology,
  UpgradeCandidate,
  V3Affix,
  Candidate,
  FunctionIntensity,
  FunctionProfile,
  ItemPartDefinition,
  ItemTypeProfile,
  MethodProfile,
  MigrationReviewItem,
  ModifierOption,
  ParameterDefinition,
  PerformanceProfile,
  ProjectionPatchRuleSource,
  ProjectionPatchOperation,
  SeriesRecipe,
  QualityProfileId,
  QualityProfile,
  RuleSetVersion,
  WorkspaceRuleSettings,
  WorkspaceState,
} from "./types";
import { defaultAffinityAxisWeights } from "./compatibility";
import { migrateLegacyProductIdentity } from "./legacy-product-migration";
import { CANONICAL_FEISHU_WORKBOOK } from "./feishu-workbook";
import { buildPatchRevision, emptyPatchLedger, migratePatchLedger } from "./patch-ledger";
import { deterministicHash } from "./rule-kernel";

export const CURRENT_WORKSPACE_SCHEMA_VERSION = 17;

const DEFAULT_RULE_SETTINGS: WorkspaceRuleSettings = {
  reductionStackingMode: "diminishing_division",
  patchOffsetLimits: {},
};

const QUALITY_PROFILES: QualityProfile[] = [
  {
    id: "quality_c_green",
    letter: "C",
    colorName: "绿",
    rank: 1,
    rules: [],
    enabled: true,
    notes: "v3 固定品质映射。",
  },
  {
    id: "quality_b_blue",
    letter: "B",
    colorName: "蓝",
    rank: 2,
    rules: [],
    enabled: true,
    notes: "v3 固定品质映射。",
  },
  {
    id: "quality_a_purple",
    letter: "A",
    colorName: "紫",
    rank: 3,
    rules: [],
    enabled: true,
    notes: "v3 固定品质映射。",
  },
  {
    id: "quality_s_orange",
    letter: "S",
    colorName: "橙",
    rank: 4,
    rules: [],
    enabled: true,
    notes: "v3 固定品质映射；历史已发布的“金”文案不回写。",
  },
];

type MutableWorkspace = Record<string, unknown> & Partial<WorkspaceState>;

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function itemPartIdForParameter(parameter: ParameterDefinition): string {
  if (parameter.itemPartId) return parameter.itemPartId;
  if (parameter.itemKind === "reel") return "part:reel";
  if (parameter.itemKind === "line") return "part:line";
  return "part:rod";
}

function benefitModeForParameter(
  parameter: ParameterDefinition,
): NonNullable<ParameterDefinition["benefitMode"]> {
  if (parameter.benefitMode) return parameter.benefitMode;
  if (parameter.key.includes("自重")) return "lower_better";
  if (
    parameter.key.includes("杆长") ||
    parameter.key.includes("传动比") ||
    parameter.key.includes("钓性") ||
    parameter.key.includes("硬度") ||
    parameter.key.includes("浮沉")
  ) {
    return "contextual";
  }
  return "higher_better";
}

function enrichParameters(parameters: ParameterDefinition[]): ParameterDefinition[] {
  return parameters.map((parameter) => ({
    ...parameter,
    itemPartId: itemPartIdForParameter(parameter),
    benefitMode: benefitModeForParameter(parameter),
    balanceWeight: parameter.balanceWeight ?? 1,
    normalizationScale: parameter.normalizationScale ?? 1,
    allowedOperations: parameter.allowedOperations ?? [
      "add",
      "multiply",
      "set",
      "min",
      "max",
      "formula",
    ],
  }));
}

function buildItemParts(parameters: ParameterDefinition[]): ItemPartDefinition[] {
  const definitions: Array<{
    id: string;
    name: string;
    legacyItemKind?: "rod" | "reel" | "line";
    activeInGeneration: boolean;
  }> = [
    { id: "part:rod", name: "竿", legacyItemKind: "rod", activeInGeneration: true },
    { id: "part:reel", name: "轮", legacyItemKind: "reel", activeInGeneration: true },
    { id: "part:line", name: "线", legacyItemKind: "line", activeInGeneration: true },
    { id: "part:hook", name: "钩", activeInGeneration: false },
    { id: "part:float", name: "漂", activeInGeneration: false },
    { id: "part:natural_bait", name: "真饵", activeInGeneration: false },
    { id: "part:artificial_lure", name: "拟饵", activeInGeneration: false },
  ];

  return definitions.map((definition) => ({
    ...definition,
    parameterKeys: parameters
      .filter((parameter) => parameter.itemPartId === definition.id)
      .map((parameter) => parameter.key),
    notes: definition.activeInGeneration
      ? "v3 首版生成流程启用。"
      : "v3 注册表预留；尚未决定开放到当前生成界面。",
  }));
}

function legacyModifiers(
  state: MutableWorkspace,
  dimension: ModifierOption["dimension"],
): ModifierOption[] {
  return arrayOf<ModifierOption>(state.modifiers).filter(
    (modifier) => modifier.dimension === dimension,
  );
}

function buildMethodProfiles(): MethodProfile[] {
  return [
    {
      id: "method:lure",
      name: "路亚",
      rules: [],
      enabled: true,
      notes: "从当前路亚工作区迁移；钓法与类型保持独立规则层。",
    },
  ];
}

function buildItemTypeProfiles(state: MutableWorkspace): ItemTypeProfile[] {
  return legacyModifiers(state, "structure").map((modifier) => ({
    id: "type:" + modifier.id,
    name: modifier.name,
    methodIds: ["method:lure"],
    itemPartIds: ["part:rod", "part:reel", "part:line"],
    rules: structuredClone(modifier.rules),
    enabled: modifier.enabled,
    notes: "由旧 structure Modifier 兼容迁移；原 ID 与规则保留在旧字段。",
  }));
}

function asFunctionIntensity(value: number | string): FunctionIntensity {
  const numeric = Number(value);
  if (numeric === 1 || numeric === 2 || numeric === 3) return numeric;
  return 2;
}

function buildFunctionProfiles(state: MutableWorkspace): FunctionProfile[] {
  const groups = new Map<string, ModifierOption[]>();
  for (const modifier of legacyModifiers(state, "function")) {
    const items = groups.get(modifier.name) ?? [];
    items.push(modifier);
    groups.set(modifier.name, items);
  }

  return Array.from(groups.entries()).map(([name, modifiers]) => ({
    id: "function:" + name,
    name,
    rules: [],
    intensityRules: modifiers
      .map((modifier) => ({
        intensity: asFunctionIntensity(modifier.level),
        rules: structuredClone(modifier.rules),
      }))
      .sort((left, right) => left.intensity - right.intensity),
    enabled: modifiers.some((modifier) => modifier.enabled),
    notes: "由旧 function Modifier 按功能名称聚合；functionIntensity 与品质独立。",
  }));
}

function buildPerformanceProfiles(state: MutableWorkspace): PerformanceProfile[] {
  return legacyModifiers(state, "performance").map((modifier) => ({
    id: "performance:" + modifier.id,
    name: modifier.name,
    rules: structuredClone(modifier.rules),
    legacyIntensityLabel: String(modifier.level),
    enabled: modifier.enabled,
    notes: "由旧 performance Modifier 兼容迁移；OPEN-002 的强度语义尚未固化。",
  }));
}

function buildRuleSetVersion(
  state: MutableWorkspace,
  settings: WorkspaceRuleSettings,
): RuleSetVersion {
  const importedAt =
    typeof state.importedAt === "string"
      ? state.importedAt
      : "1970-01-01T00:00:00.000Z";
  return {
    id: "ruleset-v3-migrated-1",
    version: 1,
    status: "published",
    settings: structuredClone(settings),
    sourceRevisionIds: arrayOf<{ id?: string }>(state.dataSourceImports)
      .map((record) => record.id)
      .filter((id): id is string => Boolean(id)),
    createdAt: importedAt,
    publishedAt: importedAt,
    notes: "由 schema v1 兼容迁移生成；旧规则字段继续保留。",
  };
}

function migrationPatches(
  candidates: Candidate[],
  ruleSet: RuleSetVersion,
): ProjectionPatchRuleSource[] {
  return candidates.flatMap((candidate, candidateIndex) => {
    const entries = Object.entries(candidate.overrides ?? {});
    if (!entries.length) return [];
    return [
      {
        id: "migration-patch-" + candidate.id,
        scope: "model" as const,
        scopeId: candidate.id,
        reason: "由旧 Candidate.overrides 迁移；在 Model 身份迁移完成前保持待审核。",
        author: "workspace-migration",
        baseProjectionId: "legacy-template:" + candidate.templateId,
        baseRuleSetVersion: ruleSet.id,
        status: "draft" as const,
        order: candidateIndex,
        rules: entries.map(([parameterKey, value], ruleIndex): AdjustmentRule => ({
          id: "migration-patch-" + candidate.id + "-" + ruleIndex,
          parameterKey,
          operation: "set",
          value,
          notes: "旧手工覆盖，保留为可追踪 set Patch。",
        })),
      },
    ];
  });
}

function migrationReviewItems(
  candidates: Candidate[],
  qualityBands: Array<{ id?: string; name?: string }>,
): MigrationReviewItem[] {
  const candidateItems = candidates
    .filter((candidate) => Object.keys(candidate.overrides ?? {}).length > 0)
    .map((candidate): MigrationReviewItem => ({
      id: "review-candidate-override-" + candidate.id,
      sourceType: "candidate_override",
      sourceId: candidate.id,
      message: "旧候选覆盖已转为 draft Model Patch；正式 Model 身份建立后需复核作用域。",
      preservedPayload: structuredClone(candidate.overrides),
      status: "pending",
    }));
  const legacyGold = qualityBands.find(
    (band) => band.id === "gold" || band.name === "金",
  );
  const qualityItems: MigrationReviewItem[] = legacyGold
    ? [
        {
          id: "review-quality-gold",
          sourceType: "quality",
          sourceId: legacyGold.id ?? "gold",
          message: "历史“金”品质字段原样保留；v3 新实体使用 S/橙，不回写历史展示。",
          preservedPayload: structuredClone(legacyGold),
          status: "pending",
        },
      ]
    : [];
  return [...candidateItems, ...qualityItems];
}

function mergeById<T extends { id: string }>(existing: T[], added: T[]): T[] {
  const ids = new Set(existing.map((item) => item.id));
  return [...existing, ...added.filter((item) => !ids.has(item.id))];
}

function migrateV1ToV2(input: MutableWorkspace): MutableWorkspace {
  const state = structuredClone(input);
  const parameters = enrichParameters(arrayOf<ParameterDefinition>(state.parameters));
  const settings = state.ruleSettings
    ? structuredClone(state.ruleSettings)
    : structuredClone(DEFAULT_RULE_SETTINGS);
  const existingRuleSets = arrayOf<RuleSetVersion>(state.ruleSetVersions);
  const ruleSet = existingRuleSets[0] ?? buildRuleSetVersion(state, settings);
  const candidates = arrayOf<Candidate>(state.candidates);
  const existingPatches = arrayOf<ProjectionPatchRuleSource>(state.projectionPatches);
  const existingReviews = arrayOf<MigrationReviewItem>(state.migrationReviewItems);

  return {
    ...state,
    schemaVersion: 2,
    parameters,
    ruleSettings: settings,
    ruleSetVersions: existingRuleSets.length ? existingRuleSets : [ruleSet],
    itemParts: arrayOf<ItemPartDefinition>(state.itemParts).length
      ? state.itemParts
      : buildItemParts(parameters),
    methodProfiles: arrayOf<MethodProfile>(state.methodProfiles).length
      ? state.methodProfiles
      : buildMethodProfiles(),
    itemTypeProfiles: arrayOf<ItemTypeProfile>(state.itemTypeProfiles).length
      ? state.itemTypeProfiles
      : buildItemTypeProfiles(state),
    functionProfiles: arrayOf<FunctionProfile>(state.functionProfiles).length
      ? state.functionProfiles
      : buildFunctionProfiles(state),
    performanceProfiles: arrayOf<PerformanceProfile>(state.performanceProfiles).length
      ? state.performanceProfiles
      : buildPerformanceProfiles(state),
    qualityProfiles: arrayOf<QualityProfile>(state.qualityProfiles).length
      ? state.qualityProfiles
      : structuredClone(QUALITY_PROFILES),
    projectionPatches: mergeById(
      existingPatches,
      migrationPatches(candidates, ruleSet),
    ),
    derivedProjections: arrayOf(state.derivedProjections),
    migrationReviewItems: mergeById(
      existingReviews,
      migrationReviewItems(
        candidates,
        arrayOf<{ id?: string; name?: string }>(state.qualityBands),
      ),
    ),
  };
}
function legacyQualityId(value: string): QualityProfileId {
  const normalized = value.toLowerCase();
  if (normalized === "s" || value.includes("橙") || value.includes("金")) {
    return "quality_s_orange";
  }
  if (normalized === "a" || value.includes("紫")) return "quality_a_purple";
  if (normalized === "b" || value.includes("蓝")) return "quality_b_blue";
  return "quality_c_green";
}

function legacyRuleToEffect(
  rule: AdjustmentRule,
  ruleSetVersion: string,
): AttributeAffixEffect | null {
  if (typeof rule.value !== "number") return null;
  if (rule.operation === "add") {
    return {
      id: "v3-effect:" + rule.id,
      parameterKey: rule.parameterKey,
      operation: "flat_bonus",
      value: rule.value,
      unit: "",
      stackingGroup: rule.parameterKey,
      ruleSetVersion,
    };
  }
  if (rule.operation === "multiply") {
    return {
      id: "v3-effect:" + rule.id,
      parameterKey: rule.parameterKey,
      operation: "percent_bonus",
      value: rule.value - 1,
      unit: "%",
      stackingGroup: rule.parameterKey,
      ruleSetVersion,
    };
  }
  return null;
}

function migrateLegacyAffixes(
  state: MutableWorkspace,
  ruleSetVersion: string,
): V3Affix[] {
  return arrayOf<Affix>(state.affixes).map((affix) => {
    const passive = affix.category === "passive";
    return {
      id: "v3:" + affix.id,
      version: 1,
      name: affix.name,
      category: passive ? "passive" as const : "attribute" as const,
      itemPartId:
        affix.itemKinds.length === 1
          ? "part:" + affix.itemKinds[0]
          : "part:rod",
      generationPolicy: "normal" as const,
      rarity:
        affix.rarity === "epic"
          ? "epic" as const
          : affix.rarity === "rare"
            ? "rare" as const
            : "common" as const,
      valueScore: affix.score,
      tags: structuredClone(affix.tags),
      attributeEffects: passive
        ? []
        : affix.rules
            .map((rule) => legacyRuleToEffect(rule, ruleSetVersion))
            .filter((effect): effect is AttributeAffixEffect => Boolean(effect)),
      passivePayload: passive
        ? {
            skillId: "v3:" + affix.id,
            name: affix.name,
            itemPartId:
              affix.itemKinds.length === 1
                ? "part:" + affix.itemKinds[0]
                : "part:rod",
            triggerType: "legacy_description",
            triggerDescription: affix.description,
            effectTarget: "legacy_unspecified",
            effectLogicDescription:
              "历史资料原样保留；本工具不执行或验证该被动技能。",
            exampleParameters: {},
            durationDescription: "待策划补充",
            cooldownDescription: "待策划补充",
            resetDescription: "待策划补充",
            stackingDescription: "待策划补充",
            playerDescription: affix.description,
          }
        : undefined,
      description: affix.description,
      enabled: affix.enabled,
    };
  });
}

function migrateLegacyTechnologies(
  state: MutableWorkspace,
  ruleSetVersion: string,
): { affixes: V3Affix[]; technologies: Technology[] } {
  const modifiers = legacyModifiers(state, "technology");
  const affixes = modifiers.flatMap((modifier) =>
    modifier.rules.flatMap((rule, index): V3Affix[] => {
      const effect = legacyRuleToEffect(rule, ruleSetVersion);
      if (!effect) return [];
      return [
        {
          id: "v3-tech-affix:" + modifier.id + ":" + index,
          version: 1,
          name: modifier.name + " / " + rule.parameterKey,
          category: "attribute",
          itemPartId:
            modifier.itemKinds.length === 1
              ? "part:" + modifier.itemKinds[0]
              : "part:rod",
          generationPolicy: "technology_only",
          rarity: "ultra_rare",
          valueScore: 0,
          tags: ["技术迁移", modifier.name],
          attributeEffects: [effect],
          description: modifier.notes,
          enabled: modifier.enabled,
        },
      ];
    }),
  );
  const technologies = modifiers.map((modifier): Technology => ({
    id: "v3:" + modifier.id,
    version: 1,
    name: modifier.name,
    description: modifier.notes,
    affixIds: affixes
      .filter((affix) => affix.id.startsWith("v3-tech-affix:" + modifier.id + ":"))
      .map((affix) => affix.id),
    compatiblePerformanceProfileIds: [],
    compatibleSeriesIds: [],
    generationPolicy: "technology_only",
    valueScorePolicy: "members_only",
    enabled: modifier.enabled,
  }));
  return { affixes, technologies };
}

function migrateSearchRecipes(state: MutableWorkspace): CandidateSearchRecipe[] {
  return arrayOf<SeriesRecipe>(state.recipes).map((recipe) => ({
    id: "search:" + recipe.id,
    revision: 1,
    name: recipe.name,
    methodIds: ["method:lure"],
    typeIds: structuredClone(recipe.structureIds),
    functionIds: structuredClone(recipe.functionIds),
    performanceIds: structuredClone(recipe.performanceIds),
    qualityIds: [legacyQualityId(recipe.qualityTarget)],
    targetPullRangeKg: {
      min: recipe.fishMinKg,
      max: recipe.fishMaxKg,
    },
    maxCandidates: recipe.maxCandidates,
    sourceLegacyRecipeId: recipe.id,
    notes: "由旧 SeriesRecipe 迁移；仅保留候选搜索能力，不再承担产品身份。",
  }));
}

function migrateV2ToV3(input: MutableWorkspace): MutableWorkspace {
  const state = structuredClone(input);
  const ruleSetVersion =
    arrayOf<RuleSetVersion>(state.ruleSetVersions)[0]?.id ??
    "ruleset-v3-migrated-1";
  const migratedTechnology = migrateLegacyTechnologies(state, ruleSetVersion);
  const existingAffixes = arrayOf<V3Affix>(state.v3Affixes);
  const existingTechnologies = arrayOf<Technology>(state.technologies);
  const migratedPatches = arrayOf<ProjectionPatchRuleSource>(
    state.projectionPatches,
  ).map((patch) => ({
    ...patch,
    createdAt:
      patch.createdAt ??
      (typeof state.importedAt === "string"
        ? state.importedAt
        : "1970-01-01T00:00:00.000Z"),
    operations:
      patch.operations ??
      patch.rules.flatMap((rule): ProjectionPatchOperation[] => {
        if (rule.operation === "set") {
          return [{ op: "set", path: rule.parameterKey, value: rule.value }];
        }
        if (
          (rule.operation === "add" || rule.operation === "multiply") &&
          typeof rule.value === "number"
        ) {
          return [
            rule.operation === "add"
              ? { op: "add", path: rule.parameterKey, value: rule.value }
              : { op: "multiply", path: rule.parameterKey, value: rule.value },
          ];
        }
        return [];
      }),
  }));
  const v3Affixes = existingAffixes.length
    ? existingAffixes
    : [...migrateLegacyAffixes(state, ruleSetVersion), ...migratedTechnology.affixes];
  const technologies = existingTechnologies.length
    ? existingTechnologies
    : migratedTechnology.technologies;
  const legacyProducts = migrateLegacyProductIdentity(
    { ...state, projectionPatches: migratedPatches, v3Affixes, technologies } as Partial<WorkspaceState>,
    ruleSetVersion,
  );

  return {
    ...state,
    schemaVersion: 3,
    projectionPatches: legacyProducts.projectionPatches,
    projectionMatches: arrayOf<ProjectionMatch>(state.projectionMatches),
    compatibilityRules: arrayOf<CompatibilityRule>(state.compatibilityRules),
    affinityRules: arrayOf<AffinityRule>(state.affinityRules),
    affinityAxisWeights: state.affinityAxisWeights
      ? structuredClone(state.affinityAxisWeights)
      : structuredClone(defaultAffinityAxisWeights),
    collections: legacyProducts.collections,
    seriesDefinitions: legacyProducts.seriesDefinitions,
    skuDrawers: legacyProducts.skuDrawers,
    purchasableModels: legacyProducts.purchasableModels,
    candidateSearchRecipes: arrayOf<CandidateSearchRecipe>(
      state.candidateSearchRecipes,
    ).length
      ? state.candidateSearchRecipes
      : migrateSearchRecipes(state),
    v3Affixes,
    technologies,
    configurationSnapshots: legacyProducts.configurationSnapshots,
    upgradeCandidates: arrayOf<UpgradeCandidate>(state.upgradeCandidates),
    ruleChangeProposals: arrayOf<RuleChangeProposal>(state.ruleChangeProposals),
    governanceAuditLog: legacyProducts.governanceAuditLog,
  };
}

function migrateV3ToV4(state: MutableWorkspace): MutableWorkspace {
  return {
    ...state,
    schemaVersion: 4,
    fiveAxisViewDefinitions: arrayOf<
      WorkspaceState["fiveAxisViewDefinitions"][number]
    >(state.fiveAxisViewDefinitions),
    fiveAxisVertexSets: arrayOf<
      WorkspaceState["fiveAxisVertexSets"][number]
    >(state.fiveAxisVertexSets),
    workspacePolicies: arrayOf<
      WorkspaceState["workspacePolicies"][number]
    >(state.workspacePolicies),
    aiAssessments: arrayOf<
      WorkspaceState["aiAssessments"][number]
    >(state.aiAssessments),
    exportTargetProfiles: arrayOf<
      WorkspaceState["exportTargetProfiles"][number]
    >(state.exportTargetProfiles),
    identityAuditLog: arrayOf<
      WorkspaceState["identityAuditLog"][number]
    >(state.identityAuditLog),
    commandIdempotencyRecords: arrayOf<
      WorkspaceState["commandIdempotencyRecords"][number]
    >(state.commandIdempotencyRecords),
  };
}


function emptyRecipePartConstraint(recipe: SeriesRecipe): NonNullable<SeriesRecipe["partConstraints"]>["rod"] {
  return {
    templateIds: [...recipe.templateIds],
    typeIds: [...recipe.structureIds],
    materialIds: [],
    requiredAffixIds: [...recipe.requiredAffixIds],
    optionalAffixPoolIds: [...recipe.optionalAffixPoolIds],
    notes: "由旧版扁平系列配方迁移；请按竿、轮、线复核类型与材质约束。",
  };
}

function migrateV13ToV14(state: MutableWorkspace): MutableWorkspace {
  const recipes = arrayOf<SeriesRecipe>(state.recipes).map((recipe) => {
    if (recipe.partConstraints) return recipe;
    return {
      ...recipe,
      partConstraints: {
        rod: emptyRecipePartConstraint(recipe),
        reel: emptyRecipePartConstraint(recipe),
        line: emptyRecipePartConstraint(recipe),
      },
    };
  });
  return {
    ...state,
    schemaVersion: 14,
    functionProfiles: arrayOf<FunctionProfile>(state.functionProfiles).map((profile) => ({
      ...profile,
      intensityRules: profile.intensityRules.map((rule) => ({ ...rule })),
    })),
    recipes,
  };
}

function migrateV14ToV15(state: MutableWorkspace): MutableWorkspace {
  return {
    ...state,
    schemaVersion: 15,
    fiveAxisViewDefinitions: arrayOf<WorkspaceState["fiveAxisViewDefinitions"][number]>(
      state.fiveAxisViewDefinitions,
    ).map((definition) => {
      if (definition.definitionHash && definition.revision && definition.publicationState) {
        return definition;
      }
      const content = {
        ...definition,
        revision: definition.revision ?? 1,
        publicationState: definition.publicationState ?? "UNPUBLISHED" as const,
      };
      return { ...content, definitionHash: deterministicHash(content) };
    }),
  };
}

function migrateV15ToV16(state: MutableWorkspace): MutableWorkspace {
  return {
    ...state,
    schemaVersion: 16,
  };
}

type LegacyProjectionMatchV16 = Record<string, unknown> & {
  targetPullKg?: number;
  targetWeightKg?: number;
  matchedStructuralPullKg?: number;
  anchorWeightKg?: number;
  pullDistance?: number;
  weightDistance?: number;
};

function resolveLegacyNumber(input: {
  canonical: unknown;
  legacy: unknown;
  label: string;
  positive?: boolean;
  nonNegative?: boolean;
}): number {
  if (
    typeof input.canonical === "number"
    && typeof input.legacy === "number"
    && input.canonical !== input.legacy
  ) {
    throw new Error(`TARGET_PULL_MIGRATION_CONFLICT：${input.label} 的新旧字段不一致。`);
  }
  const value = typeof input.canonical === "number" ? input.canonical : input.legacy;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || (input.positive && value <= 0)
    || (input.nonNegative && value < 0)
  ) {
    throw new Error(`TARGET_PULL_MIGRATION_INVALID：${input.label} 缺少可无损迁移的有限数值。`);
  }
  return value;
}

function migrateLegacyProjectionMatchV16(value: unknown): ProjectionMatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("历史 ProjectionMatch 必须是对象。");
  }
  const source = value as LegacyProjectionMatchV16;
  const targetPullKg = resolveLegacyNumber({
    canonical: source.targetPullKg,
    legacy: source.targetWeightKg,
    label: "ProjectionMatch.targetPullKg",
    positive: true,
  });
  const matchedStructuralPullKg = resolveLegacyNumber({
    canonical: source.matchedStructuralPullKg,
    legacy: source.anchorWeightKg,
    label: "ProjectionMatch.matchedStructuralPullKg",
    positive: true,
  });
  const pullDistance = resolveLegacyNumber({
    canonical: source.pullDistance,
    legacy: source.weightDistance,
    label: "ProjectionMatch.pullDistance",
    nonNegative: true,
  });
  const {
    targetWeightKg: _targetWeightKg,
    anchorWeightKg: _anchorWeightKg,
    weightDistance: _weightDistance,
    ...preserved
  } = source;
  void _targetWeightKg;
  void _anchorWeightKg;
  void _weightDistance;
  return {
    ...preserved,
    targetPullKg,
    matchedStructuralPullKg,
    pullDistance,
  } as ProjectionMatch;
}

function migrationArchiveItem(
  id: string,
  sourceId: string,
  message: string,
  preservedPayload: unknown,
): MigrationReviewItem {
  return {
    id,
    sourceType: "unknown",
    sourceId,
    message,
    preservedPayload: structuredClone(preservedPayload),
    status: "resolved",
  };
}

function migrateV16ToV17(state: MutableWorkspace): MutableWorkspace {
  const migrationReviewItems = arrayOf<MigrationReviewItem>(state.migrationReviewItems)
    .map((item) => structuredClone(item));
  const archive = (item: MigrationReviewItem) => {
    if (!migrationReviewItems.some((existing) => existing.id === item.id)) {
      migrationReviewItems.push(item);
    }
  };
  const skuDrawers: Array<Record<string, unknown>> = arrayOf<Record<string, unknown>>(state.skuDrawers).map((sku) => {
    const legacyTargetPullKg = resolveLegacyNumber({
      canonical: sku.targetPullKg,
      legacy: sku.targetWeightKg,
      label: "SKU " + String(sku.id ?? "unknown") + ".targetPullKg",
      positive: true,
    });
    if (Object.hasOwn(sku, "targetWeightKg")) {
      archive(migrationArchiveItem(
        "target-pull-migration:sku:" + String(sku.id ?? "unknown"),
        String(sku.id ?? "unknown"),
        "AUD-024：历史 SKU 拉力 payload 已归档；活动对象仅保留 targetPullKg。",
        sku,
      ));
    }
    const { targetWeightKg: _targetWeightKg, ...preserved } = sku;
    void _targetWeightKg;
    const projectionMatch = migrateLegacyProjectionMatchV16(sku.projectionMatch);
    if (projectionMatch.targetPullKg !== legacyTargetPullKg) {
      throw new Error("TARGET_PULL_MIGRATION_CONFLICT：SKU 与 ProjectionMatch 目标拉力不一致。");
    }
    return {
      ...preserved,
      targetPullKg: legacyTargetPullKg,
      projectionMatch,
    };
  });
  const projectionMatches = arrayOf<unknown>(state.projectionMatches).map((match, index) => {
    const source = match as Record<string, unknown>;
    if (Object.hasOwn(source, "targetWeightKg")) {
      archive(migrationArchiveItem(
        "target-pull-migration:projection-match:" + index,
        String(source.projectionId ?? index),
        "AUD-024：历史 ProjectionMatch payload 已归档。",
        source,
      ));
    }
    return migrateLegacyProjectionMatchV16(source);
  });
  const migrateSelector = (selector: unknown, sourceId: string) => {
    const source = selector && typeof selector === "object" && !Array.isArray(selector)
      ? selector as Record<string, unknown>
      : {};
    const { minWeightKg, maxWeightKg, ...preserved } = source;
    if (minWeightKg !== undefined || maxWeightKg !== undefined) {
      archive(migrationArchiveItem(
        "target-pull-migration:selector:" + sourceId,
        sourceId,
        "AUD-024：历史拉力范围 selector payload 已归档。",
        source,
      ));
    }
    if (typeof source.minPullKg === "number" && typeof minWeightKg === "number" && source.minPullKg !== minWeightKg) {
      throw new Error("TARGET_PULL_MIGRATION_CONFLICT：" + sourceId + " 最小拉力新旧字段不一致。");
    }
    if (typeof source.maxPullKg === "number" && typeof maxWeightKg === "number" && source.maxPullKg !== maxWeightKg) {
      throw new Error("TARGET_PULL_MIGRATION_CONFLICT：" + sourceId + " 最大拉力新旧字段不一致。");
    }
    return {
      ...preserved,
      ...(typeof source.minPullKg === "number" ? {} : typeof minWeightKg === "number" ? { minPullKg: minWeightKg } : {}),
      ...(typeof source.maxPullKg === "number" ? {} : typeof maxWeightKg === "number" ? { maxPullKg: maxWeightKg } : {}),
    };
  };
  const compatibilityRules = arrayOf<Record<string, unknown>>(state.compatibilityRules).map((rule) => ({
    ...rule,
    selector: migrateSelector(rule.selector, "compatibility:" + String(rule.id ?? "unknown")),
  }));
  const affinityRules = arrayOf<Record<string, unknown>>(state.affinityRules).map((rule) => ({
    ...rule,
    selector: migrateSelector(rule.selector, "affinity:" + String(rule.id ?? "unknown")),
  }));
  const candidateSearchRecipes = arrayOf<Record<string, unknown>>(state.candidateSearchRecipes).map((recipe) => {
    const legacyRange = recipe.targetWeightRangeKg;
    if (legacyRange !== undefined) {
      archive(migrationArchiveItem(
        "target-pull-migration:candidate-recipe:" + String(recipe.id ?? "unknown"),
        String(recipe.id ?? "unknown"),
        "AUD-024：历史候选搜索拉力范围 payload 已归档。",
        recipe,
      ));
    }
    if (
      recipe.targetPullRangeKg !== undefined
      && legacyRange !== undefined
      && deterministicHash(recipe.targetPullRangeKg) !== deterministicHash(legacyRange)
    ) {
      throw new Error("TARGET_PULL_MIGRATION_CONFLICT：候选搜索配方拉力范围新旧字段不一致。");
    }
    const { targetWeightRangeKg: _targetWeightRangeKg, ...preserved } = recipe;
    void _targetWeightRangeKg;
    const targetPullRangeKg = recipe.targetPullRangeKg ?? legacyRange;
    if (!targetPullRangeKg || typeof targetPullRangeKg !== "object" || Array.isArray(targetPullRangeKg)) {
      throw new Error("TARGET_PULL_MIGRATION_INVALID：候选搜索配方缺少拉力范围。");
    }
    return {
      ...preserved,
      targetPullRangeKg,
    };
  });
  const seriesDefinitions = arrayOf<Record<string, unknown>>(state.seriesDefinitions).map((series) => {
    const { targetWeightsKg: _targetWeightsKg, ...preserved } = series;
    if (_targetWeightsKg !== undefined) {
      archive(migrationArchiveItem(
        "target-pull-migration:series:" + String(series.id ?? "unknown"),
        String(series.id ?? "unknown"),
        "AUD-024：历史 Series 重量数组已归档；活动对象消费离散 targetPullSpecifications。",
        series,
      ));
    }
    const declaredSkuIds = new Set(arrayOf<string>(series.skuIds));
    const seriesSkus = skuDrawers
      .filter((sku) => sku.seriesId === series.id)
      .filter((sku) => !declaredSkuIds.size || declaredSkuIds.has(String(sku.id)))
      .sort((left, right) => {
        const leftPull = Number(left.targetPullKg);
        const rightPull = Number(right.targetPullKg);
        return leftPull - rightPull || String(left.id).localeCompare(String(right.id));
      });
    const existingSpecifications = arrayOf<Record<string, unknown>>(series.targetPullSpecifications);
    const targetPullSpecifications = existingSpecifications.length
      ? structuredClone(existingSpecifications)
      : seriesSkus.map((sku) => ({
          targetPullKgf: Number(sku.targetPullKg),
          skuId: String(sku.id),
        }));
    return {
      ...preserved,
      targetPullSpecifications,
    };
  });
  return {
    ...state,
    schemaVersion: 17,
    skuDrawers,
    projectionMatches,
    compatibilityRules,
    affinityRules,
    candidateSearchRecipes,
    seriesDefinitions,
    migrationReviewItems,
    // ConfigurationSnapshot 是冻结 payload；此迁移不得补字段、重算或改变 contentHash。
    configurationSnapshots: arrayOf<WorkspaceState["configurationSnapshots"][number]>(
      state.configurationSnapshots,
    ),
  } as unknown as MutableWorkspace;
}

const migrations: Record<number, (state: MutableWorkspace) => MutableWorkspace> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
  4: migrateV4ToV5,
  5: migrateV5ToV6,
  6: migrateV6ToV7,
  7: migrateV7ToV8,
  8: migrateV8ToV9,
  9: migrateV9ToV10,
  10: migrateV10ToV11,
  11: migrateV11ToV12,
  12: migrateV12ToV13,
  13: migrateV13ToV14,
  14: migrateV14ToV15,
  15: migrateV15ToV16,
  16: migrateV16ToV17,
};

export function migrateWorkspaceState(input: unknown): WorkspaceState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("工作区状态必须是对象。");
  }

  let state = structuredClone(input) as MutableWorkspace;
  let version =
    typeof state.schemaVersion === "number" ? state.schemaVersion : 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("工作区 schemaVersion 无效。");
  }
  if (version > CURRENT_WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      "工作区版本 " + version + " 高于当前支持版本 " +
        CURRENT_WORKSPACE_SCHEMA_VERSION + "。",
    );
  }

  while (version < CURRENT_WORKSPACE_SCHEMA_VERSION) {
    const migrate = migrations[version];
    if (!migrate) {
      throw new Error("缺少从 schema v" + version + " 开始的顺序迁移。");
    }
    state = migrate(state);
    const nextVersion = state.schemaVersion;
    if (typeof nextVersion !== "number" || nextVersion <= version) {
      throw new Error("schema v" + version + " 迁移没有推进版本号。");
    }
    version = nextVersion;
  }

  // Some production databases were marked v17 before every persisted payload had
  // been normalized. Keep this normalizer idempotent so current-version states
  // are readable on startup without changing frozen snapshots.
  if (version === 17) {
    state = migrateV16ToV17(state);
  }

  state = {
    ...state,
    patchLedger: state.patchLedger && typeof state.patchLedger === "object"
      ? migratePatchLedger(state.patchLedger as WorkspaceState["patchLedger"])
      : emptyPatchLedger(),
  };
  return state as WorkspaceState;
}

function migrateV4ToV5(state: MutableWorkspace): MutableWorkspace {
  const existingWorkbooks = arrayOf<WorkspaceState["feishuWorkbooks"][number]>(
    state.feishuWorkbooks,
  );
  return {
    ...state,
    schemaVersion: 5,
    feishuWorkbooks: existingWorkbooks.length
      ? existingWorkbooks
      : [structuredClone(CANONICAL_FEISHU_WORKBOOK)],
    feishuSourceRevisions: arrayOf<WorkspaceState["feishuSourceRevisions"][number]>(
      state.feishuSourceRevisions,
    ),
    sourceIdentityMigrationReports: arrayOf<WorkspaceState["sourceIdentityMigrationReports"][number]>(
      state.sourceIdentityMigrationReports,
    ),
    pricingPolicyDrafts: arrayOf<WorkspaceState["pricingPolicyDrafts"][number]>(
      state.pricingPolicyDrafts,
    ),
    pricingPolicyVersions: arrayOf<WorkspaceState["pricingPolicyVersions"][number]>(
      state.pricingPolicyVersions,
    ),
  };
}

function migrateV5ToV6(state: MutableWorkspace): MutableWorkspace {
  return {
    ...state,
    schemaVersion: 6,
    configEnvironmentProfiles: arrayOf<
      WorkspaceState["configEnvironmentProfiles"][number]
    >(state.configEnvironmentProfiles),
    configExportMappings: arrayOf<
      WorkspaceState["configExportMappings"][number]
    >(state.configExportMappings),
  };
}

function migrateV6ToV7(state: MutableWorkspace): MutableWorkspace {
  return {
    ...state,
    schemaVersion: 7,
    candidateSearchRecipes: arrayOf<CandidateSearchRecipe>(state.candidateSearchRecipes)
      .map((recipe) => ({ ...recipe, revision: recipe.revision ?? 1 })),
    candidateRuns: arrayOf<WorkspaceState["candidateRuns"][number]>(state.candidateRuns),
    candidateMaterializations: arrayOf<WorkspaceState["candidateMaterializations"][number]>(state.candidateMaterializations),
  };
}

function migrateV7ToV8(state: MutableWorkspace): MutableWorkspace {
  type LegacySku = Record<string, unknown> & {
    id: string;
    seriesId: string;
    targetPullKg?: number;
    targetWeightKg?: number;
  };
  type LegacySeries = Record<string, unknown> & {
    id: string;
    planningPullRange?: { minKgf: number; maxKgf: number };
    targetPullSpecifications?: Array<{ targetPullKgf: number; skuId: string }>;
    targetWeightsKg?: number[];
    skuIds?: string[];
  };
  const skuDrawers = arrayOf<LegacySku>(state.skuDrawers);
  const pullForLegacySku = (sku: LegacySku) => resolveLegacyNumber({
    canonical: sku.targetPullKg,
    legacy: sku.targetWeightKg,
    label: "schema v7 SKU " + sku.id,
    positive: true,
  });
  return {
    ...state,
    schemaVersion: 8,
    seriesDefinitions: arrayOf<LegacySeries>(state.seriesDefinitions)
      .map((series) => {
        const seriesSkus = skuDrawers
          .filter((sku) => sku.seriesId === series.id)
          .sort((left, right) => pullForLegacySku(left) - pullForLegacySku(right) || left.id.localeCompare(right.id));
        const specifications = seriesSkus.map((sku) => ({
          targetPullKgf: pullForLegacySku(sku),
          skuId: sku.id,
        }));
        const pulls = specifications.map((entry) => entry.targetPullKgf);
        return {
          ...series,
          planningPullRange: series.planningPullRange ?? (pulls.length
            ? { minKgf: Math.min(...pulls), maxKgf: Math.max(...pulls) }
            : undefined),
          targetPullSpecifications: series.targetPullSpecifications?.length
            ? structuredClone(series.targetPullSpecifications)
            : specifications,
          targetWeightsKg: series.targetWeightsKg?.length
            ? [...series.targetWeightsKg]
            : pulls,
          skuIds: series.skuIds?.length ? [...series.skuIds] : specifications.map((entry) => entry.skuId),
        };
      }),
  } as unknown as MutableWorkspace;
}

function migrateV12ToV13(state: MutableWorkspace): MutableWorkspace {
  const ledger = state.patchLedger && typeof state.patchLedger === "object"
    ? migratePatchLedger(state.patchLedger as WorkspaceState["patchLedger"])
    : emptyPatchLedger();
  return { ...state, schemaVersion: 13, patchLedger: ledger };
}
function migrateV11ToV12(state: MutableWorkspace): MutableWorkspace {
  const ledger = state.patchLedger && typeof state.patchLedger === "object"
    ? structuredClone(state.patchLedger) as WorkspaceState["patchLedger"]
    : emptyPatchLedger();
  ledger.revisions = ledger.revisions.map((revision) => {
    const legacy = revision.rawPayload as { status?: unknown } | undefined;
    return revision.state === "APPROVED" && legacy?.status === "approved"
      ? { ...revision, state: "ACTIVE" as const }
      : revision;
  });
  return { ...state, schemaVersion: 12, patchLedger: ledger };
}
function migrateV10ToV11(state: MutableWorkspace): MutableWorkspace {
  const ledger = state.patchLedger && typeof state.patchLedger === "object"
    ? structuredClone(state.patchLedger) as WorkspaceState["patchLedger"]
    : emptyPatchLedger();
  for (const snapshot of arrayOf<WorkspaceState["configurationSnapshots"][number]>(state.configurationSnapshots)) {
    if (snapshot.patchReferences?.length || !snapshot.patchSetHash) continue;
    const id = "patch-snapshot-migration:" + snapshot.id;
    if (ledger.migrationReviewItems.some((entry) => entry.id === id)) continue;
    ledger.migrationReviewItems.push({
      id,
      patchId: "legacy-snapshot:" + snapshot.id,
      patchRevision: 1,
      reason: "LEGACY_SNAPSHOT_PATCH_REFERENCES_UNAVAILABLE",
      preservedPayload: structuredClone(snapshot),
    });
  }
  return { ...state, schemaVersion: 11, patchLedger: ledger };
}

function migrateV9ToV10(state: MutableWorkspace): MutableWorkspace {
  const existing = state.patchLedger && typeof state.patchLedger === "object"
    ? structuredClone(state.patchLedger) as WorkspaceState["patchLedger"]
    : emptyPatchLedger();
  const withSnapshotMigrationReviews = (ledger: WorkspaceState["patchLedger"]) => {
    const next = structuredClone(ledger);
    for (const snapshot of arrayOf<WorkspaceState["configurationSnapshots"][number]>(state.configurationSnapshots)) {
      if (snapshot.patchReferences?.length || !snapshot.patchSetHash) continue;
      const id = "patch-snapshot-migration:" + snapshot.id;
      if (next.migrationReviewItems.some((entry) => entry.id === id)) continue;
      next.migrationReviewItems.push({
        id,
        patchId: "legacy-snapshot:" + snapshot.id,
        patchRevision: 1,
        reason: "LEGACY_SNAPSHOT_PATCH_REFERENCES_UNAVAILABLE",
        preservedPayload: structuredClone(snapshot),
      });
    }
    return next;
  };
  if (existing.revisions.length || !arrayOf<ProjectionPatchRuleSource>(state.projectionPatches).length) {
    return { ...state, schemaVersion: 10, patchLedger: withSnapshotMigrationReviews(existing) };
  }
  const ledger = emptyPatchLedger();
  for (const patch of arrayOf<ProjectionPatchRuleSource>(state.projectionPatches)) {
    const sourceOperations = patch.operations ?? [];
    if (!sourceOperations.length) {
      ledger.migrationReviewItems.push({
        id: "patch-migration:" + patch.id,
        patchId: patch.id,
        patchRevision: 1,
        reason: "LEGACY_PATCH_OPERATION_MISSING",
        preservedPayload: structuredClone(patch),
      });
      continue;
    }
    try {
      ledger.revisions.push(buildPatchRevision({
        patchId: patch.id,
        patchRevision: 1,
        scopeType: patch.scope,
        layerType: patch.scope,
        subjectEntityId: patch.scopeId,
        subjectName: patch.scopeId,
        baseRuleSetVersion: patch.baseRuleSetVersion,
        baseObjectRevision: 1,
        state: patch.status === "approved" ? "ACTIVE" : patch.status === "superseded" ? "SUPERSEDED" : "DRAFT",
        mirrorSyncState: "NOT_SYNCED",
        attentionStates: [],
        reason: patch.reason,
        evidence: [],
        createdBy: patch.author,
        createdAt: patch.createdAt ?? "1970-01-01T00:00:00.000Z",
        snapshotRefs: [],
        rawPayload: structuredClone(patch),
        operations: sourceOperations.map((operation, index) => ({
          operationId: patch.id + ":op:" + String(index + 1),
          operationIndex: index,
          parameterKey: operation.path,
          operation: operation.op === "remove" ? "clear" : operation.op,
          operand: "value" in operation ? operation.value : null,
          before: undefined,
          after: undefined,
        })),
      }));
    } catch {
      ledger.migrationReviewItems.push({
        id: "patch-migration:" + patch.id,
        patchId: patch.id,
        patchRevision: 1,
        reason: "LEGACY_PATCH_REQUIRES_REVIEW",
        preservedPayload: structuredClone(patch),
      });
    }
  }
  return { ...state, schemaVersion: 10, patchLedger: withSnapshotMigrationReviews(ledger) };
}

function migrateV8ToV9(state: MutableWorkspace): MutableWorkspace {
  return {
    ...state,
    schemaVersion: 9,
    qualityValuePolicyDrafts: arrayOf<
      WorkspaceState["qualityValuePolicyDrafts"][number]
    >(state.qualityValuePolicyDrafts),
  };
}
