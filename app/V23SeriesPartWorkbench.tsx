"use client";

import { useMemo, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import type { SeriesPartRevision, SkuDrawerRevision, V23ProjectAffixPayload, V23StableContentRef, WorkspaceState } from "@/lib/types";
import { projectV23SeriesGantt, resolveCurrentV23Skus, resolveCurrentV23Technologies, resolveV23CatalogOrder, resolveV23InheritedAffixRefs, resolveV23SkuOccupiedAffixIds, resolveV23TechnologySurface, selectCurrentPublishedWeightTemplateDraftId, v23PartWeightBandsValid, validateV23PreviewSkuHeads, type V23BandBlock, type V23CatalogOrders } from "@/lib/v23-series-gantt";
import { buildV23LocalCopyPayload, executeV23UiAction, previewV23WeightBand, v23CanApplyReadback, v23CanCopyInheritedAffix, v23CanCreateSkuFromPreview, v23LatestGeneration, v23PartConfigurationDraftDirty, v23QualityReasonValid, v23SeriesSwitchRequestBoundary, v23StableRefAttachmentStatus, v23WritePreflight } from "@/lib/v23-ui-actions";
import { randomUUID } from "@/lib/browser-utils";
import { canApplyConfirmedWorkspace, DIRTY_WORKSPACE_CONFIRMATION_MESSAGE } from "@/lib/clean-workspace-confirmation";

type Preview = { part: SeriesPartRevision; weightBandId: string; skus: SkuDrawerRevision[]; match?: { status?: string } };

function canonicalBandOrders(state: WorkspaceState): V23CatalogOrders {
  const currentId = selectCurrentPublishedWeightTemplateDraftId(state);
  if (!currentId) return { rod: undefined, reel: undefined, line: undefined };
  const drafts = state.weightTemplatePolicyDrafts.filter((entry) => entry.id === currentId);
  if (drafts.length !== 1) return { rod: undefined, reel: undefined, line: undefined };
  const draft = drafts[0];
  return {
    rod: resolveV23CatalogOrder(draft?.templates ?? [], "part:rod"),
    reel: resolveV23CatalogOrder(draft?.templates ?? [], "part:reel"),
    line: resolveV23CatalogOrder(draft?.templates ?? [], "part:line"),
  };
}

export function V23SeriesPartWorkbench(props: {
  state: WorkspaceState; workspaceRevision: number; actionAvailabilities: ActionAvailabilityMap;
  notify: (message: string) => void; workspaceFreshness: () => { dirty: boolean; revision: number }; onApplied: (state: WorkspaceState, revision: number, message: string) => void;
}) {
  const { state, workspaceRevision, actionAvailabilities, notify, workspaceFreshness, onApplied } = props;
  const catalogOrders = useMemo(() => canonicalBandOrders(state), [state]);
  const seriesIds = useMemo(() => [...new Set(state.v23SeriesPartHeads.map((head) => head.seriesId))], [state]);
  const [seriesId, setSeriesId] = useState(seriesIds[0] ?? "");
  const [preview, setPreview] = useState<Preview>();
  const [pending, setPending] = useState<string>();
  const requestEpoch = useRef(0); const writeEpoch = useRef(0); const writeFlight = useRef(false);
  const activeSeriesId = seriesIds.includes(seriesId) ? seriesId : seriesIds[0] ?? "";
  const projection = useMemo(
    () => !activeSeriesId ? undefined : projectV23SeriesGantt(state, activeSeriesId, catalogOrders),
    [state, activeSeriesId, catalogOrders],
  );
  const refresh = async (expectedRevision: number, message: string, epoch: number, baseline: { dirty: boolean; revision: number }) => {
    const response = await fetch("/api/state");
    const current = await response.json().catch(() => null) as { state?: WorkspaceState; revision?: number; error?: string } | null;
    if (!response.ok || !current?.state || !Number.isInteger(current.revision)) throw new Error(current?.error ?? "写入完成但无法安全回读工作区。");
    const revision = current.revision as number;
    if (!v23LatestGeneration(writeEpoch.current, epoch)) return;
    if (revision < expectedRevision) throw new Error("回读 revision 早于写入结果，已拒绝覆盖可见状态。");
    const freshness = workspaceFreshness(); const applyCheck = canApplyConfirmedWorkspace({ ...freshness, expectedRevision: baseline.revision });
    if (!v23CanApplyReadback({ current: freshness, baselineRevision: baseline.revision, returnedRevision: revision })) { notify("工作区状态已漂移，已拒绝应用回读；请重新载入。"); return; }
    if (!applyCheck.allowed) { notify(`${applyCheck.reason} 服务端命令已提交，但为保护本地未保存修改未应用回读；请重新载入。`); return; }
    onApplied(current.state, revision, message);
  };
  const chooseBand = async (part: SeriesPartRevision, weightBandId: string) => {
    if (!part.weightBandIds.includes(weightBandId) || !v23PartWeightBandsValid(part, [weightBandId], catalogOrders)) {
      return notify("重量段不属于该 Part 当前目录，已拒绝预览。");
    }
    const availability = actionAvailabilities.preview_weight_band_skus;
    if (!availability?.enabled) return notify(availability?.disabledReasonText ?? "当前账号不能预览重量段 SKU。");
    const epoch = ++requestEpoch.current;
    setPending(`preview:${part.partId}:${weightBandId}`);
    try {
      const payload = await previewV23WeightBand(part.partId, part.revision, weightBandId) as { skuHeads?: SkuDrawerRevision[]; match?: { status?: string } };
      if (epoch !== requestEpoch.current) return;
      const current = resolveCurrentV23Skus(state, part.partId, weightBandId);
      if (current.unresolved || !validateV23PreviewSkuHeads(current.skus, payload.skuHeads) || payload.skuHeads.some((sku) => sku.partId !== part.partId || sku.weightBandId !== weightBandId) || !payload.match || !["VALID", "INVALID_NO_MATCH", "INVALID_AMBIGUOUS"].includes(payload.match.status ?? "")) throw new Error("SKU 当前 immutable head 或功能模板预览无法闭合验证。");
      setPreview({ part, weightBandId, skus: payload.skuHeads, match: payload.match });
    } catch (error) { if (epoch === requestEpoch.current) notify(error instanceof Error ? error.message : "SKU 预览失败。"); }
    finally { if (epoch === requestEpoch.current) setPending(undefined); }
  };
  const write = async (action: Parameters<typeof executeV23UiAction>[0], payload: Record<string, unknown>, message: string) => {
    if (writeFlight.current) return notify("上一条写入仍在进行；为避免并发覆盖已拒绝本次操作。");
    const baseline = workspaceFreshness();
    const preflight = v23WritePreflight({ ...baseline, expectedWorkspaceRevision: payload.expectedWorkspaceRevision });
    if (!preflight.allowed) return notify(preflight.reason === "dirty" ? DIRTY_WORKSPACE_CONFIRMATION_MESSAGE : "工作区 revision 已变化；请刷新后重新执行该操作。");
    const availability = actionAvailabilities[action];
    if (!availability?.enabled) return notify(availability?.disabledReasonText ?? "当前账号不能执行该动作。");
    const token = `${action}:${randomUUID()}`; const epoch = ++writeEpoch.current; writeFlight.current = true; setPending(token);
    try {
      const result = await executeV23UiAction(action, token, payload);
      await refresh(result.revision!, message, epoch, baseline);
      if (epoch !== writeEpoch.current) return;
      setPreview(undefined);
    } catch (error) { notify(error instanceof Error ? error.message : "v23 写入失败；已保留当前可见状态。"); }
    finally { if (epoch === writeEpoch.current) setPending(undefined); writeFlight.current = false; }
  };
  if (!seriesIds.length) return <section className="v23-part-workbench"><h2>v23 Part / SKU</h2><p>当前没有可唯一解析的 v23 Series head。</p></section>;
  return <section className="v23-part-workbench" aria-label="v23 Part 与 SKU 编辑器">
    <header><div><span>V23 · IMMUTABLE HEADS</span><h2>Part 与重量段 SKU</h2><p>甘特块只表示连续展示；必须选择准确重量段才会读取 SKU，绝不会自动创建。</p></div>
      <label>Series<select value={activeSeriesId} onChange={(event) => { const boundary = v23SeriesSwitchRequestBoundary(requestEpoch.current, pending); requestEpoch.current = boundary.requestEpoch; setPending(boundary.pending); setSeriesId(event.target.value); setPreview(undefined); }}>{seriesIds.map((id) => <option key={id} value={id}>{state.seriesDefinitions.find((series) => series.id === id)?.name ?? id}</option>)}</select></label></header>
    {projection?.unresolved ? <p className="v23-fail-closed">{projection.reason}；已拒绝启用编辑。</p> : <div className="v23-part-grid">{projection?.parts.map((view) => <PartCard key={`${view.part.partId}:${view.part.revision}`} part={view.part} bandBlocks={view.bandBlocks} orderedBands={[...(catalogOrders[view.part.partType] ?? [])]} state={state} workspaceRevision={workspaceRevision} pending={Boolean(pending)} availability={actionAvailabilities} notify={notify} onBand={chooseBand} write={write} onSave={(configuration) => { const weightBandIds = configuration.weightBandIds; if (!Array.isArray(weightBandIds) || !weightBandIds.every((id): id is string => typeof id === "string") || !v23PartWeightBandsValid(view.part, weightBandIds, catalogOrders)) { notify("Part 重量段不属于该 Part 当前目录，已拒绝保存。"); return Promise.resolve(); } return write("update_part_configuration", { expectedWorkspaceRevision: workspaceRevision, partId: view.part.partId, expectedPartRevision: view.part.revision, configuration }, "Part 配置已受控保存并回读。"); }} />)}</div>}
    {preview ? <section className="v23-sku-preview" aria-live="polite"><header><div><span>精确重量段：{preview.weightBandId}</span><h3>{preview.part.partType.toUpperCase()} SKU 抽屉预览</h3><small>04.5 匹配：{preview.match?.status ?? "未知"}；仅显示 current immutable SKU heads。</small></div><button type="button" onClick={() => setPreview(undefined)}>关闭</button></header>
      {preview.skus.map((sku) => <SkuCard key={`${sku.skuId}:${sku.revision}`} sku={sku} part={preview.part} state={state} workspaceRevision={workspaceRevision} availability={actionAvailabilities} pending={Boolean(pending)} notify={notify} write={write} />)}
      <button className="v23-create-sku" type="button" disabled={Boolean(pending) || !actionAvailabilities.create_sku?.enabled || !v23CanCreateSkuFromPreview(preview.match?.status)} onClick={() => { if (!v23CanCreateSkuFromPreview(preview.match?.status)) return notify("04.5 唯一匹配无效，已拒绝创建 SKU。"); void write("create_sku", { expectedWorkspaceRevision: workspaceRevision, skuId: `sku:${randomUUID()}`, partId: preview.part.partId, expectedPartRevision: preview.part.revision, weightBandId: preview.weightBandId, displayOrder: preview.skus.length }, "SKU 已显式创建并回读。"); }} title={v23CanCreateSkuFromPreview(preview.match?.status) ? actionAvailabilities.create_sku?.disabledReasonText : "04.5 必须唯一匹配后才能创建 SKU"}><Plus size={15} />明确创建 SKU</button>
      {!preview.skus.length ? <p>此重量段没有 SKU；点击上方按钮才会创建。</p> : null}</section> : null}
    <ProjectAffixForm workspaceRevision={workspaceRevision} pending={Boolean(pending)} availability={actionAvailabilities.create_project_affix} write={write} />
  </section>;
}

function PartCard({ part, bandBlocks, orderedBands, state, workspaceRevision, pending, availability, notify, onBand, onSave, write }: {
  part: SeriesPartRevision; bandBlocks: V23BandBlock[]; orderedBands: string[]; state: WorkspaceState;
  workspaceRevision: number; pending: boolean; availability: ActionAvailabilityMap; notify: (message: string) => void;
  onBand: (part: SeriesPartRevision, id: string) => void;
  onSave: (configuration: Record<string, unknown>) => Promise<void>;
  write: (action: Parameters<typeof executeV23UiAction>[0], payload: Record<string, unknown>, message: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => ({ fishingMethodId: part.fishingMethodId, materialTypeId: part.materialTypeId, functionProfileId: part.functionProfileId, functionIntensity: part.functionIntensity, weightBandIds: part.weightBandIds, defaultEntryRefs: part.defaultEntryRefs }));
  const [openedBlock, setOpenedBlock] = useState<number>();
  const candidates = state.v23AffixDefinitions.filter((entry) => entry.payload.itemPartId === `part:${part.partType}` && entry.payload.enabled);
  const technologyCatalog = resolveCurrentV23Technologies(state, `part:${part.partType}`);
  const draftDirty = v23PartConfigurationDraftDirty(part, draft);
  const toggleBand = (id: string) => setDraft((current) => ({ ...current, weightBandIds: current.weightBandIds.includes(id) ? current.weightBandIds.filter((value) => value !== id) : [...current.weightBandIds, id] }));
  const toggleAffix = (id: string) => setDraft((current) => ({ ...current, defaultEntryRefs: current.defaultEntryRefs.some((ref) => ref.id === id) ? current.defaultEntryRefs.filter((ref) => ref.id !== id) : [...current.defaultEntryRefs, ...candidates.filter((entry) => entry.affixId === id).map((entry) => ({ id: entry.affixId, revision: entry.revision, contentHash: entry.contentHash }))] }));
  const technologyPayload = (technologyRef: V23StableContentRef) => ({
    expectedWorkspaceRevision: workspaceRevision,
    partId: part.partId,
    expectedPartRevision: part.revision,
    technologyRef,
  });
  const runTechnologyAction = (action: "attach_part_technology" | "remove_part_technology", technologyRef: V23StableContentRef, message: string) => {
    if (draftDirty) return notify("Part 配置有未保存修改；请先保存 Part 配置，再操作 Technology。");
    if (action === "attach_part_technology" && v23StableRefAttachmentStatus(part.technologyRefs, technologyRef) !== "absent") {
      return notify("同一 Technology 稳定 ID 已挂载；请先移除旧 revision。");
    }
    void write(action, technologyPayload(technologyRef), message);
  };
  return <article className={`v23-part-card v23-${part.partType}`}><header><strong>{part.partType.toUpperCase()}</strong><small>immutable {part.partId} · r{part.revision}</small></header>
    <label>钓法<input value={draft.fishingMethodId} onChange={(event) => setDraft({ ...draft, fishingMethodId: event.target.value })} /></label><label>材质<input value={draft.materialTypeId} onChange={(event) => setDraft({ ...draft, materialTypeId: event.target.value })} /></label><label>功能定位<input value={draft.functionProfileId} onChange={(event) => setDraft({ ...draft, functionProfileId: event.target.value })} /></label><label>专精强度<select value={draft.functionIntensity} onChange={(event) => setDraft({ ...draft, functionIntensity: Number(event.target.value) as 1 | 2 | 3 })}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
    <fieldset><legend>01.x 重量段</legend><div className="v23-band-block">{orderedBands.map((id) => <label key={id}><input type="checkbox" checked={draft.weightBandIds.includes(id)} onChange={() => toggleBand(id)} />{id}</label>)}</div></fieldset>
    <fieldset><legend>Part 默认词条</legend>{candidates.map((entry) => <label key={entry.affixId}><input type="checkbox" checked={draft.defaultEntryRefs.some((ref) => ref.id === entry.affixId)} onChange={() => toggleAffix(entry.affixId)} />{entry.payload.name}</label>)}</fieldset>
    <TechnologySurface state={state} refs={part.technologyRefs} itemPartId={`part:${part.partType}`} label="Part Technology" />
    {technologyCatalog.unresolved ? <p className="v23-fail-closed">{technologyCatalog.reason}；已禁用 Technology 挂载。</p> : <div className="v23-technology-actions">{technologyCatalog.technologies.map((technology) => {
      const ref = { id: technology.technologyId, revision: technology.revision, contentHash: technology.contentHash };
      const attachment = v23StableRefAttachmentStatus(part.technologyRefs, ref);
      const action = attachment === "exact" ? "remove_part_technology" : "attach_part_technology";
      const conflict = attachment === "stable_id_conflict";
      const title = draftDirty ? "Part 配置有未保存修改；请先保存 Part 配置，再操作 Technology。" : conflict ? "同一 Technology 稳定 ID 已挂载旧 revision；请先移除旧 revision。" : availability[action]?.disabledReasonText;
      return <button key={technology.technologyId} type="button" disabled={pending || draftDirty || conflict || !availability[action]?.enabled} title={title} onClick={() => runTechnologyAction(action, ref, attachment === "exact" ? "Part Technology 已移除并完成 SKU 重算回读。" : "Part Technology 已挂载并完成 SKU 重算回读。")}>{conflict ? "先移除旧 revision" : attachment === "exact" ? "移除" : "挂载"} {technology.name}</button>;
    })}{part.technologyRefs.filter((ref) => !technologyCatalog.technologies.some((entry) => entry.technologyId === ref.id && entry.revision === ref.revision && entry.contentHash === ref.contentHash)).map((ref) => <button key={`${ref.id}:${ref.revision}`} type="button" disabled={pending || draftDirty || !availability.remove_part_technology?.enabled} title={draftDirty ? "Part 配置有未保存修改；请先保存 Part 配置，再操作 Technology。" : availability.remove_part_technology?.disabledReasonText} onClick={() => runTechnologyAction("remove_part_technology", ref, "旧版 Part Technology 引用已精确移除并完成 SKU 重算回读。")}>移除 {ref.id}@{ref.revision}</button>)}</div>}
    <div className="v23-gantt-blocks" role="group" aria-label={`${part.partType} 合并重量段`}>{bandBlocks.map((block, index) => <div key={block.weightBandIds.join(":")}><button type="button" aria-expanded={openedBlock === index} onClick={() => setOpenedBlock((current) => current === index ? undefined : index)}>{block.weightBandIds.join(" · ")}</button>{openedBlock === index ? <div className="v23-exact-band-picker" role="group" aria-label="选择准确重量段">{block.weightBandIds.map((id) => <button key={id} type="button" disabled={pending} onClick={() => onBand(part, id)}>预览 {id}</button>)}</div> : null}</div>)}</div>
    <button type="button" disabled={pending || !availability.update_part_configuration?.enabled || !draft.weightBandIds.length} onClick={() => void onSave({ partId: part.partId, partType: part.partType, ...draft, technologyRefs: part.technologyRefs })} title={availability.update_part_configuration?.disabledReasonText}>保存 Part 配置</button>
  </article>;
}

function ProjectAffixForm({ workspaceRevision, pending, availability, write }: { workspaceRevision: number; pending: boolean; availability: ActionAvailabilityMap["create_project_affix"]; write: (action: Parameters<typeof executeV23UiAction>[0], payload: Record<string, unknown>, message: string) => Promise<void> }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [partType, setPartType] = useState<"rod" | "reel" | "line">("rod");
  const create = () => { const affixId = `affix:${randomUUID()}`; const payload = { name: name.trim(), category: "passive" as const, itemPartId: `part:${partType}`, semanticContributionKey: `manual:${name.trim()}`, stackingPolicy: "dedupe" as const, generationPolicy: "normal" as const, rarity: "common" as const, valueScore: 0, tags: ["manual"], description: description.trim(), enabled: true, operations: [] as [], passivePayload: { skillId: `skill:${affixId}`, name: name.trim(), itemPartId: `part:${partType}`, triggerType: "manual_description", triggerDescription: description.trim(), effectTarget: "展示", effectLogicDescription: description.trim(), exampleParameters: {}, durationDescription: "未执行", cooldownDescription: "未执行", resetDescription: "未执行", stackingDescription: "按定义展示", playerDescription: description.trim(), simulatorReferenceKey: null } }; if (!name.trim() || !description.trim()) return; void write("create_project_affix", { expectedWorkspaceRevision: workspaceRevision, affixId, affixPayload: payload }, "项目级被动词条已完整创建并回读。"); };
  return <details className="v23-project-affix"><summary>新增项目级词条（完整被动定义）</summary><p>被动词条只保存、计分和展示，不执行模拟器逻辑；属性词条需完整 operation 与已发布 RuleSet 范围，当前不伪造默认数值。</p><label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>部位<select value={partType} onChange={(event) => setPartType(event.target.value as "rod" | "reel" | "line")}><option value="rod">rod</option><option value="reel">reel</option><option value="line">line</option></select></label><label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label><button type="button" disabled={pending || !availability?.enabled || !name.trim() || !description.trim()} title={availability?.disabledReasonText} onClick={create}>创建项目词条</button></details>;
}

function TechnologySurface({ state, refs, itemPartId, label }: {
  state: WorkspaceState;
  refs: readonly V23StableContentRef[];
  itemPartId: "part:rod" | "part:reel" | "part:line";
  label: string;
}) {
  const surface = resolveV23TechnologySurface(state, refs, itemPartId);
  if (surface.unresolved) return <p className="v23-fail-closed">{label} 无法解析：{surface.reason}</p>;
  if (!surface.technologies.length) return <small>{label}：无</small>;
  return <section className="v23-technology-surface" aria-label={label}>
    <strong>{label}</strong>
    {surface.technologies.map((technology) => <span key={`${technology.technologyId}:${technology.revision}`}>{technology.name} · r{technology.revision}</span>)}
    <small>稳定成员词条贡献（按 affixId 去重；Technology 本身不重复计加成）：{surface.members.map((entry) => entry.payload.name).join("、")}</small>
  </section>;
}

function LocalCopyEditor({ copy, pending, availability, publishedRuleSetIds, save }: {
  copy: SkuDrawerRevision["localEntryCopies"][number];
  pending: boolean;
  availability: ActionAvailabilityMap["update_sku_local_affix_copy"];
  publishedRuleSetIds: readonly string[];
  save: (payload: V23ProjectAffixPayload) => void;
}) {
  const [name, setName] = useState(copy.payload.name);
  const [description, setDescription] = useState(copy.payload.description);
  const [valueScoreText, setValueScoreText] = useState(String(copy.payload.valueScore));
  const [branchJson, setBranchJson] = useState(() => JSON.stringify(copy.payload.category === "attribute" ? copy.payload.operations : copy.payload.passivePayload, null, 2));
  const parsed = buildV23LocalCopyPayload({
    original: copy.payload,
    sourceRef: copy.sourceRef,
    name,
    description,
    valueScoreText,
    branchJson,
    publishedRuleSetIds,
  });
  const unchanged = name === copy.payload.name
    && description === copy.payload.description
    && valueScoreText === String(copy.payload.valueScore)
    && branchJson === JSON.stringify(copy.payload.category === "attribute" ? copy.payload.operations : copy.payload.passivePayload, null, 2);
  return <label className="v23-local-copy-editor"><span>局部副本：{copy.payload.name}</span>
    <span>类别：{copy.payload.category} · 来源：{copy.sourceRef.id}@{copy.sourceRef.revision}（不可修改）</span>
    <input aria-label={`${copy.payload.name} 局部副本名称`} value={name} onChange={(event) => setName(event.target.value)} />
    <input aria-label={`${copy.payload.name} 局部副本价值分`} inputMode="decimal" value={valueScoreText} onChange={(event) => setValueScoreText(event.target.value)} />
    <textarea aria-label={`${copy.payload.name} 局部副本说明`} value={description} onChange={(event) => setDescription(event.target.value)} />
    <textarea aria-label={`${copy.payload.name} ${copy.payload.category === "attribute" ? "operations" : "passivePayload"} JSON`} value={branchJson} onChange={(event) => setBranchJson(event.target.value)} />
    {parsed.error ? <small className="v23-fail-closed">{parsed.error}</small> : null}
    <button type="button" disabled={pending || !availability?.enabled || unchanged || !parsed.payload} title={availability?.disabledReasonText ?? parsed.error} onClick={() => parsed.payload && save(parsed.payload)}>保存完整局部副本</button>
  </label>;
}

function SkuCard({ sku, part, state, workspaceRevision, availability, pending, notify, write }: { sku: SkuDrawerRevision; part: SeriesPartRevision; state: WorkspaceState; workspaceRevision: number; availability: ActionAvailabilityMap; pending: boolean; notify: (message: string) => void; write: (action: Parameters<typeof executeV23UiAction>[0], payload: Record<string, unknown>, message: string) => Promise<void> }) {
  const quality = sku.quality.status === "ASSESSED" ? sku.quality.assessment : undefined;
  const [qualityId, setQualityId] = useState(quality?.selectedQualityId ?? "quality_c_green"); const [reason, setReason] = useState(quality?.qualityOverrideReason ?? "");
  const inheritedSurface = resolveV23InheritedAffixRefs(state, part);
  const inherited = inheritedSurface.refs;
  const available = state.v23AffixDefinitions.filter((definition) => definition.payload.itemPartId === `part:${part.partType}` && definition.payload.enabled);
  const occupiedAffixes = resolveV23SkuOccupiedAffixIds(state, part, sku);
  const addableAffixes = occupiedAffixes.unresolved ? [] : available.filter((item) => !occupiedAffixes.ids.includes(item.affixId));
  const technologyCatalog = resolveCurrentV23Technologies(state, `part:${part.partType}`);
  const base = { expectedWorkspaceRevision: workspaceRevision, skuId: sku.skuId, expectedSkuRevision: sku.revision };
  const payload = (extra: Record<string, unknown>) => ({ ...base, ...extra });
  const qualityReasonValid = v23QualityReasonValid(quality?.recommendedQualityId, qualityId, reason);
  const effectiveTechnologyRefs = [...part.technologyRefs];
  for (const ref of sku.technologyRefs) {
    if (!effectiveTechnologyRefs.some((entry) => entry.id === ref.id && entry.revision === ref.revision && entry.contentHash === ref.contentHash)) {
      effectiveTechnologyRefs.push(ref);
    }
  }
  return <article className="v23-sku-card"><header><strong>{sku.skuId}</strong><small>revision {sku.revision} · {sku.status}</small></header>
    <p>派生拉力：{sku.derivation?.status === "VALID" ? `${sku.derivation.targetPullKg} kg` : "不可用（只读派生结果）"}</p>
    <p>品质：推荐 {quality?.recommendedQualityId ?? "无（评分 ≥100 时禁止正式目标定价）"}；实际 {quality?.selectedQualityId ?? "未评估"}；{quality?.qualityOverrideState ?? "—"}{quality?.qualityOverrideReason ? ` · 原因：${quality.qualityOverrideReason}` : ""}</p>
    {quality?.finalValueScore !== undefined && quality.finalValueScore >= 100 ? <p className="v23-fail-closed">评分 {quality.finalValueScore} ≥100：无推荐品质，正式目标定价阻断。</p> : null}
    <label>实际品质<select value={qualityId} onChange={(event) => setQualityId(event.target.value as typeof qualityId)}><option value="quality_c_green">C / 绿</option><option value="quality_b_blue">B / 蓝</option><option value="quality_a_purple">A / 紫</option><option value="quality_s_orange">S / 橙</option></select></label><label>覆盖理由（无推荐或与推荐不一致时必填；匹配时必须为空）<input value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="button" disabled={pending || !availability.set_sku_actual_quality?.enabled || !qualityReasonValid} title={qualityReasonValid ? availability.set_sku_actual_quality?.disabledReasonText : "品质与理由不符合双向不变量"} onClick={() => { if (!qualityReasonValid) return; void write("set_sku_actual_quality", payload({ selectedQualityId: qualityId, reason: reason.trim() || null }), "实际品质已受控保存并回读。"); }}>保存实际品质</button>
    {occupiedAffixes.unresolved ? <p className="v23-fail-closed">{occupiedAffixes.reason}；已禁用 SKU 词条添加。</p> : null}
    <div className="v23-affix-actions">{addableAffixes.map((item) => <button key={item.affixId} type="button" disabled={pending || !availability.add_sku_affix?.enabled} title={availability.add_sku_affix?.disabledReasonText} onClick={() => { if (occupiedAffixes.unresolved || occupiedAffixes.ids.includes(item.affixId)) return notify("该词条 identity 已存在于 SKU 有效或历史来源中，已拒绝重复添加。"); void write("add_sku_affix", payload({ affixRef: { id: item.affixId, revision: item.revision, contentHash: item.contentHash } }), "SKU 词条已增加并回读。"); }}>添加 {item.payload.name}</button>)}</div>
    {inheritedSurface.unresolved ? <p className="v23-fail-closed">继承词条无法闭合解析：{inheritedSurface.reason}；屏蔽、恢复和局部复制已整组禁用。</p> : inherited.map((ref) => sku.removedInheritedEntryIds.includes(ref.id) ? <button key={ref.id} type="button" disabled={pending || !availability.restore_inherited_affix?.enabled} onClick={() => void write("restore_inherited_affix", payload({ inheritedEntryId: ref.id }), "继承词条已恢复并回读.")}><RefreshCw size={14} />恢复继承词条</button> : <span key={ref.id}><button type="button" disabled={pending || !availability.remove_inherited_affix?.enabled} onClick={() => void write("remove_inherited_affix", payload({ inheritedEntryId: ref.id }), "继承词条已屏蔽并回读。")}>屏蔽继承词条</button><button type="button" disabled={pending || !availability.copy_sku_local_affix?.enabled || !v23CanCopyInheritedAffix(sku.localEntryCopies, ref)} title={v23CanCopyInheritedAffix(sku.localEntryCopies, ref) ? availability.copy_sku_local_affix?.disabledReasonText : "该稳定词条 identity 已有局部副本。"} onClick={() => { if (!v23CanCopyInheritedAffix(sku.localEntryCopies, ref)) return notify("该稳定词条 identity 已有局部副本，已拒绝重复复制。"); void write("copy_sku_local_affix", payload({ affixRef: ref, localCopyId: `local:${randomUUID()}` }), "已创建 SKU 局部词条副本并回读。"); }}>复制为局部副本</button></span>)}
    <TechnologySurface state={state} refs={effectiveTechnologyRefs} itemPartId={`part:${part.partType}`} label="SKU 有效 Technology" />
    {technologyCatalog.unresolved ? <p className="v23-fail-closed">{technologyCatalog.reason}；已禁用 SKU Technology 挂载。</p> : <div className="v23-technology-actions">{technologyCatalog.technologies.map((technology) => {
      const ref = { id: technology.technologyId, revision: technology.revision, contentHash: technology.contentHash };
      const attachment = v23StableRefAttachmentStatus(sku.technologyRefs, ref);
      const inheritedFromPart = part.technologyRefs.some((entry) => entry.id === ref.id);
      const action = attachment === "exact" ? "remove_sku_technology" : "attach_sku_technology";
      const conflict = attachment === "stable_id_conflict";
      const title = inheritedFromPart ? "该 Technology 已由 Part 继承，无需在 SKU 重复挂载。" : conflict ? "同一 Technology 稳定 ID 已挂载旧 revision；请先移除旧 revision。" : availability[action]?.disabledReasonText;
      return <button key={technology.technologyId} type="button" disabled={pending || inheritedFromPart || conflict || !availability[action]?.enabled} title={title} onClick={() => { if (action === "attach_sku_technology" && (inheritedFromPart || v23StableRefAttachmentStatus(sku.technologyRefs, ref) !== "absent")) return notify("同一 Technology 稳定 ID 已挂载或由 Part 继承；请先移除旧 revision。"); void write(action, payload({ technologyRef: ref }), attachment === "exact" ? "SKU Technology 已移除并回读。" : "SKU Technology 已挂载并回读。"); }}>{inheritedFromPart ? "Part 已继承" : conflict ? "先移除旧 revision" : attachment === "exact" ? "移除" : "挂载"} {technology.name}</button>;
    })}{sku.technologyRefs.filter((ref) => !technologyCatalog.technologies.some((entry) => entry.technologyId === ref.id && entry.revision === ref.revision && entry.contentHash === ref.contentHash)).map((ref) => <button key={`${ref.id}:${ref.revision}`} type="button" disabled={pending || !availability.remove_sku_technology?.enabled} title={availability.remove_sku_technology?.disabledReasonText} onClick={() => void write("remove_sku_technology", payload({ technologyRef: ref }), "旧版 SKU Technology 引用已精确移除并回读。")}>移除 {ref.id}@{ref.revision}</button>)}</div>}
    {sku.localEntryCopies.map((copy) => <LocalCopyEditor key={copy.localCopyId} copy={copy} pending={pending} availability={availability.update_sku_local_affix_copy} publishedRuleSetIds={state.ruleSetVersions.filter((entry) => entry.status === "published").map((entry) => entry.id)} save={(affixPayload) => void write("update_sku_local_affix_copy", payload({ localCopyId: copy.localCopyId, affixPayload }), "SKU 局部词条副本已更新并回读。")} />)}
    <small>Technology 只展开稳定成员词条并按 affixId 去重，不会被重复为等价词条贡献。项目级新词条必须通过完整定义动作创建。</small>
  </article>;
}
