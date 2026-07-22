import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AIModelDescriptorV1, Sha256Hex } from "./ai-outbound";

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
  state: "ACTIVE" | "USER_DELETED" | "EXPIRED";
}

export interface AIUnacceptedSemanticContent {
  findings: unknown[];
  recommendations: unknown[];
  assumptions: unknown[];
  uncoveredInformation: unknown[];
  evidenceRefs: unknown[];
  feedback?: unknown;
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
  deletionTombstone?: {
    requestedAt: string;
    requestedBy: string;
    primaryPurgeDueAt: string;
    backupPurgeDueAt: string;
    primaryPurgedAt?: string;
    backupPurgedAt?: string;
  };
}

export interface AIRetentionSweepResult {
  record: AIAssessmentRetentionRecord;
  auditEvents: Array<{
    action: "AI_ASSESSMENT_HIDDEN" | "AI_PRIMARY_CONTENT_PURGED" | "AI_BACKUP_PURGE_DUE"
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
    tombstone.backupPurgedAt = occurredAt;
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

export function assertAIAssessmentVisible(record: AIAssessmentRetentionRecord): void {
  if (record.visibility !== "VISIBLE" || record.deletionTombstone) {
    throw new Error("AI_ASSESSMENT_USER_DELETED");
  }
}

