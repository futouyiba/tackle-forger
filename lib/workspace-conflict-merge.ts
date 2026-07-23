import { isGovernedStateField } from "./api-command-boundaries";
import { stableStringify } from "./rule-kernel";
import type { WorkspaceState } from "./types";

export interface WorkspaceConflictMerge {
  /** Latest state plus safe local-only ordinary-field edits. */
  state: WorkspaceState;
  /** Ordinary top-level fields changed differently on both sides. */
  conflicts: string[];
  /** Ordinary fields safely replayed from the local draft. */
  replayedLocalFields: string[];
}

/**
 * Merge whole-workspace drafts without allowing a stale client to overwrite
 * concurrent normal edits. Governed aggregates are never replayed by this
 * recovery path: their dedicated commands own conflict handling.
 */
export function mergeWorkspaceConflict(input: {
  baseline: WorkspaceState;
  draft: WorkspaceState;
  latest: WorkspaceState;
}): WorkspaceConflictMerge {
  const baseline = input.baseline as unknown as Record<string, unknown>;
  const draft = input.draft as unknown as Record<string, unknown>;
  const latest = input.latest as unknown as Record<string, unknown>;
  const merged = structuredClone(input.latest) as unknown as Record<string, unknown>;
  const conflicts: string[] = [];
  const replayedLocalFields: string[] = [];
  const fields = new Set([...Object.keys(baseline), ...Object.keys(draft), ...Object.keys(latest)]);

  for (const field of [...fields].sort()) {
    if (isGovernedStateField(field)) continue;
    const baseValue = stableStringify(baseline[field]);
    const draftValue = stableStringify(draft[field]);
    const latestValue = stableStringify(latest[field]);
    const localChanged = draftValue !== baseValue;
    const remoteChanged = latestValue !== baseValue;
    if (!localChanged || draftValue === latestValue) continue;
    if (remoteChanged) {
      conflicts.push(field);
      continue;
    }
    merged[field] = structuredClone(draft[field]);
    replayedLocalFields.push(field);
  }

  return {
    state: merged as unknown as WorkspaceState,
    conflicts,
    replayedLocalFields,
  };
}
