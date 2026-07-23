import type { PatchState } from "./types";

const PATCH_TRANSITIONS: Record<PatchState, readonly PatchState[]> = {
  DRAFT: ["PENDING_REVIEW", "WITHDRAWN", "SUPERSEDED"],
  PENDING_REVIEW: ["APPROVED", "REBASE_REQUIRED", "WITHDRAWN", "SUPERSEDED"],
  APPROVED: ["ACTIVE", "REBASE_REQUIRED", "SUPERSEDED"],
  ACTIVE: ["REBASE_REQUIRED", "ABSORBED", "PARTIALLY_ABSORBED"],
  REBASE_REQUIRED: ["SUPERSEDED"],
  ABSORBED: [],
  PARTIALLY_ABSORBED: [],
  WITHDRAWN: [],
  SUPERSEDED: [],
};

export function transitionPatchState(current: PatchState, next: PatchState): PatchState {
  if (!PATCH_TRANSITIONS[current].includes(next)) {
    throw new Error(`非法 Patch 状态迁移：${current} → ${next}。`);
  }
  return next;
}
