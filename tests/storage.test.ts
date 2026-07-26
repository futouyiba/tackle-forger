import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindDeploymentWorkspaceIdentity,
  createBlobDocument,
  listRevisions,
  loadRevision,
  loadWorkspaceState,
  resolveRuntimeWorkspaceStorageContract,
  resolveWorkspaceStorageContract,
  saveWorkspaceState,
  workspaceSqliteDatabasePath,
} from "../lib/storage";
import { createSeedState } from "../lib/seed";
import { closeSqliteStorage } from "../lib/sqlite-storage";

test("SQLite 保存可跨读取、冲突受保护且历史版本冻结", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-storage-"));
  process.env.WORKSPACE_DATABASE_PATH = path.join(directory, "workspace.sqlite");
  const databasePath = process.env.WORKSPACE_DATABASE_PATH;
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    delete process.env.WORKSPACE_DATABASE_PATH;
    await rm(directory, { recursive: true, force: true });
  });
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  const initial = await loadWorkspaceState();
  const changed = structuredClone(initial.state);
  const previousNotes = initial.state.affixScorePolicy.notes;
  const savedNotes = `local-runtime-saved-${Date.now()}-${crypto.randomUUID()}`;
  changed.affixScorePolicy.notes = savedNotes;
  const saved = await saveWorkspaceState({
    state: changed,
    baseRevision: initial.revision,
    author: "test",
    message: "验证本地一致性存储",
  });
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal((await loadWorkspaceState()).state.affixScorePolicy.notes, savedNotes);
  assert.equal((await listRevisions())[0]?.revision, saved.revision);
  assert.equal((await loadRevision(initial.revision))?.affixScorePolicy.notes, previousNotes);
  assert.notEqual((await loadRevision(initial.revision))?.affixScorePolicy.notes, savedNotes);
  const conflict = await saveWorkspaceState({
    state: initial.state,
    baseRevision: initial.revision,
    author: "stale",
    message: "过期写入",
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.revision, saved.revision);
});

test("空数据库首次持久化绑定部署身份、重载稳定且后续错配 fail-closed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-storage-identity-"));
  const previousDatabase = process.env.WORKSPACE_DATABASE_PATH;
  const previousIdentity = process.env.TACKLE_FORGER_WORKSPACE_ID;
  process.env.WORKSPACE_DATABASE_PATH = path.join(directory, "workspace.sqlite");
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:bootstrap-a";
  const databasePath = process.env.WORKSPACE_DATABASE_PATH;
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    if (previousDatabase === undefined) delete process.env.WORKSPACE_DATABASE_PATH; else process.env.WORKSPACE_DATABASE_PATH = previousDatabase;
    if (previousIdentity === undefined) delete process.env.TACKLE_FORGER_WORKSPACE_ID; else process.env.TACKLE_FORGER_WORKSPACE_ID = previousIdentity;
    await rm(directory, { recursive: true, force: true });
  });
  const initial = await loadWorkspaceState();
  assert.equal(initial.state.workspaceId, "workspace:bootstrap-a");
  await closeSqliteStorage(databasePath);
  assert.equal((await loadWorkspaceState()).state.workspaceId, "workspace:bootstrap-a");
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:bootstrap-b";
  await assert.rejects(loadWorkspaceState(), /WORKSPACE_IDENTITY_MISMATCH/);
});

test("Blob 首次 put 前构造的 payload 已绑定部署身份", () => {
  const prior = process.env.TACKLE_FORGER_WORKSPACE_ID;
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:blob-bootstrap";
  const payload = createBlobDocument();
  assert.equal(payload.state.workspaceId, "workspace:blob-bootstrap");
  assert.equal(payload.revisions[0]?.state.workspaceId, "workspace:blob-bootstrap");
  if (prior === undefined) delete process.env.TACKLE_FORGER_WORKSPACE_ID;
  else process.env.TACKLE_FORGER_WORKSPACE_ID = prior;
});

