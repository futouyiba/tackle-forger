import { deterministicHash } from "./rule-kernel";
import type {
  Collection,
  ConfigurationSnapshot,
  SeriesDefinition,
  SkuDrawer,
  PurchasableModel,
  ValidationIssue as LegacyValidationIssue,
} from "./types";
import {
  assertProductItemPartChainEnabled,
  isProductItemPartEnabled,
  seriesItemPartId,
} from "./enabled-item-parts";
import { formalConfigExportActionBlock } from "./config-export-stage";

export type CapabilityCode =
  | "series.read" | "series.edit" | "series.approve"
  | "sku.read" | "sku.edit"
  | "model.read" | "model.edit" | "model.review" | "model.publish"
  | "candidate.generate" | "candidate.materialize" | "candidate.override_selection" | "candidate.select" | "candidate.dismiss"
  | "model.patch.create" | "model.patch.review" | "patch.rebase"
  | "patch.create" | "patch.review" | "patch.mirror.write" | "patch.mirror.pull"
  | "patch.mirror.inspect" | "patch.mirror.repair" | "patch.mirror.rebuild_from_local"
  | "patch.mirror.schema.repair" | "patch.subject.migrate"
  | "patch.absorption.review" | "rules.proposal.create"
  | "snapshot.read" | "snapshot.audit_archive.download" | "snapshot.export"
  | "ai.evaluate" | "ai.patch_draft.create" | "ai.rule_source_change_draft.create"
  | "ai.feishu_proposal_draft.create" | "ai.provider_policy.manage"
  | "feishu.proposal.submit" | "feishu.proposal.review" | "feishu.proposal.apply"
  | "feishu.workbook.read" | "feishu.workbook.pull" | "feishu.identity.write"
  | "feishu.rule_change.confirm_write" | "feishu.source.pull"
  | "ruleset.draft.create" | "ruleset.publish"
  | "data_source.resolve" | "data_source.preview" | "data_source.publish"
  | "data_source.writeback.preview" | "data_source.writeback.commit"
  | "excel.import" | "revision.read"
  | "config.id.reserve" | "config.id.policy.publish" | "config.id.legacy_import"
  | "config.id.ledger.correct"
  | "config.target.scan" | "config.target.scan.approve" | "config.target.catalog.publish"
  | "config.export.preview" | "config.export.commit"
  | "validation.warning.acknowledge" | "pricing.warning.acknowledge"
  | "validation.waiver.request" | "validation.waiver.approve"
  | "validation.recompute" | "rules.source_change_draft.create"
  | "rules.five_axis.publish" | "workspace.policy.manage" | "workspace.save";

export type ActionCode =
  | "open_series" | "create_series" | "open_sku" | "change_sku_target_pull" | "preview_model"
  | "edit" | "review" | "publish" | "generate_candidates" | "materialize_candidates"
  | "override_candidate_selection" | "select_candidate" | "dismiss_candidate_run"
  | "create_patch" | "review_patch" | "rebase_patch"
  | "view_snapshot" | "download_snapshot_audit_archive" | "export_snapshot"
  | "write_patch_mirror" | "pull_patch_mirror" | "inspect_patch_mirror"
  | "repair_patch_mirror" | "rebuild_patch_mirror_from_local"
  | "fix_patch_mirror_schema" | "migrate_patch_subject"
  | "run_ai_assessment" | "create_ai_patch_draft" | "create_ai_rule_source_change_draft" | "create_ai_feishu_draft" | "manage_ai_provider_policy"
  | "submit_feishu_proposal" | "review_feishu_proposal" | "apply_feishu_proposal"
  | "inspect_feishu_workbook" | "pull_feishu_workbook" | "create_ruleset_draft" | "publish_ruleset" | "write_feishu_identity"
  | "confirm_feishu_write" | "pull_feishu_source"
  | "resolve_data_source" | "preview_data_source" | "publish_data_source"
  | "preview_data_source_writeback" | "commit_data_source_writeback"
  | "import_excel" | "view_revisions"
  | "reserve_config_id_bundle" | "publish_config_id_policy"
  | "import_legacy_config_id" | "correct_config_id_ledger_metadata"
  | "scan_config_target" | "approve_config_target_scan" | "publish_config_target_catalog"
  | "preview_config_export" | "commit_config_export"
  | "acknowledge_validation_warning" | "acknowledge_price_warning"
  | "request_validation_waiver" | "approve_validation_waiver"
  | "recompute_validation" | "create_rule_source_change_draft"
  | "publish_five_axis_definition" | "manage_workspace_policy" | "save_workspace";

