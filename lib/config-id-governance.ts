import type { PurchasableModel, WorkspaceState } from "./types";
import { stableStringify } from "./rule-kernel";
import { sha256Hex } from "./deterministic-sha256";

export type ConfigIdPart = "rod" | "reel" | "line";
export type ConfigIdLedgerStatus =
  | "RESERVED"
  | "ABANDONED"
  | "DEPRECATED"
  | "LEGACY_IMPORTED"
  | "EXTERNAL_OCCUPIED";
export type ConfigIdCapacityLevel = "NORMAL" | "WARNING_80" | "CRITICAL_95" | "EXHAUSTED";

export interface ConfigIdRangeDefinition {
  rangeId: string;
  part: ConfigIdPart;
  minimumBaseId: string;
  maximumBaseId: string;
  reservedBaseIdSuffix: "000";
  goodsBasicDerivation: "decimal_prefix_10";
  storeBuyDerivation: "decimal_prefix_30";
}

export interface ConfigTargetCatalogEntry {
  targetEntryId: string;
  environmentId: string;
  channelKey: string;
  repositoryId: string;
  authoritativeRef: string;
  logicalDirectory: string;
  configTomlPath: string;
  managedWorkbooks: ConfigTargetManagedWorkbook[];
  requiredForFormal: boolean;
}

export interface ConfigTargetManagedWorkbook {
  logicalName: string;
  workbookPath: string;
  sheetNames: string[];
}

export interface ConfigTargetCatalogVersion {
  catalogVersionId: string;
  status: "PUBLISHED" | "SUPERSEDED";
  entries: ConfigTargetCatalogEntry[];
  approvedBy: string;
  approvedAt: string;
  contentHash: string;
}

export interface ConfigTargetWorkbookHash {
  logicalName: string;
  workbookPath: string;
  sheets: Array<{
    sheetName: string;
    sheetHash: string;
  }>;
  workbookHash: string;
}

export interface ConfigTargetScanManifest {
  manifestId: string;
  catalogVersionId: string;
  targetEntryId: string;
  environmentId: string;
  channelKey: string;
  repositoryId: string;
  authoritativeRef: string;
  resolvedCommitOid: string;
  logicalDirectory: string;
  configTomlHash: string;
  workbooks: ConfigTargetWorkbookHash[];
  workbookSetHash: string;
  scannerVersion: string;
  ruleVersion: string;
  verifiedRangeIds: string[];
  issueCodes: string[];
  resultHash: string;
  state: "APPROVED";
  scannedBy: string;
  scannedAt: string;
  approvedBy: string;
  approvedAt: string;
}

export interface ConfigTargetObservedState {
  targetEntryId: string;
  repositoryId: string;
  authoritativeRef: string;
  resolvedCommitOid: string;
  logicalDirectory: string;
  configTomlHash: string;
  workbooks: ConfigTargetWorkbookHash[];
}

export interface ConfigTargetPhysicalRefGroup {
  repositoryId: string;
  authoritativeRef: string;
  expectedCommitOid: string;
  targetEntryIds: string[];
}

export interface ConfigIdPolicyVersion {
  policyVersionId: string;
  status: "PUBLISHED" | "SUPERSEDED";
  catalogVersionId: string;
  manifestIds: string[];
  manifestSetHash: string;
  ranges: ConfigIdRangeDefinition[];
  publishedBy: string;
  publishedAt: string;
  contentHash: string;
}

/**
 * #55 只消费由 #56 的治理协调器在 COMMITTING 点签发并实时验证的证明。
 * 本模块不签发租约、不推进 Git ref，也不实现 formal export。
 */
export interface ConfigTargetSerializationCheckpoint {
  state: "COMMITTING";
  leaseId: string;
  fencingToken: string;
  operationId: string;
  catalogVersionId: string;
  manifestSetHash: string;
  physicalRefs: ConfigTargetPhysicalRefGroup[];
  targets: Array<{
    targetEntryId: string;
    repositoryId: string;
    authoritativeRef: string;
    expectedCommitOid: string;
    configTomlHash: string;
    workbookSetHash: string;
  }>;
  expiresAt: string;
}

export interface ConfigIdBundle {
  bundleId: string;
  part: ConfigIdPart;
  stableModelKey: string;
  tackleItem: { configNumericId: string; configNameKey: string };
  goodsBasic: { configNumericId: string; configNameKey: string };
  storeBuy: { configNumericId: string; configNameKey: string };
}

export interface ConfigIdRangeCursor {
  rangeId: string;
  lastAllocatedBaseId: string;
  updatedAt: string;
}

export interface ConfigIdReservationLedgerEntry {
  ledgerEntryId: string;
  bundle: ConfigIdBundle;
  rangeId: string;
  modelId?: string;
  status: ConfigIdLedgerStatus;
  policyVersionId: string;
  reservedAgainstModelRevisionId?: string;
  resultingModelRevisionId?: string;
  leaseId?: string;
  fencingToken?: string;
  manifestSetHash?: string;
  targetEntryIds?: string[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  reason?: string;
}

export interface ConfigIdReservationResultRecord {
  modelId: string;
  reservedAgainstModelRevisionId: string;
  resultingModelRevisionId: string;
  bundle: ConfigIdBundle;
  leaseId: string;
  fencingToken: string;
  capacity: ConfigIdCapacityStatus;
}

export interface ConfigIdReservationIdempotencyRecord {
  idempotencyKey: string;
  modelId: string;
  commandHash: string;
  result: ConfigIdReservationResultRecord;
  committedAt: string;
}

export interface ConfigIdGovernanceAuditRecord {
  auditId: string;
  action:
    | "PUBLISH_TARGET_CATALOG"
    | "APPROVE_TARGET_SCAN"
    | "PUBLISH_CONFIG_ID_POLICY"
    | "RESERVE_CONFIG_ID_BUNDLE"
    | "TRANSITION_CONFIG_ID_BUNDLE";
  actor: string;
  occurredAt: string;
  subjectId: string;
  beforeHash?: string;
  afterHash: string;
  reason?: string;
}

export interface ConfigIdGovernanceState {
  schemaVersion: 1;
  catalogs: ConfigTargetCatalogVersion[];
  scanManifests: ConfigTargetScanManifest[];
  policies: ConfigIdPolicyVersion[];
  rangeCursors: ConfigIdRangeCursor[];
  reservationLedger: ConfigIdReservationLedgerEntry[];
  reservationIdempotency: ConfigIdReservationIdempotencyRecord[];
  modelRevisionArchive: PurchasableModel[];
  auditLog: ConfigIdGovernanceAuditRecord[];
  preservedUnknown?: Record<string, unknown>;
}

export interface ConfigIdCapacityStatus {
  rangeId: string;
  used: number;
  capacity: number;
  utilization: number;
  level: ConfigIdCapacityLevel;
}

export interface ReserveConfigIdBundleCommand {
  modelId: string;
  expectedModelRevisionId: string;
  part: ConfigIdPart;
  expectedNormalizedStableModelKey: string;
  policyVersionId: string;
  expectedManifestSetHash: string;
  operationId: string;
  idempotencyKey: string;
}

export interface ReserveConfigIdBundleContext {
  observedTargets: ConfigTargetObservedState[];
  serializationCheckpoint?: ConfigTargetSerializationCheckpoint;
  actor: string;
  now: string;
}

export interface ReserveConfigIdBundleTransition {
  state: WorkspaceState;
  result: ConfigIdReservationResultRecord;
  idempotent: boolean;
  existing: boolean;
}

export class ConfigIdGovernanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConfigIdGovernanceError";
  }
}

