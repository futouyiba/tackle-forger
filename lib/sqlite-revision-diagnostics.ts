import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteRevisionDiagnosticsErrorCode =
  | "SQLITE_DIAGNOSTICS_PATH_REQUIRED"
  | "SQLITE_DIAGNOSTICS_DATABASE_UNAVAILABLE"
  | "SQLITE_DIAGNOSTICS_SCHEMA_MISSING"
  | "SQLITE_DIAGNOSTICS_EMPTY_HISTORY"
  | "SQLITE_DIAGNOSTICS_INVALID_TIMESTAMP"
  | "SQLITE_DIAGNOSTICS_REVISION_MISMATCH"
  | "SQLITE_DIAGNOSTICS_INVALID_STATISTICS"
  | "SQLITE_DIAGNOSTICS_QUERY_FAILED";

export class SqliteRevisionDiagnosticsError extends Error {
  constructor(
    readonly code: SqliteRevisionDiagnosticsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SqliteRevisionDiagnosticsError";
  }
}

export interface SqliteRevisionStorageDiagnostics {
  capturedAt: string;
  databasePath: string;
  currentRevision: number;
  revisionCount: number;
  minimumRevision: number;
  maximumRevision: number;
  earliestCreatedAt: string;
  latestCreatedAt: string;
  stateJsonTotalBytes: number;
  stateJsonAverageBytes: number;
  stateJsonMaximumBytes: number;
  databaseFileBytes: number;
  walPresent: boolean;
  walFileBytes: number;
  sqlitePageSizeBytes: number;
  sqlitePageCount: number;
  sqliteFreelistPages: number;
  sqliteAllocatedBytes: number;
  sqliteReusableBytes: number;
}

type RevisionAggregateRow = {
  revision_count: number;
  minimum_revision: number | null;
  maximum_revision: number | null;
  state_json_total_bytes: number | null;
  state_json_average_bytes: number | null;
  state_json_maximum_bytes: number | null;
};

function diagnosticsError(
  code: SqliteRevisionDiagnosticsErrorCode,
  message: string,
  cause?: unknown,
) {
  return new SqliteRevisionDiagnosticsError(code, message, cause === undefined ? undefined : { cause });
}

function requireSafePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw diagnosticsError(
      "SQLITE_DIAGNOSTICS_INVALID_STATISTICS",
      `SQLite revision 诊断得到无效的${label}。`,
    );
  }
  return value;
}

function requireSafeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw diagnosticsError(
      "SQLITE_DIAGNOSTICS_INVALID_STATISTICS",
      `SQLite revision 诊断得到无效的${label}。`,
    );
  }
  return value;
}

async function requiredDatabaseFileSize(databasePath: string) {
  try {
    const entry = await stat(databasePath);
    if (!entry.isFile()) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_DATABASE_UNAVAILABLE",
        `SQLite revision 诊断目标不是普通文件：${databasePath}`,
      );
    }
    return requireSafeNonNegativeInteger(entry.size, "数据库文件字节数");
  } catch (error) {
    if (error instanceof SqliteRevisionDiagnosticsError) throw error;
    throw diagnosticsError(
      "SQLITE_DIAGNOSTICS_DATABASE_UNAVAILABLE",
      `无法读取 SQLite revision 诊断目标：${databasePath}`,
      error,
    );
  }
}

async function optionalWalFileSize(databasePath: string) {
  const walPath = `${databasePath}-wal`;
  try {
    const entry = await stat(walPath);
    if (!entry.isFile()) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_DATABASE_UNAVAILABLE",
        `SQLite WAL 路径存在但不是普通文件：${walPath}`,
      );
    }
    return { walPresent: true, walFileBytes: requireSafeNonNegativeInteger(entry.size, "WAL 文件字节数") };
  } catch (error) {
    if (error instanceof SqliteRevisionDiagnosticsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { walPresent: false, walFileBytes: 0 };
    }
    throw diagnosticsError(
      "SQLITE_DIAGNOSTICS_DATABASE_UNAVAILABLE",
      `无法读取 SQLite WAL 文件状态：${walPath}`,
      error,
    );
  }
}

function requiredPragmaInteger(db: DatabaseSync, pragma: "page_size" | "page_count" | "freelist_count") {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  return requireSafeNonNegativeInteger(row?.[pragma], `PRAGMA ${pragma}`);
}

