import type {
  FeishuSourceRevision,
  FeishuWorkbookRef,
} from "./feishu-workbook";
import type {
  PricingPolicyDraft,
  PricingPolicyVersion,
  PricingTrialResult,
} from "./pricing-policy";
import type { SourceIdentityMigrationReport } from "./source-id-migration";
import type { ConfigExportMapping } from "./config-export-mapping";
import type {
  ModelAffixValueAssessment,
  QualityValuePolicyDraft,
} from "./quality-value-policy";
import type { ConfigIdGovernanceState } from "./config-id-governance";
import type { CalculationTraceArchive } from "./calculation-trace";
export type {
  CalculationTraceArchive,
  CalculationTraceEntry,
} from "./calculation-trace";
import type {
  PerformanceSummaryDefinition,
  PerformanceSummarySnapshot,
} from "./performance-summary";

export type ItemKind = "rod" | "reel" | "line";
export type RuleOperation = "add" | "multiply" | "set" | "min" | "max" | "formula";
export type DimensionKey =
  | "structure"
  | "material"
  | "function"
  | "performance"
  | "technology"
  | "series";

export interface ParameterDefinition {
  key: string;
  label: string;
  itemKind: ItemKind;
  /** v3 部位注册表引用；itemKind 作为旧界面兼容字段保留。 */
  itemPartId?: string;
  unit: string;
  precision: number;
  benefitMode?: "higher_better" | "lower_better" | "target_range" | "contextual";
  balanceWeight?: number;
  normalizationScale?: number;
  allowedOperations?: RuleOperation[];
  targetRange?: { min: number; max: number };
  notes: string;
}

export interface WeightTemplate {
  id: string;
  name: string;
  fishMinKg: number;
  fishMaxKg: number;
  nominalFishKg: number;
  /** 数值越大优先级越高；仅在结构拉力比例距离相同时参与确定性决胜。 */
  templatePriority?: number;
  tier: string;
  values: Record<string, number | string>;
  notes: string;
}

export type ReductionStackingMode =
  | "linear_subtraction"
  | "diminishing_division";

export type FunctionIntensity = 1 | 2 | 3;
export type RuleSetStatus = "draft" | "published" | "superseded";
export type ProjectionLayer =
  | "base_weight_template"
  | "method"
  | "item_type"
  | "function"
  | "performance"
  | "quality"
  | "series_patch"
  | "sku_patch"
  | "model_patch"
  | "attribute_affix"
  | "final_review_patch"
  | "parameter_definition"
  | "validation";

export interface WorkspaceRuleSettings {
  /**
   * @deprecated 仅用于重放旧 RuleSet/Snapshot。新运行时固定使用
   * ReductionStackingPolicyVersion，不得再把该字段作为公式选择器。
   */
  reductionStackingMode?: ReductionStackingMode;
  reductionStackingPolicyVersion?: string;
  /**
   * @deprecated OPEN-004 已决定不使用独立偏移阈值。仅用于读取旧工作区；
   * v16 迁移会把非空值隔离到迁移复核记录并清空，运行时不得消费。
   */
  patchOffsetLimits: {
    warning?: number;
    error?: number;
  };
}

export interface RuleSetVersion {
  id: string;
  version: number;
  status: RuleSetStatus;
  settings: WorkspaceRuleSettings;
  sourceRevisionIds: string[];
  createdAt: string;
  publishedAt?: string;
  publishedBy?: string;
  warningAcknowledgements?: Array<{ issueKey: string; reason: string }>;
  publicationHash?: string;
  notes: string;
}

export type AffixNumericDirection = "increase" | "decrease";
export type CanonicalAffixOperationKind =
  | "percent_adjust"
  | "flat_adjust"
  | "clamp_add"
  | "enum_add"
  | "set";

export interface CanonicalAttributeOperation {
  operationId: string;
  operationIndex: number;
  sourceAffixId: string;
  sourceAffixRevision: string;
  parameterKey: string;
  operation: CanonicalAffixOperationKind;
  direction?: AffixNumericDirection;
  magnitude?: number;
  publishedMagnitudeRange?: {
    min: number;
    max: number;
    ruleSetVersion: string;
  };
  rawLexical?: string;
  clampMin?: number;
  clampMax?: number;
  value?: number | string | boolean;
  migrationEvidence?: {
    sourceShape: "canonical" | "legacy_named" | "legacy_signed";
    originalOperation?: string;
    originalValue?: number;
    negativeZero?: boolean;
  };
}

export interface ReductionStackingPolicySource {
  workbookRefId: "feishu-workbook:tackle-design";
  sheetId: "zrVOxd";
  sourceRevisionId: string;
  sourceRevision: string;
  ruleId: string;
  parameterKey: string;
}

export interface ReductionStackingPolicyVersion {
  id: string;
  version: string;
  status: "draft" | "published" | "superseded";
  strategy: "bidirectional_ratio";
  numericContract: "ieee754-binary64-v1";
  operationOrder: [
    "set",
    "percent_adjust",
    "flat_adjust",
    "clamp_add",
    "final_review_patch",
    "parameter_definition",
  ];
  source?: ReductionStackingPolicySource;
  issues: ValidationIssue[];
  contentHash: string;
  inputHash: string;
  createdAt: string;
  publishedAt?: string;
  publishedBy?: string;
}

export interface ItemPartDefinition {
  id: string;
  name: string;
  legacyItemKind?: ItemKind;
  activeInGeneration: boolean;
  parameterKeys: string[];
  notes: string;
}

export interface MethodProfile {
  id: string;
  name: string;
  rules: AdjustmentRule[];
  enabled: boolean;
  sourceRevisionId?: string;
  notes: string;
}

export interface ItemTypeProfile {
  id: string;
  name: string;
  methodIds: string[];
  itemPartIds: string[];
  rules: AdjustmentRule[];
  enabled: boolean;
  sourceRevisionId?: string;
  notes: string;
}

export interface FunctionIntensityRuleSet {
  intensity: FunctionIntensity;
  rules: AdjustmentRule[];
  /** 飞书 03_功能定位中的稳定源行 ID（func_*）；只用于溯源，不作为聚合 FunctionProfile 的 ID。 */
  sourceRowId?: string;
}

export interface FunctionProfile {
  id: string;
  name: string;
  rules: AdjustmentRule[];
  intensityRules: FunctionIntensityRuleSet[];
  enabled: boolean;
  sourceRevisionId?: string;
  notes: string;
}

export interface PerformanceProfile {
  id: string;
  name: string;
  rules: AdjustmentRule[];
  /** OPEN-002：只保留旧标签，不定义最终强度命名或曲线。 */
  legacyIntensityLabel?: string;
  enabled: boolean;
  sourceRevisionId?: string;
  notes: string;
}

export interface QualityProfile {
  id: string;
  letter: "C" | "B" | "A" | "S";
  colorName: "绿" | "蓝" | "紫" | "橙";
  rank: 1 | 2 | 3 | 4;
  rules: AdjustmentRule[];
  enabled: boolean;
  notes: string;
}
export type AttributeContributionOperation =
  | "percent_bonus"
  | "flat_bonus"
  | "reduction"
  | "reduction_diminishing"
  | "flat_reduction"
  | CanonicalAffixOperationKind;

export interface AttributeContribution {
  id: string;
  sourceId: string;
  sourceName: string;
  parameterKey: string;
  operation: AttributeContributionOperation;
  value: number;
  sourceAffixRevision?: string;
  operationIndex?: number;
  operationId?: string;
  direction?: AffixNumericDirection;
  magnitude?: number;
  publishedMagnitudeRange?: CanonicalAttributeOperation["publishedMagnitudeRange"];
  rawLexical?: string;
  clampMin?: number;
  clampMax?: number;
  setValue?: number | string | boolean;
}

export type ProjectionPatchOperation =
  | { op: "set"; path: string; value: unknown }
  | { op: "add"; path: string; value: number }
  | { op: "multiply"; path: string; value: number }
  | { op: "remove"; path: string };
export interface ProjectionPatchRuleSource {
  id: string;
  scope: "series" | "sku" | "model" | "final_review";
  scopeId: string;
  reason: string;
  author: string;
  createdAt?: string;
  baseProjectionId: string;
  baseRuleSetVersion: string;
  status: "draft" | "approved" | "superseded";
  order: number;
  rules: AdjustmentRule[];
  operations?: ProjectionPatchOperation[];
}

export type PatchState =
  | "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "ACTIVE"
  | "REBASE_REQUIRED" | "ABSORBED" | "PARTIALLY_ABSORBED"
  | "WITHDRAWN" | "SUPERSEDED";
export type PatchMirrorSyncState =
  | "NOT_SYNCED" | "PENDING" | "WRITING" | "SYNCED"
  | "REMOTE_CHANGED" | "CONFLICT" | "WRITE_FAILED";
