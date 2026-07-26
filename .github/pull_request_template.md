## Linked issue

<!-- Use either `Closes #123` or `No linked issue — <reason>`. A governance PR does not need a linked Issue when the reason is explicit. -->

## Summary and scope

<!-- Briefly explain what changed, why, what is included, and any important exclusion. Do not copy the full TaskBrief. -->

## Validation evidence

<!--
Record the checks actually performed and their results. Link durable logs or runs when available.
For anything expected but not run, write `Not run — <reason>`. Never imply success.
Do not copy the TaskBrief validation plan, environment hashes, or full CI job inventory.
-->

| Command or check | Result | Evidence |
| --- | --- | --- |
|  |  |  |

## Risk triggers

<!--
Mirror only the six TaskBrief.riskDimensions through the five checkboxes below:
- persistedData → Persisted data or migration
- historicalSnapshots → Historical or published artifacts
- authorization or concurrency → Authorization or concurrency
- externalSideEffects → External side effects
- userVisible → User-visible UI or interaction

Leave non-applicable items unchecked. Do not add N/A explanations.
These checkboxes do not derive or override riskProfile, reviewTier, or the merge gate's normal/high classification.
-->

- [ ] Persisted data or migration
- [ ] Historical or published artifacts
- [ ] Authorization or concurrency
- [ ] External side effects
- [ ] User-visible UI or interaction
  - If checked: **视觉与交互统一检查待执行**

<!--
For every checked item, add only the applicable details below; delete unused prompts.

- Persisted data or migration: compatibility and unknown-field preservation; stable identities; production-shape fixture; second-run no-op; recovery or rollback.
- Historical or published artifacts: artifacts and hashes that must remain frozen; replay/readback evidence; handling of unrepresentable historical data.
- Authorization or concurrency: denied path; server-side re-authorization at commit; conflict/concurrency behavior; stale-operation protection and recovery.
- External side effects: preparation → write → readback → activation; idempotency key; partial-failure recovery or compensation; activation/rollback boundary.
- User-visible UI or interaction:
  - Keep the visible pending marker above until the unified visual and interaction review is complete.
  - When completed, replace it with rendered states, viewports, screenshot or recording links, findings, fixes, and the final recheck.
  - Minimal render smoke: <result or `Not run — <reason>`>. A minimal render smoke does not complete the unified visual review.
-->

## Review and CI evidence

<!--
Give current Review and CI status with durable links. If evidence is unavailable, write `Pending` or `Not run — <reason>`.
Do not copy exact head/base or the full CI job inventory into this body.
Merge readiness is evaluated live immediately before an actual merge; do not copy a merge-gate result here because it can become stale.
For a high-risk PR, link the substantive current-head review carrying the required `Agent-Review: PASS` signal.
-->

- Review:
- CI:

## Residual risk or follow-up

<!-- Describe remaining risk, rollback constraints, blocked dependencies, or linked follow-up Issues. If none were identified, say `None identified.` -->
