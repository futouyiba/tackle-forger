import assert from "node:assert/strict";
import test from "node:test";
import { approveMethodTemplateWrite, executeMethodTemplateWrite, prepareMethodTemplateWrite } from "../lib/method-template-writeback";

const prepared = () => prepareMethodTemplateWrite({ sourceRevision: "4227", sourceHash: "hash", idempotencyKey: "key-1", commands: [{ sheetId: "m3eQCg", cell: "B3", value: 1.2, stableId: "fshg_rod_0001" }] });

test("02.5 写回必须审核、基线一致且回读完整才进入 REMOTE_CHANGES_AVAILABLE", async () => {
  assert.throws(() => approveMethodTemplateWrite(prepared(), ""));
  const result = await executeMethodTemplateWrite(approveMethodTemplateWrite(prepared(), "reviewer"), {
    getCurrentRevision: async () => "4227",
    write: async () => {},
    readback: async () => [{ cell: "B3", value: 1.2, stableId: "fshg_rod_0001" }],
  });
  assert.equal(result.state, "REMOTE_CHANGES_AVAILABLE");
});

test("02.5 冲突或部分失败只能恢复验证，不能静默激活", async () => {
  const approved = approveMethodTemplateWrite(prepared(), "reviewer");
  const conflict = await executeMethodTemplateWrite(approved, { getCurrentRevision: async () => "4228", write: async () => {}, readback: async () => [] });
  assert.equal(conflict.state, "NEEDS_REBASE");
  const recovered = await executeMethodTemplateWrite(approved, { getCurrentRevision: async () => "4227", write: async () => { throw new Error("timeout"); }, readback: async () => [{ cell: "B3", value: 1.2, stableId: "fshg_rod_0001" }] });
  assert.equal(recovered.state, "REMOTE_CHANGES_AVAILABLE");
  assert.equal(recovered.recoveredAfterWriteError, true);
  const mismatch = await executeMethodTemplateWrite(approved, { getCurrentRevision: async () => "4227", write: async () => {}, readback: async () => [{ cell: "B3", value: 1.1, stableId: "fshg_rod_0001" }] });
  assert.equal(mismatch.state, "WRITE_FAILED");
});
