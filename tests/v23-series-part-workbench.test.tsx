import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { V23SeriesPartWorkbench } from "../app/V23SeriesPartWorkbench";
import type { ActionAvailabilityMap } from "../lib/interaction-contracts";
import { buildV23LocalCopyPayload, v23CanCreateSkuFromPreview, v23QualityReasonValid, v23SeriesSwitchRequestBoundary } from "../lib/v23-ui-actions";
import type { SeriesPartRevision, V23ProjectAffixPayload, WorkspaceState } from "../lib/types";

const part = (partId: string, partType: "rod" | "reel" | "line", bands: string[]): SeriesPartRevision => ({ partId, seriesId: "series:one", revision: 1, partType, fishingMethodId: "method", materialTypeId: "material", functionProfileId: "function", functionIntensity: 2, weightBandIds: bands, defaultEntryRefs: [], technologyRefs: [], inputFingerprint: "a".repeat(64), contentHash: "b".repeat(64) });
const availability = Object.fromEntries(["preview_weight_band_skus", "create_sku", "create_project_affix", "update_part_configuration", "add_sku_affix", "remove_inherited_affix", "restore_inherited_affix", "copy_sku_local_affix", "update_sku_local_affix_copy", "attach_part_technology", "remove_part_technology", "attach_sku_technology", "remove_sku_technology", "set_sku_actual_quality"].map((action) => [action, { enabled: false, disabledReasonText: "权限不足" }])) as ActionAvailabilityMap;
const fixture = (): WorkspaceState => {
  const parts = [part("part:rod", "rod", ["01.1", "01.2", "01.4"]), part("part:reel", "reel", ["01.1"]), part("part:line", "line", ["01.2"])];
  return { seriesDefinitions: [{ id: "series:one", name: "测试系列" }], v23SeriesPartRevisions: parts, v23SeriesPartHeads: parts.map((entry) => ({ seriesId: entry.seriesId, partId: entry.partId, revision: entry.revision })), v23SkuDrawerHeads: [], v23SkuDrawerRevisions: [], v23AffixDefinitions: [], v23TechnologyDefinitions: [], v23TechnologyHeads: [], ruleSetVersions: [{ id: "rules:current", version: 2, status: "published", weightTemplateDraftId: "draft:bands" }], weightTemplatePolicyDrafts: [{ id: "draft:bands", templates: [{ id: "01.1", itemPartId: "part:rod", sourceRow: 2 }, { id: "01.2", itemPartId: "part:rod", sourceRow: 10 }, { id: "01.4", itemPartId: "part:rod", sourceRow: 20 }, { id: "01.1", itemPartId: "part:reel", sourceRow: 2 }, { id: "01.2", itemPartId: "part:line", sourceRow: 2 }] }] } as unknown as WorkspaceState;
};

