import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listRevisions, loadRevision, loadWorkspaceState, saveWorkspaceState } from "../lib/storage";
import { closeSqliteStorage } from "../lib/sqlite-storage";

test("SQLite 保存可跨读取、冲突受保护且历史版本冻结", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-storage-"));
  process.env.WORKSPACE_DATABASE_PATH = path.join(directory, "workspace.sqlite");
  const databasePath = process.env.WORKSPACE_DATABASE_PATH;
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    delete process.env.WORKSPACE_DATABASE_PATH;
    await rm(directory, { recursive: true, force: true });
  });
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  const initial = await loadWorkspaceState();
  const changed = structuredClone(initial.state);
  const previousNotes = initial.state.affixScorePolicy.notes;
  const savedNotes = `local-runtime-saved-${Date.now()}-${crypto.randomUUID()}`;
  changed.affixScorePolicy.notes = savedNotes;
  const saved = await saveWorkspaceState({
    state: changed,
    baseRevision: initial.revision,
    author: "test",
    message: "验证本地一致性存储",
  });
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal((await loadWorkspaceState()).state.affixScorePolicy.notes, savedNotes);
  assert.equal((await listRevisions())[0]?.revision, saved.revision);
  assert.equal((await loadRevision(initial.revision))?.affixScorePolicy.notes, previousNotes);
  assert.notEqual((await loadRevision(initial.revision))?.affixScorePolicy.notes, savedNotes);
  const conflict = await saveWorkspaceState({
    state: initial.state,
    baseRevision: initial.revision,
    author: "stale",
    message: "过期写入",
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.revision, saved.revision);
});

test("SQLite 并发写入同一基线 revision 时只有一个成功，其余进入冲突", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-storage-concurrency-"));
  process.env.WORKSPACE_DATABASE_PATH = path.join(directory, "workspace.sqlite");
  const databasePath = process.env.WORKSPACE_DATABASE_PATH;
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    delete process.env.WORKSPACE_DATABASE_PATH;
    await rm(directory, { recursive: true, force: true });
  });
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  const initial = await loadWorkspaceState();
  const buildState = (suffix: string) => {
    const state = structuredClone(initial.state);
    state.affixScorePolicy.notes = `concurrent-${suffix}-${Date.now()}`;
    return state;
  };
  const results = await Promise.all([
    saveWorkspaceState({ state: buildState("a"), baseRevision: initial.revision, author: "a", message: "并发 a" }),
    saveWorkspaceState({ state: buildState("b"), baseRevision: initial.revision, author: "b", message: "并发 b" }),
    saveWorkspaceState({ state: buildState("c"), baseRevision: initial.revision, author: "c", message: "并发 c" }),
  ]);
  const successes = results.filter((result) => !result.conflict);
  const conflicts = results.filter((result) => result.conflict);
  assert.equal(successes.length, 1, "同一基线 revision 的并发写入只应有一个成功");
  assert.equal(conflicts.length, 2, "其余并发写入应因基线已前进而冲突");
  assert.equal((await loadWorkspaceState()).revision, initial.revision + 1);
});
