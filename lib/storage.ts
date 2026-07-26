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
  WORKSPACE_STORAGE_BACKEND?: string;
  NITRO_PRESET?: string;
  CF_PAGES?: string;
  VERCEL?: string;
  NODE_ENV?: string;
};

type StorageEnvironment = Pick<
  StorageEnv,
  "WORKSPACE_STORAGE_BACKEND" | "NITRO_PRESET" | "CF_PAGES" | "VERCEL" | "NODE_ENV"
> & {
  WORKSPACE_DATABASE_PATH?: string;
  BLOB_READ_WRITE_TOKEN?: string;
};

export type WorkspaceStorageBackend = "sqlite" | "blob" | "d1" | "ephemeral";
export type WorkspaceDeploymentTarget = "r730" | "vercel_review" | "cloudflare_review" | "development";

export type WorkspaceStorageContract = {
  backend: WorkspaceStorageBackend;
  target: WorkspaceDeploymentTarget;
  explicit: boolean;
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

function processStorageEnvironment(): StorageEnvironment {
  return typeof process === "undefined"
    ? {}
    : process.env as StorageEnvironment;
}

function configuredBackend(value: string | undefined): WorkspaceStorageBackend | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === "sqlite" || normalized === "blob" || normalized === "d1" || normalized === "ephemeral") {
    return normalized;
  }
  throw new Error(
    "WORKSPACE_STORAGE_BACKEND_INVALID：WORKSPACE_STORAGE_BACKEND 必须为 sqlite、blob、d1 或 ephemeral。",
  );
}

function isCloudflareEnvironment(environment: StorageEnvironment) {
  return environment.CF_PAGES === "1"
    || environment.NITRO_PRESET?.startsWith("cloudflare") === true;
}

/**
 * Resolve the storage authority before probing credentials or bindings. Production
 * deployments must name their backend explicitly, so an incidental token/binding
 * can never silently change where the authoritative workspace is persisted.
 */
export function resolveWorkspaceStorageContract(
  environment: StorageEnvironment = processStorageEnvironment(),
): WorkspaceStorageContract {
  const backend = configuredBackend(environment.WORKSPACE_STORAGE_BACKEND);
  const production = environment.NODE_ENV === "production";
  const target: WorkspaceDeploymentTarget = environment.VERCEL === "1" || environment.NITRO_PRESET === "vercel"
    ? "vercel_review"
    : isCloudflareEnvironment(environment)
      ? "cloudflare_review"
      : production
        ? "r730"
        : "development";

  const requiredBackend: WorkspaceStorageBackend | undefined = target === "r730"
    ? "sqlite"
    : target === "vercel_review"
      ? "blob"
      : target === "cloudflare_review"
        ? "d1"
        : undefined;

  if (requiredBackend && !backend) {
    throw new Error(
      `WORKSPACE_STORAGE_BACKEND_REQUIRED：${target} 部署必须显式设置 WORKSPACE_STORAGE_BACKEND=${requiredBackend}。`,
    );
  }
  if (requiredBackend && backend !== requiredBackend) {
    throw new Error(
      `WORKSPACE_STORAGE_BACKEND_TARGET_MISMATCH：${target} 仅允许 WORKSPACE_STORAGE_BACKEND=${requiredBackend}。`,
    );
  }
  if (target === "development" && (backend === "blob" || backend === "d1")) {
    throw new Error(
      `WORKSPACE_STORAGE_BACKEND_TARGET_MISMATCH：${backend} 后端只能用于其指定的评审目标。`,
    );
  }

  // Local tests and development can retain the old convenient SQLite setup, but
  // production may not infer a backend from a path, token, or runtime binding.
  if (backend) return { backend, target, explicit: true };
  if (environment.WORKSPACE_DATABASE_PATH?.trim()) {
    return { backend: "sqlite", target, explicit: false };
  }
  return { backend: "ephemeral", target, explicit: false };
}

