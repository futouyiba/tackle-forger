import { deterministicHash } from "./rule-kernel";
import { verifySnapshotIntegrity } from "./publishing";
import { authoritativeObjectIdentity, evaluateAuthoritativePatchFinalRanges, type AuthoritativePatchObject } from "./patch-authority";
import {
  assertPatchGateCanProceed,
  assertPatchValidationWaiverDecisionCoverage,
  assertPublishedPatchOffsetPolicy,
  PatchOffsetPolicyError,
} from "./patch-offset-policy";
import type {
  ConfigurationSnapshot,
  CanonicalValidationIssue,
  LegacyValidationIssue,
  PatchOffsetPolicyVersion,
  ParameterDefinition,
  PatchRevisionRecord,
  PatchValidationWaiver,
  PatchValidationWaiverDecision,
  RuleSetVersion,
  ValidationAcknowledgement,
  ValidationIssue,
  ValidationWaiver,
  ValidationWaiverDecision,
  WaiverPolicyVersion,
  WorkspacePolicyRecord,
} from "./types";
import type { ExportTargetProfile } from "./interaction-contracts";
import type { ConfigExportMapping } from "./config-export-mapping";
import { assertConfigExportSnapshotReplayable } from "./config-preview-package";
import {
  assertSnapshotItemPartEnabled,
} from "./enabled-item-parts";
import {
  canonicalizeValidationIssues,
  assertFrozenValidationIssuesMatch,
  assertValidationGateCanProceed,
  assertValidationWaiverDecisionCoverage,
} from "./validation-issues";
import {
  assertFormalConfigExportAllowed,
  assertFormalConfigExportStageEnabled,
  recoverVerifiedFormalConfigExportEvidence,
  type FormalConfigExportAuthorization,
  type FormalConfigExportContext,
  type FormalConfigExportEvidenceVerifier,
  type VerifiedFormalConfigExportEvidence,
} from "./config-export-stage";
import type { ReductionStackingPolicyVersion } from "./types";
export type { ConfigExportMapping } from "./config-export-mapping";


export interface ExportManifestEntry {
  logicalTable: string;
  workbook: string;
  sheet: string;
  businessKey: string;
  operation: "insert" | "update" | "skip";
  beforeHash?: string;
  afterHash?: string;
}

export interface ExportManifest {
  packageId: string;
  generatorVersion: string;
  mappingId: string;
  mappingVersion: string;
  profileId: string;
  environmentId?: string;
  channelKey?: string;
  sourceSnapshotId: string;
  sourceSnapshotHash: string;
  originalFileHashes: Record<string, string>;
  entries: ExportManifestEntry[];
  patchOffsetPolicyVersion?: string;
  patchValidationIssueFingerprints?: string[];
  patchValidationWaiverRefs?: string[];
  patchValidationWaiverDecisionRefs?: string[];
  validationIssueFingerprints?: string[];
  validationAcknowledgementRefs?: string[];
  validationWaiverRefs?: string[];
  validationWaiverDecisionRefs?: string[];
  createdAt: string;
  manifestHash: string;
}

