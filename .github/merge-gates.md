# Agent pull request merge gate

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
  current head, the repository-approved review signal is current, review
  findings and threads are settled, dependencies and the base are current, and
  the user has authorized the merge.

Do not require this merge checker to pass before removing Draft. The checker
intentionally rejects Draft pull requests, while a high-risk review signal is
normally collected after formal review begins. Requiring both in the opposite
order creates a circular blocker. The correct high-risk sequence is:

```text
complete implementation and scoped validation
→ remove Draft and enter formal review
→ record a current-head review signal and settle its findings
→ run the live merge checker
→ obtain explicit merge authorization
```

Classify blockers before changing ownership: implementation or acceptance
defects return to implementation; evidence gaps require collection or reruns;
metadata lag is reconciled by an authorized observer; an externally required
approval blocks merge without making the code defective; dependency or base
changes require a sync and fresh current-head CI. Never return work to an
implementer solely to change Draft or Issue status.

This repository has one accountable owner coordinating several Agents. A
current-head `COMMENTED` review, a Bot review, or a review submitted through the
owner's GitHub identity may therefore serve as the traceable review signal. A
`COMMENTED` review counts only when its body contains this exact standalone
line:

```text
Agent-Review: PASS
```

An arbitrary comment or a review that only reports findings does not count.
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

The command reads the pull request around two complete evidence queries. It
compares normalized CI, review, and review-thread fingerprints and retries if
either the PR identity or any gate evidence changes. After three unstable
attempts it fails closed. It then evaluates only evidence bound to the reported
current head SHA, pull request number, and current base SHA:

- the PR is not Draft;
- the current head's `.github/workflows/ci.yml` has the same SHA-256 content as
  the file read from the live base SHA;
- `Root v3 app (npm)`, `Historical workspace (pnpm)`, and
  `Windows line-ending policy` are present, explicitly owned by the
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
without the exact provenance format and canonical workflow path fail
closed. The checker selects only the newest canonical workflow run and that
run's current attempt; it never combines jobs from an older run or attempt.
Each required job name must appear exactly once in that attempt, so a missing or
duplicate same-name job blocks instead of falling back or masking a failure. It
prints a stable blocker code for every unmet condition and exits
`1`; API or authentication failures exit `2`. `--json` provides
machine-readable output. Malformed pagination evidence also fails closed as an
API error; a connection that declares another page must supply a non-empty
cursor.

## Workflow governance path

GitHub runs a `pull_request` workflow from the pull request merge context.
Therefore the path, run name, and job display names do not prove that the
trusted commands ran. The checker reads `.github/workflows/ci.yml` at both the
live base SHA and current head SHA and compares the decoded file contents. Any
difference returns `CI_WORKFLOW_CHANGED`, even when all reported jobs succeed.
Missing or malformed contents return `CI_WORKFLOW_TRUST_UNAVAILABLE`.

A pull request that intentionally changes the canonical workflow or gate
program must be a dedicated governance change. It cannot receive an automated
exception from its own branch. Before such a change can be considered:

1. keep unrelated application changes out of the pull request;
2. inspect the exact workflow diff and the commands behind every required job;
3. run the trusted-base checker and confirm all non-governance blockers are
   cleared;
4. record an independent current-head review that explicitly accepts the
   workflow change and identifies `CI_WORKFLOW_CHANGED`;
5. obtain owner merge authorization that explicitly names the governance
   exception;
6. after merge, update a clean target-branch checkout and verify that the new
   trusted checker and workflow are the live base copies.

The successful Actions run on the workflow-changing pull request is
supplementary evidence only. It cannot prove its own workflow definition.
There is no CLI flag, environment variable, review marker, or fixture field
that turns `CI_WORKFLOW_CHANGED` or `GATE_PROGRAM_CHANGED` into `READY`.

### One-time bootstrap for PR #63

PR #63 first introduces both the structured `run-name` and
`scripts/check-pr-merge-gate.mjs`. Its base therefore has neither an identical
workflow nor a trusted gate-program copy. The expected automated blockers are
`CI_WORKFLOW_CHANGED` and `GATE_PROGRAM_BOOTSTRAP_REQUIRED`. This is a single,
named bootstrap case, not a reusable allowlist:

- independently review the exact PR #63 workflow and gate implementation;
- require every other normal blocker, current-head review finding, and thread
  to be cleared;
- record the bootstrap decision and exact reviewed head SHA in the review;
- merge only after explicit owner authorization naming PR #63;
- immediately after merge, run the checker from a clean updated `main`.

No later pull request inherits this bootstrap treatment. A later workflow
change follows the dedicated workflow-governance path above, and a later gate
program change must be evaluated by the trusted program already present on its
live base.

Because repository settings do not enforce this policy, the Agent must run the
checker again immediately before the merge decision. Any new commit, review,
thread change, rerun, or other relevant GitHub state change invalidates the old
result. The checker is evidence, not merge authorization.

The incident tracked by #21 remains historical evidence only. Its post-event CI
run can never satisfy this gate for a different current head.

Offline behavior can be verified without GitHub access:

```powershell
npm run governance:check-pr -- --fixture tests/fixtures/merge-gate/ready-high-risk.json
```

A real pull request drill still requires working GitHub authentication. Verify
at least: all three current-head/current-base PR jobs passing, old-head success
rejected, push-only success rejected, stale-base success rejected, Draft
rejected, unresolved thread and active change request rejected, old-head
review rejected, arbitrary `COMMENTED` rejected, and a current-head Agent
`COMMENTED` with `Agent-Review: PASS` or `APPROVED` signal accepted for a
high-risk PR.

Review decisions are scoped to the current head. A later decision submitted on
an older commit cannot clear a current-head `CHANGES_REQUESTED`; only a later
current-head `APPROVED`, exact `Agent-Review: PASS`, or dismissed decision from
the same reviewer can replace it.
