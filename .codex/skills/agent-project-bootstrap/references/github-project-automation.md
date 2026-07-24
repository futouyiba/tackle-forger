# GitHub Project automation

## Capability is not configuration

Installing a GitHub connector gives the agent tools. Installing this skill gives it operating rules. Neither action creates or configures a GitHub Project for a repository. Bootstrap must inspect and configure each Project separately, with authorization.

## Recommended division of responsibility

- The agent interprets natural language, finds or proposes the right Issue, detects ambiguity, implements work, and summarizes evidence.
- GitHub's deterministic workflows add matching Issues to a Project, set intake status, and close predictable lifecycle transitions.
- CI tests code. Branch rules use CI and review results as merge gates.
- A managed supervisor interprets review and CI results and performs the next authorized semantic action. It does not replace GitHub's deterministic workflows.

## Minimal Project

Use one status field with `Backlog`, `Ready`, `In progress`, `Blocked`, `In review`, and `Done`. Add only decision-driving fields such as Priority, Area, Size, or Risk.

A Project can contain Issues, pull requests, and draft items. `Backlog` means uncommitted candidate work; it does not mean bug, requirement, or high priority. Draft items are useful for uncertain ideas that should not yet become repository Issues.

## Built-in workflow checklist

In the Project, open the menu and choose **Workflows**. Configure, when available:

1. **Auto-add to project** for Issues in the intended repository. Do not auto-add PRs by default.
2. **Item added to project** → set Status to `Backlog` only for Issue or draft intake.
3. **Issue closed** → set Status to `Done`.
4. Keep the linked PR outside the Project by default. If the team intentionally tracks both Issue and PR items, add the PR at `In review` rather than `Backlog`, and configure **Pull request merged** → `Done`.

GitHub plan limits and available triggers can differ. Verify the saved workflow and run one real Issue/PR through it. Transitions such as `In progress` and `In review` normally remain agent actions unless a repository-specific Action or API integration is deliberately added.

Codex recurring Automations are scheduled supervisor heartbeats, not Project workflows or GitHub webhooks. Codex automatic review writes review findings to PRs; Claude Code users rely on external review tooling or the GitHub Agentic Workflows reviewer. GitHub auto-merge or a merge queue performs the final merge only after branch requirements pass. Keep these responsibilities separate so a failure has one observable owner.

## Recording the result

Store the Project URL, exact status spelling, and any pending automation in repository `AGENTS.md` (Codex/ChatGPT) or `CLAUDE.md` (Claude Code) and `.codex/agent-project-bootstrap.yml`. Do not put these repository-specific values in the user's global instruction file.
