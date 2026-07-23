export type BrowserDirectoryPermissionState =
  | "bound_granted"
  | "bound_needs_permission"
  | "unbound"
  | "invalid";

export interface LocalExportTargetBinding {
  bindingId: string;
  environmentId: string;
  channelKey: string;
  targetKind: "DEFAULT_1001" | "EXPLICIT_CHANNEL_DIRECTORY";
  directoryHandleStorageKey: string;
  userLabel: string;
  mappingId: string;
  mappingVersion: string;
}

export interface BrowserDirectoryBindingStatus {
  binding: LocalExportTargetBinding;
  permissionState: BrowserDirectoryPermissionState;
  directoryName?: string;
  reason?: string;
}

export interface BrowserExportFileOperation {
  relativePath: string;
  sourceHash: string;
  stagedHash: string;
  stagedBytes: Uint8Array;
}

export interface BrowserExportPreviewOperation extends BrowserExportFileOperation {
  workbook: string;
  changes: WorkbookCellChange[];
}

export interface BrowserExportPreview {
  packageId: string;
  bindingId: string;
  environmentId: string;
  channelKey: string;
  mappingId: string;
  mappingVersion: string;
  snapshotIds: string[];
  snapshotHashes: Record<string, string>;
  itemPartIds: string[];
  status: "ready" | "blocked";
  operations: BrowserExportPreviewOperation[];
  issues: ConfigExportMappingIssue[];
  createdAt: string;
}

export interface BrowserRecoveryManifest {
  packageId: string;
  bindingId: string;
  itemPartIds: string[];
  createdAt: string;
  operations: Array<{
    relativePath: string;
    sourceHash: string;
    stagedHash: string;
    backupPath?: string;
    state: "pending" | "written" | "verified" | "restored";
  }>;
}

type PermissionMode = "read" | "readwrite";
type PermissionState = "granted" | "denied" | "prompt";

interface FileSystemPermissionDescriptor {
  mode?: PermissionMode;
}

export interface BrowserFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: BufferSource | Blob | string): Promise<void>;
    close(): Promise<void>;
  }>;
}

export interface BrowserDirectoryHandle {
  kind: "directory";
  name: string;
  queryPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: PermissionMode; id?: string }) => Promise<BrowserDirectoryHandle>;
  }
}

const DATABASE_NAME = "tackle-forger-local-bindings";
const STORE_NAME = "directory-handles";
const DATABASE_VERSION = 1;

function openBindingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地目录绑定数据库。"));
  });
}

export async function saveDirectoryHandle(
  storageKey: string,
  handle: BrowserDirectoryHandle,
): Promise<void> {
  const database = await openBindingDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(handle, storageKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存目录绑定失败。"));
    });
  } finally {
    database.close();
  }
}

export async function loadDirectoryHandle(
  storageKey: string,
): Promise<BrowserDirectoryHandle | undefined> {
  const database = await openBindingDatabase();
  try {
    return await new Promise<BrowserDirectoryHandle | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(storageKey);
      request.onsuccess = () => resolve(request.result as BrowserDirectoryHandle | undefined);
      request.onerror = () => reject(request.error ?? new Error("读取目录绑定失败。"));
    });
  } finally {
    database.close();
  }
}

export function browserDirectoryPickerAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function chooseAndSaveDirectory(
  binding: LocalExportTargetBinding,
): Promise<BrowserDirectoryBindingStatus> {
  if (!browserDirectoryPickerAvailable()) {
    return {
      binding,
      permissionState: "invalid",
      reason: "当前浏览器不支持 File System Access API；请下载变更包人工搬运。",
    };
  }
  const handle = await window.showDirectoryPicker!({
    mode: "readwrite",
    id: binding.directoryHandleStorageKey,
  });
  await saveDirectoryHandle(binding.directoryHandleStorageKey, handle);
  const permission = await handle.queryPermission({ mode: "readwrite" });
  return {
    binding,
    directoryName: handle.name,
    permissionState: permission === "granted" ? "bound_granted" : "bound_needs_permission",
  };
}