/** Deployment-owned identity; never infer it from a mutable workspace payload. */
export function deploymentWorkspaceId(): string | undefined {
  const explicit = process.env.TACKLE_FORGER_WORKSPACE_ID?.trim();
  if (explicit) return explicit;
  const tenantKey = process.env.FEISHU_TENANT_KEY?.trim();
  return tenantKey ? `workspace:feishu:${tenantKey}` : undefined;
}

export function bindDeploymentWorkspaceIdentity(state: WorkspaceState): WorkspaceState {
  const deploymentId = deploymentWorkspaceId();
  if (!deploymentId) return state;
  if (state.workspaceId && state.workspaceId !== deploymentId) {
    throw new Error("WORKSPACE_IDENTITY_MISMATCH：持久化工作区身份与部署/租户身份不一致。");
  }
  return state.workspaceId === deploymentId ? state : { ...state, workspaceId: deploymentId };
}

export function workspaceSqliteDatabasePath(contract = resolveWorkspaceStorageContract()) {
  if (contract.backend !== "sqlite") return undefined;
  const configuredPath = process.env.WORKSPACE_DATABASE_PATH?.trim();
  if (process.env.NODE_ENV === "production" && !configuredPath) {
    throw new Error("WORKSPACE_STORAGE_SQLITE_PATH_REQUIRED：生产 sqlite 后端必须显式设置 WORKSPACE_DATABASE_PATH。");
  }
  return configuredPath || ".data/workspace.sqlite";
}

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

export function resolveRuntimeWorkspaceStorageContract(
  environment: StorageEnvironment,
  runtime: Pick<StorageEnv, "DB" | "FILES">,
): WorkspaceStorageContract {
  const explicitD1 = environment.WORKSPACE_STORAGE_BACKEND?.trim() === "d1";
  const hasPlatformMarker = Boolean(environment.VERCEL || environment.CF_PAGES || environment.NITRO_PRESET);
  const inferredCloudflareProduction = environment.NODE_ENV === "production"
    && explicitD1
    && !hasPlatformMarker
    && Boolean(runtime.DB)
    && Boolean(runtime.FILES);
  const contract = resolveWorkspaceStorageContract(
    inferredCloudflareProduction
      ? { ...environment, NITRO_PRESET: "cloudflare_module" }
      : environment,
  );

  if (contract.backend === "blob" && !environment.BLOB_READ_WRITE_TOKEN?.trim()) {
    throw new Error("WORKSPACE_STORAGE_BLOB_UNAVAILABLE：blob 后端要求 BLOB_READ_WRITE_TOKEN。");
  }
  if (contract.backend === "d1" && !runtime.DB) {
    throw new Error("WORKSPACE_STORAGE_D1_UNAVAILABLE：d1 后端要求 Cloudflare DB 绑定。");
  }
  if (contract.backend === "d1" && !runtime.FILES) {
    throw new Error("WORKSPACE_STORAGE_R2_UNAVAILABLE：d1 后端要求 Cloudflare FILES 绑定。");
  }
  return contract;
}

async function runtimeStorageContract(): Promise<{ contract: WorkspaceStorageContract; runtime: StorageEnv }> {
  const runtime = await getRuntimeStorage();
  const contract = resolveRuntimeWorkspaceStorageContract(processStorageEnvironment(), runtime);
  return { contract, runtime };
}

export function createBlobDocument(): BlobWorkspaceDocument {
  const state = bindDeploymentWorkspaceIdentity(createSeedState({ mode: "production" }));
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
  const contract = resolveWorkspaceStorageContract();
  if (contract.backend !== "ephemeral") {
    throw new Error(`WORKSPACE_STORAGE_CONTRACT_VIOLATION：${action}请求未命中 ephemeral 后端。`);
  }
}

