#!/usr/bin/env python3
"""Create or inspect a disposable local snapshot of GitHub Issue and PR metadata."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, check=False, capture_output=True, text=True)


def repository_root(path: Path) -> Path:
    result = run(["git", "rev-parse", "--show-toplevel"], path)
    if result.returncode != 0:
        raise RuntimeError("The selected path is not inside a Git repository.")
    return Path(result.stdout.strip()).resolve()


def github_json(root: Path, arguments: list[str]) -> Any:
    result = run(["gh", *arguments], root)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown GitHub CLI error"
        raise RuntimeError(detail)
    return json.loads(result.stdout)


def cache_path(root: Path) -> Path:
    return root / ".codex" / "cache" / "github-snapshot.json"


def refresh(root: Path, limit: int) -> dict[str, Any]:
    version = run(["gh", "--version"], root)
    if version.returncode != 0:
        raise RuntimeError("GitHub CLI (gh) is required.")

    repository = github_json(root, ["repo", "view", "--json", "nameWithOwner"])
    repository_name = repository["nameWithOwner"]
    issues = github_json(
        root,
        [
            "issue",
            "list",
            "--repo",
            repository_name,
            "--state",
            "all",
            "--limit",
            str(limit),
            "--json",
            "number,title,state,labels,assignees,updatedAt,url,milestone",
        ],
    )
    pull_requests = github_json(
        root,
        [
            "pr",
            "list",
            "--repo",
            repository_name,
            "--state",
            "all",
            "--limit",
            str(limit),
            "--json",
            "number,title,state,isDraft,headRefName,baseRefName,reviewDecision,updatedAt,url",
        ],
    )
    snapshot = {
        "schema_version": 1,
        "repository": repository_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "issues": issues,
        "pull_requests": pull_requests,
    }
    destination = cache_path(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=destination.parent,
        prefix="github-snapshot-",
        suffix=".json",
        delete=False,
    ) as handle:
        json.dump(snapshot, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(destination)
    return snapshot


def status(root: Path) -> dict[str, Any]:
    destination = cache_path(root)
    if not destination.exists():
        return {"exists": False, "path": str(destination)}
    data = json.loads(destination.read_text(encoding="utf-8"))
    generated = datetime.fromisoformat(data["generated_at"])
    age = datetime.now(timezone.utc) - generated.astimezone(timezone.utc)
    return {
        "exists": True,
        "path": str(destination),
        "repository": data.get("repository"),
        "generated_at": data.get("generated_at"),
        "age_seconds": max(0, int(age.total_seconds())),
        "issue_count": len(data.get("issues", [])),
        "pull_request_count": len(data.get("pull_requests", [])),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("refresh", "status"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("path", nargs="?", default=".", help="Path inside the repository")
        if command == "refresh":
            subparser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    try:
        root = repository_root(Path(args.path).expanduser().resolve())
        if args.command == "refresh":
            snapshot = refresh(root, max(1, args.limit))
            result = {
                "ok": True,
                "path": str(cache_path(root)),
                "repository": snapshot["repository"],
                "issue_count": len(snapshot["issues"]),
                "pull_request_count": len(snapshot["pull_requests"]),
            }
        else:
            result = {"ok": True, **status(root)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, RuntimeError, KeyError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
