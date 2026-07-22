import assert from "node:assert/strict";
import test from "node:test";
import {
  actionAvailability,
  buildActionAvailabilityMap,
  buildProductBreadcrumbs,
  aiServiceAvailability,
  assertAIRecommendationCanCreateDraft,
  buildSeriesGanttProjection,
  createExportPreviewTarget,
  derivePrimaryDisplayState,
  normalizeEntityState,
  refreshAIRecommendationState,
  resolveProductDeepLink,
  sanitizeAIInput,
  validateExportCommit,
} from "../lib/interaction-contracts";
import { createSeedState } from "../lib/seed";

test("R1 甘特图只返回真实离散 SKU，不补齐连续重量", () => {
  const state = createSeedState();
  const projection = buildSeriesGanttProjection({
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
  });
  const block = projection[0];
  assert.deepEqual(block.skuNodes.map((node) => node.targetWeightKg), [1.5, 1.8]);
  assert.equal(block.minDisplayWeightKg, 1.5);
  assert.equal(block.maxDisplayWeightKg, 1.8);
  assert.equal(
    block.coverageDisclaimer,
    "覆盖范围只表达系列规划跨度，不代表连续插值。",
  );
});

test("R1 无 SKU 草稿 Series 不绘制虚假跨度", () => {
  const state = createSeedState();
  const empty = { ...state.seriesDefinitions[0], id: "series:empty", name: "空系列" };
  const block = buildSeriesGanttProjection({
    series: [empty],
    skus: state.skuDrawers,
    models: state.purchasableModels,
  })[0];
  assert.equal(block.minDisplayWeightKg, null);
  assert.equal(block.maxDisplayWeightKg, null);
  assert.deepEqual(block.skuNodes, []);
});

test("R2 前端动作由 Capability 与服务端禁用原因共同决定", () => {
  const denied = actionAvailability("publish", ["model.read"]);
  assert.equal(denied.enabled, false);
  assert.equal(denied.disabledReasonCode, "CAPABILITY_MISSING");
  const blocked = actionAvailability("publish", ["model.publish"], {
    code: "HARD_CONFLICT",
    text: "硬冲突阻止发布。",
  });
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.disabledReasonCode, "HARD_CONFLICT");
  assert.equal(actionAvailability("publish", ["model.publish"]).enabled, true);
});

test("R2 服务端一次返回完整 ActionAvailability 映射", () => {
  const actions = buildActionAvailabilityMap(["series.read", "series.edit", "candidate.generate"]);
  assert.equal(actions.open_series.enabled, true);
  assert.equal(actions.create_series.enabled, true);
  assert.equal(actions.generate_candidates.enabled, true);
  assert.equal(actions.materialize_candidates.enabled, false);
  assert.equal(actions.materialize_candidates.disabledReasonCode, "CAPABILITY_MISSING");
  assert.deepEqual(actions.materialize_candidates.requiredCapabilities, ["candidate.materialize"]);
});

test("正式 Series 创建与查看分别授权", () => {
  assert.equal(buildActionAvailabilityMap(["series.read"]).create_series.enabled, false);
  const editor = buildActionAvailabilityMap(["series.edit"]);
  assert.equal(editor.create_series.enabled, true);
  assert.deepEqual(editor.create_series.requiredCapabilities, ["series.edit"]);
  assert.equal(editor.open_series.enabled, false);
});

test("R2 规则工作簿检查、拉取、建草稿与 ID 回写分别授权", () => {
  const actions = buildActionAvailabilityMap([
    "feishu.workbook.read",
    "feishu.workbook.pull",
    "ruleset.draft.create",
    "ruleset.publish",
  ]);
  assert.equal(actions.inspect_feishu_workbook.enabled, true);
  assert.equal(actions.pull_feishu_workbook.enabled, true);
  assert.equal(actions.create_ruleset_draft.enabled, true);
  assert.equal(actions.publish_ruleset.enabled, true);
  assert.equal(actions.write_feishu_identity.enabled, false);
  assert.equal(buildActionAvailabilityMap(["ruleset.draft.create"]).publish_ruleset.enabled, false);
  assert.deepEqual(actions.write_feishu_identity.requiredCapabilities, ["feishu.identity.write"]);
  assert.equal(actions.save_workspace.enabled, false);
  assert.equal(buildActionAvailabilityMap(["workspace.save"]).save_workspace.enabled, true);
});

