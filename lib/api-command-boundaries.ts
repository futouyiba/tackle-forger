import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";
import {
  isReadOnlyLegacyProductField,
} from "./legacy-history";

export { findReadOnlyLegacyProductChanges } from "./legacy-history";

/**
 * General configuration fields persisted by the explicit "save workspace"
 * action. Everything else is command-governed by default. Legacy product
 * collections are intentionally absent: they are read-only migration history.
 *
 * Keep this list aligned with direct `mutate` calls in Workbench.  In
 * particular, v3 product entities, immutable snapshots, ledgers, command
 * records and audit histories must never be added here merely to make a save
 * succeed; those require a dedicated domain command.
 */
export const GENERAL_WORKSPACE_SAVE_FIELDS = [
  "notes",
  "parameters",
  "templates",
  "modifiers",
  "layers",
  "affixes",
  "qualityBands",
  "affixScorePolicy",
  "seriesShowcases",
  "ruleGraphs",
  "ruleRuns",
  "dataSources",
] as const satisfies readonly (keyof WorkspaceState)[];

const generalWorkspaceSaveFields = new Set<string>(GENERAL_WORKSPACE_SAVE_FIELDS);

export function findGovernedStateChanges(
  current: WorkspaceState,
  proposed: WorkspaceState,
): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  return [...keys].filter((key) => !generalWorkspaceSaveFields.has(key)).filter(
    (key) => JSON.stringify((current as unknown as Record<string, unknown>)[key])
      !== JSON.stringify((proposed as unknown as Record<string, unknown>)[key]),
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
