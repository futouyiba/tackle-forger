import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ExportTargetProfile } from "./interaction-contracts";
import type { ConfigurationSnapshot } from "./types";
import { verifySnapshotIntegrity } from "./publishing";
import {
  materializeConfigExport,
  parseConfigTomlTables,
  type ConfigExportMapping,
  type ConfigExportMappingIssue,
} from "./config-export-mapping";
import {
  extractLogicalTablesFromWorkbook,
  stageWorkbookRows,
  type WorkbookCellChange,
} from "./config-export-workbook";
import {
  commitExportPackage,
  validateLogicalTableRelations,
  type ExportCommitAdapter,
  type ExportCommitResult,
  type ExportFileOperation,
} from "./config-export";
import {
  assertSnapshotItemPartEnabled,
  snapshotItemPartId,
} from "./enabled-item-parts";

export interface FilesystemExportOperation extends ExportFileOperation {
  sourceHash: string;
  stagedHash: string;
  changes: WorkbookCellChange[];
}

export interface FilesystemExportPreview {
  packageId: string;
  profileId: string;
  mappingId: string;
  mappingVersion: string;
  snapshotId: string;
  snapshotHash: string;
  itemPartId: string;
  status: "ready" | "blocked";
  projectRoot: string;
  workbookRoot: string;
  stagingRoot?: string;
  backupRoot?: string;
  operations: FilesystemExportOperation[];
  issues: ConfigExportMappingIssue[];
  createdAt: string;
}

function exportIssue(input: Omit<ConfigExportMappingIssue, "level" | "gate">): ConfigExportMappingIssue {
  return { level: "error", gate: "export", ...input };
}

