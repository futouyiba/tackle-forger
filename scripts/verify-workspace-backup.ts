import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DATABASE_FILE_NAME = "workspace.sqlite";
const TEMPORARY_DIRECTORY_PREFIX = "tackle-forger-backup-verify-";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function requireDirectory(directory: string) {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (error) {
    throw new Error(`备份目录不可访问：${directory} (${errorMessage(error)})`, { cause: error });
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`备份目录必须是实际目录，不能是符号链接或普通文件：${directory}`);
  }
}

async function requireDatabaseFile(databasePath: string) {
  let entry;
  try {
    entry = await lstat(databasePath);
  } catch (error) {
    throw new Error(`备份中缺少 ${DATABASE_FILE_NAME}：${databasePath} (${errorMessage(error)})`, { cause: error });
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${DATABASE_FILE_NAME} 必须是实际文件，不能是符号链接或目录：${databasePath}`);
  }
}

function assertIntegrityCheckResult(rows: Array<Record<string, unknown>>) {
  const results = rows.map((row) => row.integrity_check);
  if (results.length !== 1 || results[0] !== "ok") {
    throw new Error(`SQLite PRAGMA integrity_check 未通过：${JSON.stringify(results)}`);
  }
}

/**
 * Verifies a completed workspace backup without opening or modifying its SQLite file.
 * SQLite only sees a private temporary copy, so it cannot create -wal or -shm next to
 * the immutable backup artifact.
 */
export async function verifyWorkspaceBackupDirectory(
  backupDirectory: string,
) {
  if (!backupDirectory.trim()) throw new Error("必须提供备份目录参数");

  const resolvedBackupDirectory = path.resolve(backupDirectory);
  await requireDirectory(resolvedBackupDirectory);
  const sourceDatabasePath = path.join(resolvedBackupDirectory, DATABASE_FILE_NAME);
  await requireDatabaseFile(sourceDatabasePath);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
  const copiedDatabasePath = path.join(temporaryDirectory, DATABASE_FILE_NAME);
  let verificationFailure: unknown;

  try {
    await copyFile(sourceDatabasePath, copiedDatabasePath);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(copiedDatabasePath, { readOnly: true, timeout: 5_000 });
      assertIntegrityCheckResult(database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>);
    } finally {
      database?.close();
    }
  } catch (error) {
    verificationFailure = error;
    throw new Error(`备份校验失败：${resolvedBackupDirectory} (${errorMessage(error)})`, { cause: error });
  } finally {
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (verificationFailure) {
        throw new Error(
          `备份校验失败，且临时副本清理失败：${errorMessage(verificationFailure)}；${errorMessage(cleanupError)}`,
          { cause: cleanupError },
        );
      }
      throw new Error(`备份校验完成，但临时副本清理失败：${errorMessage(cleanupError)}`, { cause: cleanupError });
    }
  }
}

async function runCommandLine() {
  const backupDirectory = process.argv[2];
  if (!backupDirectory || process.argv.length !== 3) {
    throw new Error("用法：npm run storage:verify-backup -- <备份目录>");
  }
  await verifyWorkspaceBackupDirectory(backupDirectory);
  console.log(JSON.stringify({ backup: path.resolve(backupDirectory), integrityCheck: "ok" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommandLine().catch((error: unknown) => {
    console.error(`备份校验失败：${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
