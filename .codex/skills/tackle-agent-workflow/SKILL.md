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

## Start with a Task Card; create a TaskBrief at a formal boundary

Before implementation, follow `docs/spec-v3/README.md`: read the index, section 0, and sections 19–20; classify the task and read every routed section and direct dependency. Full reading is only for unknown scope, broadly cross-domain impact, or canonical-spec structure changes. Begin daily work with a closed `tackle-task-card/v1`, not a TaskBrief. Its exactly six semantic fields are `taskId`, `workflowMode`, `scope`, `ownedPaths`, `riskProfile`, and `changeClass`.

Run `--prepare-task-card --input <six-field-card.json>` only from a clean worktree. It mechanically binds the initial base/spec identity, workflow route, and complete OPEN registry coverage. For a resolved scoped route it also emits a read-plan template and an incomplete receipt-shaped draft (`readSections: []`); a person must complete and check the receipt after actually reading. It never generates a valid reading assertion. Every formal boundary has `formalTaskBriefRequiredAtBoundary: true`; `earlyEscalationRequired` separately flags runtime, persistence, historical snapshots, authorization, concurrency, publication/export/external effects, non-scoped paths, Issue/PR work, or uncertain classification. Non-scoped cards intentionally emit no complete route/read plan.

After daily implementation changes only card-owned paths, use `--upgrade-task-card --card <task-card.json> --boundary-input <formal-boundary.json>` at the formal local-review boundary. It verifies the original card base is still current HEAD and rejects any unowned dirt, then requires the human formal decisions, complete routed sections, OPEN applicability and completed coordinator receipt before emitting the ordinary full TaskBrief. This bridge treats the dirty owned diff as the current task artifact, never as pre-existing work. A stale card, unowned dirt, unknown/high risk, or incomplete route fails closed.

At a formal local-review handoff, Issue dispatch, or PR boundary, create the full TaskBrief and pass its raw form to participating agents:

For a clean worktree, start with `--prepare-task-brief --input <semantic-input.json>`. The closed input deliberately requires the human decisions it cannot safely infer: task ID and route, base revision, scope, owned paths, acceptance criteria, exclusions, risk profile/dimensions, runtime-semantics declaration, relevant v3 sections (including 20), OPEN applicability/reason, and a complete closed coordinator `tackle-spec-read/v1` or `v2` receipt. The command validates and embeds that supplied receipt; it never turns a reason into a reading claim or manufactures `readSections`. A reused v2 receipt additionally requires the trusted caller context flags `--current-agent-identity`, `--current-context-session-id`, and `--current-context-state continuous`; omitted, mismatched, unknown, or compacted context fails closed, while v1 needs no such flags. Local preparation requires `baseSha` to equal the current exact HEAD, so committed changes cannot be silently absorbed as task input; Issue/PR preparation retains their exact-head ancestor rules. It derives current canonical hashes, full OPEN checked IDs, exact current head/worktree identity, allowed changes, conditional N/A reasons, and validation commands/scenarios, then immediately runs the existing TaskBrief checker. Workflow owned-file whitespace validation is a closed `--check-owned-whitespace` command: tracked/deleted files use Git's base diff and untracked files use `git diff --no-index --check /dev/null`, so later-created owned files cannot evade trailing-whitespace checks. It rejects unknown-high-risk preparation and only accepts the closed risk/profile/class/dimension combinations that imply their required scenarios; every true declared risk dimension contributes its required scenarios without changing the declared dimensions. It fails on dirty worktrees, invalid/duplicate/non-file/symlink paths, invalid current sections or OPEN IDs, unsupported risk/change combinations, non-ancestor bases, and missing semantic input. It never creates commits, branches, PRs, or a claim that the specification was understood.

```text
Task-ID / workflow mode (local | issue | pull_request)
Spec: path, content hash, relevant sections, checked OPEN decisions
Code identity: base SHA; reviewed head SHA or WORKTREE; branch; owned paths; pre-existing changes
Scope: acceptance criteria; explicit exclusions; permitted changes
Risk: persisted or historical data; concurrency; authorization; external effects; user-visible impact
Validation: required commands and scenarios; a triggered command or scenario cannot be N/A
```

