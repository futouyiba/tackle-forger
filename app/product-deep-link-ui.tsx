"use client";

import {
  buildProductBreadcrumbs,
  ProductParentChainError,
  type BreadcrumbItem,
  type ProductDeepLinkResolution,
  type ProductDeepLinkUnavailable,
} from "@/lib/interaction-contracts";

export interface ProductRouteSelection {
  seriesId: string;
  skuId: string;
  modelId: string;
  snapshotId: string;
}

export interface ProductRouteRecoveryPlan {
  next: ProductRouteSelection;
  changed: boolean;
  disposition: "synchronized" | "deleted_fallback" | "rejected" | "blocked";
  announcement?: string;
}

export interface ProductBreadcrumbUnavailable {
  code: "DEEP_LINK_REFERENCE_INVALID";
  message: string;
}

function sameSelection(left: ProductRouteSelection, right: ProductRouteSelection) {
  return left.seriesId === right.seriesId
    && left.skuId === right.skuId
    && left.modelId === right.modelId
    && left.snapshotId === right.snapshotId;
}

function resolvedSelection(resolution: ProductDeepLinkResolution): ProductRouteSelection {
  return {
    seriesId: resolution.series?.id ?? "",
    skuId: resolution.sku?.id ?? "",
    modelId: resolution.model?.id ?? "",
    snapshotId: resolution.snapshot?.id ?? "",
  };
}

/**
 * 将解析器返回的稳定父链作为一个整体同步到路由选择状态。
 * 无法恢复的引用错误保持原状态，以便界面稳定显示完整性错误，且不猜测父级。
 */
export function planProductRouteRecovery(
  resolution: ProductDeepLinkResolution,
  current: ProductRouteSelection,
): ProductRouteRecoveryPlan | undefined {
  const unavailable = resolution.unavailable;
  if (unavailable?.code === "DEEP_LINK_CROSS_WORKSPACE") {
    const next = { seriesId: "", skuId: "", modelId: "", snapshotId: "" };
    return {
      next,
      changed: !sameSelection(current, next),
      disposition: "rejected",
      announcement: unavailable.message,
    };
  }

  if (unavailable?.code === "DEEP_LINK_REFERENCE_INVALID" && !unavailable.recoveryRef) {
    return {
      next: current,
      changed: false,
      disposition: "blocked",
      announcement: unavailable.message,
    };
  }

  const hasResolvedRoute = Boolean(
    resolution.series
    || resolution.sku
    || resolution.model
    || resolution.snapshot,
  );
  const hasRequestedProductRoute = Boolean(
    current.seriesId
    || current.skuId
    || current.modelId
    || current.snapshotId,
  );
  if (!hasResolvedRoute && !unavailable) return undefined;
  if (!hasRequestedProductRoute && !unavailable) return undefined;

  const next = resolvedSelection(resolution);
  if (!unavailable && sameSelection(current, next)) return undefined;

  return {
    next,
    changed: !sameSelection(current, next),
    disposition: unavailable?.code === "DEEP_LINK_OBJECT_DELETED"
      ? "deleted_fallback"
      : "synchronized",
    announcement: unavailable?.message,
  };
}

export function buildProductBreadcrumbView(
  input: Parameters<typeof buildProductBreadcrumbs>[0],
): { breadcrumbs: BreadcrumbItem[]; unavailable?: ProductBreadcrumbUnavailable } {
  try {
    return { breadcrumbs: buildProductBreadcrumbs(input) };
  } catch (error) {
    if (!(error instanceof ProductParentChainError)) throw error;
    return {
      breadcrumbs: [],
      unavailable: {
        code: "DEEP_LINK_REFERENCE_INVALID",
        message: error.message,
      },
    };
  }
}

export function ProductDeepLinkUnavailableNotice({
  unavailable,
}: {
  unavailable?: Pick<ProductDeepLinkUnavailable, "code" | "message"> | ProductBreadcrumbUnavailable;
}) {
  if (!unavailable) return null;
  return (
    <div
      className="gantt-reference-unavailable"
      role="alert"
      data-error-code={unavailable.code}
    >
      <strong>{unavailable.code}</strong>
      <span>{unavailable.message}</span>
      {unavailable.code === "DEEP_LINK_REFERENCE_INVALID"
        ? <small>请返回有效父级，或通过迁移审计修复稳定引用；系统不会自动猜测父级。</small>
        : null}
    </div>
  );
}