export const ACTION_CODES = [
  "open_series", "create_series", "open_sku", "change_sku_target_pull", "preview_model",
  "edit", "review", "publish",
  "generate_candidates", "materialize_candidates", "override_candidate_selection",
  "select_candidate", "dismiss_candidate_run",
  "create_patch", "review_patch", "rebase_patch",
  "view_snapshot", "download_snapshot_audit_archive", "export_snapshot",
  "write_patch_mirror", "pull_patch_mirror", "inspect_patch_mirror",
  "repair_patch_mirror", "rebuild_patch_mirror_from_local",
  "fix_patch_mirror_schema", "migrate_patch_subject",
  "run_ai_assessment", "create_ai_patch_draft", "create_ai_rule_source_change_draft", "create_ai_feishu_draft", "manage_ai_provider_policy",
  "submit_feishu_proposal", "review_feishu_proposal", "apply_feishu_proposal",
  "inspect_feishu_workbook", "pull_feishu_workbook", "create_ruleset_draft", "publish_ruleset", "write_feishu_identity",
  "confirm_feishu_write", "pull_feishu_source",
  "resolve_data_source", "preview_data_source", "publish_data_source",
  "preview_data_source_writeback", "commit_data_source_writeback", "import_excel", "view_revisions",
  "reserve_config_id_bundle", "publish_config_id_policy",
  "import_legacy_config_id", "correct_config_id_ledger_metadata",
  "scan_config_target", "approve_config_target_scan", "publish_config_target_catalog",
  "preview_config_export", "commit_config_export", "publish_five_axis_definition",
  "acknowledge_validation_warning", "acknowledge_price_warning",
  "request_validation_waiver", "approve_validation_waiver",
  "recompute_validation", "create_rule_source_change_draft",
  "manage_workspace_policy",
  "save_workspace",
] as const satisfies readonly ActionCode[];

export type IssuePresentationActionCode = "navigate" | "view_evidence" | "open_help";

export const ISSUE_PRESENTATION_ACTION_CODES = [
  "navigate",
  "view_evidence",
  "open_help",
] as const satisfies readonly IssuePresentationActionCode[];

/**
 * 只有这里列出的动作可以在没有 ActionCommandPayloadRef 的情况下执行。
 * 这些动作不得修改数据库、文件、远端系统或业务状态。
 */
export const READ_ONLY_ACTION_CODES = [
  "open_series",
  "open_sku",
  "preview_model",
  "view_snapshot",
  "download_snapshot_audit_archive",
  "inspect_patch_mirror",
  "inspect_feishu_workbook",
  "resolve_data_source",
  "preview_data_source",
  "preview_data_source_writeback",
  "view_revisions",
  "preview_config_export",
] as const satisfies readonly ActionCode[];

const READ_ONLY_ACTION_CODE_SET = new Set<ActionCode>(READ_ONLY_ACTION_CODES);

export function isStateChangingActionCode(action: ActionCode): boolean {
  return !READ_ONLY_ACTION_CODE_SET.has(action);
}

export interface EntityRef {
  workspaceId: string;
  entityType:
    | "workspace" | "collection" | "series" | "sku_drawer" | "model"
    | "configuration_snapshot" | "model_candidate" | "adjustment_patch"
    | "upgrade_candidate" | "rule_source_change_draft" | "feishu_rule_proposal"
    | "config_id_bundle" | "config_id_policy" | "config_target_catalog"
    | "config_target_scan_manifest" | "config_export_package";
  entityId: string;
  revisionId: string;
}

export interface ActionCommandLeaseRef {
  workspaceId: string;
  leaseId: string;
  action: ActionCode;
  fencingToken: string;
}

export interface ActionCommandPayloadRef {
  payloadRefId: string;
  action: ActionCode;
  subjectRef: EntityRef;
  expectedRevisionId: string;
  inputHash: string;
  manifestHash?: string;
  payloadHash: string;
  idempotencyKey: string;
  leaseRef: ActionCommandLeaseRef;
  expiresAt?: string;
}

