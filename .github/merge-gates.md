# Agent pull request merge gate

This document is the sole complete human-readable authority for Tackle Forger
pull-request merge eligibility and the Agent review-signal format. Other
repository instructions and Skills route work here rather than restating these
rules.

Tackle Forger currently does not use a GitHub Ruleset or branch protection as
the merge gate. Issue #27 deliberately chose an Agent/managed-flow gate. Do not
add required checks, status contexts, or a duplicate workflow for this policy.

## Review readiness is not merge readiness

Use separate decisions for entering formal review and entering the merge path:

- A pull request is **ready for review** when its scoped implementation,
  validation, migration notes, risks, and rollback evidence are complete enough
  for a reviewer to decide. At that point, remove Draft and move the linked
  Issue to `In review`.
- A pull request is **merge-ready** only when the live checker accepts its
  current head, review findings and threads are settled, and dependencies and
  the base are current. A current review signal is additionally required only
  when the workflow machine policy, repository or platform policy, or the
  high-risk merge gate requires one.

## Qualified automatic merge authorization

This repository grants standing merge authorization to the first capable
coordinating Agent or single managed supervisor when the trusted live checker
returns `READY` for the exact current head/base. No additional per-turn user
instruction is required. The coordinator is expected to merge one qualifying
pull request through the repository's normal GitHub merge method and immediately
read back the PR state, merge SHA, and remote base containment.

An explicit user instruction made at the start of or during the current task
to not merge, wait for a human merge, or ask again before merging creates a
task-scoped human gate. `READY` does not override that hold. Only a later
explicit user instruction authorizing the merge clears it; silence, elapsed
time, successful CI or review, retries, and a fresh `READY` result do not.
If that hold arrives after auto-merge was enabled or the pull request entered
a merge queue, and the pull request is still unmerged, the coordinator must
immediately disable auto-merge or remove only that pull request from the queue
and read back its state. If the platform cannot safely cancel the pending
merge, report the human gate and verify whether the pull request merged.
Cancellation and readback do not clear the hold. After later explicit user
authorization, refresh the exact head/base and rerun the live checker before
entering any merge transport again.

This standing authorization does not apply when the checker is not `READY`, a
product or scope decision remains unresolved, dependency order is ambiguous,
required validation or identity is unavailable, retries are exhausted, or the
merge itself triggers deployment, publishing, release, destructive data work,
an authorization/security decision, or another external side effect. The
workflow-governance path below is a standing, independently reviewed exception
to the checker's `READY` result and does not itself require a human decision.
At any actual human gate, stop and request the missing decision.
Never reinterpret merge authorization as permission to deploy, publish, delete,
expand scope, or perform another external action.

## Validation cadence

Full CI is a stable-candidate boundary, not a default development loop. Read-only
fetch/compare/history/status work runs no CI. Documentation or non-behavioral
workflow edits use format, reference, and scoped-diff checks; focused scripts or
rules use targeted tests; deployment configuration uses configuration validation,
service restart, actual-listener inspection, and a health check; business code
uses typecheck, lint, and related tests; durable data, permission, or external
writes additionally require boundary, failure-recovery, idempotency, and readback
evidence. A rebase starts by classifying its actual diff and reruns only affected
checks unless that diff is broad.

These are two independent dimensions: an iteration classification that forbids
full CI does not waive or prohibit the stable-candidate boundary. Business,
deployment, and durable/external changes stay targeted while iterating, then still
require one complete CI run when they become a stable exact head/base candidate.

Run the complete PR CI once for a stable exact head/base candidate. A head or base
change invalidates that identity and requires affected checks first; repeat full CI
when the refreshed candidate is again stable, or when broad impact makes the full
run necessary. The live merge checker still requires one eligible exact-head/base
run containing every canonical job; this cadence never permits missing, stale,
partial, or cross-run evidence.

Development branches do not trigger this workflow. Draft pull requests retain a
remote discussion object without allocating CI runners. Moving a pull request to
Ready for review triggers the candidate run; later candidate heads trigger fresh
runs, while concurrency cancellation stops superseded runs for the same pull
request. Cross-session problem tracking belongs in the lightweight Agent task
Issue, not in an early pull request opened only to preserve context.

Do not require this merge checker to pass before removing Draft. The checker
intentionally rejects Draft pull requests, while a high-risk review signal is
normally collected after formal review begins. Requiring both in the opposite
order creates a circular blocker. The correct high-risk sequence is:

```text
complete implementation and scoped validation
→ remove Draft and enter formal review
→ record a current-head review signal and settle its findings
→ run the live merge checker
→ establish exact-head integration evidence
```

Classify blockers before changing ownership: implementation or acceptance
defects return to implementation; evidence gaps require collection or reruns;
metadata lag is reconciled by an authorized observer; an externally required
approval blocks merge without making the code defective; dependency or base
changes require a sync and fresh current-head CI. Never return work to an
implementer solely to change Draft or Issue status.

