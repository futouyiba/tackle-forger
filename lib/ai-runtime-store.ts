import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AI_RETENTION_POLICY_VERSION,
  assertAIAssessmentVisible,
  encryptAIRawContent,
  purgeAIAssessmentBackups,
  requestAIAssessmentDeletion,
  sweepAIAssessmentRetention,
  type AIBackupPurgeAdapter,
  type AIRetentionSweepResult,
  type AIAssessmentRetentionRecord,
} from "./ai-retention";
import {
  AI_PROVIDER_POLICY_VERSION,
  promptTemplateHash,
  type AIRequestEnvelopeV1,
  type LocalAliasReferenceV1,
  type RequestAlias,
} from "./ai-outbound";
import {
  FancyHubError,
  type AIProviderHardLimits,
  type FancyHubAdmissionCoordinator,
  type FancyHubAdmissionLease,
  type FancyHubAssessmentResponse,
  type FancyHubAuditEvent,
  type FancyHubRawAssessmentAttempt,
} from "./fancy-hub";

const LOCK_RETRIES = 100;

export type AIRuntimeStoreErrorCode = "AI_RETENTION_CONFIG_INVALID" | "AI_RETENTION_STORE_UNAVAILABLE";

export class AIRuntimeStoreError extends Error {
  constructor(public readonly code: AIRuntimeStoreErrorCode, message: string) {
    super(message);
    this.name = "AIRuntimeStoreError";
  }
}

interface AIRuntimeStoreConfig {
  dataDir: string;
  encryptionKey: Uint8Array;
  encryptionKeyVersion: string;
}

export interface AIRuntimeStoreFaultHooks {
  beforeRetentionAuditAppend?: (event: AIRetentionAuditEvent & { eventId: string }) => Promise<void> | void;
  afterRetentionAuditAppended?: (event: AIRetentionAuditEvent & { eventId: string }) => Promise<void> | void;
  beforeAssessmentMutationCommitted?: (input: {
    assessmentId: string;
    auditEvents: AIRetentionAuditEvent[];
  }) => Promise<void> | void;
}

interface AIAdmissionDocument {
  version: 1;
  leases: Record<string, { workspaceId: string; expiresAtMs: number }>;
  assessmentRequestTimesMs: number[];
  providerHardLimits?: AIProviderHardLimits;
}

export interface AIRetentionAuditEvent {
  action: AIRetentionSweepResult["auditEvents"][number]["action"];
  assessmentId: string;
  actorStableId?: string;
  occurredAt: string;
  resultCode: "SUCCESS" | "FAILED";
}

export interface AIRetentionSweepSummary {
  recordsScanned: number;
  recordsChanged: number;
  auditEventsWritten: number;
  backupPurgeFailures: number;
}

interface StoredAIRetentionAuditEvent extends AIRetentionAuditEvent {
  eventId: string;
}

type StoredAIAssessmentRetentionRecord = AIAssessmentRetentionRecord & {
  runtimeAuditOutbox?: StoredAIRetentionAuditEvent[];
};

const EMPTY_ADMISSION_DOCUMENT: AIAdmissionDocument = {
  version: 1,
  leases: {},
  assessmentRequestTimesMs: [],
};

function parseEncryptionKey(value: string | undefined): Uint8Array | undefined {
  const raw = value?.trim();
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return undefined;
  const decoded = Buffer.from(raw, "base64");
  return decoded.byteLength === 32 ? decoded : undefined;
}

export function aiRuntimeStoreConfigFromEnvironment(): AIRuntimeStoreConfig | undefined {
  const dataDir = process.env.AI_RETENTION_DATA_DIR?.trim();
  const encryptionKey = parseEncryptionKey(process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64);
  const encryptionKeyVersion = process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION?.trim();
  if (!dataDir || !encryptionKey || !encryptionKeyVersion) return undefined;
  return { dataDir: path.resolve(dataDir), encryptionKey, encryptionKeyVersion };
}

export function aiRuntimeStoreEnablement(): { enabled: boolean; code?: AIRuntimeStoreErrorCode } {
  return aiRuntimeStoreConfigFromEnvironment()
    ? { enabled: true }
    : { enabled: false, code: "AI_RETENTION_CONFIG_INVALID" };
}

