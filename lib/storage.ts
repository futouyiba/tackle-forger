import { env } from "cloudflare:workers";
import { createSeedState } from "./seed";
import type { RevisionInfo, WorkspaceState } from "./types";
import { ensureWorkflowFields } from "./workflow";

type StorageEnv = {
  DB?: D1Database;
  FILES?: R2Bucket;
};

const runtime = env as unknown as StorageEnv;

async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS workspace_state (id TEXT PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS workspace_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL UNIQUE, state_json TEXT NOT NULL, author TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS imported_files (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, r2_key TEXT NOT NULL)",
    ),
  ]);
}

export function getRuntimeStorage() {
  return runtime;
}

export async function loadWorkspaceState(): Promise<{
  state: WorkspaceState;
  revision: number;
}> {
  const db = runtime.DB;
  if (!db) return { state: createSeedState(), revision: 1 };
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT state_json, revision FROM workspace_state WHERE id = ?")
    .bind("main")
    .first<{ state_json: string; revision: number }>();

  if (row) {
    return { state: ensureWorkflowFields(JSON.parse(row.state_json) as WorkspaceState), revision: row.revision };
  }

  const state = createSeedState();
  const now = new Date().toISOString();
  const json = JSON.stringify(state);
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspace_state (id, state_json, revision, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("main", json, 1, "Excel 导入", now),
    db
      .prepare(
        "INSERT INTO workspace_revisions (revision, state_json, author, message, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(1, json, "Excel 导入", "从两份工作簿创建初始版本", now),
  ]);
  return { state, revision: 1 };
}

export async function saveWorkspaceState(input: {
  state: WorkspaceState;
  baseRevision: number;
  author: string;
  message: string;
}): Promise<{ revision: number; conflict?: boolean }> {
  const db = runtime.DB;
  if (!db) return { revision: input.baseRevision + 1 };
  await ensureSchema(db);
  const current = await db
    .prepare("SELECT revision FROM workspace_state WHERE id = ?")
    .bind("main")
    .first<{ revision: number }>();
  if (current && current.revision !== input.baseRevision) {
    return { revision: current.revision, conflict: true };
  }

  const revision = input.baseRevision + 1;
  const now = new Date().toISOString();
  const json = JSON.stringify(input.state);
  const updated = await db
    .prepare(
      "UPDATE workspace_state SET state_json = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?",
    )
    .bind(json, revision, input.author, now, "main", input.baseRevision)
    .run();

  if (!updated.meta.changes) {
    return { revision: current?.revision ?? input.baseRevision, conflict: true };
  }
  await db
    .prepare(
      "INSERT INTO workspace_revisions (revision, state_json, author, message, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(revision, json, input.author, input.message, now)
    .run();
  return { revision };
}

export async function listRevisions(): Promise<RevisionInfo[]> {
  const db = runtime.DB;
  if (!db) return createSeedState().revisions;
  await ensureSchema(db);
  const result = await db
    .prepare(
      "SELECT revision, author, message, created_at FROM workspace_revisions ORDER BY revision DESC LIMIT 100",
    )
    .all<{ revision: number; author: string; message: string; created_at: string }>();
  return result.results.map((row) => ({
    revision: row.revision,
    author: row.author,
    message: row.message,
    createdAt: row.created_at,
  }));
}

export async function loadRevision(revision: number): Promise<WorkspaceState | null> {
  const db = runtime.DB;
  if (!db) return revision === 1 ? createSeedState() : null;
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT state_json FROM workspace_revisions WHERE revision = ?")
    .bind(revision)
    .first<{ state_json: string }>();
  return row ? ensureWorkflowFields(JSON.parse(row.state_json) as WorkspaceState) : null;
}

export async function saveImportedFile(file: File, author: string) {
  const bucket = runtime.FILES;
  const db = runtime.DB;
  const id = crypto.randomUUID();
  const key = "imports/" + new Date().toISOString().slice(0, 10) + "/" + id + "-" + file.name;
  if (bucket) {
    await bucket.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { originalName: file.name, author },
    });
  }
  if (db) {
    await ensureSchema(db);
    await db
      .prepare(
        "INSERT INTO imported_files (id, file_name, content_type, size, uploaded_by, uploaded_at, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        file.name,
        file.type || "application/octet-stream",
        file.size,
        author,
        new Date().toISOString(),
        key,
      )
      .run();
  }
  return { id, key, stored: Boolean(bucket) };
}
