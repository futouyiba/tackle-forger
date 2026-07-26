import { get } from "@vercel/blob";
import { link, open, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  closeSqliteStorage,
  importSqliteWorkspace,
  verifySqliteWorkspaceImport,
  type SqliteWorkspaceImportVerification,
} from "../lib/sqlite-storage";
import { stableStringify } from "../lib/rule-kernel";
import type { RevisionInfo, WorkspaceState } from "../lib/types";
import { ensureWorkflowFields } from "../lib/workflow";

export type BlobWorkspaceDocument = {
  state: WorkspaceState;
  revision: number;
  revisions: Array<RevisionInfo & { state: WorkspaceState }>;
};

export type BlobMigrationReport = SqliteWorkspaceImportVerification & {
  databasePath: string;
  sourceRevisionCount: number;
  sourceRevisionMin: number;
  sourceRevisionMax: number;
  sourceRevisionGaps: number[];
  /** Blob retains at most a window; this migration never proves unavailable history was recovered. */
  historyTruncatedOrUnknown: true;
};

type MigrationDependencies = {
  importWorkspace?: typeof importSqliteWorkspace;
  verifyWorkspace?: typeof verifySqliteWorkspaceImport;
  beforePublish?: () => Promise<void> | void;
  /** Test seams for the publication durability protocol. */
  fileSystem?: Partial<Pick<typeof import("node:fs/promises"), "link" | "rm" | "stat" | "unlink">> & {
    syncDirectory?: (directory: string) => Promise<void>;
  };
};

function revisionWindow(document: BlobWorkspaceDocument) {
  const revisions = document.revisions.map((entry) => entry.revision).sort((left, right) => left - right);
  const gaps: number[] = [];
  for (let index = 1; index < revisions.length; index += 1) {
    for (let revision = revisions[index - 1]! + 1; revision < revisions[index]!; revision += 1) gaps.push(revision);
  }
  return { revisions, gaps };
}

/**
 * Verify internal consistency only. A valid Blob window can legitimately start
 * after revision 1, because old Blob revisions may already have been trimmed.
 */
export function assertBlobWorkspaceDocument(document: BlobWorkspaceDocument): void {
  if (!document || typeof document !== "object" || !document.state || !Number.isSafeInteger(document.revision) || document.revision < 1) {
    throw new Error("Blob 工作区格式无效：缺少 state 或有效 revision，拒绝迁移。");
  }
  if (!Array.isArray(document.revisions) || document.revisions.length === 0) {
    throw new Error("Blob 工作区格式无效：缺少可获得的 revisions，拒绝迁移。");
  }
  const revisions = new Set<number>();
  for (const entry of document.revisions) {
    if (!entry || !entry.state || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || revisions.has(entry.revision)) {
      throw new Error("Blob 工作区格式无效：可获得 revision 必须唯一且携带原始 state。");
    }
    revisions.add(entry.revision);
  }
  if (!revisions.has(document.revision)) {
    throw new Error("Blob 工作区格式无效：当前 revision 不在可获得历史窗口中，拒绝迁移。");
  }
  const current = document.revisions.find((entry) => entry.revision === document.revision)!;
  // `ensureWorkflowFields` is exactly the normalization used by the SQLite
  // importer. Compare canonical JSON so source key order cannot hide or invent
  // a mismatch, while unknown fields remain part of the comparison.
  const normalizedTopLevel = ensureWorkflowFields(structuredClone(document.state));
  const normalizedCurrentRevision = ensureWorkflowFields(structuredClone(current.state));
  if (stableStringify(normalizedTopLevel) !== stableStringify(normalizedCurrentRevision)) {
    throw new Error("Blob 工作区格式无效：顶层 state 与当前 revision 快照不一致，拒绝迁移。");
  }
}

/**
 * Windows (and some other platforms via libuv) reject `fsync` on a *directory*
 * file descriptor with EPERM — they cannot fsync directory fds at all. This is
 * not a permission problem (that fails at `open`): it is a hard platform
 * limitation, verified to be independent of volume type. Directory-entry
 * visibility on those platforms is already atomic via `link`/`unlink`, and NTFS
 * metadata journaling covers crash recovery, so dropping the directory fsync
 * there is a safe best-effort degradation rather than a lost durability
 * guarantee. Production runs on Linux, where directory fsync succeeds and the
 * full publication protocol holds unchanged.
 */
