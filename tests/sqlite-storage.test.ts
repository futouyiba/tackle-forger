import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeSqliteStorage,
  importSqliteWorkspace,
  listSqliteRevisions,
  loadSqliteWorkspace,
  saveSqliteImportedFile,
  saveSqliteWorkspace,
} from "../lib/sqlite-storage";
import { createSeedState } from "../lib/seed";

test("SQLite 导入历史版本后保持当前 revision 和冻结历史", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-sqlite-import-"));
  const databasePath = path.join(directory, "workspace.sqlite");
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    await rm(directory, { recursive: true, force: true });
  });
  const first = createSeedState();
  const second = structuredClone(first);
  second.affixScorePolicy.notes = "migrated-revision-2";
  await importSqliteWorkspace(databasePath, {
    state: second,
    revision: 2,
    revisions: [
      { revision: 2, state: second, author: "migration", message: "second", createdAt: "2026-07-22T00:00:01.000Z" },
      { revision: 1, state: first, author: "migration", message: "first", createdAt: "2026-07-22T00:00:00.000Z" },
    ],
  });
  assert.equal((await loadSqliteWorkspace(databasePath)).revision, 2);
  assert.deepEqual((await listSqliteRevisions(databasePath)).map((entry) => entry.revision), [2, 1]);
});

test("SQLite 保存使用 revision 条件更新并持久化内容", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-sqlite-save-"));
  const databasePath = path.join(directory, "workspace.sqlite");
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    await rm(directory, { recursive: true, force: true });
  });

  const loaded = await loadSqliteWorkspace(databasePath);
  const changed = structuredClone(loaded.state);
  changed.affixScorePolicy.notes = "persisted-through-sqlite";
  const saved = await saveSqliteWorkspace(databasePath, {
    state: changed,
    baseRevision: loaded.revision,
    author: "tester",
    message: "save",
  });
  assert.deepEqual(saved, { revision: loaded.revision + 1 });
  const reloaded = await loadSqliteWorkspace(databasePath);
  assert.equal(reloaded.revision, loaded.revision + 1);
  assert.equal(reloaded.state.affixScorePolicy.notes, "persisted-through-sqlite");
});

test("SQLite 过期 baseRevision 返回冲突且不新增历史", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-sqlite-conflict-"));
  const databasePath = path.join(directory, "workspace.sqlite");
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    await rm(directory, { recursive: true, force: true });
  });

  const loaded = await loadSqliteWorkspace(databasePath);
  const first = structuredClone(loaded.state);
  first.affixScorePolicy.notes = "first-save";
  const saved = await saveSqliteWorkspace(databasePath, {
    state: first,
    baseRevision: loaded.revision,
    author: "first",
    message: "first",
  });
  assert.equal(saved.revision, loaded.revision + 1);

  const stale = structuredClone(loaded.state);
  stale.affixScorePolicy.notes = "must-not-overwrite";
  const conflict = await saveSqliteWorkspace(databasePath, {
    state: stale,
    baseRevision: loaded.revision,
    author: "stale",
    message: "stale",
  });
  assert.deepEqual(conflict, { revision: loaded.revision + 1, conflict: true });
  assert.deepEqual((await listSqliteRevisions(databasePath)).map((entry) => entry.revision), [loaded.revision + 1, loaded.revision]);
  assert.equal((await loadSqliteWorkspace(databasePath)).state.affixScorePolicy.notes, "first-save");
});

test("SQLite 导入文件会原子落盘并记录元数据", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-sqlite-file-"));
  const databasePath = path.join(directory, "workspace.sqlite");
  const dataDir = path.join(directory, "files");
  t.after(async () => {
    await closeSqliteStorage(databasePath);
    await rm(directory, { recursive: true, force: true });
  });
  const file = new File(["workbook-content"], "规则 表.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const saved = await saveSqliteImportedFile(databasePath, dataDir, file, "tester");
  assert.equal(saved.stored, true);
  const target = path.join(dataDir, saved.key);
  assert.equal((await stat(target)).size, file.size);
  assert.equal(await readFile(target, "utf8"), "workbook-content");
});