export const CANONICAL_CONFIG_ID_RANGES: readonly ConfigIdRangeDefinition[] = [
  {
    rangeId: "rod_301800001_301899999",
    part: "rod",
    minimumBaseId: "301800001",
    maximumBaseId: "301899999",
    reservedBaseIdSuffix: "000",
    goodsBasicDerivation: "decimal_prefix_10",
    storeBuyDerivation: "decimal_prefix_30",
  },
  {
    rangeId: "reel_302800001_302899999",
    part: "reel",
    minimumBaseId: "302800001",
    maximumBaseId: "302899999",
    reservedBaseIdSuffix: "000",
    goodsBasicDerivation: "decimal_prefix_10",
    storeBuyDerivation: "decimal_prefix_30",
  },
  {
    rangeId: "line_303800001_303899999",
    part: "line",
    minimumBaseId: "303800001",
    maximumBaseId: "303899999",
    reservedBaseIdSuffix: "000",
    goodsBasicDerivation: "decimal_prefix_10",
    storeBuyDerivation: "decimal_prefix_30",
  },
] as const;

function sha256(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueBy<T>(values: T[], key: (value: T) => string, code: string): T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) {
      throw new ConfigIdGovernanceError(code, `发现重复身份：${id}。`);
    }
    seen.add(id);
  }
  return values;
}

function assertSha256(value: string, field: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_SCAN_HASH_INVALID",
      `${field} 必须是小写 SHA-256 十六进制字符串。`,
    );
  }
}

function assertRepositoryRelativePath(value: string, field: string) {
  if (
    typeof value !== "string"
    || !value
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_CATALOG_ENTRY_INVALID",
      `${field} 必须是规范化的仓库内相对路径。`,
    );
  }
}

function normalizeManagedWorkbooks(
  workbooks: ConfigTargetManagedWorkbook[],
  targetEntryId: string,
): ConfigTargetManagedWorkbook[] {
  if (!Array.isArray(workbooks) || !workbooks.length) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_CATALOG_WORKBOOKS_EMPTY",
      `${targetEntryId} 必须声明至少一个受管 workbook。`,
    );
  }
  const normalized = uniqueBy(
    structuredClone(workbooks),
    (entry) => entry.logicalName,
    "CONFIG_TARGET_CATALOG_WORKBOOK_DUPLICATE",
  );
  uniqueBy(
    normalized,
    (entry) => entry.workbookPath,
    "CONFIG_TARGET_CATALOG_WORKBOOK_PATH_DUPLICATE",
  );
  for (const workbook of normalized) {
    if (typeof workbook.logicalName !== "string" || !workbook.logicalName) {
      throw new ConfigIdGovernanceError(
        "CONFIG_TARGET_CATALOG_ENTRY_INVALID",
        `${targetEntryId} 包含空 workbook 逻辑名。`,
      );
    }
    assertRepositoryRelativePath(
      workbook.workbookPath,
      `${targetEntryId}.${workbook.logicalName}.workbookPath`,
    );
    if (
      !Array.isArray(workbook.sheetNames)
      || !workbook.sheetNames.length
      || workbook.sheetNames.some((sheetName) => typeof sheetName !== "string" || !sheetName)
    ) {
      throw new ConfigIdGovernanceError(
        "CONFIG_TARGET_CATALOG_SHEETS_EMPTY",
        `${targetEntryId}/${workbook.logicalName} 必须声明非空 sheet 集合。`,
      );
    }
    workbook.sheetNames = uniqueBy(
      [...workbook.sheetNames],
      (sheetName) => sheetName,
      "CONFIG_TARGET_CATALOG_SHEET_DUPLICATE",
    ).sort(compareText);
  }
  return normalized.sort((left, right) => compareText(left.logicalName, right.logicalName));
}

function normalizeWorkbookHashes(
  workbooks: ConfigTargetWorkbookHash[],
  expected: ConfigTargetManagedWorkbook[],
  targetEntryId: string,
): ConfigTargetWorkbookHash[] {
  if (!Array.isArray(workbooks) || !workbooks.length) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_SCAN_WORKBOOKS_EMPTY",
      `${targetEntryId} 的扫描结果未包含任何受管 workbook。`,
    );
  }
  const normalized = uniqueBy(
    structuredClone(workbooks),
    (entry) => entry.logicalName,
    "CONFIG_TARGET_SCAN_WORKBOOK_DUPLICATE",
  );
  uniqueBy(
    normalized,
    (entry) => entry.workbookPath,
    "CONFIG_TARGET_SCAN_WORKBOOK_PATH_DUPLICATE",
  );
  for (const workbook of normalized) {
    if (typeof workbook.logicalName !== "string" || !workbook.logicalName) {
      throw new ConfigIdGovernanceError(
        "CONFIG_TARGET_SCAN_MANIFEST_INVALID",
        `${targetEntryId} 包含空 workbook 逻辑名。`,
      );
    }
    assertRepositoryRelativePath(
      workbook.workbookPath,
      `${targetEntryId}.${workbook.logicalName}.workbookPath`,
    );
    assertSha256(workbook.workbookHash, `${targetEntryId}.${workbook.logicalName}.workbookHash`);
    if (!Array.isArray(workbook.sheets) || !workbook.sheets.length) {
      throw new ConfigIdGovernanceError(
        "CONFIG_TARGET_SCAN_SHEETS_EMPTY",
        `${targetEntryId}/${workbook.logicalName} 的扫描结果未包含任何 sheet。`,
      );
    }
    workbook.sheets = uniqueBy(
      workbook.sheets,
      (sheet) => sheet.sheetName,
      "CONFIG_TARGET_SCAN_SHEET_DUPLICATE",
    ).sort((left, right) => compareText(left.sheetName, right.sheetName));
    for (const sheet of workbook.sheets) {
      if (typeof sheet.sheetName !== "string" || !sheet.sheetName) {
        throw new ConfigIdGovernanceError(
          "CONFIG_TARGET_SCAN_MANIFEST_INVALID",
          `${targetEntryId}/${workbook.logicalName} 包含空 sheet 名。`,
        );
      }
      assertSha256(
        sheet.sheetHash,
        `${targetEntryId}.${workbook.logicalName}.${sheet.sheetName}.sheetHash`,
      );
    }
  }
  normalized.sort((left, right) => compareText(left.logicalName, right.logicalName));
  const expectedIdentity = expected.map((workbook) => ({
    logicalName: workbook.logicalName,
    workbookPath: workbook.workbookPath,
    sheetNames: workbook.sheetNames,
  }));
  const actualIdentity = normalized.map((workbook) => ({
    logicalName: workbook.logicalName,
    workbookPath: workbook.workbookPath,
    sheetNames: workbook.sheets.map((sheet) => sheet.sheetName),
  }));
  if (stableStringify(actualIdentity) !== stableStringify(expectedIdentity)) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_SCAN_MANIFEST_COVERAGE_INCOMPLETE",
      `${targetEntryId} 的扫描结果未恰好覆盖目录声明的 workbook/sheet 闭集。`,
      { expected: expectedIdentity, actual: actualIdentity },
    );
  }
  return normalized;
}

