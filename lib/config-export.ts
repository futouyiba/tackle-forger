import { deterministicHash } from "./rule-kernel";
import { verifySnapshotIntegrity } from "./publishing";
import {
  assertPatchGateCanProceed,
  assertPatchRangeEvaluationIntegrity,
  assertPublishedPatchOffsetPolicy,
  PatchOffsetPolicyError,
} from "./patch-offset-policy";
import type { PatchRangeEvaluation } from "./patch-offset-policy";
import type {
  ConfigurationSnapshot,
  PatchOffsetPolicyVersion,
  PatchValidationWaiver,
  ValidationIssue,
  WorkspacePolicyRecord,
} from "./types";
import type { ExportTargetProfile } from "./interaction-contracts";
import type { ConfigExportMapping } from "./config-export-mapping";
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
  createdAt: string;
  manifestHash: string;
}

export function createExportManifest(input: {
  packageId: string;
  generatorVersion: string;
  mapping: ConfigExportMapping;
  profile: ExportTargetProfile;
  snapshot: ConfigurationSnapshot;
  originalFileHashes: Record<string, string>;
  entries: ExportManifestEntry[];
  createdAt: string;
  environmentId?: string;
  channelKey?: string;
  patchOffsetGovernance?: {
    policy?: WorkspacePolicyRecord | PatchOffsetPolicyVersion;
    rangeEvaluation: PatchRangeEvaluation;
    waivers?: PatchValidationWaiver[];
  };
}): ExportManifest {
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
  let frozenPatchGovernance: Pick<ExportManifest,
    "patchOffsetPolicyVersion" | "patchValidationIssueFingerprints" | "patchValidationWaiverRefs" | "patchValidationWaiverDecisionRefs"> = {};
  if (input.snapshot.patchOffsetPolicyVersion) {
    const governance = input.patchOffsetGovernance;
    if (
      !input.environmentId?.trim()
      || !input.channelKey?.trim()
      || !governance
      || governance.rangeEvaluation.gate !== "EXPORT"
      || governance.rangeEvaluation.policyVersion !== input.snapshot.patchOffsetPolicyVersion
      || governance.rangeEvaluation.environmentId !== input.environmentId
      || governance.rangeEvaluation.channelKey !== input.channelKey
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
      assertPatchRangeEvaluationIntegrity({
        evaluation: governance.rangeEvaluation,
        policy: governance.policy,
        expectedSubjectRef: {
          scopeType: "model",
          entityId: input.snapshot.modelId,
          revision: input.snapshot.modelRevision,
        },
        expectedPatchSetHash: input.snapshot.patchSetHash,
        expectedPatchReferences: input.snapshot.patchReferences,
      });
      assertPatchGateCanProceed({
        evaluation: governance.rangeEvaluation,
        waivers: governance.waivers,
      });
    } catch (error) {
      if (error instanceof PatchOffsetPolicyError) {
        throw new Error(`配置导出被阻止：[${error.code}] ${error.message}`);
      }
      throw error;
    }
    frozenPatchGovernance = {
      patchOffsetPolicyVersion: input.snapshot.patchOffsetPolicyVersion,
      patchValidationIssueFingerprints: governance.rangeEvaluation.issues
        .flatMap((issue) => issue.fingerprint ? [issue.fingerprint] : [])
        .sort(),
      patchValidationWaiverRefs: (governance.waivers ?? []).map((waiver) => waiver.waiverId).sort(),
      patchValidationWaiverDecisionRefs: [...new Set(
        (governance.waivers ?? []).map((waiver) => waiver.waiverDecisionId),
      )].sort(),
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

export interface ExportRelationIssue extends ValidationIssue {
  workbook?: string;
  sheet?: string;
  excelRow?: number;
  rawValue?: unknown;
  targetLogicalTables?: string[];
}

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
  stagedPath: string;
  targetPath: string;
  expectedOriginalHash: string;
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
  audit?: {
    workspaceId: string;
    userId: string;
    requestedAt: string;
  };
}

export async function commitExportPackage(input: {
  profileId: string;
  packageId: string;
  idempotencyKey: string;
  operations: ExportFileOperation[];
  adapter: ExportCommitAdapter;
  audit?: ExportCommitResult["audit"];
}): Promise<ExportCommitResult> {
  const previous = await input.adapter.findCommittedResult(input.idempotencyKey);
  if (previous) return structuredClone(previous);

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
      ...(input.audit ? { audit: input.audit } : {}),
    };
  }
}