test("R2 旧数据源、Excel 与版本读取动作分别由服务端映射授权", () => {
  const actions = buildActionAvailabilityMap([
    "data_source.resolve",
    "data_source.preview",
    "data_source.writeback.preview",
    "excel.import",
    "revision.read",
  ]);
  assert.equal(actions.resolve_data_source.enabled, true);
  assert.equal(actions.preview_data_source.enabled, true);
  assert.equal(actions.preview_data_source_writeback.enabled, true);
  assert.equal(actions.publish_data_source.enabled, false);
  assert.equal(actions.commit_data_source_writeback.enabled, false);
  assert.equal(actions.import_excel.enabled, true);
  assert.equal(actions.view_revisions.enabled, true);
});

test("R2 稳定面包屑使用 ID 与 revision 构建完整对象父链", () => {
  const state = createSeedState();
  const sku = state.skuDrawers[0];
  const model = state.purchasableModels.find((entry) => entry.skuId === sku.id)!;
  const snapshot = state.configurationSnapshots.find((entry) => entry.modelId === model.id);
  const collection = state.collections[0];
  const series = {
    ...state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!,
    collectionId: collection.id,
  };
  const breadcrumbs = buildProductBreadcrumbs({
    workspaceId: "tenant:test",
    collection,
    series,
    sku,
    model,
    snapshot,
    currentEntityType: "model",
  });
  assert.deepEqual(
    breadcrumbs.map((entry) => entry.ref.entityType),
    snapshot
      ? ["collection", "series", "sku_drawer", "model", "configuration_snapshot"]
      : ["collection", "series", "sku_drawer", "model"],
  );
  assert.equal(breadcrumbs.find((entry) => entry.ref.entityType === "series")?.ref.entityId, series.id);
  assert.equal(breadcrumbs.find((entry) => entry.ref.entityType === "model")?.ref.revisionId, String(model.revision));
  assert.equal(breadcrumbs.find((entry) => entry.current)?.ref.entityType, "model");
});

test("R2 无 Collection 从 Series 开始，缺失可选层不造占位", () => {
  const state = createSeedState();
  const series = { ...state.seriesDefinitions[0], collectionId: undefined };
  const breadcrumbs = buildProductBreadcrumbs({ workspaceId: "tenant:test", series });
  assert.deepEqual(breadcrumbs.map((entry) => entry.objectLabel), ["Series"]);
});

test("R2 已知但不可见父级仅披露占位且禁止导航", () => {
  const state = createSeedState();
  const series = { ...state.seriesDefinitions[0], collectionId: "collection:hidden" };
  const breadcrumbs = buildProductBreadcrumbs({ workspaceId: "tenant:test", series });
  const hidden = breadcrumbs[0];
  assert.equal(hidden.label, "不可见对象");
  assert.equal(hidden.ref.entityId, "collection:hidden");
  assert.equal(hidden.ref.revisionId, "unavailable");
  assert.equal(hidden.navigable, false);
  assert.match(hidden.unavailableReason ?? "", /无权查看/);
});

test("R2 Snapshot 深链接按冻结引用解析完整父链", () => {
  const state = createSeedState();
  const snapshot = state.configurationSnapshots[0];
  const resolution = resolveProductDeepLink({
    workspaceId: "tenant:test",
    requested: { snapshotId: snapshot.id },
    collections: state.collections,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    snapshots: state.configurationSnapshots,
  });
  assert.equal(resolution.snapshot?.id, snapshot.id);
  assert.equal(resolution.model?.id, snapshot.modelId);
  assert.equal(resolution.sku?.id, resolution.model?.skuId);
  assert.equal(resolution.series?.id, resolution.sku?.seriesId);
  assert.equal(resolution.unavailableRequestedRef, undefined);
});

