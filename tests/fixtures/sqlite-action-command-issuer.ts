import {
  issueActionCommandPayload,
} from "../../lib/action-command-payloads";
import {
  workspaceCommandInputHash,
  workspaceCommandSubject,
} from "../../lib/production-action-commands";
import { SqliteActionCommandPayloadStore } from "../../lib/sqlite-action-command-payload-store";
import { closeSqliteStorage, loadSqliteWorkspace } from "../../lib/sqlite-storage";

const [databasePath, idempotencyKey, delayMilliseconds = "0"] = process.argv.slice(2);
if (!databasePath || !idempotencyKey) {
  throw new Error("usage: sqlite-action-command-issuer <databasePath> <idempotencyKey> [delayMilliseconds]");
}

const actorId = "feishu:tenant:sqlite-command-test";
const store = new SqliteActionCommandPayloadStore(databasePath);
const current = await loadSqliteWorkspace(databasePath);
const subjectRef = workspaceCommandSubject(current.revision);
const payloadRef = await store.issueWithWorkspaceLease(
  async (leaseRef, prior) => {
    const delay = Number(delayMilliseconds);
    if (Number.isFinite(delay) && delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    return issueActionCommandPayload({
      store,
      actionId: prior?.actionId ?? `action:save_workspace:${idempotencyKey}`,
      action: "save_workspace",
      subjectRef: prior?.subjectRef ?? subjectRef,
      expectedRevisionId: prior?.expectedRevisionId ?? subjectRef.revisionId,
      inputHash: prior?.inputHash ?? workspaceCommandInputHash(current.revision),
      leaseRef,
      idempotencyKey,
      payload: { test: idempotencyKey },
      actorId,
      capabilities: ["workspace.save"],
    });
  },
  {
    workspaceId: subjectRef.workspaceId,
    action: "save_workspace",
    actorId,
    idempotencyKey,
  },
);
console.log(JSON.stringify({ payloadRefId: payloadRef.payloadRefId }));
await closeSqliteStorage(databasePath);
