import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const ZERO_SHA = /^0{40}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function runGit(args, { cwd, inherit = false } = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: inherit ? undefined : "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

function requireCommitSha(value, label, { allowZero = false } = {}) {
  const sha = String(value ?? "").trim();
  if (!COMMIT_SHA.test(sha) || (!allowZero && ZERO_SHA.test(sha))) {
    throw new Error(`${label} must be a non-zero 40-character commit SHA`);
  }
  return sha.toLowerCase();
}

function resolveRevision(ref, cwd) {
  if (!ref) return undefined;
  const result = runGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return COMMIT_SHA.test(sha) ? sha.toLowerCase() : undefined;
}

function mergeBase(leftSha, rightSha, cwd) {
  const result = runGit(["merge-base", leftSha, rightSha], { cwd });
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim().split(/\s+/)[0];
  return COMMIT_SHA.test(sha) ? sha.toLowerCase() : undefined;
}

function candidateBaselineRefs(pushBaseRef, defaultBranch) {
  const candidates = [];
  if (pushBaseRef) {
    candidates.push(pushBaseRef);
    if (pushBaseRef.startsWith("refs/heads/")) {
      candidates.push(`refs/remotes/origin/${pushBaseRef.slice("refs/heads/".length)}`);
    }
  }
  if (defaultBranch) {
    candidates.push(`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`);
  }
  return [...new Set(candidates)];
}

function resolveNewBranchBase({ pushBaseRef, defaultBranch, headSha, cwd }) {
  for (const ref of candidateBaselineRefs(pushBaseRef, defaultBranch)) {
    const baselineSha = resolveRevision(ref, cwd);
    if (!baselineSha) continue;
    const baseSha = mergeBase(baselineSha, headSha, cwd);
    if (baseSha) return { baseSha, baselineRef: ref };
  }
  return undefined;
}

export function resolveCommittedWhitespaceRange(environment, { cwd = process.cwd() } = {}) {
  const eventName = String(environment.EVENT_NAME ?? "").trim();

  if (eventName === "pull_request") {
    const baseSha = requireCommitSha(environment.PR_BASE_SHA, "PR_BASE_SHA");
    const headSha = requireCommitSha(environment.PR_HEAD_SHA, "PR_HEAD_SHA");
    return { baseSha, headSha, mode: "pull_request_commit_range" };
  }

  if (eventName === "push") {
    const beforeSha = requireCommitSha(environment.PUSH_BEFORE_SHA, "PUSH_BEFORE_SHA", { allowZero: true });
    const headSha = requireCommitSha(environment.PUSH_AFTER_SHA, "PUSH_AFTER_SHA");
    if (!ZERO_SHA.test(beforeSha)) {
      return { baseSha: beforeSha, headSha, mode: "push_commit_range" };
    }

    const newBranchBase = resolveNewBranchBase({
      pushBaseRef: String(environment.PUSH_BASE_REF ?? "").trim(),
      defaultBranch: String(environment.DEFAULT_BRANCH ?? "").trim(),
      headSha,
      cwd,
    });
    if (newBranchBase) {
      return {
        baseSha: newBranchBase.baseSha,
        headSha,
        mode: "new_branch_merge_base",
        baselineRef: newBranchBase.baselineRef,
      };
    }
    return { baseSha: EMPTY_TREE_SHA, headSha, mode: "new_branch_full_tree" };
  }

  throw new Error(`Unsupported event: ${eventName || "<empty>"}`);
}

export function checkCommittedWhitespace(environment, { cwd = process.cwd() } = {}) {
  const range = resolveCommittedWhitespaceRange(environment, { cwd });
  const baseline = range.baselineRef ? ` via ${range.baselineRef}` : "";
  console.log(`Checking committed whitespace (${range.mode}${baseline}): ${range.baseSha}..${range.headSha}`);
  const result = runGit(["diff", "--check", range.baseSha, range.headSha], { cwd, inherit: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git diff --check failed for ${range.baseSha}..${range.headSha}`);
  }
  return range;
}

const isMainModule = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  try {
    checkCommittedWhitespace(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