export async function inspectDirectoryBinding(
  binding: LocalExportTargetBinding,
): Promise<BrowserDirectoryBindingStatus> {
  try {
    const handle = await loadDirectoryHandle(binding.directoryHandleStorageKey);
    if (!handle) return { binding, permissionState: "unbound" };
    const permission = await handle.queryPermission({ mode: "readwrite" });
    return {
      binding,
      directoryName: handle.name,
      permissionState: permission === "granted" ? "bound_granted" : "bound_needs_permission",
    };
  } catch (error) {
    return {
      binding,
      permissionState: "invalid",
      reason: error instanceof Error ? error.message : "目录绑定已失效。",
    };
  }
}

export async function requestDirectoryWritePermission(
  binding: LocalExportTargetBinding,
): Promise<BrowserDirectoryBindingStatus> {
  const handle = await loadDirectoryHandle(binding.directoryHandleStorageKey);
  if (!handle) return { binding, permissionState: "unbound" };
  const permission = await handle.requestPermission({ mode: "readwrite" });
  return {
    binding,
    directoryName: handle.name,
    permissionState: permission === "granted" ? "bound_granted" : "bound_needs_permission",
    reason: permission === "granted" ? undefined : "用户尚未授予目录读写权限。",
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function exportIssue(input: Omit<ConfigExportMappingIssue, "level" | "gate">): ConfigExportMappingIssue {
  return { level: "error", gate: "export", ...input };
}

function asMappingIssues(
  issues: ReturnType<typeof validateLogicalTableRelations>,
): ConfigExportMappingIssue[] {
  return issues.map((entry) => ({
    level: entry.level === "info" ? "warning" : entry.level,
    gate: "export" as const,
    code: entry.code,
    message: entry.message,
    workbook: entry.workbook,
    sheet: entry.sheet,
    field: entry.parameterKey,
    suggestion: "修复引用关系后重新生成差异预览。",
  }));
}

async function readBytes(handle: BrowserFileHandle): Promise<Uint8Array> {
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeBytes(handle: BrowserFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

function splitPath(path: string): string[] {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`非法相对路径：${path}`);
  }
  return parts;
}

async function resolveParent(
  root: BrowserDirectoryHandle,
  relativePath: string,
  create: boolean,
): Promise<{ parent: BrowserDirectoryHandle; fileName: string }> {
  const parts = splitPath(relativePath);
  const fileName = parts.pop()!;
  let parent = root;
  for (const part of parts) {
    parent = await parent.getDirectoryHandle(part, { create });
  }
  return { parent, fileName };
}

async function getFile(
  root: BrowserDirectoryHandle,
  relativePath: string,
  create: boolean,
): Promise<BrowserFileHandle> {
  const { parent, fileName } = await resolveParent(root, relativePath, create);
  return parent.getFileHandle(fileName, { create });
}

async function readFileAt(root: BrowserDirectoryHandle, relativePath: string): Promise<Uint8Array> {
  return readBytes(await getFile(root, relativePath, false));
}

function workbookRelativePath(binding: LocalExportTargetBinding, workbook: string) {
  return binding.targetKind === "DEFAULT_1001" ? `xlsx/${workbook}` : workbook;
}

function rowIdentity(row: MaterializedConfigRow) {
  return [
    row.logicalTable,
    String(row.values[row.businessKeyField] ?? "").trim(),
    String(row.values[row.configNameKeyField] ?? "").trim(),
  ].join("|");
}

export async function previewBrowserExportFromHandles(input: {
  binding: LocalExportTargetBinding;
  targetRoot: BrowserDirectoryHandle;
  configRoot: BrowserDirectoryHandle;
  packageId: string;
  mapping: ConfigExportMapping;
  snapshots: ConfigurationSnapshot[];
  availableReductionPolicies: ReductionStackingPolicyVersion[];
  createdAt?: string;
}): Promise<BrowserExportPreview> {
  for (const snapshot of input.snapshots) {
    assertSnapshotItemPartEnabled(snapshot, "config_export");
    assertFormalSnapshotHasReplayPolicy(snapshot, input.availableReductionPolicies);
  }
  const itemPartIds = [...new Set(
    input.snapshots.map((snapshot) => snapshotItemPartId(snapshot)!),
  )].sort();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const issues: ConfigExportMappingIssue[] = [];
  const blocked = (): BrowserExportPreview => ({
    packageId: input.packageId,
    bindingId: input.binding.bindingId,
    environmentId: input.binding.environmentId,
    channelKey: input.binding.channelKey,
    mappingId: input.mapping.mappingId,
    mappingVersion: input.mapping.version,
    snapshotIds: input.snapshots.map((snapshot) => snapshot.id),
    snapshotHashes: Object.fromEntries(input.snapshots.map((snapshot) => [snapshot.id, snapshot.contentHash])),
    itemPartIds,
    status: "blocked",
    operations: [],
    issues,
    createdAt,
  });

  if (
    input.binding.mappingId !== input.mapping.mappingId
    || input.binding.mappingVersion !== input.mapping.version
  ) {
    issues.push(exportIssue({
      code: "EXPORT_BINDING_MAPPING_MISMATCH",
      message: `${input.binding.userLabel} 绑定的映射版本与预览请求不一致。`,
    }));
  }
  if (!input.snapshots.length) {
    issues.push(exportIssue({ code: "EXPORT_SNAPSHOTS_EMPTY", message: "导出批次没有可复用的冻结 Snapshot。" }));
  }
  for (const snapshot of input.snapshots) {
    if (!verifySnapshotIntegrity(snapshot)) {
      issues.push(exportIssue({
        code: "EXPORT_SNAPSHOT_INTEGRITY_FAILED",
        message: `冻结 Snapshot ${snapshot.id} 的内容哈希校验失败。`,
      }));
    }
  }

  let configToml = "";
  try {
    configToml = new TextDecoder().decode(await readFileAt(input.configRoot, "config.toml"));
  } catch (error) {
    issues.push(exportIssue({
      code: "EXPORT_CONFIG_TOML_READ_FAILED",
      message: `config.toml 读取失败：${error instanceof Error ? error.message : String(error)}`,
    }));
    return blocked();
  }
  const compilerTables = parseConfigTomlTables(configToml);
  const rows: MaterializedConfigRow[] = [];
  for (const snapshot of input.snapshots) {
    const materialized = materializeConfigExport({ snapshot, mapping: input.mapping, compilerTables });
    rows.push(...materialized.rows);
    issues.push(...materialized.issues);
  }
  const seenRows = new Set<string>();
  for (const row of rows) {
    const identity = rowIdentity(row);
    if (seenRows.has(identity)) {
      issues.push(exportIssue({
        code: "EXPORT_BATCH_IDENTITY_DUPLICATED",
        message: `批次内配置身份 ${identity} 重复。`,
        logicalTable: row.logicalTable,
      }));
    }
    seenRows.add(identity);
  }

  const requiredWorkbooks = ["tackle.xlsx", "item.xlsx", "store.xlsx"];
  const declaredWorkbooks = new Set(Object.values(input.mapping.logicalTables).map((table) => table.workbook));
  for (const workbook of requiredWorkbooks) {
    if (!declaredWorkbooks.has(workbook)) {
      issues.push(exportIssue({
        code: "EXPORT_REQUIRED_WORKBOOK_MAPPING_MISSING",
        message: `正式装备导出映射缺少 ${workbook}。`,
        workbook,
      }));
    }
  }

  const pending: BrowserExportPreviewOperation[] = [];
  const staged = new Map<string, Uint8Array>();
  for (const workbook of Array.from(declaredWorkbooks).sort()) {
    const relativePath = workbookRelativePath(input.binding, workbook);
    try {
      const source = await readFileAt(input.targetRoot, relativePath);
      const result = stageWorkbookRows({
        source,
        workbookName: workbook,
        mapping: input.mapping,
        rows,
      });
      issues.push(...result.issues);
      if (result.status === "ready") {
        staged.set(workbook, result.output);
        pending.push({
          workbook,
          relativePath,
          sourceHash: await sha256(source),
          stagedHash: await sha256(result.output),
          stagedBytes: result.output,
          changes: result.changes,
        });
      }
    } catch (error) {
      issues.push(exportIssue({
        code: "EXPORT_WORKBOOK_READ_FAILED",
        message: `${relativePath} 读取失败：${error instanceof Error ? error.message : String(error)}`,
        workbook,
      }));
    }
  }

  const logicalTables = [];
  for (const [workbook, bytes] of staged) {
    const extracted = extractLogicalTablesFromWorkbook({ source: bytes, workbookName: workbook, mapping: input.mapping });
    logicalTables.push(...extracted.tables);
    issues.push(...extracted.issues);
  }
  const managedFields = new Map<string, Set<string>>();
  for (const row of rows) {
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
        allowCommaSeparatedTargets: relation.targetLogicalTables.length > 1,
      })),
  );
  issues.push(...asMappingIssues(validateLogicalTableRelations({ tables: logicalTables, relations })));

  if (issues.some((issue) => issue.level === "error")) return blocked();
  return {
    ...blocked(),
    status: "ready",
    operations: pending,
  };
}

