import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";

/**
 * Fields still authored by the legacy workbench and persisted by its explicit
 * "save workspace" action.  Everything else is command-governed by default.
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
  "recipes",
  "seriesShowcases",
  "candidates",
  "officialSkus",
  "detailOverrides",
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

export function stableAuditActor(identity: RequestIdentity): string {
  if (identity.tenantKey && identity.openId) {
    return `feishu:${identity.tenantKey}:${identity.openId}`;
  }
  return identity.name.trim() || identity.email.trim() || "unknown-actor";
}