export type PatchAttentionState = "ORPHANED";
export type PatchLayerType =
  | "derivation" | "series" | "sku" | "model" | "final_review" | "projection_pin";

export interface PatchOperationRecord {
  patchId: string;
  patchRevision: number;
  operationId: string;
  operationIndex: number;
  parameterKey: string;
  operation: "set" | "add" | "multiply" | "clear";
  operand: unknown;
  before: unknown;
  after: unknown;
}

export interface PatchSnapshotReference {
  patchId: string;
  patchRevision: number;
  orderedOperationIds: string[];
}

export type PatchOffsetPolicyMode = "FINAL_RANGE_WITH_MANDATORY_REVIEW";
export type PatchOffsetThresholdMode = "NONE";
export type PatchRangeEndpointMode = "INCLUSIVE";

export interface PatchOffsetPolicyVersion {
  policyId: string;
  policyType: "patchOffsetPolicy";
  version: string;
  status: "draft" | "published" | "superseded";
  value: {
    mode: PatchOffsetPolicyMode;
    offsetThresholds: PatchOffsetThresholdMode;
    rangeEndpoints: PatchRangeEndpointMode;
    applicableScopes: Array<"series" | "sku" | "model" | "final_review">;
  };
  createdAt: string;
  publishedAt?: string;
  publishedBy?: string;
  contentHash: string;
}

export interface PatchReviewSubjectRef {
  scopeType: "series" | "sku" | "model" | "final_review" | "snapshot_batch";
  entityId: string;
  revision: number;
}

export interface PatchRangeResultEvidence {
  contextId: string;
  parameterKey: string;
  standardUnit: string;
  finalValue: number;
  min: number;
  max: number;
  valid: boolean;
  issueFingerprint?: string;
  skuRef?: string;
  targetPullKg?: number;
  projectionId: string;
  weightBandId: string;
  constraintRuleRef: string;
  constraintRuleVersion: string;
}

export interface PatchReviewObjectEvidence {
  subjectRef: PatchReviewSubjectRef;
  objectInputHash: string;
  patchReferences: PatchSnapshotReference[];
  patchSetHash: string;
  finalValues: Record<string, number>;
  rangeResults: PatchRangeResultEvidence[];
  issueFingerprints: string[];
  state: "FRESH" | "STALE";
}

export interface PatchReviewBatch {
  batchId: string;
  policyVersion: string;
  gate: "REVIEW" | "PUBLISH";
  status: "FRESH" | "PARTIALLY_STALE" | "STALE";
  objectEvidence: PatchReviewObjectEvidence[];
  reviewedBy: string;
  reviewedAt: string;
  inputHash: string;
}

export interface PatchValidationWaiver {
  waiverId: string;
  waiverDecisionId: string;
  issueFingerprint: string;
  policyVersion: string;
  gate: "REVIEW" | "PUBLISH" | "EXPORT";
  environmentId?: string;
  channelKey?: string;
  scopeRef: PatchReviewSubjectRef;
  objectInputHash: string;
  patchSetHash: string;
  reason: string;
  approvedBy: string;
  approvedAt: string;
}

export interface PatchValidationWaiverDecision {
  waiverDecisionId: string;
  scopeRef: PatchReviewSubjectRef;
  reason: string;
  approvedBy: string;
  approvedAt: string;
  waiverIds: string[];
  decisionHash: string;
}

export interface PatchRevisionRecord {
  patchId: string;
  patchRevision: number;
  scopeType: "series" | "sku" | "model" | "derivation" | "final_review";
  layerType: PatchLayerType;
  subjectEntityId: string;
  subjectName: string;
  parentEntityId?: string;
  baseRuleSetVersion: string;
  baseObjectRevision: number;
  state: PatchState;
  mirrorSyncState: PatchMirrorSyncState;
  attentionStates: PatchAttentionState[];
  reason: string;
  evidence: string[];
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  supersedesPatchId?: string;
  ruleProposalId?: string;
  snapshotRefs: string[];
  operations: PatchOperationRecord[];
  revisionHash: string;
  rawPayload?: unknown;
}

export interface PatchMirrorOperationResult {
  operationId: string;
  status: "PENDING" | "WRITTEN" | "FAILED" | "VERIFIED";
  remoteRowId?: string;
  errorCode?: string;
  message?: string;
}