function assertDecimalId(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ConfigIdGovernanceError("CONFIG_ID_RANGE_INVALID", `${field} 必须是无前导零的正整数十进制字符串。`);
  }
  return BigInt(value);
}

function rangeSemanticValue(range: ConfigIdRangeDefinition) {
  return {
    rangeId: range.rangeId,
    part: range.part,
    minimumBaseId: range.minimumBaseId,
    maximumBaseId: range.maximumBaseId,
    reservedBaseIdSuffix: range.reservedBaseIdSuffix,
    goodsBasicDerivation: range.goodsBasicDerivation,
    storeBuyDerivation: range.storeBuyDerivation,
  };
}

function rangeIntervals(range: ConfigIdRangeDefinition) {
  const minimum = assertDecimalId(range.minimumBaseId, `${range.rangeId}.minimumBaseId`);
  const maximum = assertDecimalId(range.maximumBaseId, `${range.rangeId}.maximumBaseId`);
  if (minimum > maximum) {
    throw new ConfigIdGovernanceError("CONFIG_ID_RANGE_INVALID", `${range.rangeId} 的上下界顺序无效。`);
  }
  return [
    { kind: "base", minimum, maximum },
    { kind: "goods_basic", minimum: BigInt(`10${range.minimumBaseId}`), maximum: BigInt(`10${range.maximumBaseId}`) },
    { kind: "store_buy", minimum: BigInt(`30${range.minimumBaseId}`), maximum: BigInt(`30${range.maximumBaseId}`) },
  ];
}

function assertRangeDefinitions(
  governance: ConfigIdGovernanceState,
  ranges: ConfigIdRangeDefinition[],
) {
  uniqueBy(ranges, (range) => range.rangeId, "CONFIG_ID_RANGE_DUPLICATE");
  const knownRanges = governance.policies.flatMap((policy) => policy.ranges);
  for (const range of ranges) {
    if (
      !range.rangeId
      || !["rod", "reel", "line"].includes(range.part)
      || range.reservedBaseIdSuffix !== "000"
      || range.goodsBasicDerivation !== "decimal_prefix_10"
      || range.storeBuyDerivation !== "decimal_prefix_30"
    ) {
      throw new ConfigIdGovernanceError("CONFIG_ID_RANGE_INVALID", `${range.rangeId} 使用了未启用部位。`);
    }
    const prior = knownRanges.find((entry) => entry.rangeId === range.rangeId);
    if (prior && stableStringify(rangeSemanticValue(prior)) !== stableStringify(rangeSemanticValue(range))) {
      throw new ConfigIdGovernanceError(
        "CONFIG_ID_RANGE_SEMANTICS_CHANGED",
        `稳定 rangeId ${range.rangeId} 的语义不能跨策略版本改变。`,
      );
    }
    rangeIntervals(range);
  }

  const allById = new Map<string, ConfigIdRangeDefinition>();
  for (const range of [...knownRanges, ...ranges]) allById.set(range.rangeId, range);
  const all = [...allById.values()].sort((left, right) => compareText(left.rangeId, right.rangeId));
  for (let leftIndex = 0; leftIndex < all.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < all.length; rightIndex += 1) {
      const left = all[leftIndex]!;
      const right = all[rightIndex]!;
      for (const leftInterval of rangeIntervals(left)) {
        for (const rightInterval of rangeIntervals(right)) {
          if (leftInterval.minimum <= rightInterval.maximum && rightInterval.minimum <= leftInterval.maximum) {
            throw new ConfigIdGovernanceError(
              "CONFIG_ID_RANGE_OVERLAP",
              `${left.rangeId}/${leftInterval.kind} 与 ${right.rangeId}/${rightInterval.kind} 空间重叠。`,
            );
          }
        }
      }
    }
  }
}

export function emptyConfigIdGovernanceState(): ConfigIdGovernanceState {
  return {
    schemaVersion: 1,
    catalogs: [],
    scanManifests: [],
    policies: [],
    rangeCursors: [],
    reservationLedger: [],
    reservationIdempotency: [],
    modelRevisionArchive: [],
    auditLog: [],
  };
}

export function migrateConfigIdGovernanceState(input: unknown): ConfigIdGovernanceState {
  if (input === undefined || input === null) return emptyConfigIdGovernanceState();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigIdGovernanceError("CONFIG_ID_GOVERNANCE_SCHEMA_INVALID", "ConfigId 治理子状态必须是对象。");
  }
  const source = structuredClone(input) as Partial<ConfigIdGovernanceState> & Record<string, unknown>;
  if (source.schemaVersion !== 1) {
    throw new ConfigIdGovernanceError(
      "CONFIG_ID_GOVERNANCE_SCHEMA_UNSUPPORTED",
      `不支持 ConfigId 治理子状态版本 ${String(source.schemaVersion)}。`,
    );
  }
  const known = new Set([
    "schemaVersion", "catalogs", "scanManifests", "policies", "rangeCursors",
    "reservationLedger", "reservationIdempotency", "modelRevisionArchive", "auditLog",
    "preservedUnknown",
  ]);
  const unknownEntries = Object.entries(source).filter(([key]) => !known.has(key));
  return {
    schemaVersion: 1,
    catalogs: Array.isArray(source.catalogs) ? source.catalogs : [],
    scanManifests: Array.isArray(source.scanManifests) ? source.scanManifests : [],
    policies: Array.isArray(source.policies) ? source.policies : [],
    rangeCursors: Array.isArray(source.rangeCursors) ? source.rangeCursors : [],
    reservationLedger: Array.isArray(source.reservationLedger) ? source.reservationLedger : [],
    reservationIdempotency: Array.isArray(source.reservationIdempotency) ? source.reservationIdempotency : [],
    modelRevisionArchive: Array.isArray(source.modelRevisionArchive) ? source.modelRevisionArchive : [],
    auditLog: Array.isArray(source.auditLog) ? source.auditLog : [],
    ...(source.preservedUnknown || unknownEntries.length
      ? { preservedUnknown: { ...(source.preservedUnknown ?? {}), ...Object.fromEntries(unknownEntries) } }
      : {}),
  };
}

