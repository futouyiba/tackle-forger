import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const databasePath = path.resolve(process.env.WORKSPACE_DATABASE_PATH?.trim() || ".data/workspace.sqlite");
const dataDir = path.resolve(process.env.WORKSPACE_FILE_DATA_DIR?.trim() || path.join(path.dirname(databasePath), "files"));
const sessionDataDir = path.resolve(process.env.FEISHU_SESSION_DATA_DIR?.trim() || ".data/auth");
const backupRoot = path.resolve(process.env.WORKSPACE_BACKUP_DIR?.trim() || path.join(path.dirname(databasePath), "backups"));
const retentionDays = Number(process.env.WORKSPACE_BACKUP_RETENTION_DAYS || "30");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetDir = path.join(backupRoot, stamp);

await stat(databasePath);
await mkdir(targetDir, { recursive: true, mode: 0o700 });
const source = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
try {
  const backupDatabasePath = path.join(targetDir, "workspace.sqlite");
  await backup(source, backupDatabasePath);
  await chmod(backupDatabasePath, 0o600);
} finally {
  source.close();
}
if (await stat(dataDir).then((entry) => entry.isDirectory()).catch(() => false)) {
  await cp(dataDir, path.join(targetDir, "files"), { recursive: true, preserveTimestamps: true });
}
const sessionDataIncluded = await stat(sessionDataDir).then((entry) => entry.isDirectory()).catch(() => false);
if (sessionDataIncluded) {
  const sessionBackupDir = path.join(targetDir, "auth");
  await cp(sessionDataDir, sessionBackupDir, { recursive: true, preserveTimestamps: true });
  await chmod(sessionBackupDir, 0o700);
}
await writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify({
  createdAt: new Date().toISOString(), databasePath, dataDir, sessionDataDir, sessionDataIncluded,
}, null, 2)}\n`, { mode: 0o600 });

if (Number.isFinite(retentionDays) && retentionDays > 0) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T/.test(entry.name)) continue;
    const candidate = path.join(backupRoot, entry.name);
    if ((await stat(candidate)).mtimeMs < cutoff) await rm(candidate, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ backup: targetDir, retentionDays }));
