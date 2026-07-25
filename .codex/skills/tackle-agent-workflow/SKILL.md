---
name: tackle-agent-workflow
description: Prepare and route Tackle Forger implementation work through a scoped coding subagent and, only for local work, an independent read-only reviewer. Use for repository changes that include code, tests, fixes, or refactors, and when the user asks to start implementation or use the project agent workflow.
---

# Run the Tackle Agent Workflow

Use this Skill for project-specific constraints, task preparation, and a local implementation loop. `AGENTS.md` owns project validation and visual policy; v3 remains the only product and domain authority.

<!-- workflow-contract-policy-ref: AGENTS.md/workflow-contract-policy/v1 -->

## Route before dispatch

Choose exactly one route before creating an agent:

- **Local implementation, no Issue or PR:** this Skill owns one coding agent and one independent local reviewer.
- **Issue delivery:** `$agent-issue-loop` owns Issue, branch, PR, closure, and handoff. Supply it this Skill's TaskBrief; do not start a local independent reviewer. Once a PR exists, `$agent-pr-loop` exclusively owns review, CI, fixes, and merge gates.
- **Existing PR:** invoke `$agent-pr-loop` directly and supply the TaskBrief. Do not create a coding or review loop here.

Never add a second independent reviewer to an Issue or PR route. This Skill never authorizes merge, publication, deployment, deletion, scope expansion, or external actions.

## Establish the TaskBrief

Before implementation or review, read `docs/README.md` and `docs/tackle-forger-development-spec-v3.md` completely, check v3 section 20, record the base revision, and inspect pre-existing changes. Create one compact TaskBrief and pass its raw form to every participating agent:

```text
Task-ID / workflow mode (local | issue | pull_request)
Spec: path, content hash, relevant sections, checked OPEN decisions
Code identity: base SHA; reviewed head SHA or WORKTREE; branch; owned paths; pre-existing changes
Scope: acceptance criteria; explicit exclusions; permitted changes
Risk: persisted or historical data; concurrency; authorization; external effects; user-visible impact
Validation: required commands and scenarios; each N/A check with reason
```

Stop for user confirmation only when the authoritative specification leaves required semantics unresolved. Preserve unrelated user work and do not let it enter the owned diff.

## Local implementation and review

For the local route only, create one concrete coding subagent (`gpt-5.6-terra`, medium reasoning) and reuse it for rework. Give it bounded or no inherited context, the TaskBrief, and no authority beyond the scoped implementation and validation.

After inspecting the actual owned diff and validation evidence, create a different read-only reviewer (`gpt-5.6-sol`, low reasoning) with bounded or no inherited context. It reviews raw artifacts against the TaskBrief, v3, `AGENTS.md`, and historical, authorization, recovery, and regression constraints. Findings require severity, file/line, evidence, and remediation.

The reviewer must return this exact local verdict record:

```text
Tackle-Review-Version: v1
Task-ID: ...
Base-SHA: ...
Reviewed-Head-SHA: ... | WORKTREE
Owned-Paths: ...
Patch-Hash: ...
Spec-SHA256: ...
Verdict: PASS | FINDINGS
```

`Patch-Hash` is SHA-256 lowercase hex of the UTF-8 RFC 8785 JCS bytes of this deterministic manifest:

```text
{"baseSha":"...","entries":[],"schemaVersion":"tackle-local-patch/v1"}
```

`entries` are UTF-8-byte sorted by normalized repo-relative `path`. Derive each path from the canonical repository root, use forward slashes, and preserve raw Unicode without normalization. Reject absolute or empty paths, `.`, `..` or traversal segments, NUL, invalid Unicode, and paths escaping that root. Tabs and newlines are permitted raw Unicode path characters and are parsed through Git's NUL-delimited output. Each regular-file entry has `path`, `state` (`tracked_changed`, `untracked`, or `unchanged`), git `mode`, decimal-byte `length`, and lowercase-hex `contentSha256` of its raw bytes. For either current-file state, set `mode` to `100755` iff any POSIX execute bit is set, otherwise `100644`; fail closed if execute bits cannot be read. Each deletion is a tombstone with `path`, `state:"deleted"`, base-tree git `mode`, base decimal-byte `length`, and base-content `contentSha256`. Reject symlinks, non-regular files, and modes other than these regular-file modes. Read and hash every entry before review and again after review; changed paths, states, modes, lengths, content hashes, base, Task-ID, owned-path set, or spec hash invalidate `PASS` and require a new review.

## Check contract automation

For workflow-contract changes, run these dependency-free Node 22 commands from the repository root:

```text
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --generate-index
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --patch-hash --base <base-sha> --owned <repo-relative-path> [--owned <repo-relative-path> ...]
node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs
```

`references/v3-navigation.json` is generated navigation and drift evidence only; it is not a product or domain authority and does not replace the mandatory complete v3 reading.

`PASS` is valid only for those artifacts. PR review evidence remains exclusively owned by `$agent-pr-loop`.

## Bounded resolution and handoff

Default to at most three review/fix cycles. Every rework cycle must resolve, disprove with evidence, or materially narrow findings; the same finding in two consecutive cycles requires the coordinator to re-check the TaskBrief and remediation direction. Never hide, downgrade, or rename a finding to reach `PASS`.

At the limit: safely split a remaining in-scope defect into a new bounded task; ask the user when new product semantics, authority, or scope is needed; or report a reproducible external blocker. Do not claim completion without a current valid `PASS` for the local route.

For user-visible local work outside an explicitly scoped visual review, retain `视觉与交互统一检查待执行` in the handoff. A minimal render smoke confirms only basic loadability and never removes that marker or counts as full visual acceptance. Full visual evidence is required only when visual or interaction review is explicitly in scope.

The handoff includes the owned files and outcome, TaskBrief identity, reviewer verdict and resolved findings, exact validation results, N/A reasons and residual risks. Review completion is not merge authorization.