export async function previewBrowserExport(input: {
  binding: LocalExportTargetBinding;
  configRootBinding: LocalExportTargetBinding;
  packageId: string;
  mapping: ConfigExportMapping;
  snapshots: ConfigurationSnapshot[];
  availableReductionPolicies: ReductionStackingPolicyVersion[];
  createdAt?: string;
}): Promise<BrowserExportPreview> {
  const targetRoot = await loadDirectoryHandle(input.binding.directoryHandleStorageKey);
  const configRoot = await loadDirectoryHandle(input.configRootBinding.directoryHandleStorageKey);
  if (!targetRoot) throw new Error(`${input.binding.userLabel} 的目标目录尚未绑定。`);
  if (!configRoot) throw new Error(`${input.binding.environmentId} 的环境根目录尚未绑定，无法读取 config.toml。`);
  const [targetPermission, configPermission] = await Promise.all([
    targetRoot.queryPermission({ mode: "readwrite" }),
    configRoot.queryPermission({ mode: "read" }),
  ]);
  if (targetPermission !== "granted" || configPermission !== "granted") {
    throw new Error("目标目录或环境根目录需要重新授权。");
  }
  return previewBrowserExportFromHandles({
    ...input,
    targetRoot,
    configRoot,
  });
}

function safePackageDirectory(packageId: string): string {
  return packageId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96);
}

