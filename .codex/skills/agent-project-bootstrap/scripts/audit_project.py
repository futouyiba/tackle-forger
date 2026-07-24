#!/usr/bin/env python3
"""Read-only audit for agent-project-bootstrap."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def git(path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(path), *args],
        check=False,
        capture_output=True,
        text=True,
    )


def find_root(path: Path) -> Path | None:
    result = git(path, "rev-parse", "--show-toplevel")
    if result.returncode != 0:
        return None
    return Path(result.stdout.strip()).resolve()


def exists(root: Path, relative: str) -> bool:
    return (root / relative).exists()


def first_match(root: Path, patterns: list[str]) -> str | None:
    for pattern in patterns:
        match = next(root.glob(pattern), None)
        if match is not None:
            return str(match.relative_to(root))
    return None


def ignored_local_files(root: Path) -> list[str]:
    candidates = [
        ".env",
        ".env.local",
        ".env.development.local",
        ".env.test.local",
        "config/local.yml",
        "config/local.yaml",
        "docker-compose.override.yml",
        "compose.override.yml",
    ]
    found: list[str] = []
    for relative in candidates:
        if not exists(root, relative):
            continue
        check = git(root, "check-ignore", "-q", "--", relative)
        if check.returncode == 0:
            found.append(relative)
    return found


def detect_stacks(root: Path) -> list[str]:
    indicators = {
        "node": ["package.json"],
        "python": ["pyproject.toml", "requirements.txt", "setup.py"],
        "rust": ["Cargo.toml"],
        "go": ["go.mod"],
        "ruby": ["Gemfile"],
        "java-gradle": ["build.gradle", "build.gradle.kts"],
        "java-maven": ["pom.xml"],
        "dotnet": ["*.sln", "*.csproj", "src/*/*.csproj", "tests/*/*.csproj"],
        "unity": ["ProjectSettings/ProjectVersion.txt"],
    }
    detected: list[str] = []
    for stack, patterns in indicators.items():
        if first_match(root, patterns):
            detected.append(stack)
    return detected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default=".", help="Path inside the repository")
    args = parser.parse_args()
    requested = Path(args.path).expanduser().resolve()
    root = find_root(requested)

    if root is None:
        print(json.dumps({"ok": False, "reason": "not_git_repository", "path": str(requested)}, indent=2))
        return 2

    remote = git(root, "config", "--get", "remote.origin.url")
    workflows_dir = root / ".github" / "workflows"
    workflows = []
    if workflows_dir.is_dir():
        workflows = sorted(
            path.relative_to(root).as_posix()
            for path in workflows_dir.iterdir()
            if path.is_file() and path.suffix in {".yml", ".yaml"}
        )

    package_manager = None
    for manager, lockfile in (
        ("pnpm", "pnpm-lock.yaml"),
        ("yarn", "yarn.lock"),
        ("npm", "package-lock.json"),
        ("bun", "bun.lockb"),
    ):
        if exists(root, lockfile):
            package_manager = manager
            break

    compose_file = first_match(
        root,
        ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"],
    )
    report = {
        "ok": True,
        "repository_root": str(root),
        "remote_origin": remote.stdout.strip() if remote.returncode == 0 else None,
        "detected_stacks": detect_stacks(root),
        "node_package_manager": package_manager,
        "docker_compose_file": compose_file,
        "coordination": {
            "agents_md": exists(root, "AGENTS.md"),
            "bootstrap_marker": exists(root, ".codex/agent-project-bootstrap.yml"),
            "issue_templates": exists(root, ".github/ISSUE_TEMPLATE"),
            "pull_request_template": any(
                exists(root, candidate)
                for candidate in (
                    ".github/pull_request_template.md",
                    ".github/PULL_REQUEST_TEMPLATE.md",
                    "pull_request_template.md",
                )
            ),
            "workflows": workflows,
            "worktreeinclude": exists(root, ".worktreeinclude"),
            "codex_directory": exists(root, ".codex"),
        },
        "ignored_local_files_for_review": ignored_local_files(root),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
