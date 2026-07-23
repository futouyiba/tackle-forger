import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AI_RETENTION_POLICY_VERSION,
  encryptAIRawContent,
  type AIAssessmentRetentionRecord,
} from "./ai-retention";
import {
  AI_PROVIDER_POLICY_VERSION,
  jcsCanonicalize,
  type AIRequestEnvelopeV1,
} from "./ai-outbound";
import {
  FancyHubError,
  type AIProviderHardLimits,
  type FancyHubAdmissionCoordinator,
  type FancyHubAdmissionLease,
  type FancyHubAssessmentResponse,
  type FancyHubAuditEvent,
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

interface AIAdmissionDocument {
  version: 1;
  leases: Record<string, { workspaceId: string; expiresAtMs: number }>;
  assessmentRequestTimesMs: number[];
  providerHardLimits?: AIProviderHardLimits;
}

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

  constructor(private readonly config: AIRuntimeStoreConfig) {
    this.assessmentsDir = path.join(config.dataDir, "assessments");
    this.auditFile = path.join(config.dataDir, "audit.jsonl");
    this.admissionFile = path.join(config.dataDir, "admission.json");
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

  async appendAuditEvent(event: FancyHubAuditEvent): Promise<void> {
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
    if (!assessmentId || !/^[A-Za-z0-9-]{1,128}$/.test(assessmentId)) {
      throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存记录缺少安全 assessmentId。");
    }
    await mkdir(this.assessmentsDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.assessmentsDir, `${assessmentId}.json`);
    const release = await acquireLock(target);
    try {
      try {
        await readFile(target, "utf8");
        throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 留存记录 ID 重复。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await release();
    }
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
  }): AIAssessmentRetentionRecord {
    const rawContent = jcsCanonicalize({
      request: JSON.parse(input.canonicalRequestJson),
      response: input.response,
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
}

export function createAIRuntimeStoreFromEnvironment(): FileAIRuntimeStore {
  const config = aiRuntimeStoreConfigFromEnvironment();
  if (!config) throw new AIRuntimeStoreError("AI_RETENTION_CONFIG_INVALID", "AI 留存目录、32 字节加密密钥或密钥版本未配置。");
  return new FileAIRuntimeStore(config);
}
