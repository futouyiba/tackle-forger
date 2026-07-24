# Managed autopilot

## Purpose

Use one durable supervisor to move a bounded goal through GitHub without making the user relay messages between implementation, review, CI, and merge conversations. GitHub stores facts; the supervisor interprets them and chooses the next safe action.

Managed mode is an extension of daily flow, not a separate task database and not unlimited authorization.

Use `supervised` when the heartbeat may continue routine work but merge still needs a per-turn decision. Use `autonomous` only for repositories that explicitly allow `qualified_auto_merge`; human gates and prohibited actions still apply. `off` disables the supervisor.

## Required repository policy

Before enabling managed mode, record these values in root `AGENTS.md` (Codex/ChatGPT) or `CLAUDE.md` (Claude Code) and `.codex/agent-project-bootstrap.yml`:

- enabled state and goal or Issue scope;
- supervisor type, normally a recurring thread Automation;
- heartbeat schedule and whether the local client must remain available;
- retry limit, default `3` fix-review-CI cycles;
- automatic review state;
- merge policy: `per_turn`, `qualified_auto_merge`, or `manual`;
- low-risk merge criteria and high-risk paths or labels;
- human gates;
- deployment and publishing policy, default `never`.

Use `pending` with a reason when a capability cannot be configured. Do not claim that installing the skill creates an Automation, enables Codex review, changes a ruleset, or stores an API key.

## One supervisor, several services

Assign each responsibility once:

- **Supervisor Automation**: refresh state, choose the next eligible action, implement, address review comments, repair CI, re-request review, and escalate once. This may be a local Codex heartbeat or an explicitly configured GitHub Agentic Workflows supervisor, but never both for the same scope.
- **GitHub Issues and PRs**: hold scope, dependencies, decisions, review threads, and evidence.
- **GitHub Project workflows**: perform deterministic intake and status transitions.
- **CI / required checks**: provide repeatable validation gates.
- **Codex automatic review**: place semantic review findings directly on the PR.
- **GitHub auto-merge or merge queue**: merge only after repository rules are satisfied and standing policy authorizes it.

Do not start duplicate work when an Issue already has an active branch or PR. Do not use multiple recurring supervisors for the same repository scope.

## Heartbeat procedure

On every scheduled wake-up:

1. Read repository policy and refresh current GitHub state.
2. Restrict work to the configured goal, Issues, and dependency order.
3. Resume an active PR before selecting new `Ready` work.
4. If actionable review feedback exists, address it on the same branch, validate, push, reply with evidence, and re-request review when supported.
5. If required CI fails, diagnose and repair it within scope. Count a cycle only after a new attempted fix receives a new review or CI result.
6. If the PR qualifies and merge policy is `qualified_auto_merge`, enable auto-merge or enter the merge queue. Refresh after merge before selecting dependent work.
7. If no action is available, finish the heartbeat quietly; do not ask the user to relay status.
8. If a human gate is reached or the retry limit is exhausted, record one concise blocker on the Issue or PR and notify the user once with the decision needed.

Do not infer success from old comments or stale checks. Do not resolve substantive review threads merely because code changed; verify the concern and follow repository review policy.

## Default human gates

Escalate for:

- competing product interpretations or acceptance-criteria changes;
- scope expansion or a newly discovered independent feature;
- authentication, authorization, payments, secrets, privacy, security boundaries, destructive data migration, or irreversible operations;
- public API or compatibility breaks not already accepted;
- deployment, publishing, releases, or meaningful external cost;
- merge conflicts whose correct resolution changes behavior;
- the configured retry limit, repeated infrastructure failure, or unavailable required reviewer;
- any action not covered by repository standing authorization.

Do not escalate routine branch creation, PR creation, review-fix iterations, test reruns, status updates, or re-review requests for a clearly selected task.

## Merge policy

Default to `per_turn` for migrated repositories. Offer `qualified_auto_merge` only after CI and review have run successfully on real PRs and branch rules are established.

For `qualified_auto_merge`, require all of the following:

- non-draft PR linked to an in-scope Issue;
- acceptance criteria satisfied with current evidence;
- all required checks successful on the current head;
- required approval or repository-approved review signal present;
- no unresolved actionable review thread;
- no conflict and dependencies already merged;
- no configured high-risk path or label;
- repository merge method and rules respected.

This policy never implies deployment or publishing.

## Automation setup

When the Codex client exposes Automations, use [the managed supervisor prompt](../assets/codex-managed-supervisor.md) as the instruction body and attach it to the supervisor task. Ask once for the cadence if repository policy does not define it. Prefer 15–30 minutes for active delivery and a slower schedule for maintenance. Claude Code has no built-in recurring Automation; drive the same supervisor prompt from an external scheduler, or use the GitHub Agentic Workflows profile instead.

Scheduled heartbeats are not GitHub webhooks. Local heartbeats may also require the desktop client to remain available. If true event-driven execution is required, read [GitHub Agentic Workflows](github-agentic-workflows.md) and offer its staged profile. It compiles Markdown agent workflows into GitHub Actions and can use Codex or another supported engine. Require a separate security review before adding an API key or live safe outputs. Validate trusted actors, untrusted PR content, prompt-injection exposure, workflow permissions, generated lock files, concurrency, and cost limits. Do not enable write-capable event automation by default.
