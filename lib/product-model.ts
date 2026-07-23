import type {
  DerivedProjection,
  HardCompatibilityResult,
  ParameterDefinition,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  ValidationIssue,
} from "./types";

export function seriesTargetPullSpecifications(series: SeriesDefinition) {
  if (series.targetPullSpecifications?.length) {
    return [...series.targetPullSpecifications]
      .sort((left, right) => left.targetPullKgf - right.targetPullKgf || left.skuId.localeCompare(right.skuId));
  }
  return series.skuIds.map((skuId, index) => ({
    targetPullKgf: series.targetWeightsKg[index],
    skuId,
  })).filter((entry) => Number.isFinite(entry.targetPullKgf));
}

export interface ResolvedModelPanel {
  modelId: string;
  skuId: string;
  values: Record<string, number | string>;
}

export interface ValidateSeriesInput {
  series: SeriesDefinition;
  skus: SkuDrawer[];
  models: PurchasableModel[];
  projections: DerivedProjection[];
  resolvedPanels?: ResolvedModelPanel[];
  hardCompatibilityByModelId?: Record<string, HardCompatibilityResult>;
  parameters?: ParameterDefinition[];
  /** @deprecated OPEN-004 已禁止独立偏移阈值；保留该输入只为旧调用方兼容，校验器会忽略。 */
  patchOffsetLimits?: { warning?: number; error?: number };
  neutralValuesBySkuId?: Record<string, Record<string, number | string>>;
}

const MONOTONIC_PARAMETER_KEYS = [
  "杆最大拉力kgf",
  "轮最大拉力kgf",
  "线最大拉力kgf",
  "安全工作拉力",
  "杆最大耐力",
  "轮最大耐力",
  "饵重上限g",
  "PE号上限",
];

function issue(
  issues: ValidationIssue[],
  level: ValidationIssue["level"],
  code: string,
  message: string,
  parameterKey?: string,
): void {
  issues.push({ level, code, message, parameterKey });
}

function projectionForSku(
  sku: SkuDrawer,
  projections: DerivedProjection[],
): DerivedProjection | undefined {
  return projections.find(
    (projection) => projection.id === sku.projectionMatch.projectionId,
  );
}

function valueDirection(value: number, neutral: number): "positive" | "negative" | "neutral" {
  const delta = value - neutral;
  if (Math.abs(delta) <= Number.EPSILON) return "neutral";
  return delta > 0 ? "positive" : "negative";
}

