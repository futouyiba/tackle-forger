import type { WorkspaceState } from "./types";

/**
 * Legacy product collections remain readable for migration and audit, but are
 * no longer writable through the root v3 workbench or its whole-state save.
 */
export const READ_ONLY_LEGACY_PRODUCT_FIELDS = [
  "recipes",
  "candidates",
  "officialSkus",
  "detailOverrides",
] as const satisfies readonly (keyof WorkspaceState)[];

export type ReadOnlyLegacyProductField =
  (typeof READ_ONLY_LEGACY_PRODUCT_FIELDS)[number];

const readOnlyLegacyProductFields = new Set<string>(
  READ_ONLY_LEGACY_PRODUCT_FIELDS,
);

export function isReadOnlyLegacyProductField(
  key: string,
): key is ReadOnlyLegacyProductField {
  return readOnlyLegacyProductFields.has(key);
}

export function findReadOnlyLegacyProductChanges(
  current: WorkspaceState,
  proposed: WorkspaceState,
): ReadOnlyLegacyProductField[] {
  return READ_ONLY_LEGACY_PRODUCT_FIELDS.filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(proposed[key]),
  );
}

/**
 * Accept active v3 and general-workbench state while preserving the exact
 * legacy payload, including Candidate calculation traces. This protects
 * history from client-side recalculation and full-workbook/revision restores.
 */
export function preserveReadOnlyLegacyProductHistory(
  current: WorkspaceState,
  proposed: WorkspaceState,
): WorkspaceState {
  return {
    ...proposed,
    recipes: current.recipes,
    candidates: current.candidates,
    officialSkus: current.officialSkus,
    detailOverrides: current.detailOverrides,
  };
}

export const LEGACY_COMPATIBLE_PAGE_KEYS = [
  "recipes",
  "candidates",
  "skus",
  "details",
] as const;

export function resolveCompatibleWorkbenchPage<T extends string>(
  requested: string | null,
  knownPageKeys: ReadonlySet<T>,
  fallback: T,
): T {
  return requested !== null && knownPageKeys.has(requested as T)
    ? requested as T
    : fallback;
}
