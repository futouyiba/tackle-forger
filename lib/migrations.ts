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
  PartConstraintFieldName,
  PartConstraintFieldTrace,
  PartConstraintSet,
  PartConstraintSetRef,
  PartConstraintSlot,
  PartConstraintSourceRevisionRef,
  ProjectionPatchRuleSource,
  SeriesRecipe,
  QualityProfileId,
  QualityProfile,
  RuleSetVersion,
  WorkspaceRuleSettings,
  WorkspaceState,
  FeishuShareLinkHistoryEntry,
  V23LegacyReadAdapter,
  V23MigrationSourceEvidence,
} from "./types";
import { defaultAffinityAxisWeights } from "./compatibility";
import { migrateLegacyProductIdentity } from "./legacy-product-migration";
import { CANONICAL_FEISHU_WORKBOOK } from "./feishu-workbook";
import {
  emptyPatchLedger,
  importLegacyPatchesToLedger,
  migratePatchLedger,
  patchRevisionIdentityKey,
  type PatchLedgerMigrationContext,
} from "./patch-ledger";
import { canonicalizeAffixOperations } from "./reduction-stacking-policy";
import {
  CANONICAL_PATCH_OFFSET_POLICY_ID,
  createCanonicalPatchOffsetPolicyVersion,
} from "./patch-offset-policy";
import { migrateConfigIdGovernanceState } from "./config-id-governance";
import {
  createNeedsReviewPartConstraintSet,
  PART_CONSTRAINT_SOURCE_HASH_PROJECTION,
  partConstraintSourceContentHash,
  partConstraintSourceRevisionId,
  partConstraintSourceStableId,
  partConstraintSetContentHash,
  partConstraintSetRef,
  resolvePartConstraintSourceRevision,
  resolvePartConstraintSetRef,
} from "./part-constraints";
import { deterministicHash } from "./rule-kernel";
import { jcsSha256Hex } from "./canonical-json";
import { projectShareLinkHistoryEntry } from "./data-sources";
import { createFiveAxisDispositionCatalogRevision, createFormalFiveAxisVertexSet } from "./five-axis-formal";

export const CURRENT_WORKSPACE_SCHEMA_VERSION = 23;

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

type MigrationContext = {
  initialSchemaVersion: number;
  originalInput: unknown;
};

function patchLedgerMigrationContext(state:MutableWorkspace):PatchLedgerMigrationContext{
  return {
    frozenPatchRevisionKeys:arrayOf<WorkspaceState["configurationSnapshots"][number]>(state.configurationSnapshots)
      .flatMap((snapshot)=>snapshot.patchReferences??[])
      .map((reference)=>patchRevisionIdentityKey(reference.patchId,reference.patchRevision)),
  };
}

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

/**
 * 为新建参数生成不可复用的稳定 id。新增路径（addParameter、Excel 导入）必须用它，
 * 不得用 `param:${key}`：rename 后旧 id 被保留、旧 key 被释放，以后再用该 key 新建
 * 参数会生成相同 id → 两行 React key 撞车（节点复用/状态串扰/重挂载，即 review 发现）。
 *
 * 注意：与 enrichParameters 的 `param:${key}` 回填分工——后者只用于历史无 id 数据的
 * best-effort 回填（存量数据、碰撞风险低且不能臆造身份），新增路径绝不能用它。
 *
 * 使用全局 Web Crypto（浏览器与 Node 22.16+ 均原生可用，与 lib/workflow、lib/storage 一致）。
 */
export function createParameterId(): string {
  return `param:${crypto.randomUUID()}`;
}

