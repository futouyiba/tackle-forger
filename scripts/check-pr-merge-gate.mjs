#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REQUIRED_CURRENT_HEAD_CHECKS = [
  "Root v3 app (npm)",
  "Historical workspace (pnpm)",
  "Windows line-ending policy",
];

const DECISIVE_REVIEW_STATES = new Set([
  "APPROVED",
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
  // GitHub check-run IDs are monotonic. A rerun can be queued before it has
  // started_at/completed_at, so timestamps must never make an older completed
  // run override the newer pending run.
  return [...runs].sort(compareIds).at(-1);
}

function currentHeadReviewState({ reviews, headSha }) {
  const latestDecisionByReviewer = new Map();
  const orderedReviews = Array.isArray(reviews)
    ? [...reviews].sort((left, right) =>
        compareByTimeAndId(left, right, "submittedAt"),
      )
    : [];

  for (const review of orderedReviews) {
    const state = String(review?.state ?? "").toUpperCase();
    const reviewerKey = userKey(review?.author);
    if (!reviewerKey || !DECISIVE_REVIEW_STATES.has(state)) {
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
    const state = String(review?.state ?? "").toUpperCase();
    const reviewerKey = userKey(review?.author);
    if (
      !reviewerKey ||
      review.commitSha !== headSha ||
      (state !== "APPROVED" && state !== "COMMENTED")
    ) {
      return false;
    }

    const laterDecision = latestDecisionByReviewer.get(reviewerKey);
    return !laterDecision ||
      compareByTimeAndId(laterDecision, review, "submittedAt") <= 0 ||
      laterDecision.state === "APPROVED";
  });

  return { signal };
}

export function evaluatePullRequestMergeGate(snapshot) {
  const pullRequest = snapshot?.pullRequest ?? {};
  const headSha = pullRequest.headSha;
  const riskLevel = snapshot?.riskLevel;
  const blockers = [];
  const evidence = [];

  if (!/^[a-f0-9]{40}$/i.test(headSha ?? "")) {
    blockers.push({
      code: "CURRENT_HEAD_UNAVAILABLE",
      message: "Pull request current head SHA is unavailable",
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

    const run = latestRun(currentHeadRuns);
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
      runId: run.id,
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

  if (riskLevel === "high") {
    const reviewState = currentHeadReviewState({
      reviews: snapshot?.reviews,
      headSha,
    });
    if (reviewState.activeChangeRequest) {
      blockers.push({
        code: "REVIEW_CHANGES_REQUESTED",
        message: "A current-head review still requests changes",
      });
    } else if (!reviewState.signal) {
      blockers.push({
        code: "CURRENT_HEAD_REVIEW_SIGNAL_REQUIRED",
        message:
          "High-risk changes require a current-head COMMENTED or APPROVED review signal",
      });
    } else {
      evidence.push({
        type: "review",
        headSha,
        reviewId: reviewState.signal.id,
        reviewer: reviewState.signal.author.login,
        state: String(reviewState.signal.state).toUpperCase(),
        submittedAt: reviewState.signal.submittedAt,
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

  async function paginate(path) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const payload = await request(`${path}${separator}per_page=100&page=${page}`);
      const pageItems = Array.isArray(payload) ? payload : payload.check_runs;
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

function normalizePullRequest(payload) {
  return {
    number: payload.number,
    url: payload.html_url,
    isDraft: payload.draft === true,
    state: payload.state,
    headSha: payload.head?.sha,
    updatedAt: payload.updated_at,
    author: {
      login: payload.user?.login,
      type: payload.user?.type,
    },
  };
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
    const firstEvidence = await readEvidence(before.headSha);
    const secondEvidence = await readEvidence(before.headSha);
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

async function readLiveSnapshot({ repository, pullNumber, riskLevel }) {
  const client = createGithubClient(readToken());
  const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;

  const readPullRequest = async () =>
    normalizePullRequest(
      await client.request(`${prefix}/pulls/${pullNumber}`),
    );
  const readEvidence = async (headSha) => {
    const [reviewPayloads, checkPayloads, reviewThreads] = await Promise.all([
      client.paginate(`${prefix}/pulls/${pullNumber}/reviews`),
      client.paginate(`${prefix}/commits/${headSha}/check-runs?filter=all`),
      readReviewThreads(client, repository, pullNumber),
    ]);
    return {
      reviews: reviewPayloads.map((review) => ({
        id: review.id,
        state: review.state,
        commitSha: review.commit_id,
        submittedAt: review.submitted_at,
        author: {
          login: review.user?.login,
          type: review.user?.type,
        },
      })),
      reviewThreads,
      checks: checkPayloads.map((check) => ({
        id: check.id,
        name: check.name,
        headSha: check.head_sha,
        status: check.status,
        conclusion: check.conclusion,
        appSlug: check.app?.slug,
        startedAt: check.started_at,
        completedAt: check.completed_at,
        url: check.html_url,
      })),
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
      lines.push(`PASS current-head ${item.state} review signal by ${item.reviewer} (${item.headSha.slice(0, 12)})`);
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
