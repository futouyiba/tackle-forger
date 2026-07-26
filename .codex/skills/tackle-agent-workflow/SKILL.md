---
name: tackle-agent-workflow
description: Prepare and route Tackle Forger implementation work with a lightweight Task Card, a formal review tier, and tier-appropriate evidence. Use for repository changes that include code, tests, fixes, or refactors, and when the user asks to start implementation or use the project agent workflow.
---

# Run the Tackle Agent Workflow

Use this Skill for project-specific constraints, task preparation, and a local implementation loop. `AGENTS.md` owns project validation and visual policy; v3 remains the only product and domain authority.

<!-- workflow-contract-policy-ref/v2: .codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json -->

## Route before dispatch

Choose exactly one route before dispatch. The coordinator chooses implementation capacity and reviewer count, specialization, model, reasoning strength, and scheduling from task risk, scope, available capabilities, and resources.

- **Local implementation, no Issue or PR:** this Skill owns local implementation and applies the TaskBrief review tier at the local evidence boundary.
- **Issue delivery:** `$agent-issue-loop` owns Issue, branch, PR, closure, and handoff. Supply it this Skill's TaskBrief. Once a PR exists, `$agent-pr-loop` exclusively owns review, CI, fixes, and merge gates.
- **Existing PR:** invoke `$agent-pr-loop` directly and supply the TaskBrief. It owns the review loop.

The versioned policy reference above is the machine authority for review tiers, risk floors, receipt roles, route boundaries, and validation requirements. This Skill applies that policy without restating its matrices. It does not own PR merge action, publication, deployment, deletion, scope expansion, or other external actions.

## Start with a Task Card; create a TaskBrief at a formal boundary

Before implementation, follow `docs/spec-v3/README.md`: read the index, section 0, section 19, and the generated compact OPEN registry; classify the task and read every routed section plus only the canonical OPEN subsections and explicit dependencies selected from TaskBrief `applicableIds`. Empty applicability retains the full registry hash, complete checked IDs, and a non-empty reason without loading all of section 20. Unknown/broad scope, canonical-spec structure changes, strict/high-risk work, or unreliable applicability fail closed to FULL. Begin daily work with a closed `tackle-task-card/v1`, not a TaskBrief. Its exactly six semantic fields remain `taskId`, `workflowMode`, `scope`, `ownedPaths`, `riskProfile`, and `changeClass`; choose `reviewTier` only at the formal TaskBrief boundary.

Run `--prepare-task-card --input <six-field-card.json>` only from a clean worktree. Add `--store-run` when the daily card itself needs a private durable record. It mechanically binds the initial base/spec identity, workflow route, and complete OPEN registry coverage. For a resolved scoped route it also emits a read-plan template and an incomplete receipt-shaped draft (`readSections: []`); a person must complete and check the receipt after actually reading. It never generates a valid reading assertion. Every formal boundary has `formalTaskBriefRequiredAtBoundary: true`; `earlyEscalationRequired` separately flags runtime, persistence, historical snapshots, authorization, concurrency, publication/export/external effects, non-scoped paths, Issue/PR work, or uncertain classification. Non-scoped cards intentionally emit no complete route/read plan.

After daily implementation changes only card-owned paths, use `--upgrade-task-card --card <task-card.json> --boundary-input <formal-boundary-with-review-tier.json>` at the formal evidence boundary. Add `--store-run` to persist the resulting formal TaskBrief, never the source card. It verifies the original card base is still current HEAD and rejects any unowned dirt, then requires the human `reviewTier` decision, complete routed sections, OPEN applicability and completed coordinator receipt before emitting the ordinary full TaskBrief. This bridge treats the dirty owned diff as the current task artifact, never as pre-existing work. A stale card, unowned dirt, unknown/high risk, invalid tier, or incomplete route fails closed.

At a formal local-review handoff, Issue dispatch, or PR boundary, create the full TaskBrief and pass its raw form to participating agents:

