# Codex worktree and local-environment standard

This profile targets Codex-managed worktrees. Claude Code has its own worktree isolation; the Docker, port, database, and output-isolation guidance below still applies, but `.worktreeinclude` and the Codex Local Environment UI are Codex-specific.

`.worktreeinclude` is a repository-level file for Codex-managed worktrees. It is not a global Git feature and does not configure ChatGPT Work mode. Each repository needs its own file because local dependencies differ.

Include only ignored files required before setup can succeed. Never include `.venv`, `node_modules`, caches, build outputs, database volumes, `.git` internals, or broad secret directories.

A setup script should be idempotent, non-interactive where possible, fail-fast, based on lockfiles, limited to repository-local changes, and free of destructive cleanup.

Concurrent worktrees share one machine. Derive distinct Docker Compose project names, host ports, database names or schemas, and test-output directories. Never point destructive tests at a shared development database.

Configure Codex Local Environments through the desktop UI as the source of truth. Do not invent undocumented `.codex` configuration formats.
