export const LOCAL_SESSION_EDITOR_FLAG = "TACKLE_FORGER_LOCAL_SESSION_EDITOR_ENABLED";

/** Production-safe: absent, malformed and mixed-case values all remain off. */
export function isLocalSessionEditorEnabled(value: string | undefined): boolean {
  return value === "true";
}
