import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EMPTY_TREE_SHA, resolveCommittedWhitespaceRange } from "../scripts/check-committed-whitespace.mjs";

const ZERO_SHA = "0".repeat(40);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createRepository(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "tackle-forger-ci-range-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "CI Range Test");
  git(cwd, "config", "user.email", "ci-range@example.invalid");
  await writeFile(path.join(cwd, "historical.txt"), "historical trailing whitespace   \n");
  git(cwd, "add", "historical.txt");
  git(cwd, "commit", "-m", "historical baseline");
  const mainSha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/remotes/origin/main", mainSha);
  return { cwd, mainSha };
}

function diffCheck(cwd, baseSha, headSha) {
  return spawnSync("git", ["diff", "--check", baseSha, headSha], { cwd, encoding: "utf8" });
}

test("新分支首次 push 从默认分支共同祖先检查，不回扫历史空白", async (t) => {
  const { cwd, mainSha } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "feature.txt"), "clean feature\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feature change");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: ZERO_SHA,
    PUSH_AFTER_SHA: headSha,
    DEFAULT_BRANCH: "main",
  }, { cwd });

  assert.equal(range.mode, "new_branch_merge_base");
  assert.equal(range.baseSha, mainSha);
  assert.equal(diffCheck(cwd, range.baseSha, range.headSha).status, 0);
  assert.notEqual(diffCheck(cwd, EMPTY_TREE_SHA, range.headSha).status, 0);
});

test("新分支本次新增的 trailing whitespace 仍失败并定位文件", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "feature.txt"), "new trailing whitespace   \n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "bad feature change");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: ZERO_SHA,
    PUSH_AFTER_SHA: headSha,
    DEFAULT_BRANCH: "main",
  }, { cwd });
  const result = diffCheck(cwd, range.baseSha, range.headSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /feature\.txt:1: trailing whitespace/);
});

test("新分支首次 push 优先使用事件 base_ref", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "release");
  await writeFile(path.join(cwd, "release.txt"), "release baseline\n");
  git(cwd, "add", "release.txt");
  git(cwd, "commit", "-m", "release baseline");
  const releaseSha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/remotes/origin/release", releaseSha);
  git(cwd, "switch", "-c", "feature-from-release");
  git(cwd, "branch", "-D", "release");
  await writeFile(path.join(cwd, "feature.txt"), "clean feature\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feature from release");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: ZERO_SHA,
    PUSH_AFTER_SHA: headSha,
    PUSH_BASE_REF: "refs/heads/release",
    DEFAULT_BRANCH: "main",
  }, { cwd });

  assert.equal(range.baseSha, releaseSha);
  assert.equal(range.baselineRef, "refs/remotes/origin/release");
});

test("共同基线不可用时从空树检查，不能只检查 head 父提交", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "feature.txt"), "clean feature\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feature change");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: ZERO_SHA,
    PUSH_AFTER_SHA: headSha,
  }, { cwd });

  assert.equal(range.mode, "new_branch_full_tree");
  assert.equal(range.baseSha, EMPTY_TREE_SHA);
  assert.notEqual(diffCheck(cwd, range.baseSha, range.headSha).status, 0);
});

test("常规 push 只检查事件给出的 before 到 after", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "first.txt"), "first clean change\n");
  git(cwd, "add", "first.txt");
  git(cwd, "commit", "-m", "first push");
  const beforeSha = git(cwd, "rev-parse", "HEAD");
  await writeFile(path.join(cwd, "second.txt"), "new trailing whitespace   \n");
  git(cwd, "add", "second.txt");
  git(cwd, "commit", "-m", "second push");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: beforeSha,
    PUSH_AFTER_SHA: headSha,
  }, { cwd });

  assert.deepEqual(range, { baseSha: beforeSha, headSha, mode: "push_commit_range" });
  const result = diffCheck(cwd, range.baseSha, range.headSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /second\.txt:1: trailing whitespace/);
});

test("Pull Request 保持使用事件 base 到 head 的范围", async (t) => {
  const { cwd, mainSha } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "feature.txt"), "clean feature\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feature change");
  const headSha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "main");
  await writeFile(path.join(cwd, "base-only.txt"), "target branch trailing whitespace   \n");
  git(cwd, "add", "base-only.txt");
  git(cwd, "commit", "-m", "target branch advanced");
  const pullRequestBaseSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "pull_request",
    PR_BASE_SHA: pullRequestBaseSha,
    PR_HEAD_SHA: headSha,
  }, { cwd });

  assert.equal(range.mode, "pull_request_commit_range");
  assert.equal(range.baseSha, pullRequestBaseSha);
  assert.notEqual(range.baseSha, mainSha);
  assert.equal(diffCheck(cwd, range.baseSha, range.headSha).status, 0);
});

test("无共同祖先的两提交首次 push 会定位第一提交的 trailing whitespace", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "--orphan", "orphan-feature");
  await writeFile(path.join(cwd, "first.txt"), "first commit trailing whitespace   \n");
  git(cwd, "add", "first.txt");
  git(cwd, "commit", "-m", "orphan first commit");
  await writeFile(path.join(cwd, "second.txt"), "clean second commit\n");
  git(cwd, "add", "second.txt");
  git(cwd, "commit", "-m", "orphan second commit");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: ZERO_SHA,
    PUSH_AFTER_SHA: headSha,
    DEFAULT_BRANCH: "main",
  }, { cwd });

  assert.equal(range.mode, "new_branch_full_tree");
  assert.equal(range.baseSha, EMPTY_TREE_SHA);
  const result = diffCheck(cwd, range.baseSha, range.headSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /first\.txt:1: trailing whitespace/);
});
