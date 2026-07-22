import { deterministicHash } from "./rule-kernel";
import type {
  Collection,
  ConfigurationSnapshot,
  SeriesDefinition,
  SkuDrawer,
  PurchasableModel,
  ValidationIssue as LegacyValidationIssue,
} from "./types";

export type CapabilityCode =
  | "series.read" | "series.edit" | "series.approve"
  | "sku.read" | "sku.edit"
  | "model.read" | "model.edit" | "model.review" | "model.publish"
  | "candidate.generate" | "candidate.materialize" | "candidate.override_selection" | "candidate.select" | "candidate.dismiss"
  | "model.patch.create" | "model.patch.review" | "patch.rebase"
  | "snapshot.read" | "snapshot.export"
  | "ai.evaluate" | "ai.patch_draft.create" | "ai.feishu_proposal_draft.create"
  | "feishu.proposal.submit" | "feishu.proposal.review" | "feishu.proposal.apply"
  | "feishu.workbook.read" | "feishu.workbook.pull" | "feishu.identity.write" | "ruleset.draft.create"
  | "data_source.resolve" | "data_source.preview" | "data_source.publish"
  | "data_source.writeback.preview" | "data_source.writeback.commit"
  | "excel.import" | "revision.read"
  | "config.export.preview" | "config.export.commit"
  | "rules.five_axis.publish" | "workspace.policy.manage" | "workspace.save";

export type ActionCode =
  | "open_series" | "open_sku" | "preview_model"
  | "edit" | "review" | "publish" | "generate_candidates" | "materialize_candidates"
  | "select_candidate" | "dismiss_candidate_run"
  | "create_patch" | "review_patch" | "open_rebase"
  | "view_snapshot" | "export_snapshot"
  | "run_ai_assessment" | "create_ai_patch_draft" | "create_ai_feishu_draft"
  | "submit_feishu_proposal" | "review_feishu_proposal" | "apply_feishu_proposal"
  | "inspect_feishu_workbook" | "pull_feishu_workbook" | "create_ruleset_draft" | "write_feishu_identity"
  | "resolve_data_source" | "preview_data_source" | "publish_data_source"
  | "preview_data_source_writeback" | "commit_data_source_writeback"
  | "import_excel" | "view_revisions"
  | "preview_config_export" | "commit_config_export"
  | "publish_five_axis_definition" | "manage_workspace_policy" | "save_workspace";

export const ACTION_CODES: ActionCode[] = [
  "open_series", "open_sku", "preview_model", "edit", "review", "publish",
  "generate_candidates", "materialize_candidates", "select_candidate", "dismiss_candidate_run",
  "create_patch", "review_patch", "open_rebase", "view_snapshot", "export_snapshot",
  "run_ai_assessment", "create_ai_patch_draft", "create_ai_feishu_draft",
  "submit_feishu_proposal", "review_feishu_proposal", "apply_feishu_proposal",
  "inspect_feishu_workbook", "pull_feishu_workbook", "create_ruleset_draft", "write_feishu_identity",
  "resolve_data_source", "preview_data_source", "publish_data_source",
  "preview_data_source_writeback", "commit_data_source_writeback", "import_excel", "view_revisions",
  "preview_config_export", "commit_config_export", "publish_five_axis_definition",
  "manage_workspace_policy",
  "save_workspace",
];

export interface EntityRef {
  workspaceId: string;
  entityType:
    | "collection" | "series" | "sku_drawer" | "model"
    | "configuration_snapshot" | "model_candidate" | "adjustment_patch"
    | "upgrade_candidate" | "rule_source_change_draft" | "feishu_rule_proposal";
  entityId: string;
  revisionId: string;
}

export interface BreadcrumbItem {
  ref: EntityRef;
  label: string;
  objectLabel: "Collection" | "Series" | "SKU 抽屉" | "Model" | "冻结快照";
  current: boolean;
  navigable: boolean;
  unavailableReason?: string;
}

type BreadcrumbEntity = {
  collection?: Collection;
  series?: SeriesDefinition;
  sku?: SkuDrawer;
  model?: PurchasableModel;
  snapshot?: ConfigurationSnapshot;
};

