import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EMPTY_TREE_SHA, resolveCommittedWhitespaceRange } from "../scripts/check-committed-whitespace.mjs";

const ZERO_SHA = "0".repeat(40);
// A syntactically valid 40-char SHA that will not exist in any test repository
// built here. Models `github.event.before` after a force-push/rebase that
// rewrote history and left the previous tip unreachable in a fresh Actions
// checkout.
const UNREACHABLE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

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

test("force-push 后 before-SHA 不可达时回退到与默认分支的 merge-base", async (t) => {
  const { cwd, mainSha } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "feature.txt"), "clean feature\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feature change");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: UNREACHABLE_SHA,
    PUSH_AFTER_SHA: headSha,
    DEFAULT_BRANCH: "main",
  }, { cwd });

  assert.equal(range.mode, "forced_push_merge_base");
  assert.equal(range.baseSha, mainSha);
  assert.equal(range.headSha, headSha);
  assert.equal(range.baselineRef, "refs/remotes/origin/main");
  assert.ok(range.fallbackReason, "fallback reason must be surfaced in the resolved range");
  assert.ok(range.fallbackReason.includes(UNREACHABLE_SHA), "fallback reason must name the unreachable before SHA");
  // 干净的 feature 提交不得误报失败
  assert.equal(diffCheck(cwd, range.baseSha, range.headSha).status, 0);
});

test("before-SHA 不可达回退后仍检出本次引入的 trailing whitespace（不静默放过）", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "feature.txt"), "new trailing whitespace   \n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "bad feature change");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: UNREACHABLE_SHA,
    PUSH_AFTER_SHA: headSha,
    DEFAULT_BRANCH: "main",
  }, { cwd });
  const result = diffCheck(cwd, range.baseSha, range.headSha);

  assert.equal(range.mode, "forced_push_merge_base");
  assert.ok(range.fallbackReason);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /feature\.txt:1: trailing whitespace/);
});

test("before-SHA 不可达且无可信共同基线时回退到空树全树检查（多提交 head）", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  // createRepository 在 main 上提交了带 trailing whitespace 的 historical.txt；
  // feature 分支继承该文件，空树全树检查会被它命中，故先移除以聚焦"无基线 → 全树"路径。
  git(cwd, "rm", "-f", "historical.txt");
  await writeFile(path.join(cwd, "first.txt"), "first clean change\n");
  git(cwd, "add", "first.txt");
  git(cwd, "commit", "-m", "first commit");
  await writeFile(path.join(cwd, "second.txt"), "second clean change\n");
  git(cwd, "add", "second.txt");
  git(cwd, "commit", "-m", "second commit");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: UNREACHABLE_SHA,
    PUSH_AFTER_SHA: headSha,
    // 故意不传 DEFAULT_BRANCH / PUSH_BASE_REF，逼出无共同基线 → 全树回退路径
  }, { cwd });

  assert.equal(range.mode, "forced_push_full_tree");
  assert.equal(range.baseSha, EMPTY_TREE_SHA);
  assert.equal(range.headSha, headSha);
  assert.ok(range.fallbackReason);
  assert.ok(range.fallbackReason.includes("full-tree"));
  assert.equal(diffCheck(cwd, range.baseSha, range.headSha).status, 0);
});

test("before-SHA 不可达且无共同基线时全树检查仍检出较早提交引入的 trailing whitespace", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  // 倒数第二个提交写入 trailing whitespace；末提交不触碰该文件。
  await writeFile(path.join(cwd, "early.txt"), "early commit trailing whitespace   \n");
  git(cwd, "add", "early.txt");
  git(cwd, "commit", "-m", "early bad commit");
  await writeFile(path.join(cwd, "late.txt"), "clean late commit\n");
  git(cwd, "add", "late.txt");
  git(cwd, "commit", "-m", "late clean commit");
  const headSha = git(cwd, "rev-parse", "HEAD");
  const headParent = git(cwd, "rev-parse", "HEAD^");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: UNREACHABLE_SHA,
    PUSH_AFTER_SHA: headSha,
    // 不传 DEFAULT_BRANCH / PUSH_BASE_REF：无可信共同基线
  }, { cwd });

  assert.equal(range.mode, "forced_push_full_tree");
  assert.equal(range.baseSha, EMPTY_TREE_SHA);
  // 旧的 head^..head 回退只会检查末提交（late.txt 干净），从而静默放过 early.txt。
  assert.equal(diffCheck(cwd, headParent, headSha).status, 0);
  // 全树回退必须检出较早提交引入的 trailing whitespace 并定位文件，不得静默放过。
  const result = diffCheck(cwd, range.baseSha, range.headSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /early\.txt:1: trailing whitespace/);
});

test("before-SHA 不可达且 head 为孤儿根提交时回退到空树全树检查", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "--orphan", "orphan-feature");
  // --orphan leaves the baseline historical.txt (with trailing whitespace) in
  // the working tree but unstaged; drop it tolerantly so this commit stays
  // clean and the test focuses on the full-tree fallback path.
  git(cwd, "rm", "-f", "--ignore-unmatch", "historical.txt");
  await writeFile(path.join(cwd, "orphan.txt"), "clean orphan\n");
  git(cwd, "add", "orphan.txt");
  git(cwd, "commit", "-m", "orphan root");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: UNREACHABLE_SHA,
    PUSH_AFTER_SHA: headSha,
  }, { cwd });

  assert.equal(range.mode, "forced_push_full_tree");
  assert.equal(range.baseSha, EMPTY_TREE_SHA);
  assert.equal(range.headSha, headSha);
  assert.ok(range.fallbackReason);
  assert.ok(range.fallbackReason.includes("full-tree"));
  assert.equal(diffCheck(cwd, range.baseSha, range.headSha).status, 0);
});

test("常规 push 的 before-SHA 可达时不进入回退路径（无 fallback 字段）", async (t) => {
  const { cwd } = await createRepository(t);
  git(cwd, "switch", "-c", "feature");
  await writeFile(path.join(cwd, "first.txt"), "first clean change\n");
  git(cwd, "add", "first.txt");
  git(cwd, "commit", "-m", "first push");
  const beforeSha = git(cwd, "rev-parse", "HEAD");
  await writeFile(path.join(cwd, "second.txt"), "second clean change\n");
  git(cwd, "add", "second.txt");
  git(cwd, "commit", "-m", "second push");
  const headSha = git(cwd, "rev-parse", "HEAD");

  const range = resolveCommittedWhitespaceRange({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: beforeSha,
    PUSH_AFTER_SHA: headSha,
    DEFAULT_BRANCH: "main",
  }, { cwd });

  assert.deepEqual(range, { baseSha: beforeSha, headSha, mode: "push_commit_range" });
  assert.equal("fallbackReason" in range, false);
});
