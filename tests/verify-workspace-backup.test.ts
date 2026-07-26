import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { verifyWorkspaceBackupDirectory } from "../scripts/verify-workspace-backup";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function backupManifest(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifest: Record<string, string> = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if ((await lstat(entryPath)).isSymbolicLink()) {
      manifest[entry.name] = `symlink:${await readlink(entryPath)}`;
    } else if (entry.isDirectory()) {
      const nested = await backupManifest(entryPath);
      for (const [name, hash] of Object.entries(nested)) manifest[`${entry.name}/${name}`] = hash;
    } else {
      manifest[entry.name] = sha256(await readFile(entryPath));
    }
  }
  return manifest;
}

async function verificationTemporaryDirectories() {
  return (await readdir(os.tmpdir())).filter((name) => name.startsWith("tackle-forger-backup-verify-"));
}

async function assertRejectedWithoutMutation(
  sourceRoot: string,
  operation: () => Promise<unknown>,
  expectedError: RegExp,
) {
  const sourceBefore = await backupManifest(sourceRoot);
  const temporaryBefore = await verificationTemporaryDirectories();
  await assert.rejects(operation, expectedError);
  assert.deepEqual(await backupManifest(sourceRoot), sourceBefore);
  assert.deepEqual(await verificationTemporaryDirectories(), temporaryBefore);
}

async function runVerifierCommand(arguments_: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/verify-workspace-backup.ts", ...arguments_], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createProductionShapeBackup(root: string) {
  const backupDirectory = path.join(root, "backup-2026-07-26");
  await mkdir(path.join(backupDirectory, "files"), { recursive: true });
  const databasePath = path.join(backupDirectory, "workspace.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE workspace_revisions (
        revision INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    database.prepare("INSERT INTO workspace_revisions (revision, state_json, created_at) VALUES (?, ?, ?)").run(
      43,
      await readFile(new URL("./fixtures/workspace-production-schema-v17.json", import.meta.url), "utf8"),
      "2026-07-26T00:00:00.000Z",
    );
  } finally {
    database.close();
  }
  await writeFile(path.join(backupDirectory, "files", "production-redacted.bin"), "fixture");
  await writeFile(path.join(backupDirectory, "manifest.json"), "{\"version\":1}\n");
  return backupDirectory;
}

test("production_shape_fixture：校验私有副本，备份目录和 SQLite 边车文件均保持不变", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-backup-verify-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const backupDirectory = await createProductionShapeBackup(root);
  const before = await backupManifest(backupDirectory);
  const temporaryBefore = await verificationTemporaryDirectories();
  await verifyWorkspaceBackupDirectory(backupDirectory);
  const after = await backupManifest(backupDirectory);

  assert.deepEqual(after, before);
  assert.equal(after["workspace.sqlite-wal"], undefined);
  assert.equal(after["workspace.sqlite-shm"], undefined);
  assert.deepEqual(await verificationTemporaryDirectories(), temporaryBefore);
});

test("损坏备份失败后仍清理临时副本，且不触碰备份目录", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-backup-verify-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const backupDirectory = path.join(root, "corrupt-backup");
  await mkdir(backupDirectory);
  await writeFile(path.join(backupDirectory, "workspace.sqlite"), "not a sqlite database");
  const before = await backupManifest(backupDirectory);
  const temporaryBefore = await verificationTemporaryDirectories();

  await assert.rejects(
    verifyWorkspaceBackupDirectory(backupDirectory),
    /备份校验失败.*SQLite|备份校验失败.*file is not a database/,
  );

  assert.deepEqual(await backupManifest(backupDirectory), before);
  assert.deepEqual(await verificationTemporaryDirectories(), temporaryBefore);
});

test("边界：空路径、缺失目录和缺失 workspace.sqlite 都拒绝且没有副作用", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-backup-verify-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  await assertRejectedWithoutMutation(root, () => verifyWorkspaceBackupDirectory("   "), /必须提供备份目录参数/);
  await assertRejectedWithoutMutation(root, () => verifyWorkspaceBackupDirectory(path.join(root, "missing")), /备份目录不可访问/);

  const missingDatabaseDirectory = path.join(root, "missing-database");
  await mkdir(missingDatabaseDirectory);
  await assertRejectedWithoutMutation(
    missingDatabaseDirectory,
    () => verifyWorkspaceBackupDirectory(missingDatabaseDirectory),
    /备份中缺少 workspace\.sqlite/,
  );
});

test("冲突边界：备份目录、workspace.sqlite 符号链接或 workspace.sqlite 目录都拒绝且不修改源", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-backup-verify-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const actualBackup = await createProductionShapeBackup(root);
  const linkedBackup = path.join(root, "linked-backup");
  await symlink(actualBackup, linkedBackup);
  await assertRejectedWithoutMutation(root, () => verifyWorkspaceBackupDirectory(linkedBackup), /备份目录必须是实际目录/);

  const linkedDatabaseBackup = path.join(root, "linked-database");
  await mkdir(linkedDatabaseBackup);
  await symlink(path.join(actualBackup, "workspace.sqlite"), path.join(linkedDatabaseBackup, "workspace.sqlite"));
  await assertRejectedWithoutMutation(
    linkedDatabaseBackup,
    () => verifyWorkspaceBackupDirectory(linkedDatabaseBackup),
    /workspace\.sqlite 必须是实际文件/,
  );

  const directoryDatabaseBackup = path.join(root, "directory-database");
  await mkdir(path.join(directoryDatabaseBackup, "workspace.sqlite"), { recursive: true });
  await assertRejectedWithoutMutation(
    directoryDatabaseBackup,
    () => verifyWorkspaceBackupDirectory(directoryDatabaseBackup),
    /workspace\.sqlite 必须是实际文件/,
  );
});

test("CLI：零参数和额外参数均非零退出、不输出成功 JSON，且不改变备份或临时目录", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-backup-verify-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const backupDirectory = await createProductionShapeBackup(root);
  for (const arguments_ of [[], [backupDirectory, "unexpected"]]) {
    const sourceBefore = await backupManifest(root);
    const temporaryBefore = await verificationTemporaryDirectories();
    const result = await runVerifierCommand(arguments_);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /用法：npm run storage:verify-backup/);
    assert.doesNotMatch(result.stdout, /"integrityCheck":"ok"/);
    assert.deepEqual(await backupManifest(root), sourceBefore);
    assert.deepEqual(await verificationTemporaryDirectories(), temporaryBefore);
  }
});

test("second_run_noop：同一备份可重复校验，两个运行后字节和目录清单均不变", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-backup-verify-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const backupDirectory = await createProductionShapeBackup(root);
  const before = await backupManifest(backupDirectory);
  const temporaryBefore = await verificationTemporaryDirectories();
  await verifyWorkspaceBackupDirectory(backupDirectory);
  await verifyWorkspaceBackupDirectory(backupDirectory);

  assert.deepEqual(await backupManifest(backupDirectory), before);
  assert.deepEqual(await verificationTemporaryDirectories(), temporaryBefore);
});
