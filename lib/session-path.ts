import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Options for {@link resolveSessionDataDir}.
 *
 * @remarks All fields are optional so the function is easy to call in tests
 * with only the dimension being exercised.
 */
export interface SessionPathOptions {
  /**
   * Raw (trimmed) value of `FEISHU_SESSION_DATA_DIR`, or empty / undefined
   * when unset.
   *
   * The default value `".data/auth"` is treated as "not intentional" so
   * that `start-dev.ps1` can transparently upgrade it to a worktree-
   * specific path without the user editing `.env.local`.
   */
  explicitEnvPath?: string;

  /**
   * Git worktree name (e.g. `"v3-work"`, `"agent-a606cb391fdc5dbaa"`).
   * When provided together with `port`, an isolated directory is derived
   * under the project root.
   */
  worktreeName?: string;

  /**
   * Development server port (e.g. `3000`, `3001`).
   * Required together with `worktreeName` for auto-isolation.
   */
  port?: number;

  /**
   * Override for `process.cwd()` — only used in tests.
   */
  _cwd?: string;
}

/**
 * Resolve the session data directory for authentication storage.
 *
 * Priority (first match wins):
 *
 *  1. **Explicit production path** – `explicitEnvPath` is non-empty AND
 *     is NOT the default `".data/auth"`.  Treated as an intentional
 *     override; resolved against cwd.
 *  2. **Worktree + port auto-isolation** – `worktreeName` AND `port` are
 *     both present.  Derives `".data/auth-<worktreeName>-<port>"` under
 *     the project root.
 *  3. **Default fallback** – `".data/auth"` under cwd.
 *
 * The default `".data/auth"` is never considered an intentional override,
 * so the dev script can upgrade it transparently without the user editing
 * `.env.local`.
 */
export function resolveSessionDataDir(options?: SessionPathOptions): string {
  const cwd = options?._cwd ?? process.cwd();
  const raw = options?.explicitEnvPath?.trim() ?? "";
  const isDefaultPath = raw === "" || raw === ".data/auth";

  // Priority 1: explicit non-default override (production / CI)
  if (raw !== "" && !isDefaultPath) {
    return path.resolve(cwd, raw);
  }

  // Priority 2: worktree + port auto-isolation (dev script)
  if (options?.worktreeName && options?.port !== undefined) {
    const safeName = sanitizeWorktreeName(options.worktreeName);
    return path.join(cwd, `.data/auth-${safeName}-${options.port}`);
  }

  // Priority 3: default fallback
  return path.join(cwd, ".data/auth");
}

/**
 * Sanitize a git worktree name for use in Windows directory paths.
 *
 * Git worktree names are already restricted to `[a-zA-Z0-9._-]` by git
 * itself, but we guard against empty / dots-only / path-traversal edge
 * cases so the function is safe to use even with untrusted input.
 */
export function sanitizeWorktreeName(name: string): string {
  if (!name) return "unknown-worktree";
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "unknown-worktree";
}

/**
 * Detect the current git worktree name from the `.git` file in the project
 * root, if this checkout is a linked worktree.
 *
 * In a git worktree the `.git` path is a plain file whose first line reads
 * `gitdir: /path/to/.git/worktrees/<name>`.  In the main checkout `.git`
 * is a directory; this function returns `undefined` for that case.
 *
 * @param projectRoot - Directory containing `.git` (the worktree root).
 * @returns The worktree name (e.g. `"v3-work"`), or `undefined` when the
 *          checkout is NOT a linked worktree.
 */
export function detectGitWorktreeName(projectRoot: string): string | undefined {
  try {
    const gitPath = path.join(projectRoot, ".git");
    const stat = statSync(gitPath);
    if (!stat.isFile()) return undefined;

    const content = readFileSync(gitPath, "utf8");
    const match = content.match(/gitdir:\s*(.+)/);
    if (!match) return undefined;

    const gitdir = match[1].trim();

    // Platform-agnostic: accept both \ and / as path separators.
    const parts = gitdir.split(/[\\/]/);
    const worktreeIdx = parts.lastIndexOf("worktrees");
    if (worktreeIdx !== -1 && worktreeIdx + 1 < parts.length) {
      return parts[worktreeIdx + 1];
    }

    return undefined;
  } catch {
    return undefined;
  }
}
