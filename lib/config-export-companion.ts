import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ConfigExportMapping, ConfigExportMappingIssue } from "./config-export-mapping";
import {
  commitFilesystemExport,
  previewFilesystemExport,
  readFilesystemExportCommitResult,
  type FilesystemExportPreview,
} from "./config-export-filesystem";
import type { ExportCommitResult } from "./config-export";
import type { ExportTargetProfile } from "./interaction-contracts";
import type {
  ConfigurationSnapshot,
  ReductionStackingPolicyVersion,
} from "./types";
import type {
  FormalConfigExportAuthorization,
  FormalConfigExportEvidenceVerifier,
} from "./config-export-stage";
import { ConfigExportStageError } from "./config-export-stage";

export type CompanionCapability = "config.export.preview" | "config.export.commit";
export interface CompanionPairingIdentity {
  workspaceId: string;
  userId: string;
}


export interface ConfigExportCompanionRegistry {
  version: 1;
  capabilities: CompanionCapability[];
  pairing: {
    workspaceId: string;
    allowedOpenIds: string[];
  };
  allowedOrigins?: string[];
  profiles: ExportTargetProfile[];
  mappings: ConfigExportMapping[];
  reductionStackingPolicyVersions: ReductionStackingPolicyVersion[];
}

export interface CompanionPreviewRequest {
  packageId: string;
  profileIds: string[];
  snapshot: ConfigurationSnapshot;
  formalAuthorization?: FormalConfigExportAuthorization;
}

export interface CompanionPreviewEntry {
  profileId: string;
  label: string;
  status: "ready" | "blocked";
  files: Array<{
    workbook: string;
    changeCount: number;
    sourceHash: string;
    stagedHash: string;
    changes: FilesystemExportPreview["operations"][number]["changes"];
  }>;
  backupRoot?: string;
  issues: ConfigExportMappingIssue[];
}

export interface CompanionPreviewResponse {
  previewToken: string;
  packageId: string;
  expiresAt: string;
  results: CompanionPreviewEntry[];
}

export interface CompanionCommitRequest {
  previewToken: string;
  confirmations: Record<string, string>;
  formalAuthorization?: FormalConfigExportAuthorization;
}

export interface CompanionCommitResponse {
  packageId: string;
  results: ExportCommitResult[];
}

export interface CompanionStatusRequest {
  packageId: string;
  profileIds: string[];
}

export interface CompanionStatusResponse {
  packageId: string;
  results: Array<
    { profileId: string; status: "unknown" } | ExportCommitResult
  >;
}

interface StoredPreview {
  packageId: string;
  expiresAtMs: number;
  previews: Map<string, FilesystemExportPreview>;
  snapshot: ConfigurationSnapshot;
  identity: CompanionPairingIdentity;
}

