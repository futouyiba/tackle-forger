import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createSeedState } from "./seed";
import type { RevisionInfo, WorkspaceState } from "./types";
import { ensureWorkflowFields } from "./workflow";

type StoredRevision = RevisionInfo & { state: WorkspaceState };

const databases = new Map<string, Promise<DatabaseSync>>();

async function openDatabase(databasePath: string) {
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

export async function closeSqliteStorage(databasePath: string) {
  const resolved = path.resolve(databasePath);
  const pending = databases.get(resolved);
  if (!pending) return;
  const db = await pending;
  if (db.isOpen) db.close();
  databases.delete(resolved);
}
function seedDatabase(db: DatabaseSync) {
  const existing = db.prepare("SELECT revision FROM workspace_state WHERE id = ?").get("main") as
    | { revision: number }
    | undefined;
  if (existing) return;
  const state = createSeedState();
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

export async function loadSqliteWorkspace(databasePath: string) {
  const db = await openDatabase(databasePath);
  seedDatabase(db);
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
  seedDatabase(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT revision FROM workspace_state WHERE id = ?").get("main") as { revision: number };
    if (current.revision !== input.baseRevision) {
      db.exec("ROLLBACK");
      return { revision: current.revision, conflict: true as const };
    }
    const revision = input.baseRevision + 1;
    const createdAt = new Date().toISOString();
    const info: RevisionInfo = { revision, author: input.author, message: input.message, createdAt };
    const savedState = ensureWorkflowFields(structuredClone(input.state));
    savedState.revisions = [info, ...(savedState.revisions ?? []).filter((entry) => entry.revision !== revision)].slice(0, 100);
    const json = JSON.stringify(savedState);
    const updated = db.prepare("UPDATE workspace_state SET state_json = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(json, revision, input.author, createdAt, "main", input.baseRevision);
    if (updated.changes !== 1) {
      db.exec("ROLLBACK");
      const latest = db.prepare("SELECT revision FROM workspace_state WHERE id = ?").get("main") as { revision: number } | undefined;
      return { revision: latest?.revision ?? input.baseRevision, conflict: true as const };
    }
    db.prepare("INSERT INTO workspace_revisions (revision, state_json, author, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(revision, json, input.author, input.message, createdAt);
    db.exec("COMMIT");
    return { revision };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function listSqliteRevisions(databasePath: string): Promise<RevisionInfo[]> {
  const db = await openDatabase(databasePath);
  seedDatabase(db);
  const rows = db.prepare("SELECT revision, author, message, created_at FROM workspace_revisions ORDER BY revision DESC LIMIT 100").all() as Array<{
    revision: number; author: string; message: string; created_at: string;
  }>;
  return rows.map((row) => ({ revision: row.revision, author: row.author, message: row.message, createdAt: row.created_at }));
}

export async function loadSqliteRevision(databasePath: string, revision: number) {
  const db = await openDatabase(databasePath);
  seedDatabase(db);
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
