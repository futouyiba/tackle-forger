# CI and branch protection

Continuous integration (CI) is the practice of automatically validating every candidate change. GitHub Actions is a platform that can run CI. A workflow is its YAML definition; a runner executes it; a status check reports the result on a commit or pull request.

Before creating `.github/workflows/ci.yml`:

- determine the package manager and lockfile;
- use commands already established by the repository or confirmed by the user;
- trigger on `pull_request` and optionally pushes to the default branch;
- give required jobs stable names;
- use least-privilege permissions;
- exclude deployment, publishing, and secret-dependent work from basic CI.

Do not invent commands. For Unity or another specialized stack, reuse the repository's existing batch or test-runner setup.

After the workflow succeeds at least once, configure a branch ruleset or protection rule:

1. require a pull request;
2. require the stable CI check;
3. require an appropriate number of approvals;
4. block force pushes and default-branch deletion;
5. decide explicitly whether administrators and automation may bypass.

Do not enable every setting automatically. Signed commits, linear history, merge queues, stale-approval dismissal, and deployment gates are project policy choices.

For managed mode, decide separately whether qualifying low-risk PRs may use GitHub auto-merge or a merge queue. Record that standing policy in repository `AGENTS.md` (Codex/ChatGPT) or `CLAUDE.md` (Claude Code); installing the skill or enabling CI alone never authorizes automatic merge. Keep high-risk paths and labels outside unattended merge.
