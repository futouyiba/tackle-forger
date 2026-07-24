---
name: agent-pr-loop
description: Orchestrate one GitHub pull request through all comments and review findings, minimal implementation, independent Agent review, current-head CI, and automatic merge when every gate passes, pausing only at explicit human gates. Use when the user explicitly names agent-pr-loop or $agent-pr-loop, or says “搞定 PR”, “搞定这个 PR”, “搞定当前 PR”, “把这个 PR 完成/收尾/处理掉”, “把当前 PR 跑完”, “审完修完这个 PR”, “处理 PR 的评论/review/CI”, “复审后合并”, or “合并收尾”, especially when Codex should infer the active PR instead of requiring its number.
---

Use `$agent-project-bootstrap` in daily-flow mode for work selection and repository coordination. This Skill's automatic-merge policy replaces that Skill's generic current-turn merge-confirmation rule for one selected PR; explicit repository human gates and the user's current-turn no-merge instruction still win. Keep GitHub as the current-state source of truth and obey repository instructions and canonical specifications.

## Select the PR

Resolve exactly one PR in this order:

1. Use an explicit PR number or URL when given.
2. Otherwise, query the PR for the checked-out branch in the current repository.
3. Otherwise, use the sole open PR explicitly linked to the current Issue or recent task context.
4. If more than one candidate remains, show at most three candidates and ask the user to choose. Do not guess.

Refresh GitHub before every external write and immediately before a merge decision. Record head/base SHA, linked Issue, mergeability, top-level PR comments, review bodies and states, inline review comments, unresolved discussions, relevant bot comments, required CI, branch protection, dependencies, and whether merging triggers deployment, publishing, release, or another external side effect.

## Read the complete PR conversation

Inspect every feedback surface available from GitHub: top-level comments, submitted reviews, inline discussions, unresolved conversations, and relevant bot, CI, security, or policy comments.

Classify each item as actionable-current, verified-resolved, obsolete-after-new-head, informational, or non-actionable. Bind actionable findings and their dispositions to the relevant head SHA. Any actionable-current comment blocks PASS and merge even when another review is `APPROVED` or says PASS. A formal approval never erases a comment. Do not block on informational or obsolete comments merely because they exist.

Reply with the verified disposition and evidence when useful. Resolve an inline thread only after the code fix and regression evidence are present. Give top-level actionable comments an equally durable disposition.

## Run the two-role loop

The primary Agent is the coordinator and sole integrator. Use no more than one active implementation Agent and one active independent review Agent at once.

- Spawn the implementation Agent with `gpt-5.6-terra` and `medium` reasoning. It makes only minimal code and regression-test changes. It must not merge, deploy, publish, delete, commit, push, edit PR metadata, or resolve/reply to review threads unless the coordinator explicitly delegates that action.
- Spawn the independent review Agent with `gpt-5.6-sol` and `low` reasoning. It is read-only except for publishing its final substantive GitHub review signal when authorized. It checks the exact current head against the linked Issue, canonical specification, merged dependencies, the complete PR conversation, concurrency/authorization/history boundaries, and explicit scope exclusions. Independence means separate task role and fresh reasoning, not a distinct GitHub account. Assume one human owner and one shared GitHub identity unless repository policy says otherwise.

Use Agent messages for fast coordination during the active task. Route disposition-changing conclusions through the coordinator so it can serialize review, repair, push, CI, and re-review against the correct head. Direct implementation/reviewer clarification is allowed, but it never replaces coordinator awareness or durable evidence. Treat GitHub as the cross-session mailbox and source of truth.

Start with parallel read-only triage when safe. Once a defect is found, serialize the cycle:

1. Reviewer reports severity-ranked findings bound to the current SHA.
2. Implementation Agent makes the smallest in-scope fix and tests it.
3. Coordinator reviews the diff, runs repository-required full gates, commits, and pushes only the exact PR head.
4. Coordinator reads back and verifies `local HEAD == remote PR head == GitHub PR head`.
5. Wait for current-head pull-request CI.
6. Reviewer performs an incremental review of that exact new head.

Never reuse a PASS, approval, CI result, or unresolved-thread disposition after the head or base changes. Preserve historical data, stable identities, and published snapshots. At durable, authorization, publication, and external-write boundaries, fail closed.

The final substantive review signal must be a submitted COMMENT review or repository-approved equivalent containing:

```text
Agent-Review-Version: v1
Reviewer-Role: independent-review-agent
Head-SHA: <full SHA>
Base-SHA: <full SHA>
Verdict: PASS
Agent-Review: PASS
```

Include reviewed scope, validation inspected, findings, comment dispositions, and residual risks when applicable. Never emit PASS while an actionable finding remains anywhere in the PR conversation. In a single-owner, shared-account workflow, publish the COMMENT as durable Agent-review evidence rather than pretending it is a GitHub Approval. Require another GitHub identity only when repository or platform policy explicitly does.

## Ready and merge gates

Declare the PR ready and merge it automatically only when one exact head/base pair has all of:

- synchronized latest intended integration base and clean worktree;
- complete repository-required local validation with exact results;
- every required pull-request CI job successful on its current run/attempt;
- no unresolved actionable top-level comment, review body finding, inline comment, discussion, or relevant bot finding;
- a substantive independent review bound to that exact head/base pair containing the required structured fields and exact line `Agent-Review: PASS`;
- open, non-draft, mergeable PR plus any actually configured branch-protection approvals.

Automatic merge is the normal completion path; do not ask for redundant confirmation after the review/fix/CI loop has supplied all merge information. The user may override this for the current turn by saying “只审不合并”, “不要合并”, or equivalent.

Pause and request the missing human decision only for unresolved product or scope semantics; destructive data, security, authorization, secret, billing, legal, or compliance choices; merge-triggered external side effects; unavailable required validation; ambiguous dependency order; a required second GitHub identity; exhausted retries; or an untrustworthy exact-head result. Do not label ordinary code quality, a completed Agent review, or a generic desire for caution as a human gate.

## Publish and verify the merge

Use GitHub PR merge, repository auto-merge, or its merge queue as the default merge transport. Immediately before merging, refresh GitHub and re-check the exact head/base, current-run gates, discussions, dependencies, and side effects. Respect the repository merge method and merge one qualifying PR only.

After GitHub reports success:

1. Read back the PR state and merge result SHA.
2. Verify the remote base contains that result and verify the linked Issue state.
3. Fetch remote refs when local synchronization is useful.
4. Update a local base branch only by a safe fast-forward in a clean, available worktree; local synchronization is optional and does not determine remote merge success.

Do not push the PR head after merge. Do not push a stale local base after a server-side merge. Never use `git push --all`, `git push --mirror`, a post-merge force-push, or a bulk tag push as PR cleanup. A new post-merge code change requires a new branch and PR.

If repository policy explicitly selects local integration, treat `local merge + explicit base ref push + readback` as one separate merge transport. The merge is not complete until that exact base push succeeds and is verified. Never reinterpret a local merge as permission to publish other branches.

Never deploy, publish, release, delete a branch, or expand scope merely because merge is automatic.
