import { deterministicHash } from "./rule-kernel";

export interface MethodTemplateWriteCommand {
  sheetId: "m3eQCg";
  cell: string;
  value: string | number;
  stableId: string;
}

export interface MethodTemplateWritePreparation {
  id: string;
  sourceRevision: string;
  sourceHash: string;
  idempotencyKey: string;
  commands: MethodTemplateWriteCommand[];
  approvedBy?: string;
  state: "PREPARED" | "APPROVED";
}

export interface MethodTemplateWriteAdapter {
  getCurrentRevision(): Promise<string>;
  write(input: { expectedRevision: string; idempotencyKey: string; commands: MethodTemplateWriteCommand[] }): Promise<void>;
  readback(commands: MethodTemplateWriteCommand[]): Promise<Array<{ cell: string; value: string | number; stableId: string }>>;
}

export interface MethodTemplateWriteResult {
  state: "REMOTE_CHANGES_AVAILABLE" | "NEEDS_REBASE" | "WRITE_FAILED";
  preparation: MethodTemplateWritePreparation;
  verificationErrors: string[];
  recoveredAfterWriteError: boolean;
}

/** Creates immutable evidence only. This never contacts Feishu or activates rules. */
export function prepareMethodTemplateWrite(input: {
  sourceRevision: string;
  sourceHash: string;
  idempotencyKey: string;
  commands: MethodTemplateWriteCommand[];
}): MethodTemplateWritePreparation {
  if (!input.sourceRevision || !input.sourceHash || !input.idempotencyKey || !input.commands.length) throw new Error("02.5 写回准备缺少冻结基线、幂等键或精确单元格。");
  if (input.commands.some((command) => command.sheetId !== "m3eQCg" || !command.cell || !command.stableId)) throw new Error("02.5 写回只能包含带稳定 ID 的精确 m3eQCg 单元格。");
  const payload = { sourceRevision: input.sourceRevision, sourceHash: input.sourceHash, idempotencyKey: input.idempotencyKey, commands: input.commands };
  return { id: `method-template-write:${deterministicHash(payload)}`, ...payload, commands: structuredClone(input.commands), state: "PREPARED" };
}

export function approveMethodTemplateWrite(preparation: MethodTemplateWritePreparation, approvedBy: string): MethodTemplateWritePreparation {
  if (preparation.state !== "PREPARED" || !approvedBy.trim()) throw new Error("02.5 写回必须由人工审核后才能执行。");
  return { ...preparation, approvedBy: approvedBy.trim(), state: "APPROVED" };
}

/** Write + readback only; successful activation is represented solely by REMOTE_CHANGES_AVAILABLE. */
export async function executeMethodTemplateWrite(preparation: MethodTemplateWritePreparation, adapter: MethodTemplateWriteAdapter): Promise<MethodTemplateWriteResult> {
  if (preparation.state !== "APPROVED") throw new Error("02.5 写回尚未人工审核。");
  const currentRevision = await adapter.getCurrentRevision();
  if (currentRevision !== preparation.sourceRevision) return { state: "NEEDS_REBASE", preparation, verificationErrors: [`源 revision 已从 ${preparation.sourceRevision} 变为 ${currentRevision}。`], recoveredAfterWriteError: false };
  let writeFailed = false;
  try { await adapter.write({ expectedRevision: preparation.sourceRevision, idempotencyKey: preparation.idempotencyKey, commands: preparation.commands }); } catch { writeFailed = true; }
  const readback = await adapter.readback(preparation.commands);
  const actual = new Map(readback.map((entry) => [entry.cell, entry]));
  const verificationErrors = preparation.commands.flatMap((command) => {
    const entry = actual.get(command.cell);
    return entry && entry.stableId === command.stableId && entry.value === command.value ? [] : [`${command.cell} 回读不匹配。`];
  });
  return { state: verificationErrors.length ? "WRITE_FAILED" : "REMOTE_CHANGES_AVAILABLE", preparation, verificationErrors, recoveredAfterWriteError: writeFailed && !verificationErrors.length };
}
