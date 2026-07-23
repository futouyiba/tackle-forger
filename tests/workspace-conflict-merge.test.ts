import assert from "node:assert/strict";
import test from "node:test";
import { mergeWorkspaceConflict } from "../lib/workspace-conflict-merge";
import { createSeedState } from "../lib/seed";

test("工作区冲突三方合并只重放 local-only 普通字段，保留 remote-only 字段", () => {
  const baseline = createSeedState();
  const draft = structuredClone(baseline) as typeof baseline & Record<string, unknown>;
  const latest = structuredClone(baseline) as typeof baseline & Record<string, unknown>;
  draft.notes = "local note";
  draft.futureWorkspaceField = { local: true };
  latest.compatibilityRules = [];
  latest.futureRemoteField = { remote: true };

  const merged = mergeWorkspaceConflict({ baseline, draft, latest });
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.replayedLocalFields, ["futureWorkspaceField", "notes"]);
  assert.equal(merged.state.notes, "local note");
  assert.deepEqual((merged.state as unknown as Record<string, unknown>).futureWorkspaceField, { local: true });
  assert.deepEqual(merged.state.compatibilityRules, []);
  assert.deepEqual((merged.state as unknown as Record<string, unknown>).futureRemoteField, { remote: true });
});

test("同一普通字段双方变化安全阻断，直到用户显式选择", () => {
  const baseline = createSeedState();
  const draft = structuredClone(baseline);
  const latest = structuredClone(baseline);
  draft.notes = "local note";
  latest.notes = "remote note";

  const merged = mergeWorkspaceConflict({ baseline, draft, latest });
  assert.deepEqual(merged.conflicts, ["notes"]);
  assert.deepEqual(merged.replayedLocalFields, []);
  assert.equal(merged.state.notes, "remote note");
});

test("受治理字段永远使用最新值，未知普通字段仍保留", () => {
  const baseline = createSeedState();
  const draft = structuredClone(baseline) as typeof baseline & Record<string, unknown>;
  const latest = structuredClone(baseline) as typeof baseline & Record<string, unknown>;
  draft.seriesDefinitions.push({ ...draft.seriesDefinitions[0]!, id: "series:stale" });
  latest.seriesDefinitions.push({ ...latest.seriesDefinitions[0]!, id: "series:latest" });
  draft.futureWorkspaceField = { nested: "local" };

  const merged = mergeWorkspaceConflict({ baseline, draft, latest });
  assert.ok(merged.state.seriesDefinitions.some((entry) => entry.id === "series:latest"));
  assert.equal(merged.state.seriesDefinitions.some((entry) => entry.id === "series:stale"), false);
  assert.deepEqual((merged.state as unknown as Record<string, unknown>).futureWorkspaceField, { nested: "local" });
});
