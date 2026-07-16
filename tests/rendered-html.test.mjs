import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

test("生产构建包含完整工作台客户端与 Worker", async () => {
  const assetRoot = new URL("../dist/client/assets/", import.meta.url);
  const files = await readdir(assetRoot);
  const scripts = files.filter((name) => name.endsWith(".js"));
  const styles = files.filter((name) => name.endsWith(".css"));
  assert.ok(scripts.length > 0, "应生成客户端 JavaScript");
  assert.ok(styles.length > 0, "应生成工作台样式");
  const [scriptContents, styleContents, workerInfo] = await Promise.all([
    Promise.all(scripts.map((name) => readFile(new URL(name, assetRoot), "utf8"))),
    Promise.all(styles.map((name) => readFile(new URL(name, assetRoot), "utf8"))),
    stat(new URL("../dist/server/index.js", import.meta.url)),
  ]);
  const script = scriptContents.join("\n");
  const css = styleContents.join("\n");
  assert.match(script, /钓具配置工坊/);
  assert.match(script, /候选池/);
  assert.match(script, /_TackleForgerState/);
  assert.match(css, /\.workbench/);
  assert.ok(workerInfo.size > 0);
});