export function createExportManifest(input: {
  packageId: string;
  generatorVersion: string;
  mapping: ConfigExportMapping;
  profile: ExportTargetProfile;
  snapshot: ConfigurationSnapshot;
  availableReductionPolicies: ReductionStackingPolicyVersion[];
  originalFileHashes: Record<string, string>;
  entries: ExportManifestEntry[];
  createdAt: string;
  environmentId?: string;
  channelKey?: string;
  patchOffsetGovernance?: {
    policy?: WorkspacePolicyRecord | PatchOffsetPolicyVersion;
    ruleSet: RuleSetVersion;
    parameterDefinitions: ParameterDefinition[];
    patchRevisions: PatchRevisionRecord[];
    waivers?: PatchValidationWaiver[];
    decisions?: PatchValidationWaiverDecision[];
  };
  validationGovernance?: {
    issues: CanonicalValidationIssue[];
    acknowledgements?: ValidationAcknowledgement[];
    waivers?: ValidationWaiver[];
    decisions?: ValidationWaiverDecision[];
    activeWaiverPolicies?: WaiverPolicyVersion[];
  };
}): ExportManifest {
  assertSnapshotItemPartEnabled(input.snapshot, "config_export");
  if (!verifySnapshotIntegrity(input.snapshot)) {
    throw new Error("ConfigurationSnapshot 完整性校验失败，不能生成配置表。");
  }
  if (!input.profile.enabled) {
    throw new Error("导出目标 Profile 已停用。");
  }
  const includesStore = input.entries.some((entry) =>
    entry.logicalTable === "store_buy" || entry.logicalTable === "goods_basic"
  );
  if (includesStore && (!input.snapshot.pricingPolicyVersion || !input.snapshot.automaticPricing?.formal)) {
    throw new Error("PricingPolicy 尚未形成可执行的已发布版本：请查看策略 Trace 中的精确缺参或执行语义问题；正式 Store 导出已阻断。");
  }
  assertConfigExportSnapshotReplayable(
    input.snapshot,
    input.availableReductionPolicies,
  );
  let frozenPatchGovernance: Pick<ExportManifest,
    "patchOffsetPolicyVersion" | "patchValidationIssueFingerprints" | "patchValidationWaiverRefs" | "patchValidationWaiverDecisionRefs"> = {};
  if (input.snapshot.patchOffsetPolicyVersion) {
    const governance = input.patchOffsetGovernance;
    let rangeEvaluation: ReturnType<typeof evaluateAuthoritativePatchFinalRanges>;
    if (
      !input.environmentId?.trim()
      || !input.channelKey?.trim()
      || !governance
    ) {
      throw new Error("正式导出缺少与 Snapshot 策略及目标环境×渠道精确匹配的 Patch 范围校验。");
    }
    try {
      assertPublishedPatchOffsetPolicy(governance.policy);
      if (governance.policy.version !== input.snapshot.patchOffsetPolicyVersion) {
        throw new PatchOffsetPolicyError(
          "PATCH_OFFSET_POLICY_VERSION_MISMATCH",
          "正式导出的 PatchOffsetPolicyVersion 与 Snapshot 不一致。",
        );
      }
      if (!input.snapshot.patchReferences?.length) {
        throw new PatchOffsetPolicyError(
          "PATCH_REVISION_EVIDENCE_MISSING",
          "正式导出的 Snapshot 缺少冻结的有序 Patch revision 引用。",
        );
      }
      const authority: AuthoritativePatchObject = {
        subjectRef: {
          scopeType: "model",
          entityId: input.snapshot.modelId,
          revision: input.snapshot.modelRevision,
        },
        ruleSet: governance.ruleSet,
        parameterDefinitions: governance.parameterDefinitions,
        patchRevisions: governance.patchRevisions,
        contexts: [{
          contextId: `${input.snapshot.modelId}:${input.snapshot.projectionId}:snapshot`,
          itemPartId: input.snapshot.projectionMatch.itemPartId,
          projection: {
            id: input.snapshot.projectionId,
            ruleSetVersion: input.snapshot.ruleSetVersion,
            sourceHash: input.snapshot.contentHash,
            values: input.snapshot.finalPanelValues,
          },
          finalPanelValues: input.snapshot.finalPanelValues,
          weightBandId: input.snapshot.projectionMatch.weightTemplateId,
          targetPullKg: input.snapshot.projectionMatch.targetPullKg,
        }],
      };
      rangeEvaluation = evaluateAuthoritativePatchFinalRanges({
        policy: governance.policy,
        gate: "EXPORT",
        environmentId: input.environmentId,
        channelKey: input.channelKey,
        objects: [authority],
      });
      const identity = authoritativeObjectIdentity(authority);
      if (
        identity.patchSetHash !== input.snapshot.patchSetHash
        || deterministicHash(identity.patchReferences) !== deterministicHash(input.snapshot.patchReferences)
      ) {
        throw new PatchOffsetPolicyError("PATCH_SET_HASH_MISMATCH", "导出命令派生的 Patch revision 引用与冻结 Snapshot 不一致。");
      }
      assertPatchGateCanProceed({
        evaluation: rangeEvaluation,
        waivers: governance.waivers,
      });
      assertPatchValidationWaiverDecisionCoverage({
        waivers: governance.waivers,
        decisions: governance.decisions,
      });
    } catch (error) {
      if (error instanceof PatchOffsetPolicyError) {
        throw new Error(`配置导出被阻止：[${error.code}] ${error.message}`);
      }
      throw error;
    }
    frozenPatchGovernance = {
      patchOffsetPolicyVersion: input.snapshot.patchOffsetPolicyVersion,
      patchValidationIssueFingerprints: rangeEvaluation.issues
        .flatMap((issue) => issue.fingerprint ? [issue.fingerprint] : [])
        .sort(),
      patchValidationWaiverRefs: (governance.waivers ?? []).map((waiver) => waiver.waiverId).sort(),
      patchValidationWaiverDecisionRefs: (governance.decisions ?? [])
        .map((decision) => decision.waiverDecisionId)
        .sort(),
    };
  }
  let frozenValidationGovernance: Pick<ExportManifest,
    "validationIssueFingerprints" | "validationAcknowledgementRefs"
    | "validationWaiverRefs" | "validationWaiverDecisionRefs"> = {};
  const frozenSnapshotValidationIssues = canonicalizeValidationIssues(
    input.snapshot.validationReport,
    {
      subjectRef: {
        workspaceId: "workspace:legacy",
        entityType: "model",
        entityId: input.snapshot.modelId,
        revisionId: String(input.snapshot.modelRevision),
      },
      inputHash: input.snapshot.contentHash,
      ruleRefs: [input.snapshot.ruleSetVersion],
      gate: "NONE",
      source: "import",
      mode: "active_gate",
    },
  );
  const frozenSnapshotExportIssues = frozenSnapshotValidationIssues.filter(
    (issue): issue is CanonicalValidationIssue =>
      issue.gate === "EXPORT"
      && issue.environmentId === input.environmentId
      && issue.channelKey === input.channelKey,
  );
  if (frozenSnapshotExportIssues.length && !input.validationGovernance) {
    throw new Error("Snapshot 含当前导出目标的统一 Issue，但导出命令缺少对应确认证据。");
  }
  if (input.validationGovernance) {
    assertValidationWaiverDecisionCoverage({
      waivers: input.validationGovernance.waivers,
      decisions: input.validationGovernance.decisions,
    });
    if (!input.environmentId?.trim() || !input.channelKey?.trim()) {
      throw new Error("统一 EXPORT 校验证据必须精确绑定 environmentId 与 channelKey。");
    }
    assertFrozenValidationIssuesMatch({
      frozenIssues: frozenSnapshotExportIssues,
      currentIssues: input.validationGovernance.issues,
      acknowledgements: input.validationGovernance.acknowledgements,
      waivers: input.validationGovernance.waivers,
      decisions: input.validationGovernance.decisions,
    });
    assertValidationGateCanProceed({
      issues: input.validationGovernance.issues,
      gate: "EXPORT",
      environmentId: input.environmentId,
      channelKey: input.channelKey,
      acknowledgements: input.validationGovernance.acknowledgements,
      waivers: input.validationGovernance.waivers,
      decisions: input.validationGovernance.decisions,
      activeWaiverPolicies: input.validationGovernance.activeWaiverPolicies,
      at: input.createdAt,
    });
    const relevantFingerprints = new Set(
      input.validationGovernance.issues
        .filter((issue) =>
          issue.gate === "EXPORT"
          && issue.environmentId === input.environmentId
          && issue.channelKey === input.channelKey)
        .map((issue) => issue.fingerprint),
    );
    const waivers = (input.validationGovernance.waivers ?? [])
      .filter((waiver) =>
        relevantFingerprints.has(waiver.issueFingerprint)
        && waiver.environmentId === input.environmentId
        && waiver.channelKey === input.channelKey);
    frozenValidationGovernance = {
      validationIssueFingerprints: [...relevantFingerprints].sort(),
      validationAcknowledgementRefs: (input.validationGovernance.acknowledgements ?? [])
        .filter((entry) => relevantFingerprints.has(entry.issueFingerprint))
        .map((entry) => entry.acknowledgementId)
        .sort(),
      validationWaiverRefs: waivers.map((entry) => entry.waiverId).sort(),
      validationWaiverDecisionRefs: (input.validationGovernance.decisions ?? [])
        .filter((decision) => waivers.some((waiver) =>
          waiver.waiverDecisionId === decision.waiverDecisionId
          && decision.waiverIds.includes(waiver.waiverId)))
        .map((decision) => decision.waiverDecisionId)
        .sort(),
    };
  }
  const content = {
    packageId: input.packageId,
    generatorVersion: input.generatorVersion,
    mappingId: input.mapping.mappingId,
    mappingVersion: input.mapping.version,
    profileId: input.profile.profileId,
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    ...(input.channelKey ? { channelKey: input.channelKey } : {}),
    sourceSnapshotId: input.snapshot.id,
    sourceSnapshotHash: input.snapshot.contentHash,
    originalFileHashes: structuredClone(input.originalFileHashes),
    entries: structuredClone(input.entries),
    ...frozenPatchGovernance,
    ...frozenValidationGovernance,
    createdAt: input.createdAt,
  };
  return { ...content, manifestHash: deterministicHash(content) };
}

