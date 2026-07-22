import type {
  AffixQualityEvaluation,
  Candidate,
  Collection,
  ConfigurationSnapshot,
  DetailOverride,
  GovernanceAuditLogEntry,
  ModelComponentSelection,
  OfficialSku,
  ProjectionMatch,
  ProjectionPatchRuleSource,
  PurchasableModel,
  QualityProfileId,
  SeriesDefinition,
  SkuDrawer,
  V3Affix,
  WeightTemplate,
  WorkspaceState,
} from "./types";
import { deterministicHash } from "./rule-kernel";

interface LegacyProductMigrationResult {
  collections: Collection[];
  seriesDefinitions: SeriesDefinition[];
  skuDrawers: SkuDrawer[];
  purchasableModels: PurchasableModel[];
  configurationSnapshots: ConfigurationSnapshot[];
  governanceAuditLog: GovernanceAuditLogEntry[];
  projectionPatches: ProjectionPatchRuleSource[];
}

function legacyQualityId(value: string): QualityProfileId {
  const normalized = value.toLowerCase();
  if (normalized === "s" || value.includes("橙") || value.includes("金")) return "quality_s_orange";
  if (normalized === "a" || value.includes("紫")) return "quality_a_purple";
  if (normalized === "b" || value.includes("蓝")) return "quality_b_blue";
  return "quality_c_green";
}

function stableId(prefix: string, value: string) {
  return prefix + deterministicHash(value).slice(0, 12);
}

function legacyComponents(
  sku: OfficialSku,
  details: DetailOverride[],
): ModelComponentSelection[] {
  const ids = { rod: sku.rodId, reel: sku.reelId, line: sku.lineId };
  return (["rod", "reel", "line"] as const).map((kind) => {
    const detail = details.find((item) => item.skuId === sku.id && item.itemKind === kind);
    return {
      itemPartId: "part:" + kind,
      componentId: detail?.model || ids[kind],
      name: detail?.name || ids[kind],
      values: structuredClone(detail?.values ?? {}),
    };
  });
}

function migrationQualityReport(qualityId: QualityProfileId): AffixQualityEvaluation {
  const meta = {
    quality_c_green: { letter: "C" as const, colorName: "绿" as const },
    quality_b_blue: { letter: "B" as const, colorName: "蓝" as const },
    quality_a_purple: { letter: "A" as const, colorName: "紫" as const },
    quality_s_orange: { letter: "S" as const, colorName: "橙" as const },
  }[qualityId];
  return {
    totalScore: 0,
    qualityId,
    letter: meta.letter,
    colorName: meta.colorName,
    attributeAffixScore: 0,
    passiveAffixScore: 0,
    technologyAffixIds: [],
    directAffixIds: [],
    warnings: ["历史品质展示已映射到 v3 标识；原发布值未回写。"],
    blockingIssues: [],
  };
}

function snapshotWithHash(
  value: Omit<ConfigurationSnapshot, "contentHash">,
): ConfigurationSnapshot {
  return { ...value, contentHash: deterministicHash(value) };
}

