import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileAIBackupPurgeAdapter } from "../lib/ai-backup-purge";
import {
  AI_RETENTION_POLICY_VERSION,
  purgeAIAssessmentBackups,
  type AIAssessmentRetentionRecord,
} from "../lib/ai-retention";

const dueAt = new Date("2026-08-22T01:00:00.000Z");

function dueDeletionRecord(): AIAssessmentRetentionRecord {
  return {
    policyVersion: AI_RETENTION_POLICY_VERSION,
    visibility: "HIDDEN",
    deletionTombstone: {
      assessmentId: "assessment-backup-root",
      requestedAt: "2026-07-23T01:00:00.000Z",
      requestedBy: "owner-backup-root",
      primaryPurgeDueAt: "2026-07-24T01:00:00.000Z",
      backupPurgeDueAt: dueAt.toISOString(),
    },
  };
}

test("备份根目录缺失或不可读取时 fail-closed，修复目录后可重试", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-backup-root-"));
  const missingRoot = path.join(root, "missing");
  const nonDirectoryRoot = path.join(root, "not-a-directory");
  await writeFile(nonDirectoryRoot, "not a backup directory\n", "utf8");

  try {
    let missingRootFailure: AIAssessmentRetentionRecord | undefined;
    for (const unavailableRoot of [missingRoot, nonDirectoryRoot]) {
      const failed = await purgeAIAssessmentBackups({
        record: dueDeletionRecord(),
        now: dueAt,
        adapter: createFileAIBackupPurgeAdapter(unavailableRoot),
      });
      if (unavailableRoot === missingRoot) missingRootFailure = failed.record;

      assert.equal(failed.record.deletionTombstone?.backupPurgeState, "FAILED");
      assert.equal(failed.record.deletionTombstone?.backupPurgedAt, undefined);
      assert.equal(failed.record.deletionTombstone?.backupPurgeAttempts, 1);
      assert.equal(
        failed.record.deletionTombstone?.backupPurgeLastErrorCode,
        "AI_BACKUP_ROOT_UNAVAILABLE",
      );
      assert.deepEqual(
        failed.auditEvents.map((event) => event.action),
        ["AI_BACKUP_PURGE_FAILED"],
      );
    }

    await mkdir(missingRoot);
    assert.ok(missingRootFailure);
    const retried = await purgeAIAssessmentBackups({
      record: missingRootFailure,
      now: new Date(dueAt.getTime() + 1_000),
      adapter: createFileAIBackupPurgeAdapter(missingRoot),
    });

    assert.equal(retried.record.deletionTombstone?.backupPurgeState, "PURGED");
    assert.ok(retried.record.deletionTombstone?.backupPurgedAt);
    assert.equal(retried.record.deletionTombstone?.backupPurgeAttempts, 2);
    assert.equal(retried.record.deletionTombstone?.backupPurgeLastErrorCode, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