test("部署目标要求显式且匹配的存储后端，开发环境保留受控兼容", () => {
  assert.deepEqual(
    resolveWorkspaceStorageContract({ NODE_ENV: "production", WORKSPACE_STORAGE_BACKEND: "sqlite" }),
    { target: "r730", backend: "sqlite", explicit: true },
  );
  assert.deepEqual(
    resolveWorkspaceStorageContract({ VERCEL: "1", NODE_ENV: "production", WORKSPACE_STORAGE_BACKEND: "blob" }),
    { target: "vercel_review", backend: "blob", explicit: true },
  );
  assert.deepEqual(
    resolveWorkspaceStorageContract({ NITRO_PRESET: "cloudflare_module", NODE_ENV: "production", WORKSPACE_STORAGE_BACKEND: "d1" }),
    { target: "cloudflare_review", backend: "d1", explicit: true },
  );
  assert.deepEqual(resolveWorkspaceStorageContract({ NODE_ENV: "test" }), {
    target: "development", backend: "ephemeral", explicit: false,
  });
  assert.deepEqual(resolveWorkspaceStorageContract({ NODE_ENV: "test", WORKSPACE_DATABASE_PATH: ".tmp/test.sqlite" }), {
    target: "development", backend: "sqlite", explicit: false,
  });
  assert.deepEqual(
    resolveWorkspaceStorageContract({ NODE_ENV: "development", WORKSPACE_STORAGE_BACKEND: "sqlite" }),
    { target: "development", backend: "sqlite", explicit: true },
  );
  assert.deepEqual(
    resolveRuntimeWorkspaceStorageContract(
      { NODE_ENV: "development", WORKSPACE_STORAGE_BACKEND: "sqlite" },
      { DB: {} as D1Database },
    ),
    { target: "development", backend: "sqlite", explicit: true },
  );
  assert.throws(
    () => resolveWorkspaceStorageContract({ NODE_ENV: "production" }),
    /WORKSPACE_STORAGE_BACKEND_REQUIRED/,
  );
  assert.throws(
    () => resolveWorkspaceStorageContract({ VERCEL: "1", WORKSPACE_STORAGE_BACKEND: "sqlite" }),
    /WORKSPACE_STORAGE_BACKEND_TARGET_MISMATCH/,
  );
  assert.throws(
    () => resolveWorkspaceStorageContract({ NODE_ENV: "test", WORKSPACE_STORAGE_BACKEND: "blob" }),
    /WORKSPACE_STORAGE_BACKEND_TARGET_MISMATCH/,
  );
  assert.throws(
    () => resolveWorkspaceStorageContract({ WORKSPACE_STORAGE_BACKEND: "memory" }),
    /WORKSPACE_STORAGE_BACKEND_INVALID/,
  );
  assert.throws(
    () => resolveRuntimeWorkspaceStorageContract(
      { NODE_ENV: "production", NITRO_PRESET: "cloudflare_module", WORKSPACE_STORAGE_BACKEND: "d1" },
      { DB: {} as D1Database },
    ),
    /WORKSPACE_STORAGE_R2_UNAVAILABLE/,
  );
  assert.throws(
    () => resolveRuntimeWorkspaceStorageContract(
      { NODE_ENV: "production", NITRO_PRESET: "cloudflare_module", WORKSPACE_STORAGE_BACKEND: "d1" },
      { FILES: {} as R2Bucket },
    ),
    /WORKSPACE_STORAGE_D1_UNAVAILABLE/,
  );
  assert.deepEqual(
    resolveRuntimeWorkspaceStorageContract(
      { NODE_ENV: "production", NITRO_PRESET: "cloudflare_module", WORKSPACE_STORAGE_BACKEND: "d1" },
      { DB: {} as D1Database, FILES: {} as R2Bucket },
    ),
    { target: "cloudflare_review", backend: "d1", explicit: true },
  );
  const unmarkedCloudflareContract = resolveRuntimeWorkspaceStorageContract(
      { NODE_ENV: "production", WORKSPACE_STORAGE_BACKEND: "d1" },
      { DB: {} as D1Database, FILES: {} as R2Bucket },
  );
  assert.deepEqual(unmarkedCloudflareContract, { target: "cloudflare_review", backend: "d1", explicit: true });
  assert.equal(workspaceSqliteDatabasePath(unmarkedCloudflareContract), undefined);
  assert.throws(
    () => resolveRuntimeWorkspaceStorageContract(
      { NODE_ENV: "production", VERCEL: "1", WORKSPACE_STORAGE_BACKEND: "d1" },
      { DB: {} as D1Database, FILES: {} as R2Bucket },
    ),
    /WORKSPACE_STORAGE_BACKEND_TARGET_MISMATCH/,
  );
});

