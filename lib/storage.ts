import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import path from "node:path";
import { createSeedState } from "./seed";
import type { RevisionInfo, WorkspaceState } from "./types";
import { ensureWorkflowFields } from "./workflow";
import {
  listSqliteRevisions,
  loadSqliteRevision,
  loadSqliteWorkspace,
  saveSqliteImportedFile,
  saveSqliteWorkspace,
} from "./sqlite-storage";

type StorageEnv = {
  DB?: D1Database;
  FILES?: R2Bucket;
};

type StoredRevision = RevisionInfo & {
  state: WorkspaceState;
};

type BlobWorkspaceDocument = {
  state: WorkspaceState;
  revision: number;
  revisions: StoredRevision[];
  updatedAt: string;
};

type LoadedBlobDocument = {
  document: BlobWorkspaceDocument;
  etag: string;
};

const WORKSPACE_BLOB_PATH = "workspace/main.json";
let runtimePromise: Promise<StorageEnv> | null = null;

function hasVercelBlob() {
  return typeof process !== "undefined" && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function workspaceSqliteDatabasePath() {
  if (typeof process === "undefined" || process.env.VERCEL) return undefined;
  return process.env.WORKSPACE_DATABASE_PATH?.trim() || ".data/workspace.sqlite";
}

const sqliteDatabasePath = workspaceSqliteDatabasePath;

function sqliteFileDataDir(databasePath: string) {
  return process.env.WORKSPACE_FILE_DATA_DIR?.trim()
    || path.join(path.dirname(path.resolve(databasePath)), "files");
}
async function getRuntimeStorage(): Promise<StorageEnv> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (typeof process !== "undefined" && process.env.VERCEL) return {};
    try {
      const specifier = "cloudflare:" + "workers";
      const cloudflare = (await import(
        /* webpackIgnore: true */
        /* @vite-ignore */
        specifier
      )) as { env?: StorageEnv };
      return cloudflare.env ?? {};
    } catch {
      return {};
    }
  })();
  return runtimePromise;
}

function createBlobDocument(): BlobWorkspaceDocument {
  const state = createSeedState();
  const initial = state.revisions[0] ?? {
    revision: 1,
    author: "Excel 导入",
    message: "从两份工作簿创建初始版本",
    createdAt: new Date().toISOString(),
  };
  return {
    state,
    revision: initial.revision,
    revisions: [{ ...initial, state }],
    updatedAt: initial.createdAt,
  };
}

let localWorkspaceDocument: BlobWorkspaceDocument | null = null;

function ensureLocalWorkspaceDocument() {
  localWorkspaceDocument ??= createBlobDocument();
  return localWorkspaceDocument;
}

function assertEphemeralStorageAllowed(action: "读取" | "保存" | "读取版本" | "存储导入文件") {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
    throw new Error(
      `生产环境未配置持久化存储，无法${action}工作区。请配置 WORKSPACE_DATABASE_PATH、Vercel Blob 或 D1/R2；禁止回退到进程内临时数据。`,
    );
  }
}

