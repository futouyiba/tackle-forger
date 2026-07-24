---
name: tackle-agent-workflow
description: Orchestrate Tackle Forger implementation, fixes, and refactors through a scoped coding subagent and an independent read-only review subagent, including validation evidence and bounded rework. Use for repository changes that include writing code, changing tests, fixing defects, or refactoring, and when the user asks to start implementation, use the project agent workflow, or run an independent implementation review.
---

# Run the Tackle Agent Workflow

## Establish the task

1. Read `docs/README.md` and `docs/tackle-forger-development-spec-v3.md` completely before implementation or review.
2. Identify the canonical specification, acceptance criteria, affected authority layer, unresolved decisions, historical-data impact, external side effects, and applicable validation.
3. Stop for user confirmation when the specification marks required semantics as unresolved. Do not ask merely to avoid making a safe implementation assumption.
4. Record the implementation base revision and inspect existing uncommitted changes. Preserve unrelated user work.

## Dispatch the coding agent

Create one concrete coding subagent with:

- model: `gpt-5.6-terra`
- reasoning effort: `medium`
- context inheritance: a bounded positive `fork_turns` value or `none`; never `all` when overriding the model
- responsibility: implement the scoped change, add or update tests, run proportionate validation, and report exact files and commands
- authority: no merge, publish, deploy, deletion, scope expansion, or unrelated cleanup

Give the agent the task-local acceptance criteria, canonical document paths, relevant repository state, and explicit file ownership. Reuse the same coding agent for review-driven rework so it retains implementation context.

The main agent may perform read-only coordination while the coding agent runs. Do not create an idle agent or split tightly coupled changes merely to increase parallelism.

## Close the visual feedback loop when the change is user-visible

For a change that affects a screen, visual state, interaction, rendered document, or other user-visible output, completion requires an observed visual loop in addition to code and automated checks:

1. Run or render the actual artifact in representative states and the relevant viewport sizes. Include the changed path and applicable loading, empty, error, responsive, and populated states.
2. Capture screenshots or a recording, then have the responsible Agent actually inspect those artifacts. Do not treat their existence as proof that they were reviewed.
3. Look for obvious layout, hierarchy, spacing, overflow, clipping/truncation, contrast, content-density, responsive, and state-transition defects against the canonical UI contract.
4. Fix discovered defects, render again, and inspect the new evidence. Repeat until no actionable visual defect remains.
5. Record the states, viewports, artifact locations or links, observations, fixes, and recheck result in the handoff or PR.

Source review, DOM assertions, snapshots, and automated tests are valuable but do not substitute for observing the rendered output. Do not introduce product semantics during visual polish: v3 remains authoritative. For a non-user-visible change, explicitly mark the visual loop not applicable. If the environment genuinely cannot render the artifact, report visual validation as incomplete and do not claim the user interface is complete.

## Verify implementation evidence

After the coding agent reports completion:

1. Inspect the actual diff and repository state; do not accept a summary as evidence.
2. Confirm the implementation still matches the canonical specification.
3. Run or independently verify the scoped validation where risk warrants it.
4. For user-visible changes, inspect the captured rendered evidence yourself and confirm the visual loop includes the relevant states and viewports. Code review, DOM assertions, and automated tests alone are insufficient.
5. Capture exact commands, outcomes, intentionally unrun checks, and the current head/base relationship.

## Dispatch the independent reviewer

Create a different review subagent with:

- model: `gpt-5.6-sol`
- reasoning effort: `low`
- context inheritance: a bounded positive `fork_turns` value or `none`; never `all` when overriding the model
- responsibility: review the actual diff and validation evidence against the canonical specification, repository instructions, regressions, historical freeze, authorization, and recovery requirements; for user-visible changes, inspect real rendered evidence rather than reviewing source alone
- authority: read-only by default; do not edit files, merge, publish, or deploy

Pass raw artifacts and task-local requirements, not the main agent's intended conclusion. Require findings to include severity, file and line, evidence, and a concrete remediation. Require an explicit `PASS` when no actionable finding remains.

For user-visible changes, pass the reviewer the states, viewports, screenshots or recording, and implementer's observations. The reviewer must inspect those artifacts and call out missing visual coverage or visible defects. When the affected artifact could not be rendered, report visual validation as incomplete and withhold `PASS`; do not turn a clearly labeled evidence gap into a successful review. For a non-user-visible change, record why this requirement is not applicable.

## Resolve review

Classify every reviewer item:

- Actionable defect, unmet acceptance criterion, regression, conflict, or evidence gap: send it to the same coding agent for correction.
- Metadata-only lag within the main agent's authority: reconcile it without returning implementation.
- Informational, obsolete, or disproven: record the evidence and do not create churn.
- Requires new product semantics, external authority, or scope expansion: stop and ask the user.

After corrections, rerun affected validation and ask the same independent reviewer to review the new current diff. Continue until `PASS`, a user decision is required, or no safe in-scope progress remains.

## Complete the handoff

The main agent owns the final decision and report. Include:

- changed files and implemented outcome;
- reviewer result and any resolved findings;
- exact validation commands and results;
- intentionally unrun checks and remaining risks;
- base revision and whether evidence was rerun after any rebase or merge.

Do not treat review completion as merge authorization. Follow repository policy for GitHub, merge, publication, deployment, deletion, and other external side effects.
