export const LOCAL_SESSION_EDITOR_FLAG = "TACKLE_FORGER_LOCAL_SESSION_EDITOR_ENABLED";

/** Development defaults to the isolated local editor; production remains exact opt-in. */
export function isLocalSessionEditorEnabled(
  value: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  if (nodeEnv === "development") {
    return true;
  }
  return value === "true";
}
