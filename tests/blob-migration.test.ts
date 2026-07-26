import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  assertBlobWorkspaceDocument,
  migrateBlobDocumentToSqlite,
  migrateBlobToSqlite,
  type BlobWorkspaceDocument,
} from "../scripts/migrate-blob-to-sqlite";
import { migrateWorkspaceState } from "../lib/migrations";
import {
  closeSqliteStorage,
  listSqliteRevisions,
  loadSqliteRevision,
  loadSqliteWorkspace,
} from "../lib/sqlite-storage";
import type { WorkspaceState } from "../lib/types";

function documentFixture(): BlobWorkspaceDocument {
  const first = createSeedState() as WorkspaceStateWithUnknown;
  first.unknownHistoricalField = { preserved: true };
  const current = structuredClone(first);
  current.affixScorePolicy.notes = "migrated-current";
  return {
    state: current,
    revision: 12,
    revisions: [
      { revision: 10, author: "import", message: "available window start", createdAt: "2026-01-01T00:00:00.000Z", state: first },
      { revision: 12, author: "user", message: "current", createdAt: "2026-01-02T00:00:00.000Z", state: current },
    ],
  };
}

type WorkspaceStateWithUnknown = ReturnType<typeof createSeedState> & { unknownHistoricalField?: unknown };

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function checkpointedSqliteSnapshot(databasePath: string) {
  await closeSqliteStorage(databasePath);
  const bytes = await readFile(databasePath);
  const current = await loadSqliteWorkspace(databasePath);
  const revisions = await listSqliteRevisions(databasePath);
  const revisionStates = await Promise.all(revisions.map((entry) => loadSqliteRevision(databasePath, entry.revision)));
  await closeSqliteStorage(databasePath);
  return { rawSha256: sha256(bytes), current, revisions, revisionStates };
}

async function productionShapeDocument(): Promise<BlobWorkspaceDocument> {
  const legacy = JSON.parse(await readFile(new URL("./fixtures/workspace-production-schema-v17.json", import.meta.url), "utf8")) as WorkspaceState;
  const current = migrateWorkspaceState(legacy);
  const availableWindowStart = structuredClone(current);
  return {
    state: current,
    revision: 43,
    revisions: [
      { revision: 42, author: "migration", message: "redacted production available-window start", createdAt: "2026-01-01T00:00:00.000Z", state: availableWindowStart },
      { revision: 43, author: "migration", message: "redacted production current", createdAt: "2026-01-02T00:00:00.000Z", state: current },
    ],
  };
}

test("Blob→SQLite 迁移只接受一致的可获得窗口，不把截断窗口误作完整历史", () => {
  const document = documentFixture();
  assert.doesNotThrow(() => assertBlobWorkspaceDocument(document));
  assert.throws(() => assertBlobWorkspaceDocument({ ...document, revisions: [document.revisions[0]!] }), /当前 revision/);
  assert.throws(() => assertBlobWorkspaceDocument({ ...document, revisions: [document.revisions[0]!, document.revisions[0]!] }), /唯一/);
});

test("production_shape_fixture：脱敏生产 schema v17 经权威迁移后保留未知字段、稳定 ID 与已发布 Snapshot", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-blob-migration-production-shape-"));
  const target = path.join(directory, "workspace.sqlite");
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  const document = await productionShapeDocument();
  await migrateBlobDocumentToSqlite(document, target);
  const persisted = await loadSqliteWorkspace(target);
  const state = persisted.state as WorkspaceState & { legacyImportedField?: unknown };
  assert.deepEqual(state.legacyImportedField, { source: "production-redacted", preserve: true });
  assert.equal(state.skuDrawers[0]!.id, "sku:production-redacted");
  assert.equal(state.configurationSnapshots[0]!.id, "snapshot:published-redacted");
  assert.equal(state.configurationSnapshots[0]!.contentHash, "sha256:production-published-snapshot-redacted");
  assert.equal((state.configurationSnapshots[0] as unknown as { status?: string }).status, "published");
  await closeSqliteStorage(target);
});

test("second_run_noop：已有目标拒绝第二次迁移，SQLite 原始字节、当前状态和 revisions 均不变", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-blob-migration-noop-"));
  const target = path.join(directory, "workspace.sqlite");
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  const document = await productionShapeDocument();
  await migrateBlobDocumentToSqlite(document, target);
  const before = await checkpointedSqliteSnapshot(target);
  await assert.rejects(migrateBlobDocumentToSqlite(document, target), /目标数据库已存在/);
  const after = await checkpointedSqliteSnapshot(target);
  assert.equal(after.rawSha256, before.rawSha256);
  assert.deepEqual(after.current, before.current);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.revisionStates, before.revisionStates);
  assert.equal(after.revisions.length, before.revisions.length);
});

test("authorization_denied：缺少 Blob 令牌在读取或写入前拒绝迁移", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-blob-migration-auth-"));
  const target = path.join(directory, "workspace.sqlite");
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  await assert.rejects(migrateBlobToSqlite({ WORKSPACE_DATABASE_PATH: target } as unknown as NodeJS.ProcessEnv), /BLOB_READ_WRITE_TOKEN/);
  assert.deepEqual(await readdir(directory), []);
});