For a clean worktree, start with `--prepare-task-brief --input <semantic-input-with-review-tier.json>`. Add optional `--store-run` to write the canonical resulting JSON to the current worktree's Git-private `codex-runs` path; this never creates a worktree file or Git-tracked artifact, reports `TaskBrief-Run-Path: <absolute-path>` only on stderr, and keeps stdout as the prepared JSON. A stored daily card instead uses the distinct `TaskCard-Run-Path` report and `task-card-...json` identity; a formal brief uses `task-brief-...json`, whether created directly or through `--upgrade-task-card --store-run`. The path is resolved by Git for the active worktree, so linked worktrees remain separate. Each immutable record identity combines its type, a SHA-256 task-ID digest (never a path component supplied by the task), and the canonical record hash: identical reruns reuse it, while a rebase or evolved record under the same task ID creates another record. Publication writes a complete same-directory temporary file and atomically hard-links it into the final no-overwrite name; a concurrent writer may only read that completed final file. This requires a filesystem with same-directory hard-link support (including normal NTFS); unsupported files fail closed. Publisher-owned temporaries are removed, abandoned old temporaries are cleaned, and unsafe directory/record/temporary symlinks or collisions stop preparation. On POSIX the storage directory and records are forced and verified as `0700`/`0600`; Windows intentionally skips POSIX mode semantics. The closed input deliberately requires the human decisions it cannot safely infer: task ID and route, base revision, scope, owned paths, acceptance criteria, exclusions, risk profile/dimensions, independent review tier, runtime-semantics declaration, relevant v3 sections (including 20), OPEN applicability/reason, and a complete closed coordinator `tackle-spec-read/v1` or `v2` receipt. The command validates and embeds that supplied receipt; it never turns a reason into a reading claim or manufactures `readSections`. A reused v2 receipt additionally requires the trusted caller context flags `--current-agent-identity`, `--current-context-session-id`, and `--current-context-state continuous`; omitted, mismatched, unknown, or compacted context fails closed, while v1 needs no such flags. Local preparation requires `baseSha` to equal the current exact HEAD, so committed changes cannot be silently absorbed as task input; Issue/PR preparation retains their exact-head ancestor rules. It derives current canonical hashes, full OPEN checked IDs, exact current head/worktree identity, allowed changes, conditional N/A reasons, and validation commands/scenarios, then immediately runs the existing TaskBrief checker. Workflow owned-file whitespace validation is a closed `--check-owned-whitespace` command: tracked/deleted files use Git's base diff and untracked files use `git diff --no-index --check /dev/null`, so later-created owned files cannot evade trailing-whitespace checks. It rejects unknown-high-risk preparation and only accepts the closed risk/profile/class/dimension combinations that imply their required scenarios; every true declared risk dimension contributes its required scenarios without changing the declared dimensions. It fails on dirty worktrees, invalid/duplicate/non-file/symlink paths, invalid current sections or OPEN IDs, unsupported risk/change combinations, non-ancestor bases, invalid review tiers, and missing semantic input. It never creates commits, branches, PRs, or a claim that the specification was understood.

```text
Task-ID / workflow mode (local | issue | pull_request)
Spec: path, content hash, relevant sections, checked OPEN decisions
Code identity: base SHA; reviewed head SHA or WORKTREE; branch; owned paths; pre-existing changes
Scope: acceptance criteria; explicit exclusions; permitted changes
Risk: persisted or historical data; concurrency; authorization; external effects; user-visible impact
Review tier: fast | standard | strict (review boundary/intensity only; independent from risk profile)
Validation: required commands and scenarios; a triggered command or scenario cannot be N/A
```

The closed `tackle-task-brief/v1` remains the formal handoff record. Its schema, receipt composition, route eligibility, evidence stages, and validation matrix come from the versioned policy and are enforced by `workflow-contract.mjs`; display prose is not a competing authority.