This repository has one accountable owner coordinating several Agents. A
current-head `COMMENTED` review, a Bot review, or a review submitted through the
owner's GitHub identity may therefore serve as the traceable review signal.
When a review signal is required, the canonical integrated Agent review uses
this complete six-field envelope, with the exact reviewed head and base:

```text
Agent-Review-Version: v1
Reviewer-Role: independent-review-agent
Head-SHA: <full SHA>
Base-SHA: <full SHA>
Verdict: PASS
Agent-Review: PASS
```

This envelope moves the existing review-signal contract here without changing
the live checker's behavior: for a `COMMENTED` review, the checker mechanically
requires the exact standalone `Agent-Review: PASS` line and binds the review to
the current head through GitHub evidence; the remaining fields preserve the
coordinator's exact-head/base audit context. An arbitrary comment or a review
that only reports findings does not count.
Unresolved threads and an active `CHANGES_REQUESTED` still block, and the
supervising Agent must inspect the review contents and acceptance evidence
before recording the marker. Never describe an Agent review as a human GitHub
`APPROVED` review. Human approval is required only when GitHub rules or an
explicit owner decision separately requires it.

Before recommending or performing a merge, the supervising Agent must classify
the change as `normal` or `high` risk and run the read-only checker against the
live pull request. The command itself must be run from a clean, up-to-date
checkout of the live target branch, never from the pull request worktree:

```powershell
npm run governance:check-pr -- --repo futouyiba/tackle-forger --pr <number> --risk <normal|high>
```

The checker hashes its own loaded file and compares it with
`scripts/check-pr-merge-gate.mjs` at the live base SHA. A missing base copy
returns `GATE_PROGRAM_BOOTSTRAP_REQUIRED`; any mismatch returns
`GATE_PROGRAM_UNTRUSTED`. It also compares the reviewed head's gate-program
content with the base copy; a change returns `GATE_PROGRAM_CHANGED`. Do not copy
the checker from the reviewed branch or use a reviewed branch's `package.json`
command to evade this check.

The command is successful evidence only when the live-base entrypoint actually
executes and emits a non-empty first line beginning with `READY` or `BLOCKED`.
Exit code 0 with empty output, or output without either explicit disposition,
is an entrypoint failure and must be treated as blocked.

The command reads the pull request around two complete evidence queries. It
compares normalized CI, review, and review-thread fingerprints and retries if
either the PR identity or any gate evidence changes. After three unstable
attempts it fails closed. It then evaluates only evidence bound to the reported
current head SHA, pull request number, and current base SHA:

- the PR is not Draft;
- the current head's `.github/workflows/ci.yml` has the same SHA-256 content as
  the file read from the live base SHA;
- `Root v3 app (npm)` and `Windows line-ending policy` are present, explicitly owned by the
  `github-actions` app, and successful in a `pull_request` workflow run for that
  PR, head, and base;
- no review thread remains unresolved and no active current-head
  `CHANGES_REQUESTED` review remains;
- a high-risk change has a current-head review signal (`COMMENTED` or
  `APPROVED`) with a GitHub actor identity. `COMMENTED` additionally requires
  the exact `Agent-Review: PASS` line. Actor type and equality with the PR author
  do not decide validity in this single-owner, multi-Agent repository.
  A later `CHANGES_REQUESTED` or dismissed review invalidates earlier evidence
  from that reviewer until a fresh current-head signal is recorded. On the same
  current head, a later exact `Agent-Review: PASS` from that reviewer replaces
  their earlier `CHANGES_REQUESTED`; an arbitrary `COMMENTED` review does not.

Missing, pending, failed, cancelled, skipped, push-only, old-head, or stale-base
CI blocks. The workflow's structured `run-name` records the event-time PR
number, head, and base; do not use the workflow-run API's nested current PR
object as historical evidence because those fields can drift with the PR. Runs
without the exact provenance format and canonical workflow path are not
eligible evidence. The checker first filters runs to the target PR and head,
then selects the newest eligible run for that PR; a newer run for another PR
using the same head cannot shadow it. The selected run's jobs are read from
GitHub's attempt-specific jobs endpoint, so the checker does not depend on an
undocumented `job.run_attempt` field and never combines jobs from an older run
or attempt.
Each required job name must appear exactly once in that attempt, so a missing or
duplicate same-name job blocks instead of falling back or masking a failure. It
prints a stable blocker code for every unmet condition and exits
`1`; API or authentication failures exit `2`. `--json` provides
machine-readable output. Malformed pagination evidence also fails closed as an
API error; a connection that declares another page must supply a non-empty
cursor.

### Historical workspace recovery evidence

