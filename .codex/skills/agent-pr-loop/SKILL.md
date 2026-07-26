---
name: agent-pr-loop
description: Orchestrate one GitHub pull request through comments, review-tier-aware independent Agent review, current-head CI, batched repair, integration evidence, and safe merge readback when a merge is performed. Use when the user explicitly names agent-pr-loop or $agent-pr-loop, or says “搞定 PR”, “搞定这个 PR”, “搞定当前 PR”, “把这个 PR 完成/收尾/处理掉”, “把当前 PR 跑完”, “审完修完这个 PR”, “处理 PR 的评论/review/CI”, “复审后合并”, or “合并收尾”, especially when Codex should infer the active PR instead of requiring its number.
---

<!-- workflow-contract-policy-ref/v2: .codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json -->

Use `$agent-project-bootstrap` in daily-flow mode for work selection and repository coordination. Keep GitHub as the current-state source of truth and obey repository instructions and canonical specifications.

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

## Run the adaptive review loop

The primary Agent is the coordinator and sole integrator. Load review boundaries, receipt roles, and safety floors from the versioned machine policy referenced above; do not reconstruct its tier matrix from this Skill.

The coordinator selects implementation capacity and, when review is required or chosen, reviewer count, specialization, model, reasoning strength, and sequential or parallel scheduling from task risk, scope, available capabilities, and resources. Never hard-code reviewer count or model. Each implementation role makes only minimal in-scope code and regression-test changes; it must not merge, deploy, publish, delete, commit, push, edit PR metadata, or resolve/reply to review threads unless the coordinator explicitly delegates that action. Each independent reviewer is read-only except for publishing the final substantive GitHub review signal when authorized, and checks its assigned scope against the exact current head/base, linked Issue, canonical specification, merged dependencies, complete PR conversation, concurrency/authorization/history boundaries, and explicit exclusions. Independence means separate task role and fresh reasoning, not a distinct GitHub account. Assume one human owner and one shared GitHub identity unless repository policy says otherwise.

Use Agent messages for fast coordination during the active task. Route disposition-changing conclusions through the coordinator so it can serialize review, repair, push, CI, and re-review against the correct head. Direct implementation/reviewer clarification is allowed, but it never replaces coordinator awareness or durable evidence. Treat GitHub as the cross-session mailbox and source of truth.

Start with parallel read-only triage when safe. For each candidate cycle:

1. Coordinator disposes known findings, assigns one batch of the smallest in-scope fixes, and runs the required local checks.
2. Coordinator reviews the combined diff, commits, pushes the stable candidate head, and verifies `local HEAD == remote PR head == GitHub PR head`.
3. Immediately after that readback, start current-head pull-request CI and every policy-required independent review scope in parallel.
4. Wait for both branches to reach a terminal result. Do not serialize review behind CI or CI behind review.
5. Coordinator performs one combined disposition pass over CI failures, review findings, actionable PR conversation, and thread state. If repair is required, batch compatible fixes into the next candidate instead of pushing one fix per finding.
6. After a changed head is pushed, repeat from step 3 for that exact head/base and re-run every policy-required exact-head review scope.

Never reuse a PASS, approval, CI result, or unresolved-thread disposition after the head or base changes. Preserve historical data, stable identities, and published snapshots. At durable, authorization, publication, and external-write boundaries, fail closed.

When policy requires independent review, after every assigned scope covers the exact current head/base and the coordinator disposes all findings, emit exactly one integrated substantive review signal. Use the complete envelope and eligibility rules defined only in `.github/merge-gates.md`; do not duplicate them here. Include reviewed scope, validation inspected, findings, comment dispositions, and residual risks when applicable.

## Integration evidence

Evaluate integration evidence for one exact head/base pair against `.github/merge-gates.md`, the referenced machine policy, and the complete PR conversation. That merge-gates document is the sole human-readable authority for review-signal format and merge eligibility.

Pause and request the missing human decision only for unresolved product or scope semantics; destructive data, security, authorization, secret, billing, legal, or compliance choices; merge-triggered external side effects; unavailable required validation; ambiguous dependency order; a required second GitHub identity; exhausted retries; or an untrustworthy exact-head result. Do not label ordinary code quality, a completed Agent review, or a generic desire for caution as a human gate.

## Publish and verify a merge

Repository policy decides whether the Agent merges or hands off a PR. In this repository, a trusted live `READY` result for the exact current head/base activates qualified auto-merge standing authorization when no recorded human gate applies. The coordinator must then merge one qualifying PR without requesting a separate per-turn user instruction. Use GitHub PR merge, repository auto-merge, or its merge queue as the applicable transport. Immediately before merging, refresh GitHub and re-check the exact head/base, current-run gates, discussions, dependencies, and side effects.

After GitHub reports success:

1. Read back the PR state and merge result SHA.
2. Verify the remote base contains that result and verify the linked Issue state.
3. Fetch remote refs when local synchronization is useful.
4. Update a local base branch only by a safe fast-forward in a clean, available worktree; local synchronization is optional and does not determine remote merge success.

Do not push the PR head after merge. Do not push a stale local base after a server-side merge. Never use `git push --all`, `git push --mirror`, a post-merge force-push, or a bulk tag push as PR cleanup. A new post-merge code change requires a new branch and PR.

If repository policy explicitly selects local integration, treat `local merge + explicit base ref push + readback` as one separate merge transport. The merge is not complete until that exact base push succeeds and is verified. Never reinterpret a local merge as permission to publish other branches.

Never deploy, publish, release, delete a branch, or expand scope merely because integration evidence is complete.