export interface ActionLink {
  actionId: string;
  action: ActionCode | IssuePresentationActionCode;
  label: string;
  targetRef?: EntityRef;
  targetRoute?: string;
  enabled: boolean;
  requiredCapabilities: CapabilityCode[];
  disabledReasonCode?: string;
  disabledReasonText?: string;
  commandPayloadRef?: ActionCommandPayloadRef;
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

export class ProductParentChainError extends Error {
  readonly code = "PRODUCT_PARENT_CHAIN_INCOMPLETE";

  constructor(message: string) {
    super(message);
    this.name = "ProductParentChainError";
  }
}

/**
 * 只按稳定父链构建面包屑。当前工作区内的已解析对象必须提供完整父链；
 * 缺失父级不会通过名称、顺序、相邻对象或脱敏占位猜测。
 */
export function buildProductBreadcrumbs(input: BreadcrumbEntity & {
  workspaceId: string;
  currentEntityType?: EntityRef["entityType"];
}): BreadcrumbItem[] {
  if (input.snapshot && (!input.model || input.snapshot.modelId !== input.model.id)) {
    throw new ProductParentChainError("ConfigurationSnapshot 缺少匹配的 Model 父级。");
  }
  if (input.model && (!input.sku || input.model.skuId !== input.sku.id)) {
    throw new ProductParentChainError("Model 缺少匹配的 SKU 抽屉父级。");
  }
  if (input.sku && (!input.series || input.sku.seriesId !== input.series.id)) {
    throw new ProductParentChainError("SKU 抽屉缺少匹配的 Series 父级。");
  }
  if (input.series?.collectionId
    && (!input.collection || input.collection.id !== input.series.collectionId)) {
    throw new ProductParentChainError("Series 引用了无法解析的 Collection 父级。");
  }
  const items: BreadcrumbItem[] = [];
  const currentType = input.currentEntityType
    ?? (input.snapshot
      ? "configuration_snapshot"
      : input.model
        ? "model"
        : input.sku
          ? "sku_drawer"
          : input.series
            ? "series"
            : "collection");
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

  if (input.collection) {
    push(
      { workspaceId: input.workspaceId, entityType: "collection", entityId: input.collection.id, revisionId: input.collection.updatedAt },
      input.collection.name,
      "Collection",
    );
  }

  if (input.series) {
    push(
      { workspaceId: input.workspaceId, entityType: "series", entityId: input.series.id, revisionId: String(input.series.revision) },
      input.series.name,
      "Series",
    );
  }

  if (input.sku) {
    push(
      { workspaceId: input.workspaceId, entityType: "sku_drawer", entityId: input.sku.id, revisionId: String(input.sku.revision) },
      `${input.sku.targetPullKg} kg · SKU 抽屉`,
      "SKU 抽屉",
    );
  }

  if (input.model) {
    push(
      { workspaceId: input.workspaceId, entityType: "model", entityId: input.model.id, revisionId: String(input.model.revision) },
      `${input.model.name} · 实际选择/购买对象`,
      "Model",
    );
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
  unavailable?: ProductDeepLinkUnavailable;
  fallbackEntityType?: EntityRef["entityType"];
  integrityIssues: LegacyValidationIssue[];
}

export type ProductDeepLinkUnavailableCode =
  | "DEEP_LINK_CROSS_WORKSPACE"
  | "DEEP_LINK_OBJECT_DELETED"
  | "DEEP_LINK_ROUTE_STALE"
  | "DEEP_LINK_REFERENCE_INVALID";

export interface ProductDeepLinkUnavailable {
  code: ProductDeepLinkUnavailableCode;
  message: string;
  requestedRef: EntityRef;
  recoveryRef?: EntityRef;
}

type ProductEntityType = "collection" | "series" | "sku_drawer" | "model" | "configuration_snapshot";

const PRODUCT_ENTITY_TYPES = new Set<ProductEntityType>([
  "collection",
  "series",
  "sku_drawer",
  "model",
  "configuration_snapshot",
]);

export function resolveProductDeepLink(input: {
  workspaceId: string;
  requested: {
    ref?: EntityRef;
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
  const requestedRef = input.requested.ref ?? (() => {
    if (input.requested.snapshotId) {
      return { workspaceId: input.workspaceId, entityType: "configuration_snapshot", entityId: input.requested.snapshotId, revisionId: "unversioned" } satisfies EntityRef;
    }
    if (input.requested.modelId) {
      return { workspaceId: input.workspaceId, entityType: "model", entityId: input.requested.modelId, revisionId: "unversioned" } satisfies EntityRef;
    }
    if (input.requested.skuId) {
      return { workspaceId: input.workspaceId, entityType: "sku_drawer", entityId: input.requested.skuId, revisionId: "unversioned" } satisfies EntityRef;
    }
    if (input.requested.seriesId) {
      return { workspaceId: input.workspaceId, entityType: "series", entityId: input.requested.seriesId, revisionId: "unversioned" } satisfies EntityRef;
    }
    if (input.requested.collectionId) {
      return { workspaceId: input.workspaceId, entityType: "collection", entityId: input.requested.collectionId, revisionId: "unversioned" } satisfies EntityRef;
    }
    return undefined;
  })();
  if (requestedRef?.workspaceId !== undefined && requestedRef.workspaceId !== input.workspaceId) {
    return {
      unavailable: {
        code: "DEEP_LINK_CROSS_WORKSPACE",
        message: "该引用不属于当前工作区，未解析或返回任何对象父链。",
        requestedRef,
      },
      integrityIssues: [{
        level: "error",
        code: "DEEP_LINK_CROSS_WORKSPACE",
        message: "跨工作区对象引用已拒绝。",
      }],
    };
  }
  if (requestedRef && !PRODUCT_ENTITY_TYPES.has(requestedRef.entityType as ProductEntityType)) {
    return {
      unavailable: {
        code: "DEEP_LINK_REFERENCE_INVALID",
        message: "该引用不是可导航的产品对象。",
        requestedRef,
      },
      integrityIssues: [{
        level: "error",
        code: "DEEP_LINK_REFERENCE_INVALID",
        message: "深链接包含不受支持的产品对象类型。",
      }],
    };
  }

  const explicitIdForRef = requestedRef?.entityType === "collection"
    ? input.requested.collectionId
    : requestedRef?.entityType === "series"
      ? input.requested.seriesId
      : requestedRef?.entityType === "sku_drawer"
        ? input.requested.skuId
        : requestedRef?.entityType === "model"
          ? input.requested.modelId
          : requestedRef?.entityType === "configuration_snapshot"
            ? input.requested.snapshotId
            : undefined;
  const requestedRefConflicts = Boolean(explicitIdForRef && requestedRef && explicitIdForRef !== requestedRef.entityId);
  const requestedRefHasDescendant = Boolean(input.requested.ref && (
    (requestedRef?.entityType === "collection" && (input.requested.seriesId || input.requested.skuId || input.requested.modelId || input.requested.snapshotId))
    || (requestedRef?.entityType === "series" && (input.requested.skuId || input.requested.modelId || input.requested.snapshotId))
    || (requestedRef?.entityType === "sku_drawer" && (input.requested.modelId || input.requested.snapshotId))
    || (requestedRef?.entityType === "model" && input.requested.snapshotId)
  ));

  const requestedSnapshotId = requestedRef
    ? requestedRef.entityType === "configuration_snapshot" ? requestedRef.entityId : undefined
    : input.requested.snapshotId;
  const requestedModelId = requestedRef
    ? requestedRef.entityType === "model"
      ? requestedRef.entityId
      : requestedRef.entityType === "configuration_snapshot" ? input.requested.modelId : undefined
    : input.requested.modelId;
  const requestedSkuId = requestedRef
    ? requestedRef.entityType === "sku_drawer"
      ? requestedRef.entityId
      : requestedRef.entityType === "model" || requestedRef.entityType === "configuration_snapshot"
        ? input.requested.skuId
        : undefined
    : input.requested.skuId;
  const requestedSeriesId = requestedRef
    ? requestedRef.entityType === "series"
      ? requestedRef.entityId
      : requestedRef.entityType === "sku_drawer" || requestedRef.entityType === "model" || requestedRef.entityType === "configuration_snapshot"
        ? input.requested.seriesId
        : undefined
    : input.requested.seriesId;
  const requestedCollectionId = requestedRef
    ? requestedRef.entityType === "collection"
      ? requestedRef.entityId
      : input.requested.collectionId
    : input.requested.collectionId;

  const requestedSnapshot = requestedSnapshotId
    ? input.snapshots.find((entry) => entry.id === requestedSnapshotId)
    : undefined;
  const modelId = requestedSnapshot?.modelId ?? requestedModelId;
  const model = modelId ? input.models.find((entry) => entry.id === modelId) : undefined;
  const skuId = model?.skuId ?? requestedSkuId;
  const sku = skuId ? input.skus.find((entry) => entry.id === skuId) : undefined;
  const seriesId = sku?.seriesId ?? requestedSeriesId;
  const series = seriesId ? input.series.find((entry) => entry.id === seriesId) : undefined;
  const collectionId = series?.collectionId ?? requestedCollectionId;
  const collection = collectionId
    ? input.collections.find((entry) => entry.id === collectionId)
    : undefined;
  const frozenSnapshot = requestedSnapshot ?? (
    model?.configurationSnapshotId
      ? input.snapshots.find((entry) => entry.id === model.configurationSnapshotId)
      : undefined
  );
  try {
    if (requestedSnapshot || model || sku || series) {
      assertProductItemPartChainEnabled([
        ...(series ? [seriesItemPartId(series, input.skus)] : []),
        ...(sku ? [sku.projectionMatch.itemPartId] : []),
        ...(frozenSnapshot ? [frozenSnapshot.projectionMatch.itemPartId] : []),
      ], "product_ui");
    }
  } catch (error) {
    const blockedRef = requestedRef ?? (requestedSnapshot
      ? { workspaceId: input.workspaceId, entityType: "configuration_snapshot", entityId: requestedSnapshot.id, revisionId: String(requestedSnapshot.version) }
      : model
        ? { workspaceId: input.workspaceId, entityType: "model", entityId: model.id, revisionId: String(model.revision) }
        : sku
          ? { workspaceId: input.workspaceId, entityType: "sku_drawer", entityId: sku.id, revisionId: String(sku.revision) }
          : { workspaceId: input.workspaceId, entityType: "series", entityId: series!.id, revisionId: String(series!.revision) }) satisfies EntityRef;
    issues.push({
      level: "error",
      code: typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "ITEM_PART_NOT_ENABLED",
      message: error instanceof Error ? error.message : "部位未启用：unknown 不提供产品只读入口。",
    });
    return {
      collection,
      unavailable: {
        code: "DEEP_LINK_REFERENCE_INVALID",
        message: "对象部位谱系未启用或不一致，未返回不完整产品父链。",
        requestedRef: blockedRef,
        ...(collection
          ? {
              recoveryRef: {
                workspaceId: input.workspaceId,
                entityType: "collection" as const,
                entityId: collection.id,
                revisionId: collection.updatedAt,
              },
            }
          : {}),
      },
      fallbackEntityType: collection ? "collection" : undefined,
      integrityIssues: issues,
    };
  }

  const mismatches = [
    requestedRefConflicts
      ? "EntityRef 与同层路由 ID 不一致。"
      : "",
    requestedRefHasDescendant
      ? "EntityRef 同时携带了更深层对象 ID，目标语义不唯一。"
      : "",
    requestedModelId && requestedSnapshot && requestedSnapshot.modelId !== requestedModelId
      ? "Snapshot 与请求的 Model 父链不一致；按 Snapshot 冻结引用定位。"
      : "",
    requestedSkuId && model && model.skuId !== requestedSkuId
      ? "Model 与请求的 SKU 父链不一致；按 Model 稳定引用定位。"
      : "",
    requestedSeriesId && sku && sku.seriesId !== requestedSeriesId
      ? "SKU 与请求的 Series 父链不一致；按 SKU 稳定引用定位。"
      : "",
    requestedCollectionId && series?.collectionId && series.collectionId !== requestedCollectionId
      ? "Series 与请求的 Collection 父链不一致；按 Series 稳定引用定位。"
      : "",
  ].filter(Boolean);
  mismatches.forEach((message) => issues.push({
    level: "error",
    code: "DEEP_LINK_REFERENCE_INVALID",
    message,
  }));

  const structuralProblems = [
    requestedSnapshot && !model ? "Snapshot 引用的 Model 不存在。" : "",
    model && !sku ? "Model 引用的 SKU 抽屉不存在。" : "",
    sku && !series ? "SKU 抽屉引用的 Series 不存在。" : "",
    series?.collectionId && !collection ? "Series 引用的 Collection 不存在。" : "",
  ].filter(Boolean);
  structuralProblems.forEach((message) => issues.push({
    level: "error",
    code: "DEEP_LINK_REFERENCE_INVALID",
    message,
  }));

  const actualRequestedRevision = requestedRef?.entityType === "collection"
    ? collection?.updatedAt
    : requestedRef?.entityType === "series"
      ? series && String(series.revision)
      : requestedRef?.entityType === "sku_drawer"
        ? sku && String(sku.revision)
        : requestedRef?.entityType === "model"
          ? model && String(model.revision)
          : requestedRef?.entityType === "configuration_snapshot"
            ? requestedSnapshot && String(requestedSnapshot.version)
            : undefined;
  const currentTargetRef = requestedRef && actualRequestedRevision
    ? { ...requestedRef, revisionId: actualRequestedRevision }
    : undefined;
  const routeStale = Boolean(requestedRef
    && requestedRef.revisionId !== "unversioned"
    && actualRequestedRevision
    && requestedRef.revisionId !== actualRequestedRevision);

  const missingRequestedTarget = Boolean(requestedRef && !actualRequestedRevision);
  const recoveryRef: EntityRef | undefined = currentTargetRef
    ?? (model ? { workspaceId: input.workspaceId, entityType: "model", entityId: model.id, revisionId: String(model.revision) }
      : sku ? { workspaceId: input.workspaceId, entityType: "sku_drawer", entityId: sku.id, revisionId: String(sku.revision) }
        : series ? { workspaceId: input.workspaceId, entityType: "series", entityId: series.id, revisionId: String(series.revision) }
          : collection ? { workspaceId: input.workspaceId, entityType: "collection", entityId: collection.id, revisionId: collection.updatedAt }
            : undefined);

  let unavailable: ProductDeepLinkUnavailable | undefined;
  if (requestedRef && structuralProblems.length > 0) {
    unavailable = {
      code: "DEEP_LINK_REFERENCE_INVALID",
      message: "对象父链引用无效，未返回不完整谱系。",
      requestedRef,
    };
  } else if (requestedRef && mismatches.length > 0) {
    unavailable = {
      code: "DEEP_LINK_REFERENCE_INVALID",
      message: "路由父链与稳定引用不一致，已按当前工作区的稳定引用恢复。",
      requestedRef,
      recoveryRef,
    };
  } else if (requestedRef && missingRequestedTarget) {
    unavailable = {
      code: "DEEP_LINK_OBJECT_DELETED",
      message: "请求的对象已删除或不存在。",
      requestedRef,
      recoveryRef,
    };
  } else if (requestedRef && routeStale) {
    unavailable = {
      code: "DEEP_LINK_ROUTE_STALE",
      message: "路由引用的 revision 已过期，已定位到当前 revision。",
      requestedRef,
      recoveryRef,
    };
  }
  const fallbackEntityType = unavailable
    ? model ? "model" : sku ? "sku_drawer" : series ? "series" : collection ? "collection" : undefined
    : undefined;

  if (structuralProblems.length > 0) {
    return {
      unavailable,
      fallbackEntityType,
      integrityIssues: issues,
    };
  }

  return {
    collection,
    series,
    sku,
    model,
    snapshot: requestedSnapshot && model ? requestedSnapshot : undefined,
    unavailable,
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

const ACTION_CAPABILITIES = {
  open_series: ["series.read"],
  create_series: ["series.edit"],
  open_sku: ["sku.read"],
  change_sku_target_pull: ["sku.edit"],
  preview_model: ["model.read"],
  edit: ["model.edit"],
  review: ["model.review"],
  publish: ["model.publish"],
  generate_candidates: ["candidate.generate"],
  materialize_candidates: ["candidate.materialize"],
  override_candidate_selection: ["candidate.override_selection"],
  select_candidate: ["candidate.select"],
  dismiss_candidate_run: ["candidate.dismiss"],
  create_patch: ["model.patch.create"],
  review_patch: ["model.patch.review"],
  rebase_patch: ["patch.rebase"],
  view_snapshot: ["snapshot.read"],
  download_snapshot_audit_archive: ["snapshot.audit_archive.download"],
  export_snapshot: ["snapshot.export"],
  write_patch_mirror: ["patch.mirror.write"],
  pull_patch_mirror: ["patch.mirror.pull"],
  inspect_patch_mirror: ["patch.mirror.inspect"],
  repair_patch_mirror: ["patch.mirror.repair"],
  rebuild_patch_mirror_from_local: ["patch.mirror.rebuild_from_local"],
  fix_patch_mirror_schema: ["patch.mirror.schema.repair"],
  migrate_patch_subject: ["patch.subject.migrate"],
  run_ai_assessment: ["ai.evaluate"],
  create_ai_patch_draft: ["ai.patch_draft.create"],
  create_ai_rule_source_change_draft: ["ai.rule_source_change_draft.create"],
  create_ai_feishu_draft: ["ai.feishu_proposal_draft.create"],
  manage_ai_provider_policy: ["ai.provider_policy.manage"],
  submit_feishu_proposal: ["feishu.proposal.submit"],
  review_feishu_proposal: ["feishu.proposal.review"],
  apply_feishu_proposal: ["feishu.proposal.apply"],
  inspect_feishu_workbook: ["feishu.workbook.read"],
  pull_feishu_workbook: ["feishu.workbook.pull"],
  create_ruleset_draft: ["ruleset.draft.create"],
  publish_ruleset: ["ruleset.publish"],
  write_feishu_identity: ["feishu.identity.write"],
  confirm_feishu_write: ["feishu.rule_change.confirm_write"],
  pull_feishu_source: ["feishu.source.pull"],
  resolve_data_source: ["data_source.resolve"],
  preview_data_source: ["data_source.preview"],
  publish_data_source: ["data_source.publish"],
  preview_data_source_writeback: ["data_source.writeback.preview"],
  commit_data_source_writeback: ["data_source.writeback.commit"],
  import_excel: ["excel.import"],
  view_revisions: ["revision.read"],
  reserve_config_id_bundle: ["config.id.reserve"],
  publish_config_id_policy: ["config.id.policy.publish"],
  import_legacy_config_id: ["config.id.legacy_import"],
  correct_config_id_ledger_metadata: ["config.id.ledger.correct"],
  scan_config_target: ["config.target.scan"],
  approve_config_target_scan: ["config.target.scan.approve"],
  publish_config_target_catalog: ["config.target.catalog.publish"],
  preview_config_export: ["config.export.preview"],
  commit_config_export: ["config.export.commit"],
  acknowledge_validation_warning: ["validation.warning.acknowledge"],
  acknowledge_price_warning: ["pricing.warning.acknowledge"],
  request_validation_waiver: ["validation.waiver.request"],
  approve_validation_waiver: ["validation.waiver.approve"],
  recompute_validation: ["validation.recompute"],
  create_rule_source_change_draft: ["rules.source_change_draft.create"],
  publish_five_axis_definition: ["rules.five_axis.publish"],
  manage_workspace_policy: ["workspace.policy.manage"],
  save_workspace: ["workspace.save"],
} satisfies Partial<Record<ActionCode, readonly CapabilityCode[]>>;

export function requiredCapabilitiesForAction(action: ActionCode): CapabilityCode[] {
  return [...(ACTION_CAPABILITIES[action] ?? [])];
}

export function actionAvailability(
  action: ActionCode,
  capabilities: Iterable<CapabilityCode>,
  domainBlock?: { code: string; text: string },
): ActionAvailability {
  const held = new Set(capabilities);
  const requiredCapabilities = requiredCapabilitiesForAction(action);
  const stageBlock = action === "commit_config_export" || action === "export_snapshot"
    ? formalConfigExportActionBlock()
    : undefined;
  if (stageBlock) {
    return {
      action,
      enabled: false,
      requiredCapabilities,
      disabledReasonCode: stageBlock.code,
      disabledReasonText: stageBlock.text,
    };
  }
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

export function buildActionLink(input: {
  actionId: string;
  action: ActionCode | IssuePresentationActionCode;
  label: string;
  availability?: ActionAvailability;
  targetRef?: EntityRef;
  targetRoute?: string;
  commandPayloadRef?: ActionCommandPayloadRef;
  disabledReasonCode?: string;
  disabledReasonText?: string;
}): ActionLink {
  const presentation = (ISSUE_PRESENTATION_ACTION_CODES as readonly string[])
    .includes(input.action);
  if (presentation) {
    if (input.commandPayloadRef) {
      throw new Error("只读展示动作不得携带命令载荷。");
    }
    return {
      actionId: input.actionId,
      action: input.action,
      label: input.label,
      targetRef: input.targetRef,
      targetRoute: input.targetRoute,
      enabled: input.disabledReasonCode === undefined,
      requiredCapabilities: [],
      ...(input.disabledReasonCode
        ? {
            disabledReasonCode: input.disabledReasonCode,
            disabledReasonText: input.disabledReasonText,
          }
        : {}),
    };
  }

  const action = input.action as ActionCode;
  const availability = input.availability;
  if (!availability || availability.action !== action) {
    throw new Error("领域动作必须使用同一 ActionCode 的服务端 ActionAvailability。");
  }
  if (!availability.enabled && input.commandPayloadRef) {
    throw new Error("禁用动作不得携带命令载荷。");
  }
  if (availability.enabled && isStateChangingActionCode(action)) {
    const payloadRef = input.commandPayloadRef;
    if (!payloadRef) {
      throw new Error("ACTION_COMMAND_PAYLOAD_REQUIRED");
    }
    if (
      payloadRef.action !== action
      || payloadRef.leaseRef.action !== action
      || payloadRef.leaseRef.workspaceId !== payloadRef.subjectRef.workspaceId
      || (input.targetRef
        && (
          payloadRef.subjectRef.workspaceId !== input.targetRef.workspaceId
          || payloadRef.subjectRef.entityType !== input.targetRef.entityType
          || payloadRef.subjectRef.entityId !== input.targetRef.entityId
          || payloadRef.subjectRef.revisionId !== input.targetRef.revisionId
        ))
    ) {
      throw new Error("ACTION_COMMAND_PAYLOAD_BINDING_MISMATCH");
    }
  }
  return {
    actionId: input.actionId,
    action,
    label: input.label,
    targetRef: input.targetRef,
    targetRoute: input.targetRoute,
    enabled: availability.enabled,
    requiredCapabilities: availability.requiredCapabilities,
    disabledReasonCode: availability.disabledReasonCode,
    disabledReasonText: availability.disabledReasonText,
    ...(availability.enabled && input.commandPayloadRef
      ? { commandPayloadRef: input.commandPayloadRef }
      : {}),
  };
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
  targetPullKg: number;
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
    .filter((series) => isProductItemPartEnabled(seriesItemPartId(series, input.skus)))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((series) => {
      const itemPartId = seriesItemPartId(series, input.skus);
      const skuNodes = input.skus
        .filter((sku) =>
          sku.seriesId === series.id
          && sku.status !== "superseded"
          && isProductItemPartEnabled(sku.projectionMatch.itemPartId)
          && sku.projectionMatch.itemPartId === itemPartId)
        .sort((left, right) => left.targetPullKg - right.targetPullKg || left.id.localeCompare(right.id))
        .map((sku) => ({
          skuId: sku.id,
          targetPullKg: sku.targetPullKg,
          modelIds: sku.modelIds.filter((id) => modelIds.has(id)),
          status: sku.status,
          validationIssues: structuredClone(sku.validationSummary),
        }));
      const weights = skuNodes.map((node) => node.targetPullKg);
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
  connectorType?: "fancy_hub";
  providerPolicyVersion?: "ai-provider/open006-v1";
  requestSchemaVersion?: "ai-request/v1";
  connectorConfigured?: boolean;
  hardLimitsConfigured?: boolean;
}

export interface AIServiceAvailability {
  enabled: boolean;
  reasonCode?: "AI_DISABLED" | "AI_PROVIDER_UNCONFIRMED" | "AI_FIELD_ALLOWLIST_EMPTY"
    | "AI_CONNECTOR_NOT_CONFIGURED" | "AI_HARD_LIMIT_POLICY_MISSING";
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
  if (
    policy.connectorType !== undefined
    && (
      policy.connectorType !== "fancy_hub"
      || policy.providerPolicyVersion !== "ai-provider/open006-v1"
      || policy.requestSchemaVersion !== "ai-request/v1"
      || !policy.connectorConfigured
    )
  ) {
    return {
      enabled: false,
      reasonCode: "AI_CONNECTOR_NOT_CONFIGURED",
      reasonText: "Fancy Hub 连接器未完成独立安全配置，真实数据保持禁用。",
    };
  }
  if (policy.connectorType === "fancy_hub" && !policy.hardLimitsConfigured) {
    return {
      enabled: false,
      reasonCode: "AI_HARD_LIMIT_POLICY_MISSING",
      reasonText: "Fancy Hub provider 或租户硬限额缺失。",
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
  environmentId?: string;
  channelKey?: string;
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