export function normalizeStableModelKey(value: string): string {
  const normalized = value
    .replace(/^[\u0009-\u000D\u0020]+|[\u0009-\u000D\u0020]+$/g, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(normalized)) {
    throw new ConfigIdGovernanceError(
      "STABLE_MODEL_KEY_INVALID",
      "stableModelKey 规范化后必须匹配 ^[a-z][a-z0-9_]{0,39}$。",
      { normalized },
    );
  }
  return normalized;
}

export function configNameKeys(part: ConfigIdPart, stableModelKey: string) {
  const key = normalizeStableModelKey(stableModelKey);
  const values = {
    tackleItem: `tf_${part}_${key}`,
    goodsBasic: `store_tf_${part}_${key}`,
    storeBuy: `buy_tf_${part}_${key}`,
  };
  for (const [kind, value] of Object.entries(values)) {
    if (value.length > 64 || !/^[a-z][a-z0-9_]*$/.test(value)) {
      throw new ConfigIdGovernanceError("CONFIG_NAME_KEY_INVALID", `${kind} 名称不满足配置键约束。`);
    }
  }
  return values;
}

export function deriveConfigIds(baseId: string) {
  assertDecimalId(baseId, "baseId");
  return { baseId, goodsBasicId: `10${baseId}`, storeBuyId: `30${baseId}` };
}

function auditRecord(
  action: ConfigIdGovernanceAuditRecord["action"],
  actor: string,
  occurredAt: string,
  subjectId: string,
  after: unknown,
  before?: unknown,
  reason?: string,
): ConfigIdGovernanceAuditRecord {
  return {
    auditId: `config-id-audit:${sha256({ action, occurredAt, subjectId, after }).slice(0, 24)}`,
    action,
    actor,
    occurredAt,
    subjectId,
    ...(before === undefined ? {} : { beforeHash: sha256(before) }),
    afterHash: sha256(after),
    ...(reason ? { reason } : {}),
  };
}

export function publishConfigTargetCatalogVersion(
  inputState: ConfigIdGovernanceState,
  input: Omit<ConfigTargetCatalogVersion, "status" | "contentHash">,
): ConfigIdGovernanceState {
  const state = migrateConfigIdGovernanceState(inputState);
  if (state.catalogs.some((entry) => entry.catalogVersionId === input.catalogVersionId)) {
    throw new ConfigIdGovernanceError("CONFIG_TARGET_CATALOG_VERSION_EXISTS", "目录版本 ID 已存在且不可改写。");
  }
  const entries = uniqueBy(
    structuredClone(input.entries),
    (entry) => entry.targetEntryId,
    "CONFIG_TARGET_CATALOG_ENTRY_DUPLICATE",
  ).sort((left, right) => compareText(left.targetEntryId, right.targetEntryId));
  uniqueBy(
    entries,
    (entry) => stableStringify([entry.environmentId, entry.channelKey]),
    "CONFIG_TARGET_CATALOG_SCOPE_DUPLICATE",
  );
  for (const entry of entries) {
    if (!entry.repositoryId || !entry.authoritativeRef || !entry.logicalDirectory || !entry.configTomlPath) {
      throw new ConfigIdGovernanceError("CONFIG_TARGET_CATALOG_ENTRY_INVALID", `${entry.targetEntryId} 缺少权威目标字段。`);
    }
    assertRepositoryRelativePath(entry.logicalDirectory, `${entry.targetEntryId}.logicalDirectory`);
    assertRepositoryRelativePath(entry.configTomlPath, `${entry.targetEntryId}.configTomlPath`);
    entry.managedWorkbooks = normalizeManagedWorkbooks(entry.managedWorkbooks, entry.targetEntryId);
  }
  const version: ConfigTargetCatalogVersion = {
    ...structuredClone(input),
    status: "PUBLISHED",
    entries,
    contentHash: sha256({ catalogVersionId: input.catalogVersionId, entries }),
  };
  return {
    ...state,
    catalogs: [
      ...state.catalogs.map((entry) =>
        entry.status === "PUBLISHED" ? { ...entry, status: "SUPERSEDED" as const } : entry),
      version,
    ],
    auditLog: [...state.auditLog, auditRecord(
      "PUBLISH_TARGET_CATALOG", input.approvedBy, input.approvedAt,
      input.catalogVersionId, version,
    )],
  };
}

export function approveConfigTargetScanManifest(
  inputState: ConfigIdGovernanceState,
  input: Omit<ConfigTargetScanManifest, "state" | "workbookSetHash" | "resultHash">,
): ConfigIdGovernanceState {
  const state = migrateConfigIdGovernanceState(inputState);
  if (state.scanManifests.some((entry) => entry.manifestId === input.manifestId)) {
    throw new ConfigIdGovernanceError("CONFIG_TARGET_SCAN_MANIFEST_EXISTS", "扫描 Manifest ID 已存在且不可改写。");
  }
  const catalog = state.catalogs.find((entry) =>
    entry.catalogVersionId === input.catalogVersionId && entry.status === "PUBLISHED");
  const target = catalog?.entries.find((entry) => entry.targetEntryId === input.targetEntryId);
  if (!catalog || !target) {
    throw new ConfigIdGovernanceError("CONFIG_TARGET_CATALOG_ENTRY_MISSING", "Manifest 未命中已发布目录条目。");
  }
  if (
    input.environmentId !== target.environmentId
    || input.channelKey !== target.channelKey
    || input.repositoryId !== target.repositoryId
    || input.authoritativeRef !== target.authoritativeRef
    || input.logicalDirectory !== target.logicalDirectory
  ) {
    throw new ConfigIdGovernanceError("CONFIG_TARGET_SCAN_MANIFEST_TARGET_MISMATCH", "Manifest 与目录条目身份不一致。");
  }
  if (
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.resolvedCommitOid)
    || !input.scannerVersion
    || !input.ruleVersion
  ) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_SCAN_MANIFEST_INVALID",
      "Manifest 缺少可验证 commit、配置 hash 或扫描规则版本。",
    );
  }
  assertSha256(input.configTomlHash, `${input.targetEntryId}.configTomlHash`);
  const workbooks = normalizeWorkbookHashes(
    input.workbooks,
    target.managedWorkbooks,
    input.targetEntryId,
  );
  const workbookSetHash = sha256(workbooks);
  const manifest: ConfigTargetScanManifest = {
    ...structuredClone(input),
    workbooks,
    workbookSetHash,
    state: "APPROVED",
    resultHash: sha256({
      ...input,
      workbooks,
      workbookSetHash,
      state: "APPROVED",
    }),
  };
  return {
    ...state,
    scanManifests: [...state.scanManifests, manifest],
    auditLog: [...state.auditLog, auditRecord(
      "APPROVE_TARGET_SCAN", input.approvedBy, input.approvedAt, input.manifestId, manifest,
    )],
  };
}

