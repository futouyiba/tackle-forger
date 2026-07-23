import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AIModelDescriptorV1, AIRequestEnvelopeV1, Sha256Hex } from "./ai-outbound";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const AI_RETENTION_POLICY_VERSION = "ai-model-record/open009-v1" as const;
export const AI_RETENTION_DURATIONS = Object.freeze({
  operationMetadataMs: 3 * 365 * DAY_MS,
  encryptedRawContentMs: 180 * DAY_MS,
  unacceptedSemanticContentMs: 365 * DAY_MS,
  operationLogMs: 365 * DAY_MS,
  userDeletionPrimaryPurgeMs: DAY_MS,
  backupPurgeMs: 30 * DAY_MS,
});

export interface EncryptedAIRawContent {
  algorithm: "aes-256-gcm";
  keyVersion: string;
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
}

export interface AIOperationMetadataRecord {
  assessmentId: string;
  actorStableId: string;
  scopeStableRef: string;
  /**
   * v2 fields are optional only so pre-v2 retained records remain readable.
   * Every new successful or failed provider call must write the full ledger.
   */
  metadataSchemaVersion?: "ai-operation-metadata/v2";
  scope?: {
    scopeType: "series" | "sku" | "model" | "candidate_set";
    scopeId: string;
    inputRevision: string;
  };
  ruleSetVersion?: string;
  fiveAxisRuleVersion?: string;
  attempts?: Array<{
    attemptNumber: number;
    attemptKind: "INITIAL" | "RETRY" | "FALLBACK";
    modelDescriptor: AIModelDescriptorV1;
    requestedAt: string;
    completedAt: string;
    inputHash: Sha256Hex;
    resultCode: string;
  }>;
  retryCount?: number;
  cancellationStatus?: "NOT_REQUESTED" | "REQUESTED" | "CANCELLED" | "CANCELLATION_FAILED";
  modelDescriptor: AIModelDescriptorV1;
  promptTemplateVersion: string;
  promptTemplateHash: Sha256Hex;
  schemaVersion: "ai-request/v1";
  allowlistPolicyVersion: "ai-provider/open006-v1";
  inputHash: Sha256Hex;
  outputHash?: Sha256Hex;
  requestedAt: string;
  completedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicroUsd?: number;
  resultCode: string;
  state: "ACTIVE" | "ACCEPTED" | "USER_DELETED" | "EXPIRED";
}

export interface AIAssessmentCurrentInput {
  scopeType: "series" | "sku" | "model" | "candidate_set";
  scopeId: string;
  inputRevision: string;
  ruleSetVersion: string;
  fiveAxisRuleVersion: string;
  inputHash: Sha256Hex;
}

export interface AIAssessmentFreshness {
  state: "fresh" | "stale";
  canCreateDraft: boolean;
  staleReasonCodes: Array<
    | "AI_OPERATION_METADATA_INCOMPLETE"
    | "AI_SCOPE_NOT_FOUND"
    | "AI_SCOPE_CHANGED"
    | "AI_INPUT_REVISION_CHANGED"
    | "AI_INPUT_HASH_CHANGED"
    | "AI_RULESET_VERSION_CHANGED"
    | "AI_FIVE_AXIS_RULE_VERSION_CHANGED"
    | "AI_ASSESSMENT_NOT_SUCCESSFUL"
    | "AI_SEMANTIC_CONTENT_UNAVAILABLE"
  >;
}

export interface AIUnacceptedSemanticContent {
  findings: unknown[];
  recommendations: unknown[];
  assumptions: unknown[];
  uncoveredInformation: unknown[];
  evidenceRefs: unknown[];
  /**
   * Provider-facing evidenceRefs intentionally contain request aliases only.
   * This local-only projection keeps the dereferenceable identity after the
   * encrypted raw alias map reaches its shorter retention deadline.
   */
  resolvedEvidenceRefs?: Array<{
    evidenceType: AIRequestEnvelopeV1["evidenceRefs"][number]["evidenceType"];
    evidenceAlias: string;
    refId: string;
    revisionId?: string;
    contentHash: Sha256Hex;
  }>;
  feedback?: {
    recommendations: Array<{
      recommendationId: string;
      state: "dismissed";
      dismissedAt: string;
      reason?: string;
    }>;
    acceptedArtifact?: {
      acceptedAt: string;
      artifactStableRefs: string[];
    };
  };
}