The machine `tackle-task-brief/v1` is authoritative: record `changeClass`, `allowedChanges`, six boolean `riskDimensions` (`persistedData`, `historicalSnapshots`, `concurrency`, `authorization`, `externalSideEffects`, `userVisible`), and `validationPlan.requiredCommands`, `requiredScenarios`, `intentionallyNotApplicable`. Evidence stages are derived from the closed TaskBrief state: ordinary `pre_dispatch` is `development` and keeps exploration/coding light—no formal patch hash or PASS; a local `verdict` is `local_review_handoff` and freezes the review artifact; `pr_final` retains exact-head CI and merge gates. `AGENTS.md` owns the validation matrix; commands and scenarios are separate collections. Its closed `executionTiers` keep iteration and candidate validation orthogonal: `iterationFullCi: forbidden` prevents routine inspection, documentation, focused-rule, deployment, business-code, or durable/external iteration from silently escalating to full CI, but never waives the stable candidate's `candidateFullCi: once_per_exact_head_base`. A rebase reruns affected checks first; broad impact or a newly stable exact head/base candidate requires candidate CI. The closed conditional N/A catalog is `product_runtime_tests` and `legacy_workspace_ci`: workflow-only metadata must provide the former with a reason such as “no product-code change”; every non-workflow class must run product tests and may not name it. Work that does not own `legacy-workspace/**` must provide the latter with a reason; work that does must instead run `node --test tests/package-manager-boundaries.test.mjs`, `pnpm --dir legacy-workspace install --frozen-lockfile`, and the four `pnpm --dir legacy-workspace --filter '@tackle-forger/*'` commands for typecheck, lint, test, and build. No triggered command or scenario may be N/A.

<!-- workflow-contract-task-brief-ref/v1
{"conditionalNaApplicability":{"legacyTouchedForbids":"legacy_workspace_ci","nonLegacyRequires":"legacy_workspace_ci","nonWorkflowForbids":"product_runtime_tests","workflowMetadataRequires":"product_runtime_tests"},"conditionalNaCatalog":{"legacyWorkspaceCi":"legacy_workspace_ci","productRuntimeTests":"product_runtime_tests"},"evidenceStages":{"development":"task_card_daily","localReviewHandoff":"local_verdict","prFinal":"pr_final_change_class"},"executionTiers":{"business_code":{"iterationFullCi":"forbidden","requiredEvidence":["typecheck","lint","related_tests"]},"deployment_configuration":{"iterationFullCi":"forbidden","requiredEvidence":["config_validation","service_restart","actual_listener","health_check"]},"documentation_or_nonbehavior_workflow":{"iterationFullCi":"forbidden","requiredEvidence":["format_reference_scoped_diff"]},"durable_or_external":{"iterationFullCi":"forbidden","requiredEvidence":["boundary","failure_recovery","idempotency","readback"]},"focused_script_or_rule":{"iterationFullCi":"forbidden","requiredEvidence":["targeted_test"]},"inspection_only":{"iterationFullCi":"forbidden","requiredEvidence":["fetch_compare_history_or_status"]},"rebase_refresh":{"candidateFullCi":"broad_impact_or_new_stable_candidate","requiredEvidence":["actual_diff_classification","affected_checks"]},"stable_pr_candidate":{"candidateFullCi":"once_per_exact_head_base","requiredEvidence":["root_full_ci","applicable_historical_ci","windows_policy"]}},"legacyWorkspaceCommands":["node --test tests/package-manager-boundaries.test.mjs","pnpm --dir legacy-workspace install --frozen-lockfile","pnpm --dir legacy-workspace --filter '@tackle-forger/*' typecheck","pnpm --dir legacy-workspace --filter '@tackle-forger/*' lint","pnpm --dir legacy-workspace --filter '@tackle-forger/*' test","pnpm --dir legacy-workspace --filter '@tackle-forger/*' build"],"triggeredCannotBeNa":true}
-->

For machine-checkable handoffs, preserve the same information as `tackle-task-brief/v1`, including `phase`, scope/acceptance/exclusions/risks/validation, base/head, current-v3 relevant sections (including 20), a structured OPEN decision check, risk profile/runtime-semantics flag, unowned pre-existing changes, `specReadReceipts`, and `dirtyWorktreeDisposition`. OPEN checking binds a hash of the complete current registry, records every checked ID, and makes applicable IDs a checked subset; a non-empty registry can still honestly have no applicable item only with a non-empty reason. The TaskBrief is the only authority for receipt risk/sections, but SCOPED is additionally gated by every owned path: only `AGENTS.md`, `.codex/skills/tackle-agent-workflow/**`, explicitly named non-authoritative governance docs, root `.github/*.md|yml|yaml`, and canonical Actions workflow files directly in `.github/workflows/*.yml|yaml` may be SCOPED candidates. Other nested `.github` paths remain ineligible. `docs/README.md`, v3, other product/domain contracts, and all other paths force FULL. The embedded `workflow-contract-policy-ref` remains the canonical AGENTS policy reference for this classification. A `pre_dispatch` brief requires exactly one coordinator receipt; a `verdict` brief requires exactly one receipt each for coordinator, coding, and review. To advance a local `WORKTREE` brief, use `--promote-task-brief --brief <pre-dispatch.json> --coding-receipt <coding.json> --review-receipt <review.json> [--reuse-contexts <role-contexts.json>]`. The optional context file is a closed object keyed only by each `REUSE_FULL` receipt role (`coordinator`, `coding`, `review`), with each value carrying independently trusted agent, session, and `continuous` state; v1 receipts have no context entry. It validates receipt bindings, owned-only Git status, and the frozen baseline, then changes only phase, receipt composition, and mechanical artifact/disposition fields. It never changes TaskBrief semantics or creates a verdict, PASS, findings, validation result, commit, or external side effect. Issue/PR reviewed heads must equal the current clean HEAD; base may differ, but must be its exact 40-hex ancestor. Only local work may use `WORKTREE`. All versioned records are closed schemas. When an owned path was already modified, generate and embed the complete `tackle-owned-baseline/v1` manifest plus its computed hash; do not record a hash alone. Run `--check-task-brief` before dispatch and record its `taskBriefSha256` and `specReceiptHashes` in the local verdict.

Stop for user confirmation only when the authoritative specification leaves required semantics unresolved. Preserve unrelated user work and do not let it enter the owned diff.

## Spec receipts and worktree isolation

Every role follows the progressive index. `ROUTED` reads README, the v3 index, sections 0, 19, 20, every relevant indexed section, and its direct dependencies. `SCOPED` is the same bounded protocol for proven workflow/docs/metadata work with no runtime semantics. `FULL` reads every module and is required only for unknown scope, broadly cross-domain impact, or canonical specification structure changes. Record immutable `tackle-spec-read/v1`: taskId, role, spec hash, profile, risk profile, required/read sections, and reason.

For a continuous same-Agent context only, a prior FULL v1 receipt may be captured in closed `tackle-spec-full-read-session/v1` evidence and reused by a task-specific `tackle-spec-read/v2` receipt with `profile: "REUSE_FULL"`. The checker accepts this only when the exact agent identity and context-session identity match, context is explicitly `continuous`, v3/README/OPEN-registry hashes are current and identical, the original receipt is FULL for the same role, and the low-risk task explicitly records every scoped and relevant section as read. Reuse additionally requires trusted current agent identity, current context-session identity, and current context state; all three must match the stored session and the state must be exactly `continuous`. It never infers continuity from elapsed time: unknown or compacted context, any identity or hash change, role change, risk increase, runtime semantics, or incomplete relevant sections requires a new FULL read. A single receipt check accepts its three flags; a TaskBrief, validation, or verdict with any v2 receipts instead receives the closed role-keyed `--reuse-contexts <role-contexts.json>` mapping, including exactly those v2 roles. Receipts remain auditable declarations, never proof of comprehension.

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
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --upgrade-task-card --card <task-card.json> --boundary-input <formal-boundary.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --spec-read-plan --role <coordinator|coding|review> --risk <risk-profile> [--relevant <section> ...]
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-read-receipt --receipt <receipt.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-task-brief --brief <task-brief.json>
node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --promote-task-brief --brief <pre-dispatch-task-brief.json> --coding-receipt <coding-receipt.json> --review-receipt <review-receipt.json> [--reuse-contexts <role-contexts.json>]
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

The handoff includes the owned files and outcome, TaskBrief identity, reviewer verdict and resolved findings, exact validation results, N/A reasons and residual risks. Review completion is not merge authorization.
