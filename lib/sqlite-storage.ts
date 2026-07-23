import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createSeedState } from "./seed";
import type { RevisionInfo, WorkspaceState } from "./types";
import { ensureWorkflowFields } from "./workflow";

type StoredRevision = RevisionInfo & { state: WorkspaceState };

const databases = new Map<string, Promise<DatabaseSync>>();
const transactionTails = new Map<string, Promise<void>>();
interface SqliteTransactionContext {
  key: string;
  rollbackHooks: Array<() => Promise<void>>;
}
const transactionContext = new AsyncLocalStorage<SqliteTransactionContext>();

export async function openSqliteDatabase(databasePath: string) {
  const resolved = path.resolve(databasePath);
  let pending = databases.get(resolved);
  if (!pending) {
    pending = (async () => {
      await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(resolved, { timeout: 5_000 });
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS storage_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_state (
          id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          revision INTEGER NOT NULL UNIQUE,
          state_json TEXT NOT NULL,
          author TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS imported_files (
          id TEXT PRIMARY KEY,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          uploaded_by TEXT NOT NULL,
          uploaded_at TEXT NOT NULL,
          r2_key TEXT NOT NULL
        );
      `);
      db.prepare("INSERT OR IGNORE INTO storage_migrations (version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
      await chmod(resolved, 0o600).catch(() => undefined);
      return db;
    })();
    databases.set(resolved, pending);
  }
  return pending;
}

const openDatabase = openSqliteDatabase;

export async function runSqliteImmediateTransaction<T>(
  databasePath: string,
  execute: (db: DatabaseSync) => Promise<T>,
): Promise<T> {
  const key = path.resolve(databasePath);
  const db = await openSqliteDatabase(databasePath);
  if (transactionContext.getStore()?.key === key && db.isTransaction) {
    return execute(db);
  }
  const prior = transactionTails.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(async () => {
    if (db.isTransaction) {
      throw new Error("检测到未完成的 SQLite 事务。");
    }
    db.exec("BEGIN IMMEDIATE");
    const context: SqliteTransactionContext = { key, rollbackHooks: [] };
    try {
      const result = await transactionContext.run(
        context,
        () => execute(db),
      );
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      for (const rollback of context.rollbackHooks.reverse()) {
        await rollback().catch(() => undefined);
      }
      throw error;
    }
  });
  const tail = run.then(() => undefined, () => undefined);
  transactionTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (transactionTails.get(key) === tail) transactionTails.delete(key);
  }
}

export async function waitForSqliteTransaction(databasePath: string) {
  const key = path.resolve(databasePath);
  if (transactionContext.getStore()?.key === key) return;
  while (true) {
    const tail = transactionTails.get(key);
    if (!tail) return;
    await tail;
    if (transactionTails.get(key) === tail) return;
  }
}

export function registerSqliteRollbackHook(
  databasePath: string,
  rollback: () => Promise<void>,
) {
  const context = transactionContext.getStore();
  if (!context || context.key !== path.resolve(databasePath)) return false;
  context.rollbackHooks.push(rollback);
  return true;
}

export async function closeSqliteStorage(databasePath: string) {
  const resolved = path.resolve(databasePath);
  const pending = databases.get(resolved);
  if (!pending) return;
  const db = await pending;
  if (db.isOpen) db.close();
  databases.delete(resolved);
}
export function ensureSqliteWorkspaceSeeded(db: DatabaseSync, initialState = createSeedState()) {
  const existing = db.prepare("SELECT revision FROM workspace_state WHERE id = ?").get("main") as
    | { revision: number }
    | undefined;
  if (existing) return;
  const state = initialState;
  const initial = state.revisions[0] ?? {
    revision: 1,
    author: "Excel 导入",
    message: "从两份工作簿创建初始版本",
    createdAt: new Date().toISOString(),
  };
  const json = JSON.stringify(state);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO workspace_state (id, state_json, revision, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("main", json, initial.revision, initial.author, initial.createdAt);
    db.prepare("INSERT INTO workspace_revisions (revision, state_json, author, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(initial.revision, json, initial.author, initial.message, initial.createdAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const seedDatabase = ensureSqliteWorkspaceSeeded;

export async function loadSqliteWorkspace(databasePath: string, initialState?: WorkspaceState) {
  const db = await openDatabase(databasePath);
  ensureSqliteWorkspaceSeeded(db, initialState ?? createSeedState());
  await waitForSqliteTransaction(databasePath);
  const row = db.prepare("SELECT state_json, revision FROM workspace_state WHERE id = ?").get("main") as {
    state_json: string;
    revision: number;
  };
  return {
    state: ensureWorkflowFields(JSON.parse(row.state_json) as WorkspaceState),
    revision: row.revision,
  };
}

export async function saveSqliteWorkspace(databasePath: string, input: {
  state: WorkspaceState;
  baseRevision: number;
  author: string;
  message: string;
}) {
  const db = await openDatabase(databasePath);
  ensureSqliteWorkspaceSeeded(db, input.state);
  return runSqliteImmediateTransaction(databasePath, async (transaction) => {
    const current = transaction.prepare("SELECT revision FROM workspace_state WHERE id = ?").get("main") as { revision: number };
    if (current.revision !== input.baseRevision) {
      return { revision: current.revision, conflict: true as const };
    }
    const revision = input.baseRevision + 1;
    const createdAt = new Date().toISOString();
    const info: RevisionInfo = { revision, author: input.author, message: input.message, createdAt };
    const savedState = ensureWorkflowFields(structuredClone(input.state));
    savedState.revisions = [info, ...(savedState.revisions ?? []).filter((entry) => entry.revision !== revision)].slice(0, 100);
    const json = JSON.stringify(savedState);
    const updated = transaction.prepare("UPDATE workspace_state SET state_json = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(json, revision, input.author, createdAt, "main", input.baseRevision);
    if (updated.changes !== 1) {
      const latest = transaction.prepare("SELECT revision FROM workspace_state WHERE id = ?").get("main") as { revision: number } | undefined;
      return { revision: latest?.revision ?? input.baseRevision, conflict: true as const };
    }
    transaction.prepare("INSERT INTO workspace_revisions (revision, state_json, author, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(revision, json, input.author, input.message, createdAt);
    return { revision };
  });
}

export async function listSqliteRevisions(databasePath: string): Promise<RevisionInfo[]> {
  const db = await openDatabase(databasePath);
  seedDatabase(db);
  await waitForSqliteTransaction(databasePath);
  const rows = db.prepare("SELECT revision, author, message, created_at FROM workspace_revisions ORDER BY revision DESC LIMIT 100").all() as Array<{
    revision: number; author: string; message: string; created_at: string;
  }>;
  return rows.map((row) => ({ revision: row.revision, author: row.author, message: row.message, createdAt: row.created_at }));
}

export async function loadSqliteRevision(databasePath: string, revision: number) {
  const db = await openDatabase(databasePath);
  seedDatabase(db);
  await waitForSqliteTransaction(databasePath);
  const row = db.prepare("SELECT state_json FROM workspace_revisions WHERE revision = ?").get(revision) as
    | { state_json: string }
    | undefined;
  return row ? ensureWorkflowFields(JSON.parse(row.state_json) as WorkspaceState) : null;
}

export async function saveSqliteImportedFile(databasePath: string, dataDir: string, file: File, author: string) {
  const db = await openDatabase(databasePath);
  const id = randomUUID();
  const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  const relativeKey = path.join("imports", new Date().toISOString().slice(0, 10), `${id}-${safeName}`);
  const target = path.join(path.resolve(dataDir), relativeKey);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 });
  await rename(temporary, target);
  registerSqliteRollbackHook(
    databasePath,
    () => unlink(target),
  );
  try {
    db.prepare("INSERT INTO imported_files (id, file_name, content_type, size, uploaded_by, uploaded_at, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, file.name, file.type || "application/octet-stream", file.size, author, new Date().toISOString(), relativeKey);
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
  return { id, key: relativeKey.replaceAll("\\", "/"), stored: true };
}

export async function importSqliteWorkspace(databasePath: string, document: {
  state: WorkspaceState;
  revision: number;
  revisions: StoredRevision[];
}) {
  const db = await openDatabase(databasePath);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM workspace_revisions; DELETE FROM workspace_state;");
    const state = ensureWorkflowFields(document.state);
    const current = document.revisions.find((entry) => entry.revision === document.revision) ?? document.revisions[0];
    const now = current?.createdAt ?? new Date().toISOString();
    db.prepare("INSERT INTO workspace_state (id, state_json, revision, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("main", JSON.stringify(state), document.revision, current?.author ?? "迁移", now);
    const insert = db.prepare("INSERT INTO workspace_revisions (revision, state_json, author, message, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const entry of document.revisions) {
      insert.run(entry.revision, JSON.stringify(ensureWorkflowFields(entry.state)), entry.author, entry.message, entry.createdAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
