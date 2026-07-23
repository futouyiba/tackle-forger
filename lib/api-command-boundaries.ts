import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";
import {
  READ_ONLY_LEGACY_PRODUCT_FIELDS,
  isReadOnlyLegacyProductField,
} from "./legacy-history";

export { findReadOnlyLegacyProductChanges } from "./legacy-history";

/**
 * 不得通过整包 PUT /api/state 覆盖的字段(默认放行其余字段)。
 * 这是一个小而稳定的 denylist:已发布不可变数据、只读旧历史,以及有专属领域命令
 * (Series/SKU 走命令,UI 仍可改)的字段。其余工作台字段一律允许整包保存,
 * 否则配置工作台连"加一个重量段"都存不进去。
 */
const GOVERNED_FIELDS = new Set<string>([
  ...READ_ONLY_LEGACY_PRODUCT_FIELDS, // recipes / candidates / officialSkus / detailOverrides
  "configurationSnapshots", // 已发布快照,不可变
  "ruleSetVersions", // 已发布规则集
  "seriesDefinitions", // POST /api/series
  "skuDrawers", // POST /api/skus/target-pull
]);

export function findGovernedStateChanges(
  current: WorkspaceState,
  proposed: WorkspaceState,
): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  return [...keys].filter((key) => {
    if (!GOVERNED_FIELDS.has(key)) return false;
    return JSON.stringify((current as unknown as Record<string, unknown>)[key])
      !== JSON.stringify((proposed as unknown as Record<string, unknown>)[key]);
  });
}

export function changesOnlyReadOnlyLegacyHistory(changes: string[]): boolean {
  return changes.length > 0 && changes.every(isReadOnlyLegacyProductField);
}

export function stableAuditActor(identity: RequestIdentity): string {
  if (identity.tenantKey && identity.openId) {
    return `feishu:${identity.tenantKey}:${identity.openId}`;
  }
  return identity.name.trim() || identity.email.trim() || "unknown-actor";
}