export function resolveConfigTargetPhysicalRefGroups(
  catalog: ConfigTargetCatalogVersion,
  manifests: ConfigTargetScanManifest[],
): ConfigTargetPhysicalRefGroup[] {
  const groups = new Map<string, ConfigTargetPhysicalRefGroup>();
  for (const manifest of manifests) {
    const entry = catalog.entries.find((candidate) => candidate.targetEntryId === manifest.targetEntryId);
    if (!entry) {
      throw new ConfigIdGovernanceError("CONFIG_TARGET_CATALOG_ENTRY_MISSING", "Manifest 引用了目录外目标。");
    }
    const key = stableStringify([entry.repositoryId, entry.authoritativeRef]);
    const existing = groups.get(key);
    if (existing && existing.expectedCommitOid !== manifest.resolvedCommitOid) {
      throw new ConfigIdGovernanceError(
        "CONFIG_TARGET_REF_ALIAS_CONFLICT",
        "同一物理 Git ref 的逻辑别名声明了不同 expected OID。",
        { targetEntryIds: [...existing.targetEntryIds, entry.targetEntryId] },
      );
    }
    if (existing) {
      existing.targetEntryIds.push(entry.targetEntryId);
    } else {
      groups.set(key, {
        repositoryId: entry.repositoryId,
        authoritativeRef: entry.authoritativeRef,
        expectedCommitOid: manifest.resolvedCommitOid,
        targetEntryIds: [entry.targetEntryId],
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      targetEntryIds: [...group.targetEntryIds].sort(compareText),
    }))
    .sort((left, right) =>
      compareText(left.repositoryId, right.repositoryId)
      || compareText(left.authoritativeRef, right.authoritativeRef));
}

function policyManifests(
  governance: ConfigIdGovernanceState,
  policy: Pick<ConfigIdPolicyVersion, "catalogVersionId" | "manifestIds">,
) {
  const catalog = governance.catalogs.find((entry) =>
    entry.catalogVersionId === policy.catalogVersionId && entry.status === "PUBLISHED");
  if (!catalog) {
    throw new ConfigIdGovernanceError("CONFIG_TARGET_CATALOG_UNPUBLISHED", "ConfigTargetCatalogVersion 未发布。");
  }
  const manifests = policy.manifestIds.map((manifestId) => {
    const manifest = governance.scanManifests.find((entry) => entry.manifestId === manifestId);
    if (!manifest || manifest.state !== "APPROVED") {
      throw new ConfigIdGovernanceError("CONFIG_TARGET_SCAN_MANIFEST_UNAPPROVED", `Manifest ${manifestId} 未获批。`);
    }
    if (manifest.catalogVersionId !== catalog.catalogVersionId) {
      throw new ConfigIdGovernanceError("CONFIG_TARGET_SCAN_MANIFEST_CATALOG_MISMATCH", "Manifest 不属于策略目录版本。");
    }
    return manifest;
  });
  uniqueBy(manifests, (manifest) => manifest.manifestId, "CONFIG_TARGET_SCAN_MANIFEST_DUPLICATE");
  const requiredIds = catalog.entries.filter((entry) => entry.requiredForFormal)
    .map((entry) => entry.targetEntryId).sort(compareText);
  const coveredIds = manifests.filter((manifest) => requiredIds.includes(manifest.targetEntryId))
    .map((manifest) => manifest.targetEntryId).sort(compareText);
  if (stableStringify(requiredIds) !== stableStringify(coveredIds)) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_SCAN_MANIFEST_COVERAGE_INCOMPLETE",
      "获批 Manifest 未恰好覆盖目录中的全部必需目标。",
      { requiredIds, coveredIds },
    );
  }
  return { catalog, manifests };
}

export function verifyConfigTargetManifestFreshness(
  governance: ConfigIdGovernanceState,
  policy: Pick<ConfigIdPolicyVersion, "catalogVersionId" | "manifestIds">,
  observations: ConfigTargetObservedState[],
) {
  const { catalog, manifests } = policyManifests(governance, policy);
  uniqueBy(observations, (entry) => entry.targetEntryId, "CONFIG_TARGET_OBSERVATION_DUPLICATE");
  for (const manifest of manifests) {
    const observed = observations.find((entry) => entry.targetEntryId === manifest.targetEntryId);
    const target = catalog.entries.find((entry) => entry.targetEntryId === manifest.targetEntryId);
    const observedWorkbooks = observed && target
      ? normalizeWorkbookHashes(observed.workbooks, target.managedWorkbooks, observed.targetEntryId)
      : undefined;
    const observedWorkbookSetHash = observedWorkbooks ? sha256(observedWorkbooks) : undefined;
    if (
      !observed
      || !target
      || observed.repositoryId !== manifest.repositoryId
      || observed.authoritativeRef !== manifest.authoritativeRef
      || observed.resolvedCommitOid !== manifest.resolvedCommitOid
      || observed.logicalDirectory !== manifest.logicalDirectory
      || observed.configTomlHash !== manifest.configTomlHash
      || observedWorkbookSetHash !== manifest.workbookSetHash
      || stableStringify(observedWorkbooks) !== stableStringify(manifest.workbooks)
    ) {
      throw new ConfigIdGovernanceError(
        "CONFIG_TARGET_SCAN_MANIFEST_STALE",
        `目标 ${manifest.targetEntryId} 已偏离获批 Manifest。`,
        { targetEntryId: manifest.targetEntryId },
      );
    }
  }
  return resolveConfigTargetPhysicalRefGroups(catalog, manifests);
}