async function readBlobDocument(): Promise<LoadedBlobDocument | null> {
  const result = await get(WORKSPACE_BLOB_PATH, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  const document = JSON.parse(text) as BlobWorkspaceDocument;
  document.state = bindDeploymentWorkspaceIdentity(ensureWorkflowFields(document.state));
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
  const { contract, runtime } = await runtimeStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    const loaded = await loadSqliteWorkspace(sqlitePath, bindDeploymentWorkspaceIdentity(createSeedState({ mode: "production" })));
    return { ...loaded, state: bindDeploymentWorkspaceIdentity(loaded.state) };
  }

  if (contract.backend === "blob") {
    const current = await ensureBlobDocument();
    return {
      state: bindDeploymentWorkspaceIdentity(ensureWorkflowFields(current.document.state)),
      revision: current.document.revision,
    };
  }

  if (contract.backend === "ephemeral") {
    assertEphemeralStorageAllowed("读取");
    const document = ensureLocalWorkspaceDocument();
    return {
      state: bindDeploymentWorkspaceIdentity(ensureWorkflowFields(structuredClone(document.state))),
      revision: document.revision,
    };
  }
  const db = runtime.DB!;
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT state_json, revision FROM workspace_state WHERE id = ?")
    .bind("main")
    .first<{ state_json: string; revision: number }>();

  if (row) {
    return {
      state: bindDeploymentWorkspaceIdentity(ensureWorkflowFields(JSON.parse(row.state_json) as WorkspaceState)),
      revision: row.revision,
    };
  }

  const state = bindDeploymentWorkspaceIdentity(createSeedState({ mode: "production" }));
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
  const { contract, runtime } = await runtimeStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return saveSqliteWorkspace(sqlitePath, {
      ...input,
      state: bindDeploymentWorkspaceIdentity(input.state),
    });
  }

  if (contract.backend === "blob") {
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
    const savedState = bindDeploymentWorkspaceIdentity(ensureWorkflowFields(structuredClone(input.state)));
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

  if (contract.backend === "ephemeral") {
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
    const savedState = bindDeploymentWorkspaceIdentity(ensureWorkflowFields(structuredClone(input.state)));
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
  const db = runtime.DB!;
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
  const savedState = bindDeploymentWorkspaceIdentity(ensureWorkflowFields(structuredClone(input.state)));
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
  const { contract, runtime } = await runtimeStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return listSqliteRevisions(sqlitePath);
  }

  if (contract.backend === "blob") {
    const current = await ensureBlobDocument();
    return current.document.revisions.map((entry) => ({
      revision: entry.revision,
      author: entry.author,
      message: entry.message,
      createdAt: entry.createdAt,
    }));
  }

  if (contract.backend === "ephemeral") {
    assertEphemeralStorageAllowed("读取版本");
    return ensureLocalWorkspaceDocument().revisions.map((entry) => ({
      revision: entry.revision,
      author: entry.author,
      message: entry.message,
      createdAt: entry.createdAt,
    }));
  }
  const db = runtime.DB!;
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
  const { contract, runtime } = await runtimeStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return loadSqliteRevision(sqlitePath, revision);
  }

  if (contract.backend === "blob") {
    const current = await ensureBlobDocument();
    const entry = current.document.revisions.find((item) => item.revision === revision);
    return entry ? ensureWorkflowFields(entry.state) : null;
  }

  if (contract.backend === "ephemeral") {
    assertEphemeralStorageAllowed("读取版本");
    const entry = ensureLocalWorkspaceDocument().revisions.find((item) => item.revision === revision);
    return entry ? ensureWorkflowFields(structuredClone(entry.state)) : null;
  }
  const db = runtime.DB!;
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
  const { contract, runtime } = await runtimeStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return saveSqliteImportedFile(sqlitePath, sqliteFileDataDir(sqlitePath), file, author);
  }

  const id = crypto.randomUUID();
  const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  const key =
    "imports/" + new Date().toISOString().slice(0, 10) + "/" + id + "-" + safeName;

  if (contract.backend === "blob") {
    await put(key, file, {
      access: "private",
      contentType: file.type || "application/octet-stream",
      addRandomSuffix: false,
    });
    return { id, key, stored: true };
  }

  const bucket = runtime.FILES;
  const db = contract.backend === "d1" ? runtime.DB! : undefined;
  if (contract.backend === "ephemeral") assertEphemeralStorageAllowed("存储导入文件");
  if (contract.backend === "d1" && !bucket) {
    throw new Error("WORKSPACE_STORAGE_R2_UNAVAILABLE：d1 后端存储导入文件要求 Cloudflare FILES 绑定。");
  }
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
