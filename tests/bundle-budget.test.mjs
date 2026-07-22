import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const CLIENT_CHUNK_LIMIT_BYTES = 500_000;
const WORKBENCH_ENTRY_LIMIT_BYTES = 150_000;

test("生产客户端 chunk 保持在审计预算内且工作台模块已动态拆分", async () => {
  const manifest = JSON.parse(await readFile("dist/client/.vite/manifest.json", "utf8"));
  const javascript = [...new Set(Object.values(manifest)
    .map((entry) => entry.file)
    .filter((file) => file.endsWith(".js")))];
  const sizes = await Promise.all(javascript.map(async (file) => ({
    file,
    size: (await stat(`dist/client/${file}`)).size,
  })));
  const oversized = sizes.filter((entry) => entry.size > CLIENT_CHUNK_LIMIT_BYTES);
  assert.deepEqual(oversized, [], `超过 ${CLIENT_CHUNK_LIMIT_BYTES} bytes: ${JSON.stringify(oversized)}`);

  for (const source of [
    "app/SeriesGanttWorkbenchV3.tsx",
    "app/V3FlowWorkbench.tsx",
    "app/RuleGraphStudio.tsx",
    "app/RuleWorkbookWorkbench.tsx",
    "app/PatchLedgerWorkbench.tsx",
    "app/BrowserConfigExportWorkbench.tsx",
  ]) {
    assert.equal(manifest[source]?.isDynamicEntry, true, `${source} 应为动态入口`);
  }
  const workbench = manifest["app/Workbench.tsx"];
  assert.ok(workbench?.file, "缺少 Workbench 客户端入口");
  assert.ok((await stat(`dist/client/${workbench.file}`)).size <= WORKBENCH_ENTRY_LIMIT_BYTES);
});