function unavailableBreadcrumb(
  workspaceId: string,
  entityType: EntityRef["entityType"],
  entityId: string,
  objectLabel: BreadcrumbItem["objectLabel"],
): BreadcrumbItem {
  return {
    ref: { workspaceId, entityType, entityId, revisionId: "unavailable" },
    label: "不可见对象",
    objectLabel,
    current: false,
    navigable: false,
    unavailableReason: "无权查看或对象已不可用。",
  };
}

/**
 * 只按稳定父链构建面包屑。缺失父级不会通过名称、顺序或相邻对象猜测，
 * 仅保留允许披露的稳定 ID 与不可导航占位。
 */
export function buildProductBreadcrumbs(input: BreadcrumbEntity & {
  workspaceId: string;
  currentEntityType?: EntityRef["entityType"];
}): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [];
  const currentType = input.currentEntityType
    ?? (input.snapshot ? "configuration_snapshot" : input.model ? "model" : input.sku ? "sku_drawer" : "series");
  const push = (
    ref: EntityRef,
    label: string,
    objectLabel: BreadcrumbItem["objectLabel"],
  ) => items.push({
    ref,
    label,
    objectLabel,
    current: ref.entityType === currentType,
    navigable: ref.entityType !== currentType,
  });

  const collectionId = input.series?.collectionId;
  if (collectionId) {
    if (input.collection?.id === collectionId) {
      push(
        { workspaceId: input.workspaceId, entityType: "collection", entityId: input.collection.id, revisionId: input.collection.updatedAt },
        input.collection.name,
        "Collection",
      );
    } else {
      items.push(unavailableBreadcrumb(input.workspaceId, "collection", collectionId, "Collection"));
    }
  }

  if (input.series) {
    push(
      { workspaceId: input.workspaceId, entityType: "series", entityId: input.series.id, revisionId: String(input.series.revision) },
      input.series.name,
      "Series",
    );
  } else if (input.sku?.seriesId) {
    items.push(unavailableBreadcrumb(input.workspaceId, "series", input.sku.seriesId, "Series"));
  }

  if (input.sku) {
    push(
      { workspaceId: input.workspaceId, entityType: "sku_drawer", entityId: input.sku.id, revisionId: String(input.sku.revision) },
      `${input.sku.targetWeightKg} kg · SKU 抽屉`,
      "SKU 抽屉",
    );
  } else if (input.model?.skuId) {
    items.push(unavailableBreadcrumb(input.workspaceId, "sku_drawer", input.model.skuId, "SKU 抽屉"));
  }

  if (input.model) {
    push(
      { workspaceId: input.workspaceId, entityType: "model", entityId: input.model.id, revisionId: String(input.model.revision) },
      `${input.model.name} · 实际选择/购买对象`,
      "Model",
    );
  } else if (input.snapshot?.modelId) {
    items.push(unavailableBreadcrumb(input.workspaceId, "model", input.snapshot.modelId, "Model"));
  }

  if (input.snapshot) {
    push(
      { workspaceId: input.workspaceId, entityType: "configuration_snapshot", entityId: input.snapshot.id, revisionId: String(input.snapshot.version) },
      `v${input.snapshot.version} · 冻结快照`,
      "冻结快照",
    );
  }

  return items;
}

export interface ProductDeepLinkResolution extends BreadcrumbEntity {
  unavailableRequestedRef?: EntityRef;
  fallbackEntityType?: EntityRef["entityType"];
  integrityIssues: LegacyValidationIssue[];
}

