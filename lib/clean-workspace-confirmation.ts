/**
 * Remote confirmations replace the editor's authoritative workspace with the
 * version returned by the server.  They must therefore never start while the
 * editor contains local changes that have not acquired a workspace revision.
 */
export const DIRTY_WORKSPACE_CONFIRMATION_MESSAGE =
  "当前工作区有未保存修改；请先保存并取得新 revision，再确认 AI 规则草稿。";
export const CHANGED_WORKSPACE_CONFIRMATION_MESSAGE =
  "AI 规则草稿已在服务端确认，但本地工作区在等待期间已变化；为保留本地修改，未覆盖当前编辑。请先保存或刷新后再查看确认结果。";

export type CleanWorkspaceConfirmationResult<T> =
  | { disposition: "blocked"; reason: typeof DIRTY_WORKSPACE_CONFIRMATION_MESSAGE }
  | { disposition: "submitted"; value: T };

export async function runCleanWorkspaceConfirmation<T>(input: {
  dirty: boolean;
  submit: () => Promise<T>;
}): Promise<CleanWorkspaceConfirmationResult<T>> {
  if (input.dirty) {
    return { disposition: "blocked", reason: DIRTY_WORKSPACE_CONFIRMATION_MESSAGE };
  }
  return { disposition: "submitted", value: await input.submit() };
}

export function canApplyConfirmedWorkspace(input: {
  dirty: boolean;
  revision: number;
  expectedRevision: number;
}): { allowed: true } | { allowed: false; reason: typeof CHANGED_WORKSPACE_CONFIRMATION_MESSAGE } {
  if (input.dirty || input.revision !== input.expectedRevision) {
    return { allowed: false, reason: CHANGED_WORKSPACE_CONFIRMATION_MESSAGE };
  }
  return { allowed: true };
}