export interface AIAcceptedArtifactProvenance {
  assessmentId: string;
  modelDescriptor: AIModelDescriptorV1;
  selectedRecommendation: unknown;
  evidenceContentHashes: Sha256Hex[];
  humanDiff: unknown;
  artifactStableRefs: string[];
  retainedWithArtifact: true;
}

export interface AIDeletionTombstone {
  assessmentId: string;
  requestedAt: string;
  requestedBy: string;
  primaryPurgeDueAt: string;
  backupPurgeDueAt: string;
  primaryPurgedAt?: string;
  backupPurgedAt?: string;
  backupPurgeState?: "PENDING" | "FAILED" | "PURGED";
  backupPurgeAttempts?: number;
  backupPurgeLastErrorCode?: string;
}

export interface AIAssessmentRetentionRecord {
  policyVersion: typeof AI_RETENTION_POLICY_VERSION;
  metadata?: AIOperationMetadataRecord;
  encryptedRawContent?: EncryptedAIRawContent;
  semanticContent?: AIUnacceptedSemanticContent;
  acceptedArtifactProvenance?: AIAcceptedArtifactProvenance;
  rawContentCreatedAt?: string;
  semanticContentCreatedAt?: string;
  operationLogCreatedAt?: string;
  operationLog?: { action: string; objectHash?: Sha256Hex; resultCode: string };
  visibility: "VISIBLE" | "HIDDEN";
  deletionTombstone?: AIDeletionTombstone;
}

export interface AIBackupPurgeAdapter {
  purgeAssessmentBackups(input: { assessmentId: string; tombstoneRequestedAt: string }): Promise<void>;
  verifyAssessmentBackupsAbsent(input: { assessmentId: string; tombstoneRequestedAt: string }): Promise<boolean>;
}

export interface AIRetentionSweepResult {
  record: AIAssessmentRetentionRecord;
  auditEvents: Array<{
    action: "AI_ASSESSMENT_HIDDEN" | "AI_PRIMARY_CONTENT_PURGED" | "AI_BACKUP_PURGE_DUE"
      | "AI_BACKUP_PURGED" | "AI_BACKUP_PURGE_FAILED"
      | "AI_RAW_CONTENT_EXPIRED" | "AI_SEMANTIC_CONTENT_EXPIRED" | "AI_METADATA_EXPIRED"
      | "AI_OPERATION_LOG_EXPIRED";
    occurredAt: string;
  }>;
}