test("v23 Part 工作台显式预览与受控动作，不在甘特块点击时创建 SKU", async () => {
  const source = await readFile(new URL("../app/V23SeriesPartWorkbench.tsx", import.meta.url), "utf8");
  for (const action of ["preview_weight_band_skus", "create_sku", "create_project_affix", "add_sku_affix", "remove_inherited_affix", "restore_inherited_affix", "copy_sku_local_affix", "update_sku_local_affix_copy", "attach_part_technology", "remove_part_technology", "attach_sku_technology", "remove_sku_technology", "set_sku_actual_quality"]) assert.match(source, new RegExp(action));
  assert.match(source, /必须选择准确重量段才会读取 SKU，绝不会自动创建/);
  assert.match(source, /拒绝覆盖可见状态/);
  assert.match(source, /评分 .*≥100：无推荐品质，正式目标定价阻断/);
  assert.match(source, /Technology 本身不重复计加成/);
  assert.match(source, /resolveV23InheritedAffixRefs/);
  assert.match(source, /屏蔽、恢复和局部复制已整组禁用/);
  assert.match(source, /remove_inherited_affix/);
  assert.match(source, /restore_inherited_affix/);
  assert.match(source, /copy_sku_local_affix/);
  assert.match(source, /buildV23LocalCopyPayload/);
  assert.match(source, /来源：.*不可修改/);
  assert.match(source, /保存完整局部副本/);
  assert.match(source, /v23CanCreateSkuFromPreview/);
  assert.match(source, /04\.5 唯一匹配无效，已拒绝创建 SKU/);
  assert.match(source, /v23QualityReasonValid/);
  assert.match(source, /覆盖理由（无推荐或与推荐不一致时必填；匹配时必须为空）/);
  assert.match(source, /disabled=\{pending \|\| !availability\.set_sku_actual_quality\?\.enabled \|\| !qualityReasonValid\}/);
  assert.match(source, /if \(!qualityReasonValid\) return; void write\("set_sku_actual_quality"/);
  assert.match(source, /immutable .*partId/);
  assert.match(source, /DIRTY_WORKSPACE_CONFIRMATION_MESSAGE/);
  assert.match(source, /canApplyConfirmedWorkspace/);
  assert.match(source, /v23WritePreflight/);
  assert.match(source, /v23SeriesSwitchRequestBoundary\(requestEpoch\.current, pending\)/);
  assert.match(source, /setPending\(boundary\.pending\)/);
  assert.match(source, /重量段不属于该 Part 当前目录，已拒绝预览/);
  assert.match(source, /Part 重量段不属于该 Part 当前目录，已拒绝保存/);
  assert.match(source, /resolveV23SkuOccupiedAffixIds/);
  assert.match(source, /occupiedAffixes\.ids\.includes\(item\.affixId\)/);
  assert.match(source, /已拒绝重复添加/);
});

test("create SKU 只接受 VALID preview，两个 invalid 状态均不进入写入资格", () => {
  assert.equal(v23CanCreateSkuFromPreview("VALID"), true);
  assert.equal(v23CanCreateSkuFromPreview("INVALID_NO_MATCH"), false);
  assert.equal(v23CanCreateSkuFromPreview("INVALID_AMBIGUOUS"), false);
  assert.equal(v23CanCreateSkuFromPreview(undefined), false);
});

test("品质理由双向不变量覆盖无推荐、不匹配、匹配与非法多余理由", () => {
  assert.equal(v23QualityReasonValid(undefined, "quality_s_orange", ""), false);
  assert.equal(v23QualityReasonValid(undefined, "quality_s_orange", "未评估时也不得保存"), false);
  assert.equal(v23QualityReasonValid(null, "quality_s_orange", ""), false);
  assert.equal(v23QualityReasonValid(null, "quality_s_orange", "人工确认无推荐"), true);
  assert.equal(v23QualityReasonValid("quality_c_green", "quality_b_blue", ""), false);
  assert.equal(v23QualityReasonValid("quality_c_green", "quality_b_blue", "人工覆盖"), true);
  assert.equal(v23QualityReasonValid("quality_c_green", "quality_c_green", "多余理由"), false);
  assert.equal(v23QualityReasonValid("quality_c_green", "quality_c_green", " "), true);
});

test("Series 切换不会继承旧 preview pending，写入 pending 则保持真实状态", () => {
  assert.deepEqual(v23SeriesSwitchRequestBoundary(2, "preview:part:rod:01.1"), { requestEpoch: 3, pending: undefined });
  assert.deepEqual(v23SeriesSwitchRequestBoundary(2, "create_sku:token"), { requestEpoch: 3, pending: "create_sku:token" });
  assert.deepEqual(v23SeriesSwitchRequestBoundary(2, undefined), { requestEpoch: 3, pending: undefined });
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

test("local copy attribute editor 提交完整 closed payload 并拒绝非法中间输入/source 改写", () => {
  const sourceRef = { id: "affix:source", revision: 2, contentHash: "a".repeat(64) };
  const original: V23ProjectAffixPayload = {
    name: "属性副本", category: "attribute", itemPartId: "part:rod",
    semanticContributionKey: "pull", stackingPolicy: "dedupe", generationPolicy: "normal",
    rarity: "rare", valueScore: 5, tags: ["local"], description: "原说明", enabled: true,
    operations: [{
      operationId: "op:1", operationIndex: 0, sourceAffixId: sourceRef.id,
      sourceAffixRevision: sourceRef.revision, parameterKey: "pull", operation: "flat_adjust",
      direction: "increase", magnitude: 2, publishedMagnitudeRange: { min: 0, max: 10, ruleSetVersion: "rules:1" },
    }],
    passivePayload: null,
  };
  const edited = [{ ...original.operations[0]!, magnitude: 3 }];
  const result = buildV23LocalCopyPayload({ original, sourceRef, name: "属性副本 2", description: "新说明", valueScoreText: "8", branchJson: JSON.stringify(edited), publishedRuleSetIds: ["rules:1"] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.payload, { ...original, name: "属性副本 2", description: "新说明", valueScore: 8, operations: edited });
  assert.match(buildV23LocalCopyPayload({ original, sourceRef, name: "x", description: "", valueScoreText: "8", branchJson: "{", publishedRuleSetIds: ["rules:1"] }).error ?? "", /JSON/);
  assert.match(buildV23LocalCopyPayload({ original, sourceRef, name: "x", description: "", valueScoreText: " ", branchJson: JSON.stringify(edited), publishedRuleSetIds: ["rules:1"] }).error ?? "", /价值分/);
  assert.match(buildV23LocalCopyPayload({ original, sourceRef, name: "x", description: "", valueScoreText: "8", branchJson: JSON.stringify([{ ...edited[0], sourceAffixId: "affix:forged" }]), publishedRuleSetIds: ["rules:1"] }).error ?? "", /source/);
  const negativeIndex = buildV23LocalCopyPayload({ original, sourceRef, name: "x", description: "", valueScoreText: "8", branchJson: JSON.stringify([{ ...edited[0], operationIndex: -1 }]), publishedRuleSetIds: ["rules:1"] });
  assert.equal(negativeIndex.payload, undefined);
  assert.match(negativeIndex.error ?? "", /identity/);
  assert.match(buildV23LocalCopyPayload({ original, sourceRef, name: "x", description: "", valueScoreText: "8", branchJson: JSON.stringify(edited), publishedRuleSetIds: [] }).error ?? "", /range/);
});

test("local copy passive editor 编辑结构化 payload/valueScore 且非法 scalar fail closed", () => {
  const sourceRef = { id: "affix:passive", revision: 1, contentHash: "b".repeat(64) };
  const passivePayload = {
    skillId: "skill:one", name: "被动", itemPartId: "part:rod", triggerType: "manual",
    triggerDescription: "触发", effectTarget: "展示", effectLogicDescription: "不执行",
    exampleParameters: { chance: 0.2 }, durationDescription: "持续", cooldownDescription: "冷却",
    resetDescription: "重置", stackingDescription: "叠加", playerDescription: "玩家文案",
    simulatorReferenceKey: null,
  };
  const original: V23ProjectAffixPayload = {
    name: "被动副本", category: "passive", itemPartId: "part:rod",
    semanticContributionKey: "passive", stackingPolicy: "dedupe", generationPolicy: "normal",
    rarity: "rare", valueScore: 4, tags: [], description: "说明", enabled: true,
    operations: [], passivePayload,
  };
  const edited = { ...passivePayload, playerDescription: "新玩家文案", exampleParameters: { chance: 0.5, active: true } };
  const result = buildV23LocalCopyPayload({ original, sourceRef, name: "被动副本", description: "说明 2", valueScoreText: "6", branchJson: JSON.stringify(edited), publishedRuleSetIds: [] });
  assert.deepEqual(result.payload, { ...original, description: "说明 2", valueScore: 6, passivePayload: edited });
  const invalid = { ...edited, exampleParameters: { chance: null } };
  assert.match(buildV23LocalCopyPayload({ original, sourceRef, name: "被动副本", description: "说明", valueScoreText: "6", branchJson: JSON.stringify(invalid), publishedRuleSetIds: [] }).error ?? "", /参数/);
});
