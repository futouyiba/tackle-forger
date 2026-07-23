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
  assert.match(script, /飞书规则源/);
  assert.match(script, /显式拉取/);
  assert.match(script, /Patch 权威台账/);
  assert.match(script, /创建个体 Patch 草稿/);
  assert.match(script, /个体 Patch 汇总分析/);
  assert.match(script, /批准 revision/);
  assert.match(script, /飞书 Patch 台账连接器未配置/);
  assert.match(script, /创建 Series 与离散 SKU/);
  assert.match(script, /目标拉力规格 · 明确离散列表/);
  assert.match(script, /精确目标拉力/);
  assert.match(script, /第 1 层 · 先看对象与发布风险/);
  assert.match(script, /第 2 层 · 再看五维表现与适配依据/);
  assert.match(script, /Series 基准策略/);
  assert.match(script, /草稿定义 · OPEN-005/);
  assert.match(script, /规划拉力范围（可选）· 不参与 SKU 生成/);
  assert.match(script, /SeriesRecipe 已转为只读历史/);
  assert.match(script, /旧 Candidate 结果仅供迁移审计/);
  assert.match(script, /OfficialSku 已转为只读历史/);
  assert.match(script, /DetailOverride 已转为只读历史/);
  assert.match(script, /历史候选只读/);
  assert.match(script, /原始 key\/value/);
  assert.match(script, /未解析 OfficialSku/);
  assert.match(script, /历史 Candidate 结果（兼容旧候选池）/);
  assert.doesNotMatch(script, /历史 Model 候选结果/);

  assert.match(script, /_TackleForgerState/);
  assert.match(css, /\.workbench/);
  assert.ok(workerInfo.size > 0);
});