async function readBlobDocument(): Promise<LoadedBlobDocument | null> {
  const result = await get(WORKSPACE_BLOB_PATH, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  const document = JSON.parse(text) as BlobWorkspaceDocument;
  document.state = ensureWorkflowFields(document.state);
  document.revisions = (document.revisions ?? []).map((entry) => ({
    ...entry,
    state: ensureWorkflowFields(entry.state),
  }));
  return { document, etag: result.blob.etag.replace(/^W\//, "") };
}

async function ensureBlobDocument(): Promise<LoadedBlobDocument> {
  const current = await readBlobDocument();
  if (current) return current;

  const document = createBlobDocument();
  try {
    const created = await put(WORKSPACE_BLOB_PATH, JSON.stringify(document), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
    });
    return { document, etag: created.etag };
  } catch {
    const raced = await readBlobDocument();
    if (raced) return raced;
    throw new Error("无法初始化 Vercel Blob 工作区。");
  }
}

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

export async function loadWorkspaceState(): Promise<{
  state: WorkspaceState;
  revision: number;
}> {
  const sqlitePath = sqliteDatabasePath();
  if (sqlitePath) return loadSqliteWorkspace(sqlitePath);

  if (hasVercelBlob()) {
    const current = await ensureBlobDocument();
    return {
      state: ensureWorkflowFields(current.document.state),
      revision: current.document.revision,
    };
  }

  const runtime = await getRuntimeStorage();
  const db = runtime.DB;
  if (!db) {
    assertEphemeralStorageAllowed("读取");
    const document = ensureLocalWorkspaceDocument();
    return {
      state: ensureWorkflowFields(structuredClone(document.state)),
      revision: document.revision,
    };
  }
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT state_json, revision FROM workspace_state WHERE id = ?")
    .bind("main")
    .first<{ state_json: string; revision: number }>();

  if (row) {
    return {
      state: ensureWorkflowFields(JSON.parse(row.state_json) as WorkspaceState),
      revision: row.revision,
    };
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
  const sqlitePath = sqliteDatabasePath();
  if (sqlitePath) return saveSqliteWorkspace(sqlitePath, input);

  if (hasVercelBlob()) {
    const current = await ensureBlobDocument();
    if (current.document.revision !== input.baseRevision) {
      return { revision: current.document.revision, conflict: true };
    }

    const revision = input.baseRevision + 1;
    const createdAt = new Date().toISOString();
    const info: RevisionInfo = {
      revision,
      author: input.author,
      message: input.message,
      createdAt,
    };
    const savedState = ensureWorkflowFields(structuredClone(input.state));
    savedState.revisions = [
      info,
      ...(savedState.revisions ?? []).filter((entry) => entry.revision !== revision),
    ].slice(0, 100);
    const next: BlobWorkspaceDocument = {
      state: savedState,
      revision,
      revisions: [
        { ...info, state: savedState },
        ...current.document.revisions.filter((entry) => entry.revision !== revision),
      ].slice(0, 100),
      updatedAt: createdAt,
    };

    try {
      await put(WORKSPACE_BLOB_PATH, JSON.stringify(next), {
        access: "private",
        contentType: "application/json",
        allowOverwrite: true,
        ifMatch: current.etag,
        cacheControlMaxAge: 60,
      });
      return { revision };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        const latest = await readBlobDocument();
        return {
          revision: latest?.document.revision ?? input.baseRevision,
          conflict: true,
        };
      }
      throw error;
    }
  }

  const runtime = await getRuntimeStorage();
  const db = runtime.DB;
  if (!db) {
    assertEphemeralStorageAllowed("保存");
    const current = ensureLocalWorkspaceDocument();
    if (current.revision !== input.baseRevision) {
      return { revision: current.revision, conflict: true };
    }
    const revision = input.baseRevision + 1;
    const createdAt = new Date().toISOString();
    const info: RevisionInfo = {
      revision,
      author: input.author,
      message: input.message,
      createdAt,
    };
    const savedState = ensureWorkflowFields(structuredClone(input.state));
    savedState.revisions = [
      info,
      ...(savedState.revisions ?? []).filter((entry) => entry.revision !== revision),
    ].slice(0, 100);
    localWorkspaceDocument = {
      state: savedState,
      revision,
      revisions: [
        { ...info, state: structuredClone(savedState) },
        ...current.revisions.filter((entry) => entry.revision !== revision),
      ].slice(0, 100),
      updatedAt: createdAt,
    };
    return { revision };
  }
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
  const savedState = ensureWorkflowFields(structuredClone(input.state));
  const json = JSON.stringify(savedState);
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
  const sqlitePath = sqliteDatabasePath();
  if (sqlitePath) return listSqliteRevisions(sqlitePath);

  if (hasVercelBlob()) {
    const current = await ensureBlobDocument();
    return current.document.revisions.map((entry) => ({
      revision: entry.revision,
      author: entry.author,
      message: entry.message,
      createdAt: entry.createdAt,
    }));
  }

  const runtime = await getRuntimeStorage();
  const db = runtime.DB;
  if (!db) {
    assertEphemeralStorageAllowed("读取版本");
    return ensureLocalWorkspaceDocument().revisions.map((entry) => ({
      revision: entry.revision,
      author: entry.author,
      message: entry.message,
      createdAt: entry.createdAt,
    }));
  }
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
  const sqlitePath = sqliteDatabasePath();
  if (sqlitePath) return loadSqliteRevision(sqlitePath, revision);

  if (hasVercelBlob()) {
    const current = await ensureBlobDocument();
    const entry = current.document.revisions.find((item) => item.revision === revision);
    return entry ? ensureWorkflowFields(entry.state) : null;
  }

  const runtime = await getRuntimeStorage();
  const db = runtime.DB;
  if (!db) {
    assertEphemeralStorageAllowed("读取版本");
    const entry = ensureLocalWorkspaceDocument().revisions.find((item) => item.revision === revision);
    return entry ? ensureWorkflowFields(structuredClone(entry.state)) : null;
  }
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT state_json FROM workspace_revisions WHERE revision = ?")
    .bind(revision)
    .first<{ state_json: string }>();
  return row
    ? ensureWorkflowFields(JSON.parse(row.state_json) as WorkspaceState)
    : null;
}

export async function saveImportedFile(file: File, author: string) {
  const sqlitePath = sqliteDatabasePath();
  if (sqlitePath) return saveSqliteImportedFile(sqlitePath, sqliteFileDataDir(sqlitePath), file, author);

  const id = crypto.randomUUID();
  const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  const key =
    "imports/" + new Date().toISOString().slice(0, 10) + "/" + id + "-" + safeName;

  if (hasVercelBlob()) {
    await put(key, file, {
      access: "private",
      contentType: file.type || "application/octet-stream",
      addRandomSuffix: false,
    });
    return { id, key, stored: true };
  }

  const runtime = await getRuntimeStorage();
  const bucket = runtime.FILES;
  const db = runtime.DB;
  if (!bucket && !db) assertEphemeralStorageAllowed("存储导入文件");
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
