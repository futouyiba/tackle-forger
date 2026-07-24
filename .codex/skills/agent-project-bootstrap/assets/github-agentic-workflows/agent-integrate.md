---
on:
  workflow_dispatch:
    inputs:
      item_number:
        description: "Pull request number"
        required: true
        type: string
      item_kind:
        description: "Must be pull_request"
        required: true
        type: choice
        options: [pull_request]
      reason:
        description: "Why merge-readiness should be checked"
        required: true
        type: string
  permissions:
    issues: read
    pull-requests: read
  steps:
    - name: Require exact managed pull request
      id: managed_target
      env:
        ITEM_NUMBER: ${{ github.event.inputs.item_number }}
      run: |
        case "$ITEM_NUMBER" in
          ''|*[!0-9]*) exit 1 ;;
        esac
        gh api "repos/$GITHUB_REPOSITORY/issues/$ITEM_NUMBER" \
          --jq '.pull_request and any(.labels[]?; .name == "agent:managed")' | grep -qx true

if: needs.pre_activation.outputs.managed_target_result == 'success'

run-name: Agent merge-readiness PR #${{ github.event.inputs.item_number }}

permissions:
  actions: read
  checks: read
  contents: read
  issues: read
  pull-requests: read
  statuses: read

engine: __ENGINE__
timeout-minutes: 15
max-ai-credits: 30

concurrency:
  group: gh-aw-agent-integrate-${{ github.event.inputs.item_number }}
  cancel-in-progress: true

jobs:
  managed-target-gate:
    runs-on: ubuntu-latest
    needs: agent
    permissions:
      issues: read
      pull-requests: read
    steps:
      - name: Recheck managed pull request before writes
        env:
          ITEM_NUMBER: ${{ github.event.inputs.item_number }}
        run: |
          case "$ITEM_NUMBER" in
            ''|*[!0-9]*) exit 1 ;;
          esac
          gh api "repos/$GITHUB_REPOSITORY/issues/$ITEM_NUMBER" \
            --jq '.pull_request and any(.labels[]?; .name == "agent:managed")' | grep -qx true

safe-outputs:
  staged: __STAGED__
  needs: [managed-target-gate]
  add-comment:
    target: "${{ github.event.inputs.item_number }}"
    required-labels: [agent:managed]
    max: 1
  add-labels:
    allowed: [agent:merge-ready, agent:needs-rework, needs:human]
    target: "${{ github.event.inputs.item_number }}"
    required-labels: [agent:managed]
    max: 1
  remove-labels:
    allowed: [agent:merge-ready]
    target: "${{ github.event.inputs.item_number }}"
    required-labels: [agent:managed]
    max: 1
---

# Verify merge readiness without merging

Inspect PR `#${{ github.event.inputs.item_number }}` because:
`${{ github.event.inputs.reason }}`.

Re-read the linked Issue and acceptance criteria. Verify the current head is
non-draft, conflict-free, dependency-complete, labeled `agent:managed`, has the
latest `VERDICT: MERGE_READY` review signal, has no unresolved actionable review
thread, and has all required checks successful on the same head SHA. Also apply
the repository's high-risk paths and human-gate policy.

Never call a merge API, enable auto-merge, deploy, publish, delete, or change
scope. If every gate passes, keep `agent:merge-ready` and add one concise comment
with the verified head SHA and evidence. If a routine code or CI correction is
needed, remove `agent:merge-ready` and add `agent:needs-rework`. If a human gate
is reached, remove `agent:merge-ready`, add `needs:human`, and state the
exact decision required.
