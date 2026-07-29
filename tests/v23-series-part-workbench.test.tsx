import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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
