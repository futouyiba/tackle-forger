import { deterministicHash } from "./rule-kernel";
import type {
  DataSourceProfile,
  DataSourceWritebackEvidence,
  DataSourceWritebackIntent,
  DataSourceWritebackPreview,
  WorkspaceState,
} from "./types";

export interface WorkspaceRevisionSnapshot {
  state: WorkspaceState;
  revision: number;
}

export interface WorkspaceRevisionStore {
  load(): Promise<WorkspaceRevisionSnapshot>;
  save(input: {
    state: WorkspaceState;
    baseRevision: number;
    author: string;
    message: string;
  }): Promise<{ revision: number; conflict?: boolean }>;
}

export interface RemoteWritebackResult {
  result: "written" | "alreadyApplied" | "recovered" | "failed";
  evidence: DataSourceWritebackEvidence[];
  error?: string;
}

export interface RecoverableWritebackResult {
  state: WorkspaceState;
  revision: number;
  intent: DataSourceWritebackIntent;
  idempotent: boolean;
  remoteAttempted: boolean;
}

export function dataSourceWritebackIdempotencyKey(input: {
  sourceId: string;
  sourceFingerprint: string;
  checksum: string;
}): string {
  return `data-source-writeback:${deterministicHash(input)}`;
}

function replaceIntent(
  state: WorkspaceState,
  intent: DataSourceWritebackIntent,
): WorkspaceState {
  return {
    ...state,
    dataSourceWritebackIntents: [
      intent,
      ...state.dataSourceWritebackIntents.filter(
        (candidate) => candidate.idempotencyKey !== intent.idempotencyKey,
      ),
    ].slice(0, 100),
  };
}

async function saveWithReconciliation(input: {
  store: WorkspaceRevisionStore;
  author: string;
  message: string;
  idempotencyKey: string;
  update(intent: DataSourceWritebackIntent, current: WorkspaceRevisionSnapshot): DataSourceWritebackIntent;
  addAudit?: boolean;
  maxAttempts?: number;
}): Promise<WorkspaceRevisionSnapshot> {
  const maxAttempts = input.maxAttempts ?? 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await input.store.load();
    const existing = current.state.dataSourceWritebackIntents.find(
      (candidate) => candidate.idempotencyKey === input.idempotencyKey,
    );
    if (!existing) throw new Error("找不到已持久化的飞书回写意图，不能继续远端操作。");
    const intent = input.update(existing, current);
    const next = replaceIntent(structuredClone(current.state), intent);
    if (input.addAudit && !next.dataSourceWritebacks.some(
      (record) => record.idempotencyKey === intent.idempotencyKey,
    )) {
      next.dataSourceWritebacks = [
        {
          id: `writeback:${deterministicHash({ key: intent.idempotencyKey, revision: current.revision + 1 })}`,
          sourceId: intent.sourceId,
          sourceName: intent.sourceName,
          dataset: intent.dataset,
          checksum: intent.checksum,
          recordCount: intent.recordCount,
          fieldCount: intent.fieldCount,
          publishedRevision: current.revision + 1,
          publishedAt: intent.updatedAt,
          publishedBy: intent.requestedBy,
          idempotencyKey: intent.idempotencyKey,
          remoteResult: intent.remoteResult === "failed" ? undefined : intent.remoteResult,
          evidence: structuredClone(intent.evidence),
        },
        ...next.dataSourceWritebacks,
      ].slice(0, 100);
    }
    const saved = await input.store.save({
      state: next,
      baseRevision: current.revision,
      author: input.author,
      message: input.message,
    });
    if (!saved.conflict) return { state: next, revision: saved.revision };
  }
  throw new Error("本地审计持续发生 revision 冲突；回写意图和远端证据已保留，可用同一幂等键继续自动对账。");
}

/**
 * 可恢复的数据源回写事务：先保存完整写入意图，再执行远端写入，最后基于最新
 * workspace revision 合并审计。远端写入器仍必须执行写前回读；因此响应丢失、
 * 本地 CAS 冲突或整个请求重试都不会重复写入。
 *
 * 此函数只登记“远端变化可拉取”。它不会刷新本地 binding、拉取数据或发布规则。
 */