export async function commitBrowserExportFromHandle(input: {
  root: BrowserDirectoryHandle;
  binding: LocalExportTargetBinding;
  preview: BrowserExportPreview;
  snapshots: ConfigurationSnapshot[];
  availableReductionPolicies: ReductionStackingPolicyVersion[];
}): Promise<BrowserRecoveryManifest> {
  if (!input.snapshots.length) throw new Error("导出提交缺少冻结 ConfigurationSnapshot。");
  for (const snapshot of input.snapshots) {
    assertSnapshotItemPartEnabled(snapshot, "config_export");
    assertFormalSnapshotHasReplayPolicy(snapshot, input.availableReductionPolicies);
    if (!verifySnapshotIntegrity(snapshot)) {
      throw new Error(`冻结 ConfigurationSnapshot ${snapshot.id} 的内容哈希校验失败。`);
    }
  }
  const snapshotIds = input.snapshots.map((snapshot) => snapshot.id).sort();
  const previewSnapshotIds = [...input.preview.snapshotIds].sort();
  const itemPartIds = [...new Set(input.snapshots.map((snapshot) => snapshotItemPartId(snapshot)!))].sort();
  if (
    input.preview.status !== "ready"
    || input.preview.bindingId !== input.binding.bindingId
    || input.preview.environmentId !== input.binding.environmentId
    || input.preview.channelKey !== input.binding.channelKey
    || input.preview.mappingId !== input.binding.mappingId
    || input.preview.mappingVersion !== input.binding.mappingVersion
    || JSON.stringify(snapshotIds) !== JSON.stringify(previewSnapshotIds)
    || JSON.stringify(itemPartIds) !== JSON.stringify([...input.preview.itemPartIds].sort())
    || input.snapshots.some((snapshot) => input.preview.snapshotHashes[snapshot.id] !== snapshot.contentHash)
  ) {
    throw new Error("提交使用的冻结 Preview/Package/Snapshot 证明不一致，必须重新预览。");
  }
  const operations = input.preview.operations;
  const root = input.root;
  const permission = await root.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error("导出目录需要重新授权。");
  if (!operations.length) throw new Error("导出包没有文件操作。");

  for (const operation of operations) {
    const file = await getFile(root, operation.relativePath, false);
    const currentHash = await sha256(await readBytes(file));
    if (currentHash !== operation.sourceHash) {
      throw new Error(`${operation.relativePath} 在预览后已变化；保留暂存包并重新预览。`);
    }
    const stagedHash = await sha256(operation.stagedBytes);
    if (stagedHash !== operation.stagedHash) {
      throw new Error(`${operation.relativePath} 的暂存内容 hash 不匹配。`);
    }
  }

  const backupRoot = await root.getDirectoryHandle(".tackle-forger-backups", { create: true });
  const packageRoot = await backupRoot.getDirectoryHandle(safePackageDirectory(input.preview.packageId), { create: true });
  const originals = new Map<string, Uint8Array>();
  const manifest: BrowserRecoveryManifest = {
    packageId: input.preview.packageId,
    bindingId: input.binding.bindingId,
    itemPartIds,
    createdAt: input.preview.createdAt,
    operations: operations.map((operation) => ({
      relativePath: operation.relativePath,
      sourceHash: operation.sourceHash,
      stagedHash: operation.stagedHash,
      backupPath: `.tackle-forger-backups/${safePackageDirectory(input.preview.packageId)}/${operation.relativePath}`,
      state: "pending",
    })),
  };

  for (const operation of operations) {
    const source = await getFile(root, operation.relativePath, false);
    const original = await readBytes(source);
    originals.set(operation.relativePath, original);
    const backup = await getFile(packageRoot, operation.relativePath, true);
    await writeBytes(backup, original);
  }

  const written: string[] = [];
  try {
    for (const operation of operations) {
      const target = await getFile(root, operation.relativePath, false);
      await writeBytes(target, operation.stagedBytes);
      written.push(operation.relativePath);
      const entry = manifest.operations.find((item) => item.relativePath === operation.relativePath)!;
      entry.state = "written";
      const verifiedHash = await sha256(await readBytes(target));
      if (verifiedHash !== operation.stagedHash) {
        throw new Error(`${operation.relativePath} 写后回读 hash 不匹配。`);
      }
      entry.state = "verified";
    }
  } catch (error) {
    for (const relativePath of [...written].reverse()) {
      const original = originals.get(relativePath);
      if (!original) continue;
      const target = await getFile(root, relativePath, false);
      await writeBytes(target, original);
      const entry = manifest.operations.find((item) => item.relativePath === relativePath);
      if (entry) entry.state = "restored";
    }
    throw error;
  } finally {
    const manifestFile = await packageRoot.getFileHandle("recovery-manifest.json", { create: true });
    await writeBytes(
      manifestFile,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );
  }
  return manifest;
}

export async function commitBrowserExport(input: {
  binding: LocalExportTargetBinding;
  preview: BrowserExportPreview;
  snapshots: ConfigurationSnapshot[];
  availableReductionPolicies: ReductionStackingPolicyVersion[];
}): Promise<BrowserRecoveryManifest> {
  const root = await loadDirectoryHandle(input.binding.directoryHandleStorageKey);
  if (!root) throw new Error("导出目录尚未绑定。");
  return commitBrowserExportFromHandle({ ...input, root });
}
import {
  materializeConfigExport,
  parseConfigTomlTables,
  type ConfigExportMapping,
  type ConfigExportMappingIssue,
  type MaterializedConfigRow,
} from "./config-export-mapping";
import {
  extractLogicalTablesFromWorkbook,
  stageWorkbookRows,
  type WorkbookCellChange,
} from "./config-export-workbook";
import { validateLogicalTableRelations } from "./config-export";
import { verifySnapshotIntegrity } from "./publishing";
import type { ConfigurationSnapshot, ReductionStackingPolicyVersion } from "./types";
import {
  assertSnapshotItemPartEnabled,
  snapshotItemPartId,
} from "./enabled-item-parts";
import { assertFormalSnapshotHasReplayPolicy } from "./reduction-stacking-policy";
