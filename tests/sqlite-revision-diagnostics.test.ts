import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import {
  inspectSqliteRevisionStorage,
  SqliteRevisionDiagnosticsError,
} from "../lib/sqlite-revision-diagnostics";
import {
  closeSqliteStorage,
  listSqliteRevisions,
  loadSqliteWorkspace,
  saveSqliteWorkspace,
} from "../lib/sqlite-storage";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function createDatabaseWithTwoRevisions(databasePath: string) {
  const initial = await loadSqliteWorkspace(databasePath);
  const changed = structuredClone(initial.state);
  changed.notes = "revision diagnostics fixture";
  const result = await saveSqliteWorkspace(databasePath, {
    state: changed,
    baseRevision: initial.revision,
    author: "diagnostics-test",
    message: "add observable revision",
  });
  assert.equal(result.conflict, undefined);
  await closeSqliteStorage(databasePath);
  return result.revision;
}

function createRollbackJournalDatabaseWithTwoRevisions(databasePath: string) {
  const db = new DatabaseSync(databasePath);
  const journalMode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string };
  assert.equal(journalMode.journal_mode, "delete");
  db.exec(`
    CREATE TABLE workspace_state (
      id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE TABLE workspace_revisions (
      revision INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const firstState = JSON.stringify({ revision: 1, notes: "rollback journal fixture" });
  const currentState = JSON.stringify({ revision: 2, notes: "rollback journal current" });
  db.prepare("INSERT INTO workspace_revisions (revision, state_json, created_at) VALUES (?, ?, ?)")
    .run(1, firstState, "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO workspace_revisions (revision, state_json, created_at) VALUES (?, ?, ?)")
    .run(2, currentState, "2026-01-02T00:00:00.000Z");
  db.prepare("INSERT INTO workspace_state (id, state_json, revision) VALUES (?, ?, ?)")
    .run("main", currentState, 2);
  db.close();
}

async function readDirectoryFiles(directory: string) {
  const names = (await readdir(directory)).sort();
  const contents = await Promise.all(names.map(async (name) => [
    name,
    createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex"),
  ] as const));
  return { names, contents: Object.fromEntries(contents) as Record<string, string> };
}

test("AUD-009 SQLite revision 诊断只读返回容量、时间和文件统计", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-revision-diagnostics-"));
  const databasePath = path.join(directory, "workspace.sqlite");
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    await rm(directory, { recursive: true, force: true });
  });
  const currentRevision = await createDatabaseWithTwoRevisions(databasePath);
  const historyBefore = await listSqliteRevisions(databasePath);
  await closeSqliteStorage(databasePath);
  const databaseBefore = await readFile(databasePath);
  const invocationStartedAt = Date.now();

  const diagnostics = await inspectSqliteRevisionStorage(databasePath);
  const invocationFinishedAt = Date.now();

  assert.ok(Date.parse(diagnostics.sampledFrom) >= invocationStartedAt);
  assert.ok(Date.parse(diagnostics.sampledFrom) <= Date.parse(diagnostics.sampledTo));
  assert.ok(Date.parse(diagnostics.sampledTo) <= invocationFinishedAt);
  assert.equal(diagnostics.currentRevision, currentRevision);
  assert.equal(diagnostics.revisionCount, 2);
  assert.equal(diagnostics.minimumRevision, 1);
  assert.equal(diagnostics.maximumRevision, currentRevision);
  assert.ok(Date.parse(diagnostics.earliestCreatedAt) <= Date.parse(diagnostics.latestCreatedAt));
  assert.ok(diagnostics.stateJsonTotalBytes > 0);
  assert.equal(
    diagnostics.stateJsonAverageBytes,
    Math.round(diagnostics.stateJsonTotalBytes / diagnostics.revisionCount),
  );
  assert.ok(diagnostics.stateJsonMaximumBytes >= diagnostics.stateJsonAverageBytes);
  assert.equal(diagnostics.databaseFileBytes, (await stat(databasePath)).size);
  assert.ok(diagnostics.sqliteAllocatedBytes >= diagnostics.databaseFileBytes);
  assert.equal(
    diagnostics.sqliteReusableBytes,
    diagnostics.sqlitePageSizeBytes * diagnostics.sqliteFreelistPages,
  );
  assert.equal(typeof diagnostics.walPresent, "boolean");
  assert.ok(diagnostics.walFileBytes >= 0);
  assert.deepEqual(await readFile(databasePath), databaseBefore);
  assert.deepEqual(await listSqliteRevisions(databasePath), historyBefore);
});

test("AUD-009 无 WAL 数据库诊断不创建 WAL/SHM 并显式返回零值", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-revision-no-wal-"));
  const databasePath = path.join(directory, "workspace.sqlite");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  createRollbackJournalDatabaseWithTwoRevisions(databasePath);
  const before = await readDirectoryFiles(directory);
  assert.deepEqual(before.names, ["workspace.sqlite"]);

  const diagnostics = await inspectSqliteRevisionStorage(databasePath);

  assert.equal(diagnostics.walPresent, false);
  assert.equal(diagnostics.walFileBytes, 0);
  assert.deepEqual(await readDirectoryFiles(directory), before);
  await assert.rejects(stat(`${databasePath}-wal`), { code: "ENOENT" });
  await assert.rejects(stat(`${databasePath}-shm`), { code: "ENOENT" });
});

test("AUD-009 SQLite revision 诊断缺路径、缺数据库或缺schema时 fail-closed 且不创建文件", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-revision-diagnostics-missing-"));
  const missingPath = path.join(directory, "missing.sqlite");
  const emptyPath = path.join(directory, "empty.sqlite");
  const emptyHistoryPath = path.join(directory, "empty-history.sqlite");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    inspectSqliteRevisionStorage(" "),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_PATH_REQUIRED",
  );
  const environmentWithoutDatabasePath = { ...process.env };
  delete environmentWithoutDatabasePath.WORKSPACE_DATABASE_PATH;
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(repositoryRoot, "scripts/diagnose-workspace-revisions.ts")],
      { cwd: repositoryRoot, env: environmentWithoutDatabasePath },
    ),
    (error: unknown) => typeof error === "object"
      && error !== null
      && "stderr" in error
      && typeof error.stderr === "string"
      && error.stderr.includes("必须设置 WORKSPACE_DATABASE_PATH"),
  );
  await assert.rejects(
    inspectSqliteRevisionStorage(missingPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_DATABASE_UNAVAILABLE",
  );
  await assert.rejects(stat(missingPath), { code: "ENOENT" });

  new DatabaseSync(emptyPath).close();
  const emptyBefore = await readFile(emptyPath);
  await assert.rejects(
    inspectSqliteRevisionStorage(emptyPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_SCHEMA_MISSING",
  );
  assert.deepEqual(await readFile(emptyPath), emptyBefore);

  await createDatabaseWithTwoRevisions(emptyHistoryPath);
  const emptyHistoryDb = new DatabaseSync(emptyHistoryPath);
  emptyHistoryDb.exec("DELETE FROM workspace_revisions");
  emptyHistoryDb.close();
  await assert.rejects(
    inspectSqliteRevisionStorage(emptyHistoryPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_EMPTY_HISTORY",
  );
});

test("AUD-009 SQLite revision 诊断遇到非法时间或当前历史错位时 fail-closed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-revision-diagnostics-invalid-"));
  const timestampPath = path.join(directory, "timestamp.sqlite");
  const futureTimestampPath = path.join(directory, "future-timestamp.sqlite");
  const mismatchPath = path.join(directory, "mismatch.sqlite");
  const invalidJsonPath = path.join(directory, "invalid-json.sqlite");
  t.after(async () => {
    await closeSqliteStorage(timestampPath);
    await closeSqliteStorage(futureTimestampPath);
    await closeSqliteStorage(mismatchPath);
    await closeSqliteStorage(invalidJsonPath);
    await rm(directory, { recursive: true, force: true });
  });

  await createDatabaseWithTwoRevisions(timestampPath);
  const timestampDb = new DatabaseSync(timestampPath);
  timestampDb.prepare("UPDATE workspace_revisions SET created_at = ? WHERE revision = 1").run("not-a-time");
  timestampDb.close();
  await assert.rejects(
    inspectSqliteRevisionStorage(timestampPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_INVALID_TIMESTAMP",
  );

  await createDatabaseWithTwoRevisions(futureTimestampPath);
  const futureTimestampDb = new DatabaseSync(futureTimestampPath);
  futureTimestampDb.prepare("UPDATE workspace_revisions SET created_at = ? WHERE revision = 1")
    .run("2999-01-01T00:00:00.000Z");
  futureTimestampDb.close();
  await assert.rejects(
    inspectSqliteRevisionStorage(futureTimestampPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_INVALID_TIMESTAMP",
  );

  await createDatabaseWithTwoRevisions(invalidJsonPath);
  const invalidJsonDb = new DatabaseSync(invalidJsonPath);
  invalidJsonDb.prepare("UPDATE workspace_revisions SET state_json = ? WHERE revision = 1").run("not-json");
  invalidJsonDb.close();
  await assert.rejects(
    inspectSqliteRevisionStorage(invalidJsonPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_INVALID_STATISTICS",
  );

  await createDatabaseWithTwoRevisions(mismatchPath);
  const mismatchDb = new DatabaseSync(mismatchPath);
  mismatchDb.prepare("UPDATE workspace_state SET revision = ? WHERE id = ?").run(99, "main");
  mismatchDb.close();
  await assert.rejects(
    inspectSqliteRevisionStorage(mismatchPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_REVISION_MISMATCH",
  );

  const stateMismatchPath = path.join(directory, "state-mismatch.sqlite");
  await createDatabaseWithTwoRevisions(stateMismatchPath);
  const stateMismatchDb = new DatabaseSync(stateMismatchPath);
  stateMismatchDb.prepare("UPDATE workspace_state SET state_json = ? WHERE id = ?").run("{}", "main");
  stateMismatchDb.close();
  await assert.rejects(
    inspectSqliteRevisionStorage(stateMismatchPath),
    (error: unknown) => error instanceof SqliteRevisionDiagnosticsError
      && error.code === "SQLITE_DIAGNOSTICS_REVISION_MISMATCH",
  );
});

test("AUD-009 工作区备份 manifest 冻结静态副本诊断和在线源库近似观测", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-revision-backup-"));
  const databasePath = path.join(directory, "workspace.sqlite");
  const backupRoot = path.join(directory, "backups");
  const currentRevision = await createDatabaseWithTwoRevisions(databasePath);
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    await rm(directory, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", path.join(repositoryRoot, "scripts/backup-workspace.ts")],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        WORKSPACE_DATABASE_PATH: databasePath,
        WORKSPACE_FILE_DATA_DIR: path.join(directory, "files"),
        FEISHU_SESSION_DATA_DIR: path.join(directory, "auth"),
        WORKSPACE_BACKUP_DIR: backupRoot,
        WORKSPACE_BACKUP_RETENTION_DAYS: "30",
      },
    },
  );
  const result = JSON.parse(stdout.trim()) as { backup: string; retentionDays: number };
  const manifest = JSON.parse(await readFile(path.join(result.backup, "manifest.json"), "utf8")) as {
    revisionDiagnostics: Awaited<ReturnType<typeof inspectSqliteRevisionStorage>>;
    sourceOnlineStorageObservation: {
      observationMode: "online_approximate_interval";
      sampledFrom: string;
      sampledTo: string;
      databaseFileBytes: number;
      walPresent: boolean;
      walFileBytes: number;
    };
  };

  assert.equal(result.retentionDays, 30);
  assert.equal("sourceStorageFilesAtBackupStart" in manifest, false);
  assert.equal(manifest.revisionDiagnostics.currentRevision, currentRevision);
  assert.equal(manifest.revisionDiagnostics.revisionCount, 2);
  assert.equal(
    manifest.revisionDiagnostics.databasePath,
    path.join(result.backup, "workspace.sqlite"),
  );
  assert.ok(manifest.revisionDiagnostics.stateJsonTotalBytes > 0);
  assert.equal(manifest.sourceOnlineStorageObservation.observationMode, "online_approximate_interval");
  assert.ok(manifest.sourceOnlineStorageObservation.databaseFileBytes > 0);
  assert.equal(typeof manifest.sourceOnlineStorageObservation.walPresent, "boolean");
  assert.ok(manifest.sourceOnlineStorageObservation.walFileBytes >= 0);
  assert.ok(Date.parse(manifest.sourceOnlineStorageObservation.sampledFrom) > 0);
  assert.ok(
    Date.parse(manifest.sourceOnlineStorageObservation.sampledFrom)
      <= Date.parse(manifest.sourceOnlineStorageObservation.sampledTo),
  );
  assert.deepEqual((await listSqliteRevisions(databasePath)).map((entry) => entry.revision), [2, 1]);
});