export interface PatchMirrorSyncCommand {
  idempotencyKey: string;
  patchId: string;
  patchRevision: number;
  expectedRemoteRevision?: string;
  state: "PENDING" | "WRITING" | "READBACK_REQUIRED" | "COMPLETED" | "FAILED";
  operationResults: PatchMirrorOperationResult[];
  readbackEvidence?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PatchMirrorCollaborationEntry {
  entryId: string;
  kind: "NOTE" | "REVIEW_COMMENT";
  authorId: string;
  authoredAt: string;
  remoteRevision: string;
  content: string;
}

export interface PatchMirrorRemoteRow {
  remoteRowId: string;
  patchId: string;
  patchRevision: number;
  operationId: string;
  operationIndex: number;
  scopeType: PatchRevisionRecord["scopeType"];
  layerType: PatchLayerType;
  subjectEntityId: string;
  baseRuleSetVersion: string;
  baseObjectRevision: number;
  parameterKey: string;
  operation: PatchOperationRecord["operation"];
  operand: unknown;
  before: unknown;
  after: unknown;
  snapshotRefs: string[];
  collaborationEntries?: PatchMirrorCollaborationEntry[];
  sharedRuleSuggestion?: { value: boolean; revision: string };
}

export interface PatchMirrorValidationIssue {
  source: "patch";
  code: "PATCH_MIRROR_ROW_MISSING" | "PATCH_MIRROR_UNKNOWN_KEY" | "PATCH_MIRROR_DUPLICATE_KEY" | "PATCH_MIRROR_AUDIT_FIELD_TAMPERED" | "PATCH_MIRROR_GROUP_INCOMPLETE" | "PATCH_MIRROR_COLLABORATION_INVALID" | "PATCH_MIRROR_EXPECTED_REVISION_CONFLICT";
  severity: "ERROR" | "WARNING";
  key: string;
  patchId?: string;
  patchRevision?: number;
  operationId?: string;
  remoteRowId?: string;
  field?: string;
  message: string;
}

export interface PatchMirrorPullAudit {
  pulledAt: string;
  remoteRevision: string;
  issues: PatchMirrorValidationIssue[];
  quarantinedRemoteRowIds: string[];
  refillDetailKeys: string[];
}

export interface PatchPatternSummary {
  patternId: string;
  layerType: PatchLayerType;
  parameterKey: string;
  operation: PatchOperationRecord["operation"];
  direction: "increase" | "decrease" | "replace" | "clear" | "mixed";
  methodId?: string;
  typeId?: string;
  functionId?: string;
  weightBandId?: string;
  patchRevisionRefs: Array<{ patchId: string; patchRevision: number }>;
  subjectEntityIds: string[];
  frequency: number;
  analysisHash: string;
}

export interface RuleSourceChangeDraft {
  id: string;
  patternId: string;
  sourcePatchRevisionRefs: Array<{ patchId: string; patchRevision: number }>;
  targetLayerType: PatchLayerType;
  parameterKey: string;
  proposedOperation: PatchOperationRecord["operation"];
  impactSubjectEntityIds: string[];
  rationale: string;
  status: "DRAFT" | "WITHDRAWN" | "SUBMITTED";
  createdBy: string;
  createdAt: string;
  inputHash: string;
}


export type PatchAbsorptionOutcome =
  | "FULLY_COVERED" | "PARTIALLY_COVERED" | "NOT_COVERED" | "REBASE_REQUIRED";

export interface PatchAbsorptionOperationEvidence {
  operationId: string;
  outcome: PatchAbsorptionOutcome;
  oldPatchedValue: unknown;
  newRuleValue: unknown;
  newRulePlusPatchValue: unknown;
  traceHash: string;
  residualOperation?: {
    operation: PatchOperationRecord["operation"];
    operand: unknown;
    before: unknown;
    after: unknown;
  };
}

export interface PatchAbsorptionAssessment {
  assessmentId: string;
  patchId: string;
  sourcePatchRevision: number;
  resultPatchRevision: number;
  ruleProposalId: string;
  publishedRuleSetVersion: string;
  resultState: "ABSORBED" | "PARTIALLY_ABSORBED" | "ACTIVE" | "REBASE_REQUIRED";
  operationEvidence: PatchAbsorptionOperationEvidence[];
  inputHash: string;
  assessedBy: string;
  assessedAt: string;
}
export interface PatchLedger {
  schemaVersion: number;
  revisions: PatchRevisionRecord[];
  mirrorCommands: PatchMirrorSyncCommand[];
  ruleSourceChangeDrafts: RuleSourceChangeDraft[];
  absorptionAssessments: PatchAbsorptionAssessment[];
  mirrorPullAudits: PatchMirrorPullAudit[];
  migrationReviewItems: Array<{
    id: string;
    patchId: string;
    patchRevision: number;
    reason: string;
    preservedPayload: unknown;
  }>;
}

export interface ProjectionTraceContribution {
  sequence: number;
  ruleId: string;
  sourceId: string;
  sourceName: string;
  parameterKey: string;
  operation: RuleOperation | AttributeContributionOperation | "base";
  before: number | string | null;
  operand: number | string;
  after: number | string | null;
  numericEvidence?: {
    stage: string;
    rawLexical?: string;
    operandBinary64?: string;
    beforeBinary64?: string;
    afterBinary64?: string;
    anomaly: "none" | "no_effect" | "overflow" | "underflow_to_zero" | "invalid";
  };
}

export interface ProjectionTraceStep {
  layer: ProjectionLayer;
  sourceIds: string[];
  contributions: ProjectionTraceContribution[];
}

export interface ProjectionWarning {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  layer: ProjectionLayer;
  parameterKey?: string;
  sourceId?: string;
  severity?: "INFO" | "WARNING" | "ERROR" | "BLOCKER";
  gate?: "NONE" | "REVIEW" | "PUBLISH" | "EXPORT";
  fingerprint?: string;
  evidence?: Record<string, unknown>;
}

export interface DerivedProjection {
  id: string;
  weightTemplateId: string;
  methodId: string;
  typeId: string;
  functionId: string;
  functionIntensity: FunctionIntensity;
  performanceId?: string;
  qualityId?: string;
  ruleSetVersion: string;
  /** 旧投影重放字段；新投影不得消费它来选择公式。 */
  reductionStackingMode?: ReductionStackingMode;
  reductionStackingPolicyVersion?: string;
  formalStatus?: "FORMAL" | "NON_FORMAL";
  /** 仅包含 WeightTemplate × Method × Type × FunctionProfile 基础层，早于 functionIntensity 与商品层。 */
  structuralValues?: Record<string, number | string>;
  values: Record<string, number | string>;
  /** OPEN-001 新投影冻结从 AffixOutput 到最终 ParameterDefinition 的完整证据链。 */
  affixRuntimeEvidence?: AffixRuntimeEvidence;
  trace: ProjectionTraceStep[];
  warnings: ProjectionWarning[];
  sourceHash: string;
  createdAt: string;
}

export interface MigrationReviewItem {
  id: string;
  sourceType:
    | "modifier"
    | "candidate_override"
    | "quality"
    | "series_recipe"
    | "series_definition"
    | "candidate_search_recipe"
    | "unknown";
  sourceId: string;
  message: string;
  preservedPayload: unknown;
  status: "pending" | "resolved";
}
export type CompatibilityEffect = "allow" | "deny" | "require";
export type CompatibilityAxis =
  | "method_type"
  | "type_weight"
  | "type_function"
  | "line_material"
  | "model_component"
  | "rod_reel_line";

export interface CompatibilityContext {
  methodId: string;
  typeId: string;
  targetPullKg?: number;
  functionId?: string;
  functionIntensity?: FunctionIntensity;
  performanceId?: string;
  qualityId?: string;
  itemPartId?: string;
  lineMaterialId?: string;
  componentIds: string[];
  tags: string[];
}

export interface CompatibilitySelector {
  methodId?: string;
  typeId?: string;
  functionId?: string;
  functionIntensity?: FunctionIntensity;
  performanceId?: string;
  qualityId?: string;
  itemPartId?: string;
  lineMaterialId?: string;
  minPullKg?: number;
  maxPullKg?: number;
  componentIds?: string[];
  tags?: string[];
}

export interface CompatibilityRequirement {
  kind: "tag" | "component" | "field";
  key: string;
  value?: string | number;
  message: string;
}

export interface CompatibilityRule {
  id: string;
  axis: CompatibilityAxis;
  effect: CompatibilityEffect;
  selector: CompatibilitySelector;
  requirements: CompatibilityRequirement[];
  priority: number;
  ruleSetVersion: string;
  reason: string;
  suggestion: string;
  enabled: boolean;
}

export interface MatchedCompatibilityRule {
  ruleId: string;
  axis: CompatibilityAxis;
  effect: CompatibilityEffect;
  specificity: number;
  priority: number;
  reason: string;
}

export interface HardCompatibilityFailure {
  ruleId: string;
  code: "DENIED" | "REQUIREMENT_MISSING";
  message: string;
  suggestion: string;
}

export interface HardCompatibilityResult {
  allowed: boolean;
  matchedRules: MatchedCompatibilityRule[];
  decisiveRuleIds: string[];
  failures: HardCompatibilityFailure[];
  suggestions: string[];
}

export type AffinityAxis =
  | "method_type"
  | "type_weight"
  | "type_function"
  | "function_performance"
  | "material_function"
  | "quality_specialization"
  | "model_component"
  | "series_coherence";

export type AffinityAxisWeights = Record<AffinityAxis, number>;

export interface AffinityRule {
  id: string;
  axis: AffinityAxis;
  selector: CompatibilitySelector;
  score: number;
  priority: number;
  ruleSetVersion: string;
  reason: string;
  enabled: boolean;
}

export interface AffinityAxisContribution {
  axis: AffinityAxis;
  score: number;
  weight: number;
  weightedScore: number;
  ruleId?: string;
  specificity: number;
  reason: string;
}

export interface AffinityScoreResult {
  score: number;
  contributions: AffinityAxisContribution[];
  matchedRuleIds: string[];
  warnings: string[];
}

export interface ProjectionMatchTraceItem {
  stage:
    | "identity"
    | "hard_compatibility"
    | "range"
    | "weight_distance"
    | "affinity"
    | "attribute_distance"
    | "stable_id"
    | "derived_pull_tiebreak"
    | "template_priority"
    | "pin";
  candidateId?: string;
  detail: string;
}

export interface ProjectionMatch {
  targetPullKg: number;
  matchedStructuralPullKg: number;
  pullDistance: number;
  itemPartId: string;
  projectionId: string;
  weightTemplateId: string;
  ruleSetVersion: string;
  affinityScore: number;
  normalizedAttributeDistance: number;
  reasons: string[];
  alternatives: string[];
  pinnedByUser: boolean;
  trace: ProjectionMatchTraceItem[];
}

export interface PatchApplicationTraceItem {
  patchId: string;
  scope: "series" | "sku" | "model" | "final_review";
  scopeId: string;
  path: string;
  operation: ProjectionPatchOperation["op"];
  before: unknown;
  operand?: unknown;
  after: unknown;
}

export interface PatchApplicationIssue {
  level: "error" | "warning" | "info";
  code:
    | "PATCH_PATH_INVALID"
    | "PATCH_NUMERIC_REQUIRED"
    | "PATCH_SET_CONFLICT"
    | "PATCH_REMOVE_MISSING"
    | "PATCH_BASE_MISMATCH"
    | "PATCH_SKIPPED";
  patchId: string;
  path?: string;
  message: string;
  requiresReview: boolean;
}

export interface PatchApplicationResult<T = Record<string, unknown>> {
  value: T;
  appliedPatchIds: string[];
  trace: PatchApplicationTraceItem[];
  issues: PatchApplicationIssue[];
}

export interface PatchRebaseDifference {
  path: string;
  oldBase: unknown;
  newBase: unknown;
  oldResult: unknown;
  newResult: unknown;
}

export interface PatchRebasePreview<T = Record<string, unknown>> {
  oldProjectionId: string;
  newProjectionId: string;
  oldRuleSetVersion: string;
  newRuleSetVersion: string;
  oldResult: T;
  newResult: T;
  differences: PatchRebaseDifference[];
  issues: PatchApplicationIssue[];
  requiresReview: boolean;
}
export type QualityProfileId =
  | "quality_c_green"
  | "quality_b_blue"
  | "quality_a_purple"
  | "quality_s_orange";
export type EntityLifecycleStatus =
  | "draft"
  | "approved"
  | "published"
  | "superseded";

export interface Collection {
  id: string;
  name: string;
  brandStory: string;
  seriesIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type PartConstraintReviewStatus = "CONFIRMED" | "NEEDS_REVIEW";
export type PartConstraintSlot = "rod" | "reel" | "line";
export type PartConstraintItemPartId = "part:rod" | "part:reel" | "part:line";
export type PartConstraintFieldName =
  | "templateIds"
  | "materialIds"
  | "requiredAffixIds"
  | "optionalAffixPoolIds"
  | "typeIds";

export interface PartConstraintSetRef {
  constraintSetId: string;
  revision: number;
  contentHash: string;
}

export interface PartConstraintSourceRevisionRef {
  sourceType:
    | "legacy_series_recipe"
    | "series_definition"
    | "candidate_search_recipe";
  sourceId: string;
  /** 旧载体没有 revision 时必须保持 null，不得伪造。 */
  revisionId: string | null;
  /**
   * 排除 partConstraintSetRef 的无环来源投影；持久化来源可据此重新计算并验证。
   */
  hashProjectionVersion: "WITHOUT_PART_CONSTRAINT_SET_REF_V1";
  contentHash: string;
}

export interface PartConstraintFieldTrace {
  traceId: string;
  itemPartId: PartConstraintItemPartId;
  field: PartConstraintFieldName;
  sourceRef: PartConstraintSourceRevisionRef;
  sourcePath: string;
  /** 记录复制、改名或合成等迁移转换，保证 Trace 可重放。 */
  transformationCodes: string[];
  reviewStatus: PartConstraintReviewStatus;
  diagnosticCodes: string[];
  /** 保留该字段的迁移输入，包括无法解释的值。 */
  rawPayload: unknown;
}

export interface PartConstraint {
  itemPartId: PartConstraintItemPartId;
  reviewStatus: PartConstraintReviewStatus;
  templateIds: string[];
  materialIds: string[];
  requiredAffixIds: string[];
  optionalAffixPoolIds: string[];
  /**
   * 只有组件注册表明确发布该部位的版本化 type 分类时才可用于权威过滤。
   * 迁移值默认 NEEDS_REVIEW，不等于 Series Type。
   */
  typeIds: string[];
  fieldTraceRefs: Record<PartConstraintFieldName, string>;
}

export interface PartConstraintMigrationEvidence {
  migratorVersion: string;
  sourceSchemaVersion: number;
  migratedAt: string;
  diagnosticCodes: string[];
  /** 完整保留来源对象及未知字段，供人工复核与审计导出。 */
  rawPayload: unknown;
}

export interface PartConstraintSet {
  /** 终身稳定且不得复用的对象身份。 */
  constraintSetId: string;
  /** 单调递增的不可变内容修订。 */
  revision: number;
  contentHash: string;
  reviewStatus: PartConstraintReviewStatus;
  parts: Record<PartConstraintSlot, PartConstraint>;
  sourceRef: PartConstraintSourceRevisionRef;
  traces: PartConstraintFieldTrace[];
  migrationEvidence: PartConstraintMigrationEvidence;
  createdBy: string;
  createdAt: string;
}

export interface SeriesSignatureAxis {
  parameterGroup: string;
  expectedDirection: "positive" | "negative" | "neutral" | "contextual";
  importance: number;
  tolerance: number;
}

export interface SeriesDefinition {
  id: string;
  collectionId?: string;
  revision: number;
  name: string;
  concept: string;
  fishingMethodId: string;
  typeId: string;
  /** 结构标杆匹配的明确部位；旧数据缺失时仅作兼容读取。 */
  itemPartId?: string;
  qualityId: QualityProfileId;
  coreFunctionId: string;
  functionIntensityPolicy:
    | { mode: "fixed"; intensity: FunctionIntensity }
    | { mode: "weight_curve"; values: Record<string, FunctionIntensity> };
  /** @deprecated 旧 Series 只读证据；新 revision 不得写入或消费。 */
  performanceProfileId?: string;
  /** @deprecated 与旧性能定位一同只读保留。 */
  performanceIntensityPolicy?: {
    mode: "legacy_label";
    label: string;
  };
  coreAffixIds: string[];
  secondaryAffixPoolIds: string[];
  forbiddenAffixIds: string[];
  planningPullRange?: {
    minKgf: number;
    maxKgf: number;
  };
  targetPullSpecifications: Array<{
    targetPullKgf: number;
    skuId: string;
  }>;
  signature: SeriesSignatureAxis[];
  patchIds: string[];
  /** schema v18：精确冻结分部位搜索约束 revision；旧调用方可在迁移前缺失。 */
  partConstraintSetRef?: PartConstraintSetRef;
  /** @deprecated 只用于旧工作区兼容；新逻辑消费 targetPullSpecifications。 */
  skuIds: string[];
  status: EntityLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SkuDrawer {
  id: string;
  revision: number;
  seriesId: string;
  targetPullKg: number;
  projectionMatch: ProjectionMatch;
  patchIds: string[];
  modelIds: string[];
  defaultModelId?: string;
  displayOrder: number;
  validationSummary: ValidationIssue[];
  status: EntityLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ModelComponentSelection {
  itemPartId: string;
  componentId: string;
  name: string;
  values: Record<string, number | string>;
}

export type FiveAxisPointSource =
  | "direct"
  | "context_inherited"
  | "not_applicable"
  | "missing"
  | "error";

export interface FiveAxisAxisDefinition {
  axisId: string;
  label: string;
  order: number;
  sourceParameterKeys: string[];
  applicablePartIds: string[];
  contextInheritanceId?: "single_applicable_source";
  direction: "higher_better" | "lower_better" | "target_range" | "contextual";
  transformId: string;
  vertexSelectorId: string;
  componentAggregationId: string;
  missingPolicy: "error" | "unavailable" | "ignore_not_applicable";
}

export interface FiveAxisViewDefinition {
  definitionId: string;
  version: string;
  revision: number;
  publicationState: "UNPUBLISHED" | "PUBLISHED" | "SUPERSEDED";
  definitionHash: string;
  fiveAxisRuleVersion: string;
  sourceRevision: string;
  axes: [
    FiveAxisAxisDefinition,
    FiveAxisAxisDefinition,
    FiveAxisAxisDefinition,
    FiveAxisAxisDefinition,
    FiveAxisAxisDefinition,
  ];
  displayBandConfigId?: string;
  seriesBaselinePolicy:
    | { mode: "explicit_model"; required: true }
    | { mode: "approved_model_median"; minimumModels: number }
    | { mode: "projection_reference" };
}

export interface FiveAxisEntityInput {
  entityId: string;
  itemPartId: string;
  label: string;
  fishWeightGradeId: string;
  revision?: number;
  values: Record<string, number | null | undefined>;
}

export interface FiveAxisVertexSet {
  fishWeightGradeId: string;
  fiveAxisRuleVersion: string;
  definitionId: string;
  definitionVersion: string;
  values: Record<string, number>;
  vertexSetHash: string;
}

export interface FiveAxisTraceEntry {
  step: string;
  message: string;
  value?: number | string | null;
}

export interface FiveAxisSeriesPoint {
  axisId: string;
  axisDefinitionVersion: string;
  rawValue: number | null;
  vertexValue: number | null;
  unclampedRatio: number | null;
  normalizedRatio: number | null;
  officialDisplayScore: number | null;
  comparisonScore: number | null;
  overflow: number | null;
  source: FiveAxisPointSource;
  participatesInRanking: boolean;
  trace: FiveAxisTraceEntry[];
}

export interface FiveAxisSeries {
  entityId: string;
  itemPartId: string;
  label: string;
  fishWeightGradeId: string;
  points: FiveAxisSeriesPoint[];
}

export interface FiveAxisAxisSummary {
  axisId: string;
  strongestEntityIds: string[];
  weakestEntityIds: string[];
  spread: number | null;
}

export interface FiveAxisComparisonView {
  mode: "tackle_fit" | "same_part_compare";
  referenceFishWeightGradeId: string;
  fiveAxisDefinitionId: string;
  fiveAxisDefinitionVersion: string;
  fiveAxisRuleVersion: string;
  vertexSetHash: string;
  scaleMode: "official_locked" | "comparison_expanded";
  series: FiveAxisSeries[];
  axisSummaries: FiveAxisAxisSummary[];
  validationIssues: ValidationIssue[];
}

export interface FiveAxisMetric {
  axisId: string;
  axisDefinitionVersion: string;
  componentRawValues: Record<string, number | null>;
  componentRatios: Record<string, number | null>;
  vertexValue: number | null;
  unclampedModelRatio: number | null;
  displayScore: number | null;
  trace: FiveAxisTraceEntry[];
}

export interface ModelFiveAxisPreview {
  modelId: string;
  fishWeightGradeId: string;
  fiveAxisDefinitionId: string;
  fiveAxisDefinitionVersion: string;
  /** 新预览冻结定义修订；历史 Snapshot 缺失时仍保持只读兼容。 */
  fiveAxisDefinitionRevision?: number;
  /** 新预览冻结定义内容哈希；历史 Snapshot 不补写，避免改变 contentHash。 */
  fiveAxisDefinitionHash?: string;
  fiveAxisRuleVersion: string;
  vertexSetHash: string;
  sourceRevision: string;
  metrics: FiveAxisMetric[];
  tackleFitComparison: FiveAxisComparisonView;
  inputHash: string;
}

export interface PurchasableModel {
  id: string;
  revision: number;
  skuId: string;
  name: string;
  modelVariantKey?: string;
  /**
   * OPEN-008 显式稳定配置键。正式预留前可由普通 Model 编辑创建新 revision；
   * 一旦 configIdBundleRef 存在，二者都必须由领域命令原样继承。
   */
  stableModelKey?: string;
  configIdBundleRef?: string;
  action: string;
  hardness: string;
  lengthM: number;
  fishWeightGradeId?: string;
  componentSelections: ModelComponentSelection[];
  technologyIds: string[];
  attributeAffixIds: string[];
  passiveAffixIds: string[];
  patchIds: string[];
  price: number;
  unlockPolicyRef?: string;
  commercePolicyRef?: string;
  configurationSnapshotId?: string;
  status: EntityLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateSearchRecipe {
  id: string;
  revision: number;
  name: string;
  methodIds: string[];
  typeIds: string[];
  functionIds: string[];
  /** @deprecated 旧搜索配方证据；新候选运行时忽略且不得写入。 */
  performanceIds: string[];
  qualityIds: QualityProfileId[];
  targetPullRangeKg: { min: number; max: number };
  maxCandidates: number;
  /** 精确引用约束集；候选运行不得解析为“最新 revision”。 */
  partConstraintSetRef?: PartConstraintSetRef;
  sourceLegacyRecipeId?: string;
  notes: string;
}

export interface ModelVariantInput {
  modelVariantKey: string;
  label: string;
  action: string;
  hardness: string;
  lengthM: number;
  componentSelections: ModelComponentSelection[];
  technologyIds: string[];
  attributeAffixIds: string[];
  passiveAffixIds: string[];
  patchIds: string[];
  tags: string[];
}

export interface CandidateGenerationEntityRef {
  entityId: string;
  revisionId: string;
}

export interface CandidateGenerationRequest {
  requestId: string;
  seriesRef: CandidateGenerationEntityRef;
  skuRefs: CandidateGenerationEntityRef[];
  recipeRef: CandidateGenerationEntityRef;
  recipeInput: Record<string, unknown>;
  enabledVariantKeys: string[];
  perSkuLimit: number;
  minimumAffinity?: number;
  acceptWarnings: boolean;
  sortDefinitionVersion: string;
  checkpointMode: "AUTO_CONTINUE" | "REVIEW_ON_CHANGE";
  inputHash: string;
  idempotencyKey: string;
}

export interface ModelCandidate {
  candidateId: string;
  runId: string;
  skuRef: CandidateGenerationEntityRef;
  modelVariantKey: string;
  candidateFingerprint: string;
  projectionMatchRef: string;
  proposedConfiguration: Record<string, unknown>;
  variant: ModelVariantInput;
  hardCompatibility: HardCompatibilityResult;
  affinity: AffinityScoreResult;
  invariantIssues: ValidationIssue[];
  warningCount: number;
  pullDistance: number;
  rank: number;
  rankReasons: string[];
  state: "generated" | "shortlisted" | "selected" | "discarded" | "expired" | "superseded";
}

export interface CandidateRun {
  runId: string;
  request: CandidateGenerationRequest;
  status: "completed" | "waiting_for_review" | "superseded" | "failed";
  candidates: ModelCandidate[];
  enumerationTotal: number;
  legalCount: number;
  excludedByCode: Record<string, number>;
  truncatedCount: number;
  inputHash: string;
  outputHash: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface CandidateMaterializationRecord {
  materializationId: string;
  runId: string;
  runOutputHash: string;
  selectedCandidateIds: string[];
  materializedModelIds: string[];
  issues: ValidationIssue[];
  actor: string;
  occurredAt: string;
  outputHash: string;
}

export interface PassiveSkillPayload {
  skillId: string;
  name: string;
  itemPartId: string;
  triggerType: string;
  triggerDescription: string;
  effectTarget: string;
  effectLogicDescription: string;
  exampleParameters: Record<string, number | string | boolean>;
  durationDescription: string;
  cooldownDescription: string;
  resetDescription: string;
  stackingDescription: string;
  playerDescription: string;
  simulatorReferenceKey?: string;
}

export type AffixGenerationPolicy =
  | "normal"
  | "technology_only"
  | "style_only";
export type AffixRarity =
  | "common"
  | "uncommon"
  | "rare"
  | "ultra_rare"
  | "epic";

export interface LegacyAttributeAffixEffect {
  id: string;
  parameterKey: string;
  operation: AttributeContributionOperation;
  value: number;
  publishedMagnitudeRange?: CanonicalAttributeOperation["publishedMagnitudeRange"];
  unit: string;
  stackingGroup: string;
  ruleSetVersion: string;
}

export type AttributeAffixEffect =
  | LegacyAttributeAffixEffect
  | (CanonicalAttributeOperation & {
      id: string;
      unit: string;
      stackingGroup: string;
      ruleSetVersion: string;
    });

export interface V3Affix {
  id: string;
  version: number;
  name: string;
  category: "attribute" | "passive";
  itemPartId: string;
  generationPolicy: AffixGenerationPolicy;
  rarity: AffixRarity;
  valueScore: number;
  tags: string[];
  attributeEffects: AttributeAffixEffect[];
  passivePayload?: PassiveSkillPayload;
  description: string;
  enabled: boolean;
}

export interface Technology {
  id: string;
  version: number;
  name: string;
  description: string;
  affixIds: string[];
  compatiblePerformanceProfileIds: string[];
  compatibleSeriesIds: string[];
  minimumQualityId?: QualityProfileId;
  generationPolicy: AffixGenerationPolicy;
  valueScorePolicy: "members_only";
  enabled: boolean;
}

export interface AffixQualityEvaluation {
  totalScore: number;
  qualityId: QualityProfileId;
  letter: "C" | "B" | "A" | "S";
  colorName: "绿" | "蓝" | "紫" | "橙";
  attributeAffixScore: number;
  passiveAffixScore: number;
  technologyAffixIds: string[];
  directAffixIds: string[];
  warnings: string[];
  blockingIssues: string[];
}

export interface AffixRuntimeEvidence {
  reductionStackingPolicyVersion?: string;
  /** Affix/Technology 结算完成、FinalReviewPatch 之前的值。 */
  values: Record<string, number | string>;
  /** FinalReviewPatch 完成、ParameterDefinition 之前的值。 */
  postReviewValues: Record<string, number | string>;
  /** ParameterDefinition 完成后的正式最终值。 */
  finalValues: Record<string, number | string>;
  /** 按执行顺序包含 affix、FinalReviewPatch 与 ParameterDefinition 的同一条 Trace。 */
  trace: ProjectionTraceContribution[];
  issues: ValidationIssue[];
  formalStatus: "FORMAL" | "NON_FORMAL";
  traceHash: string;
}

export interface ConfigurationSnapshot {
  id: string;
  version: number;
  modelId: string;
  modelRevision: number;
  skuRevision: number;
  seriesRevision: number;
  ruleSetVersion: string;
  projectionId: string;
  /** 历史快照读取字段；不得作为新运行时公式选择器。 */
  reductionStackingMode?: ReductionStackingMode;
  /** 新正式快照必须冻结；历史快照可以缺失并继续查看/审计归档。 */
  reductionStackingPolicyVersion?: string;
  patchSetHash: string;
  patchReferences?: PatchSnapshotReference[];
  /** 历史 Snapshot 可缺失；新正式 Snapshot 必须冻结以下 OPEN-004 证据。 */
  patchOffsetPolicyVersion?: string;
  patchReviewBatchRef?: string;
  patchValidationIssueFingerprints?: string[];
  patchValidationWaiverRefs?: string[];
  patchValidationWaiverDecisionRefs?: string[];
  finalPanelValues: Record<string, number | string>;
  /** schema v16 起的新快照冻结最终拉力；历史快照缺失时不得补写或改变 contentHash。 */
  modelFinalPullKg?: number;
  componentSelections: ModelComponentSelection[];
  technologyIds: string[];
  attributeAffixIds: string[];
  passiveAffixIds: string[];
  attributeTrace: ProjectionTraceStep[];
  /** 新正式 Snapshot 冻结 canonical Trace；历史 Snapshot 不补写，避免改变 contentHash。 */
  calculationTrace?: CalculationTraceArchive;
  passiveAffixPayloads: PassiveSkillPayload[];
  projectionMatch: ProjectionMatch;
  compatibilityReport: HardCompatibilityResult;
  pricingPolicyVersion?: string;
  automaticPricing?: PricingTrialResult;
  affinityReport: AffinityScoreResult;
  qualityReport: AffixQualityEvaluation;
  qualityValueAssessment?: ModelAffixValueAssessment;
  /** 历史 Snapshot 可缺失；新正式 Snapshot 必须冻结 AVAILABLE 或 definition_missing。 */
  performanceSummary?: PerformanceSummarySnapshot;
  validationReport: ValidationIssue[];
  /** 历史 Snapshot 可缺失；新正式 Snapshot 冻结统一校验确认与 Waiver 证据。 */
  validationAcknowledgements?: ValidationAcknowledgement[];
  validationWaivers?: ValidationWaiver[];
  validationWaiverDecisions?: ValidationWaiverDecision[];
  fiveAxisPreview?: ModelFiveAxisPreview;
  publishedBy: string;
  publishedAt: string;
  contentHash: string;
}

export interface UpgradeCandidate {
  id: string;
  modelId: string;
  fromSnapshotId: string;
  proposedProjectionId: string;
  proposedRuleSetVersion: string;
  proposedReductionStackingPolicyVersion?: string;
  proposedValues: Record<string, number | string>;
  differences: PatchRebaseDifference[];
  patchRebasePreview: PatchRebasePreview;
  validationReport: ValidationIssue[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string;
  reviewer?: string;
}

export interface RuleChangeProposal {
  id: string;
  title: string;
  description: string;
  sourcePatchIds: string[];
  targetRuleSetVersion: string;
  impactEntityIds: string[];
  expectedChanges: PatchRebaseDifference[];
  conflicts: string[];
  status: "draft" | "submitted" | "approved" | "rejected" | "published";
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface GovernanceAuditLogEntry {
  id: string;
  action:
    | "import"
    | "publish_ruleset"
    | "approve_series"
    | "publish_snapshot"
    | "create_upgrade"
    | "review_upgrade"
    | "submit_rule_proposal"
    | "publish_rule_proposal"
    | "change_sku_target_pull";
  entityType: string;
  entityId: string;
  actor: string;
  occurredAt: string;
  details: Record<string, unknown>;
}
export type DataSourceDataset = "weight_templates" | "modifiers";

export interface DataSourceProfile {
  id: string;
  name: string;
  provider: "feishu_bitable";
  dataset: DataSourceDataset;
  appToken: string;
  tableId: string;
  viewId: string;
  shareUrl: string;
  enabled: boolean;
  notes: string;
}

export interface DataSourceImportRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  dataset: DataSourceDataset;
  checksum: string;
  recordCount: number;
  publishedRevision: number;
  publishedAt: string;
  publishedBy: string;
}

export interface DataSourceBinding {
  sourceId: string;
  dataset: DataSourceDataset;
  entityId: string;
  recordId: string;
  baselineHash: string;
  baseline: WeightTemplate | ModifierOption;
  fieldMap: Record<string, string>;
}

export interface DataSourceWritebackRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  dataset: DataSourceDataset;
  checksum: string;
  recordCount: number;
  fieldCount: number;
  publishedRevision: number;
  publishedAt: string;
  publishedBy: string;
}

export interface DataSourceWritebackRow {
  entityId: string;
  recordId: string;
  fieldNames: string[];
  fields: Record<string, unknown>;
}

export interface DataSourceWritebackPreview {
  sourceId: string;
  sourceName: string;
  dataset: DataSourceDataset;
  sourceFingerprint: string;
  checksum: string;
  pulledAt: string;
  recordCount: number;
  fieldCount: number;
  issues: DataSourceIssue[];
  rows: DataSourceWritebackRow[];
}

export interface DataSourceIssue {
  level: "error" | "warning";
  rowId?: string;
  message: string;
}

export interface DataSourcePreview {
  sourceId: string;
  sourceName: string;
  dataset: DataSourceDataset;
  sourceFingerprint: string;
  checksum: string;
  pulledAt: string;
  recordCount: number;
  summary: { added: number; changed: number; removed: number; unchanged: number };
  issues: DataSourceIssue[];
}
export interface AdjustmentRule {
  id: string;
  parameterKey: string;
  operation: RuleOperation;
  value: number | string;
  condition?: string;
  notes?: string;
}

export interface ModifierOption {
  id: string;
  dimension: DimensionKey;
  name: string;
  level: number | string;
  itemKinds: ItemKind[];
  rules: AdjustmentRule[];
  notes: string;
  enabled: boolean;
}

export interface RuleLayer {
  id: string;
  name: string;
  order: number;
  enabled: boolean;
  mode: "selection" | "global";
  dimension?: DimensionKey;
  optionIds: string[];
  rules: AdjustmentRule[];
  notes: string;
}

export interface Affix {
  id: string;
  name: string;
  category: "stat" | "passive";
  itemKinds: ItemKind[];
  score: number;
  rarity: "common" | "rare" | "epic";
  tags: string[];
  exclusiveGroup?: string;
  conflicts: string[];
  synergies: string[];
  rules: AdjustmentRule[];
  description: string;
  notes: string;
  enabled: boolean;
}

export interface QualityBand {
  id: string;
  name: string;
  color: string;
  minScore: number;
  maxScore: number | null;
  priceIndex: number;
  notes: string;
}

export interface AffixScorePolicy {
  sameAxisFactors: number[];
  synergyBonus: number;
  conflictPenalty: number;
  passiveWeight: number;
  directWeight: number;
  notes: string;
}

export interface SeriesRecipePartConstraint {
  templateIds: string[];
  typeIds: string[];
  materialIds: string[];
  requiredAffixIds: string[];
  optionalAffixPoolIds: string[];
  notes: string;
}

export interface SeriesRecipe {
  id: string;
  name: string;
  platformId: string;
  platformPosition: string;
  templateIds: string[];
  structureIds: string[];
  functionIds: string[];
  performanceIds: string[];
  technologyIds: string[];
  requiredAffixIds: string[];
  optionalAffixPoolIds: string[];
  /** v14：竿、轮、线分别约束；旧扁平字段继续保留供历史数据兼容。 */
  partConstraints?: Partial<Record<ItemKind, SeriesRecipePartConstraint>>;
  optionalSlots: number;
  qualityTarget: string;
  fishMinKg: number;
  fishMaxKg: number;
  useScene: string;
  maxCandidates: number;
  notes: string;
  enabled: boolean;
}

export interface SeriesShowcaseEntry {
  id: string;
  seriesId: string;
  description: string;
  /** 旧版单模板字段，仅用于兼容已保存数据。 */
  templateId?: string;
  /** 根据重量跨度自动拆出的模板集合。 */
  templateIds: string[];
  /** 旧版单结构字段，仅用于兼容已保存数据。 */
  structureId?: string;
  /** 一个系列可以同时包含直柄、枪柄等具体结构。 */
  structureIds: string[];
  /** 一个系列只对应一种钓法。 */
  fishingMethod: string;
  functionId: string;
  /** 旧版性能字段，仅用于兼容已保存数据。 */
  performanceId?: string;
  qualityId: string;
  fishMinKg: number;
  fishMaxKg: number;
  tensionMinKgf: number;
  tensionMaxKgf: number;
  /** 离散目标拉力规格；旧 min/max 只保留给历史展示和迁移，绝不用于插值。 */
  targetPullsKgf?: number[];
  /** 系列级贯通词条，拆分到任意重量段后保持不变。 */
  affixIds: string[];
  /** 旧版饵重字段，仅用于兼容已保存数据。 */
  lureMinG?: number;
  lureMaxG?: number;
  notes: string;
  publishedAt: string;
  updatedAt: string;
}

export interface CandidateSelections {
  structureId?: string;
  materialId?: string;
  functionId?: string;
  performanceId?: string;
  technologyIds: string[];
  seriesId?: string;
}

export interface CalculationTraceItem {
  layer: string;
  source: string;
  parameterKey: string;
  operation: RuleOperation | "quality";
  before: number | string | null;
  operand: number | string;
  after: number | string | null;
}

export interface QualityResult {
  rawScore: number;
  finalScore: number;
  qualityId: string;
  contributions: Array<{
    affixId: string;
    base: number;
    factor: number;
    score: number;
    note: string;
  }>;
  bonuses: string[];
  penalties: string[];
}

export type ValidationIssueSeverity = "INFO" | "WARNING" | "ERROR" | "BLOCKER";
export type ValidationIssueGate = "NONE" | "REVIEW" | "PUBLISH" | "EXPORT";
export type ValidationIssueState = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "WAIVED" | "STALE";
export type ValidationIssueSource =
  | "hard_compatibility" | "affinity" | "series_invariant" | "patch"
  | "publish" | "data_integrity" | "import" | "five_axis" | "ai_guardrail"
  | "config_identity" | "config_relationship" | "quality" | "pricing";

export interface ValidationEntityRef {
  workspaceId: string;
  entityType: string;
  entityId: string;
  revisionId: string;
}

export interface ValidationEvidenceRef {
  evidenceType:
    | "trace" | "validation_issue" | "hard_compatibility" | "affinity_axis"
    | "series_invariant" | "five_axis" | "rule" | "snapshot" | "user_note";
  refId: string;
  revisionId?: string;
  anchor?: string;
  contentHash: string;
  excerpt?: string;
}

/**
 * ActionCode 的封闭集合与不可变 commandPayloadRef 由 #48 负责。
 * 本接口只冻结 R9 共用壳，避免在 #47 复制另一套动作注册表。
 */
export interface ValidationActionLink {
  actionId: string;
  action: string;
  label: string;
  targetRef?: ValidationEntityRef;
  targetRoute?: string;
  enabled: boolean;
  requiredCapabilities: string[];
  disabledReasonCode?: string;
  disabledReasonText?: string;
  commandPayloadRef?: {
    payloadRefId: string;
    action: string;
    subjectRef: ValidationEntityRef;
    expectedRevisionId?: string;
    inputHash: string;
    payloadHash: string;
    idempotencyKey: string;
    expiresAt?: string;
  };
}

export interface CanonicalValidationIssue {
  issueId: string;
  issueRevision: string;
  fingerprint: string;
  fingerprintVersion: "validation-issue-fingerprint/v1";
  inputHash: string;
  code: string;
  source: ValidationIssueSource;
  severity: ValidationIssueSeverity;
  gate: ValidationIssueGate;
  subjectRef: ValidationEntityRef;
  affectedRefs: ValidationEntityRef[];
  parameterKeys: string[];
  title: string;
  message: string;
  evidenceRefs: ValidationEvidenceRef[];
  ruleRefs: string[];
  state: ValidationIssueState;
  waiverRef?: string;
  environmentId?: string;
  channelKey?: string;
  actions: ValidationActionLink[];
  /** @deprecated 只供尚未迁移的展示代码读取；新记录不写入，领域判断必须使用 severity。 */
  level?: "error" | "warning" | "info";
  /** @deprecated 旧内联证据兼容视图；新记录只冻结 evidenceRefs。 */
  evidence?: Record<string, unknown>;
  /** @deprecated 旧单参数兼容视图；新记录使用 parameterKeys。 */
  parameterKey?: string;
}

/** 旧工作区和历史 Snapshot 的只读输入形状；写入新证据前必须安全适配。 */
export interface LegacyValidationIssue {
  level: "error" | "warning" | "info";
  severity?: ValidationIssueSeverity;
  /** `affix` 仅是 #47 迁移前的旧来源；新记录必须使用 ValidationIssueSource。 */
  source?: ValidationIssueSource | "affix";
  gate?: ValidationIssueGate;
  state?: ValidationIssueState;
  fingerprint?: string;
  code: string;
  message: string;
  parameterKey?: string;
  environmentId?: string;
  channelKey?: string;
  evidence?: Record<string, unknown>;
}

/** pre-R9 UnifiedValidationIssue 的持久化形状；读取时必须规范化小写枚举。 */
export interface LegacyUnifiedValidationIssue {
  fingerprintVersion?: undefined;
  issueId: string;
  fingerprint: string;
  code: string;
  source: ValidationIssueSource;
  severity: "info" | "warning" | "error";
  blocking: boolean;
  gate: "generate" | "series_approve" | "model_review" | "publish" | "export";
  subjectRef: ValidationEntityRef;
  affectedRefs: ValidationEntityRef[];
  parameterKeys: string[];
  title: string;
  message: string;
  state: "open" | "acknowledged" | "resolved" | "waived" | "superseded";
  deny: boolean;
  actions: unknown[];
  level?: "error" | "warning" | "info";
  parameterKey?: string;
  environmentId?: string;
  channelKey?: string;
  evidence?: Record<string, unknown>;
}

/** 读取边界兼容旧记录；新领域代码必须创建 CanonicalValidationIssue。 */
export type ValidationIssue =
  | CanonicalValidationIssue
  | LegacyValidationIssue
  | LegacyUnifiedValidationIssue;

export interface ValidationAcknowledgement {
  acknowledgementId: string;
  /** 缺失表示合并前 v1 历史记录；新记录固定写入 v2。 */
  recordHashVersion?: "validation-evidence-record/v2";
  issueId: string;
  issueFingerprint: string;
  issueRevision: string;
  inputHash: string;
  gate: ValidationIssueGate;
  reason: string;
  acknowledgedBy: string;
  acknowledgedAt: string;
  idempotencyKey: string;
  payloadHash: string;
  state: "FRESH" | "STALE";
  /** v1 历史记录可缺失；新记录和完成失效迁移的记录必须具备。 */
  stateHashVersion?: "validation-evidence-state/v1";
  stateHash?: string;
  evidenceRefs: ValidationEvidenceRef[];
  recordHash: string;
}

export interface ValidationWaiver {
  waiverId: string;
  /** 缺失表示合并前 v1 历史记录；新记录固定写入 v2。 */
  recordHashVersion?: "validation-evidence-record/v2";
  waiverDecisionId: string;
  issueId: string;
  issueFingerprint: string;
  issueRevision: string;
  inputHash: string;
  policyVersion: string;
  policyHash: string;
  gate: Exclude<ValidationIssueGate, "NONE">;
  environmentId?: string;
  channelKey?: string;
  scopeRef: ValidationEntityRef;
  reason: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string;
  state: "FRESH" | "STALE";
  /** v1 历史记录可缺失；新记录和完成失效迁移的记录必须具备。 */
  stateHashVersion?: "validation-evidence-state/v1";
  stateHash?: string;
  evidenceRefs: ValidationEvidenceRef[];
  recordHash: string;
}

export interface ValidationWaiverDecision {
  waiverDecisionId: string;
  scopeRef: ValidationEntityRef;
  reason: string;
  requestedWaivers: Array<{
    issueFingerprint: string;
    gate: Exclude<ValidationIssueGate, "NONE">;
    environmentId?: string;
    channelKey?: string;
  }>;
  approvedBy: string;
  approvedAt: string;
  waiverIds: string[];
  policyVersion: string;
  policyHash: string;
  idempotencyKey: string;
  payloadHash: string;
  decisionHash: string;
}

export interface WaiverPolicyRule {
  source: ValidationIssueSource;
  code: string;
  gates: Array<Exclude<ValidationIssueGate, "NONE">>;
  scopeEntityTypes?: string[];
  scopeRefs?: ValidationEntityRef[];
  validFrom?: string;
  validUntil?: string;
}

export interface WaiverPolicyVersion {
  policyId: string;
  version: string;
  status: "DRAFT" | "PUBLISHED" | "RETIRED";
  rules: WaiverPolicyRule[];
  publishedAt?: string;
  policyHash: string;
}

export interface CalculatedEquipment {
  values: Record<string, number | string>;
  quality: QualityResult;
  trace: CalculationTraceItem[];
  issues: ValidationIssue[];
  safeWorkingForce: number;
  priceIndex: number;
}

export interface Candidate {
  id: string;
  recipeId: string;
  comboId: string;
  platformId: string;
  platformPosition: string;
  seriesName: string;
  templateId: string;
  fishMinKg: number;
  fishMaxKg: number;
  selections: CandidateSelections;
  affixIds: string[];
  useScene: string;
  toneOverride?: string;
  hardnessOverride?: string;
  lengthOverride?: number;
  overrides: Record<string, number | string>;
  status: "candidate" | "shortlisted" | "rejected" | "published";
  calculated: CalculatedEquipment;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialSku {
  id: string;
  candidateId: string;
  comboId: string;
  platformId: string;
  platformPosition: string;
  templateId: string;
  seriesName: string;
  qualityId: string;
  fishMinKg: number;
  fishMaxKg: number;
  structureName: string;
  functionName: string;
  functionLevel: string;
  performanceName: string;
  performanceLevel: string;
  affixIds: string[];
  tone: string;
  hardness: string;
  lengthM: number;
  useScene: string;
  rodId: string;
  reelId: string;
  lineId: string;
  priceIndex: number;
  rodForce: number;
  reelForce: number;
  lineForce: number;
  safeWorkingForce: number;
  values: Record<string, number | string>;
  overrides: Record<string, number | string>;
  notes: string;
  publishedAt: string;
}

export interface DetailOverride {
  skuId: string;
  itemKind: ItemKind;
  model: string;
  name: string;
  values: Record<string, number | string>;
  notes: string;
}

export interface RevisionInfo {
  revision: number;
  author: string;
  message: string;
  createdAt: string;
}

export type RuleGraphNodeKind =
  | "baseline"
  | "modifier"
  | "affix"
  | "rule"
  | "constraint"
  | "condition"
  | "merge"
  | "review"
  | "validate"
  | "output";

export type RuleNodeExecutionStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_review"
  | "completed"
  | "failed"
  | "skipped";

export interface RuleGraphCondition {
  id: string;
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
  value: number | string;
}

export interface RuleGraphNode {
  id: string;
  name: string;
  kind: RuleGraphNodeKind;
  description: string;
  x: number;
  y: number;
  manualStart: boolean;
  dimensions: DimensionKey[];
  rules: AdjustmentRule[];
  conditions: RuleGraphCondition[];
  conditionMode: "all" | "any";
}

export interface RuleGraphEdge {
  id: string;
  from: string;
  to: string;
  outcome: "always" | "matched" | "unmatched" | "approved";
  label: string;
}

export interface RuleGraph {
  id: string;
  name: string;
  description: string;
  mode: "automatic" | "manual" | "hybrid";
  entryNodeId: string;
  nodes: RuleGraphNode[];
  edges: RuleGraphEdge[];
  version: number;
  enabled: boolean;
}

export interface GraphBatchRow {
  id: string;
  candidateId: string;
  comboId: string;
  templateId: string;
  values: Record<string, number | string>;
  qualityId: string;
  qualityScore: number;
  issues: string[];
  touchedKeys: string[];
}

export interface RuleGraphNodeRunState {
  nodeId: string;
  status: RuleNodeExecutionStatus;
  inputRowIds: string[];
  outputRowIds: string[];
  matchedRowIds: string[];
  unmatchedRowIds: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface IntermediateSnapshot {
  id: string;
  nodeId: string;
  nodeName: string;
  status: "waiting" | "approved";
  rows: GraphBatchRow[];
  createdAt: string;
  reviewedAt?: string;
  reviewer?: string;
  notes: string;
}

export interface RuleGraphRun {
  id: string;
  graphId: string;
  name: string;
  status: "ready" | "running" | "waiting_review" | "paused" | "completed" | "failed";
  nodeStates: RuleGraphNodeRunState[];
  workingRows: GraphBatchRow[];
  snapshots: IntermediateSnapshot[];
  createdAt: string;
  updatedAt: string;
  startedBy: string;
  committedAt?: string;
}

export interface WorkspacePolicyRecord {
  policyId: string;
  policyType:
    | "performanceIntensityDefinition"
    | "patchOffsetPolicy"
    | "FiveAxisViewDefinition"
    | "aiRefreshPolicy"
    | "aiModelRecordPolicy"
    | "aiReviewPolicy"
    | "enabledItemPartPolicy"
    | "separationOfDutiesPolicy"
    | "feishuProposalApprovalPolicy"
    | "aiServicePolicy";
  version: string;
  status: "draft" | "published" | "superseded";
  value: Record<string, unknown>;
  createdAt: string;
  publishedAt?: string;
}

export interface AIAssessmentRecord {
  assessmentId: string;
  scopeType: "series" | "sku" | "model" | "candidate_set";
  scopeId: string;
  scopeRevision: string;
  inputHash: string;
  ruleSetVersion: string;
  fiveAxisRuleVersion?: string;
  promptTemplateVersion: string;
  provider?: string;
  model?: string;
  state: "fresh" | "stale" | "accepted" | "dismissed" | "superseded";
  generatedAt: string;
}

export interface WorkspaceExportTargetProfile {
  profileId: string;
  label: string;
  executorKind: "local_companion" | "server_mounted_workspace";
  projectRoot: string;
  relativeWorkbookRoot: string;
  configTomlPath: string;
  enabled: boolean;
  expectedSchemaHash?: string;
  mappingId?: string;
  mappingVersion?: string;
}

export interface ConfigEnvironmentProfile {
  environmentId: string;
  label: string;
  configTomlRelativePath: "config.toml";
  enabled: boolean;
  mappingId?: string;
  mappingVersion?: string;
}

export interface IdentityAuditRecord {
  id: string;
  tenantKey: string;
  openId: string;
  displayName: string;
  action: string;
  occurredAt: string;
  entityId?: string;
}


export interface WorkspaceState {
  schemaVersion: number;
  /**
   * OPEN-008 使用独立子 schema，避免把配置身份治理与工作区 revision
   * 的迁移编号耦合。旧工作区在读取时补为空状态，不改写历史 Snapshot。
   */
  configIdGovernance: ConfigIdGovernanceState;
  ruleSettings: WorkspaceRuleSettings;
  ruleSetVersions: RuleSetVersion[];
  itemParts: ItemPartDefinition[];
  methodProfiles: MethodProfile[];
  itemTypeProfiles: ItemTypeProfile[];
  functionProfiles: FunctionProfile[];
  performanceProfiles: PerformanceProfile[];
  performanceSummaryDefinitions: PerformanceSummaryDefinition[];
  qualityProfiles: QualityProfile[];
  projectionPatches: ProjectionPatchRuleSource[];
  patchLedger: PatchLedger;
  derivedProjections: DerivedProjection[];
  projectionMatches: ProjectionMatch[];
  compatibilityRules: CompatibilityRule[];
  affinityRules: AffinityRule[];
  affinityAxisWeights: AffinityAxisWeights;
  collections: Collection[];
  seriesDefinitions: SeriesDefinition[];
  partConstraintSets: PartConstraintSet[];
  skuDrawers: SkuDrawer[];
  purchasableModels: PurchasableModel[];
  candidateSearchRecipes: CandidateSearchRecipe[];
  candidateRuns: CandidateRun[];
  candidateMaterializations: CandidateMaterializationRecord[];
  v3Affixes: V3Affix[];
  technologies: Technology[];
  configurationSnapshots: ConfigurationSnapshot[];
  feishuWorkbooks: FeishuWorkbookRef[];
  feishuSourceRevisions: FeishuSourceRevision[];
  sourceIdentityMigrationReports: SourceIdentityMigrationReport[];
  qualityValuePolicyDrafts: QualityValuePolicyDraft[];
  pricingPolicyDrafts: PricingPolicyDraft[];
  pricingPolicyVersions: PricingPolicyVersion[];
  reductionStackingPolicyVersions: ReductionStackingPolicyVersion[];
  fiveAxisViewDefinitions: FiveAxisViewDefinition[];
  fiveAxisVertexSets: FiveAxisVertexSet[];
  workspacePolicies: WorkspacePolicyRecord[];
  patchReviewBatches: PatchReviewBatch[];
  patchValidationWaivers: PatchValidationWaiver[];
  patchValidationWaiverDecisions: PatchValidationWaiverDecision[];
  aiAssessments: AIAssessmentRecord[];
  exportTargetProfiles: WorkspaceExportTargetProfile[];
  configEnvironmentProfiles: ConfigEnvironmentProfile[];
  configExportMappings: ConfigExportMapping[];
  identityAuditLog: IdentityAuditRecord[];
  commandIdempotencyRecords: Array<{
    key: string;
    inputHash: string;
    resultRef: string;
    /** 命令可选的冻结响应；旧记录缺失时保持只读兼容。 */
    resultPayload?: Record<string, unknown>;
    resultPayloadHash?: string;
  }>;
  upgradeCandidates: UpgradeCandidate[];
  ruleChangeProposals: RuleChangeProposal[];
  governanceAuditLog: GovernanceAuditLogEntry[];
  migrationReviewItems: MigrationReviewItem[];
  parameters: ParameterDefinition[];
  templates: WeightTemplate[];
  modifiers: ModifierOption[];
  layers: RuleLayer[];
  affixes: Affix[];
  qualityBands: QualityBand[];
  affixScorePolicy: AffixScorePolicy;
  recipes: SeriesRecipe[];
  seriesShowcases: SeriesShowcaseEntry[];
  candidates: Candidate[];
  officialSkus: OfficialSku[];
  detailOverrides: DetailOverride[];
  ruleGraphs: RuleGraph[];
  ruleRuns: RuleGraphRun[];
  dataSources: DataSourceProfile[];
  dataSourceImports: DataSourceImportRecord[];
  dataSourceBindings: DataSourceBinding[];
  dataSourceWritebacks: DataSourceWritebackRecord[];
  revisions: RevisionInfo[];
  notes: string;
  importedAt: string;
}

export interface ApiStatePayload {
  state: WorkspaceState;
  revision: number;
  user: {
    authenticated: boolean;
    provider: "feishu" | "none";
    tenantKey?: string;
    openId?: string;
    capabilities: string[];
    actionAvailability: import("./interaction-contracts").ActionAvailabilityMap;
    email: string;
    name: string;
    role: "admin" | "editor" | "viewer";
  };
}
