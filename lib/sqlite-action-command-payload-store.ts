import { randomUUID } from "node:crypto";
import path from "node:path";
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
const ISSUANCE_CLAIM_STALE_AFTER_MS = 30_000;
const issuanceTails = new Map<string, Promise<void>>();

type IssuanceClaim =
  | { kind: "winner"; record: ActionCommandPayloadRecord }
  | { kind: "owner"; claimId: string; leaseRef: ActionCommandLeaseRef }
  | { kind: "pending" };

async function serializeIssuance<T>(
  databasePath: string,
  execute: () => Promise<T>,
) {
  const key = path.resolve(databasePath);
  const prior = issuanceTails.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(execute);
  const tail = run.then(() => undefined, () => undefined);
  issuanceTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (issuanceTails.get(key) === tail) issuanceTails.delete(key);
  }
}

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

function parseFencingToken(value: string, context: string) {
  let token: bigint;
  try {
    token = BigInt(value);
  } catch {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      `${context} fencing token 无法解析，必须人工恢复后再写入。`,
    );
  }
  if (token < BigInt(0) || token > MAX_FENCING_TOKEN) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      `${context} fencing token 超出有效范围，必须人工恢复后再写入。`,
    );
  }
  return token;
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
      CREATE TABLE IF NOT EXISTS workspace_fencing_high_watermarks (
        workspace_id TEXT PRIMARY KEY,
        fencing_token TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS action_command_issuance_claims (
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        claim_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY(actor_id, action, idempotency_key)
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
    const legacyLeases = db.prepare(`
      SELECT workspace_id, fencing_token
      FROM workspace_action_leases
    `).all() as Array<{ workspace_id: string; fencing_token: string }>;
    const readHighWatermark = db.prepare(`
      SELECT fencing_token
      FROM workspace_fencing_high_watermarks
      WHERE workspace_id = ?
    `);
    const saveHighWatermark = db.prepare(`
      INSERT INTO workspace_fencing_high_watermarks (
        workspace_id, fencing_token, updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        fencing_token = excluded.fencing_token,
        updated_at = excluded.updated_at
    `);
    for (const lease of legacyLeases) {
      const legacyToken = parseFencingToken(
        lease.fencing_token,
        `工作区 ${lease.workspace_id} 的旧租约`,
      );
      const existing = readHighWatermark.get(lease.workspace_id) as
        | { fencing_token: string }
        | undefined;
      const highWatermark = existing
        ? parseFencingToken(
          existing.fencing_token,
          `工作区 ${lease.workspace_id} 的高水位`,
        )
        : BigInt(0);
      if (legacyToken > highWatermark) {
        saveHighWatermark.run(
          lease.workspace_id,
          legacyToken.toString(),
          new Date().toISOString(),
        );
      }
    }
    db.prepare(
      "INSERT OR IGNORE INTO storage_migrations (version, applied_at) VALUES (?, ?)",
    ).run(3, new Date().toISOString());
    db.prepare(
      "INSERT OR IGNORE INTO storage_migrations (version, applied_at) VALUES (?, ?)",
    ).run(4, new Date().toISOString());
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

  private assertLeaseInput(input: {
    workspaceId: string;
    action: ActionCode;
    holderId: string;
    now?: Date;
  }) {
    if (!input.workspaceId.trim() || !input.holderId.trim()) {
      throw new ActionCommandPayloadError(
        "ACTION_COMMAND_PAYLOAD_INVALID",
        "工作区租约必须绑定稳定 workspaceId 与 holderId。",
      );
    }
  }

  /**
   * 高水位与当前租约先在独立事务中永久提交。后续 payload 校验或保存失败
   * 只能留下 token 空洞，不得把已经授予并可被调用方观察的 token 回滚重发。
   */
  private async grantWorkspaceLeasePermanently(input: {
    workspaceId: string;
    action: ActionCode;
    holderId: string;
    now?: Date;
  }): Promise<ActionCommandLeaseRef> {
    this.assertLeaseInput(input);
    return this.withImmediateTransaction(async (db) => {
      const current = db.prepare(`
        SELECT fencing_token
        FROM workspace_fencing_high_watermarks
        WHERE workspace_id = ?
      `).get(input.workspaceId) as { fencing_token: string } | undefined;
      const highWatermark = current
        ? parseFencingToken(
          current.fencing_token,
          `工作区 ${input.workspaceId} 的高水位`,
        )
        : BigInt(0);
      const fencingToken = highWatermark + BigInt(1);
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
      const acquiredAt = (input.now ?? new Date()).toISOString();
      db.prepare(`
        INSERT INTO workspace_fencing_high_watermarks (
          workspace_id, fencing_token, updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          fencing_token = excluded.fencing_token,
          updated_at = excluded.updated_at
      `).run(
        input.workspaceId,
        leaseRef.fencingToken,
        acquiredAt,
      );
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
      acquiredAt,
    );
      return leaseRef;
    });
  }

  async acquireWorkspaceLease(input: {
    workspaceId: string;
    action: ActionCode;
    holderId: string;
    now?: Date;
  }): Promise<ActionCommandLeaseRef> {
    return this.grantWorkspaceLeasePermanently(input);
  }

  private async inDatabaseTransaction<T>(
    execute: (db: DatabaseSync) => Promise<T>,
  ): Promise<T> {
    return this.withImmediateTransaction(execute);
  }

  private async claimIssuance(input: {
    workspaceId: string;
    action: ActionCode;
    actorId: string;
    idempotencyKey: string;
    now?: Date;
  }): Promise<IssuanceClaim> {
    this.assertLeaseInput({
      workspaceId: input.workspaceId,
      action: input.action,
      holderId: input.actorId,
      now: input.now,
    });
    return this.withImmediateTransaction(async (db) => {
      const winner = db.prepare(`
        SELECT record_json
        FROM action_command_payloads
        WHERE actor_id = ? AND action = ? AND idempotency_key = ?
      `).get(input.actorId, input.action, input.idempotencyKey) as
        | { record_json: string }
        | undefined;
      if (winner) return { kind: "winner", record: parseRecord(winner.record_json) };

      const pending = db.prepare(`
        SELECT claim_id, claimed_at
        FROM action_command_issuance_claims
        WHERE actor_id = ? AND action = ? AND idempotency_key = ?
      `).get(input.actorId, input.action, input.idempotencyKey) as
        | { claim_id: string; claimed_at: string }
        | undefined;
      if (pending) {
        const claimedAt = Date.parse(pending.claimed_at);
        if (
          Number.isFinite(claimedAt)
          && Date.now() - claimedAt > ISSUANCE_CLAIM_STALE_AFTER_MS
        ) {
          // 崩溃恢复只能移除无人完成的 claim；先前 token 已永久烧号。
          db.prepare(`
            DELETE FROM action_command_issuance_claims
            WHERE actor_id = ? AND action = ? AND idempotency_key = ? AND claim_id = ?
          `).run(
            input.actorId,
            input.action,
            input.idempotencyKey,
            pending.claim_id,
          );
        } else {
          return { kind: "pending" };
        }
      }

      const current = db.prepare(`
        SELECT fencing_token
        FROM workspace_fencing_high_watermarks
        WHERE workspace_id = ?
      `).get(input.workspaceId) as { fencing_token: string } | undefined;
      const highWatermark = current
        ? parseFencingToken(
          current.fencing_token,
          `工作区 ${input.workspaceId} 的高水位`,
        )
        : BigInt(0);
      const fencingToken = highWatermark + BigInt(1);
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
      const acquiredAt = (input.now ?? new Date()).toISOString();
      const claimId = `issuance:${randomUUID()}`;
      db.prepare(`
        INSERT INTO workspace_fencing_high_watermarks (
          workspace_id, fencing_token, updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          fencing_token = excluded.fencing_token,
          updated_at = excluded.updated_at
      `).run(input.workspaceId, leaseRef.fencingToken, acquiredAt);
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
        input.actorId,
        acquiredAt,
      );
      db.prepare(`
        INSERT INTO action_command_issuance_claims (
          actor_id, action, idempotency_key, claim_id,
          workspace_id, lease_id, fencing_token, claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.actorId,
        input.action,
        input.idempotencyKey,
        claimId,
        leaseRef.workspaceId,
        leaseRef.leaseId,
        leaseRef.fencingToken,
        new Date().toISOString(),
      );
      return { kind: "owner", claimId, leaseRef };
    });
  }

  private async releaseIssuanceClaim(input: {
    actorId: string;
    action: ActionCode;
    idempotencyKey: string;
    claimId: string;
  }) {
    await this.withImmediateTransaction(async (db) => {
      db.prepare(`
        DELETE FROM action_command_issuance_claims
        WHERE actor_id = ? AND action = ? AND idempotency_key = ? AND claim_id = ?
      `).run(input.actorId, input.action, input.idempotencyKey, input.claimId);
    });
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
    return serializeIssuance(this.databasePath, async () => {
      const idempotencyLookup = {
        actorId: input.actorId,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
      };
      while (true) {
        const claim = await this.claimIssuance(input);
        if (claim.kind === "winner") {
          return execute(claim.record.leaseRef, claim.record);
        }
        if (claim.kind === "pending") {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          continue;
        }
        try {
          return await this.inDatabaseTransaction(async (db) => {
            const winningRow = db.prepare(`
              SELECT record_json
              FROM action_command_payloads
              WHERE actor_id = ? AND action = ? AND idempotency_key = ?
            `).get(
              idempotencyLookup.actorId,
              idempotencyLookup.action,
              idempotencyLookup.idempotencyKey,
            ) as { record_json: string } | undefined;
            if (winningRow) {
              const winner = parseRecord(winningRow.record_json);
              return execute(winner.leaseRef, winner);
            }
            const currentLease = db.prepare(`
              SELECT action, lease_id, fencing_token
              FROM workspace_action_leases
              WHERE workspace_id = ?
            `).get(claim.leaseRef.workspaceId) as
              | { action: string; lease_id: string; fencing_token: string }
              | undefined;
            if (
              !currentLease
              || currentLease.action !== claim.leaseRef.action
              || currentLease.lease_id !== claim.leaseRef.leaseId
              || currentLease.fencing_token !== claim.leaseRef.fencingToken
            ) {
              throw new ActionCommandPayloadError(
                "STALE_FENCING_TOKEN",
                "payload 保存前工作区租约已轮换；已烧 token 不会回退或复用。",
              );
            }
            return execute(claim.leaseRef);
          });
        } catch (error) {
          const winner = await this.findIssuedByIdempotencyKey(idempotencyLookup);
          if (winner) return execute(winner.leaseRef, winner);
          // 失联 owner 的 claim 被恢复者接管时，旧 owner 只能观察到 stale。
          // 对同一幂等键不能把它暴露给调用方；释放自己的 claim 后回读新 owner。
          if (
            error instanceof ActionCommandPayloadError
            && error.code === "STALE_FENCING_TOKEN"
          ) {
            continue;
          }
          throw error;
        } finally {
          await this.releaseIssuanceClaim({
            ...idempotencyLookup,
            claimId: claim.claimId,
          });
        }
      }
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
    const currentLease = db.prepare(`
      SELECT action, lease_id, fencing_token
      FROM workspace_action_leases
      WHERE workspace_id = ?
    `).get(record.leaseRef.workspaceId) as
      | { action: string; lease_id: string; fencing_token: string }
      | undefined;
    if (
      !currentLease
      || currentLease.action !== record.leaseRef.action
      || currentLease.lease_id !== record.leaseRef.leaseId
      || currentLease.fencing_token !== record.leaseRef.fencingToken
    ) {
      throw new ActionCommandPayloadError(
        "STALE_FENCING_TOKEN",
        "payload 保存时工作区租约已轮换，不能写入过期命令。",
      );
    }
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
