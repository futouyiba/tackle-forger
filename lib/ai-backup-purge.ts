import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AIBackupPurgeAdapter } from "./ai-retention";
import { AIRuntimeStoreError } from "./ai-runtime-store";

function assertAssessmentId(value: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "备份清理 assessmentId 格式无效。");
  }
}

async function assessmentBackupFiles(backupRoot: string, assessmentId: string): Promise<string[]> {
  assertAssessmentId(assessmentId);
  const entries = await readdir(backupRoot, { withFileTypes: true }).catch(() => {
    throw new AIRuntimeStoreError(
      "AI_RETENTION_STORE_UNAVAILABLE",
      "AI_BACKUP_ROOT_UNAVAILABLE",
    );
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(backupRoot, entry.name, "ai-retention", "assessments", `${assessmentId}.json`));
}

export function createFileAIBackupPurgeAdapter(backupRootInput: string): AIBackupPurgeAdapter {
  const backupRoot = path.resolve(backupRootInput);
  return {
    async purgeAssessmentBackups({ assessmentId }) {
      for (const file of await assessmentBackupFiles(backupRoot, assessmentId)) {
        await rm(file, { force: true });
      }
    },
    async verifyAssessmentBackupsAbsent({ assessmentId }) {
      for (const file of await assessmentBackupFiles(backupRoot, assessmentId)) {
        const present = await lstat(file).then(() => true).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (present) return false;
      }
      return true;
    },
  };
}

export function createFileAIBackupPurgeAdapterFromEnvironment(): AIBackupPurgeAdapter {
  const backupRoot = process.env.WORKSPACE_BACKUP_DIR?.trim();
  if (!backupRoot) {
    throw new AIRuntimeStoreError("AI_RETENTION_CONFIG_INVALID", "AI 留存清理需要配置 WORKSPACE_BACKUP_DIR。");
  }
  return createFileAIBackupPurgeAdapter(backupRoot);
}
