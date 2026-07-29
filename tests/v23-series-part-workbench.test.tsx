import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { V23SeriesPartWorkbench } from "../app/V23SeriesPartWorkbench";
import type { ActionAvailabilityMap } from "../lib/interaction-contracts";
import type { SeriesPartRevision, WorkspaceState } from "../lib/types";

const part = (partId: string, partType: "rod" | "reel" | "line", bands: string[]): SeriesPartRevision => ({ partId, seriesId: "series:one", revision: 1, partType, fishingMethodId: "method", materialTypeId: "material", functionProfileId: "function", functionIntensity: 2, weightBandIds: bands, defaultEntryRefs: [], technologyRefs: [], inputFingerprint: "a".repeat(64), contentHash: "b".repeat(64) });
const availability = Object.fromEntries(["preview_weight_band_skus", "create_sku", "create_project_affix", "update_part_configuration", "add_sku_affix", "remove_inherited_affix", "restore_inherited_affix", "copy_sku_local_affix", "set_sku_actual_quality"].map((action) => [action, { enabled: false, disabledReasonText: "权限不足" }])) as ActionAvailabilityMap;
const fixture = (): WorkspaceState => {
  const parts = [part("part:rod", "rod", ["01.1", "01.2", "01.4"]), part("part:reel", "reel", ["01.1"]), part("part:line", "line", ["01.2"])];
  return { seriesDefinitions: [{ id: "series:one", name: "测试系列" }], v23SeriesPartRevisions: parts, v23SeriesPartHeads: parts.map((entry) => ({ seriesId: entry.seriesId, partId: entry.partId, revision: entry.revision })), v23SkuDrawerHeads: [], v23SkuDrawerRevisions: [], v23AffixDefinitions: [], ruleSetVersions: [{ id: "rules:current", version: 2, status: "published", weightTemplateDraftId: "draft:bands" }], weightTemplatePolicyDrafts: [{ id: "draft:bands", templates: [{ id: "01.1", sourceRow: 2 }, { id: "01.2", sourceRow: 10 }, { id: "01.4", sourceRow: 20 }] }] } as unknown as WorkspaceState;
};

test("v23 Part 工作台显式预览与受控动作，不在甘特块点击时创建 SKU", async () => {
  const source = await readFile(new URL("../app/V23SeriesPartWorkbench.tsx", import.meta.url), "utf8");
  for (const action of ["preview_weight_band_skus", "create_sku", "create_project_affix", "add_sku_affix", "remove_inherited_affix", "restore_inherited_affix", "copy_sku_local_affix", "set_sku_actual_quality"]) assert.match(source, new RegExp(action));
  assert.match(source, /必须选择准确重量段才会读取 SKU，绝不会自动创建/);
  assert.match(source, /拒绝覆盖可见状态/);
  assert.match(source, /评分 .*≥100：无推荐品质，正式目标定价阻断/);
  assert.match(source, /Technology 引用当前只读保留/);
  assert.match(source, /覆盖理由（与推荐不一致时必填）/);
  assert.match(source, /immutable .*partId/);
  assert.match(source, /DIRTY_WORKSPACE_CONFIRMATION_MESSAGE/);
  assert.match(source, /canApplyConfirmedWorkspace/);
  assert.match(source, /v23WritePreflight/);
});

test("SSR: 唯一 Part 卡、合并块与准确重量段选择器的初始语义", () => {
  const html = renderToStaticMarkup(createElement(V23SeriesPartWorkbench, { state: fixture(), workspaceRevision: 7, actionAvailabilities: availability, notify: () => undefined, workspaceFreshness: () => ({ dirty: false, revision: 7 }), onApplied: () => undefined }));
  assert.equal((html.match(/immutable part:rod/g) ?? []).length, 1);
  assert.equal((html.match(/immutable part:reel/g) ?? []).length, 1);
  assert.equal((html.match(/immutable part:line/g) ?? []).length, 1);
  assert.match(html, /01\.1 · 01\.2/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /预览 01\.1/);
  assert.match(html, /title="权限不足"/);
  assert.match(html, /aria-label="v23 Part 与 SKU 编辑器"/);
});
