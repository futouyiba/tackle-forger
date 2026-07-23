import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildProductBreadcrumbView,
  planProductRouteRecovery,
  ProductDeepLinkUnavailableNotice,
  type ProductRouteSelection,
} from "../app/product-deep-link-ui";
import { resolveProductDeepLink } from "../lib/interaction-contracts";
import { createSeedState } from "../lib/seed";

function resolveFromState(
  state: ReturnType<typeof createSeedState>,
  requested: Parameters<typeof resolveProductDeepLink>[0]["requested"],
) {
  return resolveProductDeepLink({
    workspaceId: "tenant:test",
    requested,
    collections: state.collections,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    snapshots: state.configurationSnapshots,
  });
}

test("R2 UI 有效 Snapshot 深链接一次同步完整稳定父链", () => {
  const state = createSeedState();
  const snapshot = state.configurationSnapshots[0];
  const resolution = resolveFromState(state, { snapshotId: snapshot.id });
  const current: ProductRouteSelection = {
    seriesId: "",
    skuId: "",
    modelId: "",
    snapshotId: snapshot.id,
  };

  const recovery = planProductRouteRecovery(resolution, current);

  assert.equal(recovery?.disposition, "synchronized");
  assert.deepEqual(recovery?.next, {
    seriesId: resolution.series?.id,
    skuId: resolution.sku?.id,
    modelId: snapshot.modelId,
    snapshotId: snapshot.id,
  });
  assert.equal(recovery?.announcement, undefined);
});

test("R2 UI Snapshot 携带过期或错配 Model 时以冻结引用同步整条路由", () => {
  const state = createSeedState();
  const snapshotsBefore = structuredClone(state.configurationSnapshots);
  const snapshot = state.configurationSnapshots[0];
  const otherModel = state.purchasableModels.find((entry) => entry.id !== snapshot.modelId);
  assert.ok(otherModel, "seed state should contain a mismatching Model");
  const resolution = resolveFromState(state, {
    snapshotId: snapshot.id,
    modelId: otherModel.id,
  });
  const recovery = planProductRouteRecovery(resolution, {
    seriesId: "series:stale",
    skuId: otherModel.skuId,
    modelId: otherModel.id,
    snapshotId: snapshot.id,
  });

  assert.equal(resolution.unavailable?.code, "DEEP_LINK_REFERENCE_INVALID");
  assert.equal(recovery?.disposition, "synchronized");
  assert.deepEqual(recovery?.next, {
    seriesId: resolution.series?.id,
    skuId: resolution.sku?.id,
    modelId: snapshot.modelId,
    snapshotId: snapshot.id,
  });
  assert.deepEqual(state.configurationSnapshots, snapshotsBefore, "UI recovery must not mutate frozen snapshots");
});

test("R2 UI 过期 revision 保留当前完整链并给出稳定恢复提示", () => {
  const state = createSeedState();
  const model = state.purchasableModels[0];
  const resolution = resolveFromState(state, {
    ref: {
      workspaceId: "tenant:test",
      entityType: "model",
      entityId: model.id,
      revisionId: String(model.revision - 1),
    },
  });
  const current: ProductRouteSelection = {
    seriesId: resolution.series?.id ?? "",
    skuId: resolution.sku?.id ?? "",
    modelId: model.id,
    snapshotId: "",
  };
  const recovery = planProductRouteRecovery(resolution, current);

  assert.equal(resolution.unavailable?.code, "DEEP_LINK_ROUTE_STALE");
  assert.equal(recovery?.disposition, "synchronized");
  assert.equal(recovery?.changed, false);
  assert.deepEqual(recovery?.next, current);
  assert.match(recovery?.announcement ?? "", /revision 已过期/);
});

test("R2 UI 已删除 Snapshot 明确退回 Model，且不会把删除误作可恢复错配", () => {
  const state = createSeedState();
  const model = state.purchasableModels[0];
  const resolution = resolveFromState(state, {
    snapshotId: "snapshot:deleted",
    modelId: model.id,
  });
  const recovery = planProductRouteRecovery(resolution, {
    seriesId: "",
    skuId: "",
    modelId: model.id,
    snapshotId: "snapshot:deleted",
  });

  assert.equal(resolution.unavailable?.code, "DEEP_LINK_OBJECT_DELETED");
  assert.equal(recovery?.disposition, "deleted_fallback");
  assert.equal(recovery?.next.snapshotId, "");
  assert.equal(recovery?.next.modelId, model.id);
  assert.equal(recovery?.next.skuId, resolution.sku?.id);
  assert.equal(recovery?.next.seriesId, resolution.series?.id);
});

test("R2 UI 损坏父引用不崩溃、不猜父级，并显示稳定恢复态", () => {
  const state = createSeedState();
  const brokenSeries = {
    ...state.seriesDefinitions[0],
    collectionId: "collection:deleted",
  };
  const brokenState = {
    ...state,
    seriesDefinitions: [brokenSeries, ...state.seriesDefinitions.slice(1)],
  };
  const resolution = resolveFromState(brokenState, { seriesId: brokenSeries.id });
  const current: ProductRouteSelection = {
    seriesId: brokenSeries.id,
    skuId: "",
    modelId: "",
    snapshotId: "",
  };
  const recovery = planProductRouteRecovery(resolution, current);
  const breadcrumbView = buildProductBreadcrumbView({
    workspaceId: "tenant:test",
    series: brokenSeries,
    currentEntityType: "series",
  });
  const html = renderToStaticMarkup(
    createElement(ProductDeepLinkUnavailableNotice, { unavailable: breadcrumbView.unavailable }),
  );

  assert.equal(resolution.unavailable?.code, "DEEP_LINK_REFERENCE_INVALID");
  assert.equal(recovery?.disposition, "blocked");
  assert.deepEqual(recovery?.next, current);
  assert.deepEqual(breadcrumbView.breadcrumbs, []);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-error-code="DEEP_LINK_REFERENCE_INVALID"/);
  assert.match(html, /不会自动猜测父级/);
});

test("R2 UI 跨工作区引用保持 fail-closed 并清空本地对象路由", () => {
  const state = createSeedState();
  const model = state.purchasableModels[0];
  const resolution = resolveProductDeepLink({
    workspaceId: "tenant:current",
    requested: {
      ref: {
        workspaceId: "tenant:other",
        entityType: "model",
        entityId: model.id,
        revisionId: String(model.revision),
      },
    },
    collections: state.collections,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    snapshots: state.configurationSnapshots,
  });
  const recovery = planProductRouteRecovery(resolution, {
    seriesId: "series:local",
    skuId: "sku:local",
    modelId: "model:local",
    snapshotId: "snapshot:local",
  });

  assert.equal(recovery?.disposition, "rejected");
  assert.deepEqual(recovery?.next, {
    seriesId: "",
    skuId: "",
    modelId: "",
    snapshotId: "",
  });
  assert.equal(resolution.series, undefined);
  assert.equal(resolution.model, undefined);
});