export function resolveProductDeepLink(input: {
  workspaceId: string;
  requested: {
    collectionId?: string;
    seriesId?: string;
    skuId?: string;
    modelId?: string;
    snapshotId?: string;
  };
  collections: Collection[];
  series: SeriesDefinition[];
  skus: SkuDrawer[];
  models: PurchasableModel[];
  snapshots: ConfigurationSnapshot[];
}): ProductDeepLinkResolution {
  const issues: LegacyValidationIssue[] = [];
  const unavailable = (
    entityType: EntityRef["entityType"],
    entityId: string,
  ): EntityRef => ({ workspaceId: input.workspaceId, entityType, entityId, revisionId: "unavailable" });

  const requestedSnapshot = input.requested.snapshotId
    ? input.snapshots.find((entry) => entry.id === input.requested.snapshotId)
    : undefined;
  const modelId = requestedSnapshot?.modelId ?? input.requested.modelId;
  const model = modelId ? input.models.find((entry) => entry.id === modelId) : undefined;
  const skuId = model?.skuId ?? input.requested.skuId;
  const sku = skuId ? input.skus.find((entry) => entry.id === skuId) : undefined;
  const seriesId = sku?.seriesId ?? input.requested.seriesId;
  const series = seriesId ? input.series.find((entry) => entry.id === seriesId) : undefined;
  const collectionId = series?.collectionId ?? input.requested.collectionId;
  const collection = collectionId
    ? input.collections.find((entry) => entry.id === collectionId)
    : undefined;

  const mismatches = [
    input.requested.modelId && requestedSnapshot && requestedSnapshot.modelId !== input.requested.modelId
      ? "Snapshot 与请求的 Model 父链不一致；按 Snapshot 冻结引用定位。"
      : "",
    input.requested.skuId && model && model.skuId !== input.requested.skuId
      ? "Model 与请求的 SKU 父链不一致；按 Model 稳定引用定位。"
      : "",
    input.requested.seriesId && sku && sku.seriesId !== input.requested.seriesId
      ? "SKU 与请求的 Series 父链不一致；按 SKU 稳定引用定位。"
      : "",
  ].filter(Boolean);
  mismatches.forEach((message) => issues.push({
    level: "error",
    code: "DEEP_LINK_PARENT_MISMATCH",
    message,
  }));

  let unavailableRequestedRef: EntityRef | undefined;
  if (input.requested.snapshotId && !requestedSnapshot) {
    unavailableRequestedRef = unavailable("configuration_snapshot", input.requested.snapshotId);
  } else if (modelId && !model) {
    unavailableRequestedRef = unavailable("model", modelId);
  } else if (skuId && !sku) {
    unavailableRequestedRef = unavailable("sku_drawer", skuId);
  } else if (seriesId && !series) {
    unavailableRequestedRef = unavailable("series", seriesId);
  } else if (collectionId && !collection) {
    unavailableRequestedRef = unavailable("collection", collectionId);
  }
  const fallbackEntityType = unavailableRequestedRef
    ? model ? "model" : sku ? "sku_drawer" : series ? "series" : collection ? "collection" : undefined
    : undefined;

  return {
    collection,
    series,
    sku,
    model,
    snapshot: requestedSnapshot && model ? requestedSnapshot : undefined,
    unavailableRequestedRef,
    fallbackEntityType,
    integrityIssues: issues,
  };
}

export interface ActionAvailability {
  action: ActionCode;
  enabled: boolean;
  requiredCapabilities: CapabilityCode[];
  disabledReasonCode?: string;
  disabledReasonText?: string;
}

export type ActionAvailabilityMap = Record<ActionCode, ActionAvailability>;

const ACTION_CAPABILITIES: Partial<Record<ActionCode, CapabilityCode[]>> = {
  open_series: ["series.read"],
  open_sku: ["sku.read"],
  preview_model: ["model.read"],
  edit: ["model.edit"],
  review: ["model.review"],
  publish: ["model.publish"],
  generate_candidates: ["candidate.generate"],
  materialize_candidates: ["candidate.materialize"],
  select_candidate: ["candidate.select"],
  dismiss_candidate_run: ["candidate.dismiss"],
  create_patch: ["model.patch.create"],
  review_patch: ["model.patch.review"],
  open_rebase: ["patch.rebase"],
  view_snapshot: ["snapshot.read"],
  export_snapshot: ["snapshot.export"],
  run_ai_assessment: ["ai.evaluate"],
  create_ai_patch_draft: ["ai.patch_draft.create"],
  create_ai_feishu_draft: ["ai.feishu_proposal_draft.create"],
  submit_feishu_proposal: ["feishu.proposal.submit"],
  review_feishu_proposal: ["feishu.proposal.review"],
  apply_feishu_proposal: ["feishu.proposal.apply"],
  inspect_feishu_workbook: ["feishu.workbook.read"],
  pull_feishu_workbook: ["feishu.workbook.pull"],
  create_ruleset_draft: ["ruleset.draft.create"],
  write_feishu_identity: ["feishu.identity.write"],
  resolve_data_source: ["data_source.resolve"],
  preview_data_source: ["data_source.preview"],
  publish_data_source: ["data_source.publish"],
  preview_data_source_writeback: ["data_source.writeback.preview"],
  commit_data_source_writeback: ["data_source.writeback.commit"],
  import_excel: ["excel.import"],
  view_revisions: ["revision.read"],
  preview_config_export: ["config.export.preview"],
  commit_config_export: ["config.export.commit"],
  publish_five_axis_definition: ["rules.five_axis.publish"],
  manage_workspace_policy: ["workspace.policy.manage"],
  save_workspace: ["workspace.save"],
};

