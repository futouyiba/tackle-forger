export interface CandidateGenerationWorkbenchActionResult<T> {
  ok: boolean;
  value?: T;
  message?: string;
}

/**
 * Browser event handlers are a presentation boundary. Domain guards must stay
 * fail-closed, while their errors become an actionable in-workbench message
 * instead of an uncaught client event exception.
 */
export function runCandidateGenerationWorkbenchAction<T>(
  action: "生成候选" | "物化候选",
  operation: () => T,
): CandidateGenerationWorkbenchActionResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    const detail = error instanceof Error && error.message.trim()
      ? error.message
      : "领域校验拒绝了此操作。";
    return {
      ok: false,
      message: `${action}已被安全阻止：${detail}`,
    };
  }
}

/** A failed automatic materialization is a failed user action, not a completed run. */
export function canPresentCandidateRunCompletion(
  automaticMaterializationAttempted: boolean,
  materialized: boolean,
): boolean {
  return !automaticMaterializationAttempted || materialized;
}