To advance a local `WORKTREE` brief, use `--promote-task-brief --brief <pre-dispatch.json> --coding-receipt <coding.json> [--review-receipt <review.json when required by policy>] [--reuse-contexts <role-contexts.json>]`. The command validates receipt bindings, owned-only Git status, and the frozen baseline, then changes only phase, receipt composition, and mechanical artifact/disposition fields. It never creates a verdict, PASS, commit, or external side effect. Run `--check-task-brief` before dispatch and record its returned hashes in the local verdict.

Stop for user confirmation only when the authoritative specification leaves required semantics unresolved. Preserve unrelated user work and do not let it enter the owned diff.

## Spec receipts and worktree isolation

Follow the read plan emitted from the versioned route policy and generated OPEN registry, then record the resulting immutable spec receipt. Do not derive SCOPED, ROUTED, FULL, OPEN subsection locators, dependencies, receipt roles, or required sections from prose.

For receipt reuse, pass the trusted identity/session/state inputs required by the generated plan and the closed policy. The checker, not display prose, decides whether `REUSE_FULL` is valid; receipts remain auditable declarations, never proof of comprehension.

Issue/PR routes require a clean worktree synchronized to intended base. For local work, pre-existing owned-path changes require explicit TaskBrief scope plus a frozen pre-task owned-path baseline manifest/hash; otherwise use a clean worktree. Preserve and exclude unowned changes. If the task-owned diff cannot be isolated, do not PASS; record its disposition in TaskBrief and verdict.

Record findings and verdict fields exactly as required by the versioned policy and checker. Never downgrade a finding to obtain PASS.

## Local implementation and review

At the local evidence boundary, load the policy-required receipt roles and review boundary from the referenced machine authority. Give every participating role the TaskBrief and no authority beyond its scoped implementation, validation, or read-only review work.

When policy requires local review, each assigned reviewer checks the exact local artifact read-only against the TaskBrief and applicable authority. The coordinator records every finding disposition and integrates the single local verdict only after all required scopes cover the unchanged artifact.

At `local_review_handoff`, collect any policy-required review evidence, dispose findings, and emit one local verdict record. Committed artifacts use their exact commit SHA; a still-uncommitted `WORKTREE` uses base SHA + owned paths + patch hash:

```text
Tackle-Review-Version: v1
Task-ID: ...
Base-SHA: ...
Reviewed-Head-SHA: ... | WORKTREE
Owned-Paths: ...
Artifact-Identity: commit:<exact SHA> | worktree:<base SHA + owned paths + patch hash>
Spec-SHA256: ...
TaskBrief-SHA256: ...
Spec-Receipt-Hashes: ...
Dirty-Worktree-Disposition: ...
Verdict: PASS | FINDINGS
```

For a `WORKTREE`, `Patch-Hash` is SHA-256 lowercase hex of the UTF-8 RFC 8785 JCS bytes of this deterministic manifest:

```text
{"baseSha":"...","entries":[],"schemaVersion":"tackle-local-patch/v1"}
```

`entries` are UTF-8-byte sorted by normalized repo-relative `path`. Derive each path from the canonical repository root, use forward slashes, and preserve raw Unicode without normalization. Reject absolute or empty paths, `.`, `..` or traversal segments, NUL, invalid Unicode, and paths escaping that root. Tabs and newlines are permitted raw Unicode path characters and are parsed through Git's NUL-delimited output. Each regular-file entry has `path`, `state` (`tracked_changed`, `untracked`, or `unchanged`), git `mode`, decimal-byte `length`, and lowercase-hex `contentSha256` of its raw bytes. For either current-file state, set `mode` to `100755` iff any POSIX execute bit is set, otherwise `100644`; fail closed if execute bits cannot be read. Each deletion is a tombstone with `path`, `state:"deleted"`, base-tree git `mode`, base decimal-byte `length`, and base-content `contentSha256`. Reject symlinks, non-regular files, and modes other than these regular-file modes. Read and hash every worktree entry before review and again after review; changes invalidate `PASS`. For a committed artifact, a different commit SHA invalidates the review.

