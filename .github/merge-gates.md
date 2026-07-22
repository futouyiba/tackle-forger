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
owner's GitHub identity may therefore serve as the traceable review signal.
`COMMENTED` is not an endorsement by itself: unresolved threads and an active
`CHANGES_REQUESTED` still block, and the supervising Agent must inspect the
review contents and acceptance evidence. Never describe an Agent review as a
human GitHub `APPROVED` review. Human approval is required only when GitHub
rules or an explicit owner decision separately requires it.

Before recommending or performing a merge, the supervising Agent must classify
the change as `normal` or `high` risk and run the read-only checker against the
live pull request:

```powershell
npm run governance:check-pr -- --repo futouyiba/tackle-forger --pr <number> --risk <normal|high>
```

The command reads the pull request around two complete evidence queries. It
compares normalized CI, review, and review-thread fingerprints and retries if
either the PR identity or any gate evidence changes. After three unstable
attempts it fails closed. It then evaluates only evidence bound to the reported
current head SHA:

- the PR is not Draft;
- `Root v3 app (npm)`, `Historical workspace (pnpm)`, and
  `Windows line-ending policy` are present, explicitly owned by the
  `github-actions` app, and successful on that head;
- no review thread remains unresolved and no active current-head
  `CHANGES_REQUESTED` review remains;
- a high-risk change has a current-head review signal (`COMMENTED` or
  `APPROVED`) with a GitHub actor identity. Actor type and equality with the PR
  author do not decide validity in this single-owner, multi-Agent repository.
  A later `CHANGES_REQUESTED` or dismissed review invalidates earlier evidence
  from that reviewer until a fresh current-head signal is recorded.

Missing, pending, failed, cancelled, skipped, or old-head CI blocks. The checker
uses the monotonic GitHub check-run ID to select the latest same-name run, so a
new queued rerun supersedes an older completed success even before the rerun has
timestamps. It prints a stable blocker code for every unmet condition and exits
`1`; API or authentication failures exit `2`. `--json` provides
machine-readable output. Malformed pagination evidence also fails closed as an
API error; a connection that declares another page must supply a non-empty
cursor.

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
at least: all three current-head jobs passing, old-head success rejected,
Draft rejected, unresolved thread and active change request rejected, old-head
review rejected, and a current-head Agent `COMMENTED` or `APPROVED` signal
accepted for a high-risk PR.