test("生产 sqlite 要求显式路径，开发环境保留默认路径", (t) => {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousBackend = env.WORKSPACE_STORAGE_BACKEND;
  const previousPath = env.WORKSPACE_DATABASE_PATH;
  t.after(() => {
    if (previousNodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = previousNodeEnv;
    if (previousBackend === undefined) delete env.WORKSPACE_STORAGE_BACKEND; else env.WORKSPACE_STORAGE_BACKEND = previousBackend;
    if (previousPath === undefined) delete env.WORKSPACE_DATABASE_PATH; else env.WORKSPACE_DATABASE_PATH = previousPath;
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

test("生产环境没有显式持久化后端时拒绝进程内临时存储", async (t) => {
  const env = process.env as Record<string, string | undefined>;
  const previous = {
    nodeEnv: env.NODE_ENV,
    databasePath: env.WORKSPACE_DATABASE_PATH,
    blobToken: env.BLOB_READ_WRITE_TOKEN,
    vercel: env.VERCEL,
    storageBackend: env.WORKSPACE_STORAGE_BACKEND,
  };
  env.NODE_ENV = "production";
  delete env.WORKSPACE_DATABASE_PATH;
  delete env.BLOB_READ_WRITE_TOKEN;
  delete env.VERCEL;
  delete env.WORKSPACE_STORAGE_BACKEND;
  t.after(() => {
    if (previous.nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = previous.nodeEnv;
    if (previous.databasePath === undefined) delete env.WORKSPACE_DATABASE_PATH; else env.WORKSPACE_DATABASE_PATH = previous.databasePath;
    if (previous.blobToken === undefined) delete env.BLOB_READ_WRITE_TOKEN; else env.BLOB_READ_WRITE_TOKEN = previous.blobToken;
    if (previous.vercel === undefined) delete env.VERCEL; else env.VERCEL = previous.vercel;
    if (previous.storageBackend === undefined) delete env.WORKSPACE_STORAGE_BACKEND; else env.WORKSPACE_STORAGE_BACKEND = previous.storageBackend;
  });

  await assert.rejects(
    loadWorkspaceState(),
    /WORKSPACE_STORAGE_BACKEND_REQUIRED/,
  );
});

test("两个 legacy 工作区只可由各自部署身份绑定，缺失身份不猜测且错配 fail-closed", () => {
  const prior = process.env.TACKLE_FORGER_WORKSPACE_ID;
  const legacyA = createSeedState(); delete legacyA.workspaceId;
  const legacyB = createSeedState(); delete legacyB.workspaceId;
  delete process.env.TACKLE_FORGER_WORKSPACE_ID;
  assert.equal(bindDeploymentWorkspaceIdentity(legacyA).workspaceId, undefined);
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:tenant-a";
  const boundA = bindDeploymentWorkspaceIdentity(legacyA);
  process.env.TACKLE_FORGER_WORKSPACE_ID = "workspace:tenant-b";
  const boundB = bindDeploymentWorkspaceIdentity(legacyB);
  assert.equal(boundA.workspaceId, "workspace:tenant-a");
  assert.equal(boundB.workspaceId, "workspace:tenant-b");
  assert.notEqual(boundA.workspaceId, boundB.workspaceId);
  assert.throws(() => bindDeploymentWorkspaceIdentity(boundA), /WORKSPACE_IDENTITY_MISMATCH/);
  if (prior === undefined) delete process.env.TACKLE_FORGER_WORKSPACE_ID;
  else process.env.TACKLE_FORGER_WORKSPACE_ID = prior;
});

test("SQLite 并发写入同一基线 revision 时只有一个成功，其余进入冲突", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-storage-concurrency-"));
  process.env.WORKSPACE_DATABASE_PATH = path.join(directory, "workspace.sqlite");
  const databasePath = process.env.WORKSPACE_DATABASE_PATH;
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    delete process.env.WORKSPACE_DATABASE_PATH;
    await rm(directory, { recursive: true, force: true });
  });
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  const initial = await loadWorkspaceState();
  const buildState = (suffix: string) => {
    const state = structuredClone(initial.state);
    state.affixScorePolicy.notes = `concurrent-${suffix}-${Date.now()}`;
    return state;
  };
  const results = await Promise.all([
    saveWorkspaceState({ state: buildState("a"), baseRevision: initial.revision, author: "a", message: "并发 a" }),
    saveWorkspaceState({ state: buildState("b"), baseRevision: initial.revision, author: "b", message: "并发 b" }),
    saveWorkspaceState({ state: buildState("c"), baseRevision: initial.revision, author: "c", message: "并发 c" }),
  ]);
  const successes = results.filter((result) => !result.conflict);
  const conflicts = results.filter((result) => result.conflict);
  assert.equal(successes.length, 1, "同一基线 revision 的并发写入只应有一个成功");
  assert.equal(conflicts.length, 2, "其余并发写入应因基线已前进而冲突");
  assert.equal((await loadWorkspaceState()).revision, initial.revision + 1);
});
