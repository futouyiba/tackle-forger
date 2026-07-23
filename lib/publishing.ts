import { deterministicHash } from "./rule-kernel";
import { previewPatchRebase } from "./patch-engine";
import { orderedPatchReferences } from "./patch-ledger";
import { authoritativeObjectIdentity, evaluateAuthoritativePatchFinalRanges, type AuthoritativePatchObject } from "./patch-authority";
import {
  assertPatchGateCanProceed,
  assertPatchReviewCoverage,
  assertPublishedPatchOffsetPolicy,
  assertRangeEvaluationMatchesPatchRevisions,
  PatchOffsetPolicyError,
} from "./patch-offset-policy";
import type { PatchRangeEvaluation } from "./patch-offset-policy";
import type {
  AffinityScoreResult,
  AffixQualityEvaluation,
  ConfigurationSnapshot,
  DerivedProjection,
  GovernanceAuditLogEntry,
  HardCompatibilityResult,
  ModelComponentSelection,
  ModelFiveAxisPreview,
  FiveAxisDefinitionDispositionCatalogRevision,
  StoredFiveAxisViewDefinition,
  PatchRebaseDifference,
  PatchOffsetPolicyVersion,
  ParameterDefinition,
  PatchReviewBatch,
  PatchRevisionRecord,
  PatchValidationWaiver,
  ProjectionPatchRuleSource,
  ProjectionTraceStep,
  PurchasableModel,
  RuleChangeProposal,
  RuleSetVersion,
  SeriesDefinition,
  SkuDrawer,
  Technology,
  UpgradeCandidate,
  ValidationIssue,
  PassiveSkillPayload,
  WorkspacePolicyRecord,
} from "./types";
import { structuralPullParameterKey } from "./projection-matcher";
import type { ModelAffixValueAssessment } from "./quality-value-policy";
import type { PricingTrialResult } from "./pricing-policy";
import {
  derivePerformanceSummary,
  resolvePerformanceSummaryDefinition,
  unavailablePerformanceSummary,
  type PerformanceSummaryDefinition,
  type PerformanceSummarySnapshot,
} from "./performance-summary";
import {
  assertSeriesItemPartChainEnabled,
} from "./enabled-item-parts";
import {
  adaptFiveAxisTraceToCanonical,
  adaptPricingTraceToCanonical,
  adaptRuleTraceToCanonical,
  assertCalculationTraceMatchesFiveAxis,
  assertCalculationTraceMatchesFinalPanel,
  assertCalculationTraceMatchesPricing,
  assertCalculationTraceUsesRuleSetVersion,
  createCalculationTraceArchive,
  verifyCalculationTraceArchive,
} from "./calculation-trace";

function entityRefIdentity(ref: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  revisionId: string;
}): string {
  return JSON.stringify([
    ref.workspaceId,
    ref.entityType,
    ref.entityId,
    ref.revisionId,
  ]);
}
import { resolveFormalFiveAxisDefinition } from "./five-axis-formal";