export function publishConfigIdPolicyVersion(
  inputState: ConfigIdGovernanceState,
  input: {
    policyVersionId: string;
    catalogVersionId: string;
    manifestIds: string[];
    ranges: ConfigIdRangeDefinition[];
    publishedBy: string;
    publishedAt: string;
    observedTargets: ConfigTargetObservedState[];
  },
): ConfigIdGovernanceState {
  const state = migrateConfigIdGovernanceState(inputState);
  if (state.policies.some((entry) => entry.policyVersionId === input.policyVersionId)) {
    throw new ConfigIdGovernanceError("CONFIG_ID_POLICY_VERSION_EXISTS", "策略版本 ID 已存在且不可改写。");
  }
  assertRangeDefinitions(state, input.ranges);
  const manifestIds = [...input.manifestIds].sort(compareText);
  const provisional = { catalogVersionId: input.catalogVersionId, manifestIds };
  verifyConfigTargetManifestFreshness(state, provisional, input.observedTargets);
  const { manifests } = policyManifests(state, provisional);
  const expectedRangeIds = input.ranges.map((range) => range.rangeId).sort(compareText);
  for (const manifest of manifests) {
    const verifiedRangeIds = [...new Set(manifest.verifiedRangeIds)].sort(compareText);
    if (
      manifest.issueCodes.length
      || stableStringify(verifiedRangeIds) !== stableStringify(expectedRangeIds)
    ) {
      throw new ConfigIdGovernanceError(
        "CONFIG_TARGET_SCAN_MANIFEST_RANGE_MISMATCH",
        `Manifest ${manifest.manifestId} 未无误地验证策略声明的全部 rangeId。`,
        { expectedRangeIds, verifiedRangeIds, issueCodes: manifest.issueCodes },
      );
    }
  }
  const manifestSetHash = sha256(
    manifests.map((manifest) => ({
      manifestId: manifest.manifestId,
      resultHash: manifest.resultHash,
    })).sort((left, right) => compareText(left.manifestId, right.manifestId)),
  );
  const ranges = structuredClone(input.ranges);
  const policy: ConfigIdPolicyVersion = {
    policyVersionId: input.policyVersionId,
    status: "PUBLISHED",
    catalogVersionId: input.catalogVersionId,
    manifestIds,
    manifestSetHash,
    ranges,
    publishedBy: input.publishedBy,
    publishedAt: input.publishedAt,
    contentHash: sha256({
      policyVersionId: input.policyVersionId,
      catalogVersionId: input.catalogVersionId,
      manifestIds,
      manifestSetHash,
      ranges: ranges.map(rangeSemanticValue),
    }),
  };
  return {
    ...state,
    policies: [
      ...state.policies.map((entry) =>
        entry.status === "PUBLISHED" ? { ...entry, status: "SUPERSEDED" as const } : entry),
      policy,
    ],
    auditLog: [...state.auditLog, auditRecord(
      "PUBLISH_CONFIG_ID_POLICY", input.publishedBy, input.publishedAt,
      input.policyVersionId, policy,
    )],
  };
}

export function configIdRangeCapacity(range: ConfigIdRangeDefinition): number {
  const minimum = assertDecimalId(range.minimumBaseId, "minimumBaseId");
  const maximum = assertDecimalId(range.maximumBaseId, "maximumBaseId");
  const one = BigInt(1);
  const total = maximum - minimum + one;
  const multiplesThrough = (value: bigint) => value / BigInt(1000);
  const reserved = multiplesThrough(maximum) - multiplesThrough(minimum - one);
  const capacity = total - reserved;
  if (capacity > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConfigIdGovernanceError("CONFIG_ID_RANGE_CAPACITY_UNSAFE", "区间容量超过安全计数范围。");
  }
  return Number(capacity);
}

export function configIdCapacityStatus(
  range: ConfigIdRangeDefinition,
  used: number,
): ConfigIdCapacityStatus {
  const capacity = configIdRangeCapacity(range);
  const boundedUsed = Math.max(0, used);
  const utilization = capacity === 0 ? 1 : boundedUsed / capacity;
  const level: ConfigIdCapacityLevel = boundedUsed >= capacity
    ? "EXHAUSTED"
    : utilization >= 0.95
      ? "CRITICAL_95"
      : utilization >= 0.8
        ? "WARNING_80"
        : "NORMAL";
  return { rangeId: range.rangeId, used: boundedUsed, capacity, utilization, level };
}

function partForModel(state: WorkspaceState, model: PurchasableModel): ConfigIdPart | undefined {
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId);
  const series = sku && state.seriesDefinitions.find((entry) => entry.id === sku.seriesId);
  const part = series?.itemPartId;
  if (part === "part:rod") return "rod";
  if (part === "part:reel") return "reel";
  if (part === "part:line") return "line";
  return undefined;
}

function bundleFor(baseId: string, part: ConfigIdPart, stableModelKey: string, modelId: string): ConfigIdBundle {
  const ids = deriveConfigIds(baseId);
  const names = configNameKeys(part, stableModelKey);
  return {
    bundleId: `config-id-bundle:${sha256({ modelId, part, stableModelKey }).slice(0, 24)}`,
    part,
    stableModelKey,
    tackleItem: { configNumericId: ids.baseId, configNameKey: names.tackleItem },
    goodsBasic: { configNumericId: ids.goodsBasicId, configNameKey: names.goodsBasic },
    storeBuy: { configNumericId: ids.storeBuyId, configNameKey: names.storeBuy },
  };
}

function assertSerializationCheckpoint(
  checkpoint: ConfigTargetSerializationCheckpoint | undefined,
  operationId: string,
  policy: ConfigIdPolicyVersion,
  expectedGroups: ConfigTargetPhysicalRefGroup[],
  expectedTargets: ConfigTargetSerializationCheckpoint["targets"],
  now: string,
) {
  const expiresAt = checkpoint ? Date.parse(checkpoint.expiresAt) : Number.NaN;
  const committedAt = Date.parse(now);
  if (
    !checkpoint
    || checkpoint.state !== "COMMITTING"
    || checkpoint.operationId !== operationId
    || checkpoint.catalogVersionId !== policy.catalogVersionId
    || checkpoint.manifestSetHash !== policy.manifestSetHash
    || !/^[1-9][0-9]*$/.test(checkpoint.fencingToken)
    || stableStringify(checkpoint.physicalRefs) !== stableStringify(expectedGroups)
    || stableStringify(checkpoint.targets) !== stableStringify(expectedTargets)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(committedAt)
    || expiresAt <= committedAt
  ) {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
      "缺少 #56 治理协调器在 COMMITTING 点签发的可验证串行化证明。",
    );
  }
}

function commandHash(command: ReserveConfigIdBundleCommand) {
  return sha256({
    modelId: command.modelId,
    expectedModelRevisionId: command.expectedModelRevisionId,
    part: command.part,
    expectedNormalizedStableModelKey: command.expectedNormalizedStableModelKey,
    policyVersionId: command.policyVersionId,
    expectedManifestSetHash: command.expectedManifestSetHash,
    operationId: command.operationId,
    idempotencyKey: command.idempotencyKey,
  });
}

function occupiedIds(governance: ConfigIdGovernanceState) {
  return new Set(governance.reservationLedger.flatMap((entry) => [
    entry.bundle.tackleItem.configNumericId,
    entry.bundle.goodsBasic.configNumericId,
    entry.bundle.storeBuy.configNumericId,
  ]));
}