export function migrateLegacyProductIdentity(
  state: Partial<WorkspaceState>,
  ruleSetVersion: string,
): LegacyProductMigrationResult {
  const officialSkus = (state.officialSkus ?? []) as OfficialSku[];
  const existingCollections = (state.collections ?? []) as Collection[];
  const existingSeries = (state.seriesDefinitions ?? []) as SeriesDefinition[];
  const existingDrawers = (state.skuDrawers ?? []) as SkuDrawer[];
  const existingModels = (state.purchasableModels ?? []) as PurchasableModel[];
  const existingSnapshots = (state.configurationSnapshots ?? []) as ConfigurationSnapshot[];
  const existingAudit = (state.governanceAuditLog ?? []) as GovernanceAuditLogEntry[];
  const existingPatches = (state.projectionPatches ?? []) as ProjectionPatchRuleSource[];
  if (!officialSkus.length || existingDrawers.length || existingModels.length || existingSnapshots.length) {
    return {
      collections: existingCollections,
      seriesDefinitions: existingSeries,
      skuDrawers: existingDrawers,
      purchasableModels: existingModels,
      configurationSnapshots: existingSnapshots,
      governanceAuditLog: existingAudit,
      projectionPatches: existingPatches,
    };
  }

  const candidates = (state.candidates ?? []) as Candidate[];
  const templates = (state.templates ?? []) as WeightTemplate[];
  const details = (state.detailOverrides ?? []) as DetailOverride[];
  const affixes = (state.v3Affixes ?? []) as V3Affix[];
  const now = officialSkus.map((sku) => sku.publishedAt).sort()[0] ?? "1970-01-01T00:00:00.000Z";
  const collectionId = "legacy-collection:published";
  const seriesByName = new Map<string, OfficialSku[]>();
  for (const sku of officialSkus) {
    const entries = seriesByName.get(sku.seriesName) ?? [];
    entries.push(sku);
    seriesByName.set(sku.seriesName, entries);
  }

  const migratedSeries: SeriesDefinition[] = [];
  const migratedDrawers: SkuDrawer[] = [];
  const migratedModels: PurchasableModel[] = [];
  const migratedSnapshots: ConfigurationSnapshot[] = [];
  const migratedAudit: GovernanceAuditLogEntry[] = [];
  const normalizedPatches = structuredClone(existingPatches);

  for (const [seriesName, seriesSkus] of Array.from(seriesByName.entries()).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const seriesId = stableId("legacy-series:", seriesName);
    const firstSku = seriesSkus[0];
    const firstCandidate = candidates.find((item) => item.id === firstSku.candidateId);
    const targetWeights = seriesSkus.map((sku) => templates.find((item) => item.id === sku.templateId)?.nominalFishKg ?? (sku.fishMinKg + sku.fishMaxKg) / 2).sort((left, right) => left - right);
    const qualityId = legacyQualityId(firstSku.qualityId);
    const functionIntensity = Math.min(3, Math.max(1, Number.parseInt(firstSku.functionLevel, 10) || 1)) as 1 | 2 | 3;
    const migratedSkuIds = seriesSkus.map((sku) => stableId("legacy-sku-drawer:", sku.id));
    migratedSeries.push({
      id: seriesId,
      collectionId,
      revision: 1,
      name: seriesName,
      concept: "由历史 OfficialSku 无损迁移；开放语义保持待复核。",
      fishingMethodId: "method:lure",
      typeId: firstCandidate?.selections.structureId ?? "legacy:type:unspecified",
      qualityId,
      coreFunctionId: firstCandidate?.selections.functionId ?? "legacy:function:unspecified",
      functionIntensityPolicy: { mode: "fixed", intensity: functionIntensity },
      performanceProfileId: firstCandidate?.selections.performanceId,
      performanceIntensityPolicy: firstSku.performanceLevel ? { mode: "legacy_label", label: firstSku.performanceLevel } : undefined,
      coreAffixIds: [],
      secondaryAffixPoolIds: [],
      forbiddenAffixIds: [],
      planningPullRange: targetWeights.length
        ? { minKgf: Math.min(...targetWeights), maxKgf: Math.max(...targetWeights) }
        : undefined,
      targetPullSpecifications: seriesSkus.map((sku) => {
        const template = templates.find((item) => item.id === sku.templateId);
        return {
          targetPullKgf: template?.nominalFishKg ?? (sku.fishMinKg + sku.fishMaxKg) / 2,
          skuId: stableId("legacy-sku-drawer:", sku.id),
        };
      }),
      targetWeightsKg: Array.from(new Set(targetWeights)),
      signature: [],
      patchIds: [],
      skuIds: migratedSkuIds,
      status: "published",
      createdAt: now,
      updatedAt: now,
    });

    for (const sku of seriesSkus) {
      const candidate = candidates.find((item) => item.id === sku.candidateId);
      const template = templates.find((item) => item.id === sku.templateId);
      const targetWeightKg = template?.nominalFishKg ?? (sku.fishMinKg + sku.fishMaxKg) / 2;
      const drawerId = stableId("legacy-sku-drawer:", sku.id);
      const modelId = stableId("legacy-model:", sku.id);
      const snapshotId = stableId("legacy-snapshot:", sku.id);
      const projectionId = "legacy-projection:" + sku.templateId;
      const match: ProjectionMatch = {
        targetPullKg: targetWeightKg,
        matchedStructuralPullKg: targetWeightKg,
        pullDistance: 0,
        itemPartId: "part:rod",
        targetWeightKg,
        projectionId,
        weightTemplateId: sku.templateId,
        ruleSetVersion,
        anchorWeightKg: targetWeightKg,
        weightDistance: 0,
        affinityScore: 0,
        normalizedAttributeDistance: 0,
        reasons: ["历史 OfficialSku 迁移：原模板 ID 与发布值原样保留。"],
        alternatives: [],
        pinnedByUser: true,
        trace: [{ stage: "pin", candidateId: projectionId, detail: "迁移时固定到历史模板，禁止静默重算。" }],
      };
      const patch = normalizedPatches.find((item) => item.id === "migration-patch-" + sku.candidateId);
      if (patch) {
        patch.scope = "model";
        patch.scopeId = modelId;
        patch.baseProjectionId = projectionId;
      }
      const patchIds = patch ? [patch.id] : [];
      const modelAffixes = sku.affixIds.map((id) => "v3:" + id);
      const attributeAffixIds = modelAffixes.filter((id) => affixes.find((affix) => affix.id === id)?.category !== "passive");
      const passiveAffixIds = modelAffixes.filter((id) => affixes.find((affix) => affix.id === id)?.category === "passive");
      const componentSelections = legacyComponents(sku, details);
      const model: PurchasableModel = {
        id: modelId,
        revision: 1,
        skuId: drawerId,
        name: sku.comboId,
        action: sku.tone,
        hardness: sku.hardness,
        lengthM: sku.lengthM,
        componentSelections,
        technologyIds: (candidate?.selections.technologyIds ?? []).map((id) => "v3:" + id),
        attributeAffixIds,
        passiveAffixIds,
        patchIds,
        price: sku.priceIndex,
        configurationSnapshotId: snapshotId,
        status: "published",
        createdAt: sku.publishedAt,
        updatedAt: sku.publishedAt,
      };
      migratedModels.push(model);
      migratedDrawers.push({
        id: drawerId,
        revision: 1,
        seriesId,
        targetWeightKg,
        projectionMatch: match,
        patchIds: [],
        modelIds: [modelId],
        defaultModelId: modelId,
        displayOrder: migratedDrawers.length,
        validationSummary: [{ level: "info", code: "LEGACY_SKU_MIGRATED", message: "历史 OfficialSku 已迁移为 SKU 抽屉与默认 Model。" }],
        status: "published",
        createdAt: sku.publishedAt,
        updatedAt: sku.publishedAt,
      });
      const qualityReport = migrationQualityReport(legacyQualityId(sku.qualityId));
      migratedSnapshots.push(snapshotWithHash({
        id: snapshotId,
        version: 1,
        modelId,
        modelRevision: 1,
        skuRevision: 1,
        seriesRevision: 1,
        ruleSetVersion,
        projectionId,
        reductionStackingMode: state.ruleSettings?.reductionStackingMode ?? "diminishing_division",
        patchSetHash: deterministicHash(patchIds),
        finalPanelValues: structuredClone(sku.values),
        componentSelections,
        technologyIds: structuredClone(model.technologyIds),
        attributeAffixIds,
        passiveAffixIds,
        attributeTrace: [],
        passiveAffixPayloads: passiveAffixIds.flatMap((id) => {
          const payload = affixes.find((affix) => affix.id === id)?.passivePayload;
          return payload ? [structuredClone(payload)] : [];
        }),
        projectionMatch: match,
        compatibilityReport: { allowed: true, matchedRules: [], decisiveRuleIds: [], failures: [], suggestions: ["历史已发布结果按只读兼容策略保留。"] },
        affinityReport: { score: 0, contributions: [], matchedRuleIds: [], warnings: ["历史数据没有 Affinity 明细。"] },
        qualityReport,
        validationReport: [{ level: "info", code: "LEGACY_SNAPSHOT_FROZEN", message: "原 OfficialSku 发布值已冻结为初始快照。" }],
        publishedBy: "workspace-migration",
        publishedAt: sku.publishedAt,
      }));
      migratedAudit.push({
        id: stableId("legacy-audit:", sku.id),
        action: "publish_snapshot",
        entityType: "ConfigurationSnapshot",
        entityId: snapshotId,
        actor: "workspace-migration",
        occurredAt: sku.publishedAt,
        details: { summary: "OfficialSku 无损迁移为 SKU 抽屉、默认 Model 与冻结快照。", officialSkuId: sku.id, candidateId: sku.candidateId },
      });
    }
  }

  return {
    collections: existingCollections.length ? existingCollections : [{
      id: collectionId,
      name: "历史已发布产品",
      brandStory: "由 v2 OfficialSku 迁移形成的只读兼容集合。",
      seriesIds: migratedSeries.map((series) => series.id),
      notes: "迁移来源完整保留在治理审计日志中。",
      createdAt: now,
      updatedAt: now,
    }],
    seriesDefinitions: existingSeries.length ? existingSeries : migratedSeries,
    skuDrawers: migratedDrawers,
    purchasableModels: migratedModels,
    configurationSnapshots: migratedSnapshots,
    governanceAuditLog: [...existingAudit, ...migratedAudit],
    projectionPatches: normalizedPatches,
  };
}
