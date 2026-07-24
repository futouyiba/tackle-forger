# Adopting an existing project

Use a progressive cutover:

1. Audit current task documents, Issues, branches, CI, templates, and releases without writing.
2. Record a dated cutover. Keep old task sources as read-only history.
3. Migrate only active work that still requires execution, preserving links or legacy identifiers.
4. Pilot on 3–10 real issues and one area of the project.
5. Add CI using already working local commands.
6. Observe several successful pull requests before making CI and approvals mandatory.
7. Remove duplicate live status from old boards and documents.
8. Enable managed mode only after several real PRs prove that review, CI, branch rules, and escalation boundaries are reliable. Start with `per_turn` merge policy before considering qualified auto-merge.

Do not rewrite Git history, delete historical records, or impose a complex Project schema during the pilot. If the rollout fails, relax the new protection rules and simplify fields; preserve the Issues and PRs as useful history.