async function acquireLock(file: string) {
  const lockPath = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      return async () => {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockPath).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 2));
    }
  }
  throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存存储暂时繁忙。");
}

export class FileAIRuntimeStore {
  private readonly assessmentsDir: string;
  private readonly auditFile: string;
  private readonly admissionFile: string;

  constructor(
    private readonly config: AIRuntimeStoreConfig,
    private readonly faultHooks: AIRuntimeStoreFaultHooks = {},
  ) {
    this.assessmentsDir = path.join(config.dataDir, "assessments");
    this.auditFile = path.join(config.dataDir, "audit.jsonl");
    this.admissionFile = path.join(config.dataDir, "admission.json");
  }

  private assessmentTarget(assessmentId: string): string {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(assessmentId)) {
      throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存记录 ID 格式无效。");
    }
    return path.join(this.assessmentsDir, `${assessmentId}.json`);
  }

  private async readAssessmentFile(target: string): Promise<StoredAIAssessmentRetentionRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(target, "utf8")) as StoredAIAssessmentRetentionRecord;
      if (!parsed || typeof parsed !== "object" || parsed.policyVersion !== AI_RETENTION_POLICY_VERSION) {
        throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存记录格式无效。");
      }
      if (parsed.runtimeAuditOutbox && (!Array.isArray(parsed.runtimeAuditOutbox)
        || parsed.runtimeAuditOutbox.some((event) => !event || typeof event !== "object"
          || typeof event.eventId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(event.eventId)))) {
        throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存审计待写队列格式无效。");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof AIRuntimeStoreError) throw error;
      throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存记录无法读取。");
    }
  }

  private async writeAssessmentFile(target: string, record: StoredAIAssessmentRetentionRecord): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private async mutateAssessment<T>(
    assessmentId: string,
    operation: (record: StoredAIAssessmentRetentionRecord | undefined) => Promise<{ record?: StoredAIAssessmentRetentionRecord; result: T }> | { record?: StoredAIAssessmentRetentionRecord; result: T },
  ): Promise<T> {
    await mkdir(this.assessmentsDir, { recursive: true, mode: 0o700 });
    const target = this.assessmentTarget(assessmentId);
    const release = await acquireLock(target);
    try {
      const current = await this.readAssessmentFile(target);
      const next = await operation(current ? structuredClone(current) : undefined);
      if (next.record) await this.writeAssessmentFile(target, next.record);
      return next.result;
    } finally {
      await release();
    }
  }

  private publicAssessmentRecord(record: StoredAIAssessmentRetentionRecord): AIAssessmentRetentionRecord {
    const result = structuredClone(record);
    delete result.runtimeAuditOutbox;
    return result;
  }

  private async appendRetentionAuditEventsOnce(events: StoredAIRetentionAuditEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const release = await acquireLock(this.auditFile);
    try {
      const existingIds = new Set<string>();
      try {
        const content = await readFile(this.auditFile, "utf8");
        for (const line of content.split("\n")) {
          if (!line) continue;
          const event = JSON.parse(line) as { eventId?: unknown };
          if (typeof event.eventId === "string") existingIds.add(event.eventId);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let written = 0;
      for (const event of events) {
        if (existingIds.has(event.eventId)) continue;
        await this.faultHooks.beforeRetentionAuditAppend?.(structuredClone(event));
        await appendFile(this.auditFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
        existingIds.add(event.eventId);
        written += 1;
        await this.faultHooks.afterRetentionAuditAppended?.(structuredClone(event));
      }
      return written;
    } finally {
      await release();
    }
  }

  private async flushAssessmentAuditOutbox(
    target: string,
    record: StoredAIAssessmentRetentionRecord,
  ): Promise<number> {
    const events = record.runtimeAuditOutbox ?? [];
    if (events.length === 0) return 0;
    // The stable eventId makes replay safe if the process stopped after append
    // but before this assessment record could acknowledge the outbox.
    const written = await this.appendRetentionAuditEventsOnce(events);
    delete record.runtimeAuditOutbox;
    await this.writeAssessmentFile(target, record);
    return written;
  }

  private async mutateAssessmentWithAudit<T>(
    assessmentId: string,
    operation: (record: StoredAIAssessmentRetentionRecord | undefined) => Promise<{
      record?: StoredAIAssessmentRetentionRecord;
      result: T;
      auditEvents?: AIRetentionAuditEvent[];
    }> | {
      record?: StoredAIAssessmentRetentionRecord;
      result: T;
      auditEvents?: AIRetentionAuditEvent[];
    },
  ): Promise<{ result: T; auditEventsWritten: number }> {
    await mkdir(this.assessmentsDir, { recursive: true, mode: 0o700 });
    const target = this.assessmentTarget(assessmentId);
    const release = await acquireLock(target);
    try {
      let current = await this.readAssessmentFile(target);
      let auditEventsWritten = current
        ? await this.flushAssessmentAuditOutbox(target, current)
        : 0;
      const next = await operation(current ? structuredClone(current) : undefined);
      if (next.record) {
        current = next.record;
        await this.faultHooks.beforeAssessmentMutationCommitted?.({
          assessmentId,
          auditEvents: structuredClone(next.auditEvents ?? []),
        });
        if (next.auditEvents?.length) {
          current.runtimeAuditOutbox = [
            ...(current.runtimeAuditOutbox ?? []),
            ...next.auditEvents.map((event) => ({
              ...event,
              eventId: randomBytes(24).toString("base64url"),
            })),
          ];
        }
        await this.writeAssessmentFile(target, current);
        auditEventsWritten += await this.flushAssessmentAuditOutbox(target, current);
      }
      return { result: next.result, auditEventsWritten };
    } finally {
      await release();
    }
  }

  private async mutateAdmission<T>(operation: (document: AIAdmissionDocument) => T): Promise<T> {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const release = await acquireLock(this.admissionFile);
    try {
      let document = structuredClone(EMPTY_ADMISSION_DOCUMENT);
      try {
        document = JSON.parse(await readFile(this.admissionFile, "utf8")) as AIAdmissionDocument;
        if (document.version !== 1 || !document.leases || !Array.isArray(document.assessmentRequestTimesMs)) {
          throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 准入状态文件格式无效。");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const result = operation(document);
      const temporary = `${this.admissionFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.admissionFile);
      return result;
    } finally {
      await release();
    }
  }

  admissionCoordinator(): FancyHubAdmissionCoordinator {
    return {
      readProviderHardLimits: async () => this.mutateAdmission((document) =>
        document.providerHardLimits ? structuredClone(document.providerHardLimits) : undefined),
      writeProviderHardLimits: async (limits) => {
        await this.mutateAdmission((document) => {
          document.providerHardLimits = structuredClone(limits);
        });
      },
      acquire: async (input): Promise<FancyHubAdmissionLease> => {
        const leaseId = randomBytes(24).toString("base64url");
        const admissionCounts = await this.mutateAdmission((document) => {
          const nowMs = Date.now();
          for (const [id, lease] of Object.entries(document.leases)) {
            if (lease.expiresAtMs <= nowMs) delete document.leases[id];
          }
          const leases = Object.values(document.leases);
          const workspaceCount = leases.filter((lease) => lease.workspaceId === input.workspaceId).length;
          if (workspaceCount >= input.maxConcurrentForWorkspace || leases.length >= input.maxConcurrentTotal) {
            throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "工作区、provider 或租户并发硬上限已满。");
          }
          document.leases[leaseId] = {
            workspaceId: input.workspaceId,
            expiresAtMs: input.leaseExpiresAtMs,
          };
          return { inFlightForWorkspaceBefore: workspaceCount, inFlightTotalBefore: leases.length };
        });
        let released = false;
        return {
          ...admissionCounts,
          consumeAssessmentRequest: async ({ nowMs, maxRequestsPerMinute }) => {
            await this.mutateAdmission((document) => {
              document.assessmentRequestTimesMs = document.assessmentRequestTimesMs
                .filter((time) => Number.isSafeInteger(time) && time > nowMs - 60_000 && time <= nowMs);
              if (!document.leases[leaseId]) {
                throw new FancyHubError("AI_RUNTIME_COORDINATOR_UNAVAILABLE", "AI 准入租约已失效，禁止继续出网。");
              }
              if (document.assessmentRequestTimesMs.length >= maxRequestsPerMinute) {
                throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "provider 或租户速率硬上限已满。");
              }
              document.assessmentRequestTimesMs.push(nowMs);
            });
          },
          release: async () => {
            if (released) return;
            released = true;
            await this.mutateAdmission((document) => { delete document.leases[leaseId]; });
          },
        };
      },
    };
  }

  async initialize(): Promise<void> {
    await mkdir(this.assessmentsDir, { recursive: true, mode: 0o700 });
    const probe = path.join(this.config.dataDir, `.write-probe-${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      const handle = await open(probe, "wx", 0o600);
      await handle.writeFile("ready\n", "utf8");
      await handle.close();
    } finally {
      await unlink(probe).catch(() => undefined);
    }
  }

  async appendAuditEvent(event: FancyHubAuditEvent | AIRetentionAuditEvent): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const release = await acquireLock(this.auditFile);
    try {
      await appendFile(this.auditFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    } finally {
      await release();
    }
  }

  async saveAssessment(record: AIAssessmentRetentionRecord): Promise<void> {
    const assessmentId = record.metadata?.assessmentId;
    if (!assessmentId) {
      throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存记录缺少安全 assessmentId。");
    }
    await this.mutateAssessment(assessmentId, (current) => {
      if (current) {
        throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存记录 ID 重复。");
      }
      return { record: structuredClone(record), result: undefined };
    });
  }

  async readAssessmentForActor(input: {
    assessmentId: string;
    actorStableId: string;
    includeHidden?: boolean;
  }): Promise<AIAssessmentRetentionRecord | undefined> {
    const record = await this.readAssessmentFile(this.assessmentTarget(input.assessmentId));
    if (!record || record.metadata?.actorStableId !== input.actorStableId) return undefined;
    if (!input.includeHidden) {
      try {
        assertAIAssessmentVisible(record);
      } catch {
        return undefined;
      }
    }
    return this.publicAssessmentRecord(record);
  }

  async requestAssessmentDeletion(input: {
    assessmentId: string;
    actorStableId: string;
    now?: Date;
  }): Promise<AIAssessmentRetentionRecord | undefined> {
    const now = input.now ?? new Date();
    const transaction = await this.mutateAssessmentWithAudit(input.assessmentId, (record) => {
      if (!record || record.metadata?.actorStableId !== input.actorStableId) {
        return { result: undefined };
      }
      if (record.deletionTombstone) {
        return { record, result: this.publicAssessmentRecord(record) };
      }
      const deleted = requestAIAssessmentDeletion({ record, requestedBy: input.actorStableId, now });
      return {
        record: deleted.record,
        result: this.publicAssessmentRecord(deleted.record),
        auditEvents: deleted.auditEvents.map((event) => ({
          ...event,
          assessmentId: input.assessmentId,
          actorStableId: input.actorStableId,
          resultCode: "SUCCESS",
        })),
      };
    });
    return transaction.result;
  }

  async sweepRetention(input: {
    now?: Date;
    backupAdapter: AIBackupPurgeAdapter;
  }): Promise<AIRetentionSweepSummary> {
    const now = input.now ?? new Date();
    await mkdir(this.assessmentsDir, { recursive: true, mode: 0o700 });
    const assessmentIds = (await readdir(this.assessmentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[A-Za-z0-9-]{1,128}\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
    const summary: AIRetentionSweepSummary = {
      recordsScanned: assessmentIds.length,
      recordsChanged: 0,
      auditEventsWritten: 0,
      backupPurgeFailures: 0,
    };
    for (const id of assessmentIds) {
      let actorStableId: string | undefined;
      let backupPurgeFailures = 0;
      const transaction = await this.mutateAssessmentWithAudit(id, async (record) => {
        if (!record) return { result: undefined };
        actorStableId = record.metadata?.actorStableId ?? record.deletionTombstone?.requestedBy;
        const before = JSON.stringify(record);
        let swept = sweepAIAssessmentRetention({ record, now });
        const events = [...swept.auditEvents];
        swept = await purgeAIAssessmentBackups({ record: swept.record, now, adapter: input.backupAdapter });
        events.push(...swept.auditEvents);
        if (JSON.stringify(swept.record) !== before) summary.recordsChanged += 1;
        backupPurgeFailures = events.filter((event) => event.action === "AI_BACKUP_PURGE_FAILED").length;
        return {
          record: swept.record,
          result: undefined,
          auditEvents: events.map((event) => ({
            ...event,
            assessmentId: id,
            actorStableId,
            resultCode: event.action === "AI_BACKUP_PURGE_FAILED" ? "FAILED" : "SUCCESS",
          })),
        };
      });
      summary.backupPurgeFailures += backupPurgeFailures;
      summary.auditEventsWritten += transaction.auditEventsWritten;
    }
    return summary;
  }

  successfulAssessmentRecord(input: {
    assessmentId: string;
    actorStableId: string;
    scopeStableRef: string;
    requestedAt: string;
    completedAt: string;
    requestEnvelope: AIRequestEnvelopeV1;
    canonicalRequestJson: string;
    inputHash: string;
    response: FancyHubAssessmentResponse;
    prompt: string;
    requestAliasMapping: Array<{
      alias: RequestAlias;
      reference: LocalAliasReferenceV1;
    }>;
    rawAttempts: readonly FancyHubRawAssessmentAttempt[];
  }): AIAssessmentRetentionRecord {
    const rawContent = this.rawAssessmentContent({
      assessmentId: input.assessmentId,
      prompt: input.prompt,
      promptTemplateHash: input.requestEnvelope.promptTemplateHash,
      requestAliasMapping: input.requestAliasMapping,
      rawAttempts: input.rawAttempts,
    });
    const durationMs = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.requestedAt));
    return {
      policyVersion: AI_RETENTION_POLICY_VERSION,
      metadata: {
        assessmentId: input.assessmentId,
        actorStableId: input.actorStableId,
        scopeStableRef: input.scopeStableRef,
        modelDescriptor: structuredClone(input.response.model),
        promptTemplateVersion: input.requestEnvelope.promptTemplateVersion,
        promptTemplateHash: input.requestEnvelope.promptTemplateHash,
        schemaVersion: input.requestEnvelope.schemaVersion,
        allowlistPolicyVersion: AI_PROVIDER_POLICY_VERSION,
        inputHash: input.inputHash,
        outputHash: input.response.outputHash,
        requestedAt: input.requestedAt,
        completedAt: input.completedAt,
        durationMs,
        inputTokens: input.response.usage.inputTokens,
        outputTokens: input.response.usage.outputTokens,
        costMicroUsd: input.response.usage.costMicroUsd,
        resultCode: "SUCCESS",
        state: "ACTIVE",
      },
      encryptedRawContent: encryptAIRawContent({
        assessmentId: input.assessmentId,
        plaintext: rawContent,
        key: this.config.encryptionKey,
        keyVersion: this.config.encryptionKeyVersion,
      }),
      semanticContent: {
        findings: structuredClone(input.response.result.findings),
        recommendations: structuredClone(input.response.result.recommendations),
        assumptions: structuredClone(input.response.result.assumptions),
        uncoveredInformation: structuredClone(input.response.result.uncoveredInformation),
        evidenceRefs: structuredClone(input.requestEnvelope.evidenceRefs),
      },
      rawContentCreatedAt: input.completedAt,
      semanticContentCreatedAt: input.completedAt,
      operationLogCreatedAt: input.completedAt,
      operationLog: { action: "AI_FANCY_HUB_ASSESSMENT", objectHash: input.response.outputHash, resultCode: "SUCCESS" },
      visibility: "VISIBLE",
    };
  }

  failedAssessmentRecord(input: {
    assessmentId: string;
    actorStableId: string;
    scopeStableRef: string;
    requestedAt: string;
    completedAt: string;
    resultCode: string;
    prompt: string;
    requestAliasMapping: Array<{
      alias: RequestAlias;
      reference: LocalAliasReferenceV1;
    }>;
    rawAttempts: readonly FancyHubRawAssessmentAttempt[];
  }): AIAssessmentRetentionRecord {
    const lastAttempt = input.rawAttempts.at(-1);
    if (!lastAttempt) {
      throw new AIRuntimeStoreError(
        "AI_RETENTION_STORE_UNAVAILABLE",
        "没有实际 provider 调用的失败不能伪造原始响应留存记录。",
      );
    }
    const rawContent = this.rawAssessmentContent({
      assessmentId: input.assessmentId,
      prompt: input.prompt,
      promptTemplateHash: lastAttempt.requestEnvelope.promptTemplateHash,
      requestAliasMapping: input.requestAliasMapping,
      rawAttempts: input.rawAttempts,
    });
    const durationMs = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.requestedAt));
    return {
      policyVersion: AI_RETENTION_POLICY_VERSION,
      metadata: {
        assessmentId: input.assessmentId,
        actorStableId: input.actorStableId,
        scopeStableRef: input.scopeStableRef,
        modelDescriptor: structuredClone(lastAttempt.modelDescriptor),
        promptTemplateVersion: lastAttempt.requestEnvelope.promptTemplateVersion,
        promptTemplateHash: lastAttempt.requestEnvelope.promptTemplateHash,
        schemaVersion: lastAttempt.requestEnvelope.schemaVersion,
        allowlistPolicyVersion: AI_PROVIDER_POLICY_VERSION,
        inputHash: lastAttempt.inputHash,
        requestedAt: input.requestedAt,
        completedAt: input.completedAt,
        durationMs,
        resultCode: input.resultCode,
        state: "ACTIVE",
      },
      encryptedRawContent: encryptAIRawContent({
        assessmentId: input.assessmentId,
        plaintext: rawContent,
        key: this.config.encryptionKey,
        keyVersion: this.config.encryptionKeyVersion,
      }),
      rawContentCreatedAt: input.completedAt,
      operationLogCreatedAt: input.completedAt,
      operationLog: {
        action: "AI_FANCY_HUB_ASSESSMENT",
        resultCode: input.resultCode,
      },
      visibility: "VISIBLE",
    };
  }

  private rawAssessmentContent(input: {
    assessmentId: string;
    prompt: string;
    promptTemplateHash: string;
    requestAliasMapping: Array<{
      alias: RequestAlias;
      reference: LocalAliasReferenceV1;
    }>;
    rawAttempts: readonly FancyHubRawAssessmentAttempt[];
  }): string {
    if (promptTemplateHash(input.prompt) !== input.promptTemplateHash) {
      throw new AIRuntimeStoreError(
        "AI_RETENTION_STORE_UNAVAILABLE",
        "留存的完整 prompt 与实际 Envelope 中的模板 hash 不一致。",
      );
    }
    if (!input.rawAttempts.length) {
      throw new AIRuntimeStoreError(
        "AI_RETENTION_STORE_UNAVAILABLE",
        "实际 provider 调用缺少原始尝试记录。",
      );
    }
    const aliases = input.requestAliasMapping.map((entry) => entry.alias);
    if (aliases.some((alias) => !/^[a-z][0-9]{3,7}$/.test(alias)) || new Set(aliases).size !== aliases.length) {
      throw new AIRuntimeStoreError(
        "AI_RETENTION_STORE_UNAVAILABLE",
        "请求级别名映射无效。",
      );
    }
    const serialized = JSON.stringify({
      assessmentId: input.assessmentId,
      prompt: input.prompt,
      requestAliasMapping: structuredClone(input.requestAliasMapping),
      attempts: input.rawAttempts.map((attempt) => ({
        requestedAt: attempt.requestedAt,
        completedAt: attempt.completedAt,
        modelDescriptor: structuredClone(attempt.modelDescriptor),
        envelope: JSON.parse(attempt.canonicalRequestJson),
        inputHash: attempt.inputHash,
        resultCode: attempt.resultCode,
        ...(attempt.rawResponse === undefined ? {} : { rawModelResponse: attempt.rawResponse }),
      })),
    });
    if (serialized === undefined) {
      throw new AIRuntimeStoreError(
        "AI_RETENTION_STORE_UNAVAILABLE",
        "AI 原始调用材料无法序列化。",
      );
    }
    return serialized;
  }
}

export function createAIRuntimeStoreFromEnvironment(faultHooks: AIRuntimeStoreFaultHooks = {}): FileAIRuntimeStore {
  const config = aiRuntimeStoreConfigFromEnvironment();
  if (!config) throw new AIRuntimeStoreError("AI_RETENTION_CONFIG_INVALID", "AI 留存目录、32 字节加密密钥或密钥版本未配置。");
  return new FileAIRuntimeStore(config, faultHooks);
}