export function actionAvailability(
  action: ActionCode,
  capabilities: Iterable<CapabilityCode>,
  domainBlock?: { code: string; text: string },
): ActionAvailability {
  const held = new Set(capabilities);
  const requiredCapabilities = ACTION_CAPABILITIES[action] ?? [];
  const missing = requiredCapabilities.filter((capability) => !held.has(capability));
  if (missing.length) {
    return {
      action,
      enabled: false,
      requiredCapabilities,
      disabledReasonCode: "CAPABILITY_MISSING",
      disabledReasonText: `缺少能力：${missing.join("、")}。`,
    };
  }
  if (domainBlock) {
    return {
      action,
      enabled: false,
      requiredCapabilities,
      disabledReasonCode: domainBlock.code,
      disabledReasonText: domainBlock.text,
    };
  }
  return { action, enabled: true, requiredCapabilities };
}

export function buildActionAvailabilityMap(
  capabilities: Iterable<CapabilityCode>,
): ActionAvailabilityMap {
  return Object.fromEntries(
    ACTION_CODES.map((action) => [action, actionAvailability(action, capabilities)]),
  ) as ActionAvailabilityMap;
}

export type LifecycleState = "ACTIVE" | "DEPRECATED" | "ARCHIVED";
export type RevisionState =
  | "DRAFT" | "PENDING_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "SUPERSEDED";
export type ValidationState =
  | "NOT_EVALUATED" | "EVALUATING" | "PASSED" | "WARNING" | "BLOCKED" | "ERROR";
export type PublicationState =
  | "UNPUBLISHED" | "READY_TO_PUBLISH" | "PUBLISHING" | "PUBLISHED" | "PUBLISH_FAILED";
export type AttentionState =
  | "HAS_UPGRADE_CANDIDATE" | "REBASE_REQUIRED" | "SOURCE_STALE"
  | "IMPORT_CONFLICT" | "EXPORT_RELATION_BROKEN";
export type PrimaryDisplayState =
  | "HARD_CONFLICT" | "REBASE_REQUIRED" | "REVIEW_REQUIRED" | "WARNING"
  | "READY_TO_PUBLISH" | "HAS_UPGRADE_CANDIDATE" | "PUBLISHED" | "DRAFT";

export interface CanonicalEntityState {
  lifecycle: LifecycleState;
  revision: RevisionState;
  validation: ValidationState;
  publication: PublicationState;
  attention: AttentionState[];
  primary: PrimaryDisplayState;
  readOnly: boolean;
  unknownCodes: string[];
  integrityIssues: LegacyValidationIssue[];
}

const LIFECYCLE_STATES = new Set<LifecycleState>(["ACTIVE", "DEPRECATED", "ARCHIVED"]);
const REVISION_STATES = new Set<RevisionState>(["DRAFT", "PENDING_REVIEW", "CHANGES_REQUESTED", "APPROVED", "SUPERSEDED"]);
const VALIDATION_STATES = new Set<ValidationState>(["NOT_EVALUATED", "EVALUATING", "PASSED", "WARNING", "BLOCKED", "ERROR"]);
const PUBLICATION_STATES = new Set<PublicationState>(["UNPUBLISHED", "READY_TO_PUBLISH", "PUBLISHING", "PUBLISHED", "PUBLISH_FAILED"]);
const ATTENTION_STATES = new Set<AttentionState>(["HAS_UPGRADE_CANDIDATE", "REBASE_REQUIRED", "SOURCE_STALE", "IMPORT_CONFLICT", "EXPORT_RELATION_BROKEN"]);

function knownOrFallback<T extends string>(
  value: string | undefined,
  known: ReadonlySet<T>,
  fallback: T,
  unknownCodes: string[],
): T {
  if (value && known.has(value as T)) return value as T;
  if (value) unknownCodes.push(value);
  return fallback;
}