export interface LogicalTableData {
  logicalName: string;
  workbook: string;
  sheet: string;
  keyField: string;
  rows: Array<{
    excelRow: number;
    values: Record<string, unknown>;
  }>;
}

export interface EnumRelationDefinition {
  sourceLogicalTable: string;
  field: string;
  targetLogicalTables: string[];
  referenceField?: "id" | "name";
  allowCommaSeparatedTargets: boolean;
}

export type ExportRelationIssue = LegacyValidationIssue & {
  workbook?: string;
  sheet?: string;
  excelRow?: number;
  rawValue?: unknown;
  targetLogicalTables?: string[];
};

export function validateLogicalTableRelations(input: {
  tables: LogicalTableData[];
  relations: EnumRelationDefinition[];
}): ExportRelationIssue[] {
  const issues: ExportRelationIssue[] = [];
  const tableByName = new Map(input.tables.map((table) => [table.logicalName, table]));

  for (const table of input.tables) {
    const seen = new Map<string, number>();
    for (const row of table.rows) {
      const rawKey = row.values[table.keyField];
      const key = rawKey === null || rawKey === undefined ? "" : String(rawKey).trim();
      if (!key) {
        issues.push({
          level: "error",
          code: "EXPORT_BUSINESS_KEY_EMPTY",
          message: `${table.logicalName} 的业务键不能为空。`,
          parameterKey: table.keyField,
          workbook: table.workbook,
          sheet: table.sheet,
          excelRow: row.excelRow,
          rawValue: rawKey,
        });
      } else if (seen.has(key)) {
        issues.push({
          level: "error",
          code: "EXPORT_BUSINESS_KEY_DUPLICATED",
          message: `${table.logicalName} 的业务键 ${key} 重复。`,
          parameterKey: table.keyField,
          workbook: table.workbook,
          sheet: table.sheet,
          excelRow: row.excelRow,
          rawValue: rawKey,
        });
      } else {
        seen.set(key, row.excelRow);
      }
    }
  }

  for (const relation of input.relations) {
    const source = tableByName.get(relation.sourceLogicalTable);
    if (!source) {
      issues.push({
        level: "error",
        code: "EXPORT_SOURCE_TABLE_MISSING",
        message: `缺少源逻辑表 ${relation.sourceLogicalTable}。`,
      });
      continue;
    }
    if (!relation.referenceField) {
      issues.push({
        level: "error",
        code: "ENUM_RESOLUTION_POLICY_MISSING",
        message: `${relation.sourceLogicalTable}.${relation.field} 未声明按 id 或 name 解析；系统不会猜测。`,
        workbook: source.workbook,
        sheet: source.sheet,
        parameterKey: relation.field,
      });
      continue;
    }
    const targetValues = new Set<string>();
    let targetMissing = false;
    for (const targetName of relation.targetLogicalTables) {
      const target = tableByName.get(targetName);
      if (!target) {
        targetMissing = true;
        issues.push({
          level: "error",
          code: "EXPORT_TARGET_TABLE_MISSING",
          message: `枚举关系目标逻辑表 ${targetName} 不存在。`,
          workbook: source.workbook,
          sheet: source.sheet,
          parameterKey: relation.field,
          targetLogicalTables: relation.targetLogicalTables,
        });
        continue;
      }
      for (const row of target.rows) {
        const value = row.values[relation.referenceField];
        if (value !== null && value !== undefined && String(value).trim()) {
          targetValues.add(String(value).trim());
        }
      }
    }
    if (targetMissing) continue;
    for (const row of source.rows) {
      const rawValue = row.values[relation.field];
      if (rawValue === null || rawValue === undefined || rawValue === "") continue;
      const values = relation.allowCommaSeparatedTargets
        ? String(rawValue).split(",").map((value) => value.trim()).filter(Boolean)
        : [String(rawValue).trim()];
      for (const value of values) {
        if (!targetValues.has(value)) {
          issues.push({
            level: "error",
            code: "EXPORT_ENUM_REFERENCE_BROKEN",
            message: `${relation.sourceLogicalTable}.${relation.field} 的值 ${value} 无法解析到允许目标表。`,
            parameterKey: relation.field,
            workbook: source.workbook,
            sheet: source.sheet,
            excelRow: row.excelRow,
            rawValue,
            targetLogicalTables: relation.targetLogicalTables,
          });
        }
      }
    }
  }
  return issues;
}

