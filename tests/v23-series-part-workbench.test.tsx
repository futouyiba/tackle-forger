import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { V23SeriesPartWorkbench } from "../app/V23SeriesPartWorkbench";
import type { ActionAvailabilityMap } from "../lib/interaction-contracts";
import { buildV23LocalCopyPayload, v23CanCopyInheritedAffix, v23CanCreateSkuFromPreview, v23CanSavePartConfiguration, v23PartConfigurationDraftDirty, v23QualityReasonValid, v23SeriesSwitchRequestBoundary, v23StableRefAttachmentStatus } from "../lib/v23-ui-actions";
import { v23TechnologyContentHash } from "../lib/v23-technology";
import type { SeriesPartRevision, V23AffixDefinition, V23ProjectAffixPayload, V23TechnologyDefinition, WorkspaceState } from "../lib/types";

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
  assert.match(source, /v23CanCopyInheritedAffix\(sku\.localEntryCopies, ref\)/);
  assert.match(source, /已有局部副本，已拒绝重复复制/);
  assert.match(source, /v23StableRefAttachmentStatus\(part\.technologyRefs, ref\)/);
  assert.match(source, /v23StableRefAttachmentStatus\(sku\.technologyRefs, ref\)/);
  assert.match(source, /同一 Technology 稳定 ID 已挂载；请先移除旧 revision/);
  assert.match(source, /v23PartConfigurationDraftDirty\(part, draft\)/);
  assert.match(source, /if \(draftDirty\) return notify\("Part 配置有未保存修改；请先保存 Part 配置，再操作 Technology。"\)/);
  assert.match(source, /disabled=\{pending \|\| draftDirty \|\| conflict/);
  assert.match(source, /resolveCurrentV23Affixes\(state, `part:\$\{part\.partType\}`\)/);
  assert.match(source, /validateV23CurrentDefaultAffixRefs/);
  assert.match(source, /if \(!partSaveAllowed\)/);
  assert.match(source, /Part 配置没有变化，已拒绝创建空 revision/);
  assert.match(source, /disabled=\{pending \|\| !availability\.update_part_configuration\?\.enabled \|\| !partSaveAllowed\}/);
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

test("局部副本来源按稳定 affix ID 去重，不同 revision 也必须先处理旧副本", () => {
  const source = { id: "affix:source", revision: 2, contentHash: "a".repeat(64) };
  assert.equal(v23CanCopyInheritedAffix([], source), true);
  assert.equal(v23CanCopyInheritedAffix([{ sourceRef: source }], source), false);
  assert.equal(v23CanCopyInheritedAffix([{ sourceRef: { ...source, revision: 1, contentHash: "b".repeat(64) } }], source), false);
  assert.equal(v23CanCopyInheritedAffix([{ sourceRef: { ...source, id: "affix:other" } }], source), true);
});

test("Technology attach 以稳定 ID 判定 exact、旧 revision 冲突和合法新挂载", () => {
  const current = { id: "technology:one", revision: 2, contentHash: "a".repeat(64) };
  assert.equal(v23StableRefAttachmentStatus([], current), "absent");
  assert.equal(v23StableRefAttachmentStatus([current], current), "exact");
  assert.equal(v23StableRefAttachmentStatus([{ ...current, revision: 1, contentHash: "b".repeat(64) }], current), "stable_id_conflict");
  assert.equal(v23StableRefAttachmentStatus([current, { ...current, revision: 1, contentHash: "b".repeat(64) }], current), "stable_id_conflict");
  assert.equal(v23StableRefAttachmentStatus([{ ...current, id: "technology:other" }], current), "absent");
});

test("Part 草稿 dirty 精确阻断 Technology 写入，clean 保持可操作", () => {
  const clean = part("part:rod", "rod", ["01.1"]);
  const draft = {
    fishingMethodId: clean.fishingMethodId,
    materialTypeId: clean.materialTypeId,
    functionProfileId: clean.functionProfileId,
    functionIntensity: clean.functionIntensity,
    weightBandIds: clean.weightBandIds,
    defaultEntryRefs: clean.defaultEntryRefs,
  };
  assert.equal(v23PartConfigurationDraftDirty(clean, draft), false);
  for (const dirty of [
    { ...draft, fishingMethodId: "method:changed" },
    { ...draft, weightBandIds: [...draft.weightBandIds, "01.2"] },
    { ...draft, defaultEntryRefs: [{ id: "affix:one", revision: 1, contentHash: "a".repeat(64) }] },
  ]) assert.equal(v23PartConfigurationDraftDirty(clean, dirty), true);
  let writes = 0;
  if (!v23PartConfigurationDraftDirty(clean, { ...draft, fishingMethodId: "method:changed" })) writes += 1;
  assert.equal(writes, 0, "dirty Part Technology handler 不得写入");
  if (!v23PartConfigurationDraftDirty(clean, draft)) writes += 1;
  assert.equal(writes, 1, "clean Part 仍可操作");
  assert.equal(v23CanSavePartConfiguration({ draftDirty: false, weightBandsValid: true, defaultAffixesValid: true }), false);
  assert.equal(v23CanSavePartConfiguration({ draftDirty: true, weightBandsValid: true, defaultAffixesValid: true }), true);
  assert.equal(v23CanSavePartConfiguration({ draftDirty: true, weightBandsValid: false, defaultAffixesValid: true }), false);
  assert.equal(v23CanSavePartConfiguration({ draftDirty: true, weightBandsValid: true, defaultAffixesValid: false }), false);
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
  const saveButton = html.match(/<button[^>]*>保存 Part 配置<\/button>/)?.[0];
  assert.ok(saveButton);
  assert.match(saveButton, /disabled/);
});

test("SSR: 默认词条只显示唯一 current revision，重复 current 整面 fail closed", () => {
  const candidate = fixture();
  const affix = (revision: number, name: string, contentHash: string): V23AffixDefinition => ({
    affixId: "affix:versioned",
    revision,
    contentHash,
    payload: {
      name, category: "passive", itemPartId: "part:rod",
      semanticContributionKey: "versioned", stackingPolicy: "dedupe",
      generationPolicy: "normal", rarity: "common", valueScore: 1,
      tags: [], description: name, enabled: true, operations: [] as [],
      passivePayload: {
        skillId: "skill:versioned", name, itemPartId: "part:rod",
        triggerType: "display", triggerDescription: "展示", effectTarget: "展示",
        effectLogicDescription: "不执行", exampleParameters: {}, durationDescription: "不执行",
        cooldownDescription: "不执行", resetDescription: "不执行", stackingDescription: "不执行",
        playerDescription: "展示", simulatorReferenceKey: null,
      },
    },
  });
  candidate.v23AffixDefinitions = [
    affix(1, "历史词条", "a".repeat(64)),
    affix(2, "当前词条", "b".repeat(64)),
  ];
  const html = renderToStaticMarkup(createElement(V23SeriesPartWorkbench, { state: candidate, workspaceRevision: 7, actionAvailabilities: availability, notify: () => undefined, workspaceFreshness: () => ({ dirty: false, revision: 7 }), onApplied: () => undefined }));
  assert.doesNotMatch(html, /历史词条/);
  assert.equal((html.match(/当前词条/g) ?? []).length, 1);
  candidate.v23AffixDefinitions.push(affix(2, "冲突 current", "c".repeat(64)));
  const ambiguous = renderToStaticMarkup(createElement(V23SeriesPartWorkbench, { state: candidate, workspaceRevision: 7, actionAvailabilities: availability, notify: () => undefined, workspaceFreshness: () => ({ dirty: false, revision: 7 }), onApplied: () => undefined }));
  assert.match(ambiguous, /current revision 不唯一；已禁用默认词条编辑与保存/);
  assert.doesNotMatch(ambiguous, /当前词条/);
  assert.doesNotMatch(ambiguous, /冲突 current/);
});

test("SSR: clean Part 的新 Technology 保持可挂载", () => {
  const candidate = fixture();
  const memberRef = { id: "affix:technology-member", revision: 1, contentHash: "a".repeat(64) };
  candidate.v23AffixDefinitions = [{
    affixId: memberRef.id,
    revision: 1,
    contentHash: memberRef.contentHash,
    payload: {
      name: "技术成员", category: "passive", itemPartId: "part:rod",
      semanticContributionKey: "technology-member", stackingPolicy: "dedupe",
      generationPolicy: "technology_only", rarity: "ultra_rare", valueScore: 1,
      tags: [], description: "技术成员", enabled: true, operations: [] as [],
      passivePayload: {
        skillId: "skill:technology-member", name: "技术成员", itemPartId: "part:rod",
        triggerType: "display", triggerDescription: "展示", effectTarget: "展示",
        effectLogicDescription: "不执行", exampleParameters: {}, durationDescription: "不执行",
        cooldownDescription: "不执行", resetDescription: "不执行", stackingDescription: "不执行",
        playerDescription: "展示", simulatorReferenceKey: null,
      },
    },
  }];
  const technologyInput: Omit<V23TechnologyDefinition, "contentHash"> = {
    technologyId: "technology:clean", revision: 2, itemPartId: "part:rod",
    name: "Clean Technology", description: "clean", memberAffixRefs: [memberRef], enabled: true,
  };
  const technology = { ...technologyInput, contentHash: v23TechnologyContentHash(technologyInput) };
  candidate.v23TechnologyDefinitions = [technology];
  candidate.v23TechnologyHeads = [{ technologyId: technology.technologyId, revision: technology.revision }];
  const enabled = {
    ...availability,
    attach_part_technology: { enabled: true, disabledReasonText: "" },
  } as ActionAvailabilityMap;
  const html = renderToStaticMarkup(createElement(V23SeriesPartWorkbench, { state: candidate, workspaceRevision: 7, actionAvailabilities: enabled, notify: () => undefined, workspaceFreshness: () => ({ dirty: false, revision: 7 }), onApplied: () => undefined }));
  const button = html.match(/<button[^>]*>挂载 Clean Technology<\/button>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /disabled/);

  const oldInput = { ...technologyInput, revision: 1, name: "Old Technology" };
  const oldTechnology = { ...oldInput, contentHash: v23TechnologyContentHash(oldInput) };
  candidate.v23TechnologyDefinitions = [oldTechnology, technology];
  candidate.v23TechnologyHeads = [{ technologyId: technology.technologyId, revision: technology.revision }];
  candidate.v23SeriesPartRevisions = candidate.v23SeriesPartRevisions.map((entry) =>
    entry.partType === "rod"
      ? { ...entry, technologyRefs: [{ id: oldTechnology.technologyId, revision: oldTechnology.revision, contentHash: oldTechnology.contentHash }] }
      : entry);
  const replaceOld = {
    ...enabled,
    remove_part_technology: { enabled: true, disabledReasonText: "" },
  } as ActionAvailabilityMap;
  const conflictHtml = renderToStaticMarkup(createElement(V23SeriesPartWorkbench, { state: candidate, workspaceRevision: 7, actionAvailabilities: replaceOld, notify: () => undefined, workspaceFreshness: () => ({ dirty: false, revision: 7 }), onApplied: () => undefined }));
  const conflictButton = conflictHtml.match(/<button[^>]*>先移除旧 revision Clean Technology<\/button>/)?.[0];
  assert.ok(conflictButton);
  assert.match(conflictButton, /disabled/);
  const removeOldButton = conflictHtml.match(/<button[^>]*>移除 technology:clean@1<\/button>/)?.[0];
  assert.ok(removeOldButton);
  assert.doesNotMatch(removeOldButton, /disabled/);
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
