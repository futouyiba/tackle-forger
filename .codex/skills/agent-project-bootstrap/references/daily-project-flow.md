# Daily GitHub project flow

## Goal

Translate ordinary descriptions into safe GitHub operations. The user should not need to remember Issue numbers, status-transition wording, or a long prompt.

## Intent shortcuts

| User intent | Default interpretation |
|---|---|
| `记一下：…` | Preserve an uncertain idea as a Project draft in Backlog when available. |
| `收需求：…` | Extract and deduplicate candidate Issues, then ask once for any creation not already authorized. |
| `开始做：…` | Find the best existing Issue and delegate its end-to-end delivery to `$agent-issue-loop`. |
| `搞定 Issue` / `agent-issue-loop` | Complete one selected Issue through readiness, implementation, PR review/repair, verified merge, and normal closure. |
| `收尾` | Inspect the current Issue/PR, record evidence, and prepare the gated next step. |
| `合并收尾` | Merge qualifying approved PRs in the current repository, one at a time, without deploying or publishing. |
| `搞定 PR` / `agent-pr-loop` | Delegate one selected PR to `$agent-pr-loop` for complete comments, review/fix/current-head CI, and automatic merge at all-green gates. |
| `托管` | Supervise the current repository and current explicit goal, active Issue, or active PR. |
| `托管：…` | Supervise the supplied goal or scope and escalate only at human gates. |

Natural-language equivalents have the same meaning. These phrases are conveniences, not magic syntax.

For bare `托管`, do not ask the user to restate context that is already clear from the current repository, conversation, active Issue, or active PR. Ask one concise scope question only when several candidates remain plausible. Combine missing cadence and merge-policy choices into the same one-time setup question.

For continuous supervision, read [managed autopilot](managed-autopilot.md). Managed mode reuses this lifecycle and authorization matrix; it does not create a second workflow.

## Finding the Issue

Build a query from product area, outcome, distinctive nouns, labels, assignee, and recent activity. Prefer open Issues in `Ready`, `In progress`, or `Blocked`.

- One high-confidence result: use it and tell the user its number and title.
- Two or three plausible results: show a short shortlist and ask one question.
- No result: distinguish a clear new task from an uncertain idea. Create only when the current request or repository policy authorizes creation.

Do not ask the user to search GitHub or memorize a number when the agent can resolve it.

## Routine lifecycle

1. Read the Issue, acceptance criteria, dependencies, and current Project state.
2. Check whether a dependency or conflicting active branch blocks work.
3. Delegate a selected delivery Issue to `$agent-issue-loop`; it keeps one coordinator from readiness through normal closure.
4. Move `Ready` to `In progress` and create a dedicated branch.
5. Implement only the agreed scope and run repository validation.
6. Open a PR that links the Issue and reports exact evidence.
7. Move the item to `In review` and delegate that exact PR to `$agent-pr-loop`.
8. Verify the server-side merge, acceptance coverage, normal Issue closure, and `Done` status. Ask before deployment or any explicit human gate.

## Authorization matrix

| Action | Clearly selected task | Ambiguous or expanded work |
|---|---:|---:|
| Read/search GitHub | Automatic | Automatic |
| Change Ready to In progress | Automatic | Ask |
| Create task branch | Automatic | Ask |
| Open linked PR | Automatic | Ask |
| Record tests and move to In review | Automatic | Ask |
| Create a clearly requested Issue | Allowed when repository policy says so | Ask once |
| Change scope or acceptance criteria | Ask | Ask |
| Close as Not planned, delete, publish, deploy | Ask | Ask |
| Merge | Ask in generic flow; automatically complete one PR delegated to `$agent-pr-loop` when its exact-head gates pass | Ask |
| Close selected Issue normally | Automatic after `$agent-issue-loop` verifies merge and acceptance | Ask |

The repository may impose stricter rules. A GitHub or execution tool may still request platform approval.

## Complete one Issue

Use the separately installed `$agent-issue-loop` Skill when the user says `开始做这个 Issue`, `解决这个 Issue`, `搞定 Issue`, `把当前 Issue 跑完`, explicitly names that Skill, or asks for one Issue to be delivered end to end. Bootstrap owns repository policy and Issue discovery; `agent-issue-loop` owns the delivery state machine; `$agent-pr-loop` owns the single-PR review, repair, CI, and merge phase.

Keep the invoking main Agent as the sole coordinator. Default to one delivery Issue and one primary PR. Split independently mergeable work into linked child Issues with an explicit dependency order before implementation; use stacked PRs only when repository policy says so.

The Issue loop proves readiness, records the implementation base, implements and validates the accepted scope, opens a linked ready PR, and passes a durable acceptance/risk/validation handoff to `$agent-pr-loop`. It resumes from GitHub and Git evidence rather than chat history. After a `MERGED_VERIFIED` return, it verifies the merge SHA, acceptance coverage, exclusions, normal Issue closure, and Project `Done` state.

Do not ask for redundant confirmation to merge a qualifying delegated PR or close its successfully completed Issue. Pause for scope or acceptance changes, unresolved product decisions, ambiguous dependencies, unavailable required validation, external approval identities, merge-triggered side effects, retry exhaustion, closing as `Not planned`, deployment, publishing, deletion, or destructive work.

## Complete one pull request

Use the separately installed `$agent-pr-loop` Skill when the user says `搞定 PR`, explicitly names that Skill, or asks to run one PR through comments, review, repair, CI, and completion. Bootstrap remains authoritative for work selection and repository policy; `agent-pr-loop` owns the single-PR state machine.

For that one PR, an all-green exact-head review and CI result supplies the normal merge decision. Do not ask for a redundant merge confirmation. Pause only at repository-recorded human gates, missing business decisions, unavailable required validation, ambiguous dependencies, external identity requirements, merge-triggered side effects, exhausted retries, or an explicit current-turn no-merge instruction.

During review and repair, push only the exact PR head and verify its remote SHA. Prefer GitHub server-side PR merge. After merge, read back the result and fetch remote refs when useful; do not push the merged PR head, push a stale local base, or run `git push --all`, `git push --mirror`, a post-merge force-push, or a bulk tag push.

## Batch intake

For `收需求`, first normalize candidate items, search for duplicates, and classify them as existing Issue, clear new Issue, or uncertain idea. Present one compact table and consolidate all required approval into one question. Add clear work to Issues/Project; keep uncertain ideas as Project drafts where supported.

## Integrate approved pull requests

Treat `合并收尾` and the expanded `/prompts:integrate` (Codex) or `/integrate` (Claude Code) shortcut as explicit merge authorization for the current turn only. Limit the operation to the current repository and any scope the user supplied.

1. Fetch current GitHub state; do not decide from a stale local snapshot.
2. Select open, non-draft PRs that have all required approvals.
3. Order them by explicit dependencies, then by the repository's documented priority. Do not guess a dependency when order changes behavior.
4. Before each merge, verify that acceptance criteria are satisfied, required CI is current and successful, no merge conflict exists, and no unresolved review thread remains.
5. Respect branch protection and the repository's merge method. Never bypass a required check or approval.
6. Merge one PR, refresh GitHub state, then evaluate the next PR against the new base.
7. Skip any PR that no longer qualifies and record the exact reason. Stop the batch if a systemic failure makes later decisions unreliable.
8. Report merged and skipped PRs separately, including linked Issues and final checks.

This authorization does not include deployment, publishing, releases, tag deletion, scope expansion, or closing work as `Not planned`. Platform approval prompts still apply.
