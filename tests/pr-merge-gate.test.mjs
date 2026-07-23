import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluatePullRequestMergeGate,
  graphqlNextPageCursor,
  AGENT_REVIEW_PASS_MARKER,
  parsePullRequestRunName,
  readStableMergeGateSnapshot,
} from "../scripts/check-pr-merge-gate.mjs";

async function fixture(name) {
  const path = new URL(`./fixtures/merge-gate/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

test("normal-risk current-head CI is merge-ready", async () => {
  const result = evaluatePullRequestMergeGate(await fixture("ready-normal"));

  assert.equal(result.ready, true);
  assert.equal(result.evidence.filter((item) => item.type === "ci").length, 3);
});

test("successful checks from an old head do not count", async () => {
  const result = evaluatePullRequestMergeGate(await fixture("blocked-old-head"));

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map((blocker) => blocker.code),
    ["CI_OLD_HEAD", "CI_OLD_HEAD", "CI_OLD_HEAD"],
  );
});

test("successful push jobs cannot replace this pull request's CI", async () => {
  const snapshot = await fixture("ready-normal");
  for (const check of snapshot.checks) {
    check.event = "push";
    check.pullNumber = null;
  }
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map((blocker) => blocker.code),
    ["CI_NOT_PULL_REQUEST", "CI_NOT_PULL_REQUEST", "CI_NOT_PULL_REQUEST"],
  );
});

test("CI collected before the pull request base changed is stale", async () => {
  const snapshot = await fixture("ready-normal");
  snapshot.pullRequest.baseSha = "c".repeat(40);
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map((blocker) => blocker.code),
    ["CI_BASE_STALE", "CI_BASE_STALE", "CI_BASE_STALE"],
  );
});

test("an unavailable current base fails closed", async () => {
  const snapshot = await fixture("ready-normal");
  delete snapshot.pullRequest.baseSha;
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "CURRENT_BASE_UNAVAILABLE",
    ),
  );
});

test("a current-head COMMENTED Agent review satisfies high-risk review", async () => {
  const result = evaluatePullRequestMergeGate(
    await fixture("ready-high-risk-agent-commented"),
  );

  assert.equal(result.ready, true);
  assert.deepEqual(
    result.evidence.find((item) => item.type === "review"),
    {
      type: "review",
      headSha: "a".repeat(40),
      reviewId: 11,
      reviewer: "reviewer",
      state: "COMMENTED",
      submittedAt: "2026-07-23T07:05:00Z",
      signalKind: "agent-review-pass",
    },
  );
});

test("an arbitrary COMMENTED review without the explicit PASS marker does not count", async () => {
  const snapshot = await fixture("ready-high-risk-agent-commented");
  snapshot.reviews[0].body = "Found no blocking thread, but this is not a pass signal.";
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "CURRENT_HEAD_REVIEW_SIGNAL_REQUIRED",
    ),
  );
  assert.equal(AGENT_REVIEW_PASS_MARKER, "Agent-Review: PASS");
});

test("the Agent PASS marker rejects leading or trailing whitespace", async () => {
  const snapshot = await fixture("ready-high-risk-agent-commented");

  for (const marker of [" Agent-Review: PASS", "Agent-Review: PASS "]) {
    snapshot.reviews[0].body = `Automated review complete.\n\n${marker}`;
    const result = evaluatePullRequestMergeGate(snapshot);
    assert.equal(result.ready, false);
    assert.ok(
      result.blockers.some(
        (blocker) => blocker.code === "CURRENT_HEAD_REVIEW_SIGNAL_REQUIRED",
      ),
    );
  }
});

test("a current-head APPROVED review also satisfies high-risk review", async () => {
  const result = evaluatePullRequestMergeGate(await fixture("ready-high-risk"));

  assert.equal(result.ready, true);
  assert.equal(
    result.evidence.find((item) => item.type === "review")?.reviewer,
    "reviewer",
  );
});

test("Agent review signals may come from User, Bot, App, or an actor without type", async () => {
  const snapshot = await fixture("ready-high-risk");
  delete snapshot.reviews[0].author.type;
  const missingType = evaluatePullRequestMergeGate(snapshot);
  snapshot.reviews[0].author.type = "Bot";
  const bot = evaluatePullRequestMergeGate(snapshot);
  snapshot.reviews[0].author.type = "App";
  const app = evaluatePullRequestMergeGate(snapshot);

  for (const result of [missingType, bot, app]) {
    assert.equal(result.ready, true);
  }
});

test("a review signal on an older head does not satisfy high-risk review", async () => {
  const snapshot = await fixture("ready-high-risk");
  snapshot.reviews[0].commitSha = "b".repeat(40);
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "CURRENT_HEAD_REVIEW_SIGNAL_REQUIRED",
    ),
  );
});

test("draft, failed or missing CI, pending CI, and unresolved threads all block", async () => {
  const result = evaluatePullRequestMergeGate(
    await fixture("blocked-draft-thread-failed"),
  );
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.equal(result.ready, false);
  assert.ok(codes.includes("PR_IS_DRAFT"));
  assert.ok(codes.includes("CI_FAILED"));
  assert.ok(codes.includes("CI_PENDING"));
  assert.ok(codes.includes("CI_MISSING"));
  assert.ok(codes.includes("REVIEW_THREADS_UNRESOLVED"));
});

test("later CHANGES_REQUESTED blocks and DISMISSED invalidates earlier evidence", async () => {
  const snapshot = await fixture("ready-high-risk");
  snapshot.reviews.push(
    {
      ...snapshot.reviews[0],
      id: 11,
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-07-23T07:05:00Z",
    },
  );
  const changesRequested = evaluatePullRequestMergeGate(snapshot);
  snapshot.reviews[1].state = "DISMISSED";
  const dismissed = evaluatePullRequestMergeGate(snapshot);

  assert.ok(
    changesRequested.blockers.some(
      (blocker) => blocker.code === "REVIEW_CHANGES_REQUESTED",
    ),
  );
  assert.ok(
    dismissed.blockers.some(
      (blocker) => blocker.code === "CURRENT_HEAD_REVIEW_SIGNAL_REQUIRED",
    ),
  );
});

test("a later old-head decision cannot clear a current-head change request", async () => {
  const snapshot = await fixture("ready-high-risk-agent-commented");
  snapshot.reviews.unshift({
    id: 10,
    state: "CHANGES_REQUESTED",
    commitSha: snapshot.pullRequest.headSha,
    submittedAt: "2026-07-23T07:00:00Z",
    author: { login: "blocking-reviewer", type: "User" },
  });
  snapshot.reviews.push({
    id: 12,
    state: "APPROVED",
    commitSha: "b".repeat(40),
    submittedAt: "2026-07-23T07:10:00Z",
    author: { login: "blocking-reviewer", type: "User" },
  });

  const result = evaluatePullRequestMergeGate(snapshot);
  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "REVIEW_CHANGES_REQUESTED",
    ),
  );
});

test("a current-head change request also blocks normal-risk changes", async () => {
  const snapshot = await fixture("ready-normal");
  snapshot.reviews.push({
    id: 10,
    state: "CHANGES_REQUESTED",
    commitSha: snapshot.pullRequest.headSha,
    submittedAt: "2026-07-23T07:00:00Z",
    author: { login: "reviewer", type: "User" },
  });

  const result = evaluatePullRequestMergeGate(snapshot);
  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "REVIEW_CHANGES_REQUESTED",
    ),
  );
});

test("high-risk review fails closed when no current-head review signal exists", async () => {
  const snapshot = await fixture("ready-high-risk");
  snapshot.reviews = [];
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "CURRENT_HEAD_REVIEW_SIGNAL_REQUIRED",
    ),
  );
});

test("risk classification is mandatory and cannot silently default to normal", async () => {
  const snapshot = await fixture("ready-normal");
  delete snapshot.riskLevel;
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some((blocker) => blocker.code === "RISK_UNCLASSIFIED"),
  );
});

test("PR author identity does not control the repository review signal", async () => {
  const snapshot = await fixture("ready-high-risk");
  snapshot.pullRequest.author = {};
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, true);
});

test("a newer pending rerun on the same head supersedes older success", async () => {
  const snapshot = await fixture("ready-normal");
  snapshot.checks[0].startedAt = "2026-07-23T08:00:00Z";
  snapshot.checks[0].completedAt = "2026-07-23T08:05:00Z";
  snapshot.checks.push({
    ...snapshot.checks[0],
    id: 100,
    status: "queued",
    conclusion: null,
    startedAt: null,
    completedAt: null,
  });
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "CI_PENDING"));
});

test("required CI only accepts checks explicitly owned by GitHub Actions", async () => {
  const snapshot = await fixture("ready-normal");
  delete snapshot.checks[0].appSlug;
  snapshot.checks[1].appSlug = "third-party-ci";
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map((blocker) => [blocker.code, blocker.check]),
    [
      ["CI_MISSING", "Root v3 app (npm)"],
      ["CI_MISSING", "Historical workspace (pnpm)"],
    ],
  );
});

test("GraphQL pagination fails closed when the next-page cursor is absent", () => {
  assert.throws(
    () =>
      graphqlNextPageCursor(
        { hasNextPage: true, endCursor: null },
        "Pull request review threads",
      ),
    /hasNextPage without a valid endCursor/,
  );
  assert.throws(
    () =>
      graphqlNextPageCursor(
        { hasNextPage: true, endCursor: "  " },
        "Pull request review threads",
      ),
    /hasNextPage without a valid endCursor/,
  );
  assert.equal(
    graphqlNextPageCursor(
      { hasNextPage: true, endCursor: "next-page" },
      "Pull request review threads",
    ),
    "next-page",
  );
  assert.equal(
    graphqlNextPageCursor(
      { hasNextPage: false, endCursor: null },
      "Pull request review threads",
    ),
    null,
  );
});

test("pull request run names carry immutable PR, head, and base provenance", () => {
  assert.deepEqual(
    parsePullRequestRunName(
      `gate-context event=pull_request pr=63 head=${"a".repeat(40)} base=${"d".repeat(40)}`,
    ),
    {
      pullNumber: 63,
      headSha: "a".repeat(40),
      baseSha: "d".repeat(40),
    },
  );
  assert.equal(
    parsePullRequestRunName(
      `gate-context event=push pr=0 head=${"a".repeat(40)} base=${"d".repeat(40)}`,
    ),
    null,
  );
  assert.equal(
    parsePullRequestRunName(
      `gate-context event=pull_request pr=63 head=${"a".repeat(39)} base=${"d".repeat(40)}`,
    ),
    null,
  );
});

test("evidence changes during collection trigger a retry and use the stable second attempt", async () => {
  const base = await fixture("ready-normal");
  const pending = structuredClone(base);
  pending.checks[0].status = "in_progress";
  pending.checks[0].conclusion = null;
  let pullReads = 0;
  let evidenceReads = 0;

  const snapshot = await readStableMergeGateSnapshot({
    riskLevel: "normal",
    now: () => "2026-07-23T09:00:00Z",
    readPullRequest: async () => {
      pullReads += 1;
      return {
        ...base.pullRequest,
        updatedAt: "2026-07-23T08:00:00Z",
      };
    },
    readEvidence: async () => {
      evidenceReads += 1;
      return evidenceReads === 1
        ? {
            checks: base.checks,
            reviews: base.reviews,
            reviewThreads: base.reviewThreads,
          }
        : {
            checks: pending.checks,
            reviews: pending.reviews,
            reviewThreads: pending.reviewThreads,
          };
    },
  });
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(pullReads, 4);
  assert.equal(evidenceReads, 4);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "CI_PENDING"));
});

test("continuously changing review or thread evidence fails closed", async () => {
  const base = await fixture("ready-high-risk");
  let evidenceReads = 0;

  await assert.rejects(
    readStableMergeGateSnapshot({
      riskLevel: "high",
      maxAttempts: 3,
      readPullRequest: async () => ({
        ...base.pullRequest,
        updatedAt: "2026-07-23T08:00:00Z",
      }),
      readEvidence: async () => {
        evidenceReads += 1;
        return {
          checks: base.checks,
          reviews: base.reviews.map((review) => ({
            ...review,
            state: evidenceReads % 2 === 0 ? "DISMISSED" : "APPROVED",
          })),
          reviewThreads: [
            { id: "thread", isResolved: evidenceReads % 2 === 0 },
          ],
        };
      },
    }),
    /evidence changed repeatedly/,
  );

  assert.equal(evidenceReads, 6);
});

test("changing only the review body during collection also fails closed", async () => {
  const base = await fixture("ready-high-risk-agent-commented");
  let evidenceReads = 0;

  await assert.rejects(
    readStableMergeGateSnapshot({
      riskLevel: "high",
      maxAttempts: 3,
      readPullRequest: async () => ({
        ...base.pullRequest,
        updatedAt: "2026-07-23T08:00:00Z",
      }),
      readEvidence: async () => {
        evidenceReads += 1;
        return {
          checks: base.checks,
          reviews: base.reviews.map((review) => ({
            ...review,
            body:
              evidenceReads % 2 === 0
                ? review.body
                : `${review.body}\nobservation-${evidenceReads}`,
          })),
          reviewThreads: base.reviewThreads,
        };
      },
    }),
    /evidence changed repeatedly/,
  );

  assert.equal(evidenceReads, 6);
});
