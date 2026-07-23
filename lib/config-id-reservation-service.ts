import {
  ConfigIdGovernanceError,
  reserveConfigIdBundle,
  type ReserveConfigIdBundleCommand,
  type ReserveConfigIdBundleContext,
  type ReserveConfigIdBundleTransition,
} from "./config-id-governance";
import { loadWorkspaceState, saveWorkspaceState } from "./storage";
import type { WorkspaceState } from "./types";

export interface ConfigIdWorkspaceRepository {
  load(): Promise<{ state: WorkspaceState; revision: number }>;
  save(input: {
    state: WorkspaceState;
    baseRevision: number;
    author: string;
    message: string;
  }): Promise<{ revision: number; conflict?: boolean }>;
}

const defaultRepository: ConfigIdWorkspaceRepository = {
  load: loadWorkspaceState,
  save: saveWorkspaceState,
};

/**
 * 将纯领域转换放入工作区 CAS 重试环中。单次 save 要么提交完整
 * Model/Bundle/ledger/cursor/idempotency 变更，要么不提交任何一项。
 */
export async function reserveConfigIdBundlePersisted(
  command: ReserveConfigIdBundleCommand,
  context: ReserveConfigIdBundleContext,
  repository: ConfigIdWorkspaceRepository = defaultRepository,
  maximumAttempts = 4,
): Promise<ReserveConfigIdBundleTransition & { workspaceRevision: number }> {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const current = await repository.load();
    const transition = reserveConfigIdBundle(current.state, command, context);
    if (transition.idempotent || transition.existing) {
      return { ...transition, workspaceRevision: current.revision };
    }
    const saved = await repository.save({
      state: transition.state,
      baseRevision: current.revision,
      author: context.actor,
      message: `预留 ConfigIdBundle ${transition.result.bundle.bundleId}`,
    });
    if (!saved.conflict) {
      return { ...transition, workspaceRevision: saved.revision };
    }
  }
  throw new ConfigIdGovernanceError(
    "CONFIG_ID_RESERVATION_CONCURRENT_CONFLICT",
    "工作区在 ConfigIdBundle 事务预留期间持续变化；未确认任何未提交编号。",
  );
}