function enrichParameters(parameters: ParameterDefinition[]): ParameterDefinition[] {
  return parameters.map((parameter) => ({
    ...parameter,
    id: parameter.id ?? `param:${parameter.key}`,
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
        legacyItemPartAgnostic: true,
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
  ).map((patch) => {
    const hasOnlyCanonicalRules = patch.rules.every((rule) =>
      rule.operation === "set"
      || ((rule.operation === "add" || rule.operation === "multiply") && typeof rule.value === "number"));
    const canonicalOperations = hasOnlyCanonicalRules
      ? patch.rules.map((rule) =>
          rule.operation === "set"
            ? { op: "set" as const, path: rule.parameterKey, value: rule.value }
            : rule.operation === "add"
              ? { op: "add" as const, path: rule.parameterKey, value: rule.value as number }
              : { op: "multiply" as const, path: rule.parameterKey, value: rule.value as number })
      : undefined;
    return {
      ...patch,
      createdAt:
        patch.createdAt ??
        (typeof state.importedAt === "string"
          ? state.importedAt
          : "1970-01-01T00:00:00.000Z"),
      operations: patch.operations ?? canonicalOperations,
    };
  });
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
  const ledger = state.patchLedger && typeof state.patchLedger === "object"
    ? migratePatchLedger(state.patchLedger as WorkspaceState["patchLedger"],patchLedgerMigrationContext(state))
    : emptyPatchLedger();
  const legacyLimits = state.ruleSettings?.patchOffsetLimits;
  if (legacyLimits && (legacyLimits.warning !== undefined || legacyLimits.error !== undefined)
    && !ledger.migrationReviewItems.some((entry) => entry.id === "patch-offset-policy:legacy-thresholds")) {
    ledger.migrationReviewItems.push({
      id: "patch-offset-policy:legacy-thresholds",
      patchId: "legacy-patch-offset-policy",
      patchRevision: 1,
      reason: "LEGACY_PATCH_OFFSET_THRESHOLDS_QUARANTINED",
      preservedPayload: structuredClone(legacyLimits),
    });
  }
  const policies = arrayOf<WorkspaceState["workspacePolicies"][number]>(state.workspacePolicies)
    .map((policy) => policy.policyType === "patchOffsetPolicy"
      && policy.policyId !== CANONICAL_PATCH_OFFSET_POLICY_ID && policy.status === "published"
      ? { ...policy, status: "superseded" as const } : policy);
  if (!policies.some((policy) => policy.policyId === CANONICAL_PATCH_OFFSET_POLICY_ID)) {
    policies.push(createCanonicalPatchOffsetPolicyVersion({
      createdAt: "2026-07-23T00:00:00.000Z",
      publishedAt: "2026-07-23T00:00:00.000Z",
      publishedBy: "OPEN-004 / GitHub Issue #32",
    }) as unknown as WorkspaceState["workspacePolicies"][number]);
  }
  return {
    ...state,
    schemaVersion: 16,
    ruleSettings: { ...(state.ruleSettings ?? DEFAULT_RULE_SETTINGS), patchOffsetLimits: {} },
    patchLedger: ledger,
    workspacePolicies: policies,
    patchReviewBatches: arrayOf<WorkspaceState["patchReviewBatches"][number]>(state.patchReviewBatches),
    patchValidationWaivers: arrayOf<WorkspaceState["patchValidationWaivers"][number]>(state.patchValidationWaivers),
    patchValidationWaiverDecisions: arrayOf<WorkspaceState["patchValidationWaiverDecisions"][number]>(state.patchValidationWaiverDecisions),
    canonicalRuleSourceDrafts: arrayOf<WorkspaceState["canonicalRuleSourceDrafts"][number]>(state.canonicalRuleSourceDrafts),
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
  const v3Affixes = arrayOf<V3Affix>(state.v3Affixes).map((affix) => {
    if (affix.category !== "attribute") return affix;
    const canonical = canonicalizeAffixOperations([affix]);
    if (canonical.issues.length) {
      const reviewId = `affix-direction-migration:${affix.id}@${affix.version}`;
      if (!migrationReviewItems.some((entry) => entry.id === reviewId)) {
        migrationReviewItems.push({
          id: reviewId,
          sourceType: "unknown",
          sourceId: `${affix.id}@${affix.version}`,
          message: "AFFIX_DIRECTION_CONFLICT：旧词条方向与幅度无法无损规范化，已保留原始修订并隔离等待复核。",
          preservedPayload: structuredClone(affix),
          status: "pending",
        });
      }
      return affix;
    }
    return {
      ...affix,
      attributeEffects: canonical.operations.map((operation, index) => {
        const legacy = affix.attributeEffects[index];
        return {
          ...operation,
          id: operation.operationId,
          unit: legacy?.unit ?? "",
          stackingGroup: legacy?.stackingGroup ?? "",
          ruleSetVersion: legacy?.ruleSetVersion ?? "",
        };
      }),
    };
  });
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
    const legacyProjectionMatch = sku.projectionMatch;
    if (
      legacyProjectionMatch && typeof legacyProjectionMatch === "object" && !Array.isArray(legacyProjectionMatch)
      && (Object.hasOwn(legacyProjectionMatch, "targetWeightKg")
        || Object.hasOwn(legacyProjectionMatch, "anchorWeightKg")
        || Object.hasOwn(legacyProjectionMatch, "weightDistance"))
    ) {
      archive(migrationArchiveItem(
        "target-pull-migration:sku-projection-match:" + String(sku.id ?? "unknown"),
        String(sku.id ?? "unknown"),
        "AUD-024：SKU 内嵌历史 ProjectionMatch payload 已归档。",
        legacyProjectionMatch,
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
    v3Affixes,
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
    // 不凭历史文档或外部 revision 17173 合成已发布策略。机器规则未就绪时保持空集合。
    reductionStackingPolicyVersions: arrayOf<
      WorkspaceState["reductionStackingPolicyVersions"][number]
    >(state.reductionStackingPolicyVersions),
  } as unknown as MutableWorkspace;
}

const LEGACY_SERIES_RECIPE_FIELDS = new Set([
  "id",
  "name",
  "platformId",
  "platformPosition",
  "templateIds",
  "structureIds",
  "functionIds",
  "performanceIds",
  "technologyIds",
  "requiredAffixIds",
  "optionalAffixPoolIds",
  "partConstraints",
  "optionalSlots",
  "qualityTarget",
  "fishMinKg",
  "fishMaxKg",
  "useScene",
  "maxCandidates",
  "notes",
  "enabled",
]);

function stableConstraintSetId(sourceType: string, sourceId: string): string {
  return `part-constraint-set:${sourceType}:${encodeURIComponent(sourceId)}`;
}

function assertConstraintSetSourceMatchesConsumer(
  constraintSet: PartConstraintSet,
  consumer: Record<string, unknown>,
  sourceType: PartConstraintSourceRevisionRef["sourceType"],
): void {
  const expected: PartConstraintSourceRevisionRef = {
    sourceType,
    sourceId: partConstraintSourceStableId(consumer, sourceType),
    revisionId: partConstraintSourceRevisionId(consumer),
    hashProjectionVersion: PART_CONSTRAINT_SOURCE_HASH_PROJECTION,
    contentHash: partConstraintSourceContentHash(consumer),
  };
  if (deterministicHash(constraintSet.sourceRef) !== deterministicHash(expected)) {
    throw new Error(
      `PART_CONSTRAINT_SET_SOURCE_REF_MISMATCH：${constraintSet.constraintSetId}@${constraintSet.revision} 不属于当前 ${sourceType} 消费者。`,
    );
  }
}

function v17NormalizationRequired(identity: string): never {
  throw new Error(
    `PART_CONSTRAINT_SET_V17_NORMALIZATION_REQUIRED：${identity} 是旧 schema v17 形态，不能直接提升为 schema v18。`,
  );
}

/**
 * Existing v17 constraint sets are already hash-addressed, so validate their
 * whole persisted normalization envelope before calculating or dereferencing
 * anything inside it.  `rawPayload` intentionally permits null; its presence
 * (rather than truthiness) is the audit contract.
 */
function assertV17ConstraintSetNormalization(
  value: unknown,
): asserts value is PartConstraintSet {
  const constraintSet = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const identity = constraintSet
    ? `${String(constraintSet.constraintSetId)}@${String(constraintSet.revision)}`
    : "unknown";
  if (!constraintSet) v17NormalizationRequired(identity);

  const evidence = constraintSet.migrationEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    v17NormalizationRequired(identity);
  }
  const record = evidence as Record<string, unknown>;
  if (
    typeof record.migratorVersion !== "string"
    || !record.migratorVersion.trim()
    || !Number.isSafeInteger(record.sourceSchemaVersion)
    || (record.sourceSchemaVersion as number) < 1
    || typeof record.migratedAt !== "string"
    || !record.migratedAt.trim()
    || !Number.isFinite(Date.parse(record.migratedAt))
    || !Array.isArray(record.diagnosticCodes)
    || record.diagnosticCodes.some((code) => typeof code !== "string")
    || !Object.hasOwn(record, "rawPayload")
  ) {
    v17NormalizationRequired(identity);
  }
}

function legacyRecipePartPayloads(
  source: Record<string, unknown>,
): {
  partPayloads: Partial<Record<PartConstraintSlot, unknown>>;
  fieldEvidence: Partial<Record<
    PartConstraintSlot,
    Partial<Record<PartConstraintFieldName, {
      sourcePath: string;
      rawPayload: unknown;
      transformationCodes: string[];
    }>>
  >>;
} {
  const partConstraints = source.partConstraints
    && typeof source.partConstraints === "object"
    && !Array.isArray(source.partConstraints)
    ? source.partConstraints as Record<string, unknown>
    : undefined;
  if (partConstraints) {
    const partPayloads = {
      rod: structuredClone(partConstraints.rod),
      reel: structuredClone(partConstraints.reel),
      line: structuredClone(partConstraints.line),
    };
    return {
      partPayloads,
      fieldEvidence: Object.fromEntries(
        (["rod", "reel", "line"] as PartConstraintSlot[]).map((slot) => {
          const part = partConstraints[slot]
            && typeof partConstraints[slot] === "object"
            && !Array.isArray(partConstraints[slot])
            ? partConstraints[slot] as Record<string, unknown>
            : {};
          return [slot, Object.fromEntries(
            ([
              "templateIds",
              "materialIds",
              "requiredAffixIds",
              "optionalAffixPoolIds",
              "typeIds",
            ] as PartConstraintFieldName[]).map((field) => [field, {
              sourcePath: `$.partConstraints.${slot}.${field}`,
              rawPayload: structuredClone(part[field]),
              transformationCodes: [],
            }]),
          )];
        }),
      ),
    };
  }
  const legacyCarrier = {
    templateIds: structuredClone(source.templateIds),
    typeIds: structuredClone(source.structureIds),
    materialIds: [],
    requiredAffixIds: structuredClone(source.requiredAffixIds),
    optionalAffixPoolIds: structuredClone(source.optionalAffixPoolIds),
  };
  const fieldSources: Record<
    PartConstraintFieldName,
    { sourcePath: string; rawPayload: unknown; transformationCodes: string[] }
  > = {
    templateIds: {
      sourcePath: "$.templateIds",
      rawPayload: structuredClone(source.templateIds),
      transformationCodes: ["COPY_LEGACY_FLAT_FIELD_TO_PART"],
    },
    materialIds: {
      sourcePath: "$",
      rawPayload: undefined,
      transformationCodes: ["SYNTHESIZE_EMPTY_MATERIAL_IDS"],
    },
    requiredAffixIds: {
      sourcePath: "$.requiredAffixIds",
      rawPayload: structuredClone(source.requiredAffixIds),
      transformationCodes: ["COPY_LEGACY_FLAT_FIELD_TO_PART"],
    },
    optionalAffixPoolIds: {
      sourcePath: "$.optionalAffixPoolIds",
      rawPayload: structuredClone(source.optionalAffixPoolIds),
      transformationCodes: ["COPY_LEGACY_FLAT_FIELD_TO_PART"],
    },
    typeIds: {
      sourcePath: "$.structureIds",
      rawPayload: structuredClone(source.structureIds),
      transformationCodes: [
        "COPY_LEGACY_FLAT_FIELD_TO_PART",
        "RENAME_STRUCTURE_IDS_TO_TYPE_IDS",
      ],
    },
  };
  return {
    partPayloads: {
      rod: structuredClone(legacyCarrier),
      reel: structuredClone(legacyCarrier),
      line: structuredClone(legacyCarrier),
    },
    fieldEvidence: {
      rod: structuredClone(fieldSources),
      reel: structuredClone(fieldSources),
      line: structuredClone(fieldSources),
    },
  };
}

function migrateV17ToV18(input: MutableWorkspace): MutableWorkspace {
  // v17 曾存在已标记但尚未完全规范化的生产 payload；先复用其幂等 normalizer。
  const state = migrateV16ToV17(input);
  const migratedAt = typeof state.importedAt === "string" && state.importedAt
    ? state.importedAt
    : "1970-01-01T00:00:00.000Z";
  const constraintSets = arrayOf<PartConstraintSet>(state.partConstraintSets)
    .map((entry) => structuredClone(entry));
  const reviewItems = arrayOf<MigrationReviewItem>(state.migrationReviewItems)
    .map((entry) => structuredClone(entry));

  const constraintSetIdentities = new Set<string>();
  for (const constraintSet of constraintSets) {
    assertV17ConstraintSetNormalization(constraintSet);
    const identity = `${constraintSet.constraintSetId}@${constraintSet.revision}`;
    if (constraintSetIdentities.has(identity)) {
      throw new Error(
        `PART_CONSTRAINT_SET_REVISION_DUPLICATE：${identity} 存在重复记录。`,
      );
    }
    constraintSetIdentities.add(identity);
    if (partConstraintSetContentHash(constraintSet) !== constraintSet.contentHash) {
      throw new Error(
        `PART_CONSTRAINT_SET_CONTENT_TAMPERED：${identity} 存储内容与哈希不一致。`,
      );
    }
    const sourceRef = constraintSet.sourceRef as Partial<PartConstraintSourceRevisionRef>;
    if (
      sourceRef.hashProjectionVersion !== PART_CONSTRAINT_SOURCE_HASH_PROJECTION
      || !Array.isArray(constraintSet.traces)
      || constraintSet.traces.some(
        (trace) => !Array.isArray(
          (trace as Partial<PartConstraintFieldTrace>).transformationCodes,
        ),
      )
    ) {
      v17NormalizationRequired(identity);
    }
    resolvePartConstraintSetRef(
      constraintSets,
      partConstraintSetRef(constraintSet),
    );
  }

  const addConstraintSet = (candidate: PartConstraintSet): PartConstraintSet => {
    const matches = constraintSets.filter(
      (entry) =>
        entry.constraintSetId === candidate.constraintSetId
        && entry.revision === candidate.revision,
    );
    if (matches.length > 1) {
      throw new Error(
        `PART_CONSTRAINT_SET_REVISION_DUPLICATE：${candidate.constraintSetId}@${candidate.revision} 存在重复记录。`,
      );
    }
    const existing = matches[0];
    if (existing) {
      resolvePartConstraintSetRef(
        constraintSets,
        partConstraintSetRef(existing),
      );
      if (existing.contentHash !== candidate.contentHash) {
        throw new Error(
          `PART_CONSTRAINT_SET_REVISION_CONFLICT：${candidate.constraintSetId}@${candidate.revision} 已存在不同内容。`,
        );
      }
      return existing;
    }
    constraintSets.push(candidate);
    return candidate;
  };

  const addReviewItem = (constraintSet: PartConstraintSet) => {
    const sourceType: MigrationReviewItem["sourceType"] =
      constraintSet.sourceRef.sourceType === "legacy_series_recipe"
        ? "series_recipe"
        : constraintSet.sourceRef.sourceType;
    const id = `${constraintSet.constraintSetId}:r${constraintSet.revision}:review`;
    const candidate: MigrationReviewItem = {
      id,
      sourceType,
      sourceId: constraintSet.sourceRef.sourceId,
      message: "AUD-026：分部位约束来源尚未人工确认；权威候选过滤与自动发布必须 fail-closed。",
      preservedPayload: {
        partConstraintSetRef: partConstraintSetRef(constraintSet),
        sourceRef: structuredClone(constraintSet.sourceRef),
        rawPayload: structuredClone(constraintSet.migrationEvidence.rawPayload),
        diagnosticCodes: [...constraintSet.migrationEvidence.diagnosticCodes],
      },
      status: "pending",
    };
    const matches = reviewItems.filter((entry) => entry.id === id);
    if (matches.length > 1) {
      throw new Error(
        `PART_CONSTRAINT_REVIEW_ITEM_DUPLICATE：${id} 存在重复复核项。`,
      );
    }
    if (matches.length === 1) {
      if (deterministicHash(matches[0]) !== deterministicHash(candidate)) {
        throw new Error(
          `PART_CONSTRAINT_REVIEW_ITEM_CONFLICT：${id} 与预期复核证据不一致。`,
        );
      }
      return;
    }
    reviewItems.push(candidate);
  };

  const migratedLegacyRefs = new Map<string, PartConstraintSetRef>();
  for (const recipe of arrayOf<Record<string, unknown>>(state.recipes)) {
    const sourceId = partConstraintSourceStableId(recipe, "legacy_series_recipe");
    const sourceRef = {
      sourceType: "legacy_series_recipe" as const,
      sourceId,
      revisionId: partConstraintSourceRevisionId(recipe),
      hashProjectionVersion: PART_CONSTRAINT_SOURCE_HASH_PROJECTION,
      contentHash: partConstraintSourceContentHash(recipe),
    };
    const diagnostics = new Set<string>([
      "LEGACY_V14_CARRIER_REQUIRES_REVIEW",
    ]);
    if (sourceRef.revisionId === null) diagnostics.add("SOURCE_REVISION_MISSING");
    if (Object.keys(recipe).some((field) => !LEGACY_SERIES_RECIPE_FIELDS.has(field))) {
      diagnostics.add("UNKNOWN_SOURCE_FIELDS_PRESERVED_RAW");
    }
    const rawPartConstraints = recipe.partConstraints
      && typeof recipe.partConstraints === "object"
      && !Array.isArray(recipe.partConstraints)
      ? recipe.partConstraints as Record<string, unknown>
      : undefined;
    if (
      rawPartConstraints
      && Object.keys(rawPartConstraints).some(
        (slot) => slot !== "rod" && slot !== "reel" && slot !== "line",
      )
    ) {
      diagnostics.add("UNKNOWN_PART_SLOT_PRESERVED_RAW");
    }
    const legacyParts = legacyRecipePartPayloads(recipe);
    const candidate = createNeedsReviewPartConstraintSet({
      constraintSetId: stableConstraintSetId("legacy-series-recipe", sourceId),
      sourceRef,
      rawPayload: recipe,
      sourceSchemaVersion: 17,
      migratedAt,
      partPayloads: legacyParts.partPayloads,
      fieldEvidence: legacyParts.fieldEvidence,
      diagnosticCodes: [...diagnostics],
    });
    const constraintSet = addConstraintSet(candidate);
    const ref = partConstraintSetRef(constraintSet);
    migratedLegacyRefs.set(sourceId, ref);
    addReviewItem(constraintSet);
  }

  const candidateSearchRecipes = arrayOf<Record<string, unknown>>(
    state.candidateSearchRecipes,
  ).map((recipe) => {
    const existingRef = recipe.partConstraintSetRef as PartConstraintSetRef | undefined;
    if (existingRef) {
      const constraintSet = resolvePartConstraintSetRef(constraintSets, existingRef);
      assertConstraintSetSourceMatchesConsumer(
        constraintSet,
        recipe,
        "candidate_search_recipe",
      );
      if (constraintSet.reviewStatus === "NEEDS_REVIEW") {
        addReviewItem(constraintSet);
      }
      return structuredClone(recipe);
    }
    const legacyId = typeof recipe.sourceLegacyRecipeId === "string"
      ? recipe.sourceLegacyRecipeId
      : typeof recipe.id === "string" && recipe.id.startsWith("search:")
        ? recipe.id.slice("search:".length)
        : undefined;
    const legacyRef = legacyId ? migratedLegacyRefs.get(legacyId) : undefined;

    const sourceId = partConstraintSourceStableId(recipe, "candidate_search_recipe");
    const sourceRef = {
      sourceType: "candidate_search_recipe" as const,
      sourceId,
      revisionId: partConstraintSourceRevisionId(recipe),
      hashProjectionVersion: PART_CONSTRAINT_SOURCE_HASH_PROJECTION,
      contentHash: partConstraintSourceContentHash(recipe),
    };
    const constraintSet = addConstraintSet(createNeedsReviewPartConstraintSet({
      constraintSetId: stableConstraintSetId("candidate-search-recipe", sourceId),
      sourceRef,
      rawPayload: recipe,
      sourceSchemaVersion: 17,
      migratedAt,
      diagnosticCodes: [
        "NO_RECIPE_PART_CONSTRAINT_SOURCE",
        ...(legacyRef ? ["LEGACY_RECIPE_CONSTRAINTS_NOT_REUSED_ACROSS_CONSUMERS"] : []),
        ...(!legacyRef && legacyId ? ["LEGACY_RECIPE_REF_UNRESOLVED"] : []),
      ],
    }));
    addReviewItem(constraintSet);
    return {
      ...recipe,
      partConstraintSetRef: partConstraintSetRef(constraintSet),
    };
  });

  const seriesDefinitions = arrayOf<Record<string, unknown>>(
    state.seriesDefinitions,
  ).map((series) => {
    const existingRef = series.partConstraintSetRef as PartConstraintSetRef | undefined;
    if (existingRef) {
      const constraintSet = resolvePartConstraintSetRef(constraintSets, existingRef);
      assertConstraintSetSourceMatchesConsumer(
        constraintSet,
        series,
        "series_definition",
      );
      if (constraintSet.reviewStatus === "NEEDS_REVIEW") {
        addReviewItem(constraintSet);
      }
      return structuredClone(series);
    }
    const sourceId = partConstraintSourceStableId(series, "series_definition");
    const sourceRef = {
      sourceType: "series_definition" as const,
      sourceId,
      revisionId: partConstraintSourceRevisionId(series),
      hashProjectionVersion: PART_CONSTRAINT_SOURCE_HASH_PROJECTION,
      contentHash: partConstraintSourceContentHash(series),
    };
    const constraintSet = addConstraintSet(createNeedsReviewPartConstraintSet({
      constraintSetId: stableConstraintSetId("series-definition", sourceId),
      sourceRef,
      rawPayload: series,
      sourceSchemaVersion: 17,
      migratedAt,
      diagnosticCodes: ["NO_SERIES_PART_CONSTRAINT_SOURCE"],
    }));
    addReviewItem(constraintSet);
    return {
      ...series,
      partConstraintSetRef: partConstraintSetRef(constraintSet),
    };
  });

  const sourcesByType: Record<
    PartConstraintSourceRevisionRef["sourceType"],
    Record<string, unknown>[]
  > = {
    legacy_series_recipe: arrayOf<Record<string, unknown>>(state.recipes),
    candidate_search_recipe: candidateSearchRecipes,
    series_definition: seriesDefinitions,
  };
  for (const constraintSet of constraintSets) {
    resolvePartConstraintSourceRevision(
      sourcesByType[constraintSet.sourceRef.sourceType],
      constraintSet.sourceRef,
    );
  }

  return {
    ...state,
    schemaVersion: 18,
    aiRuleSourceChangeDrafts: arrayOf<
      WorkspaceState["aiRuleSourceChangeDrafts"][number]
    >(state.aiRuleSourceChangeDrafts),
    aiArtifactProvenanceSyncRecords: arrayOf<
      WorkspaceState["aiArtifactProvenanceSyncRecords"][number]
    >(state.aiArtifactProvenanceSyncRecords),
    partConstraintSets: constraintSets,
    candidateSearchRecipes,
    seriesDefinitions,
    migrationReviewItems: reviewItems,
    performanceSummaryDefinitions: arrayOf<
      WorkspaceState["performanceSummaryDefinitions"][number]
    >(state.performanceSummaryDefinitions),
    // PartConstraintSet 迁移不得补写、重算或改变任何已发布 Snapshot。
    configurationSnapshots: arrayOf<WorkspaceState["configurationSnapshots"][number]>(
      state.configurationSnapshots,
    ),
  } as unknown as MutableWorkspace;
}

function migrateV18ToV19(input: MutableWorkspace): MutableWorkspace {
  const state = migrateV17ToV18(input);
  return {
    ...state,
    schemaVersion: 19,
    weightTemplatePolicyDrafts: arrayOf<WorkspaceState["weightTemplatePolicyDrafts"][number]>(state.weightTemplatePolicyDrafts),
    // Historical snapshots are opaque frozen publications; never derive them
    // from newly introduced source evidence.
    configurationSnapshots: arrayOf<WorkspaceState["configurationSnapshots"][number]>(state.configurationSnapshots),
  } as MutableWorkspace;
}


function migrateV19ToV20(input: MutableWorkspace): MutableWorkspace {
  const state = migrateV18ToV19(input);
  const rawHistory = arrayOf<WorkspaceState["feishuShareLinkHistory"][number]>(
    state.feishuShareLinkHistory,
  );
  const seen = new Set<string>();
  const feishuShareLinkHistory: FeishuShareLinkHistoryEntry[] = [];
  for (const raw of rawHistory) {
    const projected = projectShareLinkHistoryEntry(raw);
    if (!projected) continue;
    if (seen.has(projected.shareUrl)) continue;
    seen.add(projected.shareUrl);
    feishuShareLinkHistory.push(projected);
  }
  return {
    ...state,
    schemaVersion: 20,
    feishuShareLinkHistory,
  } as MutableWorkspace;
}

/**
 * Pricing v2 is intentionally additive: old execution switches remain opaque
 * evidence for historical replay and no published Snapshot is recalculated.
 */
function migrateV20ToV21(input: MutableWorkspace): MutableWorkspace {
  const state = migrateV19ToV20(input);
  const preserveLegacyExecution = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const policy = structuredClone(value) as Record<string, unknown>;
    if (!policy.executionPolicy && policy.moneyPolicy && typeof policy.moneyPolicy === "object") {
      const money = policy.moneyPolicy as Record<string, unknown>;
      policy.legacyExecutionPayload = {
        roundingStage: money.roundingStage,
        minimumPriceScope: money.minimumPriceScope,
        overflowMode: money.overflowMode,
      };
    }
    return policy;
  };
  // Pricing v2 formal publication requires a valid executionPolicy.  Legacy
  // published versions that pre-date executionPolicy cannot be re-published
  // under v2 semantics, so they are sealed as LEGACY_PUBLISHED evidence rather
  // than remaining indistinguishable from a currently formal policy.  Drafts
  // never carry a PUBLISHED status and only retain legacyExecutionPayload.
  const sealLegacyPublished = (value: unknown) => {
    const preserved = preserveLegacyExecution(value);
    if (!preserved || typeof preserved !== "object" || Array.isArray(preserved)) return preserved;
    const policy = preserved as Record<string, unknown>;
    if (!policy.executionPolicy && policy.formalStatus === "PUBLISHED") {
      policy.formalStatus = "LEGACY_PUBLISHED";
    }
    return policy;
  };
  return {
    ...state,
    schemaVersion: 21,
    pricingPolicyDrafts: arrayOf<WorkspaceState["pricingPolicyDrafts"][number]>(state.pricingPolicyDrafts)
      .map(preserveLegacyExecution) as WorkspaceState["pricingPolicyDrafts"],
    pricingPolicyVersions: arrayOf<WorkspaceState["pricingPolicyVersions"][number]>(state.pricingPolicyVersions)
      .map(sealLegacyPublished) as WorkspaceState["pricingPolicyVersions"],
    configurationSnapshots: arrayOf<WorkspaceState["configurationSnapshots"][number]>(state.configurationSnapshots),
  } as MutableWorkspace;
}

function migrateV21ToV22(input: MutableWorkspace): MutableWorkspace {
  return {
    ...input,
    schemaVersion: 22,
    modelPricingEvaluations: [],
  } as MutableWorkspace;
}

function requiredLegacyId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`V23_MIGRATION_${label}_ID_INVALID`);
  }
  return value;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const V23_HASH = /^[a-f0-9]{64}$/;

function v23Record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${code}_RECORD_INVALID`);
  }
  return value as Record<string, unknown>;
}

function v23ExactKeys(value: Record<string, unknown>, keys: string[], code: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${code}_SCHEMA_INVALID`);
  }
}

