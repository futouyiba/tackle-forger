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
  FiveAxisViewDefinition,
  PatchRebaseDifference,
  PatchOffsetPolicyVersion,
  ParameterDefinition,
  PatchReviewBatch,
  PatchRevisionRecord,
  PatchValidationWaiver,
  ProjectionPatchRuleSource,
  PurchasableModel,
  RuleChangeProposal,
  RuleSetVersion,
  SeriesDefinition,
  SkuDrawer,
  UpgradeCandidate,
  ValidationIssue,
  PassiveSkillPayload,
  WorkspacePolicyRecord,
} from "./types";
import { structuralPullParameterKey } from "./projection-matcher";
import type { ModelAffixValueAssessment } from "./quality-value-policy";
import type { PricingTrialResult } from "./pricing-policy";
import {
  assertSeriesItemPartChainEnabled,
} from "./enabled-item-parts";

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
  pricingPolicyVersion?: string;
  automaticPricing?: PricingTrialResult;
  validationReport: ValidationIssue[];
  fiveAxisPreview?: ModelFiveAxisPreview;
  fiveAxisDefinition?: FiveAxisViewDefinition;
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
    if (!input.qualityValueAssessment?.formal) {
      blocking.push({
        level: "error",
        code: "QUALITY_POLICY_NOT_FORMAL",
        message: "新 Snapshot 必须绑定通过所选品质区间校验的正式品质评分结果。",
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
  if (input.publicationMode === "new_formal" && input.fiveAxisPreview) {
    const definition = input.fiveAxisDefinition;
    if (!definition || definition.publicationState !== "PUBLISHED") {
      throw new Error("五轴预览使用的 FiveAxisViewDefinition 尚未发布，禁止创建正式 Snapshot。");
    }
    const { definitionHash, ...definitionContent } = definition;
    if (deterministicHash(definitionContent) !== definitionHash) {
      throw new Error("FiveAxisViewDefinition 完整性校验失败，禁止创建正式 Snapshot。");
    }
    if (
      input.fiveAxisPreview.fiveAxisDefinitionId !== definition.definitionId
      || input.fiveAxisPreview.fiveAxisDefinitionVersion !== definition.version
      || input.fiveAxisPreview.fiveAxisDefinitionRevision !== definition.revision
      || input.fiveAxisPreview.fiveAxisDefinitionHash !== definition.definitionHash
      || input.fiveAxisPreview.fiveAxisRuleVersion !== definition.fiveAxisRuleVersion
      || input.fiveAxisPreview.sourceRevision !== definition.sourceRevision
      || input.fiveAxisPreview.tackleFitComparison.fiveAxisDefinitionId !== definition.definitionId
      || input.fiveAxisPreview.tackleFitComparison.fiveAxisDefinitionVersion !== definition.version
      || input.fiveAxisPreview.tackleFitComparison.fiveAxisRuleVersion !== definition.fiveAxisRuleVersion
      || input.fiveAxisPreview.tackleFitComparison.vertexSetHash !== input.fiveAxisPreview.vertexSetHash
    ) {
      throw new Error("五轴预览的定义、规则或顶点版本链不一致，禁止创建正式 Snapshot。");
    }
  }

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
    attributeTrace: structuredClone(input.projection.trace),
    passiveAffixPayloads: structuredClone(input.passiveAffixPayloads),
    projectionMatch: structuredClone(input.sku.projectionMatch),
    compatibilityReport: structuredClone(input.compatibilityReport),
    affinityReport: structuredClone(input.affinityReport),
    qualityReport: structuredClone(input.qualityReport),
    ...(input.qualityValueAssessment
      ? { qualityValueAssessment: structuredClone(input.qualityValueAssessment) }
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