test("Blob→SQLite 拒绝顶层当前状态与当前修订快照矛盾，且不留下目标或暂存文件", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-blob-migration-"));
  const target = path.join(directory, "workspace.sqlite");
  const document = documentFixture();
  const contradictory = { ...document, state: structuredClone(document.state) };
  contradictory.state.templates[0]!.name = "conflicting-current-state";
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  assert.throws(() => assertBlobWorkspaceDocument(contradictory), /顶层 state 与当前 revision/);
  await assert.rejects(migrateBlobDocumentToSqlite(contradictory, target), /顶层 state 与当前 revision/);
  await assert.rejects(stat(target));
  assert.deepEqual(await readdir(directory), []);
});

test("Blob→SQLite 先验证再原子发布；失败可重试且不会留下最终目标", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-blob-migration-"));
  const target = path.join(directory, "workspace.sqlite");
  const document = documentFixture();
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  await assert.rejects(
    migrateBlobDocumentToSqlite(document, target, { beforePublish: () => { throw new Error("fault-before-publish"); } }),
    /fault-before-publish/,
  );
  await assert.rejects(stat(target));

  const report = await migrateBlobDocumentToSqlite(document, target);
  assert.equal(report.currentRevision, 12);
  assert.equal(report.revisionCount, 2);
  assert.deepEqual(report.sourceRevisionGaps, [11]);
  assert.equal(report.historyTruncatedOrUnknown, true);
  const persisted = await loadSqliteWorkspace(target);
  assert.deepEqual((persisted.state as WorkspaceStateWithUnknown).unknownHistoricalField, { preserved: true });
  await closeSqliteStorage(target);
  await assert.rejects(migrateBlobDocumentToSqlite(document, target), /目标数据库已存在/);

  const concurrentTarget = path.join(directory, "concurrent.sqlite");
  await assert.rejects(
    migrateBlobDocumentToSqlite(document, concurrentTarget, {
      beforePublish: async () => { await writeFile(concurrentTarget, "competing-target", "utf8"); },
    }),
    /EEXIST/,
  );
  assert.equal(await readFile(concurrentTarget, "utf8"), "competing-target");
});

test("Blob→SQLite 发布后的目录同步或暂存清理失败会回滚，成功后没有迁移残留物", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-blob-migration-"));
  const document = documentFixture();
  const target = path.join(directory, "workspace.sqlite");
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  let syncCalls = 0;
  await assert.rejects(
    migrateBlobDocumentToSqlite(document, target, {
      fileSystem: {
        syncDirectory: async () => {
          syncCalls += 1;
          if (syncCalls === 1) throw new Error("injected-directory-sync-failure");
        },
      },
    }),
    /发布后持久化或清理失败，已回滚/,
  );
  await assert.rejects(stat(target));
  assert.deepEqual(await readdir(directory), []);
  const retried = await migrateBlobDocumentToSqlite(document, target);
  assert.equal(retried.currentRevision, document.revision);
  await closeSqliteStorage(target);
  await (await import("node:fs/promises")).rm(target, { force: true });

  const unlinkTarget = path.join(directory, "unlink-failure.sqlite");
  await assert.rejects(
    migrateBlobDocumentToSqlite(document, unlinkTarget, {
      fileSystem: {
        unlink: async (candidate) => {
          if (typeof candidate === "string" && candidate.includes(".blob-migration-")) throw new Error("injected-staged-unlink-failure");
          return (await import("node:fs/promises")).unlink(candidate);
        },
      },
    }),
    /发布后持久化或清理失败，已回滚/,
  );
  await assert.rejects(stat(unlinkTarget));
  assert.deepEqual(await readdir(directory), []);

  const manualRecoveryTarget = path.join(directory, "manual-recovery.sqlite");
  await assert.rejects(
    migrateBlobDocumentToSqlite(document, manualRecoveryTarget, {
      fileSystem: {
        syncDirectory: async () => { throw new Error("injected-directory-sync-failure"); },
        rm: async (candidate, options) => {
          if (typeof candidate === "string" && candidate.includes(".blob-migration-")) {
            throw new Error("injected-staged-cleanup-failure");
          }
          return (await import("node:fs/promises")).rm(candidate, options);
        },
      },
    }),
    /需要人工恢复/,
  );
  await assert.rejects(stat(manualRecoveryTarget));
  const recoveryResidue = (await readdir(directory)).filter((name) => name.includes(".blob-migration-"));
  assert.ok(recoveryResidue.length > 0);
  await Promise.all(recoveryResidue.map(async (name) => (await import("node:fs/promises")).rm(path.join(directory, name), { force: true })));

  const successTarget = path.join(directory, "success.sqlite");
  await migrateBlobDocumentToSqlite(document, successTarget);
  const names = await readdir(directory);
  assert.deepEqual(names.filter((name) => name.includes(".blob-migration-") || name.endsWith("-wal") || name.endsWith("-shm")), []);
  await closeSqliteStorage(successTarget);
});

test("reauthorize_at_commit：文件系统 link 是最终提交授权边界，EACCES 后清理且可重试", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-blob-migration-commit-auth-"));
  const target = path.join(directory, "workspace.sqlite");
  const document = documentFixture();
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  // This is filesystem authorization at the irreversible publish boundary,
  // not an application-level authorization assertion.
  await assert.rejects(
    migrateBlobDocumentToSqlite(document, target, {
      fileSystem: {
        link: async () => { throw Object.assign(new Error("commit denied"), { code: "EACCES" }); },
      },
    }),
    /commit denied/,
  );
  await assert.rejects(stat(target));
  assert.deepEqual(await readdir(directory), []);

  const retried = await migrateBlobDocumentToSqlite(document, target);
  assert.equal(retried.currentRevision, document.revision);
  await closeSqliteStorage(target);
});
