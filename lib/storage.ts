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

type StorageEnvironment = {
  WORKSPACE_STORAGE_BACKEND?: string;
  WORKSPACE_DATABASE_PATH?: string;
  NODE_ENV?: string;
};

export type WorkspaceStorageBackend = "sqlite" | "ephemeral";
export type WorkspaceDeploymentTarget = "r730" | "development";

export type WorkspaceStorageContract = {
  backend: WorkspaceStorageBackend;
  target: WorkspaceDeploymentTarget;
  explicit: boolean;
};

type EphemeralWorkspaceDocument = {
  state: WorkspaceState;
  revision: number;
  revisions: Array<RevisionInfo & { state: WorkspaceState }>;
  updatedAt: string;
};

function processStorageEnvironment(): StorageEnvironment {
  return typeof process === "undefined" ? {} : process.env as StorageEnvironment;
}

function configuredBackend(value: string | undefined): WorkspaceStorageBackend | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === "sqlite" || normalized === "ephemeral") return normalized;
  throw new Error(
    "WORKSPACE_STORAGE_BACKEND_INVALID：WORKSPACE_STORAGE_BACKEND 仅支持 sqlite 或 ephemeral；Blob 迁移完成后不得作为运行时后端。",
  );
}

/**
 * The only production storage authority is the R730's persistent SQLite file.
 * `ephemeral` is deliberately limited to local development and test processes.
 */
export function resolveWorkspaceStorageContract(
  environment: StorageEnvironment = processStorageEnvironment(),
): WorkspaceStorageContract {
  const backend = configuredBackend(environment.WORKSPACE_STORAGE_BACKEND);
  const production = environment.NODE_ENV === "production";

  if (production && !backend) {
    throw new Error("WORKSPACE_STORAGE_BACKEND_REQUIRED：生产环境必须显式设置 WORKSPACE_STORAGE_BACKEND=sqlite。");
  }
  if (production && backend !== "sqlite") {
    throw new Error("WORKSPACE_STORAGE_BACKEND_TARGET_MISMATCH：R730 生产环境仅允许 WORKSPACE_STORAGE_BACKEND=sqlite。");
  }
  if (!production && backend === "ephemeral") {
    return { target: "development", backend, explicit: true };
  }
  if (backend === "sqlite") {
    return { target: production ? "r730" : "development", backend, explicit: true };
  }
  if (environment.WORKSPACE_DATABASE_PATH?.trim()) {
    return { target: "development", backend: "sqlite", explicit: false };
  }
  return { target: "development", backend: "ephemeral", explicit: false };
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

export function createInitialWorkspaceDocument(): EphemeralWorkspaceDocument {
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

let localWorkspaceDocument: EphemeralWorkspaceDocument | null = null;

function ensureLocalWorkspaceDocument() {
  localWorkspaceDocument ??= createInitialWorkspaceDocument();
  return localWorkspaceDocument;
}

function assertEphemeralStorageAllowed(action: "读取" | "保存" | "读取版本" | "存储导入文件") {
  if (resolveWorkspaceStorageContract().backend !== "ephemeral") {
    throw new Error(`WORKSPACE_STORAGE_CONTRACT_VIOLATION：${action}请求未命中 ephemeral 后端。`);
  }
}

export async function loadWorkspaceState(): Promise<{ state: WorkspaceState; revision: number }> {
  const contract = resolveWorkspaceStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    const loaded = await loadSqliteWorkspace(sqlitePath, bindDeploymentWorkspaceIdentity(createSeedState({ mode: "production" })));
    return { ...loaded, state: bindDeploymentWorkspaceIdentity(loaded.state) };
  }
  assertEphemeralStorageAllowed("读取");
  const document = ensureLocalWorkspaceDocument();
  return { state: bindDeploymentWorkspaceIdentity(ensureWorkflowFields(structuredClone(document.state))), revision: document.revision };
}

export async function saveWorkspaceState(input: {
  state: WorkspaceState;
  baseRevision: number;
  author: string;
  message: string;
}): Promise<{ revision: number; conflict?: boolean }> {
  const contract = resolveWorkspaceStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return saveSqliteWorkspace(sqlitePath, { ...input, state: bindDeploymentWorkspaceIdentity(input.state) });
  }
  assertEphemeralStorageAllowed("保存");
  const current = ensureLocalWorkspaceDocument();
  if (current.revision !== input.baseRevision) return { revision: current.revision, conflict: true };
  const revision = input.baseRevision + 1;
  const createdAt = new Date().toISOString();
  const info: RevisionInfo = { revision, author: input.author, message: input.message, createdAt };
  const savedState = bindDeploymentWorkspaceIdentity(ensureWorkflowFields(structuredClone(input.state)));
  savedState.revisions = [info, ...(savedState.revisions ?? []).filter((entry) => entry.revision !== revision)];
  localWorkspaceDocument = {
    state: savedState,
    revision,
    revisions: [{ ...info, state: structuredClone(savedState) }, ...current.revisions.filter((entry) => entry.revision !== revision)],
    updatedAt: createdAt,
  };
  return { revision };
}

export async function listRevisions(): Promise<RevisionInfo[]> {
  const contract = resolveWorkspaceStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return listSqliteRevisions(sqlitePath);
  }
  assertEphemeralStorageAllowed("读取版本");
  return ensureLocalWorkspaceDocument().revisions.map(({ revision, author, message, createdAt }) => ({ revision, author, message, createdAt }));
}

export async function loadRevision(revision: number): Promise<WorkspaceState | null> {
  const contract = resolveWorkspaceStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return loadSqliteRevision(sqlitePath, revision);
  }
  assertEphemeralStorageAllowed("读取版本");
  const entry = ensureLocalWorkspaceDocument().revisions.find((item) => item.revision === revision);
  return entry ? ensureWorkflowFields(structuredClone(entry.state)) : null;
}

export async function saveImportedFile(file: File, author: string) {
  const contract = resolveWorkspaceStorageContract();
  const sqlitePath = workspaceSqliteDatabasePath(contract);
  if (contract.backend === "sqlite") {
    if (!sqlitePath) throw new Error("WORKSPACE_STORAGE_SQLITE_UNAVAILABLE：sqlite 后端缺少数据库路径。");
    return saveSqliteImportedFile(sqlitePath, sqliteFileDataDir(sqlitePath), file, author);
  }
  assertEphemeralStorageAllowed("存储导入文件");
  return { id: crypto.randomUUID(), key: `imports/ephemeral/${file.name}`, stored: false };
}