test("R2 不可见 Snapshot 退回明确 Model，父链冲突不静默接受", () => {
  const state = createSeedState();
  const model = state.purchasableModels[0];
  const fallback = resolveProductDeepLink({
    workspaceId: "tenant:test",
    requested: { snapshotId: "snapshot:hidden", modelId: model.id },
    collections: state.collections,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    snapshots: state.configurationSnapshots,
  });
  assert.equal(fallback.unavailableRequestedRef?.entityType, "configuration_snapshot");
  assert.equal(fallback.fallbackEntityType, "model");
  assert.equal(fallback.model?.id, model.id);

  const snapshot = state.configurationSnapshots[0];
  const otherModel = state.purchasableModels.find((entry) => entry.id !== snapshot.modelId);
  if (otherModel) {
    const conflict = resolveProductDeepLink({
      workspaceId: "tenant:test",
      requested: { snapshotId: snapshot.id, modelId: otherModel.id },
      collections: state.collections,
      series: state.seriesDefinitions,
      skus: state.skuDrawers,
      models: state.purchasableModels,
      snapshots: state.configurationSnapshots,
    });
    assert.equal(conflict.model?.id, snapshot.modelId);
    assert.ok(conflict.integrityIssues.some((issue) => issue.code === "DEEP_LINK_PARENT_MISMATCH"));
  }
});

test("R11 主状态优先级不吞掉生命周期与注意状态", () => {
  const state = derivePrimaryDisplayState({
    lifecycle: "ACTIVE",
    revision: "APPROVED",
    validation: "BLOCKED",
    publication: "PUBLISHED",
    attention: ["HAS_UPGRADE_CANDIDATE"],
    hasPublishedSnapshot: true,
  });
  assert.equal(state.primary, "HARD_CONFLICT");
  assert.equal(state.integrityIssues.length, 0);
  const invalid = derivePrimaryDisplayState({
    lifecycle: "ACTIVE",
    revision: "APPROVED",
    validation: "PASSED",
    publication: "PUBLISHED",
    attention: [],
    hasPublishedSnapshot: false,
  });
  assert.equal(invalid.integrityIssues[0].code, "STATE_COMBINATION_INVALID");
});

test("R11 未知状态码只读降级且不被前端猜成已知状态", () => {
  const state = normalizeEntityState({
    lifecycle: "ACTIVE",
    revision: "FUTURE_REVIEW_STATE",
    validation: "PASSED",
    publication: "UNPUBLISHED",
    attention: ["FUTURE_ATTENTION"],
  });
  assert.equal(state.readOnly, true);
  assert.deepEqual(state.unknownCodes, ["FUTURE_REVIEW_STATE", "FUTURE_ATTENTION"]);
  assert.ok(state.integrityIssues.every((issue) => issue.code === "UNKNOWN_STATE_CODE"));
});

test("R6 AI 默认关闭且无确认供应方时核心能力保持不可用说明", () => {
  assert.equal(aiServiceAvailability(undefined).reasonCode, "AI_DISABLED");
  assert.equal(
    aiServiceAvailability({
      policyId: "ai:1",
      version: "1",
      enabled: true,
      provider: "external",
      model: "unknown",
      allowedFieldPaths: ["panel.drag"],
      externalDataEgressConfirmed: false,
    }).reasonCode,
    "AI_PROVIDER_UNCONFIRMED",
  );
});

test("R6 AI 输入只保留白名单且永不输出凭据字段", () => {
  const result = sanitizeAIInput(
    {
      panel: { drag: 10, secret: "no" },
      auth: { token: "never" },
      trace: { hash: "abc" },
    },
    ["panel.drag", "panel.secret", "auth.token", "trace.hash"],
  );
  assert.deepEqual(result.payload, {
    panel: { drag: 10 },
    trace: { hash: "abc" },
  });
  assert.ok(result.inputHash);
});