export interface ExportFileOperation {
  workbook: string;
  targetRef: string;
  stagedPath: string;
  targetPath: string;
  expectedOriginalHash: string;
  stagedHash: string;
}

export interface ExportCommitAdapter {
  getCurrentHash(targetPath: string): Promise<string>;
  createBackup(targetPath: string): Promise<string>;
  replaceFile(stagedPath: string, targetPath: string): Promise<string>;
  restoreBackup(backupPath: string, targetPath: string): Promise<void>;
  findCommittedResult(idempotencyKey: string): Promise<ExportCommitResult | undefined>;
  recordCommittedResult(idempotencyKey: string, result: ExportCommitResult): Promise<void>;
}

export interface ExportCommitResult {
  profileId: string;
  packageId: string;
  status: "committed" | "conflict" | "failed";
  replacedWorkbooks: string[];
  rolledBackWorkbooks: string[];
  newHashes: Record<string, string>;
  issues: ValidationIssue[];
  formalEvidence: VerifiedFormalConfigExportEvidence;
  audit?: {
    workspaceId: string;
    userId: string;
    requestedAt: string;
  };
}

export async function commitExportPackage(input: {
  profileId: string;
  packageId: string;
  snapshots: ConfigurationSnapshot[];
  availableReductionPolicies: ReductionStackingPolicyVersion[];
  idempotencyKey: string;
  operations: ExportFileOperation[];
  adapter: ExportCommitAdapter;
  formalAuthorization?: FormalConfigExportAuthorization;
  formalAuthorizationVerifier?: FormalConfigExportEvidenceVerifier;
  formalTargetContext: Pick<
    FormalConfigExportContext,
    "environmentId" | "channelKey" | "mappingId" | "mappingVersion"
  >;
  audit?: ExportCommitResult["audit"];
}): Promise<ExportCommitResult> {
  const formalExportContext: FormalConfigExportContext = {
    packageId: input.packageId,
    profileId: input.profileId,
    ...input.formalTargetContext,
    snapshots: input.snapshots.map((snapshot) => ({
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contentHash,
    })),
    operations: input.operations.map((operation) => ({
      workbook: operation.workbook,
      targetRef: operation.targetRef,
      expectedOriginalHash: operation.expectedOriginalHash,
      stagedHash: operation.stagedHash,
    })),
  };
  assertFormalConfigExportStageEnabled();
  if (!input.snapshots.length) throw new Error("导出提交缺少冻结 ConfigurationSnapshot。");
  for (const snapshot of input.snapshots) {
    assertConfigExportSnapshotReplayable(snapshot, input.availableReductionPolicies);
  }
  const previous = await input.adapter.findCommittedResult(input.idempotencyKey);
  if (previous) {
    if (
      previous.status !== "committed"
      || previous.packageId !== input.packageId
      || previous.profileId !== input.profileId
    ) {
      throw new Error("幂等记录不是当前包与 Profile 的已提交结果，拒绝恢复。");
    }
    recoverVerifiedFormalConfigExportEvidence({
      authorization: input.formalAuthorization,
      context: formalExportContext,
      evidence: previous.formalEvidence,
    });
    return structuredClone(previous);
  }
  const formalEvidence = await assertFormalConfigExportAllowed(
    input.formalAuthorization,
    input.formalAuthorizationVerifier,
    formalExportContext,
  );

  const conflictIssues: ValidationIssue[] = [];
  for (const operation of input.operations) {
    const currentHash = await input.adapter.getCurrentHash(operation.targetPath);
    if (currentHash !== operation.expectedOriginalHash) {
      conflictIssues.push({
        level: "error",
        code: "EXPORT_SOURCE_CONFLICT",
        message: `${operation.workbook} 在预览后已变化，未覆盖正式文件。`,
        parameterKey: operation.workbook,
      });
    }
  }
  if (conflictIssues.length) {
    return {
      profileId: input.profileId,
      packageId: input.packageId,
      status: "conflict",
      replacedWorkbooks: [],
      rolledBackWorkbooks: [],
      newHashes: {},
      issues: conflictIssues,
      formalEvidence,
      ...(input.audit ? { audit: input.audit } : {}),
    };
  }

  const backups = new Map<string, string>();
  for (const operation of input.operations) {
    backups.set(
      operation.targetPath,
      await input.adapter.createBackup(operation.targetPath),
    );
  }

  const replaced: ExportFileOperation[] = [];
  const newHashes: Record<string, string> = {};
  try {
    for (const operation of input.operations) {
      newHashes[operation.workbook] = await input.adapter.replaceFile(
        operation.stagedPath,
        operation.targetPath,
      );
      replaced.push(operation);
    }
    const result: ExportCommitResult = {
      profileId: input.profileId,
      packageId: input.packageId,
      status: "committed",
      replacedWorkbooks: replaced.map((operation) => operation.workbook),
      rolledBackWorkbooks: [],
      newHashes,
      issues: [],
      formalEvidence,
      ...(input.audit ? { audit: input.audit } : {}),
    };
    await input.adapter.recordCommittedResult(input.idempotencyKey, result);
    return result;
  } catch (error) {
    const rolledBack: string[] = [];
    const rollbackIssues: ValidationIssue[] = [];
    for (const operation of [...replaced].reverse()) {
      const backup = backups.get(operation.targetPath);
      if (!backup) continue;
      try {
        await input.adapter.restoreBackup(backup, operation.targetPath);
        rolledBack.push(operation.workbook);
      } catch (rollbackError) {
        rollbackIssues.push({
          level: "error",
          code: "EXPORT_ROLLBACK_FAILED",
          message: `${operation.workbook} 回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          parameterKey: operation.workbook,
        });
      }
    }
    return {
      profileId: input.profileId,
      packageId: input.packageId,
      status: "failed",
      replacedWorkbooks: replaced.map((operation) => operation.workbook),
      rolledBackWorkbooks: rolledBack,
      newHashes,
      issues: [
        {
          level: "error",
          code: "EXPORT_REPLACE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
        ...rollbackIssues,
      ],
      formalEvidence,
      ...(input.audit ? { audit: input.audit } : {}),
    };
  }
}