function safeSegment(value: string, label: string) {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${label} 包含不允许的路径字符。`);
  }
  return value.replace(/:/g, "_");
}

function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveProfilePaths(profile: ExportTargetProfile) {
  if (!path.isAbsolute(profile.projectRoot)) {
    throw new Error("ExportTargetProfile.projectRoot 必须是执行端登记的绝对路径。");
  }
  if (path.isAbsolute(profile.relativeWorkbookRoot) || path.isAbsolute(profile.configTomlPath)) {
    throw new Error("Profile 只能提供相对 workbook/config 路径。");
  }
  const projectRoot = path.resolve(profile.projectRoot);
  const workbookRoot = path.resolve(projectRoot, profile.relativeWorkbookRoot);
  const configTomlPath = path.resolve(projectRoot, profile.configTomlPath);
  if (!within(projectRoot, workbookRoot) || !within(projectRoot, configTomlPath)) {
    throw new Error("Profile 路径越过允许的 projectRoot。 ");
  }
  const realProjectRoot = await realpath(projectRoot);
  const realWorkbookRoot = await realpath(workbookRoot);
  const realConfigToml = await realpath(configTomlPath);
  if (!within(realProjectRoot, realWorkbookRoot) || !within(realProjectRoot, realConfigToml)) {
    throw new Error("Profile 解析后路径越过允许目录，可能包含符号链接逃逸。 ");
  }
  return {
    projectRoot: realProjectRoot,
    workbookRoot: realWorkbookRoot,
    configTomlPath: realConfigToml,
  };
}

function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(filePath: string) {
  return hashBytes(await readFile(filePath));
}

function relationIssues(
  issues: ReturnType<typeof validateLogicalTableRelations>,
): ConfigExportMappingIssue[] {
  return issues.map((entry) => ({
    level: entry.level === "info" ? "warning" : entry.level,
    gate: "export" as const,
    code: entry.code,
    message: entry.message,
    logicalTable: undefined,
    workbook: entry.workbook,
    sheet: entry.sheet,
    field: entry.parameterKey,
    suggestion: "修复引用关系后重新生成暂存包。",
  }));
}

export async function previewFilesystemExport(input: {
  packageId: string;
  profile: ExportTargetProfile;
  mapping: ConfigExportMapping;
  snapshot: ConfigurationSnapshot;
  createdAt?: string;
}): Promise<FilesystemExportPreview> {
  assertSnapshotItemPartEnabled(input.snapshot, "config_export");
  const itemPartId = snapshotItemPartId(input.snapshot)!;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const initialIssues: ConfigExportMappingIssue[] = [];
  if (!input.profile.enabled) {
    initialIssues.push(exportIssue({
      code: "EXPORT_PROFILE_DISABLED",
      message: `导出目标 ${input.profile.profileId} 已停用。`,
    }));
  }
  if (
    input.profile.mappingId !== input.mapping.mappingId ||
    input.profile.mappingVersion !== input.mapping.version
  ) {
    initialIssues.push(exportIssue({
      code: "EXPORT_PROFILE_MAPPING_MISMATCH",
      message: "目标 Profile 绑定的映射 ID/版本与请求不一致。",
      suggestion: "重新载入服务端登记的 Profile 与已发布映射。",
    }));
  }
  if (!verifySnapshotIntegrity(input.snapshot)) {
    initialIssues.push(exportIssue({
      code: "EXPORT_SNAPSHOT_INTEGRITY_FAILED",
      message: "冻结 ConfigurationSnapshot 的内容哈希校验失败。",
    }));
  }

  let resolved: Awaited<ReturnType<typeof resolveProfilePaths>>;
  try {
    resolved = await resolveProfilePaths(input.profile);
  } catch (error) {
    initialIssues.push(exportIssue({
      code: "EXPORT_PROFILE_PATH_INVALID",
      message: error instanceof Error ? error.message : String(error),
    }));
    return {
      packageId: input.packageId,
      profileId: input.profile.profileId,
      mappingId: input.mapping.mappingId,
      mappingVersion: input.mapping.version,
      snapshotId: input.snapshot.id,
      snapshotHash: input.snapshot.contentHash,
      itemPartId,
      status: "blocked",
      projectRoot: input.profile.projectRoot,
      workbookRoot: input.profile.relativeWorkbookRoot,
      operations: [],
      issues: initialIssues,
      createdAt,
    };
  }

  const toml = await readFile(resolved.configTomlPath, "utf8");
  const compilerTables = parseConfigTomlTables(toml);
  const materialized = materializeConfigExport({
    snapshot: input.snapshot,
    mapping: input.mapping,
    compilerTables,
  });
  const issues = [...initialIssues, ...materialized.issues];
  const workbookNames = Array.from(new Set(
    Object.values(input.mapping.logicalTables).map((table) => table.workbook),
  )).sort();
  const staged = new Map<string, Uint8Array>();
  const pendingOperations: FilesystemExportOperation[] = [];

  for (const workbook of workbookNames) {
    const targetPath = path.resolve(resolved.workbookRoot, workbook);
    if (!within(resolved.workbookRoot, targetPath)) {
      issues.push(exportIssue({
        code: "EXPORT_WORKBOOK_PATH_ESCAPE",
        message: `${workbook} 越过目标 workbookRoot。`,
        workbook,
      }));
      continue;
    }
    let source: Uint8Array;
    try {
      source = await readFile(targetPath);
    } catch (error) {
      issues.push(exportIssue({
        code: "EXPORT_WORKBOOK_READ_FAILED",
        message: `${workbook} 读取失败：${error instanceof Error ? error.message : String(error)}`,
        workbook,
      }));
      continue;
    }
    const result = stageWorkbookRows({
      source,
      workbookName: workbook,
      mapping: input.mapping,
      rows: materialized.rows,
    });
    issues.push(...result.issues);
    if (result.status === "ready") {
      staged.set(workbook, result.output);
      pendingOperations.push({
        workbook,
        stagedPath: "",
        targetPath,
        expectedOriginalHash: hashBytes(source),
        sourceHash: hashBytes(source),
        stagedHash: hashBytes(result.output),
        changes: result.changes,
      });
    }
  }

  const logicalTables = [];
  for (const [workbook, bytes] of staged) {
    const extracted = extractLogicalTablesFromWorkbook({
      source: bytes,
      workbookName: workbook,
      mapping: input.mapping,
    });
    logicalTables.push(...extracted.tables);
    issues.push(...extracted.issues);
  }
  const managedFields = new Map<string, Set<string>>();
  for (const row of materialized.rows) {
    const fields = managedFields.get(row.logicalTable) ?? new Set<string>();
    Object.keys(row.values).forEach((field) => fields.add(field));
    managedFields.set(row.logicalTable, fields);
  }
  const relations = Object.values(compilerTables).flatMap((table) =>
    table.enums
      .filter((relation) => managedFields.get(table.logicalName)?.has(relation.field))
      .map((relation) => ({
        sourceLogicalTable: table.logicalName,
        field: relation.field,
        targetLogicalTables: relation.targetLogicalTables,
        referenceField: input.mapping.enumReferenceField,
        allowCommaSeparatedTargets: false,
      })),
  );
  issues.push(...relationIssues(validateLogicalTableRelations({
    tables: logicalTables,
    relations,
  })));

  if (issues.some((entry) => entry.level === "error")) {
    return {
      packageId: input.packageId,
      profileId: input.profile.profileId,
      mappingId: input.mapping.mappingId,
      mappingVersion: input.mapping.version,
      snapshotId: input.snapshot.id,
      snapshotHash: input.snapshot.contentHash,
      itemPartId,
      status: "blocked",
      projectRoot: resolved.projectRoot,
      workbookRoot: resolved.workbookRoot,
      operations: [],
      issues,
      createdAt,
    };
  }

  const stagingRoot = path.join(
    resolved.projectRoot,
    ".tackle-forger",
    "staging",
    safeSegment(input.packageId, "packageId"),
    safeSegment(input.profile.profileId, "profileId"),
  );
  const backupRoot = path.join(
    resolved.projectRoot,
    ".tackle-forger",
    "backups",
    safeSegment(input.packageId, "packageId"),
    safeSegment(input.profile.profileId, "profileId"),
  );
  await mkdir(stagingRoot, { recursive: true });
  const operations: FilesystemExportOperation[] = [];
  for (const operation of pendingOperations) {
    const stagedPath = path.join(stagingRoot, operation.workbook);
    await writeFile(stagedPath, staged.get(operation.workbook)!);
    operations.push({ ...operation, stagedPath });
  }
  const preview: FilesystemExportPreview = {
    packageId: input.packageId,
    profileId: input.profile.profileId,
    mappingId: input.mapping.mappingId,
    mappingVersion: input.mapping.version,
    snapshotId: input.snapshot.id,
    snapshotHash: input.snapshot.contentHash,
    itemPartId,
    status: "ready",
    projectRoot: resolved.projectRoot,
    workbookRoot: resolved.workbookRoot,
    stagingRoot,
    backupRoot,
    operations,
    issues,
    createdAt,
  };
  await writeFile(path.join(stagingRoot, "ExportManifest.json"), JSON.stringify(preview, null, 2));
  return preview;
}

async function atomicReplace(sourcePath: string, targetPath: string) {
  const token = randomUUID();
  const pending = `${targetPath}.tackle-forger-new-${token}`;
  const displaced = `${targetPath}.tackle-forger-old-${token}`;
  await copyFile(sourcePath, pending);
  await rename(targetPath, displaced);
  try {
    await rename(pending, targetPath);
    await rm(displaced, { force: true });
  } catch (error) {
    await rename(displaced, targetPath).catch(() => undefined);
    await rm(pending, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function commitFilesystemExport(input: {
  preview: FilesystemExportPreview;
  snapshot: ConfigurationSnapshot;
  profile: ExportTargetProfile;
  confirmationProfileId: string;
  idempotencyKey: string;
  canCommit: boolean;
  audit?: ExportCommitResult["audit"];
}): Promise<ExportCommitResult> {
  assertSnapshotItemPartEnabled(input.snapshot, "config_export");
  if (!verifySnapshotIntegrity(input.snapshot)) {
    throw new Error("冻结 ConfigurationSnapshot 的内容哈希校验失败。");
  }
  if (
    input.snapshot.id !== input.preview.snapshotId
    || input.snapshot.contentHash !== input.preview.snapshotHash
    || snapshotItemPartId(input.snapshot) !== input.preview.itemPartId
  ) {
    throw new Error("提交使用的冻结 Snapshot 与暂存 Manifest 不一致，必须重新预览。");
  }
  if (!input.canCommit) throw new Error("缺少 config.export.commit Capability。");
  if (input.preview.status !== "ready") throw new Error("暂存预览未通过，不能提交。");
  if (!input.profile.enabled || input.profile.profileId !== input.preview.profileId) {
    throw new Error("提交 Profile 未启用或与暂存目标不一致。");
  }
  if (
    input.profile.mappingId !== input.preview.mappingId
    || input.profile.mappingVersion !== input.preview.mappingVersion
  ) {
    throw new Error("提交 Profile 的已发布映射与暂存 Manifest 不一致。");
  }
  if (input.confirmationProfileId !== input.preview.profileId) {
    throw new Error("人工确认的 Profile 与暂存目标不一致。");
  }
  const resolved = await resolveProfilePaths(input.profile);
  const expectedStagingRoot = path.join(
    resolved.projectRoot,
    ".tackle-forger",
    "staging",
    safeSegment(input.preview.packageId, "packageId"),
    safeSegment(input.profile.profileId, "profileId"),
  );
  const expectedBackupRoot = path.join(
    resolved.projectRoot,
    ".tackle-forger",
    "backups",
    safeSegment(input.preview.packageId, "packageId"),
    safeSegment(input.profile.profileId, "profileId"),
  );
  if (
    input.preview.projectRoot !== resolved.projectRoot
    || input.preview.workbookRoot !== resolved.workbookRoot
    || input.preview.stagingRoot !== expectedStagingRoot
    || input.preview.backupRoot !== expectedBackupRoot
  ) {
    throw new Error("暂存 Manifest 的目录与执行端登记 Profile 不一致。");
  }
  for (const operation of input.preview.operations) {
    if (
      !within(resolved.workbookRoot, operation.targetPath)
      || !within(expectedStagingRoot, operation.stagedPath)
    ) {
      throw new Error("暂存 Manifest 中的文件路径越过允许目录。");
    }
  }
  const controlRoot = path.join(resolved.projectRoot, ".tackle-forger");
  const lockRoot = path.join(controlRoot, "locks");
  const backupRoot = expectedBackupRoot;
  const commitRoot = path.join(controlRoot, "commits");
  await mkdir(lockRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await mkdir(commitRoot, { recursive: true });
  const lockPath = path.join(lockRoot, `${safeSegment(input.preview.profileId, "profileId")}.lock`);
  const lock = await open(lockPath, "wx").catch(() => {
    throw new Error("目标 Profile 正被其他导出任务占用，请等待或由管理员检查锁文件。");
  });
  await lock.writeFile(JSON.stringify({
    packageId: input.preview.packageId,
    profileId: input.preview.profileId,
    createdAt: new Date().toISOString(),
  }));

  const recordPath = path.join(
    commitRoot,
    `${createHash("sha256").update(input.idempotencyKey).digest("hex")}.json`,
  );
  const backupByTarget = new Map<string, string>();
  const adapter: ExportCommitAdapter = {
    getCurrentHash: hashFile,
    async createBackup(targetPath) {
      const backupPath = path.join(backupRoot, path.basename(targetPath));
      await copyFile(targetPath, backupPath);
      backupByTarget.set(targetPath, backupPath);
      return backupPath;
    },
    async replaceFile(stagedPath, targetPath) {
      await atomicReplace(stagedPath, targetPath);
      return hashFile(targetPath);
    },
    async restoreBackup(backupPath, targetPath) {
      await atomicReplace(backupPath, targetPath);
    },
    async findCommittedResult() {
      try {
        return JSON.parse(await readFile(recordPath, "utf8")) as ExportCommitResult;
      } catch {
        return undefined;
      }
    },
    async recordCommittedResult(_key, result) {
      await writeFile(recordPath, JSON.stringify(result, null, 2), { flag: "wx" });
    },
  };

  try {
    return await commitExportPackage({
      profileId: input.preview.profileId,
      packageId: input.preview.packageId,
      snapshots: [input.snapshot],
      idempotencyKey: input.idempotencyKey,
      operations: input.preview.operations,
      adapter,
      audit: input.audit,
    });
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function readFilesystemExportCommitResult(input: {
  profile: ExportTargetProfile;
  idempotencyKey: string;
}): Promise<ExportCommitResult | undefined> {
  const resolved = await resolveProfilePaths(input.profile);
  const recordPath = path.join(
    resolved.projectRoot,
    ".tackle-forger",
    "commits",
    `${createHash("sha256").update(input.idempotencyKey).digest("hex")}.json`,
  );
  try {
    const result = JSON.parse(await readFile(recordPath, "utf8")) as ExportCommitResult;
    if (result.profileId !== input.profile.profileId) {
      throw new Error("幂等任务记录与登记 Profile 不一致。");
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