export async function executeRecoverableDataSourceWriteback(input: {
  source: DataSourceProfile;
  preview: DataSourceWritebackPreview;
  author: string;
  requestedAt: string;
  expectedBaseRevision?: number;
  store: WorkspaceRevisionStore;
  writeRemote(source: DataSourceProfile, rows: DataSourceWritebackPreview["rows"]): Promise<RemoteWritebackResult>;
}): Promise<RecoverableWritebackResult> {
  const idempotencyKey = dataSourceWritebackIdempotencyKey({
    sourceId: input.source.id,
    sourceFingerprint: input.preview.sourceFingerprint,
    checksum: input.preview.checksum,
  });
  let current = await input.store.load();
  let intent = current.state.dataSourceWritebackIntents.find(
    (candidate) => candidate.idempotencyKey === idempotencyKey,
  );
  if (intent?.state === "COMPLETED") {
    return { state: current.state, revision: current.revision, intent, idempotent: true, remoteAttempted: false };
  }

  if (!intent) {
    if (input.expectedBaseRevision !== undefined && current.revision !== input.expectedBaseRevision) {
      throw Object.assign(new Error("正式配置已产生新版本，请重新检查后再操作。"), {
        code: "WORKSPACE_REVISION_CONFLICT",
        revision: current.revision,
      });
    }
    intent = {
      idempotencyKey,
      sourceId: input.source.id,
      sourceName: input.source.name,
      dataset: input.source.dataset,
      sourceFingerprint: input.preview.sourceFingerprint,
      checksum: input.preview.checksum,
      recordCount: input.preview.recordCount,
      fieldCount: input.preview.fieldCount,
      rows: structuredClone(input.preview.rows),
      state: "PENDING",
      evidence: [],
      requestedAt: input.requestedAt,
      requestedBy: input.author,
      updatedAt: input.requestedAt,
    };
    const pending = intent;
    const pendingState = replaceIntent(structuredClone(current.state), pending);
    const saved = await input.store.save({
      state: pendingState,
      baseRevision: current.revision,
      author: input.author,
      message: `登记回写${input.source.name}的写入意图（${pending.recordCount} 条 / ${pending.fieldCount} 个字段）`,
    });
    if (saved.conflict) {
      current = await input.store.load();
      intent = current.state.dataSourceWritebackIntents.find(
        (candidate) => candidate.idempotencyKey === idempotencyKey,
      );
      if (!intent) {
        throw Object.assign(new Error("登记飞书回写意图时发生 revision 冲突，请重新检查。"), {
          code: "WORKSPACE_REVISION_CONFLICT",
          revision: current.revision,
        });
      }
    } else {
      current = { state: pendingState, revision: saved.revision };
      intent = pending;
    }
  }

  if (intent.state === "COMPLETED") {
    return { state: current.state, revision: current.revision, intent, idempotent: true, remoteAttempted: false };
  }

  const remote = await input.writeRemote(input.source, structuredClone(intent.rows));
  const updatedAt = new Date().toISOString();
  const finalized = await saveWithReconciliation({
    store: input.store,
    author: input.author,
    idempotencyKey,
    addAudit: remote.result !== "failed",
    message: remote.result === "failed"
      ? `记录回写${input.source.name}失败及远端回读证据`
      : `确认已回写${input.source.name}；远端变化等待显式拉取`,
    update(existing, latest) {
      if (existing.state === "COMPLETED") return existing;
      return {
        ...existing,
        state: remote.result === "failed" ? "WRITE_FAILED" : "COMPLETED",
        remoteResult: remote.result,
        evidence: structuredClone(remote.evidence),
        error: remote.error,
        updatedAt,
        completedRevision: remote.result === "failed" ? undefined : latest.revision + 1,
      };
    },
  });
  const completed = finalized.state.dataSourceWritebackIntents.find(
    (candidate) => candidate.idempotencyKey === idempotencyKey,
  )!;
  return {
    ...finalized,
    intent: completed,
    idempotent: false,
    remoteAttempted: true,
  };
}