Run validation through the closed-catalog helper, which receives a verdict-phase TaskBrief and derives the artifact identity, relevant-input hash, dependency-lock hash, command contract, actual resolved tool path/version, PATH and execution-environment hashes, installed-dependency identity, timestamps, durations, and exit results itself. It accepts no caller-authored result, success, hash, duration, or environment fields and never uses a shell. A committed artifact requires a fully clean worktree; a `WORKTREE` artifact rejects any preexisting/unowned dirt and permits only TaskBrief-owned changes whose Git status exactly matches its frozen manifest. Every TaskBrief command is resolved exactly once, every required tool must resolve and report a version before execution, or the helper fails before executing anything; unrecognized commands fail closed. The concise `tackle-validation-summary/v1` is handoff evidence only, with expandable failure details rather than copied logs. It is deliberately not embedded in, or treated as PASS proof by, editable Verdict JSON: the reviewer still verifies the actual run. Reuse requires all derived identities to match; `pr_final` never substitutes local reuse for exact-head CI.

## Check contract automation

For workflow-contract changes, run these dependency-free Node 22 commands from the repository root:

```text
node scripts/spec-v3-modules.mjs --check
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --generate-index
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --prepare-task-card --input <six-field-card.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-task-card --card <task-card.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --upgrade-task-card --card <task-card.json> --boundary-input <formal-boundary-with-review-tier.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --spec-read-plan --role <coordinator|coding|review> --risk <risk-profile> [--review-tier <fast|standard|strict>] [--relevant <section> ...] [--applicable <OPEN-id> ...]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-read-receipt --receipt <receipt.json> [--review-tier <fast|standard|strict>] [--applicable <OPEN-id> ...]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-task-brief --brief <task-brief.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --promote-task-brief --brief <pre-dispatch-task-brief.json> --coding-receipt <coding-receipt.json> [--review-receipt <review-receipt.json when tier requires>] [--reuse-contexts <role-contexts.json>]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --owned-baseline --base <sha> --owned <repo-relative-path> [--owned <path> ...]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --run-validation --brief <verdict-task-brief.json> [--reuse-contexts <role-contexts.json>]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-verdict --verdict <verdict.json> --brief <task-brief.json> [--reuse-contexts <role-contexts.json>]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --patch-hash --base <base-sha> --owned <repo-relative-path> [--owned <repo-relative-path> ...] # WORKTREE review handoff only
node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs
```

`docs/spec-v3/manifest.json` and `README.md` are the canonical module order and progressive routing entry. `references/v3-navigation.json` remains generated drift evidence and does not replace routed source sections.

`PASS` is valid only for those artifacts. PR review evidence remains exclusively owned by `$agent-pr-loop`.

## Bounded resolution and handoff

Default to at most three review/fix cycles. Every rework cycle must resolve, disprove with evidence, or materially narrow findings; the same finding in two consecutive cycles requires the coordinator to re-check the TaskBrief and remediation direction. Never hide, downgrade, or rename a finding to reach `PASS`.

At the limit: safely split a remaining in-scope defect into a new bounded task; ask the user when new product semantics, authority, or scope is needed; or report a reproducible external blocker. Do not claim completion without a current valid `PASS` for the local route.

For user-visible local work outside an explicitly scoped visual review, retain `视觉与交互统一检查待执行` in the handoff. A minimal render smoke confirms only basic loadability and never removes that marker or counts as full visual acceptance. Full visual evidence is required only when visual or interaction review is explicitly in scope.

The handoff includes the owned files and outcome, TaskBrief identity and review tier, any assigned reviewer findings and dispositions, exact validation results, N/A reasons and residual risks. It records evidence without deciding the subsequent integration action.