function v23String(value: unknown, code: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${code}_INVALID`);
  return value;
}

function v23Hash(value: unknown, code: string) {
  const hash = v23String(value, code);
  if (!V23_HASH.test(hash)) throw new Error(`${code}_INVALID`);
  return hash;
}

function v23Revision(value: unknown, code: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${code}_INVALID`);
  return value as number;
}

function v23Array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${code}_ARRAY_INVALID`);
  return value;
}

function validateV23StableRef(value: unknown, code: string) {
  const entry = v23Record(value, code);
  v23ExactKeys(entry, ["id", "revision", "contentHash"], code);
  const id = v23String(entry.id, `${code}_ID`);
  const revision = v23Revision(entry.revision, `${code}_REVISION`);
  const contentHash = v23Hash(entry.contentHash, `${code}_CONTENT_HASH`);
  return { id, revision, contentHash };
}

function v23HashOf(value: unknown, supplied: unknown, code: string) {
  const hash = v23Hash(supplied, code);
  if (hash !== jcsSha256Hex(value)) throw new Error(`${code}_MISMATCH`);
  return hash;
}

function v23PartInput(entry: Record<string, unknown>) {
  const input = { ...entry };
  delete input.inputFingerprint;
  delete input.contentHash;
  return input;
}

function v23SkuInput(entry: Record<string, unknown>) {
  const input = { ...entry };
  delete input.contentHash;
  return input;
}

const V23_QUALITY_IDS = new Set(["quality_c_green", "quality_b_blue", "quality_a_purple", "quality_s_orange"]);

function validateV23ProjectAffixPayload(value: unknown, affixId: string, revision: number) {
  const payload = v23Record(value, "V23_AFFIX_PAYLOAD");
  const common = ["name", "category", "itemPartId", "semanticContributionKey", "stackingPolicy", "generationPolicy", "rarity", "valueScore", "tags", "description", "enabled", "operations", "passivePayload"];
  v23ExactKeys(payload, common, "V23_AFFIX_PAYLOAD");
  v23String(payload.name, "V23_AFFIX_NAME"); v23String(payload.itemPartId, "V23_AFFIX_ITEM_PART"); v23String(payload.semanticContributionKey, "V23_AFFIX_SEMANTIC_CONTRIBUTION_KEY"); v23String(payload.description, "V23_AFFIX_DESCRIPTION");
  if (!(["attribute", "passive"] as const).includes(payload.category as never) || !(["dedupe", "stack"] as const).includes(payload.stackingPolicy as never) || !(["normal", "technology_only", "style_only"] as const).includes(payload.generationPolicy as never) || !(["common", "uncommon", "rare", "ultra_rare", "epic"] as const).includes(payload.rarity as never) || !Number.isFinite(payload.valueScore) || typeof payload.enabled !== "boolean") throw new Error("V23_AFFIX_PAYLOAD_INVALID");
  const tags = v23Array(payload.tags, "V23_AFFIX_TAGS").map((tag) => v23String(tag, "V23_AFFIX_TAG")); if (new Set(tags).size !== tags.length) throw new Error("V23_AFFIX_TAG_DUPLICATE");
  const operations = v23Array(payload.operations, "V23_AFFIX_OPERATIONS"); const ids = new Set<string>(); const indexes = new Set<number>();
  for (const value of operations) {
    const operation = v23Record(value, "V23_AFFIX_OPERATION");
    const kind = v23String(operation.operation, "V23_AFFIX_OPERATION_KIND");
    const keys = kind === "set" || kind === "enum_add" ? ["operationId", "operationIndex", "sourceAffixId", "sourceAffixRevision", "parameterKey", "operation", "value"] : kind === "clamp_add" ? ["operationId", "operationIndex", "sourceAffixId", "sourceAffixRevision", "parameterKey", "operation", "direction", "magnitude", "clampMin", "clampMax"] : ["operationId", "operationIndex", "sourceAffixId", "sourceAffixRevision", "parameterKey", "operation", "direction", "magnitude"];
    v23ExactKeys(operation, keys, "V23_AFFIX_OPERATION");
    const id = v23String(operation.operationId, "V23_AFFIX_OPERATION_ID"); const index = operation.operationIndex;
    if (ids.has(id) || indexes.has(index as number) || !Number.isSafeInteger(index) || (index as number) < 0 || operation.sourceAffixId !== affixId || operation.sourceAffixRevision !== revision || !["percent_adjust", "flat_adjust", "clamp_add", "enum_add", "set"].includes(kind) || typeof operation.parameterKey !== "string" || !operation.parameterKey) throw new Error("V23_AFFIX_OPERATION_INVALID");
    ids.add(id); indexes.add(index as number);
    if ((kind === "set" && (!(["string", "number", "boolean"] as const).includes(typeof operation.value as never) || (typeof operation.value === "number" && !Number.isFinite(operation.value)))) || (kind === "enum_add" && (typeof operation.value !== "string" || !operation.value))) throw new Error("V23_AFFIX_OPERATION_VALUE_INVALID");
    const magnitude = operation.magnitude as number; const clampMin = operation.clampMin as number; const clampMax = operation.clampMax as number;
    if (["percent_adjust", "flat_adjust", "clamp_add"].includes(kind) && (!( ["increase", "decrease"] as const).includes(operation.direction as never) || !Number.isFinite(magnitude) || magnitude < 0 || (kind === "clamp_add" && (!Number.isFinite(clampMin) || !Number.isFinite(clampMax) || clampMin > clampMax)))) throw new Error("V23_AFFIX_OPERATION_BOUNDS_INVALID");
  }
  if (payload.category === "attribute" && (payload.passivePayload !== null || operations.length === 0)) throw new Error("V23_AFFIX_CATEGORY_PAYLOAD_MISMATCH");
  if (payload.category === "passive") { if (operations.length !== 0) throw new Error("V23_AFFIX_CATEGORY_PAYLOAD_MISMATCH"); const passive = v23Record(payload.passivePayload, "V23_AFFIX_PASSIVE"); v23ExactKeys(passive, ["skillId", "name", "itemPartId", "triggerType", "triggerDescription", "effectTarget", "effectLogicDescription", "exampleParameters", "durationDescription", "cooldownDescription", "resetDescription", "stackingDescription", "playerDescription", "simulatorReferenceKey"], "V23_AFFIX_PASSIVE"); for (const key of ["skillId","name","itemPartId","triggerType","triggerDescription","effectTarget","effectLogicDescription","durationDescription","cooldownDescription","resetDescription","stackingDescription","playerDescription"]) v23String(passive[key], "V23_AFFIX_PASSIVE_FIELD"); const parameters = v23Record(passive.exampleParameters, "V23_AFFIX_PASSIVE_PARAMETERS"); if (Object.values(parameters).some((item) => !(["string", "boolean", "number"] as const).includes(typeof item as never) || (typeof item === "number" && !Number.isFinite(item)))) throw new Error("V23_AFFIX_PASSIVE_PARAMETERS_INVALID"); if (passive.itemPartId !== payload.itemPartId || !(passive.simulatorReferenceKey === null || (typeof passive.simulatorReferenceKey === "string" && passive.simulatorReferenceKey.length > 0))) throw new Error("V23_AFFIX_PASSIVE_INVALID"); }
  return payload;
}

function validateV23RuntimeState(state: MutableWorkspace) {
  const parts = v23Array(state.v23SeriesPartRevisions, "V23_SERIES_PARTS");
  const heads = v23Array(state.v23SeriesPartHeads, "V23_SERIES_PART_HEADS");
  const skus = v23Array(state.v23SkuDrawerRevisions, "V23_SKUS");
  const skuHeads = v23Array(state.v23SkuDrawerHeads, "V23_SKU_HEADS");
  const affixes = v23Array(state.v23AffixDefinitions, "V23_AFFIX_DEFINITIONS");
  const evidence = v23Array(state.v23MigrationSourceEvidence, "V23_SOURCE_EVIDENCE");
  const adapters = v23Array(state.v23LegacyReadAdapters, "V23_LEGACY_ADAPTERS");
  const seriesIds = new Set<string>();
  for (const value of arrayOf<unknown>(state.seriesDefinitions)) {
    const series = v23Record(value, "V23_SERIES");
    if (typeof series.id !== "string" || series.id.length === 0) continue;
    const id = series.id;
    if (seriesIds.has(id)) throw new Error("V23_PART_SERIES_DUPLICATE");
    seriesIds.add(id);
  }

  const affixRefs = new Map<string, Map<number, { contentHash: string; payload: Record<string, unknown> }>>();
  for (const value of affixes) {
    const entry = v23Record(value, "V23_AFFIX_DEFINITION");
    v23ExactKeys(entry, ["affixId", "revision", "contentHash", "payload"], "V23_AFFIX_DEFINITION");
    const id = v23String(entry.affixId, "V23_AFFIX_ID");
    const revision = v23Revision(entry.revision, "V23_AFFIX_REVISION");
    const payload = validateV23ProjectAffixPayload(entry.payload, id, revision);
    const hash = v23HashOf({ affixId: id, revision, payload: entry.payload }, entry.contentHash, "V23_AFFIX_CONTENT_HASH");
    const revisions = affixRefs.get(id) ?? new Map<number, { contentHash: string; payload: Record<string, unknown> }>();
    if (revisions.has(revision)) throw new Error("V23_AFFIX_ID_REVISION_DUPLICATE");
    revisions.set(revision, { contentHash: hash, payload });
    affixRefs.set(id, revisions);
  }
  const resolveAffixRef = (ref: { id: string; revision: number; contentHash: string }) => {
    const resolved = affixRefs.get(ref.id)?.get(ref.revision);
    return resolved?.contentHash === ref.contentHash ? resolved : undefined;
  };
  const itemPartIdFor = (partType: unknown) => ({ rod: "part:rod", reel: "part:reel", line: "part:line" } as const)[partType as "rod" | "reel" | "line"];
  // Phase A has no immutable v23 Technology registry. Legacy Technology
  // objects cannot be JCS-parsed into an authority that resolves new refs.
  const validateTechnologyRef = (value: unknown, code: string) => {
    validateV23StableRef(value, code);
    throw new Error("V23_TECHNOLOGY_REGISTRY_UNAVAILABLE");
  };

  const assertSemanticContribution = (seen: Map<string, Set<string>>, payload: Record<string, unknown>, code: string) => {
    const contributionKey = payload.semanticContributionKey as string;
    const policy = payload.stackingPolicy as string;
    const existing = seen.get(contributionKey);
    if (existing && (policy !== "stack" || existing.has("dedupe"))) throw new Error(`${code}_SEMANTIC_CONTRIBUTION_CONFLICT`);
    if (existing) existing.add(policy);
    else seen.set(contributionKey, new Set([policy]));
  };
  const partByIdAndRevision = new Map<string, Map<number, Record<string, unknown>>>();
  const partDefaultPayloads = new Map<string, Map<string, Record<string, unknown>>>();
  const partSeriesById = new Map<string, string>();
  for (const value of parts) {
    const entry = v23Record(value, "V23_SERIES_PART");
    v23ExactKeys(entry, ["partId", "seriesId", "revision", "partType", "fishingMethodId", "materialTypeId", "functionProfileId", "functionIntensity", "weightBandIds", "defaultEntryRefs", "technologyRefs", "inputFingerprint", "contentHash"], "V23_SERIES_PART");
    const partId = v23String(entry.partId, "V23_PART_ID");
    const seriesId = v23String(entry.seriesId, "V23_PART_SERIES_ID");
    if (!seriesIds.has(seriesId)) throw new Error("V23_PART_SERIES_UNRESOLVED");
    const revision = v23Revision(entry.revision, "V23_PART_REVISION");
    if (!(["rod", "reel", "line"] as const).includes(entry.partType as "rod" | "reel" | "line")) throw new Error("V23_PART_TYPE_INVALID");
    v23String(entry.fishingMethodId, "V23_PART_METHOD_ID");
    v23String(entry.materialTypeId, "V23_PART_MATERIAL_ID");
    v23String(entry.functionProfileId, "V23_PART_FUNCTION_ID");
    if (![1, 2, 3].includes(entry.functionIntensity as number)) throw new Error("V23_PART_FUNCTION_INTENSITY_INVALID");
    const weightBandIds = v23Array(entry.weightBandIds, "V23_PART_WEIGHT_BANDS").map((id) => v23String(id, "V23_PART_WEIGHT_BAND_ID"));
    if (new Set(weightBandIds).size !== weightBandIds.length) throw new Error("V23_PART_WEIGHT_BAND_DUPLICATE");
    const partDefaultEntryIds = new Set<string>();
    const partDefaults = new Map<string, Record<string, unknown>>();
    const partDefaultContributions = new Map<string, Set<string>>();
    for (const value of v23Array(entry.defaultEntryRefs, "V23_PART_DEFAULT_ENTRIES")) {
      const ref = validateV23StableRef(value, "V23_PART_DEFAULT_ENTRY");
      if (partDefaultEntryIds.has(ref.id)) throw new Error("V23_PART_DEFAULT_ENTRY_ID_DUPLICATE");
      partDefaultEntryIds.add(ref.id);
      const resolved = resolveAffixRef(ref);
      if (!resolved) throw new Error("V23_PART_DEFAULT_ENTRY_UNRESOLVED");
      if (resolved.payload.itemPartId !== itemPartIdFor(entry.partType)) throw new Error("V23_PART_DEFAULT_ENTRY_ITEM_PART_MISMATCH");
      assertSemanticContribution(partDefaultContributions, resolved.payload, "V23_PART_DEFAULT_ENTRY");
      partDefaults.set(ref.id, resolved.payload);
    }
    for (const ref of v23Array(entry.technologyRefs, "V23_PART_TECHNOLOGIES")) validateTechnologyRef(ref, "V23_PART_TECHNOLOGY");
    const partMap = partByIdAndRevision.get(partId) ?? new Map<number, Record<string, unknown>>();
    if (partMap.has(revision)) throw new Error("V23_PART_ID_REVISION_DUPLICATE");
    if (partSeriesById.has(partId) && partSeriesById.get(partId) !== seriesId) throw new Error("V23_PART_SERIES_ID_UNSTABLE");
    partSeriesById.set(partId, seriesId);
    partMap.set(revision, entry);
    partByIdAndRevision.set(partId, partMap);
    partDefaultPayloads.set(`${partId}\u0000${revision}`, partDefaults);
    const input = v23PartInput(entry);
    v23HashOf(input, entry.inputFingerprint, "V23_PART_INPUT_FINGERPRINT");
    v23HashOf({ ...input, inputFingerprint: entry.inputFingerprint }, entry.contentHash, "V23_PART_CONTENT_HASH");
  }
  const currentPartsBySeries = new Map<string, Record<string, unknown>[]>();
  const seenHeads = new Set<string>();
  for (const value of heads) {
    const head = v23Record(value, "V23_SERIES_PART_HEAD");
    v23ExactKeys(head, ["seriesId", "partId", "revision"], "V23_SERIES_PART_HEAD");
    const seriesId = v23String(head.seriesId, "V23_SERIES_PART_HEAD_SERIES_ID");
    const partId = v23String(head.partId, "V23_SERIES_PART_HEAD_PART_ID");
    const revision = v23Revision(head.revision, "V23_SERIES_PART_HEAD_REVISION");
    const identity = `${seriesId}\u0000${partId}`;
    if (seenHeads.has(identity)) throw new Error("V23_SERIES_PART_HEAD_DUPLICATE");
    seenHeads.add(identity);
    const current = partByIdAndRevision.get(partId)?.get(revision);
    if (!current || current.seriesId !== seriesId) throw new Error("V23_SERIES_PART_HEAD_UNRESOLVED");
    const group = currentPartsBySeries.get(seriesId) ?? []; group.push(current); currentPartsBySeries.set(seriesId, group);
  }
  if (parts.length && heads.length === 0) throw new Error("V23_SERIES_PART_HEAD_REQUIRED");
  for (const [partId, seriesId] of partSeriesById) {
    if (!seenHeads.has(`${seriesId}\u0000${partId}`)) throw new Error("V23_SERIES_PART_HEAD_REQUIRED");
  }
  for (const group of currentPartsBySeries.values()) {
    if (group.length < 1 || group.length > 3) throw new Error("V23_SERIES_PART_COUNT_INVALID");
    const kinds = new Set(group.map((entry) => entry.partType));
    if (kinds.size !== group.length) throw new Error("V23_SERIES_PART_TYPE_DUPLICATE");
  }

  const localCopyOwners = new Map<string, string>(); let revisionCopyIds = new Set<string>();
  const validateAffixEntry = (value: unknown, code: string, expectedItemPartId: string): Record<string, unknown> => {
    const entry = v23Record(value, code);
    if (entry.kind === "STABLE_AFFIX_REF") {
      v23ExactKeys(entry, ["kind", "ref"], code);
      const ref = validateV23StableRef(entry.ref, `${code}_REF`);
      const resolved = resolveAffixRef(ref);
      if (!resolved) throw new Error(`${code}_REF_UNRESOLVED`);
      if (resolved.payload.itemPartId !== expectedItemPartId) throw new Error(`${code}_ITEM_PART_MISMATCH`);
      return resolved.payload;
    }
    if (entry.kind === "LOCAL_AFFIX_COPY") {
      v23ExactKeys(entry, ["kind", "localCopyId", "sourceRef", "payload", "copyHash"], code);
      const copyId = v23String(entry.localCopyId, `${code}_COPY_ID`);
      if (revisionCopyIds.has(copyId)) throw new Error("V23_LOCAL_COPY_ID_DUPLICATE");
      revisionCopyIds.add(copyId);
      const owner = localCopyOwners.get(copyId);
      if (owner !== undefined && owner !== currentSkuId) throw new Error("V23_LOCAL_COPY_ID_OWNER_CONFLICT");
      localCopyOwners.set(copyId, currentSkuId);
      const ref = validateV23StableRef(entry.sourceRef, `${code}_SOURCE_REF`);
      const resolved = resolveAffixRef(ref);
      if (!resolved) throw new Error(`${code}_SOURCE_REF_UNRESOLVED`);
      const localPayload = validateV23ProjectAffixPayload(entry.payload, ref.id, ref.revision);
      if (resolved.payload.itemPartId !== expectedItemPartId || localPayload.itemPartId !== expectedItemPartId) throw new Error(`${code}_ITEM_PART_MISMATCH`);
      v23HashOf({ localCopyId: copyId, sourceRef: ref, payload: entry.payload }, entry.copyHash, `${code}_COPY_HASH`);
      return localPayload;
    }
    throw new Error(`${code}_KIND_INVALID`);
  };
  const skuIds = new Map<string, Set<number>>(); let currentSkuId = "";
  for (const value of skus) {
    const entry = v23Record(value, "V23_SKU");
    v23ExactKeys(entry, ["skuId", "revision", "seriesId", "partId", "partRevision", "weightBandId", "match", "removedInheritedEntryIds", "addedEntryRefs", "localEntryCopies", "technologyRefs", "quality", "skuPatchIds", "modelIds", "defaultModelId", "displayOrder", "validationSummary", "status", "contentHash"], "V23_SKU");
    const skuId = v23String(entry.skuId, "V23_SKU_ID");
    currentSkuId = skuId;
    revisionCopyIds = new Set<string>();
    const revision = v23Revision(entry.revision, "V23_SKU_REVISION");
    const revisions = skuIds.get(skuId) ?? new Set<number>();
    if (revisions.has(revision)) throw new Error("V23_SKU_ID_REVISION_DUPLICATE");
    revisions.add(revision); skuIds.set(skuId, revisions);
    const seriesId = v23String(entry.seriesId, "V23_SKU_SERIES_ID");
    const partId = v23String(entry.partId, "V23_SKU_PART_ID");
    const partRevision = v23Revision(entry.partRevision, "V23_SKU_PART_REVISION");
    const part = partByIdAndRevision.get(partId)?.get(partRevision);
    if (!part || part.seriesId !== seriesId) throw new Error("V23_SKU_PART_UNRESOLVED");
    const weightBandId = v23String(entry.weightBandId, "V23_SKU_WEIGHT_BAND_ID");
    if (!v23Array(part.weightBandIds, "V23_SKU_PART_WEIGHT_BANDS").includes(weightBandId)) throw new Error("V23_SKU_WEIGHT_BAND_UNDECLARED");
    const skuPatchIds = v23Array(entry.skuPatchIds, "V23_SKU_PATCH_IDS").map((id) => v23String(id, "V23_SKU_PATCH_ID"));
    if (new Set(skuPatchIds).size !== skuPatchIds.length) throw new Error("V23_SKU_PATCH_ID_DUPLICATE");
    const modelIds = v23Array(entry.modelIds, "V23_SKU_MODEL_IDS").map((id) => v23String(id, "V23_SKU_MODEL_ID"));
    if (new Set(modelIds).size !== modelIds.length) throw new Error("V23_SKU_MODEL_ID_DUPLICATE");
    if (entry.defaultModelId !== null) v23String(entry.defaultModelId, "V23_SKU_DEFAULT_MODEL_ID");
    if (skuPatchIds.length !== 0 || modelIds.length !== 0 || entry.defaultModelId !== null) throw new Error("V23_SKU_ASSOCIATION_RESOLVER_UNAVAILABLE");
    if (!Number.isSafeInteger(entry.displayOrder) || (entry.displayOrder as number) < 0) throw new Error("V23_SKU_DISPLAY_ORDER_INVALID");
    for (const issue of v23Array(entry.validationSummary, "V23_SKU_VALIDATION_SUMMARY")) {
      const summary = v23Record(issue, "V23_SKU_VALIDATION_ISSUE");
      v23ExactKeys(summary, ["code", "severity", "gate", "state", "message"], "V23_SKU_VALIDATION_ISSUE");
      v23String(summary.code, "V23_SKU_VALIDATION_CODE"); v23String(summary.message, "V23_SKU_VALIDATION_MESSAGE");
      if (!(["INFO", "WARNING", "ERROR", "BLOCKER"] as const).includes(summary.severity as never) || !(["NONE", "REVIEW", "PUBLISH", "EXPORT"] as const).includes(summary.gate as never) || !(["OPEN", "ACKNOWLEDGED", "RESOLVED", "WAIVED", "STALE"] as const).includes(summary.state as never)) throw new Error("V23_SKU_VALIDATION_ISSUE_INVALID");
      if (summary.severity === "BLOCKER" && summary.state === "WAIVED") throw new Error("V23_SKU_VALIDATION_BLOCKER_WAIVED");
    }
    if (!(["draft", "approved", "published", "superseded"] as const).includes(entry.status as never)) throw new Error("V23_SKU_STATUS_INVALID");
    if (!["draft", "superseded"].includes(entry.status as string)) throw new Error("V23_SKU_LIFECYCLE_UNAVAILABLE");
    const match = v23Record(entry.match, "V23_SKU_MATCH");
    const status = v23String(match.status, "V23_SKU_MATCH_STATUS");
    const validateKey = (value: unknown, code: string) => {
      const key = v23Record(value, code);
      v23ExactKeys(key, ["partType", "weightBandId", "fishingMethodId", "materialTypeId", "functionProfileId", "functionIntensity"], code);
      if (!( ["rod", "reel", "line"] as const).includes(key.partType as "rod" | "reel" | "line") || key.weightBandId !== weightBandId || key.fishingMethodId !== part.fishingMethodId || key.materialTypeId !== part.materialTypeId || key.functionProfileId !== part.functionProfileId || key.functionIntensity !== part.functionIntensity) throw new Error("V23_SKU_MATCHED_KEY_MISMATCH");
      return key;
    };
    if (status === "VALID") {
      v23ExactKeys(match, ["status", "functionTemplateRef", "matchedKey", "inputFingerprint"], "V23_SKU_MATCH");
      const template = v23Record(match.functionTemplateRef, "V23_TEMPLATE_REF");
      v23ExactKeys(template, ["templateId", "revisionId", "contentHash"], "V23_TEMPLATE_REF");
      v23String(template.templateId, "V23_TEMPLATE_ID");
      v23String(template.revisionId, "V23_TEMPLATE_REVISION_ID");
      v23Hash(template.contentHash, "V23_TEMPLATE_CONTENT_HASH");
      const key = validateKey(match.matchedKey, "V23_SKU_MATCHED_KEY");
      v23HashOf(key, match.inputFingerprint, "V23_SKU_INPUT_FINGERPRINT");
      throw new Error("V23_TEMPLATE_REGISTRY_UNAVAILABLE");
    } else if (["INVALID_NO_MATCH", "INVALID_AMBIGUOUS"].includes(status)) {
      v23ExactKeys(match, ["status", "attemptedKey", "inputFingerprint"], "V23_SKU_MATCH");
      const key = validateKey(match.attemptedKey, "V23_SKU_ATTEMPTED_KEY");
      v23HashOf(key, match.inputFingerprint, "V23_SKU_INPUT_FINGERPRINT");
    } else if (status === "NEEDS_MIGRATION_REVIEW") {
      v23ExactKeys(match, ["status"], "V23_SKU_MATCH");
    } else throw new Error("V23_SKU_MATCH_STATUS_INVALID");
    const removed = v23Array(entry.removedInheritedEntryIds, "V23_SKU_REMOVED_ENTRIES");
    const removedEntryIds = new Set(removed.map((id) => v23String(id, "V23_SKU_REMOVED_ENTRY_ID")));
    if (removedEntryIds.size !== removed.length) throw new Error("V23_SKU_REMOVED_ENTRY_DUPLICATE");
    const effectiveContributions = new Map<string, Set<string>>();
    for (const [inheritedId, payload] of partDefaultPayloads.get(`${partId}\u0000${partRevision}`) ?? []) {
      if (!removedEntryIds.has(inheritedId)) assertSemanticContribution(effectiveContributions, payload, "V23_SKU_INHERITED_ENTRY");
    }
    const skuAddedEntryIds = new Set<string>();
    for (const refEntry of v23Array(entry.addedEntryRefs, "V23_SKU_ADDED_ENTRY_REFS")) {
      const stableEntry = v23Record(refEntry, "V23_SKU_ADDED_ENTRY_REF");
      if (stableEntry.kind !== "STABLE_AFFIX_REF") throw new Error("V23_SKU_ADDED_ENTRY_REF_KIND_INVALID");
      const ref = validateV23StableRef(stableEntry.ref, "V23_SKU_ADDED_ENTRY_REF_REF");
      if (skuAddedEntryIds.has(ref.id)) throw new Error("V23_SKU_ADDED_ENTRY_REF_ID_DUPLICATE");
      skuAddedEntryIds.add(ref.id);
      assertSemanticContribution(effectiveContributions, validateAffixEntry(stableEntry, "V23_SKU_ADDED_ENTRY_REF", itemPartIdFor(part.partType)!), "V23_SKU_ADDED_ENTRY_REF");
    }
    for (const copy of v23Array(entry.localEntryCopies, "V23_SKU_LOCAL_COPIES")) {
      const copyEntry = v23Record(copy, "V23_SKU_LOCAL_COPY");
      if (copyEntry.kind !== "LOCAL_AFFIX_COPY") throw new Error("V23_SKU_LOCAL_COPY_KIND_INVALID");
      assertSemanticContribution(effectiveContributions, validateAffixEntry(copyEntry, "V23_SKU_LOCAL_COPY", itemPartIdFor(part.partType)!), "V23_SKU_LOCAL_COPY");
    }
    for (const ref of v23Array(entry.technologyRefs, "V23_SKU_TECHNOLOGIES")) validateTechnologyRef(ref, "V23_SKU_TECHNOLOGY");
    const quality = v23Record(entry.quality, "V23_SKU_QUALITY");
    const qualityStatus = v23String(quality.status, "V23_SKU_QUALITY_STATUS");
    if (qualityStatus === "UNASSESSED") v23ExactKeys(quality, ["status"], "V23_SKU_QUALITY");
    else if (qualityStatus === "NO_RECOMMENDATION") { v23ExactKeys(quality, ["status", "qualityId", "reason"], "V23_SKU_QUALITY"); if (!V23_QUALITY_IDS.has(v23String(quality.qualityId, "V23_SELECTED_QUALITY_ID")) || !v23String(quality.reason, "V23_QUALITY_NO_RECOMMENDATION_REASON")) throw new Error("V23_SKU_QUALITY_INVALID"); }
    else if (qualityStatus === "MATCHED") { v23ExactKeys(quality, ["status", "qualityId"], "V23_SKU_QUALITY"); if (!V23_QUALITY_IDS.has(v23String(quality.qualityId, "V23_SKU_QUALITY_ID"))) throw new Error("V23_SKU_QUALITY_ID_INVALID"); }
    else if (qualityStatus === "OVERRIDDEN") { v23ExactKeys(quality, ["status", "recommendedQualityId", "qualityId", "reason"], "V23_SKU_QUALITY"); if (!V23_QUALITY_IDS.has(v23String(quality.recommendedQualityId, "V23_RECOMMENDED_QUALITY_ID")) || !V23_QUALITY_IDS.has(v23String(quality.qualityId, "V23_SELECTED_QUALITY_ID")) || quality.recommendedQualityId === quality.qualityId || !v23String(quality.reason, "V23_QUALITY_OVERRIDE_REASON")) throw new Error("V23_SKU_QUALITY_INVALID"); }
    else throw new Error("V23_SKU_QUALITY_STATUS_INVALID");
    v23HashOf(v23SkuInput(entry), entry.contentHash, "V23_SKU_CONTENT_HASH");
  }

  const seenSkuHeads = new Set<string>();
  for (const value of skuHeads) {
    const head = v23Record(value, "V23_SKU_HEAD");
    v23ExactKeys(head, ["skuId", "revision"], "V23_SKU_HEAD");
    const skuId = v23String(head.skuId, "V23_SKU_HEAD_ID");
    const revision = v23Revision(head.revision, "V23_SKU_HEAD_REVISION");
    if (seenSkuHeads.has(skuId)) throw new Error("V23_SKU_HEAD_DUPLICATE");
    seenSkuHeads.add(skuId);
    if (!skuIds.get(skuId)?.has(revision)) throw new Error("V23_SKU_HEAD_UNRESOLVED");
  }
  if (skus.length && skuHeads.length === 0) throw new Error("V23_SKU_HEAD_REQUIRED");
  for (const skuId of skuIds.keys()) if (!seenSkuHeads.has(skuId)) throw new Error("V23_SKU_HEAD_REQUIRED");

  const evidenceIds = new Set<string>();
  const evidencePayloads = new Map<string, Record<string, unknown>>();
  for (const value of evidence) {
    const entry = v23Record(value, "V23_SOURCE_EVIDENCE");
    v23ExactKeys(entry, ["sourceEvidenceId", "sourceSchemaVersion", "rawWorkspacePayload", "rawWorkspacePayloadHash"], "V23_SOURCE_EVIDENCE");
    const id = v23String(entry.sourceEvidenceId, "V23_SOURCE_EVIDENCE_ID");
    if (evidenceIds.has(id)) throw new Error("V23_SOURCE_EVIDENCE_ID_DUPLICATE");
    evidenceIds.add(id);
    const sourceSchemaVersion = v23Revision(entry.sourceSchemaVersion, "V23_SOURCE_SCHEMA_VERSION");
    if (sourceSchemaVersion >= CURRENT_WORKSPACE_SCHEMA_VERSION) throw new Error("V23_SOURCE_SCHEMA_VERSION_UNSUPPORTED");
    const raw = v23Record(entry.rawWorkspacePayload, "V23_SOURCE_PAYLOAD");
    const rawDeclaresSchemaVersion = Object.prototype.hasOwnProperty.call(raw, "schemaVersion");
    if (!(sourceSchemaVersion === 1 && !rawDeclaresSchemaVersion) && raw.schemaVersion !== sourceSchemaVersion) throw new Error("V23_SOURCE_SCHEMA_VERSION_MISMATCH");
    const hash = v23String(entry.rawWorkspacePayloadHash, "V23_SOURCE_PAYLOAD_HASH");
    // Existing workspace deterministicHash is an 8-hex content contract, not
    // the new v23 64-hex stable-reference contract.
    if (hash !== deterministicHash(entry.rawWorkspacePayload)) throw new Error("V23_SOURCE_PAYLOAD_HASH_MISMATCH");
    evidencePayloads.set(id, raw);
  }

  const adapterIds = new Set<string>();
  const adapterTargetSkuIds = new Set<string>();
  const coveredLegacySources = new Map<string, Set<string>>();
  for (const value of adapters) {
    const entry = v23Record(value, "V23_LEGACY_ADAPTER");
    v23ExactKeys(entry, ["adapterId", "kind", "sourceEvidenceId", "targetSkuId", "sourceKind", "sourceRecordId", "rawSourcePayload", "sourceSeriesId", "rawSeriesPayload", "diagnosticCodes", "status"], "V23_LEGACY_ADAPTER");
    const id = v23String(entry.adapterId, "V23_LEGACY_ADAPTER_ID");
    if (adapterIds.has(id)) throw new Error("V23_LEGACY_ADAPTER_ID_DUPLICATE");
    adapterIds.add(id);
    if (entry.kind !== "LEGACY_NEEDS_REVIEW" || entry.status !== "NEEDS_REVIEW") throw new Error("V23_LEGACY_ADAPTER_DISCRIMINANT_INVALID");
    const sourceEvidenceId = v23String(entry.sourceEvidenceId, "V23_LEGACY_ADAPTER_EVIDENCE_ID");
    if (!evidenceIds.has(sourceEvidenceId)) throw new Error("V23_LEGACY_ADAPTER_EVIDENCE_UNRESOLVED");
    if (entry.sourceSeriesId !== null) v23String(entry.sourceSeriesId, "V23_LEGACY_ADAPTER_SERIES_ID");
    const targetSkuId = v23String(entry.targetSkuId, "V23_LEGACY_ADAPTER_TARGET_SKU_ID");
    const sourceKind = v23String(entry.sourceKind, "V23_LEGACY_ADAPTER_SOURCE_KIND");
    const sourceRecordId = v23String(entry.sourceRecordId, "V23_LEGACY_ADAPTER_SOURCE_RECORD_ID");
    const diagnostics = v23Array(entry.diagnosticCodes, "V23_LEGACY_ADAPTER_DIAGNOSTICS");
    if (!diagnostics.length || new Set(diagnostics).size !== diagnostics.length) throw new Error("V23_LEGACY_ADAPTER_DIAGNOSTICS_INVALID");
    const allowed = new Set(["V23_SERIES_UNRESOLVED", "V23_PART_UNRESOLVED", "V23_WEIGHT_BAND_UNRESOLVED", "V23_FUNCTION_TEMPLATE_UNRESOLVED"]);
    if (diagnostics.some((code) => typeof code !== "string" || !allowed.has(code))) throw new Error("V23_LEGACY_ADAPTER_DIAGNOSTICS_INVALID");
    if ((entry.sourceSeriesId === null) !== (entry.rawSeriesPayload === null)) throw new Error("V23_LEGACY_ADAPTER_SERIES_CHAIN_INVALID");
    if ((entry.sourceSeriesId === null) !== diagnostics.includes("V23_SERIES_UNRESOLVED")) throw new Error("V23_LEGACY_ADAPTER_SERIES_DIAGNOSTIC_INVALID");
    const sourceCollection = sourceKind === "LEGACY_SKU_DRAWER" ? "skuDrawers" : sourceKind === "LEGACY_OFFICIAL_SKU" ? "officialSkus" : null;
    if (!sourceCollection) throw new Error("V23_LEGACY_ADAPTER_SOURCE_KIND_INVALID");
    const sources = arrayOf<unknown>(evidencePayloads.get(sourceEvidenceId)?.[sourceCollection]).filter((candidate) => v23Record(candidate, "V23_LEGACY_SOURCE_SKU").id === sourceRecordId);
    const rawSource = v23Record(entry.rawSourcePayload, "V23_LEGACY_ADAPTER_RAW_SOURCE");
    if (sources.length !== 1 || jcsSha256Hex(sources[0]) !== jcsSha256Hex(rawSource)) throw new Error("V23_LEGACY_ADAPTER_SKU_CHAIN_INVALID");
    const sourceIdentity = `${sourceKind}\u0000${sourceRecordId}`;
    const covered = coveredLegacySources.get(sourceEvidenceId) ?? new Set<string>();
    if (covered.has(sourceIdentity)) throw new Error("V23_LEGACY_ADAPTER_SOURCE_DUPLICATE");
    covered.add(sourceIdentity); coveredLegacySources.set(sourceEvidenceId, covered);
    // Must exactly mirror legacy-product-migration.ts stableId("legacy-sku-drawer:", official.id).
    if ((sourceKind === "LEGACY_SKU_DRAWER" && targetSkuId !== sourceRecordId) || (sourceKind === "LEGACY_OFFICIAL_SKU" && targetSkuId !== `legacy-sku-drawer:${deterministicHash(sourceRecordId).slice(0, 12)}`)) throw new Error("V23_LEGACY_ADAPTER_TARGET_SKU_INVALID");
    if (adapterTargetSkuIds.has(targetSkuId)) throw new Error("V23_LEGACY_ADAPTER_TARGET_SKU_DUPLICATE");
    adapterTargetSkuIds.add(targetSkuId);
    if (entry.sourceSeriesId !== null) {
      const rawSeries = v23Record(entry.rawSeriesPayload, "V23_LEGACY_ADAPTER_RAW_SERIES");
      if (rawSeries.id !== entry.sourceSeriesId) throw new Error("V23_LEGACY_ADAPTER_SERIES_CHAIN_INVALID");
      const sources = arrayOf<unknown>(evidencePayloads.get(sourceEvidenceId)?.seriesDefinitions).filter((candidate) => v23Record(candidate, "V23_LEGACY_SOURCE_SERIES").id === entry.sourceSeriesId);
      if (sources.length !== 1 || jcsSha256Hex(sources[0]) !== jcsSha256Hex(rawSeries)) throw new Error("V23_LEGACY_ADAPTER_SERIES_CHAIN_INVALID");
    }
  }
  for (const [evidenceId, raw] of evidencePayloads) {
    const covered = coveredLegacySources.get(evidenceId) ?? new Set<string>();
    for (const [collection, sourceKind] of [["skuDrawers", "LEGACY_SKU_DRAWER"], ["officialSkus", "LEGACY_OFFICIAL_SKU"]] as const) {
      const sourceIds = new Set<string>();
      for (const candidate of arrayOf<unknown>(raw[collection])) {
        const source = v23Record(candidate, "V23_LEGACY_SOURCE_SKU");
        if (typeof source.id !== "string" || source.id.length === 0) throw new Error("V23_LEGACY_ADAPTER_SOURCE_COVERAGE_INVALID");
        if (sourceIds.has(source.id)) throw new Error("V23_LEGACY_ADAPTER_SOURCE_COVERAGE_INVALID");
        sourceIds.add(source.id);
        if (!covered.has(`${sourceKind}\u0000${source.id}`)) throw new Error("V23_LEGACY_ADAPTER_SOURCE_COVERAGE_INVALID");
      }
    }
  }
}

/**
 * Phase A creates only read adapters. v22 has target-pull / nearest-projection
 * data, but no authoritative Part, weight-band, or 04.5 template identity.
 * Keeping that ambiguity explicit is safer than manufacturing a v23 SKU.
 */
function migrateV22ToV23(input: MutableWorkspace, context: MigrationContext): MutableWorkspace {
  const sourceEvidenceId = `v23-source:schema-${context.initialSchemaVersion}`;
  const sourceEvidence: V23MigrationSourceEvidence = {
    sourceEvidenceId,
    sourceSchemaVersion: context.initialSchemaVersion,
    rawWorkspacePayload: structuredClone(context.originalInput),
    rawWorkspacePayloadHash: deterministicHash(context.originalInput),
  };
  const existingEvidence = arrayOf<V23MigrationSourceEvidence>(input.v23MigrationSourceEvidence);
  if (existingEvidence.some((entry) => entry.sourceEvidenceId === sourceEvidenceId && !sameJson(entry, sourceEvidence))) {
    throw new Error("V23_MIGRATION_SOURCE_EVIDENCE_CONFLICT");
  }
  const evidence = existingEvidence.some((entry) => entry.sourceEvidenceId === sourceEvidenceId)
    ? existingEvidence
    : [...existingEvidence, sourceEvidence];
  if (context.initialSchemaVersion >= 1 && context.initialSchemaVersion <= 22 && ["v23SeriesPartRevisions", "v23SeriesPartHeads", "v23SkuDrawerRevisions", "v23SkuDrawerHeads", "v23AffixDefinitions", "v23MigrationSourceEvidence", "v23LegacyReadAdapters"].some((key) => Object.prototype.hasOwnProperty.call(context.originalInput, key))) {
    throw new Error("V23_MIGRATION_PARTIAL_STATE_CONFLICT");
  }

  const series = arrayOf<Record<string, unknown>>(input.seriesDefinitions);
  const originalSkus = arrayOf<Record<string, unknown>>((context.originalInput as Record<string, unknown>).skuDrawers);
  const originalOfficialSkus = arrayOf<Record<string, unknown>>((context.originalInput as Record<string, unknown>).officialSkus);
  const originalSeries = arrayOf<Record<string, unknown>>((context.originalInput as Record<string, unknown>).seriesDefinitions);
  const originalSkuById = new Map(originalSkus.filter((entry) => typeof entry.id === "string" && entry.id.length > 0).map((entry) => [entry.id as string, entry]));
  const originalOfficialSkuByDrawerId = new Map(originalOfficialSkus.filter((entry) => typeof entry.id === "string" && entry.id.length > 0).map((entry) => [`legacy-sku-drawer:${deterministicHash(entry.id as string).slice(0, 12)}`, entry]));
  const originalSeriesById = new Map(originalSeries.filter((entry) => typeof entry.id === "string" && entry.id.length > 0).map((entry) => [entry.id as string, entry]));
  const seriesById = new Map<string, Record<string, unknown>>();
  for (const entry of series) {
    // A legacy Series without a stable identity remains readable only through
    // an unresolved adapter; it must not prevent unrelated historical data
    // from being inspected or be guessed into a new v23 Part.
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    const id = entry.id;
    if (seriesById.has(id) && !sameJson(seriesById.get(id), entry)) {
      throw new Error("V23_MIGRATION_SERIES_ID_CONFLICT");
    }
    seriesById.set(id, entry);
  }

  const adapters: V23LegacyReadAdapter[] = [];
  const adapterIds = new Set<string>();
  for (const legacySku of arrayOf<Record<string, unknown>>(input.skuDrawers)) {
    const targetSkuId = requiredLegacyId(legacySku.id, "SKU");
    const drawerSource = originalSkuById.get(targetSkuId);
    const officialSource = originalOfficialSkuByDrawerId.get(targetSkuId);
    if ((drawerSource ? 1 : 0) + (officialSource ? 1 : 0) !== 1) throw new Error("V23_MIGRATION_SKU_SOURCE_UNRESOLVED");
    const sourceKind = drawerSource ? "LEGACY_SKU_DRAWER" as const : "LEGACY_OFFICIAL_SKU" as const;
    const sourceRecord = drawerSource ?? officialSource!;
    const sourceRecordId = requiredLegacyId(sourceRecord.id, "SOURCE_SKU");
    const requestedSeriesId = typeof legacySku.seriesId === "string" && legacySku.seriesId.length > 0
      ? legacySku.seriesId
      : null;
    const sourceSeriesId = requestedSeriesId && seriesById.has(requestedSeriesId) && originalSeriesById.has(requestedSeriesId)
      ? requestedSeriesId
      : null;
    const adapterId = `v23-legacy-adapter:${targetSkuId}`;
    if (adapterIds.has(adapterId)) throw new Error("V23_MIGRATION_SKU_ID_CONFLICT");
    adapterIds.add(adapterId);
    adapters.push({
      adapterId,
      kind: "LEGACY_NEEDS_REVIEW",
      sourceEvidenceId,
      targetSkuId,
      sourceKind,
      sourceRecordId,
      rawSourcePayload: structuredClone(sourceRecord),
      sourceSeriesId,
      rawSeriesPayload: sourceSeriesId
        ? structuredClone(originalSeriesById.get(sourceSeriesId))
        : null,
      diagnosticCodes: [
        ...(sourceSeriesId ? [] : ["V23_SERIES_UNRESOLVED" as const]),
        "V23_PART_UNRESOLVED",
        "V23_WEIGHT_BAND_UNRESOLVED",
        "V23_FUNCTION_TEMPLATE_UNRESOLVED",
      ],
      status: "NEEDS_REVIEW",
    });
  }

  return {
    ...input,
    schemaVersion: 23,
    v23SeriesPartRevisions: [],
    v23SeriesPartHeads: [],
    v23SkuDrawerRevisions: [],
    v23SkuDrawerHeads: [],
    v23AffixDefinitions: [],
    v23MigrationSourceEvidence: evidence,
    v23LegacyReadAdapters: adapters,
    // ConfigurationSnapshot is intentionally not read, normalized, or copied
    // here. It is a published byte-sensitive payload.
  } as MutableWorkspace;
}

const migrations: Record<number, (state: MutableWorkspace, context: MigrationContext) => MutableWorkspace> = {
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
  17: migrateV17ToV18,
  18: migrateV18ToV19,
  19: migrateV19ToV20,
  20: migrateV20ToV21,
  21: migrateV21ToV22,
  22: migrateV22ToV23,
};

export function migrateWorkspaceState(input: unknown): WorkspaceState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("工作区状态必须是对象。");
  }

  const originalInput = structuredClone(input);
  let state = structuredClone(input) as MutableWorkspace;
  let version =
    typeof state.schemaVersion === "number" ? state.schemaVersion : 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("工作区 schemaVersion 无效。");
  }
  const versionAtInput = version;
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
    state = migrate(state, { initialSchemaVersion: versionAtInput, originalInput });
    const nextVersion = state.schemaVersion;
    if (typeof nextVersion !== "number" || nextVersion <= version) {
      throw new Error("schema v" + version + " 迁移没有推进版本号。");
    }
    version = nextVersion;
  }

  const fiveAxisDefinitions = arrayOf<WorkspaceState["fiveAxisViewDefinitions"][number]>(
    state.fiveAxisViewDefinitions,
  );
  const existingFiveAxisGroupStates = arrayOf<NonNullable<WorkspaceState["fiveAxisVertexGroupStates"]>[number]>(
    state.fiveAxisVertexGroupStates,
  );
  // Old workspaces had immutable formal VertexSets but no mutable current-group
  // pointer.  Bootstrap only from each published Model's explicit current
  // Snapshot; historical arrays/order never select a candidate.
  const bootstrappedFiveAxisGroupStates = existingFiveAxisGroupStates.length
    ? existingFiveAxisGroupStates
    : (() => {
      const grouped = new Map<string, { key: import("./types").FiveAxisVertexGroupKey; sources: import("./types").FiveAxisVertexCandidateSource[] }>();
      const snapshots = arrayOf<WorkspaceState["configurationSnapshots"][number]>(state.configurationSnapshots);
      for (const model of arrayOf<WorkspaceState["purchasableModels"][number]>(state.purchasableModels)) {
        if (model.status !== "published" || !model.configurationSnapshotId) continue;
        const matches = snapshots.filter((snapshot) => snapshot.id === model.configurationSnapshotId && snapshot.modelId === model.id);
        if (matches.length !== 1) continue; // broken legacy pointer remains unavailable, never guessed
        const preview = matches[0].fiveAxisPreview;
        if (!preview?.weightBandId || !preview.weightBandPolicyVersion || !preview.candidateSources) continue;
        const key = { weightBandId: preview.weightBandId, weightBandPolicyVersion: preview.weightBandPolicyVersion, fiveAxisDefinitionId: preview.fiveAxisDefinitionId, fiveAxisDefinitionVersion: preview.fiveAxisDefinitionVersion, fiveAxisRuleVersion: preview.fiveAxisRuleVersion };
        const identity = JSON.stringify(key);
        const group = grouped.get(identity) ?? { key, sources: [] };
        const sources = preview.candidateSources.filter((source) => source.candidateSemanticKey.modelId === model.id && source.snapshotId === matches[0].id && source.candidateSemanticKey.itemPartId === "part:rod");
        if (sources.length === 1) group.sources.push(...structuredClone(sources));
        grouped.set(identity, group);
      }
      return [...grouped.values()].map<import("./types").FiveAxisVertexGroupState>((group) => {
        const matchingDefinitions = fiveAxisDefinitions.filter((entry) => "semanticContractVersion" in entry && entry.definitionId === group.key.fiveAxisDefinitionId && entry.version === group.key.fiveAxisDefinitionVersion);
        if (matchingDefinitions.length !== 1) throw new Error("FIVE_AXIS_MIGRATION_DEFINITION_UNRESOLVED：当前 Snapshot 的正式五维定义无法唯一回读。");
        const definition = matchingDefinitions[0];
        let rebuilt: import("./types").FiveAxisVertexSet;
        try {
          rebuilt = createFormalFiveAxisVertexSet({ definition: definition as import("./types").FiveAxisViewDefinition, groupKey: group.key, candidateSources: group.sources });
        } catch {
          throw new Error("FIVE_AXIS_MIGRATION_CANDIDATE_INVALID：当前 Snapshot 候选无法重放正式顶点。");
        }
        const sets = arrayOf<WorkspaceState["fiveAxisVertexSets"][number]>(state.fiveAxisVertexSets).filter((entry) => "weightBandId" in entry && entry.vertexSetHash === rebuilt.vertexSetHash && entry.candidateSetHash === rebuilt.candidateSetHash && entry.candidateEvidenceHash === rebuilt.candidateEvidenceHash);
        if (sets.length !== 1) {
          return {
            groupKey: group.key,
            state: "UNAVAILABLE_NO_ELIGIBLE_CANDIDATE" as const,
            candidateSources: group.sources,
            candidateSetHash: rebuilt.candidateSetHash,
            candidateEvidenceHash: rebuilt.candidateEvidenceHash,
            currentVertexSetId: null,
            currentVertexSetHash: null,
            missingAxisIds: [],
            reasonCode: "FIVE_AXIS_MIGRATION_VERTEX_SET_UNRESOLVED",
          };
        }
        const set = sets[0] as import("./types").FiveAxisVertexSet;
        return { groupKey: group.key, state: "AVAILABLE" as const, candidateSources: group.sources, candidateSetHash: set.candidateSetHash, candidateEvidenceHash: set.candidateEvidenceHash, currentVertexSetId: set.vertexSetId, currentVertexSetHash: set.vertexSetHash, missingAxisIds: [], reasonCode: null };
      });
    })();
  state = {
    ...state,
    parameters: enrichParameters(arrayOf<ParameterDefinition>(state.parameters)),
    aiRuleSourceChangeDrafts: arrayOf<
      WorkspaceState["aiRuleSourceChangeDrafts"][number]
    >(state.aiRuleSourceChangeDrafts),
    aiArtifactProvenanceSyncRecords: arrayOf<
      WorkspaceState["aiArtifactProvenanceSyncRecords"][number]
    >(state.aiArtifactProvenanceSyncRecords),
    performanceSummaryDefinitions: arrayOf<
      WorkspaceState["performanceSummaryDefinitions"][number]
    >(state.performanceSummaryDefinitions),
    feishuShareLinkHistory: arrayOf<
      WorkspaceState["feishuShareLinkHistory"][number]
    >(state.feishuShareLinkHistory)
      // 保存边界同样按白名单投影：当前 schema（v20）输入会跳过顺序迁移，
      // 必须在此剥离客户端载荷可能夹带的 appToken/secret/PII 等额外字段。
      .map(projectShareLinkHistoryEntry)
      .filter((entry): entry is FeishuShareLinkHistoryEntry => entry !== null),
    patchLedger: state.patchLedger && typeof state.patchLedger === "object"
      ? migratePatchLedger(state.patchLedger as WorkspaceState["patchLedger"],patchLedgerMigrationContext(state))
      : emptyPatchLedger(),
    configIdGovernance: migrateConfigIdGovernanceState(state.configIdGovernance),
  };
  const dispositionMigration = createFiveAxisDispositionCatalogRevision({
    definitions: fiveAxisDefinitions,
    existingRevisions: arrayOf<WorkspaceState["fiveAxisDispositionCatalogRevisions"][number]>(
      state.fiveAxisDispositionCatalogRevisions,
    ),
    currentRevisionId:
      typeof state.currentFiveAxisDispositionCatalogRevisionId === "string"
        ? state.currentFiveAxisDispositionCatalogRevisionId
        : null,
    decidedAt: "2026-07-23T00:00:00.000Z",
  });
  state = {
    ...state,
    fiveAxisViewDefinitions: fiveAxisDefinitions,
    fiveAxisVertexSets: arrayOf<WorkspaceState["fiveAxisVertexSets"][number]>(
      state.fiveAxisVertexSets,
    ),
    fiveAxisVertexGroupStates: bootstrappedFiveAxisGroupStates,
    fiveAxisDispositionCatalogRevisions: dispositionMigration.revisions,
    currentFiveAxisDispositionCatalogRevisionId:
      dispositionMigration.currentRevisionId,
  };
  validateV23RuntimeState(state);
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
    ? migratePatchLedger(state.patchLedger as WorkspaceState["patchLedger"],patchLedgerMigrationContext(state))
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
  const ledger = importLegacyPatchesToLedger(
    emptyPatchLedger(),
    arrayOf<ProjectionPatchRuleSource>(state.projectionPatches),
  );
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
