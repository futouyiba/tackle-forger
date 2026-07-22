import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";

const wholeStatePutAllowedKeys = new Set<keyof WorkspaceState>(["notes"]);

export function findGovernedStateChanges(
  current: WorkspaceState,
  proposed: WorkspaceState,
): string[] {
  return (Object.keys(current) as (keyof WorkspaceState)[]).filter(
    (key) => !wholeStatePutAllowedKeys.has(key),
  ).filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(proposed[key]),
  );
}

export function stableAuditActor(identity: RequestIdentity): string {
  if (identity.tenantKey && identity.openId) {
    return `feishu:${identity.tenantKey}:${identity.openId}`;
  }
  return identity.name.trim() || identity.email.trim() || "unknown-actor";
}