export function derivePrimaryDisplayState(input: {
  lifecycle: LifecycleState;
  revision: RevisionState;
  validation: ValidationState;
  publication: PublicationState;
  attention: AttentionState[];
  hasPublishedSnapshot?: boolean;
}): { primary: PrimaryDisplayState; integrityIssues: LegacyValidationIssue[] } {
  const integrityIssues: LegacyValidationIssue[] = [];
  if (input.publication === "PUBLISHED" && input.hasPublishedSnapshot === false) {
    integrityIssues.push({
      level: "error",
      code: "STATE_COMBINATION_INVALID",
      message: "Publication=PUBLISHED 但缺少 ConfigurationSnapshot 引用。",
    });
  }
  if (input.validation === "BLOCKED" || input.validation === "ERROR") {
    return { primary: "HARD_CONFLICT", integrityIssues };
  }
  if (input.attention.includes("REBASE_REQUIRED")) {
    return { primary: "REBASE_REQUIRED", integrityIssues };
  }
  if (input.revision === "PENDING_REVIEW" || input.revision === "CHANGES_REQUESTED") {
    return { primary: "REVIEW_REQUIRED", integrityIssues };
  }
  if (input.validation === "WARNING") {
    return { primary: "WARNING", integrityIssues };
  }
  if (input.publication === "READY_TO_PUBLISH" || input.publication === "PUBLISHING") {
    return { primary: "READY_TO_PUBLISH", integrityIssues };
  }
  if (input.attention.includes("HAS_UPGRADE_CANDIDATE")) {
    return { primary: "HAS_UPGRADE_CANDIDATE", integrityIssues };
  }
  if (input.publication === "PUBLISHED") {
    return { primary: "PUBLISHED", integrityIssues };
  }
  return { primary: "DRAFT", integrityIssues };
}

export function normalizeEntityState(input: {
  lifecycle?: string;
  revision?: string;
  validation?: string;
  publication?: string;
  attention?: string[];
  hasPublishedSnapshot?: boolean;
}): CanonicalEntityState {
  const unknownCodes: string[] = [];
  const lifecycle = knownOrFallback(input.lifecycle, LIFECYCLE_STATES, "ACTIVE", unknownCodes);
  const revision = knownOrFallback(input.revision, REVISION_STATES, "DRAFT", unknownCodes);
  const validation = knownOrFallback(input.validation, VALIDATION_STATES, "NOT_EVALUATED", unknownCodes);
  const publication = knownOrFallback(input.publication, PUBLICATION_STATES, "UNPUBLISHED", unknownCodes);
  const attention = [...new Set((input.attention ?? []).flatMap((code) => {
    if (ATTENTION_STATES.has(code as AttentionState)) return [code as AttentionState];
    unknownCodes.push(code);
    return [];
  }))];
  const derived = derivePrimaryDisplayState({ lifecycle, revision, validation, publication, attention, hasPublishedSnapshot: input.hasPublishedSnapshot });
  const unknownIssues = unknownCodes.map((code): LegacyValidationIssue => ({
    level: "error",
    code: "UNKNOWN_STATE_CODE",
    message: `未知状态码 ${code}；对象已降级为只读。`,
  }));
  return {
    lifecycle,
    revision,
    validation,
    publication,
    attention,
    primary: derived.primary,
    readOnly: unknownCodes.length > 0,
    unknownCodes,
    integrityIssues: [...derived.integrityIssues, ...unknownIssues],
  };
}

export function legacyEntityState(input: {
  status: SeriesDefinition["status"] | SkuDrawer["status"] | PurchasableModel["status"];
  issues?: LegacyValidationIssue[];
  attention?: AttentionState[];
  hasPublishedSnapshot?: boolean;
}): CanonicalEntityState {
  const issues = input.issues ?? [];
  const validation: ValidationState = issues.some((issue) => issue.level === "error")
    ? "BLOCKED"
    : issues.some((issue) => issue.level === "warning")
      ? "WARNING"
      : issues.length ? "PASSED" : "NOT_EVALUATED";
  const mapping = {
    draft: { lifecycle: "ACTIVE", revision: "DRAFT", publication: "UNPUBLISHED" },
    approved: { lifecycle: "ACTIVE", revision: "APPROVED", publication: "READY_TO_PUBLISH" },
    published: { lifecycle: "ACTIVE", revision: "APPROVED", publication: "PUBLISHED" },
    superseded: { lifecycle: "DEPRECATED", revision: "SUPERSEDED", publication: input.hasPublishedSnapshot ? "PUBLISHED" : "UNPUBLISHED" },
  } as const;
  const mapped = mapping[input.status];
  return normalizeEntityState({ ...mapped, validation, attention: input.attention, hasPublishedSnapshot: input.hasPublishedSnapshot });
}