function nextBaseId(
  governance: ConfigIdGovernanceState,
  range: ConfigIdRangeDefinition,
): string | undefined {
  const cursor = governance.rangeCursors.find((entry) => entry.rangeId === range.rangeId);
  const minimum = assertDecimalId(range.minimumBaseId, "minimumBaseId");
  const maximum = assertDecimalId(range.maximumBaseId, "maximumBaseId");
  let candidate = cursor
    ? assertDecimalId(cursor.lastAllocatedBaseId, "lastAllocatedBaseId") + BigInt(1)
    : minimum;
  if (candidate < minimum) candidate = minimum;
  const occupied = occupiedIds(governance);
  while (candidate <= maximum) {
    const baseId = candidate.toString();
    const ids = deriveConfigIds(baseId);
    if (
      !baseId.endsWith(range.reservedBaseIdSuffix)
      && !occupied.has(ids.baseId)
      && !occupied.has(ids.goodsBasicId)
      && !occupied.has(ids.storeBuyId)
    ) {
      return baseId;
    }
    candidate += BigInt(1);
  }
  return undefined;
}

function assertNameAndModelUniqueness(
  governance: ConfigIdGovernanceState,
  model: PurchasableModel,
  bundle: ConfigIdBundle,
) {
  const conflict = governance.reservationLedger.find((entry) =>
    entry.modelId !== model.id
    && (
      entry.bundle.tackleItem.configNameKey === bundle.tackleItem.configNameKey
      || entry.bundle.goodsBasic.configNameKey === bundle.goodsBasic.configNameKey
      || entry.bundle.storeBuy.configNameKey === bundle.storeBuy.configNameKey
    ));
  if (conflict) {
    throw new ConfigIdGovernanceError("CONFIG_NAME_KEY_CONFLICT", "配置名称已被永久 ledger 占用。");
  }
}

export function reserveConfigIdBundle(
  inputState: WorkspaceState,
  command: ReserveConfigIdBundleCommand,
  context: ReserveConfigIdBundleContext,
): ReserveConfigIdBundleTransition {
  const state = structuredClone(inputState);
  const governance = migrateConfigIdGovernanceState(state.configIdGovernance);
  const hash = commandHash(command);
  const priorByKey = governance.reservationIdempotency.find((entry) =>
    entry.idempotencyKey === command.idempotencyKey);
  if (priorByKey) {
    if (priorByKey.modelId !== command.modelId || priorByKey.commandHash !== hash) {
      throw new ConfigIdGovernanceError("IDEMPOTENCY_KEY_REUSED", "同一幂等键不能用于不同预留命令。");
    }
    return { state: inputState, result: structuredClone(priorByKey.result), idempotent: true, existing: false };
  }

  const policy = governance.policies.find((entry) =>
    entry.policyVersionId === command.policyVersionId && entry.status === "PUBLISHED");
  if (!policy) {
    throw new ConfigIdGovernanceError("CONFIG_ID_POLICY_UNPUBLISHED", "ConfigIdPolicyVersion 未发布。");
  }
  if (
    command.expectedManifestSetHash !== policy.manifestSetHash
  ) {
    throw new ConfigIdGovernanceError("CONFIG_TARGET_SCAN_MANIFEST_STALE", "命令引用的 Manifest 集合已过期。");
  }

  const model = state.purchasableModels.find((entry) => entry.id === command.modelId);
  if (!model) {
    throw new ConfigIdGovernanceError("MODEL_NOT_FOUND", "Model 不存在。");
  }
  const normalizedExpected = normalizeStableModelKey(command.expectedNormalizedStableModelKey);
  if (normalizedExpected !== command.expectedNormalizedStableModelKey) {
    throw new ConfigIdGovernanceError(
      "STABLE_MODEL_KEY_INVALID",
      "expectedNormalizedStableModelKey 必须已经是规范化结果。",
    );
  }
  const normalizedActual = model.stableModelKey === undefined
    ? undefined
    : normalizeStableModelKey(model.stableModelKey);
  const actualPart = partForModel(state, model);
  if (
    String(model.revision) !== command.expectedModelRevisionId
    || actualPart !== command.part
    || normalizedActual !== normalizedExpected
  ) {
    throw new ConfigIdGovernanceError(
      "MODEL_REVISION_CONFLICT",
      "Model head revision、部位或 stableModelKey 已变化；未消耗编号。",
    );
  }

  if (model.configIdBundleRef) {
    const existing = governance.reservationLedger.find((entry) =>
      entry.bundle.bundleId === model.configIdBundleRef && entry.modelId === model.id);
    if (
      existing
      && existing.bundle.part === command.part
      && existing.bundle.stableModelKey === normalizedExpected
    ) {
      const historicalRange = governance.policies
        .flatMap((candidate) => candidate.ranges)
        .find((range) => range.rangeId === existing.rangeId);
      if (!historicalRange) {
        throw new ConfigIdGovernanceError(
          "CONFIG_ID_RANGE_MISSING",
          `Ledger 引用的稳定 rangeId ${existing.rangeId} 不存在。`,
        );
      }
      return {
        state: inputState,
        result: {
          modelId: model.id,
          reservedAgainstModelRevisionId: existing.reservedAgainstModelRevisionId ?? `${model.id}@${model.revision}`,
          resultingModelRevisionId: existing.resultingModelRevisionId ?? `${model.id}@${model.revision}`,
          bundle: structuredClone(existing.bundle),
          leaseId: existing.leaseId ?? "",
          fencingToken: existing.fencingToken ?? "",
          capacity: configIdCapacityStatus(
            historicalRange,
            governance.reservationLedger.filter((entry) => entry.rangeId === existing.rangeId).length,
          ),
        },
        idempotent: false,
        existing: true,
      };
    }
    throw new ConfigIdGovernanceError("MODEL_CONFIG_IDENTITY_CONFLICT", "Model 的冻结 Bundle 与命令身份不一致。");
  }

  const physicalGroups = verifyConfigTargetManifestFreshness(
    governance,
    policy,
    context.observedTargets,
  );
  const manifests = policyManifests(governance, policy).manifests;
  const expectedTargets = manifests.map((manifest) => ({
    targetEntryId: manifest.targetEntryId,
    repositoryId: manifest.repositoryId,
    authoritativeRef: manifest.authoritativeRef,
    expectedCommitOid: manifest.resolvedCommitOid,
    configTomlHash: manifest.configTomlHash,
    workbookSetHash: manifest.workbookSetHash,
  })).sort((left, right) => compareText(left.targetEntryId, right.targetEntryId));
  assertSerializationCheckpoint(
    context.serializationCheckpoint,
    command.operationId,
    policy,
    physicalGroups,
    expectedTargets,
    context.now,
  );

  const ranges = policy.ranges.filter((range) => range.part === command.part);
  if (!ranges.length) {
    throw new ConfigIdGovernanceError("CONFIG_ID_RANGE_MISSING", "策略没有当前部位的分配区间。");
  }
  let selectedRange: ConfigIdRangeDefinition | undefined;
  let baseId: string | undefined;
  for (const range of ranges) {
    baseId = nextBaseId(governance, range);
    if (baseId) {
      selectedRange = range;
      break;
    }
  }
  if (!selectedRange || !baseId) {
    throw new ConfigIdGovernanceError("CONFIG_ID_RANGE_EXHAUSTED", "当前部位的全部配置 ID 区间已耗尽。");
  }

  const bundle = bundleFor(baseId, command.part, normalizedExpected, model.id);
  assertNameAndModelUniqueness(governance, model, bundle);

  const resultingModel: PurchasableModel = {
    ...structuredClone(model),
    revision: model.revision + 1,
    stableModelKey: normalizedExpected,
    configIdBundleRef: bundle.bundleId,
    updatedAt: context.now,
  };
  const resultRevisionId = `${model.id}@${resultingModel.revision}`;
  const reservedRevisionId = `${model.id}@${model.revision}`;
  const usedAfter = governance.reservationLedger.filter((entry) =>
    entry.rangeId === selectedRange!.rangeId).length + 1;
  const capacity = configIdCapacityStatus(selectedRange, usedAfter);
  const checkpoint = context.serializationCheckpoint!;
  const result: ConfigIdReservationResultRecord = {
    modelId: model.id,
    reservedAgainstModelRevisionId: reservedRevisionId,
    resultingModelRevisionId: resultRevisionId,
    bundle,
    leaseId: checkpoint.leaseId,
    fencingToken: checkpoint.fencingToken,
    capacity,
  };
  const entry: ConfigIdReservationLedgerEntry = {
    ledgerEntryId: `config-id-ledger:${bundle.bundleId}`,
    bundle,
    rangeId: selectedRange.rangeId,
    modelId: model.id,
    status: "RESERVED",
    policyVersionId: policy.policyVersionId,
    reservedAgainstModelRevisionId: reservedRevisionId,
    resultingModelRevisionId: resultRevisionId,
    leaseId: checkpoint.leaseId,
    fencingToken: checkpoint.fencingToken,
    manifestSetHash: policy.manifestSetHash,
    targetEntryIds: manifests.map((manifest) => manifest.targetEntryId).sort(compareText),
    createdBy: context.actor,
    createdAt: context.now,
    updatedBy: context.actor,
    updatedAt: context.now,
  };
  const cursor: ConfigIdRangeCursor = {
    rangeId: selectedRange.rangeId,
    lastAllocatedBaseId: baseId,
    updatedAt: context.now,
  };
  const nextGovernance: ConfigIdGovernanceState = {
    ...governance,
    rangeCursors: [
      ...governance.rangeCursors.filter((item) => item.rangeId !== selectedRange!.rangeId),
      cursor,
    ],
    reservationLedger: [...governance.reservationLedger, entry],
    reservationIdempotency: [...governance.reservationIdempotency, {
      idempotencyKey: command.idempotencyKey,
      modelId: command.modelId,
      commandHash: hash,
      result,
      committedAt: context.now,
    }],
    modelRevisionArchive: governance.modelRevisionArchive.some((item) =>
      item.id === model.id && item.revision === model.revision)
      ? governance.modelRevisionArchive
      : [...governance.modelRevisionArchive, structuredClone(model)],
    auditLog: [...governance.auditLog, auditRecord(
      "RESERVE_CONFIG_ID_BUNDLE", context.actor, context.now, bundle.bundleId, entry,
    )],
  };
  const modelIndex = state.purchasableModels.findIndex((item) => item.id === model.id);
  state.purchasableModels[modelIndex] = resultingModel;
  state.configIdGovernance = nextGovernance;
  return { state, result, idempotent: false, existing: false };
}

