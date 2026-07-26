import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindDeploymentWorkspaceIdentity,
  createInitialWorkspaceDocument,
  listRevisions,
  loadRevision,
  loadWorkspaceState,
  resolveWorkspaceStorageContract,
  saveWorkspaceState,
  workspaceSqliteDatabasePath,
} from "../lib/storage";
import { createSeedState } from "../lib/seed";
import { closeSqliteStorage } from "../lib/sqlite-storage";

test("SQLite 保存可跨读取、冲突受保护且历史版本冻结", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-storage-"));
  const previousDatabase = process.env.WORKSPACE_DATABASE_PATH;
  const previousBackend = process.env.WORKSPACE_STORAGE_BACKEND;
  process.env.WORKSPACE_DATABASE_PATH = path.join(directory, "workspace.sqlite");
  process.env.WORKSPACE_STORAGE_BACKEND = "sqlite";
  const databasePath = process.env.WORKSPACE_DATABASE_PATH;
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    if (previousDatabase === undefined) delete process.env.WORKSPACE_DATABASE_PATH; else process.env.WORKSPACE_DATABASE_PATH = previousDatabase;
    if (previousBackend === undefined) delete process.env.WORKSPACE_STORAGE_BACKEND; else process.env.WORKSPACE_STORAGE_BACKEND = previousBackend;
    await rm(directory, { recursive: true, force: true });
  });
  const initial = await loadWorkspaceState();
  const changed = structuredClone(initial.state);
  const previousNotes = initial.state.affixScorePolicy.notes;
  changed.affixScorePolicy.notes = `local-runtime-saved-${crypto.randomUUID()}`;
  const saved = await saveWorkspaceState({ state: changed, baseRevision: initial.revision, author: "test", message: "验证本地一致性存储" });
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal((await loadWorkspaceState()).state.affixScorePolicy.notes, changed.affixScorePolicy.notes);
  assert.equal((await listRevisions())[0]?.revision, saved.revision);
  assert.equal((await loadRevision(initial.revision))?.affixScorePolicy.notes, previousNotes);
  const conflict = await saveWorkspaceState({ state: initial.state, baseRevision: initial.revision, author: "stale", message: "过期写入" });
  assert.deepEqual(conflict, { revision: saved.revision, conflict: true });
});

test("初始临时文档绑定部署身份，但生产不会使用它", () => {
  const prior = process.env.TACKLE_FORGER_WORKSPACE_ID;
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:bootstrap";
  const payload = createInitialWorkspaceDocument();
  assert.equal(payload.state.workspaceId, "workspace:bootstrap");
  assert.equal(payload.revisions[0]?.state.workspaceId, "workspace:bootstrap");
  if (prior === undefined) delete process.env.TACKLE_FORGER_WORKSPACE_ID; else process.env.TACKLE_FORGER_WORKSPACE_ID = prior;
});

test("R730 生产仅允许显式 SQLite，云端后端无法重新启用", () => {
  assert.deepEqual(resolveWorkspaceStorageContract({ NODE_ENV: "production", WORKSPACE_STORAGE_BACKEND: "sqlite" }), { target: "r730", backend: "sqlite", explicit: true });
  assert.deepEqual(resolveWorkspaceStorageContract({ NODE_ENV: "test" }), { target: "development", backend: "ephemeral", explicit: false });
  assert.deepEqual(resolveWorkspaceStorageContract({ NODE_ENV: "test", WORKSPACE_DATABASE_PATH: ".tmp/test.sqlite" }), { target: "development", backend: "sqlite", explicit: false });
  assert.throws(() => resolveWorkspaceStorageContract({ NODE_ENV: "production" }), /WORKSPACE_STORAGE_BACKEND_REQUIRED/);
  assert.throws(() => resolveWorkspaceStorageContract({ NODE_ENV: "production", WORKSPACE_STORAGE_BACKEND: "ephemeral" }), /WORKSPACE_STORAGE_BACKEND_TARGET_MISMATCH/);
  assert.throws(() => resolveWorkspaceStorageContract({ NODE_ENV: "test", WORKSPACE_STORAGE_BACKEND: "blob" }), /WORKSPACE_STORAGE_BACKEND_INVALID/);
  assert.throws(() => resolveWorkspaceStorageContract({ NODE_ENV: "test", WORKSPACE_STORAGE_BACKEND: "d1" }), /WORKSPACE_STORAGE_BACKEND_INVALID/);
});

test("生产 SQLite 要求显式路径，开发环境保留默认路径", (t) => {
  const env = process.env as Record<string, string | undefined>;
  const previous = { nodeEnv: env.NODE_ENV, backend: env.WORKSPACE_STORAGE_BACKEND, path: env.WORKSPACE_DATABASE_PATH };
  t.after(() => {
    if (previous.nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = previous.nodeEnv;
    if (previous.backend === undefined) delete env.WORKSPACE_STORAGE_BACKEND; else env.WORKSPACE_STORAGE_BACKEND = previous.backend;
    if (previous.path === undefined) delete env.WORKSPACE_DATABASE_PATH; else env.WORKSPACE_DATABASE_PATH = previous.path;
  });
  env.NODE_ENV = "production";
  env.WORKSPACE_STORAGE_BACKEND = "sqlite";
  delete env.WORKSPACE_DATABASE_PATH;
  assert.throws(() => workspaceSqliteDatabasePath(), /WORKSPACE_STORAGE_SQLITE_PATH_REQUIRED/);
  env.WORKSPACE_DATABASE_PATH = "/opt/tackle-forger/data/workspace.sqlite";
  assert.equal(workspaceSqliteDatabasePath(), "/opt/tackle-forger/data/workspace.sqlite");
  env.NODE_ENV = "test";
  delete env.WORKSPACE_DATABASE_PATH;
  assert.equal(workspaceSqliteDatabasePath(), ".data/workspace.sqlite");
});

test("部署身份不猜测且错配 fail-closed", () => {
  const prior = process.env.TACKLE_FORGER_WORKSPACE_ID;
  const legacy = createSeedState(); delete legacy.workspaceId;
  delete process.env.TACKLE_FORGER_WORKSPACE_ID;
  assert.equal(bindDeploymentWorkspaceIdentity(legacy).workspaceId, undefined);
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:tenant-a";
  const bound = bindDeploymentWorkspaceIdentity(legacy);
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:tenant-b";
  assert.throws(() => bindDeploymentWorkspaceIdentity(bound), /WORKSPACE_IDENTITY_MISMATCH/);
  if (prior === undefined) delete process.env.TACKLE_FORGER_WORKSPACE_ID; else process.env.TACKLE_FORGER_WORKSPACE_ID = prior;
});
