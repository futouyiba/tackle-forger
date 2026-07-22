import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";

export function findGovernedStateChanges(
  current: WorkspaceState,
  proposed: WorkspaceState,
): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  return [...keys].filter((key) => key !== "notes").filter(
    (key) => JSON.stringify((current as unknown as Record<string, unknown>)[key])
      !== JSON.stringify((proposed as unknown as Record<string, unknown>)[key]),
  );
}

export function stableAuditActor(identity: RequestIdentity): string {
  if (identity.tenantKey && identity.openId) {
    return `feishu:${identity.tenantKey}:${identity.openId}`;
  }
  return identity.name.trim() || identity.email.trim() || "unknown-actor";
}
