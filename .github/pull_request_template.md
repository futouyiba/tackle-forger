## Linked issue

Closes #

## Base and scope

- Base commit:
- In scope:
- Explicitly out of scope:
- Shared contracts touched (`lib/types.ts`, migrations, publishing, v3, API contracts):
- Dependency and merge order:

## What changed and why

<!-- Summarize the implementation and why it satisfies the linked issue. -->

## Authority and behavior boundaries

<!-- Identify the authoritative source for every changed behavior. Confirm that the frontend does not derive a second state/permission/rule model. -->

- Canonical specification or ADR:
- Server-side authority and re-authorization:
- Open decision / fail-closed behavior:
- External side effects and activation sequence:

## Validation evidence

<!-- List exact commands and results. Write "Not run" with a reason instead of implying success. -->

| Command or check | Result | Evidence |
| --- | --- | --- |
|  |  |  |

### Scenario coverage

- [ ] Normal path
- [ ] Boundary conditions
- [ ] Conflict or concurrent revision change
- [ ] Failure recovery and idempotent retry
- [ ] Permission denial and server-side re-authorization
- [ ] Version freeze / historical Snapshot invariants
- [ ] Not applicable scenarios are explained below

### Migration and compatibility

- [ ] Existing and unknown fields are preserved
- [ ] Stable IDs and historical references are preserved
- [ ] Migration is idempotent when executed twice
- [ ] A real or redacted production-shape fixture is covered
- [ ] Published Snapshot payload and hash remain unchanged
- [ ] Not applicable because this change has no persisted-data impact

### Required gates

- [ ] Branch was synchronized with the latest `main` before final validation
- [ ] Relevant root npm checks pass
- [ ] GitHub Actions required checks pass

## Visual evidence

<!--
For ordinary user-visible work, retain "视觉与交互统一检查待执行". A minimal render
smoke may establish basic loadability but is not full visual acceptance and never
removes that marker. Complete the detailed evidence below only when this PR explicitly
scopes visual or interaction review. For a non-user-visible change, write "N/A" and
explain why. If explicitly scoped rendering was not possible, write "Incomplete" with
the blocker; do not claim the interface is visually complete.
-->

| Required evidence | Detail |
| --- | --- |
| Unified visual and interaction review | 视觉与交互统一检查待执行 / Full visual and interaction review completed / N/A (reason) / Incomplete (blocker) |
| Minimal render smoke | Not run (reason) / Completed (path and result); this never changes the unified-review status |
| Full-review scope and states | Required only for full review: changed path plus applicable loading, empty, error, populated, and transition states |
| Full-review viewports and evidence | Required only for full review: exact viewport sizes and screenshots or recording links |
| Full-review observations and recheck | Required only for full review: issues/fixes and final rendered observation |

## Risks, recovery, and rollback

<!-- Describe data compatibility, immutable Snapshot impact, external partial-write recovery, deployment concerns, and a safe rollback path. -->

## Excluded follow-up work

<!-- Link separate Issues instead of silently expanding this pull request. -->
