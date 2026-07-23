#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REQUIRED_CURRENT_HEAD_CHECKS = [
  "Root v3 app (npm)",
  "Historical workspace (pnpm)",
  "Windows line-ending policy",
];

export const AGENT_REVIEW_PASS_MARKER = "Agent-Review: PASS";

const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const PR_RUN_NAME_PATTERN =
  /^gate-context event=pull_request pr=([1-9]\d*) head=([a-f0-9]{40}) base=([a-f0-9]{40})$/i;

const DECISIVE_REVIEW_STATES = new Set([
  "APPROVED",
  "AGENT_PASSED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);

function normalizeLogin(login) {
  return typeof login === "string" ? login.trim().toLowerCase() : "";
}

function userKey(user) {
  const login = normalizeLogin(user?.login);
  return login ? `login:${login}` : "";
}

function eventTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareIds(left, right) {
  const leftId = String(left?.id ?? "");
  const rightId = String(right?.id ?? "");
  if (leftId === rightId) {
    return 0;
  }
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    return BigInt(leftId) < BigInt(rightId) ? -1 : 1;
  }
  return leftId < rightId ? -1 : 1;
}

function compareByTimeAndId(left, right, timeField) {
  const timeDifference = eventTime(left?.[timeField]) - eventTime(right?.[timeField]);
  if (timeDifference !== 0) {
    return timeDifference;
  }

  return compareIds(left, right);
}

function latestRun(runs) {
  // GitHub Actions job IDs are monotonic. A rerun can be queued before it has
  // started_at/completed_at, so timestamps must never make an older completed
  // run override the newer pending run.
  return [...runs].sort(compareIds).at(-1);
}

function hasAgentReviewPassMarker(body) {
  return String(body ?? "")
    .split(/\r?\n/u)
    .some((line) => line === AGENT_REVIEW_PASS_MARKER);
}

function decisiveReviewState(review) {
  const state = String(review?.state ?? "").toUpperCase();
  if (state === "COMMENTED" && hasAgentReviewPassMarker(review?.body)) {
    return "AGENT_PASSED";
  }
  return state;
}

function currentHeadReviewState({ reviews, headSha }) {
  const latestDecisionByReviewer = new Map();
  const orderedReviews = Array.isArray(reviews)
    ? [...reviews].sort((left, right) =>
        compareByTimeAndId(left, right, "submittedAt"),
      )
    : [];

  for (const review of orderedReviews) {
    const state = decisiveReviewState(review);
    const reviewerKey = userKey(review?.author);
    if (
      !reviewerKey ||
      review.commitSha !== headSha ||
      !DECISIVE_REVIEW_STATES.has(state)
    ) {
      continue;
    }

    latestDecisionByReviewer.set(reviewerKey, { ...review, state });
  }

  const activeChangeRequest = [...latestDecisionByReviewer.values()].find(
    (review) => review.state === "CHANGES_REQUESTED" && review.commitSha === headSha,
  );
  if (activeChangeRequest) {
    return { activeChangeRequest };
  }

  const signal = [...orderedReviews].reverse().find((review) => {
    const state = decisiveReviewState(review);
    const reviewerKey = userKey(review?.author);
    if (
      !reviewerKey ||
      review.commitSha !== headSha ||
      (state !== "APPROVED" && state !== "AGENT_PASSED")
    ) {
      return false;
    }

    const laterDecision = latestDecisionByReviewer.get(reviewerKey);
    return !laterDecision ||
      compareByTimeAndId(laterDecision, review, "submittedAt") <= 0 ||
      laterDecision.state === "APPROVED" ||
      laterDecision.state === "AGENT_PASSED";
  });

  return { signal };
}

export function evaluatePullRequestMergeGate(snapshot) {
  const pullRequest = snapshot?.pullRequest ?? {};
  const headSha = pullRequest.headSha;
  const baseSha = pullRequest.baseSha;
  const riskLevel = snapshot?.riskLevel;
  const blockers = [];
  const evidence = [];

  if (!/^[a-f0-9]{40}$/i.test(headSha ?? "")) {
    blockers.push({
      code: "CURRENT_HEAD_UNAVAILABLE",
      message: "Pull request current head SHA is unavailable",
    });
  }

  if (!/^[a-f0-9]{40}$/i.test(baseSha ?? "")) {
    blockers.push({
      code: "CURRENT_BASE_UNAVAILABLE",
      message: "Pull request current base SHA is unavailable",
    });
  }

  if (pullRequest.isDraft) {
    blockers.push({
      code: "PR_IS_DRAFT",
      message: "Draft pull requests are not merge-ready",
    });
  }

  if (pullRequest.state !== "open") {
    blockers.push({
      code: "PR_NOT_OPEN",
      message: "Only open pull requests can be merge-ready",
    });
  }

  if (riskLevel !== "normal" && riskLevel !== "high") {
    blockers.push({
      code: "RISK_UNCLASSIFIED",
      message: "Risk must be classified explicitly as normal or high",
    });
  }

  for (const checkName of REQUIRED_CURRENT_HEAD_CHECKS) {
    const namedRuns = (snapshot?.checks ?? []).filter(
      (check) =>
        check.name === checkName &&
        check.appSlug === "github-actions",
    );
    const currentHeadRuns = namedRuns.filter((check) => check.headSha === headSha);

    if (currentHeadRuns.length === 0) {
      const oldHeadRun = latestRun(namedRuns);
      blockers.push({
        code: oldHeadRun ? "CI_OLD_HEAD" : "CI_MISSING",
        check: checkName,
        message: oldHeadRun
          ? `${checkName} only has evidence for ${oldHeadRun.headSha}`
          : `${checkName} is missing on the current head`,
      });
      continue;
    }

    const pullRequestRuns = currentHeadRuns.filter(
      (check) =>
        check.event === "pull_request" &&
        check.pullNumber === pullRequest.number,
    );
    if (pullRequestRuns.length === 0) {
      blockers.push({
        code: "CI_NOT_PULL_REQUEST",
        check: checkName,
        message: `${checkName} has no evidence from this pull request's workflow run`,
      });
      continue;
    }

    const currentBaseRuns = pullRequestRuns.filter(
      (check) => check.baseSha === baseSha,
    );
    if (currentBaseRuns.length === 0) {
      const staleRun = latestRun(pullRequestRuns);
      blockers.push({
        code: "CI_BASE_STALE",
        check: checkName,
        message: `${checkName} only has pull request evidence for base ${staleRun.baseSha ?? "unknown"}`,
      });
      continue;
    }

    if (currentBaseRuns.length !== 1) {
      blockers.push({
        code: "CI_AMBIGUOUS",
        check: checkName,
        message: `${checkName} appears ${currentBaseRuns.length} times in the trusted workflow attempt`,
      });
      continue;
    }

    const [run] = currentBaseRuns;
    if (String(run.status).toLowerCase() !== "completed") {
      blockers.push({
        code: "CI_PENDING",
        check: checkName,
        message: `${checkName} has not completed on the current head`,
      });
      continue;
    }

    if (String(run.conclusion).toLowerCase() !== "success") {
      blockers.push({
        code: "CI_FAILED",
        check: checkName,
        message: `${checkName} concluded ${run.conclusion ?? "without success"}`,
      });
      continue;
    }

    evidence.push({
      type: "ci",
      check: checkName,
      headSha,
      baseSha,
      runId: run.id,
      workflowRunId: run.workflowRunId,
      url: run.url,
    });
  }

  const unresolvedThreads = (snapshot?.reviewThreads ?? []).filter(
    (thread) => thread?.isResolved !== true,
  );
  if (unresolvedThreads.length > 0) {
    blockers.push({
      code: "REVIEW_THREADS_UNRESOLVED",
      count: unresolvedThreads.length,
      message: `${unresolvedThreads.length} review thread(s) remain unresolved`,
    });
  }

  const reviewState = currentHeadReviewState({
    reviews: snapshot?.reviews,
    headSha,
  });
  if (reviewState.activeChangeRequest) {
    blockers.push({
      code: "REVIEW_CHANGES_REQUESTED",
      message: "A current-head review still requests changes",
    });
  } else if (riskLevel === "high") {
    if (!reviewState.signal) {
      blockers.push({
        code: "CURRENT_HEAD_REVIEW_SIGNAL_REQUIRED",
        message:
          `High-risk changes require current-head APPROVED or COMMENTED with exact ${AGENT_REVIEW_PASS_MARKER} marker`,
      });
    } else {
      evidence.push({
        type: "review",
        headSha,
        reviewId: reviewState.signal.id,
        reviewer: reviewState.signal.author.login,
        state: String(reviewState.signal.state).toUpperCase(),
        submittedAt: reviewState.signal.submittedAt,
        signalKind:
          String(reviewState.signal.state).toUpperCase() === "APPROVED"
            ? "github-approved"
            : "agent-review-pass",
      });
    }
  }

  return {
    ready: blockers.length === 0,
    pullNumber: pullRequest.number,
    url: pullRequest.url,
    headSha: /^[a-f0-9]{40}$/i.test(headSha ?? "") ? headSha : null,
    riskLevel: riskLevel ?? null,
    checkedAt: snapshot?.checkedAt ?? null,
    blockers,
    evidence,
  };
}

function parseRepository(value) {
  const match = /^([^/]+)\/([^/]+)$/.exec(value ?? "");
  if (!match) {
    throw new Error("--repo must use OWNER/REPO format");
  }
  return { owner: match[1], repo: match[2] };
}

function readToken() {
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "GitHub authentication unavailable; set GH_TOKEN/GITHUB_TOKEN or run gh auth login",
    );
  }
}

