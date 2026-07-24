---
name: agent-issue-loop
description: Complete one selected GitHub Issue through readiness analysis, implementation, validation, pull-request creation, adversarial review and repair, automatic merge, and verified Issue closure. Use when the user says 开始做这个 Issue, 解决这个 Issue, 搞定 Issue, 把当前 Issue 跑完, explicitly invokes agent-issue-loop, or asks for one Issue to be delivered end to end.
---

# Agent Issue Loop

Complete one delivery Issue without making the user relay routine state between Agents. Keep one primary coordinator from Issue selection through verified closure. Use `$agent-project-bootstrap` for repository policy and work discovery, and hand the resulting single PR to `$agent-pr-loop` without creating a nested coordinator.

## Establish authority and scope

1. Read the repository instructions, bootstrap marker or equivalent policy, and canonical specifications before changing code.
2. Resolve exactly one open Issue. If the request names no number, use `$agent-project-bootstrap` to find one clear match; shortlist ambiguous matches instead of guessing.
3. Record the current integration-base revision and refresh GitHub before any external write or irreversible decision.
4. Treat the Issue as mutable task state, not as permission to expand its scope.

Default to one delivery Issue and one primary PR. If the Issue contains independently mergeable work, split it into linked child Issues and an explicit dependency order before implementation. Use stacked PRs only when repository policy explicitly supports them. Do not hide unrelated work in the primary PR.

## Use one coordinator and distinct execution roles

The invoking main Agent remains the only coordinator. A transition into `$agent-pr-loop` is a workflow handoff, not permission to spawn a second coordinator or ask the user to carry messages.

- Use one implementation Agent for code, tests, and fixes when multi-Agent execution is available. Follow repository-specific model requirements.
- Use an independent review Agent only when the PR exists. `$agent-pr-loop` owns that reviewer, the repair loop, current-head evidence, CI, and merge.
- Let the coordinator repair routine labels, links, and Project status idempotently. Do not return work to the implementer only for metadata.
- Prefer direct Agent messaging during an active task. Persist durable decisions, findings, evidence, and resumable state on the Issue or PR so another run can recover without chat history.

## Run the Issue state machine

Advance only after verifying each transition:

`ISSUE_SELECTED → ISSUE_READINESS → IMPLEMENTATION_PREPARED → IMPLEMENTING → LOCAL_VALIDATION → PR_PREPARED → PR_OPEN → PR_LOOP_ACTIVE → MERGED_VERIFIED → ISSUE_COMPLETION_VERIFIED → DONE`

Use explicit exception states when normal progress is unsafe:

- `HUMAN_DECISION_REQUIRED`
- `DEPENDENCY_BLOCKED`
- `SPLIT_REQUIRED`
- `SCOPE_CHANGED`
- `BASELINE_CHANGED`
- `VALIDATION_BLOCKED`
- `REVIEW_REWORK`
- `CI_REWORK`
- `EXTERNAL_APPROVAL_REQUIRED`
- `RETRY_EXHAUSTED`

Infer the current state from fresh GitHub and Git evidence when resuming. Never rely on an earlier conversation label when the branch, PR, checks, merge, or Issue state says otherwise.

## Prove Issue readiness

Before implementation, establish:

- a unique selected Issue and canonical authority;
- testable acceptance criteria and explicit exclusions;
- dependencies, conflicts, and merge order;
- data, migration, history, compatibility, authorization, and external-side-effect risks;
- required normal, boundary, conflict, recovery, and regression validation;
- any open semantic or business decision.

Pause in `HUMAN_DECISION_REQUIRED` when a missing choice would materially change behavior. Use `SPLIT_REQUIRED` for independently deliverable scopes. Do not turn examples, mock values, or assumptions into durable rules.

## Implement and validate

1. Move eligible work to `In progress`, prepare a dedicated branch from the intended base, and record the base revision.
2. Implement only the accepted scope. Preserve unknown fields, stable identities, historical artifacts, and existing user changes.
3. Run the repository's exact validation commands and report results honestly. Re-run affected evidence after rebasing or conflict resolution.
4. Stop at a real decision or blocked validation; do not pause for ordinary metadata repair or a redundant permission to continue the selected task.

Use `NO_CODE_DELIVERY` only when the Issue is satisfied without a repository artifact. Record the reason, acceptance evidence, and why no PR is required; never use it to bypass required review or validation.

## Prepare the PR handoff

Open one linked, non-draft PR when implementation and scoped validation are complete. Include a durable handoff containing:

- Issue number and scope or acceptance digest;
- exact base branch and base revision;
- canonical sources and acceptance criteria;
- exclusions and follow-up work;
- dependencies and risk surfaces;
- exact local validation commands and results.

Move the linked Issue to `In review` when the PR becomes ready. Then invoke `$agent-pr-loop` for that exact PR. Do not duplicate its review protocol or ask for a separate merge confirmation.

Require `$agent-pr-loop` to return a structured outcome:

- status: `MERGED_VERIFIED`, `HUMAN_GATE`, `EXTERNAL_BLOCKER`, `RETRY_EXHAUSTED`, or `NOT_READY`;
- Issue and PR numbers;
- reviewed head and base SHAs;
- merge commit SHA when merged;
- review and CI evidence;
- unresolved findings or required decisions;
- observed linked-Issue state.

Resume implementation or CI repair only from the returned evidence. Do not treat a stale PASS, comment, or check as applying to a changed head.

## Verify completion after merge

On `MERGED_VERIFIED`:

1. Read back the server-side merge result and exact merge SHA.
2. Verify the merged change covers every acceptance criterion and preserves exclusions.
3. Record or link any genuine follow-up instead of silently expanding the completed Issue.
4. Verify the Issue is closed normally and its Project item is `Done`; repair routine linkage or status drift idempotently.
5. Report the final evidence and enter `DONE`.

A successful loop includes normal Issue closure; do not ask the user for a redundant close confirmation. Closing as `Not planned`, deleting records, deploying, publishing, releasing, destructive migration, secret or billing changes, and scope expansion remain separate human gates unless repository policy explicitly authorizes the exact action.

If the PR merged but completion cannot be verified, stop in `ISSUE_COMPLETION_VERIFIED` with the missing evidence clearly identified. Never claim `DONE` from merge state alone.

## Stop conditions

Escalate once, with evidence and the smallest required decision, when:

- acceptance criteria or scope must change;
- a canonical rule or business choice is unresolved;
- dependency order is ambiguous or the baseline changed materially;
- required validation is unavailable or repeatedly fails for an external reason;
- repository or platform policy requires another identity or approval;
- merge triggers deployment, publication, destructive behavior, or another recorded human gate;
- the configured retry limit is exhausted.

Do not stop merely because the user has not manually approved a routine implementation, review repair, qualifying exact-head merge, or normal Issue closure.
