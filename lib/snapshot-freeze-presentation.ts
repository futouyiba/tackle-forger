/**
 * MOTION-05 snapshot freeze presentation model.
 *
 * Pure functions that derive a read-only freeze display state from
 * authoritative ConfigurationSnapshot + UpgradeCandidate. Zero side
 * effects, zero API calls — presentation only.
 */

import type { ConfigurationSnapshot, UpgradeCandidate } from "./types";

// ─── State ──────────────────────────────────────────────────────────────────

export type SnapshotFreezeState =
  | "NO_SNAPSHOT"
  | "BUILDING"
  | "BUILD_FAILED"
  | "FROZEN"
  | "UPGRADE_AVAILABLE";

export function snapshotFreezeStateLabel(state: SnapshotFreezeState): string {
  const labels: Record<SnapshotFreezeState, string> = {
    NO_SNAPSHOT: "尚未发布",
    BUILDING: "冻结中…",
    BUILD_FAILED: "冻结失败",
    FROZEN: "已冻结",
    UPGRADE_AVAILABLE: "可升级",
  };
  return labels[state];
}

export function isTerminalFreezeState(state: SnapshotFreezeState): boolean {
  return state === "FROZEN" || state === "UPGRADE_AVAILABLE";
}

// ─── Evidence ───────────────────────────────────────────────────────────────

export interface SnapshotFreezeEvidence {
  snapshotId: string;
  version: number;
  contentHash: string;
  patchSetHash: string;
  ruleSetVersion: string;
  projectionId: string;
  publishedBy: string;
  publishedAt: string;
  panelFieldCount: number;
  hasCalculationTrace: boolean;
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

function extractEvidence(snapshot: ConfigurationSnapshot): SnapshotFreezeEvidence {
  return {
    snapshotId: snapshot.id,
    version: snapshot.version,
    contentHash: shortHash(snapshot.contentHash),
    patchSetHash: shortHash(snapshot.patchSetHash),
    ruleSetVersion: snapshot.ruleSetVersion,
    projectionId: snapshot.projectionId,
    publishedBy: snapshot.publishedBy,
    publishedAt: snapshot.publishedAt,
    panelFieldCount: Object.keys(snapshot.finalPanelValues).length,
    hasCalculationTrace: Boolean(snapshot.calculationTrace),
  };
}

// ─── Upgrade comparison ─────────────────────────────────────────────────────

export interface UpgradeCandidateComparison {
  candidateId: string;
  fromSnapshotId: string;
  proposedRuleSetVersion: string;
  differences: Array<{ path: string; oldValue: string; newValue: string }>;
  patchRebaseSummary: string;
  status: UpgradeCandidate["status"];
  createdAt: string;
  reviewedAt?: string;
  isApproved: boolean;
}

function extractComparison(
  candidate: UpgradeCandidate,
  _oldSnapshot: ConfigurationSnapshot,
): UpgradeCandidateComparison {
  return {
    candidateId: candidate.id,
    fromSnapshotId: candidate.fromSnapshotId,
    proposedRuleSetVersion: candidate.proposedRuleSetVersion,
    differences: candidate.differences.map((diff) => ({
      path: diff.path,
      oldValue: formatFreezeValue(diff.oldResult),
      newValue: formatFreezeValue(diff.newResult),
    })),
    patchRebaseSummary: `${candidate.patchRebasePreview.oldProjectionId} → ${candidate.patchRebasePreview.newProjectionId}`,
    status: candidate.status,
    createdAt: candidate.createdAt,
    reviewedAt: candidate.reviewedAt,
    isApproved: candidate.status === "approved",
  };
}

// ─── Model ──────────────────────────────────────────────────────────────────

export interface SnapshotFreezeModel {
  state: SnapshotFreezeState;
  evidence?: SnapshotFreezeEvidence;
  upgradeCandidate?: UpgradeCandidateComparison;
  /** True when this snapshot already existed (idempotent replay / re-view). */
  isReplay: boolean;
}

export interface SnapshotFreezeModelInput {
  snapshot: ConfigurationSnapshot | undefined | null;
  upgradeCandidate: UpgradeCandidate | undefined | null;
  /** Whether a publish/freeze action is currently in progress. */
  isBuilding: boolean;
  /** Whether the last build attempt failed. */
  buildError: string | null;
  /** Whether this is a re-view of an already-frozen snapshot. */
  isReplay: boolean;
}

// ─── Builder ────────────────────────────────────────────────────────────────

function formatFreezeValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

/**
 * Builds a read-only SnapshotFreezeModel from authoritative inputs.
 *
 * The model is a projection — it never mutates, stores, or derives business
 * facts beyond what the inputs already declare.
 */
export function buildSnapshotFreezeModel(
  input: SnapshotFreezeModelInput,
): SnapshotFreezeModel {
  const { snapshot, upgradeCandidate, isBuilding, buildError, isReplay } = input;

  // Building → BUILDING
  if (isBuilding) {
    return { state: "BUILDING", isReplay: false };
  }

  // Build failed
  if (buildError && !snapshot) {
    return { state: "BUILD_FAILED", isReplay: false };
  }

  // Upgrade candidate exists and is pending/approved → UPGRADE_AVAILABLE
  // (even if snapshot exists, the candidate represents a newer upstream change)
  if (upgradeCandidate && upgradeCandidate.status !== "rejected" && snapshot) {
    return {
      state: "UPGRADE_AVAILABLE",
      evidence: extractEvidence(snapshot),
      upgradeCandidate: extractComparison(upgradeCandidate, snapshot),
      isReplay,
    };
  }

  // Snapshot exists and is frozen
  if (snapshot) {
    return {
      state: "FROZEN",
      evidence: extractEvidence(snapshot),
      isReplay,
    };
  }

  // No snapshot, no build in progress
  return { state: "NO_SNAPSHOT", isReplay: false };
}