test("R6/R7 输入变化后建议变 stale 且不可转草稿", () => {
  const recommendation = {
    recommendationId: "rec:1",
    assessmentId: "assess:1",
    inputHash: "old",
    evidenceRefs: ["issue:1"],
    suggestedAction: "create_model_patch_draft" as const,
    state: "fresh" as const,
  };
  const stale = refreshAIRecommendationState(recommendation, "new");
  assert.equal(stale.state, "stale");
  assert.throws(
    () => assertAIRecommendationCanCreateDraft(stale, {
      frozen: false,
      currentInputHash: "new",
    }),
    /已过期/,
  );
  assert.throws(
    () => assertAIRecommendationCanCreateDraft(recommendation, {
      frozen: true,
      currentInputHash: "old",
    }),
    /冻结/,
  );
});

test("WP7B 多目标导出独立校验，一个失败不伪装成全部失败", () => {
  const baseProfile = {
    label: "测试",
    executorKind: "server_mounted_workspace" as const,
    projectRoot: "E:/workspace",
    relativeWorkbookRoot: "xlsx",
    configTomlPath: "config.toml",
    enabled: true,
    mappingId: "mapping:test",
    mappingVersion: "1",
  };
  const ready = createExportPreviewTarget({
    profile: { ...baseProfile, profileId: "dev" },
    sourceSnapshotId: "snapshot:1",
    sourceSnapshotHash: "hash-1",
    sourceFileHashes: { "tackle.xlsx": "a", "item.xlsx": "b", "store.xlsx": "c" },
    snapshotPublished: true,
  });
  const blocked = createExportPreviewTarget({
    profile: { ...baseProfile, profileId: "test", enabled: false },
    sourceSnapshotId: "snapshot:1",
    sourceSnapshotHash: "hash-1",
    sourceFileHashes: { "tackle.xlsx": "a" },
    snapshotPublished: true,
  });
  assert.equal(ready.status, "ready");
  assert.equal(blocked.status, "blocked");
});

test("WP7B 预览后任一原文件变化都会阻止提交并保留精确文件", () => {
  const preview = createExportPreviewTarget({
    profile: {
      profileId: "dev",
      label: "开发",
      executorKind: "server_mounted_workspace",
      projectRoot: "E:/workspace",
      relativeWorkbookRoot: "xlsx",
      configTomlPath: "config.toml",
      enabled: true,
      mappingId: "mapping:test",
      mappingVersion: "1",
    },
    sourceSnapshotId: "snapshot:1",
    sourceSnapshotHash: "snapshot-hash",
    sourceFileHashes: { "tackle.xlsx": "before-a", "item.xlsx": "before-b" },
    snapshotPublished: true,
  });
  const issues = validateExportCommit(preview, {
    "tackle.xlsx": "changed",
    "item.xlsx": "before-b",
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "EXPORT_SOURCE_CONFLICT");
  assert.equal(issues[0].parameterKey, "tackle.xlsx");
});



test("WP7B 已冻结快照仍会阻止未绑定发布映射的目标", () => {
  const preview = createExportPreviewTarget({
    profile: {
      profileId: "dev",
      label: "开发",
      executorKind: "local_companion",
      projectRoot: "D:/workspace",
      relativeWorkbookRoot: "xlsx",
      configTomlPath: "config.toml",
      enabled: true,
    },
    sourceSnapshotId: "snapshot:1",
    sourceSnapshotHash: "snapshot-hash",
    sourceFileHashes: {},
    snapshotPublished: true,
  });
  assert.equal(preview.status, "blocked");
  assert.ok(preview.issues.some((issue) => issue.code === "EXPORT_MAPPING_NOT_PUBLISHED"));
});