function equalSecret(expected: string, received: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function registryIssue(message: string): never {
  throw new Error(`伴随服务注册表无效：${message}`);
}

export function validateCompanionRegistry(
  registry: ConfigExportCompanionRegistry,
): ConfigExportCompanionRegistry {
  if (registry.version !== 1) registryIssue("version 必须为 1。");
  if (!Array.isArray(registry.capabilities)) registryIssue("capabilities 必须是数组。");
  if (!Array.isArray(registry.reductionStackingPolicyVersions)) {
    registryIssue("reductionStackingPolicyVersions 必须是数组。");
  }
  const permitted = new Set<CompanionCapability>([
    "config.export.preview",
    "config.export.commit",
  ]);
  if (registry.capabilities.some((capability) => !permitted.has(capability))) {
    registryIssue("包含未知 Capability。");
  }
  if (!registry.pairing?.workspaceId?.trim()) {
    registryIssue("pairing.workspaceId 不能为空。");
  }
  if (!Array.isArray(registry.pairing.allowedOpenIds) || !registry.pairing.allowedOpenIds.length) {
    registryIssue("pairing.allowedOpenIds 至少登记一个飞书 open_id。");
  }
  if (new Set(registry.pairing.allowedOpenIds).size !== registry.pairing.allowedOpenIds.length) {
    registryIssue("pairing.allowedOpenIds 不能重复。");
  }
  const profiles = new Map<string, ExportTargetProfile>();
  for (const profile of registry.profiles ?? []) {
    if (profiles.has(profile.profileId)) registryIssue(`Profile ${profile.profileId} 重复。`);
    if (profile.executorKind !== "local_companion") {
      registryIssue(`Profile ${profile.profileId} 不是 local_companion。`);
    }
    profiles.set(profile.profileId, profile);
  }
  const mappings = new Set<string>();
  for (const mapping of registry.mappings ?? []) {
    const key = `${mapping.mappingId}@${mapping.version}`;
    if (mappings.has(key)) registryIssue(`Mapping ${key} 重复。`);
    mappings.add(key);
  }
  for (const profile of profiles.values()) {
    if (!profile.enabled) continue;
    if (!profile.mappingId || !profile.mappingVersion) {
      registryIssue(`已启用 Profile ${profile.profileId} 未绑定映射版本。`);
    }
    if (!mappings.has(`${profile.mappingId}@${profile.mappingVersion}`)) {
      registryIssue(`Profile ${profile.profileId} 的映射未登记。`);
    }
  }
  return structuredClone(registry);
}

export async function loadCompanionRegistry(
  registryPath: string,
): Promise<ConfigExportCompanionRegistry> {
  const parsed = JSON.parse(await readFile(registryPath, "utf8")) as ConfigExportCompanionRegistry;
  return validateCompanionRegistry(parsed);
}

export class ConfigExportCompanionController {
  readonly registry: ConfigExportCompanionRegistry;
  private readonly token: string;
  private readonly formalAuthorizationVerifier?: FormalConfigExportEvidenceVerifier;
  private readonly previews = new Map<string, StoredPreview>();

  constructor(input: {
    registry: ConfigExportCompanionRegistry;
    token: string;
    formalAuthorizationVerifier?: FormalConfigExportEvidenceVerifier;
  }) {
    if (input.token.length < 16) throw new Error("配对令牌至少需要 16 个字符。");
    this.registry = validateCompanionRegistry(input.registry);
    this.token = input.token;
    this.formalAuthorizationVerifier = input.formalAuthorizationVerifier;
  }

  authorize(token: string | undefined, identity: CompanionPairingIdentity) {
    if (!token || !equalSecret(this.token, token)) throw new Error("本地助手配对令牌无效。");
    if (
      identity.workspaceId !== this.registry.pairing.workspaceId
      || !this.registry.pairing.allowedOpenIds.includes(identity.userId)
    ) {
      throw new Error("当前飞书用户或工作区未与本地助手配对。");
    }
  }

  health(token: string | undefined, identity: CompanionPairingIdentity) {
    this.authorize(token, identity);
    return {
      status: "ready" as const,
      version: this.registry.version,
      pairing: structuredClone(identity),
      capabilities: [...this.registry.capabilities],
      profiles: this.registry.profiles.map((profile) => ({
        profileId: profile.profileId,
        label: profile.label,
        enabled: profile.enabled,
        mappingId: profile.mappingId,
        mappingVersion: profile.mappingVersion,
      })),
    };
  }

  async preview(
    token: string | undefined,
    identity: CompanionPairingIdentity,
    request: CompanionPreviewRequest,
  ): Promise<CompanionPreviewResponse> {
    this.authorize(token, identity);
    if (!this.registry.capabilities.includes("config.export.preview")) {
      throw new Error("伴随服务未授予 config.export.preview Capability。");
    }
    if (!this.registry.capabilities.includes("config.export.commit")) {
      throw new ConfigExportStageError(
        "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
        "本地助手缺少 config.export.commit，只能使用服务端 NON_FORMAL 预览。",
      );
    }
    if (!request.profileIds.length) throw new Error("至少选择一个目标 Profile。");
    const profileIds = [...new Set(request.profileIds)];
    const stored = new Map<string, FilesystemExportPreview>();
    const results: CompanionPreviewEntry[] = [];

    for (const profileId of profileIds) {
      const profile = this.registry.profiles.find((entry) => entry.profileId === profileId);
      if (!profile) throw new Error(`Profile ${profileId} 未在伴随服务登记。`);
      if (!profile.enabled) throw new Error(`Profile ${profileId} 已停用。`);
      const mapping = this.registry.mappings.find(
        (entry) => entry.mappingId === profile.mappingId && entry.version === profile.mappingVersion,
      );
      if (!mapping) throw new Error(`Profile ${profileId} 的已发布映射不存在。`);
      const preview = await previewFilesystemExport({
        packageId: request.packageId,
        profile,
        mapping,
        snapshot: request.snapshot,
        availableReductionPolicies: this.registry.reductionStackingPolicyVersions,
        canCommit: true,
        formalAuthorization: request.formalAuthorization,
        formalAuthorizationVerifier: this.formalAuthorizationVerifier,
      });
      stored.set(profileId, preview);
      results.push({
        profileId,
        label: profile.label,
        status: preview.status,
        files: preview.operations.map((operation) => ({
          workbook: operation.workbook,
          changeCount: operation.changes.length,
          sourceHash: operation.sourceHash,
          stagedHash: operation.stagedHash,
          changes: structuredClone(operation.changes),
        })),
        backupRoot: preview.backupRoot,
        issues: structuredClone(preview.issues),
      });
    }

    const previewToken = randomUUID();
    const expiresAtMs = Date.now() + 30 * 60 * 1000;
    this.previews.set(previewToken, {
      packageId: request.packageId,
      expiresAtMs,
      previews: stored,
      snapshot: structuredClone(request.snapshot),
      identity: structuredClone(identity),
    });
    return {
      previewToken,
      packageId: request.packageId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      results,
    };
  }

  async commit(
    token: string | undefined,
    identity: CompanionPairingIdentity,
    request: CompanionCommitRequest,
  ): Promise<CompanionCommitResponse> {
    this.authorize(token, identity);
    if (!this.registry.capabilities.includes("config.export.commit")) {
      throw new Error("伴随服务未授予 config.export.commit Capability。");
    }
    const stored = this.previews.get(request.previewToken);
    if (!stored) throw new Error("暂存预览不存在或伴随服务已重启，请重新生成预览。");
    if (
      stored.identity.workspaceId !== identity.workspaceId
      || stored.identity.userId !== identity.userId
    ) {
      throw new Error("暂存预览与当前飞书配对身份不一致。");
    }
    if (stored.expiresAtMs < Date.now()) {
      this.previews.delete(request.previewToken);
      throw new Error("暂存预览已过期，请重新生成预览。");
    }
    const results: ExportCommitResult[] = [];
    for (const [profileId, preview] of stored.previews) {
      if (preview.status !== "ready") continue;
      if (request.confirmations[profileId] !== profileId) {
        throw new Error(`必须完整输入 ${profileId} 才能提交该目标。`);
      }
      const profile = this.registry.profiles.find((entry) => entry.profileId === profileId);
      if (!profile) throw new Error(`Profile ${profileId} 未在伴随服务登记。`);
      results.push(await commitFilesystemExport({
        preview,
        snapshot: stored.snapshot,
        availableReductionPolicies: this.registry.reductionStackingPolicyVersions,
        profile,
        confirmationProfileId: request.confirmations[profileId],
        idempotencyKey: `commit:${stored.packageId}:${profileId}`,
        audit: {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          requestedAt: new Date().toISOString(),
        },
        canCommit: true,
        formalAuthorization: request.formalAuthorization,
        formalAuthorizationVerifier: this.formalAuthorizationVerifier,
      }));
    }
    return { packageId: stored.packageId, results };
  }

  async status(
    token: string | undefined,
    identity: CompanionPairingIdentity,
    request: CompanionStatusRequest,
  ): Promise<CompanionStatusResponse> {
    this.authorize(token, identity);
    if (!request.profileIds.length) throw new Error("至少选择一个目标 Profile。");
    const profileIds = [...new Set(request.profileIds)];
    const results: CompanionStatusResponse["results"] = [];
    for (const profileId of profileIds) {
      const profile = this.registry.profiles.find((entry) => entry.profileId === profileId);
      if (!profile) throw new Error(`Profile ${profileId} 未在伴随服务登记。`);
      const result = await readFilesystemExportCommitResult({
        profile,
        idempotencyKey: `commit:${request.packageId}:${profileId}`,
      });
      results.push(result ?? { profileId, status: "unknown" });
    }
    return { packageId: request.packageId, results };
}
}