export function isDirectoryFsyncTolerableError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === "EPERM";
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isDirectoryFsyncTolerableError(error)) throw error;
  } finally {
    await handle.close();
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function removeStagedDatabase(
  databasePath: string,
  remove: typeof rm,
) {
  const errors: unknown[] = [];
  try {
    await closeSqliteStorage(databasePath);
  } catch (error) {
    errors.push(error);
  }
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      await remove(candidate, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Import into a unique sibling file, verify it, then publish with an atomic
 * no-replace hard link. `link` is used instead of rename because POSIX rename
 * may overwrite a concurrently-created target; EEXIST therefore fails closed.
 */
export async function migrateBlobDocumentToSqlite(
  document: BlobWorkspaceDocument,
  targetPath: string,
  dependencies: MigrationDependencies = {},
): Promise<BlobMigrationReport> {
  assertBlobWorkspaceDocument(document);
  const target = path.resolve(targetPath);
  const fileSystem = dependencies.fileSystem ?? {};
  const linkFile = fileSystem.link ?? link;
  const remove = fileSystem.rm ?? rm;
  const statFile = fileSystem.stat ?? stat;
  const unlinkFile = fileSystem.unlink ?? unlink;
  const syncParent = fileSystem.syncDirectory ?? syncDirectory;
  if (await statFile(target).then(() => true).catch(() => false)) throw new Error(`目标数据库已存在，拒绝覆盖：${target}`);
  const staged = path.join(path.dirname(target), `.${path.basename(target)}.blob-migration-${randomUUID()}.sqlite`);
  const importWorkspace = dependencies.importWorkspace ?? importSqliteWorkspace;
  const verifyWorkspace = dependencies.verifyWorkspace ?? verifySqliteWorkspaceImport;
  let stagedIdentity: { dev: number; ino: number } | null = null;
  let linkSucceeded = false;
  try {
    await importWorkspace(staged, document);
    await closeSqliteStorage(staged);
    const verification = await verifyWorkspace(staged, document);
    await closeSqliteStorage(staged);
    await dependencies.beforePublish?.();
    // Capture the staged inode before `link`. Once `link` resolves, every
    // later operation is in the post-publication failure domain, even if a
    // subsequent stat/fsync itself fails.
    const stagedInfo = await statFile(staged);
    stagedIdentity = { dev: stagedInfo.dev, ino: stagedInfo.ino };
    // Atomic publish that cannot replace a target created by another migration.
    await linkFile(staged, target);
    linkSucceeded = true;
    // The link itself is atomic, but a successful migration is not reported
    // until the directory entries are durable and the staging link is gone.
    await syncParent(path.dirname(target));
    await unlinkFile(staged);
    await syncParent(path.dirname(target));
    const { revisions, gaps } = revisionWindow(document);
    return {
      databasePath: target,
      ...verification,
      sourceRevisionCount: revisions.length,
      sourceRevisionMin: revisions[0]!,
      sourceRevisionMax: revisions.at(-1)!,
      sourceRevisionGaps: gaps,
      historyTruncatedOrUnknown: true,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (linkSucceeded && stagedIdentity) {
      try {
        let existing: Awaited<ReturnType<typeof stat>> | undefined;
        try {
          existing = await statFile(target);
        } catch {
          cleanupErrors.push(new Error(`无法确认或删除本次发布的目标数据库：${target}；需要人工恢复。`));
        }
        if (existing && (existing.dev !== stagedIdentity.dev || existing.ino !== stagedIdentity.ino)) {
          cleanupErrors.push(new Error("目标数据库 inode 已变化，拒绝删除可能由其他进程创建的文件。"));
        } else if (existing) {
          await unlinkFile(target);
          await syncParent(path.dirname(target));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    cleanupErrors.push(...await removeStagedDatabase(staged, remove));
    if (cleanupErrors.length) {
      throw new Error(
        `Blob→SQLite 迁移失败，且无法完全清理发布/暂存文件；需要人工恢复。原始错误：${errorText(error)}；清理错误：${cleanupErrors.map(errorText).join("；")}`,
      );
    }
    if (linkSucceeded) {
      throw new Error(`Blob→SQLite 发布后持久化或清理失败，已回滚本次创建的目标；可修复后重试。原始错误：${errorText(error)}`);
    }
    throw error;
  }
}

export async function migrateBlobToSqlite(environment = process.env): Promise<BlobMigrationReport> {
  const target = environment.WORKSPACE_DATABASE_PATH?.trim();
  if (!target) throw new Error("必须设置 WORKSPACE_DATABASE_PATH。");
  if (!environment.BLOB_READ_WRITE_TOKEN) throw new Error("必须设置 BLOB_READ_WRITE_TOKEN。");
  const result = await get("workspace/main.json", { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error("Blob 中没有找到 workspace/main.json。");
  return migrateBlobDocumentToSqlite(JSON.parse(await new Response(result.stream).text()) as BlobWorkspaceDocument, target);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await migrateBlobToSqlite()));
}