function date(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 时间无效。`);
  return parsed;
}

function iso(value: number): string { return new Date(value).toISOString(); }

function assessmentId(record: AIAssessmentRetentionRecord): string {
  const value = record.metadata?.assessmentId ?? record.acceptedArtifactProvenance?.assessmentId;
  if (!value) throw new Error("AI 评估保留记录缺少 assessmentId，不能建立删除墓碑。" );
  return value;
}

export function evaluateAIAssessmentFreshness(
  metadata: AIOperationMetadataRecord,
  current: AIAssessmentCurrentInput | undefined,
  options: { semanticContentAvailable?: boolean } = {},
): AIAssessmentFreshness {
  const reasons: AIAssessmentFreshness["staleReasonCodes"] = [];
  if (metadata.metadataSchemaVersion !== "ai-operation-metadata/v2"
    || !metadata.scope
    || !metadata.ruleSetVersion
    || !metadata.fiveAxisRuleVersion
    || !metadata.attempts
    || metadata.retryCount === undefined
    || !metadata.cancellationStatus) {
    reasons.push("AI_OPERATION_METADATA_INCOMPLETE");
  }
  if (metadata.resultCode !== "SUCCESS") {
    reasons.push("AI_ASSESSMENT_NOT_SUCCESSFUL");
  }
  if (options.semanticContentAvailable === false) {
    reasons.push("AI_SEMANTIC_CONTENT_UNAVAILABLE");
  }
  if (!current) {
    reasons.push("AI_SCOPE_NOT_FOUND");
  } else if (metadata.scope) {
    if (metadata.scope.scopeType !== current.scopeType || metadata.scope.scopeId !== current.scopeId) {
      reasons.push("AI_SCOPE_CHANGED");
    }
    if (metadata.scope.inputRevision !== current.inputRevision) {
      reasons.push("AI_INPUT_REVISION_CHANGED");
    }
    if (metadata.inputHash !== current.inputHash) {
      reasons.push("AI_INPUT_HASH_CHANGED");
    }
    if (metadata.ruleSetVersion !== current.ruleSetVersion) {
      reasons.push("AI_RULESET_VERSION_CHANGED");
    }
    if (metadata.fiveAxisRuleVersion !== current.fiveAxisRuleVersion) {
      reasons.push("AI_FIVE_AXIS_RULE_VERSION_CHANGED");
    }
  }
  const staleReasonCodes = [...new Set(reasons)];
  return {
    state: staleReasonCodes.length ? "stale" : "fresh",
    canCreateDraft: staleReasonCodes.length === 0,
    staleReasonCodes,
  };
}

export function encryptAIRawContent(input: {
  assessmentId: string;
  plaintext: string;
  key: Uint8Array;
  keyVersion: string;
}): EncryptedAIRawContent {
  if (input.key.byteLength !== 32) throw new Error("AI 原始内容加密密钥必须是 32 字节。" );
  if (!input.keyVersion.trim()) throw new Error("AI 原始内容必须记录加密密钥版本。" );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(input.assessmentId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    keyVersion: input.keyVersion,
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
  };
}

export function decryptAIRawContent(input: {
  assessmentId: string;
  encrypted: EncryptedAIRawContent;
  key: Uint8Array;
}): string {
  if (input.key.byteLength !== 32) throw new Error("AI 原始内容解密密钥必须是 32 字节。" );
  const decipher = createDecipheriv("aes-256-gcm", input.key, Buffer.from(input.encrypted.ivBase64, "base64"));
  decipher.setAAD(Buffer.from(input.assessmentId, "utf8"));
  decipher.setAuthTag(Buffer.from(input.encrypted.authTagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.encrypted.ciphertextBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function requestAIAssessmentDeletion(input: {
  record: AIAssessmentRetentionRecord;
  requestedBy: string;
  now: Date;
}): AIRetentionSweepResult {
  const record = structuredClone(input.record);
  const nowMs = input.now.getTime();
  record.visibility = "HIDDEN";
  if (record.metadata) record.metadata.state = "USER_DELETED";
  record.deletionTombstone ??= {
    assessmentId: assessmentId(record),
    requestedAt: input.now.toISOString(),
    requestedBy: input.requestedBy,
    primaryPurgeDueAt: iso(nowMs + AI_RETENTION_DURATIONS.userDeletionPrimaryPurgeMs),
    backupPurgeDueAt: iso(nowMs + AI_RETENTION_DURATIONS.backupPurgeMs),
  };
  return { record, auditEvents: [{ action: "AI_ASSESSMENT_HIDDEN", occurredAt: input.now.toISOString() }] };
}

export function sweepAIAssessmentRetention(input: {
  record: AIAssessmentRetentionRecord;
  now: Date;
}): AIRetentionSweepResult {
  const record = structuredClone(input.record);
  const now = input.now.getTime();
  const occurredAt = input.now.toISOString();
  const auditEvents: AIRetentionSweepResult["auditEvents"] = [];
  const tombstone = record.deletionTombstone;
  if (tombstone && now >= date(tombstone.primaryPurgeDueAt, "primaryPurgeDueAt") && !tombstone.primaryPurgedAt) {
    delete record.encryptedRawContent;
    delete record.semanticContent;
    tombstone.primaryPurgedAt = occurredAt;
    auditEvents.push({ action: "AI_PRIMARY_CONTENT_PURGED", occurredAt });
  }
  if (tombstone && now >= date(tombstone.backupPurgeDueAt, "backupPurgeDueAt") && !tombstone.backupPurgedAt) {
    tombstone.backupPurgeState = tombstone.backupPurgeState === "FAILED" ? "FAILED" : "PENDING";
    auditEvents.push({ action: "AI_BACKUP_PURGE_DUE", occurredAt });
  }
  if (record.encryptedRawContent && record.rawContentCreatedAt
    && now >= date(record.rawContentCreatedAt, "rawContentCreatedAt") + AI_RETENTION_DURATIONS.encryptedRawContentMs) {
    delete record.encryptedRawContent;
    auditEvents.push({ action: "AI_RAW_CONTENT_EXPIRED", occurredAt });
  }
  if (record.semanticContent && record.semanticContentCreatedAt
    && now >= date(record.semanticContentCreatedAt, "semanticContentCreatedAt") + AI_RETENTION_DURATIONS.unacceptedSemanticContentMs) {
    delete record.semanticContent;
    auditEvents.push({ action: "AI_SEMANTIC_CONTENT_EXPIRED", occurredAt });
  }
  if (record.operationLog && record.operationLogCreatedAt
    && now >= date(record.operationLogCreatedAt, "operationLogCreatedAt") + AI_RETENTION_DURATIONS.operationLogMs) {
    delete record.operationLog;
    auditEvents.push({ action: "AI_OPERATION_LOG_EXPIRED", occurredAt });
  }
  if (record.metadata && now >= date(record.metadata.requestedAt, "metadata.requestedAt") + AI_RETENTION_DURATIONS.operationMetadataMs) {
    delete record.metadata;
    auditEvents.push({ action: "AI_METADATA_EXPIRED", occurredAt });
  }
  // acceptedArtifactProvenance intentionally has no expiry and survives user deletion.
  return { record, auditEvents };
}

export async function purgeAIAssessmentBackups(input: {
  record: AIAssessmentRetentionRecord;
  now: Date;
  adapter: AIBackupPurgeAdapter;
}): Promise<AIRetentionSweepResult> {
  const record = structuredClone(input.record);
  const tombstone = record.deletionTombstone;
  const occurredAt = input.now.toISOString();
  if (!tombstone || input.now.getTime() < date(tombstone.backupPurgeDueAt, "backupPurgeDueAt") || tombstone.backupPurgedAt) {
    return { record, auditEvents: [] };
  }
  tombstone.backupPurgeAttempts = (tombstone.backupPurgeAttempts ?? 0) + 1;
  tombstone.backupPurgeState = "PENDING";
  delete tombstone.backupPurgeLastErrorCode;
  try {
    // Recovery may arrive after the physical deletion succeeded but before its
    // tombstone update committed. Verify first so replay does not delete twice.
    let absent = await input.adapter.verifyAssessmentBackupsAbsent({
      assessmentId: tombstone.assessmentId,
      tombstoneRequestedAt: tombstone.requestedAt,
    });
    if (!absent) {
      await input.adapter.purgeAssessmentBackups({
        assessmentId: tombstone.assessmentId,
        tombstoneRequestedAt: tombstone.requestedAt,
      });
      absent = await input.adapter.verifyAssessmentBackupsAbsent({
        assessmentId: tombstone.assessmentId,
        tombstoneRequestedAt: tombstone.requestedAt,
      });
    }
    if (!absent) throw new Error("AI_BACKUP_PURGE_VERIFICATION_FAILED");
    tombstone.backupPurgeState = "PURGED";
    tombstone.backupPurgedAt = occurredAt;
    return { record, auditEvents: [{ action: "AI_BACKUP_PURGED", occurredAt }] };
  } catch (error) {
    tombstone.backupPurgeState = "FAILED";
    tombstone.backupPurgeLastErrorCode = error instanceof Error && error.message
      ? error.message.slice(0, 128)
      : "AI_BACKUP_PURGE_FAILED";
    return { record, auditEvents: [{ action: "AI_BACKUP_PURGE_FAILED", occurredAt }] };
  }
}

export function assertAIAssessmentVisible(record: AIAssessmentRetentionRecord): void {
  if (record.visibility !== "VISIBLE" || record.deletionTombstone) {
    throw new Error("AI_ASSESSMENT_USER_DELETED");
  }
}
