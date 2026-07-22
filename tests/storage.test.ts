import assert from "node:assert/strict";
import test from "node:test";
import { listRevisions, loadRevision, loadWorkspaceState, saveWorkspaceState } from "../lib/storage";

test("无云存储的单实例保存可回读、冲突受保护且历史版本冻结", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  const initial = await loadWorkspaceState();
  const changed = structuredClone(initial.state);
  changed.affixScorePolicy.notes = "local-runtime-saved";
  const saved = await saveWorkspaceState({
    state: changed,
    baseRevision: initial.revision,
    author: "test",
    message: "验证本地一致性存储",
  });
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal((await loadWorkspaceState()).state.affixScorePolicy.notes, "local-runtime-saved");
  assert.equal((await listRevisions())[0]?.revision, saved.revision);
  assert.notEqual((await loadRevision(initial.revision))?.affixScorePolicy.notes, "local-runtime-saved");
  const conflict = await saveWorkspaceState({
    state: initial.state,
    baseRevision: initial.revision,
    author: "stale",
    message: "过期写入",
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.revision, saved.revision);
});