export function transitionConfigIdBundleState(
  inputState: WorkspaceState,
  input: {
    bundleId: string;
    nextStatus: "ABANDONED" | "DEPRECATED";
    actor: string;
    occurredAt: string;
    reason: string;
  },
): WorkspaceState {
  const state = structuredClone(inputState);
  const governance = migrateConfigIdGovernanceState(state.configIdGovernance);
  const index = governance.reservationLedger.findIndex((entry) => entry.bundle.bundleId === input.bundleId);
  const current = governance.reservationLedger[index];
  if (!current) throw new ConfigIdGovernanceError("CONFIG_ID_BUNDLE_NOT_FOUND", "Bundle 不存在。");
  if (current.status !== "RESERVED" && current.status !== input.nextStatus) {
    throw new ConfigIdGovernanceError("CONFIG_ID_BUNDLE_STATE_CONFLICT", "永久占用状态不能反向或跨对象改写。");
  }
  if (current.status === input.nextStatus) return inputState;
  const next = {
    ...current,
    status: input.nextStatus,
    updatedBy: input.actor,
    updatedAt: input.occurredAt,
    reason: input.reason,
  };
  governance.reservationLedger[index] = next;
  governance.auditLog.push(auditRecord(
    "TRANSITION_CONFIG_ID_BUNDLE", input.actor, input.occurredAt,
    input.bundleId, next, current, input.reason,
  ));
  state.configIdGovernance = governance;
  return state;
}

export function assertFrozenConfigIdentityTransition(
  current: WorkspaceState,
  proposed: WorkspaceState,
) {
  for (const model of current.purchasableModels.filter((entry) => entry.configIdBundleRef)) {
    const next = proposed.purchasableModels.find((entry) => entry.id === model.id);
    if (
      !next
      || next.configIdBundleRef !== model.configIdBundleRef
      || next.stableModelKey !== model.stableModelKey
      || next.skuId !== model.skuId
      || partForModel(proposed, next) !== partForModel(current, model)
    ) {
      throw new ConfigIdGovernanceError(
        "MODEL_CONFIG_IDENTITY_FROZEN",
        `Model ${model.id} 的 part、stableModelKey 或 ConfigIdBundle 已冻结。`,
      );
    }
  }
  const nextLedger = migrateConfigIdGovernanceState(proposed.configIdGovernance).reservationLedger;
  for (const entry of migrateConfigIdGovernanceState(current.configIdGovernance).reservationLedger) {
    const next = nextLedger.find((candidate) => candidate.ledgerEntryId === entry.ledgerEntryId);
    if (
      !next
      || next.bundle.bundleId !== entry.bundle.bundleId
      || stableStringify(next.bundle) !== stableStringify(entry.bundle)
      || next.rangeId !== entry.rangeId
      || next.modelId !== entry.modelId
    ) {
      throw new ConfigIdGovernanceError(
        "CONFIG_ID_LEDGER_IMMUTABLE_IDENTITY",
        `Ledger ${entry.ledgerEntryId} 的永久身份不能删除、释放、转让或改号。`,
      );
    }
  }
  for (const snapshot of current.configurationSnapshots) {
    const next = proposed.configurationSnapshots.find((entry) => entry.id === snapshot.id);
    if (!next || stableStringify(next) !== stableStringify(snapshot)) {
      throw new ConfigIdGovernanceError(
        "PUBLISHED_CONFIGURATION_SNAPSHOT_FROZEN",
        `已发布 ConfigurationSnapshot ${snapshot.id} 不可被上游治理静默重算或删除。`,
      );
    }
  }
}
