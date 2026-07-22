import { deterministicHash } from "./rule-kernel";
import type { FeishuWorkbookRef } from "./feishu-workbook";

export type SourceIdentityMigrationMode = "INITIAL_MIGRATION" | "CONTINUOUS_SYNC";
export type SourceIdentityRowState =
  | "ALREADY_IDENTIFIED"
  | "MATCH_CANDIDATE"
  | "NEW_ID_CANDIDATE"
  | "AMBIGUOUS_MATCH"
  | "NEW_SOURCE_ROW"
  | "CONFLICT";

export interface SourceIdentityRow {
  sheetId: string;
  rowKey: string;
  displayName: string;
  entityType: string;
  level?: string | number;
  stableId?: string;
  idColumnKey: string;
}

export interface ExistingStableEntity {
  entityId: string;
  displayName: string;
  entityType?: string;
  legacyKeys?: string[];
}

export interface SourceIdentityPolicy {
  sheetId: string;
  allowedEntityTypes: string[];
  idPrefixesByEntityType: Record<string, string[]>;
}

export interface SourceIdentityMigrationItem {
  itemId: string;
  sheetId: string;
  rowKey: string;
  displayName: string;
  legacyDisplayKey: string;
  sourceEntityType: string;
  observedStableId?: string;
  proposedStableId?: string;
  candidateEntityIds: string[];
  state: SourceIdentityRowState;
  requiresHumanConfirmation: boolean;
  reasons: string[];
}

export interface SourceIdentityMigrationReport {
  reportId: string;
  workbookRefId: string;
  sourceRevision: string;
  mode: SourceIdentityMigrationMode;
  generatedAt: string;
  items: SourceIdentityMigrationItem[];
  blockingIssueCodes: string[];
  inputHash: string;
}

export interface SourceIdentityConfirmation {
  itemId: string;
  confirmedStableId: string;
  decision: "MATCH_EXISTING" | "ASSIGN_NEW";
  confirmedBy: string;
}

export interface StableIdWriteCommand {
  sheetId: string;
  rowKey: string;
  idColumnKey: string;
  stableId: string;
}

export interface StableIdWriteAdapter {
  getCurrentRevision(workbook: FeishuWorkbookRef): Promise<string>;
  writeStableIds(input: {
    workbook: FeishuWorkbookRef;
    expectedSourceRevision: string;
    idempotencyKey: string;
    commands: StableIdWriteCommand[];
  }): Promise<void>;
  readStableIds(input: {
    workbook: FeishuWorkbookRef;
    commands: StableIdWriteCommand[];
  }): Promise<Array<{ sheetId: string; rowKey: string; stableId?: string }>>;
}

export interface StableIdWriteResult {
  state: "WRITE_VERIFIED" | "WRITE_FAILED" | "NEEDS_REBASE";
  commands: StableIdWriteCommand[];
  idempotencyKey: string;
  verificationErrors: string[];
  recoveredAfterWriteError: boolean;
}

