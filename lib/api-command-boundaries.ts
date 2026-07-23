import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";
import {
  isReadOnlyLegacyProductField,
} from "./legacy-history";
import { stableStringify } from "./rule-kernel";

export { findReadOnlyLegacyProductChanges } from "./legacy-history";

export function findGovernedStateChanges(
  current: WorkspaceState,
  proposed: WorkspaceState,
): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  return [...keys].filter((key) => key !== "notes").filter(
    (key) => stableStringify((current as unknown as Record<string, unknown>)[key])
      !== stableStringify((proposed as unknown as Record<string, unknown>)[key]),
  );
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