export function validateSeriesInvariants(
  input: ValidateSeriesInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seriesType = input.projections.find((projection) => projection.typeId === input.series.typeId);
  if (input.series.itemPartId && seriesType && !input.projections.some((projection) =>
    projection.typeId === input.series.typeId && projection.structuralValues)) {
    issue(issues, "warning", "SERIES_STRUCTURAL_SOURCE_MISSING", "Series 部位已指定，但当前投影缺少可追踪的结构标杆基础值。");
  }
  const skus = input.skus
    .filter((sku) => sku.seriesId === input.series.id)
    .sort((left, right) => left.targetWeightKg - right.targetWeightKg);
  const models = input.models.filter((model) =>
    skus.some((sku) => sku.id === model.skuId),
  );

  if (!skus.length) {
    issue(issues, "error", "SERIES_SKU_MISSING", "Series 至少需要一个 SKU 抽屉。");
  }
  const specifications = seriesTargetPullSpecifications(input.series);
  if (!specifications.length) {
    issue(issues, "error", "SERIES_PULL_SPECIFICATION_MISSING", "Series 至少需要一个已确认的离散目标拉力规格。");
  }
  const specificationPulls = new Set<number>();
  const specificationSkuIds = new Set<string>();
  for (const specification of specifications) {
    if (!Number.isFinite(specification.targetPullKgf) || specification.targetPullKgf <= 0) {
      issue(issues, "error", "SERIES_PULL_SPECIFICATION_INVALID", "目标拉力规格必须是大于 0 的有限 kgf 数值。");
      continue;
    }
    if (specificationPulls.has(specification.targetPullKgf)) {
      issue(issues, "error", "SERIES_PULL_SPECIFICATION_DUPLICATE", "Series 存在重复目标拉力规格：" + specification.targetPullKgf + "kgf。");
    }
    specificationPulls.add(specification.targetPullKgf);
    if (specificationSkuIds.has(specification.skuId)) {
      issue(issues, "error", "SERIES_PULL_SPECIFICATION_SKU_DUPLICATE", "同一个 SKU 不能对应多个目标拉力规格：" + specification.skuId + "。");
    }
    specificationSkuIds.add(specification.skuId);
    const sku = skus.find((entry) => entry.id === specification.skuId);
    if (!sku) {
      issue(issues, "error", "SERIES_PULL_SPECIFICATION_NOT_MATERIALIZED", "目标拉力 " + specification.targetPullKgf + "kgf 尚未物化为所属 Series 的 SKU 抽屉。");
    } else if (sku.targetWeightKg !== specification.targetPullKgf) {
      issue(issues, "error", "SERIES_PULL_SPECIFICATION_MISMATCH", "SKU " + sku.id + " 的目标拉力与 Series 离散规格不一致。");
    }
  }
  const weightSet = new Set<number>();
  for (const sku of skus) {
    if (weightSet.has(sku.targetWeightKg)) {
      issue(
        issues,
        "error",
        "SERIES_WEIGHT_DUPLICATE",
        "Series 存在重复目标重量：" + sku.targetWeightKg + "kg。",
      );
    }
    weightSet.add(sku.targetWeightKg);
    if (!specificationSkuIds.has(sku.id)) {
      issue(
        issues,
        "error",
        "SERIES_WEIGHT_UNDECLARED",
        "SKU " + sku.id + " 未在 Series 的离散目标拉力规格中声明。",
      );
    }
    const projection = projectionForSku(sku, input.projections);
    if (!projection) {
      issue(
        issues,
        "error",
        "SERIES_PROJECTION_MISSING",
        "SKU " + sku.id + " 缺少可复现的派生投影。",
      );
      continue;
    }
    if (projection.methodId !== input.series.fishingMethodId) {
      issue(issues, "error", "SERIES_METHOD_MISMATCH", "SKU 的钓法偏离 Series。");
    }
    if (projection.typeId !== input.series.typeId) {
      issue(issues, "error", "SERIES_TYPE_MISMATCH", "SKU 的类型偏离 Series。");
    }
    if (projection.functionId !== input.series.coreFunctionId) {
      issue(
        issues,
        "error",
        "SERIES_FUNCTION_MISMATCH",
        "SKU 的核心功能偏离 Series。",
      );
    }
    if (projection.qualityId !== input.series.qualityId) {
      issue(issues, "error", "SERIES_QUALITY_MISMATCH", "SKU 的品质偏离 Series。");
    }
    if (
      input.series.performanceProfileId &&
      projection.performanceId !== input.series.performanceProfileId
    ) {
      issue(
        issues,
        "error",
        "SERIES_PERFORMANCE_MISMATCH",
        "SKU 的性能方向偏离 Series。",
      );
    }
    if (input.series.functionIntensityPolicy.mode === "fixed") {
      if (
        projection.functionIntensity !==
        input.series.functionIntensityPolicy.intensity
      ) {
        issue(
          issues,
          "error",
          "SERIES_INTENSITY_MISMATCH",
          "SKU 的功能专精强度偏离固定策略。",
        );
      }
    } else {
      const expected =
        input.series.functionIntensityPolicy.values[String(sku.targetWeightKg)];
      if (expected !== undefined && projection.functionIntensity !== expected) {
        issue(
          issues,
          "error",
          "SERIES_INTENSITY_CURVE_MISMATCH",
          "SKU 的功能专精强度不符合显式重量曲线。",
        );
      }
    }
    if (!sku.modelIds.length) {
      issue(
        issues,
        "error",
        "SKU_MODEL_MISSING",
        "SKU " + sku.id + " 至少需要一个可购买 Model。",
      );
    }
    if (sku.defaultModelId && !sku.modelIds.includes(sku.defaultModelId)) {
      issue(
        issues,
        "error",
        "SKU_DEFAULT_MODEL_INVALID",
        "SKU 默认 Model 不在该抽屉中。",
      );
    }
  }

  for (const model of models) {
    const allAffixes = [...model.attributeAffixIds, ...model.passiveAffixIds];
    for (const affixId of input.series.coreAffixIds) {
      if (!allAffixes.includes(affixId)) {
        issue(
          issues,
          "error",
          "SERIES_CORE_AFFIX_MISSING",
          "Model " + model.id + " 缺少核心词条 " + affixId + "。",
        );
      }
    }
    for (const affixId of input.series.forbiddenAffixIds) {
      if (allAffixes.includes(affixId)) {
        issue(
          issues,
          "error",
          "SERIES_FORBIDDEN_AFFIX",
          "Model " + model.id + " 包含禁用词条 " + affixId + "。",
        );
      }
    }
    const compatibility = input.hardCompatibilityByModelId?.[model.id];
    if (compatibility && !compatibility.allowed) {
      issue(
        issues,
        "error",
        "MODEL_HARD_INCOMPATIBLE",
        "Model " + model.id + " 未通过硬兼容规则。",
      );
    }
    if (
      model.status === "published" &&
      !model.configurationSnapshotId
    ) {
      issue(
        issues,
        "error",
        "MODEL_SNAPSHOT_MISSING",
        "已发布 Model 缺少 ConfigurationSnapshot。",
      );
    }
  }

  const panelBySku = new Map<string, ResolvedModelPanel>();
  for (const sku of skus) {
    const panel = (input.resolvedPanels ?? []).find(
      (candidate) =>
        candidate.skuId === sku.id &&
        (candidate.modelId === sku.defaultModelId || !sku.defaultModelId),
    );
    if (panel) panelBySku.set(sku.id, panel);
  }
  for (let index = 1; index < skus.length; index += 1) {
    const previous = panelBySku.get(skus[index - 1].id);
    const current = panelBySku.get(skus[index].id);
    if (!previous || !current) continue;
    for (const parameterKey of MONOTONIC_PARAMETER_KEYS) {
      const previousValue = previous.values[parameterKey];
      const currentValue = current.values[parameterKey];
      if (
        typeof previousValue === "number" &&
        typeof currentValue === "number" &&
        currentValue < previousValue
      ) {
        issue(
          issues,
          "error",
          "SERIES_WEIGHT_CURVE_DECREASE",
          "重量升高时 " + parameterKey + " 不得下降。",
          parameterKey,
        );
      }
    }
  }

  for (const signature of input.series.signature) {
    if (signature.expectedDirection === "contextual") continue;
    for (const panel of input.resolvedPanels ?? []) {
      const neutral = input.neutralValuesBySkuId?.[panel.skuId];
      if (!neutral) continue;
      const finalValue = panel.values[signature.parameterGroup];
      const neutralValue = neutral[signature.parameterGroup];
      if (typeof finalValue !== "number" || typeof neutralValue !== "number") {
        continue;
      }
      const direction = valueDirection(finalValue, neutralValue);
      if (
        direction !== signature.expectedDirection &&
        !(signature.expectedDirection === "neutral" &&
          Math.abs(finalValue - neutralValue) <= signature.tolerance)
      ) {
        issue(
          issues,
          signature.importance >= 0.8 ? "error" : "warning",
          "SERIES_SIGNATURE_DEVIATION",
          "Model " + panel.modelId + " 偏离 Series 方向签名。",
          signature.parameterGroup,
        );
      }
    }
  }

  if (!issues.length) {
    issue(issues, "info", "SERIES_VALID", "Series、SKU 与 Model 不变量校验通过。");
  }
  return issues;
}

export interface PurchaseReference {
  modelId: string;
  configurationSnapshotId: string;
}

export function createPurchaseReference(
  model: PurchasableModel,
): PurchaseReference {
  if (!model.configurationSnapshotId || model.status !== "published") {
    throw new Error("只有已发布且具备冻结快照的 Model 才能形成购买引用。");
  }
  return {
    modelId: model.id,
    configurationSnapshotId: model.configurationSnapshotId,
  };
}