export function modelFinalPullKgForSnapshot(
  itemPartId: string | undefined,
  finalPanelValues: Record<string, number | string>,
): number | undefined {
  const parameterKey = itemPartId ? structuralPullParameterKey(itemPartId) : undefined;
  const value = parameterKey ? finalPanelValues[parameterKey] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errors(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((issue) => issue.level === "error");
}

function warnings(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((issue) => issue.level === "warning");
}

export interface PublishModelInput {
  publicationMode: "new_formal" | "historical_import";
  /** 新正式 Snapshot 的 canonical Trace 主体工作区；历史导入不得据此补写 Trace。 */
  workspaceId?: string;
  model: PurchasableModel;
  sku: SkuDrawer;
  seriesSkus: SkuDrawer[];
  series: SeriesDefinition;
  projection: DerivedProjection;
  finalPanelValues: Record<string, number | string>;
  componentSelections: ModelComponentSelection[];
  patches: ProjectionPatchRuleSource[];
  patchRevisions?: PatchRevisionRecord[];
  patchOffsetGovernance?: {
    policy?: WorkspacePolicyRecord | PatchOffsetPolicyVersion;
    ruleSet: RuleSetVersion;
    parameterDefinitions: ParameterDefinition[];
    reviewBatch?: PatchReviewBatch;
    waivers?: PatchValidationWaiver[];
  };
  attributeAffixIds: string[];
  passiveAffixIds: string[];
  technologyIds: string[];
  passiveAffixPayloads: PassiveSkillPayload[];
  compatibilityReport: HardCompatibilityResult;
  affinityReport: AffinityScoreResult;
  qualityReport: AffixQualityEvaluation;
  qualityValueAssessment?: ModelAffixValueAssessment;
  performanceSummaryDefinition?: PerformanceSummaryDefinition;
  performanceSummaryDefinitions?: PerformanceSummaryDefinition[];
  performanceSummary?: PerformanceSummarySnapshot;
  technologyDefinitions?: Technology[];
  finalSettlementTrace?: ProjectionTraceStep[];
  pricingPolicyVersion?: string;
  automaticPricing?: PricingTrialResult;
  validationReport: ValidationIssue[];
  fiveAxisPreview?: ModelFiveAxisPreview;
  fiveAxisDefinition?: StoredFiveAxisViewDefinition;
  fiveAxisDefinitions?: StoredFiveAxisViewDefinition[];
  fiveAxisDispositionCatalogRevisions?: FiveAxisDefinitionDispositionCatalogRevision[];
  currentFiveAxisDispositionCatalogRevisionId?: string | null;
  warningConfirmations: Record<string, string>;
  publishedBy: string;
  publishedAt: string;
  snapshotId?: string;
  version?: number;
}

function snapshotContent(
  snapshot: Omit<ConfigurationSnapshot, "contentHash">,
): Omit<ConfigurationSnapshot, "contentHash"> {
  return snapshot;
}

export function publishConfigurationSnapshot(
  input: PublishModelInput,
): ConfigurationSnapshot {
  if (input.publicationMode === "new_formal" && input.patches.length && !input.patchRevisions?.length) {
    throw new Error("正式 Snapshot 必须使用可冻结 operation 顺序的 Patch revision，不能只引用旧 Patch 视图。");
  }
  const frozenPatches = input.patchRevisions
    ? orderedPatchReferences(input.patchRevisions)
    : undefined;
  const legacyPatchSetHash = deterministicHash(
    [...input.patches].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const patchSetHash = frozenPatches?.patchSetHash ?? legacyPatchSetHash;
  const hasPatchDependency = Boolean(input.patchRevisions?.length || input.patches.length);
  let patchRangeEvaluation: PatchRangeEvaluation | undefined;
  if (input.publicationMode === "new_formal" && hasPatchDependency) {
    try {
      const governance = input.patchOffsetGovernance;
      if (!governance) {
        throw new PatchOffsetPolicyError(
          "PATCH_OFFSET_POLICY_MISSING",
          "正式发布缺少 PatchOffsetPolicyVersion 与整体复核证据。",
        );
      }
      const policy = governance.policy;
      assertPublishedPatchOffsetPolicy(policy);
      const authority: AuthoritativePatchObject = {
        subjectRef: { scopeType: "model", entityId: input.model.id, revision: input.model.revision },
        ruleSet: governance.ruleSet,
        parameterDefinitions: governance.parameterDefinitions,
        patchRevisions: input.patchRevisions ?? [],
        contexts: [{
          contextId: `${input.model.id}:${input.sku.id}:${input.projection.id}`,
          itemPartId: input.sku.projectionMatch.itemPartId,
          projection: input.projection,
          finalPanelValues: input.finalPanelValues,
          weightBandId: input.sku.projectionMatch.weightTemplateId,
          skuRef: input.sku.id,
          targetPullKg: input.sku.projectionMatch.targetPullKg,
        }],
      };
      patchRangeEvaluation = evaluateAuthoritativePatchFinalRanges({
        policy,
        gate: "PUBLISH",
        objects: [authority],
      });
      const identity = authoritativeObjectIdentity(authority);
      if (identity.patchSetHash !== patchSetHash) {
        throw new PatchOffsetPolicyError("PATCH_SET_HASH_MISMATCH", "发布命令派生的 PatchSetHash 与待冻结引用不一致。");
      }
      assertPatchReviewCoverage({
        batch: governance.reviewBatch,
        policyVersion: policy.version,
        subjectRef: { scopeType: "model", entityId: input.model.id, revision: input.model.revision },
        objectInputHash: identity.objectInputHash,
        patchSetHash,
      });
      assertRangeEvaluationMatchesPatchRevisions({
        evaluation: patchRangeEvaluation,
        revisions: input.patchRevisions ?? [],
      });
      assertPatchGateCanProceed({
        evaluation: patchRangeEvaluation,
        waivers: governance.waivers,
      });
    } catch (error) {
      if (error instanceof PatchOffsetPolicyError) {
        throw new Error(`配置快照发布被阻止：[${error.code}] ${error.message}`);
      }
      throw error;
    }
  }
  assertSeriesItemPartChainEnabled(
    input.series,
    [input.sku],
    "model_publish",
    [],
    input.seriesSkus,
  );
  const combinedValidationReport = [
    ...input.validationReport,
    ...(input.fiveAxisPreview?.tackleFitComparison.validationIssues ?? []),
  ];
  const blocking = errors(combinedValidationReport);
  let registeredPerformanceSummaryDefinition = input.performanceSummaryDefinition;
  if (input.publicationMode === "new_formal" && input.performanceSummaryDefinition) {
    registeredPerformanceSummaryDefinition = resolvePerformanceSummaryDefinition({
      definitions: input.performanceSummaryDefinitions ?? [],
      definitionId: input.performanceSummaryDefinition.definitionId,
      definitionVersion: input.performanceSummaryDefinition.definitionVersion,
      expectedHash: input.performanceSummaryDefinition.definitionHash,
    });
  }
  const technologyMemberAffixIds = input.technologyIds.flatMap((technologyId) => {
    const technology = input.technologyDefinitions?.find((entry) => entry.id === technologyId && entry.enabled);
    return technology?.affixIds ?? [];
  });
  const finalSettlementTrace = input.publicationMode === "new_formal"
    ? input.finalSettlementTrace
    : input.projection.trace;
  const derivedPerformanceSummary = input.publicationMode === "new_formal"
    ? derivePerformanceSummary({
        subjectId: input.model.id,
        subjectRevisionId: String(input.model.revision),
        definition: registeredPerformanceSummaryDefinition,
        technologyIds: input.technologyIds,
        affixIds: [
          ...input.attributeAffixIds,
          ...input.passiveAffixIds,
          ...technologyMemberAffixIds,
        ],
        finalPanelValues: input.finalPanelValues,
        attributeTrace: finalSettlementTrace ?? [],
      })
    : input.performanceSummary;
  if (!input.compatibilityReport.allowed) {
    blocking.push({
      level: "error",
      code: "HARD_COMPATIBILITY_FAILED",
      message: "硬兼容失败，禁止发布。",
    });
  }
  if (input.qualityReport.blockingIssues.length) {
    blocking.push(
      ...input.qualityReport.blockingIssues.map((message) => ({
        level: "error" as const,
        code: "QUALITY_BLOCKED",
        message,
      })),
    );
  }
  if (input.publicationMode === "new_formal") {
    if (!input.workspaceId?.trim()) {
      blocking.push({
        level: "error",
        code: "CALCULATION_TRACE_SUBJECT_MISSING",
        message: "新 Snapshot 必须提供 workspaceId，以冻结 canonical CalculationTrace 的 subjectRef。",
      });
    }
    if (!input.finalSettlementTrace) {
      blocking.push({
        level: "error",
        code: "FINAL_SETTLEMENT_TRACE_MISSING",
        message: "新正式 Snapshot 必须提供产生最终面板值的结算 Trace。",
      });
    } else {
      const lastByParameter = new Map<string, number | string | null>();
      for (const step of input.finalSettlementTrace) {
        for (const contribution of step.contributions) {
          lastByParameter.set(contribution.parameterKey, contribution.after);
        }
      }
      const missingParameters = Object.keys(input.finalPanelValues).filter(
        (parameterKey) => !lastByParameter.has(parameterKey),
      );
      if (missingParameters.length) {
        blocking.push({
          level: "error",
          code: "FINAL_SETTLEMENT_TRACE_INCOMPLETE",
          message: "最终结算 Trace 未覆盖面板参数：" + missingParameters.join("、"),
        });
      }
      const staleParameters = [...lastByParameter].filter(
        ([parameterKey, after]) => !Object.is(after, input.finalPanelValues[parameterKey]),
      );
      if (staleParameters.length) {
        blocking.push({
          level: "error",
          code: "FINAL_SETTLEMENT_TRACE_STALE",
          message: "最终结算 Trace 与面板值不一致：" +
            staleParameters.map(([parameterKey]) => parameterKey).join("、"),
        });
      }
    }
    if (
      input.technologyIds.length
      && (!input.technologyDefinitions
        || input.technologyIds.some((technologyId) =>
          !input.technologyDefinitions?.some((entry) => entry.id === technologyId && entry.enabled)))
    ) {
      blocking.push({
        level: "error",
        code: "TECHNOLOGY_DEFINITION_MISSING",
        message: "新正式 Snapshot 必须用已启用 Technology 定义展开成员 Affix。",
      });
    }
    if (!input.qualityValueAssessment?.formal) {
      blocking.push({
        level: "error",
        code: "QUALITY_POLICY_NOT_FORMAL",
        message: "新 Snapshot 必须绑定通过所选品质区间校验的正式品质评分结果。",
      });
    }
    if (
      input.qualityValueAssessment?.performanceScoreFactor !== undefined
      || input.qualityValueAssessment?.trace.some((entry) => entry.step === "performance_factor")
    ) {
      blocking.push({
        level: "error",
        code: "LEGACY_PERFORMANCE_SCORE_NOT_ALLOWED",
        message: "新正式 Snapshot 不得冻结或定价包含旧 Performance 因子的品质评分结果。",
      });
    }
    if (
      !input.pricingPolicyVersion
      || !input.automaticPricing?.formal
      || input.automaticPricing.pricingPolicyRef !== input.pricingPolicyVersion
    ) {
      blocking.push({
        level: "error",
        code: "PRICING_POLICY_NOT_FORMAL",
        message: "新 Snapshot 必须绑定同一已发布 PricingPolicyVersion 的正式自动价格。",
      });
    }
    if (
      input.qualityValueAssessment?.formal
      && input.automaticPricing?.formal
      && input.automaticPricing.valueScore !== input.qualityValueAssessment.finalValueScore
    ) {
      blocking.push({
        level: "error",
        code: "PRICING_QUALITY_SCORE_MISMATCH",
        message: "正式自动价格消费的 valueScore 与规范品质评分结果不一致。",
      });
    }
  }
  if (
    input.publicationMode === "new_formal"
    && input.performanceSummary
    && deterministicHash(input.performanceSummary) !== deterministicHash(derivedPerformanceSummary)
  ) {
    blocking.push({
      level: "error",
      code: "PERFORMANCE_SUMMARY_REFERENCE_MISMATCH",
      message: "调用方提供的派生性能摘要与服务端按 Model revision、定义和冻结输入重算的结果不一致。",
    });
  }
  const unconfirmedWarnings = warnings(combinedValidationReport).filter(
    (warning) => !input.warningConfirmations[warning.code]?.trim(),
  );
  if (unconfirmedWarnings.length) {
    blocking.push({
      level: "error",
      code: "WARNING_NOT_CONFIRMED",
      message:
        "以下 warning 尚未记录确认理由：" +
        unconfirmedWarnings.map((warning) => warning.code).join("、"),
    });
  }
  if (blocking.length) {
    throw new Error(
      "配置快照发布被阻止：" +
        blocking.map((issue) => issue.message).join("；"),
    );
  }
  if (input.model.skuId !== input.sku.id || input.sku.seriesId !== input.series.id) {
    throw new Error("Model、SKU 与 Series 版本链不完整。");
  }
  if (input.sku.projectionMatch.projectionId !== input.projection.id) {
    throw new Error("SKU 的 ProjectionMatch 与发布投影不一致。");
  }
  if (
    input.fiveAxisPreview &&
    input.fiveAxisPreview.modelId !== input.model.id
  ) {
    throw new Error("五轴预览与待发布 Model 不一致。");
  }
  if (input.publicationMode === "new_formal" && !input.fiveAxisPreview) {
    throw new Error(
      "FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：新正式 Snapshot 必须冻结五维定义、目录与预览证据。",
    );
  }
  let fiveAxisDispositionEvidence: ConfigurationSnapshot["fiveAxisDispositionEvidence"];
  if (input.publicationMode === "new_formal" && input.fiveAxisPreview) {
    const definition = input.fiveAxisDefinition;
    const resolved = resolveFormalFiveAxisDefinition({
      definitions: input.fiveAxisDefinitions ?? (definition ? [definition] : []),
      revisions: input.fiveAxisDispositionCatalogRevisions ?? [],
      currentRevisionId: input.currentFiveAxisDispositionCatalogRevisionId ?? null,
    });
    if (
      !definition
      || definition.definitionId !== resolved.definition.definitionId
      || definition.version !== resolved.definition.version
      || definition.definitionHash !== resolved.definition.definitionHash
    ) {
      throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：传入定义不是目录中的唯一 FORMAL_CURRENT。");
    }
    fiveAxisDispositionEvidence = {
      catalogRevisionId: resolved.catalogRevision.catalogRevisionId,
      catalogHash: resolved.catalogRevision.catalogHash,
      disposition: structuredClone(resolved.disposition),
    };
    if (
      input.fiveAxisPreview.fiveAxisDefinitionId !== resolved.definition.definitionId
      || input.fiveAxisPreview.fiveAxisDefinitionVersion !== resolved.definition.version
      || input.fiveAxisPreview.fiveAxisDefinitionRevision !== resolved.definition.revision
      || input.fiveAxisPreview.fiveAxisDefinitionHash !== resolved.definition.definitionHash
      || input.fiveAxisPreview.fiveAxisRuleVersion !== resolved.definition.fiveAxisRuleVersion
      || input.fiveAxisPreview.sourceRevision !== resolved.definition.sourceRevision
      || input.fiveAxisPreview.tackleFitComparison.fiveAxisDefinitionId !== resolved.definition.definitionId
      || input.fiveAxisPreview.tackleFitComparison.fiveAxisDefinitionVersion !== resolved.definition.version
      || input.fiveAxisPreview.tackleFitComparison.fiveAxisRuleVersion !== resolved.definition.fiveAxisRuleVersion
      || input.fiveAxisPreview.tackleFitComparison.vertexSetHash !== input.fiveAxisPreview.vertexSetHash
    ) {
      throw new Error("五轴预览的定义、规则或顶点版本链不一致，禁止创建正式 Snapshot。");
    }
  }

  const calculationTrace = input.publicationMode === "new_formal"
    ? (() => {
        const subjectRef = {
          workspaceId: input.workspaceId!,
          entityType: "model" as const,
          entityId: input.model.id,
          revisionId: String(input.model.revision),
        };
        const entries = adaptRuleTraceToCanonical({
          projection: {
            ...input.projection,
            trace: input.finalSettlementTrace!,
          },
          subjectRef,
          parameterDefinitions: input.patchOffsetGovernance?.parameterDefinitions,
        });
        if (input.automaticPricing) {
          entries.push(...adaptPricingTraceToCanonical({
            pricing: input.automaticPricing,
            subjectRef,
            ruleSetVersion: input.projection.ruleSetVersion,
            sequenceStart: entries.length + 1,
          }));
        }
        if (input.fiveAxisPreview) {
          entries.push(...adaptFiveAxisTraceToCanonical({
            preview: input.fiveAxisPreview,
            subjectRef,
            ruleSetVersion: input.projection.ruleSetVersion,
            sequenceStart: entries.length + 1,
          }));
        }
        const archive = createCalculationTraceArchive(entries);
        assertCalculationTraceUsesRuleSetVersion({
          archive,
          subjectRef,
          ruleSetVersion: input.projection.ruleSetVersion,
        });
        assertCalculationTraceMatchesFinalPanel({
          archive,
          subjectRef,
          finalPanelValues: input.finalPanelValues,
        });
        assertCalculationTraceMatchesPricing({
          archive,
          subjectRef,
          pricing: input.automaticPricing,
          ruleSetVersion: input.projection.ruleSetVersion,
        });
        assertCalculationTraceMatchesFiveAxis({
          archive,
          subjectRef,
          preview: input.fiveAxisPreview,
          ruleSetVersion: input.projection.ruleSetVersion,
        });
        return archive;
      })()
    : undefined;

  const governance = input.patchOffsetGovernance;
  const modelFinalPullKg = modelFinalPullKgForSnapshot(
    input.sku.projectionMatch.itemPartId,
    input.finalPanelValues,
  );
  const snapshotWithoutHash: Omit<ConfigurationSnapshot, "contentHash"> = {
    id:
      input.snapshotId ??
      "snapshot-" + input.model.id + "-v" + (input.version ?? 1),
    version: input.version ?? 1,
    modelId: input.model.id,
    modelRevision: input.model.revision,
    skuRevision: input.sku.revision,
    seriesRevision: input.series.revision,
    ruleSetVersion: input.projection.ruleSetVersion,
    projectionId: input.projection.id,
    reductionStackingMode: input.projection.reductionStackingMode,
    patchSetHash,
    ...(frozenPatches ? { patchReferences: frozenPatches.references } : {}),
    ...(input.publicationMode === "new_formal" && hasPatchDependency && governance ? {
      patchOffsetPolicyVersion: governance.policy?.version,
      patchReviewBatchRef: governance.reviewBatch?.batchId,
      patchValidationIssueFingerprints: (patchRangeEvaluation?.issues ?? [])
        .flatMap((issue) => issue.fingerprint ? [issue.fingerprint] : [])
        .sort(),
      patchValidationWaiverRefs: (governance.waivers ?? []).map((waiver) => waiver.waiverId).sort(),
    } : {}),
    finalPanelValues: structuredClone(input.finalPanelValues),
    ...(modelFinalPullKg !== undefined
      ? { modelFinalPullKg }
      : {}),
    componentSelections: structuredClone(input.componentSelections),
    technologyIds: structuredClone(input.technologyIds),
    attributeAffixIds: structuredClone(input.attributeAffixIds),
    passiveAffixIds: structuredClone(input.passiveAffixIds),
    attributeTrace: structuredClone(finalSettlementTrace ?? input.projection.trace),
    ...(calculationTrace ? { calculationTrace } : {}),
    passiveAffixPayloads: structuredClone(input.passiveAffixPayloads),
    projectionMatch: structuredClone(input.sku.projectionMatch),
    compatibilityReport: structuredClone(input.compatibilityReport),
    affinityReport: structuredClone(input.affinityReport),
    qualityReport: structuredClone(input.qualityReport),
    ...(input.qualityValueAssessment
      ? { qualityValueAssessment: structuredClone(input.qualityValueAssessment) }
      : {}),
    ...(input.publicationMode === "new_formal" || derivedPerformanceSummary
      ? {
          performanceSummary: structuredClone(
            derivedPerformanceSummary ?? unavailablePerformanceSummary(),
          ),
        }
      : {}),
    ...(input.pricingPolicyVersion
      ? { pricingPolicyVersion: input.pricingPolicyVersion }
      : {}),
    ...(input.automaticPricing
      ? { automaticPricing: structuredClone(input.automaticPricing) }
      : {}),
    validationReport: [
      ...structuredClone(combinedValidationReport),
      ...Object.entries(input.warningConfirmations).map(([code, reason]) => ({
        level: "info" as const,
        code: "WARNING_CONFIRMED_" + code,
        message: reason,
      })),
    ],
    publishedBy: input.publishedBy,
    ...(input.fiveAxisPreview
      ? { fiveAxisPreview: structuredClone(input.fiveAxisPreview) }
      : {}),
    ...(fiveAxisDispositionEvidence
      ? { fiveAxisDispositionEvidence }
      : {}),
    publishedAt: input.publishedAt,
  };
  return {
    ...snapshotWithoutHash,
    contentHash: deterministicHash(snapshotContent(snapshotWithoutHash)),
  };
}

export function verifySnapshotIntegrity(
  snapshot: ConfigurationSnapshot,
): boolean {
  if (
    snapshot.calculationTrace
    && !verifyCalculationTraceArchive(snapshot.calculationTrace)
  ) return false;
  if (snapshot.calculationTrace) {
    const matchingSubjects = snapshot.calculationTrace.entries
      .map((entry) => entry.subjectRef)
      .filter((subjectRef) =>
        subjectRef.entityType === "model"
        && subjectRef.entityId === snapshot.modelId
        && subjectRef.revisionId === String(snapshot.modelRevision),
      );
    const uniqueSubjects = new Map(
      matchingSubjects.map((subjectRef) => [entityRefIdentity(subjectRef), subjectRef]),
    );
    if (uniqueSubjects.size !== 1) return false;
    try {
      assertCalculationTraceUsesRuleSetVersion({
        archive: snapshot.calculationTrace,
        subjectRef: [...uniqueSubjects.values()][0],
        ruleSetVersion: snapshot.ruleSetVersion,
      });
      assertCalculationTraceMatchesFinalPanel({
        archive: snapshot.calculationTrace,
        subjectRef: [...uniqueSubjects.values()][0],
        finalPanelValues: snapshot.finalPanelValues,
      });
      assertCalculationTraceMatchesPricing({
        archive: snapshot.calculationTrace,
        subjectRef: [...uniqueSubjects.values()][0],
        pricing: snapshot.automaticPricing,
        ruleSetVersion: snapshot.ruleSetVersion,
      });
      assertCalculationTraceMatchesFiveAxis({
        archive: snapshot.calculationTrace,
        subjectRef: [...uniqueSubjects.values()][0],
        preview: snapshot.fiveAxisPreview,
        ruleSetVersion: snapshot.ruleSetVersion,
      });
    } catch {
      return false;
    }
  }
  const { contentHash, ...content } = snapshot;
  return deterministicHash(content) === contentHash;
}

export interface CreateUpgradeCandidateInput {
  id: string;
  modelId: string;
  currentSnapshot: ConfigurationSnapshot;
  proposedProjection: DerivedProjection;
  proposedValues: Record<string, number | string>;
  patches: ProjectionPatchRuleSource[];
  patchRevisions?: PatchRevisionRecord[];
  validationReport: ValidationIssue[];
  createdAt: string;
}

function valueDifferences(
  oldValues: Record<string, number | string>,
  newValues: Record<string, number | string>,
): PatchRebaseDifference[] {
  return Array.from(
    new Set([...Object.keys(oldValues), ...Object.keys(newValues)]),
  )
    .sort()
    .flatMap((path): PatchRebaseDifference[] => {
      const oldValue = oldValues[path];
      const newValue = newValues[path];
      if (oldValue === newValue) return [];
      return [
        {
          path,
          oldBase: oldValue,
          newBase: newValue,
          oldResult: oldValue,
          newResult: newValue,
        },
      ];
    });
}

export function createUpgradeCandidate(
  input: CreateUpgradeCandidateInput,
): UpgradeCandidate {
  if (!verifySnapshotIntegrity(input.currentSnapshot)) {
    throw new Error("当前 ConfigurationSnapshot 完整性校验失败。");
  }
  const patchRebasePreview = previewPatchRebase({
    oldBase: input.currentSnapshot.finalPanelValues,
    newBase: input.proposedProjection.values,
    patches: input.patches,
    oldProjectionId: input.currentSnapshot.projectionId,
    newProjectionId: input.proposedProjection.id,
    oldRuleSetVersion: input.currentSnapshot.ruleSetVersion,
    newRuleSetVersion: input.proposedProjection.ruleSetVersion,
  });
  return {
    id: input.id,
    modelId: input.modelId,
    fromSnapshotId: input.currentSnapshot.id,
    proposedProjectionId: input.proposedProjection.id,
    proposedRuleSetVersion: input.proposedProjection.ruleSetVersion,
    proposedValues: structuredClone(input.proposedValues),
    differences: valueDifferences(
      input.currentSnapshot.finalPanelValues,
      input.proposedValues,
    ),
    patchRebasePreview,
    validationReport: structuredClone(input.validationReport),
    status: "pending",
    createdAt: input.createdAt,
  };
}

export function createRuleChangeProposal(input: {
  id: string;
  title: string;
  description: string;
  patches: ProjectionPatchRuleSource[];
  patchRevisions?: PatchRevisionRecord[];
  targetRuleSetVersion: string;
  impactEntityIds: string[];
  expectedChanges: PatchRebaseDifference[];
  conflicts: string[];
  createdBy: string;
  createdAt: string;
}): RuleChangeProposal {
  const invalid = input.patches.filter(
    (patch) => patch.status !== "approved" || !patch.reason.trim(),
  );
  if (invalid.length) {
    throw new Error("只有已批准且有明确原因的 Patch 才能形成规则提案。");
  }
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    sourcePatchIds: input.patches.map((patch) => patch.id),
    targetRuleSetVersion: input.targetRuleSetVersion,
    impactEntityIds: structuredClone(input.impactEntityIds),
    expectedChanges: structuredClone(input.expectedChanges),
    conflicts: structuredClone(input.conflicts),
    status: "draft",
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  };
}

export function auditEntry(
  entry: GovernanceAuditLogEntry,
): GovernanceAuditLogEntry {
  return structuredClone(entry);
}