function normalized(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function legacyDisplayKey(row: SourceIdentityRow) {
  return row.level === undefined || String(row.level).trim() === ""
    ? row.displayName.trim()
    : `${row.displayName.trim()}|${String(row.level).trim()}`;
}

function proposedId(workbookRefId: string, row: SourceIdentityRow, prefix = "rule_") {
  const first = deterministicHash({ workbookRefId, sheetId: row.sheetId, rowKey: row.rowKey });
  const second = deterministicHash({ rowKey: row.rowKey, sheetId: row.sheetId, workbookRefId });
  return `${prefix}${first}${second}`;
}

export function prepareSourceIdentityMigration(input: {
  workbookRefId: string;
  sourceRevision: string;
  mode: SourceIdentityMigrationMode;
  rows: SourceIdentityRow[];
  existingEntities: ExistingStableEntity[];
  identityPolicies?: SourceIdentityPolicy[];
  generatedAt: string;
}): SourceIdentityMigrationReport {
  const duplicateObservedIds = new Set<string>();
  const observedCounts = new Map<string, number>();
  for (const row of input.rows) {
    const id = row.stableId?.trim();
    if (!id) continue;
    observedCounts.set(id, (observedCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of observedCounts) if (count > 1) duplicateObservedIds.add(id);

  const candidates = new Map<string, string[]>();
  for (const entity of input.existingEntities) {
    const keys = new Set([entity.displayName, ...(entity.legacyKeys ?? [])].map(normalized));
    for (const key of keys) {
      const candidateKey = `${entity.entityType ?? "*"}:${key}`;
      candidates.set(candidateKey, [...(candidates.get(candidateKey) ?? []), entity.entityId]);
    }
  }
  const policyBySheet = new Map((input.identityPolicies ?? []).map((policy) => [policy.sheetId, policy]));

  const items = input.rows.map((row): SourceIdentityMigrationItem => {
    const observedStableId = row.stableId?.trim() || undefined;
    const displayKey = legacyDisplayKey(row);
    const itemId = `identity-row:${deterministicHash({ sheetId: row.sheetId, rowKey: row.rowKey })}`;
    if (observedStableId) {
      const policy = policyBySheet.get(row.sheetId);
      const policyErrors: string[] = [];
      if (policy && !policy.allowedEntityTypes.includes(row.entityType)) {
        policyErrors.push(`实体类型 ${row.entityType} 不属于工作表 ${row.sheetId} 的允许类型。`);
      }
      const prefixes = policy?.idPrefixesByEntityType[row.entityType] ?? [];
      if (prefixes.length && !prefixes.some((prefix) => observedStableId.startsWith(prefix))) {
        policyErrors.push(`稳定 ID ${observedStableId} 不符合 ${row.entityType} 的前缀约定 ${prefixes.join("/")}。`);
      }
      const duplicate = duplicateObservedIds.has(observedStableId);
      if (duplicate) policyErrors.push(`稳定 ID ${observedStableId} 在源表中重复。`);
      return {
        itemId,
        sheetId: row.sheetId,
        rowKey: row.rowKey,
        displayName: row.displayName,
        legacyDisplayKey: displayKey,
        sourceEntityType: row.entityType,
        observedStableId,
        candidateEntityIds: [],
        state: policyErrors.length ? "CONFLICT" : "ALREADY_IDENTIFIED",
        requiresHumanConfirmation: false,
        reasons: policyErrors.length ? policyErrors : ["源行已包含稳定 ID；迁移器不会生成替换 ID。"],
      };
    }
    if (input.mode === "CONTINUOUS_SYNC") {
      return {
        itemId,
        sheetId: row.sheetId,
        rowKey: row.rowKey,
        displayName: row.displayName,
        legacyDisplayKey: displayKey,
        sourceEntityType: row.entityType,
        proposedStableId: proposedId(input.workbookRefId, row, policyBySheet.get(row.sheetId)?.idPrefixesByEntityType[row.entityType]?.[0]),
        candidateEntityIds: [],
        state: "NEW_SOURCE_ROW",
        requiresHumanConfirmation: true,
        reasons: ["首轮迁移后出现缺少稳定 ID 的新行；禁止按名称猜测旧对象。"],
      };
    }
    const matches = Array.from(new Set([
      ...(candidates.get(`${row.entityType}:${normalized(displayKey)}`) ?? []),
      ...(candidates.get(`${row.entityType}:${normalized(row.displayName)}`) ?? []),
      ...(candidates.get(`*:${normalized(displayKey)}`) ?? []),
      ...(candidates.get(`*:${normalized(row.displayName)}`) ?? []),
    ])).sort();
    const preferredPrefix = policyBySheet.get(row.sheetId)?.idPrefixesByEntityType[row.entityType]?.[0];
    return {
      itemId,
      sheetId: row.sheetId,
      rowKey: row.rowKey,
      displayName: row.displayName,
      legacyDisplayKey: displayKey,
      sourceEntityType: row.entityType,
      proposedStableId: matches.length === 1 ? matches[0] : proposedId(input.workbookRefId, row, preferredPrefix),
      candidateEntityIds: matches,
      state: matches.length > 1 ? "AMBIGUOUS_MATCH" : matches.length === 1 ? "MATCH_CANDIDATE" : "NEW_ID_CANDIDATE",
      requiresHumanConfirmation: true,
      reasons: matches.length > 1
        ? ["名称候选命中多个对象，必须人工选择。"]
        : matches.length === 1
          ? ["名称仅用于首轮迁移候选；确认后长期关联只使用稳定 ID。"]
          : ["未命中旧对象，建议分配新的稳定 ID。"],
    };
  });
  const blockingIssueCodes = items.some((item) => item.state === "CONFLICT")
    ? ["SOURCE_STABLE_ID_DUPLICATE"]
    : [];
  const content = {
    workbookRefId: input.workbookRefId,
    sourceRevision: input.sourceRevision,
    mode: input.mode,
    generatedAt: input.generatedAt,
    items,
    blockingIssueCodes,
  };
  const inputHash = deterministicHash(content);
  return { reportId: `identity-migration:${inputHash}`, ...content, inputHash };
}

export function buildStableIdWriteCommands(input: {
  report: SourceIdentityMigrationReport;
  rows: SourceIdentityRow[];
  confirmations: SourceIdentityConfirmation[];
}): StableIdWriteCommand[] {
  if (input.report.blockingIssueCodes.length) {
    throw new Error("ID 迁移报告存在阻断冲突，不能回写。");
  }
  const itemById = new Map(input.report.items.map((item) => [item.itemId, item]));
  const rowByKey = new Map(input.rows.map((row) => [`${row.sheetId}:${row.rowKey}`, row]));
  const confirmationByItem = new Map(input.confirmations.map((item) => [item.itemId, item]));
  const commands: StableIdWriteCommand[] = [];
  for (const item of input.report.items) {
    if (!item.requiresHumanConfirmation) continue;
    const confirmation = confirmationByItem.get(item.itemId);
    if (!confirmation?.confirmedStableId.trim()) {
      throw new Error(`源行 ${item.sheetId}/${item.rowKey} 尚未人工确认稳定 ID。`);
    }
    if (confirmation.decision === "MATCH_EXISTING" && !item.candidateEntityIds.includes(confirmation.confirmedStableId)) {
      throw new Error(`确认的旧对象 ${confirmation.confirmedStableId} 不在候选报告中。`);
    }
    const row = rowByKey.get(`${item.sheetId}:${item.rowKey}`);
    if (!row) throw new Error(`找不到迁移源行 ${item.sheetId}/${item.rowKey}。`);
    commands.push({
      sheetId: item.sheetId,
      rowKey: item.rowKey,
      idColumnKey: row.idColumnKey,
      stableId: confirmation.confirmedStableId.trim(),
    });
  }
  if (input.confirmations.some((confirmation) => !itemById.has(confirmation.itemId))) {
    throw new Error("确认列表包含不属于本次迁移报告的项目。");
  }
  const ids = commands.map((command) => command.stableId);
  if (new Set(ids).size !== ids.length) throw new Error("本次确认分配了重复稳定 ID。");
  return commands;
}

async function verifyWrites(
  workbook: FeishuWorkbookRef,
  commands: StableIdWriteCommand[],
  adapter: StableIdWriteAdapter,
) {
  const readback = await adapter.readStableIds({ workbook, commands });
  const readByKey = new Map(readback.map((row) => [`${row.sheetId}:${row.rowKey}`, row.stableId?.trim()]));
  return commands.flatMap((command) => {
    const actual = readByKey.get(`${command.sheetId}:${command.rowKey}`);
    return actual === command.stableId
      ? []
      : [`${command.sheetId}/${command.rowKey} 回读为 ${actual || "空"}，期望 ${command.stableId}。`];
  });
}

export async function executeStableIdWrite(input: {
  workbook: FeishuWorkbookRef;
  report: SourceIdentityMigrationReport;
  commands: StableIdWriteCommand[];
  idempotencyKey: string;
  adapter: StableIdWriteAdapter;
}): Promise<StableIdWriteResult> {
  const currentRevision = await input.adapter.getCurrentRevision(input.workbook);
  if (currentRevision !== input.report.sourceRevision) {
    return {
      state: "NEEDS_REBASE",
      commands: input.commands,
      idempotencyKey: input.idempotencyKey,
      verificationErrors: [`源 revision 已从 ${input.report.sourceRevision} 变为 ${currentRevision}。`],
      recoveredAfterWriteError: false,
    };
  }
  let writeFailed = false;
  try {
    await input.adapter.writeStableIds({
      workbook: input.workbook,
      expectedSourceRevision: input.report.sourceRevision,
      idempotencyKey: input.idempotencyKey,
      commands: input.commands,
    });
  } catch {
    writeFailed = true;
  }
  const verificationErrors = await verifyWrites(input.workbook, input.commands, input.adapter);
  return {
    state: verificationErrors.length ? "WRITE_FAILED" : "WRITE_VERIFIED",
    commands: input.commands,
    idempotencyKey: input.idempotencyKey,
    verificationErrors,
    recoveredAfterWriteError: writeFailed && verificationErrors.length === 0,
  };
}