export interface GanttSkuNode {
  skuId: string;
  targetWeightKg: number;
  modelIds: string[];
  status: string;
  validationIssues: LegacyValidationIssue[];
}

export interface GanttSeriesBlock {
  seriesId: string;
  name: string;
  qualityId: string;
  typeId: string;
  minDisplayWeightKg: number | null;
  maxDisplayWeightKg: number | null;
  skuNodes: GanttSkuNode[];
  coverageDisclaimer: "覆盖范围只表达系列规划跨度，不代表连续插值。";
}

export function buildSeriesGanttProjection(input: {
  series: SeriesDefinition[];
  skus: SkuDrawer[];
  models: PurchasableModel[];
}): GanttSeriesBlock[] {
  const modelIds = new Set(input.models.map((model) => model.id));
  return [...input.series]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((series) => {
      const skuNodes = input.skus
        .filter((sku) => sku.seriesId === series.id)
        .sort((left, right) => left.targetWeightKg - right.targetWeightKg || left.id.localeCompare(right.id))
        .map((sku) => ({
          skuId: sku.id,
          targetWeightKg: sku.targetWeightKg,
          modelIds: sku.modelIds.filter((id) => modelIds.has(id)),
          status: sku.status,
          validationIssues: structuredClone(sku.validationSummary),
        }));
      const weights = skuNodes.map((node) => node.targetWeightKg);
      return {
        seriesId: series.id,
        name: series.name,
        qualityId: series.qualityId,
        typeId: series.typeId,
        minDisplayWeightKg: weights.length ? Math.min(...weights) : null,
        maxDisplayWeightKg: weights.length ? Math.max(...weights) : null,
        skuNodes,
        coverageDisclaimer: "覆盖范围只表达系列规划跨度，不代表连续插值。",
      };
    });
}

export interface AIServicePolicy {
  policyId: string;
  version: string;
  enabled: boolean;
  provider?: string;
  model?: string;
  allowedFieldPaths: string[];
  externalDataEgressConfirmed: boolean;
}

export interface AIServiceAvailability {
  enabled: boolean;
  reasonCode?: "AI_DISABLED" | "AI_PROVIDER_UNCONFIRMED" | "AI_FIELD_ALLOWLIST_EMPTY";
  reasonText?: string;
}

export function aiServiceAvailability(
  policy: AIServicePolicy | undefined,
): AIServiceAvailability {
  if (!policy?.enabled) {
    return {
      enabled: false,
      reasonCode: "AI_DISABLED",
      reasonText: "AI 服务未启用；核心工作流不受影响。",
    };
  }
  if (!policy.provider || !policy.model || !policy.externalDataEgressConfirmed) {
    return {
      enabled: false,
      reasonCode: "AI_PROVIDER_UNCONFIRMED",
      reasonText: "AI 供应方、模型或数据出网策略尚未确认。",
    };
  }
  if (!policy.allowedFieldPaths.length) {
    return {
      enabled: false,
      reasonCode: "AI_FIELD_ALLOWLIST_EMPTY",
      reasonText: "AI 字段白名单为空。",
    };
  }
  return { enabled: true };
}

function valueAtPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function assignPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = structuredClone(value);
      return;
    }
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  });
}

export function sanitizeAIInput(
  source: Record<string, unknown>,
  allowedFieldPaths: string[],
): { payload: Record<string, unknown>; inputHash: string } {
  const payload: Record<string, unknown> = {};
  for (const path of [...new Set(allowedFieldPaths)].sort()) {
    if (/token|secret|password|credential|nonce/i.test(path)) continue;
    const value = valueAtPath(source, path);
    if (value !== undefined) assignPath(payload, path, value);
  }
  return { payload, inputHash: deterministicHash(payload) };
}

