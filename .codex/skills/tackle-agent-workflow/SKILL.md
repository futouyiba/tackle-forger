---
name: tackle-agent-workflow
description: Prepare and route Tackle Forger implementation work through a scoped coding subagent and, only for local work, an independent read-only reviewer. Use for repository changes that include code, tests, fixes, or refactors, and when the user asks to start implementation or use the project agent workflow.
---

# Run the Tackle Agent Workflow

Use this Skill for project-specific constraints, task preparation, and a local implementation loop. `AGENTS.md` owns project validation and visual policy; v3 remains the only product and domain authority.

<!-- workflow-contract-policy-ref: AGENTS.md/workflow-contract-policy/v2 -->

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
Validation: required commands and scenarios; a triggered command or scenario cannot be N/A
```

The machine `tackle-task-brief/v1` is authoritative: record `changeClass`, `allowedChanges`, six boolean `riskDimensions` (`persistedData`, `historicalSnapshots`, `concurrency`, `authorization`, `externalSideEffects`, `userVisible`), and `validationPlan.requiredCommands`, `requiredScenarios`, `intentionallyNotApplicable`. Evidence stages are derived from the closed TaskBrief state: ordinary `pre_dispatch` is `development` and keeps exploration/coding light—no formal patch hash or PASS; a local `verdict` is `local_review_handoff` and freezes the review artifact; `pr_final` retains exact-head CI and merge gates. `AGENTS.md` owns the validation matrix; commands and scenarios are separate collections. The closed conditional N/A catalog is `product_runtime_tests` and `legacy_workspace_ci`: workflow-only metadata must provide the former with a reason such as “no product-code change”; every non-workflow class must run product tests and may not name it. Work that does not own `legacy-workspace/**` must provide the latter with a reason; work that does must instead run `node --test tests/package-manager-boundaries.test.mjs`, `pnpm --dir legacy-workspace install --frozen-lockfile`, and the four `pnpm --dir legacy-workspace --filter '@tackle-forger/*'` commands for typecheck, lint, test, and build. No triggered command or scenario may be N/A.

<!-- workflow-contract-task-brief-ref/v1
{"conditionalNaApplicability":{"legacyTouchedForbids":"legacy_workspace_ci","nonLegacyRequires":"legacy_workspace_ci","nonWorkflowForbids":"product_runtime_tests","workflowMetadataRequires":"product_runtime_tests"},"conditionalNaCatalog":{"legacyWorkspaceCi":"legacy_workspace_ci","productRuntimeTests":"product_runtime_tests"},"evidenceStages":{"development":"pre_dispatch_non_pr_final","localReviewHandoff":"local_verdict","prFinal":"pr_final_change_class"},"legacyWorkspaceCommands":["node --test tests/package-manager-boundaries.test.mjs","pnpm --dir legacy-workspace install --frozen-lockfile","pnpm --dir legacy-workspace --filter '@tackle-forger/*' typecheck","pnpm --dir legacy-workspace --filter '@tackle-forger/*' lint","pnpm --dir legacy-workspace --filter '@tackle-forger/*' test","pnpm --dir legacy-workspace --filter '@tackle-forger/*' build"],"triggeredCannotBeNa":true}
-->

For machine-checkable handoffs, preserve the same information as `tackle-task-brief/v1`, including `phase`, scope/acceptance/exclusions/risks/validation, base/head, current-v3 relevant sections (including 20), a structured OPEN decision check, risk profile/runtime-semantics flag, unowned pre-existing changes, `specReadReceipts`, and `dirtyWorktreeDisposition`. OPEN checking binds a hash of the complete current registry, records every checked ID, and makes applicable IDs a checked subset; a non-empty registry can still honestly have no applicable item only with a non-empty reason. The TaskBrief is the only authority for receipt risk/sections, but SCOPED is additionally gated by every owned path: only `AGENTS.md`, `.codex/skills/tackle-agent-workflow/**`, explicitly named non-authoritative governance docs, and root `.github/*.md|yml|yaml` may be SCOPED candidates. `docs/README.md`, v3, other product/domain contracts, and all other paths force FULL. A `pre_dispatch` brief requires exactly one coordinator receipt; a `verdict` brief requires exactly one receipt each for coordinator, coding, and review. Issue/PR reviewed heads must equal the current clean HEAD; base may differ, but must be its exact 40-hex ancestor. Only local work may use `WORKTREE`. All versioned records are closed schemas. When an owned path was already modified, generate and embed the complete `tackle-owned-baseline/v1` manifest plus its computed hash; do not record a hash alone. Run `--check-task-brief` before dispatch and record its `taskBriefSha256` and `specReceiptHashes` in the local verdict.

Stop for user confirmation only when the authoritative specification leaves required semantics unresolved. Preserve unrelated user work and do not let it enter the owned diff.

## Spec receipts and worktree isolation

The coordinator reads `docs/README.md` and all v3 once for each TaskBrief/spec hash. Coding and review roles use `FULL` for any product/domain/runtime behavior, persistence/history/migration, concurrency/auth, publication/export/external effects, unclear scope, or high risk. `SCOPED` is only for proven workflow/docs/metadata work with no runtime semantics; it reads README, v3 sections 0, 19, 20, and every relevant indexed section. Record immutable `tackle-spec-read/v1`: taskId, role, spec hash, profile, risk profile, required/read sections, and reason. It is an auditable declaration, not proof of reading; any task/spec/risk/role/section change invalidates it. Use `--spec-read-plan --role <coordinator|coding|review> --risk <workflow_docs_metadata|...> [--relevant <section> ...]` before recording and `--check-read-receipt --receipt <json-file>` to validate it.

Issue/PR routes require a clean worktree synchronized to intended base. For local work, pre-existing owned-path changes require explicit TaskBrief scope plus a frozen pre-task owned-path baseline manifest/hash; otherwise use a clean worktree. Preserve and exclude unowned changes. If the task-owned diff cannot be isolated, do not PASS; record its disposition in TaskBrief and verdict.

Findings require severity, file/line, evidence and remediation. P0 (data loss/security/immutable history break), P1 (wrong behavior, gate/evidence failure), and P2 (material regression or contract gap) are actionable and block PASS. P3 is informational and non-blocking. Never downgrade to obtain PASS. Local verdicts also include TaskBrief-SHA256, Spec-Receipt-Hashes, and Dirty-Worktree-Disposition.

## Local implementation and review

For the local route only, create one concrete coding subagent (`gpt-5.6-terra`, medium reasoning) and reuse it for rework. Give it bounded or no inherited context, the TaskBrief, and no authority beyond the scoped implementation and validation.

After inspecting the actual owned diff and validation evidence, create a different read-only reviewer (`gpt-5.6-sol`, low reasoning) with bounded or no inherited context. It reviews raw artifacts against the TaskBrief, v3, `AGENTS.md`, and historical, authorization, recovery, and regression constraints. Findings require severity, file/line, evidence, and remediation.

At `local_review_handoff`, the reviewer must return this exact local verdict record. Committed artifacts use their exact commit SHA and never require a redundant patch hash. A still-uncommitted `WORKTREE` uses base SHA + owned paths + patch hash:

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

Run validation through the closed-catalog helper, which receives a verdict-phase TaskBrief and derives the artifact identity, relevant-input hash, dependency-lock hash, command contract, Node/platform/arch identity, timestamps, durations, and exit results itself. It accepts no caller-authored result, success, hash, duration, or environment fields and never uses a shell. Every TaskBrief command is resolved exactly once or the helper fails before executing anything; unrecognized commands fail closed. The concise `tackle-validation-summary/v1` is handoff evidence only, with expandable failure details rather than copied logs. It is deliberately not embedded in, or treated as PASS proof by, editable Verdict JSON: the reviewer still verifies the actual run. Reuse requires all derived identities to match; `pr_final` never substitutes local reuse for exact-head CI.

## Check contract automation

For workflow-contract changes, run these dependency-free Node 22 commands from the repository root:

```text
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --generate-index
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --spec-read-plan --role <coordinator|coding|review> --risk <risk-profile> [--relevant <section> ...]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-read-receipt --receipt <receipt.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-task-brief --brief <task-brief.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --owned-baseline --base <sha> --owned <repo-relative-path> [--owned <path> ...]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --run-validation --brief <verdict-task-brief.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-verdict --verdict <verdict.json> --brief <task-brief.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --patch-hash --base <base-sha> --owned <repo-relative-path> [--owned <repo-relative-path> ...] # WORKTREE review handoff only
node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs
```

`references/v3-navigation.json` is generated navigation and drift evidence only; it is not a product or domain authority and does not replace the mandatory complete v3 reading.

`PASS` is valid only for those artifacts. PR review evidence remains exclusively owned by `$agent-pr-loop`.

## Bounded resolution and handoff

Default to at most three review/fix cycles. Every rework cycle must resolve, disprove with evidence, or materially narrow findings; the same finding in two consecutive cycles requires the coordinator to re-check the TaskBrief and remediation direction. Never hide, downgrade, or rename a finding to reach `PASS`.

At the limit: safely split a remaining in-scope defect into a new bounded task; ask the user when new product semantics, authority, or scope is needed; or report a reproducible external blocker. Do not claim completion without a current valid `PASS` for the local route.

For user-visible local work outside an explicitly scoped visual review, retain `视觉与交互统一检查待执行` in the handoff. A minimal render smoke confirms only basic loadability and never removes that marker or counts as full visual acceptance. Full visual evidence is required only when visual or interaction review is explicitly in scope.

The handoff includes the owned files and outcome, TaskBrief identity, reviewer verdict and resolved findings, exact validation results, N/A reasons and residual risks. Review completion is not merge authorization.
