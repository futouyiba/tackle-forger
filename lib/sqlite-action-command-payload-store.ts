import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ActionCommandPayloadError,
  type ActionCommandExecution,
  type ActionCommandPayloadRecord,
  type ActionCommandPayloadStore,
} from "./action-command-payloads";
import type {
  ActionCode,
  ActionCommandLeaseRef,
} from "./interaction-contracts";
import {
  ensureSqliteWorkspaceSeeded,
  openSqliteDatabase,
  runSqliteImmediateTransaction,
  waitForSqliteTransaction,
} from "./sqlite-storage";

const MAX_FENCING_TOKEN = BigInt("9223372036854775807");

function parseRecord(value: string): ActionCommandPayloadRecord {
  return JSON.parse(value) as ActionCommandPayloadRecord;
}

function stringifyResult(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "状态写执行结果必须是可持久化的 JSON。",
    );
  }
  return json;
}

/**
 * R730 正式部署使用的耐久命令存储。payload、工作区唯一当前租约和执行结果
 * 与业务工作区共用一个 SQLite 数据库；首次执行持有 BEGIN IMMEDIATE，
 * 因而租约重验、业务 revision 写入和幂等结果属于同一提交边界。
 */
export class SqliteActionCommandPayloadStore implements ActionCommandPayloadStore {
  constructor(readonly databasePath: string) {}
  private initializedDatabase?: Promise<DatabaseSync>;

