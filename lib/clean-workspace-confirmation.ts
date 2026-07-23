/**
 * Remote confirmations replace the editor's authoritative workspace with the
 * version returned by the server.  They must therefore never start while the
 * editor contains local changes that have not acquired a workspace revision.
 */
export const DIRTY_WORKSPACE_CONFIRMATION_MESSAGE =
  "当前工作区有未保存修改；请先保存并取得新 revision，再确认 AI 规则草稿。";

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