/**
 * 以 read-only + query_only 连接读取 R730 SQLite 容量与时间诊断。
 * 本函数不复用会建表或播种的存储初始化路径，也不修复异常数据。
 */
export async function inspectSqliteRevisionStorage(
  databasePath: string,
): Promise<SqliteRevisionStorageDiagnostics> {
  if (!databasePath.trim()) {
    throw diagnosticsError(
      "SQLITE_DIAGNOSTICS_PATH_REQUIRED",
      "SQLite revision 诊断必须提供明确的数据库路径。",
    );
  }
  const resolved = path.resolve(databasePath);
  const databaseFileBytes = await requiredDatabaseFileSize(resolved);
  let db: DatabaseSync | undefined;
  let transactionOpen = false;
  try {
    db = new DatabaseSync(resolved, { readOnly: true, timeout: 5_000 });
    db.exec("PRAGMA query_only = ON");
    db.exec("BEGIN");
    transactionOpen = true;

    const tables = db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('workspace_state', 'workspace_revisions')",
    ).all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((row) => row.name));
    if (!tableNames.has("workspace_state") || !tableNames.has("workspace_revisions")) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_SCHEMA_MISSING",
        "SQLite revision 诊断需要 workspace_state 与 workspace_revisions 表；不会自动建表或播种。",
      );
    }

    const workspaceStateCount = db.prepare("SELECT COUNT(*) AS count FROM workspace_state").get() as { count: number };
    const current = db.prepare("SELECT revision, state_json FROM workspace_state WHERE id = ?").get("main") as
      | { revision: number; state_json: string }
      | undefined;
    if (workspaceStateCount.count !== 1 || !current) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_REVISION_MISMATCH",
        "SQLite workspace_state 必须且只能包含 main 当前状态；诊断不会猜测或修复。",
      );
    }

    const aggregate = db.prepare(`
      SELECT
        COUNT(*) AS revision_count,
        MIN(revision) AS minimum_revision,
        MAX(revision) AS maximum_revision,
        SUM(length(CAST(state_json AS BLOB))) AS state_json_total_bytes,
        AVG(length(CAST(state_json AS BLOB))) AS state_json_average_bytes,
        MAX(length(CAST(state_json AS BLOB))) AS state_json_maximum_bytes
      FROM workspace_revisions
    `).get() as RevisionAggregateRow;
    if (aggregate.revision_count === 0) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_EMPTY_HISTORY",
        "SQLite workspace_revisions 为空；诊断不会自动创建历史记录。",
      );
    }

    const invalidTimestamp = db.prepare(`
      SELECT revision, created_at
      FROM workspace_revisions
      WHERE typeof(created_at) <> 'text' OR trim(created_at) = '' OR julianday(created_at) IS NULL
      ORDER BY revision ASC
      LIMIT 1
    `).get() as { revision: number; created_at: string } | undefined;
    if (invalidTimestamp) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_INVALID_TIMESTAMP",
        `SQLite revision ${invalidTimestamp.revision} 的 created_at 无法解析；诊断不会替换或忽略。`,
      );
    }

    const earliest = db.prepare(`
      SELECT created_at
      FROM workspace_revisions
      ORDER BY julianday(created_at) ASC, revision ASC
      LIMIT 1
    `).get() as { created_at: string } | undefined;
    const latest = db.prepare(`
      SELECT created_at
      FROM workspace_revisions
      ORDER BY julianday(created_at) DESC, revision DESC
      LIMIT 1
    `).get() as { created_at: string } | undefined;
    const invalidStateJson = db.prepare(`
      SELECT revision
      FROM workspace_revisions
      WHERE typeof(state_json) <> 'text'
        OR length(CAST(state_json AS BLOB)) <= 0
        OR json_valid(state_json) <> 1
      ORDER BY revision ASC
      LIMIT 1
    `).get() as { revision: number } | undefined;
    if (invalidStateJson) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_INVALID_STATISTICS",
        `SQLite revision ${invalidStateJson.revision} 的 state_json 不是有效的非空 JSON 文本；诊断不会修复。`,
      );
    }

    const currentRevision = requireSafePositiveInteger(current.revision, "当前 revision");
    const revisionCount = requireSafePositiveInteger(aggregate.revision_count, "revision 总数");
    const minimumRevision = requireSafePositiveInteger(aggregate.minimum_revision, "最小 revision");
    const maximumRevision = requireSafePositiveInteger(aggregate.maximum_revision, "最大 revision");
    if (currentRevision !== maximumRevision) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_REVISION_MISMATCH",
        `SQLite 当前 revision ${currentRevision} 与最大历史 revision ${maximumRevision} 不一致。`,
      );
    }
    const currentHistory = db.prepare(
      "SELECT state_json FROM workspace_revisions WHERE revision = ?",
    ).get(currentRevision) as { state_json: string } | undefined;
    if (!currentHistory || currentHistory.state_json !== current.state_json) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_REVISION_MISMATCH",
        `SQLite 当前 revision ${currentRevision} 缺少内容一致的完整历史副本。`,
      );
    }

    const stateJsonTotalBytes = requireSafePositiveInteger(
      aggregate.state_json_total_bytes,
      "state_json 总字节数",
    );
    const stateJsonAverageRaw = aggregate.state_json_average_bytes;
    if (typeof stateJsonAverageRaw !== "number" || !Number.isFinite(stateJsonAverageRaw) || stateJsonAverageRaw <= 0) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_INVALID_STATISTICS",
        "SQLite revision 诊断得到无效的 state_json 平均字节数。",
      );
    }
    const stateJsonAverageBytes = requireSafePositiveInteger(
      Math.round(stateJsonAverageRaw),
      "state_json 平均字节数",
    );
    const stateJsonMaximumBytes = requireSafePositiveInteger(
      aggregate.state_json_maximum_bytes,
      "state_json 最大字节数",
    );
    if (!earliest?.created_at || !latest?.created_at) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_INVALID_TIMESTAMP",
        "SQLite revision 诊断无法确定最早或最新 created_at。",
      );
    }
    const earliestTimestamp = Date.parse(earliest.created_at);
    const latestTimestamp = Date.parse(latest.created_at);
    if (
      !Number.isFinite(earliestTimestamp)
      || !Number.isFinite(latestTimestamp)
      || latestTimestamp > Date.now()
    ) {
      throw diagnosticsError(
        "SQLITE_DIAGNOSTICS_INVALID_TIMESTAMP",
        "SQLite revision 时间范围包含运行时无法解析或位于未来的 created_at；诊断不会修正时钟。",
      );
    }

    const sqlitePageSizeBytes = requireSafePositiveInteger(requiredPragmaInteger(db, "page_size"), "SQLite page_size");
    const sqlitePageCount = requireSafePositiveInteger(requiredPragmaInteger(db, "page_count"), "SQLite page_count");
    const sqliteFreelistPages = requiredPragmaInteger(db, "freelist_count");
    const sqliteAllocatedBytes = requireSafePositiveInteger(
      sqlitePageSizeBytes * sqlitePageCount,
      "SQLite 已分配页字节数",
    );
    requireSafePositiveInteger(databaseFileBytes, "数据库文件字节数");
    const sqliteReusableBytes = requireSafeNonNegativeInteger(
      sqlitePageSizeBytes * sqliteFreelistPages,
      "SQLite 可复用页字节数",
    );

    db.exec("COMMIT");
    transactionOpen = false;
    db.close();
    db = undefined;
    const wal = await optionalWalFileSize(resolved);
    return {
      capturedAt: new Date().toISOString(),
      databasePath: resolved,
      currentRevision,
      revisionCount,
      minimumRevision,
      maximumRevision,
      earliestCreatedAt: earliest.created_at,
      latestCreatedAt: latest.created_at,
      stateJsonTotalBytes,
      stateJsonAverageBytes,
      stateJsonMaximumBytes,
      databaseFileBytes,
      ...wal,
      sqlitePageSizeBytes,
      sqlitePageCount,
      sqliteFreelistPages,
      sqliteAllocatedBytes,
      sqliteReusableBytes,
    };
  } catch (error) {
    if (db?.isOpen && transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 保留原始诊断失败；read-only 事务没有可提交的变化。
      }
    }
    if (error instanceof SqliteRevisionDiagnosticsError) throw error;
    throw diagnosticsError(
      "SQLITE_DIAGNOSTICS_QUERY_FAILED",
      `SQLite revision 只读诊断失败：${resolved}`,
      error,
    );
  } finally {
    if (db?.isOpen) db.close();
  }
}