function createGithubClient(token) {
  const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "tackle-forger-merge-gate",
    "x-github-api-version": "2022-11-28",
  };

  async function request(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
    const payload = await response.json();
    if (!response.ok || payload?.errors) {
      const detail = payload?.message ?? payload?.errors?.[0]?.message ?? response.statusText;
      throw new Error(`GitHub API request failed (${response.status}): ${detail}`);
    }
    return payload;
  }

  async function paginate(path, collectionKey) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const payload = await request(`${path}${separator}per_page=100&page=${page}`);
      const pageItems = Array.isArray(payload)
        ? payload
        : collectionKey
          ? payload?.[collectionKey]
          : null;
      if (!Array.isArray(pageItems)) {
        throw new Error(
          `GitHub API pagination payload is missing ${collectionKey ?? "an item array"}`,
        );
      }
      items.push(...pageItems);
      if (pageItems.length < 100) {
        return items;
      }
    }
  }

  async function graphql(query, variables) {
    return request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  }

  return { request, paginate, graphql };
}

async function readReviewThreads(client, repository, pullNumber) {
  const query = `
    query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            nodes { id isResolved }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const threads = [];
  let after = null;

  do {
    const payload = await client.graphql(query, {
      ...repository,
      number: pullNumber,
      after,
    });
    const connection = payload.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) {
      throw new Error("Pull request review threads are unavailable");
    }
    threads.push(...connection.nodes);
    after = graphqlNextPageCursor(
      connection.pageInfo,
      "Pull request review threads",
    );
  } while (after);

  return threads;
}

export function graphqlNextPageCursor(pageInfo, connectionName) {
  if (pageInfo?.hasNextPage !== true) {
    return null;
  }

  const endCursor = pageInfo?.endCursor;
  if (typeof endCursor !== "string" || endCursor.trim() === "") {
    throw new Error(
      `${connectionName} reported hasNextPage without a valid endCursor`,
    );
  }

  return endCursor;
}

export function parsePullRequestRunName(displayTitle) {
  const match = PR_RUN_NAME_PATTERN.exec(displayTitle ?? "");
  if (!match) {
    return null;
  }
  return {
    pullNumber: Number(match[1]),
    headSha: match[2].toLowerCase(),
    baseSha: match[3].toLowerCase(),
  };
}

export function pullRequestRunProvenance(run, pullRequest) {
  const provenance = parsePullRequestRunName(run?.display_title);
  if (
    run?.event !== "pull_request" ||
    run?.path !== CI_WORKFLOW_PATH ||
    run?.head_sha !== pullRequest?.headSha ||
    provenance?.pullNumber !== pullRequest?.number ||
    provenance?.headSha !== pullRequest?.headSha
  ) {
    return null;
  }
  return provenance;
}

export function selectLatestPullRequestWorkflowRun(workflowRuns, pullRequest) {
  const latest = latestRun(
    (workflowRuns ?? []).filter(
      (run) =>
        run?.event === "pull_request" &&
        run?.path === CI_WORKFLOW_PATH &&
        run?.head_sha === pullRequest?.headSha,
    ),
  );
  if (!latest) {
    return null;
  }
  const provenance = pullRequestRunProvenance(latest, pullRequest);
  return provenance ? { run: latest, provenance } : null;
}

export function currentWorkflowRunAttemptJobs(jobs, workflowRun) {
  return (jobs ?? []).filter(
    (job) =>
      job?.run_id === workflowRun?.id &&
      job?.run_attempt === workflowRun?.run_attempt,
  );
}

function normalizePullRequest(payload, currentBaseSha) {
  return {
    number: payload.number,
    url: payload.html_url,
    isDraft: payload.draft === true,
    state: payload.state,
    headSha: payload.head?.sha,
    baseSha: currentBaseSha,
    baseSnapshotSha: payload.base?.sha,
    baseRef: payload.base?.ref,
    updatedAt: payload.updated_at,
    author: {
      login: payload.user?.login,
      type: payload.user?.type,
    },
  };
}

export async function readPullRequestWithCurrentBase({
  client,
  prefix,
  pullNumber,
}) {
  const payload = await client.request(`${prefix}/pulls/${pullNumber}`);
  const baseRef = payload.base?.ref;
  let currentBaseSha;

  if (typeof baseRef === "string" && baseRef.trim() !== "") {
    const qualifiedRef = `heads/${baseRef}`;
    const encodedRef = qualifiedRef
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const refPayload = await client.request(`${prefix}/git/ref/${encodedRef}`);
    currentBaseSha = refPayload.object?.sha;
  }

  return normalizePullRequest(payload, currentBaseSha);
}

function compareCanonicalElements(left, right) {
  const leftValue = JSON.stringify(left);
  const rightValue = JSON.stringify(right);
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue < rightValue ? -1 : 1;
}

export function mergeGateEvidenceFingerprint(evidence) {
  const canonical = {
    checks: [...(evidence?.checks ?? [])]
      .map((check) => ({
        id: check.id ?? null,
        name: check.name ?? null,
        headSha: check.headSha ?? null,
        baseSha: check.baseSha ?? null,
        event: check.event ?? null,
        pullNumber: check.pullNumber ?? null,
        workflowRunId: check.workflowRunId ?? null,
        workflowRunAttempt: check.workflowRunAttempt ?? null,
        jobRunAttempt: check.jobRunAttempt ?? null,
        status: check.status ?? null,
        conclusion: check.conclusion ?? null,
        appSlug: check.appSlug ?? null,
        startedAt: check.startedAt ?? null,
        completedAt: check.completedAt ?? null,
      }))
      .sort(compareCanonicalElements),
    reviews: [...(evidence?.reviews ?? [])]
      .map((review) => ({
        id: review.id ?? null,
        state: review.state ?? null,
        commitSha: review.commitSha ?? null,
        submittedAt: review.submittedAt ?? null,
        body: review.body ?? null,
        authorLogin: review.author?.login ?? null,
        authorType: review.author?.type ?? null,
      }))
      .sort(compareCanonicalElements),
    reviewThreads: [...(evidence?.reviewThreads ?? [])]
      .map((thread) => ({
        id: thread.id ?? null,
        isResolved: thread.isResolved === true,
      }))
      .sort(compareCanonicalElements),
  };
  return JSON.stringify(canonical);
}

export async function readStableMergeGateSnapshot({
  readPullRequest,
  readEvidence,
  riskLevel,
  now = () => new Date().toISOString(),
  maxAttempts = 3,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await readPullRequest();
    const firstEvidence = await readEvidence(before.headSha, before);
    const secondEvidence = await readEvidence(before.headSha, before);
    const after = await readPullRequest();

    const pullRequestStable = JSON.stringify(before) === JSON.stringify(after);
    const evidenceStable =
      mergeGateEvidenceFingerprint(firstEvidence) ===
      mergeGateEvidenceFingerprint(secondEvidence);
    if (pullRequestStable && evidenceStable) {
      return {
        checkedAt: now(),
        riskLevel,
        pullRequest: after,
        ...secondEvidence,
      };
    }
  }

  throw new Error(
    "Pull request or merge-gate evidence changed repeatedly while collecting a snapshot; retry from the current head",
  );
}

async function readPullRequestWorkflowChecks(client, prefix, pullRequest) {
  const workflowRuns = await client.paginate(
    `${prefix}/actions/runs?event=pull_request&head_sha=${encodeURIComponent(pullRequest.headSha)}`,
    "workflow_runs",
  );
  const selected = selectLatestPullRequestWorkflowRun(
    workflowRuns,
    pullRequest,
  );
  if (!selected) {
    return [];
  }

  const { run, provenance } = selected;
  const jobs = await client.paginate(
    `${prefix}/actions/runs/${run.id}/jobs?filter=all`,
    "jobs",
  );
  return currentWorkflowRunAttemptJobs(jobs, run).map((job) => ({
    id: job.id,
    name: job.name,
    headSha: job.head_sha ?? run.head_sha,
    baseSha: provenance.baseSha,
    event: run.event,
    pullNumber: provenance.pullNumber,
    workflowRunId: run.id,
    workflowRunAttempt: run.run_attempt,
    jobRunAttempt: job.run_attempt,
    status: job.status,
    conclusion: job.conclusion,
    appSlug: "github-actions",
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.html_url,
  }));
}

async function readLiveSnapshot({ repository, pullNumber, riskLevel }) {
  const client = createGithubClient(readToken());
  const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;

  const readPullRequest = async () =>
    readPullRequestWithCurrentBase({ client, prefix, pullNumber });
  const readEvidence = async (_headSha, pullRequest) => {
    const [reviewPayloads, checks, reviewThreads] = await Promise.all([
      client.paginate(`${prefix}/pulls/${pullNumber}/reviews`),
      readPullRequestWorkflowChecks(client, prefix, pullRequest),
      readReviewThreads(client, repository, pullNumber),
    ]);
    return {
      reviews: reviewPayloads.map((review) => ({
        id: review.id,
        state: review.state,
        commitSha: review.commit_id,
        submittedAt: review.submitted_at,
        body: review.body,
        author: {
          login: review.user?.login,
          type: review.user?.type,
        },
      })),
      reviewThreads,
      checks,
    };
  };

  return readStableMergeGateSnapshot({
    readPullRequest,
    readEvidence,
    riskLevel,
  });
}

function parseArguments(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (["--repo", "--pr", "--risk", "--fixture"].includes(argument)) {
      options[argument.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function formatResult(result) {
  const lines = [
    `${result.ready ? "READY" : "BLOCKED"} PR #${result.pullNumber ?? "?"}`,
    `head=${result.headSha ?? "unknown"}`,
    `risk=${result.riskLevel ?? "unclassified"}`,
  ];

  for (const item of result.evidence) {
    if (item.type === "ci") {
      lines.push(`PASS ${item.check} (${item.headSha.slice(0, 12)})`);
    } else if (item.type === "review") {
      lines.push(`PASS current-head ${item.state} review signal by ${item.reviewer} [${item.signalKind}] (${item.headSha.slice(0, 12)})`);
    }
  }
  for (const blocker of result.blockers) {
    lines.push(`BLOCK ${blocker.code}: ${blocker.message}`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const options = parseArguments(argv);
  let snapshot;

  if (options.fixture) {
    snapshot = JSON.parse(await readFile(options.fixture, "utf8"));
    if (options.risk) {
      snapshot.riskLevel = options.risk;
    }
  } else {
    const repository = parseRepository(options.repo ?? process.env.GITHUB_REPOSITORY);
    const pullNumber = Number(options.pr);
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
      throw new Error("--pr must be a positive integer");
    }
    if (options.risk !== "normal" && options.risk !== "high") {
      throw new Error("--risk must be supplied as normal or high");
    }
    snapshot = await readLiveSnapshot({
      repository,
      pullNumber,
      riskLevel: options.risk,
    });
  }

  const result = evaluatePullRequestMergeGate(snapshot);
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : formatResult(result)}\n`);
  process.exitCode = result.ready ? 0 : 1;
}

const isEntrypoint = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 2;
  });
}
