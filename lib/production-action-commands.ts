import { randomUUID } from "node:crypto";
import {
  ActionCommandPayloadError,
  actionCommandHash,
  executeActionCommandPayload,
  issueActionCommandPayload,
  type JsonObject,
} from "./action-command-payloads";
import type { RequestIdentity } from "./auth";
import type {
  ActionCode,
  ActionCommandPayloadRef,
  CapabilityCode,
  EntityRef,
} from "./interaction-contracts";
import { SqliteActionCommandPayloadStore } from "./sqlite-action-command-payload-store";
import { workspaceSqliteDatabasePath } from "./storage";
import type { WorkspaceState } from "./types";

export const PRODUCTION_WORKSPACE_ID = "workspace:main";
export const ROUTED_WORKSPACE_ACTIONS = [
  "create_series",
  "change_sku_target_pull",
  "save_workspace",
  "publish_data_source",
  "commit_data_source_writeback",
  "pull_feishu_workbook",
  "create_ruleset_draft",
  "publish_ruleset",
  "write_feishu_identity",
  "import_excel",
] as const satisfies readonly ActionCode[];

export type RoutedWorkspaceAction = (typeof ROUTED_WORKSPACE_ACTIONS)[number];

const stores = new Map<string, SqliteActionCommandPayloadStore>();

export function productionActionCommandStore() {
  const databasePath = workspaceSqliteDatabasePath();
  if (!databasePath) {
    throw new Error(
      "ACTION_COMMAND_STORAGE_UNAVAILABLE：正式状态写必须使用支持原子租约重验的 SQLite 持久化存储。",
    );
  }
  let store = stores.get(databasePath);
  if (!store) {
    store = new SqliteActionCommandPayloadStore(databasePath);
    stores.set(databasePath, store);
  }
  return store;
}

export function workspaceCommandSubject(revision: number): EntityRef {
  return {
    workspaceId: PRODUCTION_WORKSPACE_ID,
    entityType: "workspace",
    entityId: PRODUCTION_WORKSPACE_ID,
    revisionId: String(revision),
  };
}

export function workspaceCommandInputHash(revision: number): string {
  return actionCommandHash({
    workspaceId: PRODUCTION_WORKSPACE_ID,
    workspaceRevision: revision,
  });
}

export async function issueProductionWorkspaceCommand(input: {
  action: RoutedWorkspaceAction;
  payload: JsonObject;
  idempotencyKey: string;
  actorId: string;
  capabilities: Iterable<CapabilityCode>;
  workspaceRevision: number;
  now?: Date;
}): Promise<{ actionId: string; commandPayloadRef: ActionCommandPayloadRef }> {
  const store = productionActionCommandStore();
  const now = input.now ?? new Date();
  const subjectRef = workspaceCommandSubject(input.workspaceRevision);
  const actionId = `action:${input.action}:${randomUUID()}`;
  const commandPayloadRef = await store.issueWithWorkspaceLease(
    (leaseRef, prior) => issueActionCommandPayload({
      store,
      actionId: prior?.actionId ?? actionId,
      action: input.action,
      subjectRef: prior?.subjectRef ?? subjectRef,
      expectedRevisionId: prior?.expectedRevisionId ?? subjectRef.revisionId,
      inputHash: prior?.inputHash ?? workspaceCommandInputHash(input.workspaceRevision),
      leaseRef,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      actorId: input.actorId,
      capabilities: input.capabilities,
      now,
      expiresAt: prior?.expiresAt
        ?? new Date(now.getTime() + 5 * 60_000).toISOString(),
    }),
    {
      workspaceId: PRODUCTION_WORKSPACE_ID,
      action: input.action,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      now,
    },
  );
  const savedRecord = await store.findByPayloadRefId(commandPayloadRef.payloadRefId);
  return {
    actionId: savedRecord?.actionId ?? actionId,
    commandPayloadRef,
  };
}

export interface WorkspaceCommandHttpResult {
  status: number;
  body: unknown;
}

export class WorkspaceCommandTransientHttpError extends Error {
  constructor(readonly result: WorkspaceCommandHttpResult) {
    super("状态写遇到临时服务错误，事务和幂等成功结果均未提交。");
    this.name = "WorkspaceCommandTransientHttpError";
  }
}

export async function executeProductionWorkspaceCommand(input: {
  expectedAction: RoutedWorkspaceAction | readonly RoutedWorkspaceAction[];
  invocation: unknown;
  user: RequestIdentity;
  current: { state: WorkspaceState; revision: number };
  execute: (
    payload: JsonObject,
    action: RoutedWorkspaceAction,
  ) => Promise<WorkspaceCommandHttpResult>;
}) {
  const store = productionActionCommandStore();
  return executeActionCommandPayload({
    store,
    invocation: input.invocation,
    actorId: input.user.tenantKey && input.user.openId
      ? `feishu:${input.user.tenantKey}:${input.user.openId}`
      : input.user.name.trim() || input.user.email.trim() || "unknown-actor",
    capabilities: input.user.capabilities,
    currentSubjectRef: workspaceCommandSubject(input.current.revision),
    currentInputHash: workspaceCommandInputHash(input.current.revision),
    execute: async (record) => {
      const expectedActions = Array.isArray(input.expectedAction)
        ? input.expectedAction
        : [input.expectedAction];
      if (!(expectedActions as readonly ActionCode[]).includes(record.action)) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_ACTION_MISMATCH",
          `该入口只接受 ${expectedActions.join("、")} 命令。`,
        );
      }
      const result = await input.execute(
        record.payload,
        record.action as RoutedWorkspaceAction,
      );
      if (result.status >= 500) {
        throw new WorkspaceCommandTransientHttpError(result);
      }
      return result;
    },
  });
}