  private ensureTables(db: DatabaseSync) {
    ensureSqliteWorkspaceSeeded(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_action_leases (
        workspace_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_command_payloads (
        payload_ref_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        command_hash TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        UNIQUE(actor_id, action, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS action_command_executions (
        command_hash TEXT PRIMARY KEY,
        payload_ref_id TEXT NOT NULL UNIQUE,
        result_json TEXT NOT NULL,
        executed_at TEXT NOT NULL,
        FOREIGN KEY(payload_ref_id)
          REFERENCES action_command_payloads(payload_ref_id)
      );
    `);
    db.prepare(
      "INSERT OR IGNORE INTO storage_migrations (version, applied_at) VALUES (?, ?)",
    ).run(2, new Date().toISOString());
  }

  private async database() {
    this.initializedDatabase ??= (async () => {
      const db = await openSqliteDatabase(this.databasePath);
      await waitForSqliteTransaction(this.databasePath);
      this.ensureTables(db);
      return db;
    })();
    return this.initializedDatabase;
  }

  async withImmediateTransaction<T>(
    execute: (db: DatabaseSync) => Promise<T>,
  ): Promise<T> {
    await this.database();
    return runSqliteImmediateTransaction(this.databasePath, execute);
  }

  private acquireWorkspaceLeaseInTransaction(db: DatabaseSync, input: {
    workspaceId: string;
    action: ActionCode;
    holderId: string;
    now?: Date;
  }): ActionCommandLeaseRef {
    if (!input.workspaceId.trim() || !input.holderId.trim()) {
      throw new ActionCommandPayloadError(
        "ACTION_COMMAND_PAYLOAD_INVALID",
        "工作区租约必须绑定稳定 workspaceId 与 holderId。",
      );
    }
    if (!db.isTransaction) {
      throw new Error("工作区租约只能在 SQLite 事务中变更。");
    }
    const current = db.prepare(
      "SELECT fencing_token FROM workspace_action_leases WHERE workspace_id = ?",
    ).get(input.workspaceId) as { fencing_token: string } | undefined;
    const fencingToken = BigInt(current?.fencing_token ?? "0") + BigInt(1);
    if (fencingToken > MAX_FENCING_TOKEN) {
      throw new ActionCommandPayloadError(
        "ACTION_COMMAND_PAYLOAD_INVALID",
        "工作区 fencing token 已耗尽，必须人工恢复后再写入。",
      );
    }
    const leaseRef: ActionCommandLeaseRef = {
      workspaceId: input.workspaceId,
      action: input.action,
      leaseId: `lease:${randomUUID()}`,
      fencingToken: fencingToken.toString(),
    };
    db.prepare(`
      INSERT INTO workspace_action_leases (
        workspace_id, action, lease_id, fencing_token, holder_id, acquired_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        action = excluded.action,
        lease_id = excluded.lease_id,
        fencing_token = excluded.fencing_token,
        holder_id = excluded.holder_id,
        acquired_at = excluded.acquired_at
    `).run(
      leaseRef.workspaceId,
      leaseRef.action,
      leaseRef.leaseId,
      leaseRef.fencingToken,
      input.holderId,
      (input.now ?? new Date()).toISOString(),
    );
    return leaseRef;
  }

  async acquireWorkspaceLease(input: {
    workspaceId: string;
    action: ActionCode;
    holderId: string;
    now?: Date;
  }): Promise<ActionCommandLeaseRef> {
    return this.inDatabaseTransaction(async (db) =>
      this.acquireWorkspaceLeaseInTransaction(db, input));
  }

  private async inDatabaseTransaction<T>(
    execute: (db: DatabaseSync) => Promise<T>,
  ): Promise<T> {
    return this.withImmediateTransaction(execute);
  }

  async issueWithWorkspaceLease<T>(
    execute: (
      leaseRef: ActionCommandLeaseRef,
      prior?: ActionCommandPayloadRecord,
    ) => Promise<T>,
    input: {
      workspaceId: string;
      action: ActionCode;
      actorId: string;
      idempotencyKey: string;
      now?: Date;
    },
  ): Promise<T> {
    return this.inDatabaseTransaction(async (db) => {
      const prior = await this.findIssuedByIdempotencyKey({
        actorId: input.actorId,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
      });
      const leaseRef = prior?.leaseRef
        ?? this.acquireWorkspaceLeaseInTransaction(db, {
          workspaceId: input.workspaceId,
          action: input.action,
          holderId: input.actorId,
          now: input.now,
        });
      return execute(leaseRef, prior);
    });
  }

  async findByPayloadRefId(payloadRefId: string) {
    const db = await this.database();
    await waitForSqliteTransaction(this.databasePath);
    const row = db.prepare(
      "SELECT record_json FROM action_command_payloads WHERE payload_ref_id = ?",
    ).get(payloadRefId) as { record_json: string } | undefined;
    return row ? parseRecord(row.record_json) : undefined;
  }

  async findIssuedByIdempotencyKey(input: {
    actorId: string;
    action: ActionCode;
    idempotencyKey: string;
  }) {
    const db = await this.database();
    await waitForSqliteTransaction(this.databasePath);
    const row = db.prepare(`
      SELECT record_json
      FROM action_command_payloads
      WHERE actor_id = ? AND action = ? AND idempotency_key = ?
    `).get(input.actorId, input.action, input.idempotencyKey) as
      | { record_json: string }
      | undefined;
    return row ? parseRecord(row.record_json) : undefined;
  }

  private saveIssuedInDatabase(
    db: DatabaseSync,
    record: ActionCommandPayloadRecord,
  ): ActionCommandPayloadRecord {
    const existing = db.prepare(`
      SELECT record_json
      FROM action_command_payloads
      WHERE actor_id = ? AND action = ? AND idempotency_key = ?
    `).get(
      record.issuedForActorId,
      record.action,
      record.idempotencyKey,
    ) as { record_json: string } | undefined;
    if (existing) {
      const winning = parseRecord(existing.record_json);
      if (winning.commandHash !== record.commandHash) {
        throw new ActionCommandPayloadError(
          "IDEMPOTENCY_KEY_REUSED",
          "同一幂等键不能签发不同的命令载荷。",
        );
      }
      return winning;
    }
    db.prepare(`
      INSERT INTO action_command_payloads (
        payload_ref_id, actor_id, action, idempotency_key,
        command_hash, record_json, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.payloadRefId,
      record.issuedForActorId,
      record.action,
      record.idempotencyKey,
      record.commandHash,
      JSON.stringify(record),
      record.issuedAt,
    );
    return structuredClone(record);
  }

  async saveIssued(record: ActionCommandPayloadRecord) {
    return this.withImmediateTransaction(async (transaction) =>
      this.saveIssuedInDatabase(transaction, record));
  }

  async executeOnce<T>(input: {
    record: ActionCommandPayloadRecord;
    execute: () => Promise<T>;
  }): Promise<ActionCommandExecution<T>> {
    return this.inDatabaseTransaction(async (db) => {
      const prior = db.prepare(`
        SELECT result_json
        FROM action_command_executions
        WHERE command_hash = ?
      `).get(input.record.commandHash) as { result_json: string } | undefined;
      if (prior) {
        return {
          result: JSON.parse(prior.result_json) as T,
          replayed: true,
        };
      }
      const lease = db.prepare(`
        SELECT action, lease_id, fencing_token
        FROM workspace_action_leases
        WHERE workspace_id = ?
      `).get(input.record.leaseRef.workspaceId) as
        | { action: string; lease_id: string; fencing_token: string }
        | undefined;
      if (
        !lease
        || lease.action !== input.record.leaseRef.action
        || lease.lease_id !== input.record.leaseRef.leaseId
        || lease.fencing_token !== input.record.leaseRef.fencingToken
      ) {
        throw new ActionCommandPayloadError(
          "STALE_FENCING_TOKEN",
          "工作区租约或 fencing token 已过期，不能执行新的状态写。",
        );
      }
      const result = await input.execute();
      db.prepare(`
        INSERT INTO action_command_executions (
          command_hash, payload_ref_id, result_json, executed_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.record.commandHash,
        input.record.payloadRefId,
        stringifyResult(result),
        new Date().toISOString(),
      );
      return { result, replayed: false };
    });
  }
}