export interface AIRecommendationRecord {
  recommendationId: string;
  assessmentId: string;
  inputHash: string;
  evidenceRefs: string[];
  suggestedAction: "preview_only" | "create_model_patch_draft" | "create_feishu_proposal_draft";
  state: "fresh" | "stale" | "accepted" | "dismissed" | "superseded";
}

export function refreshAIRecommendationState(
  recommendation: AIRecommendationRecord,
  currentInputHash: string,
): AIRecommendationRecord {
  if (recommendation.state !== "fresh" || recommendation.inputHash === currentInputHash) {
    return structuredClone(recommendation);
  }
  return { ...structuredClone(recommendation), state: "stale" };
}

export function assertAIRecommendationCanCreateDraft(
  recommendation: AIRecommendationRecord,
  target: { frozen: boolean; currentInputHash: string },
): void {
  if (!recommendation.evidenceRefs.length) {
    throw new Error("AI 建议缺少证据，只能作为未覆盖信息展示。");
  }
  if (
    recommendation.state !== "fresh" ||
    recommendation.inputHash !== target.currentInputHash
  ) {
    throw new Error("AI 建议已过期，必须重新评估后才能创建草稿。");
  }
  if (target.frozen) {
    throw new Error("冻结 Model / Snapshot 不允许创建或写入 Patch。");
  }
  if (recommendation.suggestedAction === "preview_only") {
    throw new Error("该建议仅供预览，不能转换为正式草稿。");
  }
}

export type ExportExecutorKind = "local_companion" | "server_mounted_workspace";

export interface ExportTargetProfile {
  profileId: string;
  label: string;
  executorKind: ExportExecutorKind;
  projectRoot: string;
  relativeWorkbookRoot: string;
  configTomlPath: string;
  enabled: boolean;
  expectedSchemaHash?: string;
  mappingId?: string;
  mappingVersion?: string;
}

export interface ExportPreviewTarget {
  profileId: string;
  sourceSnapshotId: string;
  sourceSnapshotHash: string;
  sourceFileHashes: Record<string, string>;
  status: "ready" | "blocked";
  issues: LegacyValidationIssue[];
}

export function createExportPreviewTarget(input: {
  profile: ExportTargetProfile;
  sourceSnapshotId: string;
  sourceSnapshotHash: string;
  sourceFileHashes: Record<string, string>;
  snapshotPublished: boolean;
}): ExportPreviewTarget {
  const issues: LegacyValidationIssue[] = [];
  if (!input.profile.enabled) {
    issues.push({ level: "error", code: "EXPORT_PROFILE_DISABLED", message: "导出目标已停用。" });
  }
  if (!input.profile.mappingId || !input.profile.mappingVersion) {
    issues.push({
      level: "error",
      code: "EXPORT_MAPPING_NOT_PUBLISHED",
      message: "导出目标尚未绑定已发布的 ConfigExportMapping 版本。",
    });
  }
  if (!input.snapshotPublished || !input.sourceSnapshotHash) {
    issues.push({
      level: "error",
      code: "EXPORT_SOURCE_NOT_FROZEN",
      message: "配置表只能从已批准的冻结 ConfigurationSnapshot 生成。",
    });
  }
  if (
    input.profile.executorKind === "local_companion" &&
    /^[a-z]+:\/\//i.test(input.profile.projectRoot)
  ) {
    issues.push({
      level: "error",
      code: "EXPORT_LOCAL_ROOT_INVALID",
      message: "本地助手目标必须使用本机允许目录，不能由服务端下发 URL。",
    });
  }
  return {
    profileId: input.profile.profileId,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceSnapshotHash: input.sourceSnapshotHash,
    sourceFileHashes: structuredClone(input.sourceFileHashes),
    status: issues.some((issue) => issue.level === "error") ? "blocked" : "ready",
    issues,
  };
}

export function validateExportCommit(
  preview: ExportPreviewTarget,
  currentFileHashes: Record<string, string>,
): LegacyValidationIssue[] {
  const issues = structuredClone(preview.issues);
  for (const [file, previewHash] of Object.entries(preview.sourceFileHashes)) {
    if (currentFileHashes[file] !== previewHash) {
      issues.push({
        level: "error",
        code: "EXPORT_SOURCE_CONFLICT",
        message: `${file} 在预览后已变化；保留暂存包并重新生成预览。`,
        parameterKey: file,
      });
    }
  }
  return issues;
}