The historical pnpm workspace is outside the main tree, daily CI, merge-gate
evidence, and Agent workflow validation. It is retained only in Git history,
not as a currently supported delivery target. The immutable annotated tag
`legacy-workspace-last-green-2026-07-26` resolves to
`702938b36bed0c2ea5489238318778a18d53059f` and records its last known green
baseline with Node `22.16.0` and pnpm `10.33.2`. Any future restoration must be
a separately reviewed governance change that explicitly re-establishes its
commands and acceptance evidence; this tag is recovery evidence only.

## Workflow governance path

GitHub runs a `pull_request` workflow from the pull request merge context.
Therefore the path, run name, and job display names do not prove that the
trusted commands ran. The checker reads `.github/workflows/ci.yml` at both the
live base SHA and current head SHA and compares the decoded file contents. Any
difference returns `CI_WORKFLOW_CHANGED`, even when all reported jobs succeed.
Missing or malformed contents return `CI_WORKFLOW_TRUST_UNAVAILABLE`.

A pull request that intentionally changes the canonical workflow or gate
program must be a dedicated governance change. It cannot receive an automated
exception from its own branch. Eligibility, allowed blocker codes, the review
envelope, standing authorization, and human gates for the current pull request
must be read from the clean live-base copy of this document, never from the
reviewed head. Changes to this policy in the head take effect only after merge
and only for later pull requests. Before such a change can be considered:

1. keep unrelated application changes out of the pull request;
2. inspect the exact workflow diff and the commands behind every required job;
3. run the trusted-base checker and confirm all non-governance blockers are
   cleared;
4. record an independent current-head review that explicitly accepts the
   workflow or gate-program change using the closed exception envelope below;
5. confirm the checker reports only those independently accepted governance
   blockers and that its blocker-code set exactly equals the envelope's
   accepted set. Extra, missing, duplicated, malformed, or free-text-only
   blocker acceptance is ineligible. `GATE_PROGRAM_BOOTSTRAP_REQUIRED` is not
   eligible because the live base has no trusted checker to execute;
6. merge one qualifying governance pull request under this repository's
   standing authorization without separate owner approval;
7. after merge, update a clean target-branch checkout and verify that the new
   trusted checker and workflow are the live base copies.

The successful Actions run on the workflow-changing pull request is
supplementary evidence only. It cannot prove its own workflow definition.
There is no CLI flag, environment variable, review marker, or fixture field
that turns `CI_WORKFLOW_CHANGED` or `GATE_PROGRAM_CHANGED` into `READY`.

The independent review must contain the normal six-field Agent review envelope
and append exactly these two standalone fields:

```text
Governance-Exception: ACCEPTED
Accepted-Governance-Blockers: <sorted comma-separated blocker codes>
```

The second field is a set encoded in ascending byte order with no spaces. Its
only permitted members are `CI_WORKFLOW_CHANGED` and
`GATE_PROGRAM_CHANGED`; it must be non-empty and exactly equal the trusted
live-base checker's complete blocker-code set. The only valid serialized values
are therefore `CI_WORKFLOW_CHANGED`, `GATE_PROGRAM_CHANGED`, or
`CI_WORKFLOW_CHANGED,GATE_PROGRAM_CHANGED`. The same review already binds the
exact head/base through the normal envelope. Free text, an ordinary
`Agent-Review: PASS`, an extra code, or a subset/superset does not activate the
governance exception.

Because repository settings do not enforce this policy, the Agent must run the
checker again immediately before the merge decision. Any new commit, review,
thread change, rerun, or other relevant GitHub state change invalidates the old
result. A fresh exact-head/base `READY` result activates the qualified automatic
merge authorization above. For a dedicated workflow or gate-program change,
the fully satisfied workflow-governance path activates the same standing
authorization even though the checker remains non-`READY`; any other result or
unaccepted blocker does not authorize a merge.

The incident tracked by #21 remains historical evidence only. Its post-event CI
run can never satisfy this gate for a different current head.

Offline behavior can be verified without GitHub access:

```powershell
npm run governance:check-pr -- --fixture tests/fixtures/merge-gate/ready-high-risk.json
```

A real pull request drill still requires working GitHub authentication. Verify
at least: both current-head/current-base PR jobs passing, old-head success
rejected, push-only success rejected, stale-base success rejected, Draft
rejected, unresolved thread and active change request rejected, old-head
review rejected, arbitrary `COMMENTED` rejected, and a current-head Agent
`COMMENTED` with `Agent-Review: PASS` or `APPROVED` signal accepted for a
high-risk PR.

Review decisions are scoped to the current head. A later decision submitted on
an older commit cannot clear a current-head `CHANGES_REQUESTED`; only a later
current-head `APPROVED`, exact `Agent-Review: PASS`, or dismissed decision from
the same reviewer can replace it.
