import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";

const governedStateKeys = [
  "ruleSetVersions",
  "projectionPatches",
  "patchLedger",
  "seriesDefinitions",
  "skuDrawers",
  "purchasableModels",
  "configurationSnapshots",
  "qualityValuePolicyDrafts",
  "pricingPolicyDrafts",
  "pricingPolicyVersions",
  "fiveAxisViewDefinitions",
  "fiveAxisVertexSets",
  "commandIdempotencyRecords",
] as const satisfies readonly (keyof WorkspaceState)[];

export function findGovernedStateChanges(
  current: WorkspaceState,
  proposed: WorkspaceState,
): string[] {
  return governedStateKeys.filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(proposed[key]),
  );
}

export function stableAuditActor(identity: RequestIdentity): string {
  if (identity.tenantKey && identity.openId) {
    return `feishu:${identity.tenantKey}:${identity.openId}`;
  }
  return identity.name.trim() || identity.email.trim() || "unknown-actor";
}

