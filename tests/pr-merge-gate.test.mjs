import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluatePullRequestMergeGate,
  graphqlNextPageCursor,
  AGENT_REVIEW_PASS_MARKER,
  GITHUB_DOTCOM_API_BASE,
  parsePullRequestRunName,
  pullRequestRunProvenance,
  readPullRequestWorkflowChecks,
  readPullRequestWithCurrentBase,
  readStableMergeGateSnapshot,
  readTrustedContentEvidence,
  resolveGithubApiBase,
  selectLatestPullRequestWorkflowRun,
  workflowRunAttemptJobsPath,
} from "../scripts/check-pr-merge-gate.mjs";

async function fixture(name) {
  const path = new URL(`./fixtures/merge-gate/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

test("github.com merge-gate checks use the canonical official API host", () => {
  assert.equal(resolveGithubApiBase(undefined), GITHUB_DOTCOM_API_BASE);
  assert.equal(resolveGithubApiBase("https://api.github.com"), GITHUB_DOTCOM_API_BASE);
});

test("github.com merge-gate checks fail closed for a redirected API host", () => {
  assert.throws(
    () => resolveGithubApiBase("https://github-api-attacker.invalid"),
    /GITHUB_API_URL must be exactly https:\/\/api\.github\.com/,
  );
});

test("normal-risk current-head CI is merge-ready", async () => {
  const result = evaluatePullRequestMergeGate(await fixture("ready-normal"));

  assert.equal(result.ready, true);
  assert.equal(result.evidence.filter((item) => item.type === "ci").length, 3);
  assert.ok(
    result.evidence.some((item) => item.type === "trusted-ci-workflow"),
  );
  assert.ok(
    result.evidence.some((item) => item.type === "trusted-gate-program"),
  );
});

test("a pull request that changes the canonical CI workflow fails closed", async () => {
  const snapshot = await fixture("ready-normal");
  snapshot.trust.ciWorkflow.headContentSha256 = "3".repeat(64);

  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "CI_WORKFLOW_CHANGED",
    ),
  );
});

test("missing canonical workflow content cannot become trusted CI evidence", async () => {
  const snapshot = await fixture("ready-normal");
  snapshot.trust.ciWorkflow.baseContentSha256 = null;

  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "CI_WORKFLOW_TRUST_UNAVAILABLE",
    ),
  );
});

test("the gate program must match the live base copy", async () => {
  const snapshot = await fixture("ready-normal");
  snapshot.trust.gateProgram.localContentSha256 = "3".repeat(64);

  const untrusted = evaluatePullRequestMergeGate(snapshot);
  snapshot.trust.gateProgram.localContentSha256 =
    snapshot.trust.gateProgram.baseContentSha256;
  snapshot.trust.gateProgram.headContentSha256 = "3".repeat(64);
  const changed = evaluatePullRequestMergeGate(snapshot);
  snapshot.trust.gateProgram.baseContentSha256 = null;
  const bootstrap = evaluatePullRequestMergeGate(snapshot);

  assert.ok(
    untrusted.blockers.some(
      (blocker) => blocker.code === "GATE_PROGRAM_UNTRUSTED",
    ),
  );
  assert.ok(
    changed.blockers.some(
      (blocker) => blocker.code === "GATE_PROGRAM_CHANGED",
    ),
  );
  assert.ok(
    bootstrap.blockers.some(
      (blocker) => blocker.code === "GATE_PROGRAM_BOOTSTRAP_REQUIRED",
    ),
  );
});

test("trusted content evidence reads workflow and gate bytes from immutable refs", async () => {
  const workflow = "name: CI\non: pull_request\n";
  const gateProgram = "console.log('trusted gate');\n";
  const requestedPaths = [];
  const client = {
    request: async (path) => {
      requestedPaths.push(path);
      const isWorkflow = path.includes("/contents/.github/workflows/ci.yml");
      return {
        type: "file",
        encoding: "base64",
        sha: isWorkflow ? "workflow-blob" : "gate-blob",
        content: Buffer.from(isWorkflow ? workflow : gateProgram).toString("base64"),
      };
    },
  };

  const evidence = await readTrustedContentEvidence({
    client,
    prefix: "/repos/owner/repo",
    pullRequest: {
      baseSha: "d".repeat(40),
      headSha: "a".repeat(40),
    },
    localGateContent: Buffer.from(gateProgram),
  });

  assert.equal(
    evidence.ciWorkflow.baseContentSha256,
    evidence.ciWorkflow.headContentSha256,
  );
  assert.equal(
    evidence.gateProgram.baseContentSha256,
    evidence.gateProgram.localContentSha256,
  );
  assert.equal(
    evidence.gateProgram.baseContentSha256,
    evidence.gateProgram.headContentSha256,
  );
  assert.deepEqual(requestedPaths, [
    `/repos/owner/repo/contents/.github/workflows/ci.yml?ref=${"d".repeat(40)}`,
    `/repos/owner/repo/contents/.github/workflows/ci.yml?ref=${"a".repeat(40)}`,
    `/repos/owner/repo/contents/scripts/check-pr-merge-gate.mjs?ref=${"d".repeat(40)}`,
    `/repos/owner/repo/contents/scripts/check-pr-merge-gate.mjs?ref=${"a".repeat(40)}`,
  ]);
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

test("live pull request snapshots use the repository ref tip instead of stale PR base metadata", async () => {
  const staleBaseSha = "d".repeat(40);
  const currentBaseSha = "e".repeat(40);
  const requestedPaths = [];
  const client = {
    request: async (path) => {
      requestedPaths.push(path);
      if (path.endsWith("/pulls/63")) {
        return {
          number: 63,
          html_url: "https://example.test/pull/63",
          draft: false,
          state: "open",
          head: { sha: "a".repeat(40) },
          base: { ref: "main", sha: staleBaseSha },
          updated_at: "2026-07-23T08:00:00Z",
          user: { login: "author", type: "User" },
        };
      }
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha: currentBaseSha } };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };

  const pullRequest = await readPullRequestWithCurrentBase({
    client,
    prefix: "/repos/owner/repo",
    pullNumber: 63,
  });
  const snapshot = await fixture("ready-normal");
  snapshot.pullRequest = pullRequest;
  for (const check of snapshot.checks) {
    check.pullNumber = 63;
  }
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(pullRequest.baseSnapshotSha, staleBaseSha);
  assert.equal(pullRequest.baseSha, currentBaseSha);
  assert.deepEqual(requestedPaths, [
    "/repos/owner/repo/pulls/63",
    "/repos/owner/repo/git/ref/heads/main",
  ]);
  assert.deepEqual(
    result.blockers.map((blocker) => blocker.code),
    ["CI_BASE_STALE", "CI_BASE_STALE", "CI_BASE_STALE"],
  );
});

test("the live target ref tip participates in pull request stability sampling", async () => {
  const snapshotTemplate = await fixture("ready-normal");
  const staleBaseSha = "d".repeat(40);
  const currentBaseSha = "e".repeat(40);
  const sampledTips = [
    staleBaseSha,
    currentBaseSha,
    currentBaseSha,
    currentBaseSha,
  ];
  let refReads = 0;
  const client = {
    request: async (path) => {
      if (path.endsWith("/pulls/63")) {
        return {
          number: 63,
          html_url: "https://example.test/pull/63",
          draft: false,
          state: "open",
          head: { sha: "a".repeat(40) },
          base: { ref: "main", sha: staleBaseSha },
          updated_at: "2026-07-23T08:00:00Z",
          user: { login: "author", type: "User" },
        };
      }
      if (path.endsWith("/git/ref/heads/main")) {
        const sha = sampledTips[refReads];
        refReads += 1;
        return { object: { sha } };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };
  const readPullRequest = () =>
    readPullRequestWithCurrentBase({
      client,
      prefix: "/repos/owner/repo",
      pullNumber: 63,
    });
  const readEvidence = async () => ({
    checks: snapshotTemplate.checks,
    reviews: snapshotTemplate.reviews,
    reviewThreads: snapshotTemplate.reviewThreads,
  });

  const snapshot = await readStableMergeGateSnapshot({
    readPullRequest,
    readEvidence,
    riskLevel: "normal",
    maxAttempts: 2,
  });

  assert.equal(refReads, 4);
  assert.equal(snapshot.pullRequest.baseSnapshotSha, staleBaseSha);
  assert.equal(snapshot.pullRequest.baseSha, currentBaseSha);
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

test("a later same-head Agent PASS replaces the same reviewer's change request", async () => {
  const snapshot = await fixture("ready-high-risk-agent-commented");
  snapshot.reviews.unshift({
    id: 10,
    state: "CHANGES_REQUESTED",
    commitSha: snapshot.pullRequest.headSha,
    submittedAt: "2026-07-23T07:00:00Z",
    author: snapshot.reviews[0].author,
  });

  const result = evaluatePullRequestMergeGate(snapshot);
  assert.equal(result.ready, true);
  assert.ok(
    !result.blockers.some(
      (blocker) => blocker.code === "REVIEW_CHANGES_REQUESTED",
    ),
  );
});

test("a later arbitrary comment does not replace the same reviewer's change request", async () => {
  const snapshot = await fixture("ready-high-risk-agent-commented");
  snapshot.reviews[0].body = "Looks good after the update.";
  snapshot.reviews.unshift({
    id: 10,
    state: "CHANGES_REQUESTED",
    commitSha: snapshot.pullRequest.headSha,
    submittedAt: "2026-07-23T07:00:00Z",
    author: snapshot.reviews[0].author,
  });

  const result = evaluatePullRequestMergeGate(snapshot);
  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === "REVIEW_CHANGES_REQUESTED",
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
  snapshot.checks[0] = {
    ...snapshot.checks[0],
    id: 100,
    status: "queued",
    conclusion: null,
    startedAt: null,
    completedAt: null,
  };
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "CI_PENDING"));
});

test("duplicate required jobs in one trusted attempt fail closed", async () => {
  const snapshot = await fixture("ready-normal");
  snapshot.checks.push({
    ...snapshot.checks[0],
    id: 100,
  });

  const result = evaluatePullRequestMergeGate(snapshot);
  assert.equal(result.ready, false);
  assert.ok(
    result.blockers.some(
      (blocker) =>
        blocker.code === "CI_AMBIGUOUS" &&
        blocker.check === "Root v3 app (npm)",
    ),
  );
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

test("trusted workflow runs use the canonical path even when run-name replaces name", () => {
  const pullRequest = {
    number: 63,
    headSha: "a".repeat(40),
  };
  const displayTitle =
    `gate-context event=pull_request pr=63 head=${"a".repeat(40)} base=${"d".repeat(40)}`;
  const run = {
    name: displayTitle,
    display_title: displayTitle,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: "a".repeat(40),
  };

  assert.equal(pullRequestRunProvenance(run, pullRequest)?.baseSha, "d".repeat(40));
  assert.equal(
    pullRequestRunProvenance(
      { ...run, path: ".github/workflows/duplicate-ci.yml" },
      pullRequest,
    ),
    null,
  );
});

test("workflow selection filters target PR provenance before choosing latest", () => {
  const pullRequest = { number: 63, headSha: "a".repeat(40) };
  const oldTargetTitle =
    `gate-context event=pull_request pr=63 head=${"a".repeat(40)} base=${"d".repeat(40)}`;
  const newTargetTitle =
    `gate-context event=pull_request pr=63 head=${"a".repeat(40)} base=${"e".repeat(40)}`;
  const otherPullTitle =
    `gate-context event=pull_request pr=64 head=${"a".repeat(40)} base=${"f".repeat(40)}`;
  const oldTarget = {
    id: 1,
    display_title: oldTargetTitle,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: pullRequest.headSha,
    run_attempt: 1,
  };
  const newTarget = {
    ...oldTarget,
    id: 2,
    display_title: newTargetTitle,
  };
  const newerOtherPull = {
    ...oldTarget,
    id: 3,
    display_title: otherPullTitle,
  };

  assert.deepEqual(
    selectLatestPullRequestWorkflowRun(
      [oldTarget, newTarget, newerOtherPull],
      pullRequest,
    ),
    {
      run: newTarget,
      provenance: {
        pullNumber: 63,
        headSha: "a".repeat(40),
        baseSha: "e".repeat(40),
      },
    },
  );
});

test("workflow jobs use the selected attempt endpoint without job run_attempt", async () => {
  const headSha = "a".repeat(40);
  const baseSha = "d".repeat(40);
  const pullRequest = { number: 63, headSha };
  const run = {
    id: 101,
    display_title:
      `gate-context event=pull_request pr=63 head=${headSha} base=${baseSha}`,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: headSha,
    run_attempt: 2,
  };
  const currentAttemptJob = {
    id: 201,
    run_id: run.id,
    name: "Root v3 app (npm)",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
  };
  const requestedPaths = [];
  const client = {
    paginate: async (path, collectionName) => {
      requestedPaths.push(path);
      if (collectionName === "workflow_runs") {
        return [run];
      }
      assert.equal(collectionName, "jobs");
      return [currentAttemptJob];
    },
  };

  const checks = await readPullRequestWorkflowChecks(
    client,
    "/repos/owner/repo",
    pullRequest,
  );

  assert.deepEqual(requestedPaths, [
    `/repos/owner/repo/actions/runs?event=pull_request&head_sha=${headSha}`,
    "/repos/owner/repo/actions/runs/101/attempts/2/jobs",
  ]);
  assert.deepEqual(
    checks.map((check) => ({
      id: check.id,
      workflowRunId: check.workflowRunId,
      workflowRunAttempt: check.workflowRunAttempt,
    })),
    [{ id: 201, workflowRunId: 101, workflowRunAttempt: 2 }],
  );
  assert.equal("jobRunAttempt" in checks[0], false);
  assert.equal(
    workflowRunAttemptJobsPath("/repos/owner/repo", {
      id: 101,
      run_attempt: null,
    }),
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
            trust: base.trust,
          }
        : {
            checks: pending.checks,
            reviews: pending.reviews,
            reviewThreads: pending.reviewThreads,
            trust: pending.trust,
          };
    },
  });
  const result = evaluatePullRequestMergeGate(snapshot);

  assert.equal(pullReads, 4);
  assert.equal(evidenceReads, 4);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "CI_PENDING"));
});

test("trusted content changes during collection participate in stability sampling", async () => {
  const base = await fixture("ready-normal");
  let evidenceReads = 0;

  const snapshot = await readStableMergeGateSnapshot({
    riskLevel: "normal",
    maxAttempts: 2,
    readPullRequest: async () => base.pullRequest,
    readEvidence: async () => {
      evidenceReads += 1;
      const trust = structuredClone(base.trust);
      if (evidenceReads === 1) {
        trust.ciWorkflow.headContentSha256 = "3".repeat(64);
      }
      return {
        checks: base.checks,
        reviews: base.reviews,
        reviewThreads: base.reviewThreads,
        trust,
      };
    },
  });

  assert.equal(evidenceReads, 4);
  assert.equal(
    snapshot.trust.ciWorkflow.headContentSha256,
    base.trust.ciWorkflow.headContentSha256,
  );
  assert.equal(evaluatePullRequestMergeGate(snapshot).ready, true);
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
