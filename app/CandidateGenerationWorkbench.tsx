"use client";

import { AlertTriangle, CheckCircle2, Plus, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import { isProductItemPartEnabled, seriesItemPartId } from "@/lib/enabled-item-parts";
import {
  candidateGenerationInputHash,
  generateModelCandidateRun,
  materializeCandidateRun,
} from "@/lib/model-candidate-generation";
import type {
  CandidateRun,
  ModelVariantInput,
  SeriesDefinition,
  WorkspaceState,
} from "@/lib/types";
import "./candidate-generation.css";

interface Props {
  state: WorkspaceState;
  series: SeriesDefinition;
  initialSkuId?: string;
  actionAvailabilities: ActionAvailabilityMap;
  actor: string;
  mutate: (producer: (draft: WorkspaceState) => void, recalculate?: boolean) => void;
  notify: (message: string) => void;
  onClose: () => void;
}

function blankVariant(index: number): ModelVariantInput {
  return {
    modelVariantKey: index === 0 ? "" : `variant_${index + 1}`,
    label: "",
    action: "",
    hardness: "",
    lengthM: 0,
    componentSelections: [], technologyIds: [], attributeAffixIds: [], passiveAffixIds: [], patchIds: [], tags: [],
  };
}

export function CandidateGenerationWorkbench({ state, series, initialSkuId, actionAvailabilities, actor, mutate, notify, onClose }: Props) {
  const seriesSkus = useMemo(() => state.skuDrawers.filter((sku) =>
    sku.seriesId === series.id
    && isProductItemPartEnabled(sku.projectionMatch.itemPartId)
    && sku.projectionMatch.itemPartId === seriesItemPartId(series, state.skuDrawers))
    .sort((left, right) => left.targetWeightKg - right.targetWeightKg), [series, state.skuDrawers]);
  const matchingRecipes = state.candidateSearchRecipes.filter((recipe) =>
    recipe.methodIds.includes(series.fishingMethodId)
    && recipe.typeIds.includes(series.typeId)
    && recipe.functionIds.includes(series.coreFunctionId)
    && recipe.qualityIds.includes(series.qualityId));
  const [recipeId, setRecipeId] = useState(matchingRecipes[0]?.id ?? "");
  const [skuIds, setSkuIds] = useState<string[]>(initialSkuId ? [initialSkuId] : seriesSkus.map((sku) => sku.id));
  const [variants, setVariants] = useState<ModelVariantInput[]>([blankVariant(0)]);
  const [perSkuLimit, setPerSkuLimit] = useState(8);
  const [minimumAffinity, setMinimumAffinity] = useState("");
  const [acceptWarnings, setAcceptWarnings] = useState(true);
  const [checkpointMode, setCheckpointMode] = useState<"AUTO_CONTINUE" | "REVIEW_ON_CHANGE">("AUTO_CONTINUE");
  const [run, setRun] = useState<CandidateRun>();
  const [error, setError] = useState("");
  const generateAvailability = actionAvailabilities.generate_candidates;
  const materializeAvailability = actionAvailabilities.materialize_candidates;

  const updateVariant = (index: number, patch: Partial<ModelVariantInput>) => {
    setVariants((current) => current.map((variant, candidateIndex) => candidateIndex === index ? { ...variant, ...patch } : variant));
  };

  const persistRun = (nextRun: CandidateRun) => {
    mutate((draft) => {
      if (!draft.candidateRuns.some((entry) => entry.runId === nextRun.runId)) draft.candidateRuns.push(structuredClone(nextRun));
    }, false);
  };

  const materialize = (targetRun: CandidateRun, reviewConfirmed = false) => {
    if (!materializeAvailability.enabled) {
      setError(materializeAvailability.disabledReasonText ?? "缺少候选物化权限。");
      return;
    }
    const result = materializeCandidateRun({ state, run: targetRun, actor, occurredAt: new Date().toISOString(), reviewConfirmed });
    mutate((draft) => {
      draft.purchasableModels = result.models;
      draft.skuDrawers = result.skus;
      if (!draft.candidateRuns.some((entry) => entry.runId === targetRun.runId)) draft.candidateRuns.push(structuredClone(targetRun));
      draft.candidateMaterializations.push(result.record);
    }, false);
    notify(`已按 skuId + modelVariantKey 物化 ${result.record.materializedModelIds.length} 个 Model；${result.record.issues.length} 项跳过。`);
  };

  const generate = () => {
    setError("");
    const recipe = state.candidateSearchRecipes.find((entry) => entry.id === recipeId);
    const skus = skuIds.map((id) => state.skuDrawers.find((entry) => entry.id === id)).filter((entry): entry is WorkspaceState["skuDrawers"][number] => Boolean(entry));
    const cleanVariants = variants.map((variant) => ({ ...variant, modelVariantKey: variant.modelVariantKey.trim(), label: variant.label.trim() }));
    if (!recipe || !skus.length) { setError("请选择候选搜索配方和至少一个精确重量 SKU。"); return; }
    if (cleanVariants.some((variant) => !variant.modelVariantKey || !variant.label || !variant.action || !variant.hardness || variant.lengthM <= 0)) {
      setError("每条 Model 路线都必须填写稳定 modelVariantKey、名称、调性、硬度和正数长度。"); return;
    }
    if (new Set(cleanVariants.map((variant) => variant.modelVariantKey)).size !== cleanVariants.length) {
      setError("modelVariantKey 在本次请求中必须唯一。"); return;
    }
    const options = {
      seriesRef: { entityId: series.id, revisionId: String(series.revision) },
      skuRefs: skus.map((sku) => ({ entityId: sku.id, revisionId: String(sku.revision) })),
      recipeRef: { entityId: recipe.id, revisionId: String(recipe.revision) },
      recipeInput: {},
      enabledVariantKeys: cleanVariants.map((variant) => variant.modelVariantKey),
      perSkuLimit,
      minimumAffinity: minimumAffinity === "" ? undefined : Number(minimumAffinity),
      acceptWarnings,
      sortDefinitionVersion: "candidate-sort-v1",
      checkpointMode,
    };
    const inputHash = candidateGenerationInputHash({
      series, skus, recipe, variants: cleanVariants,
      ruleSetVersion: state.ruleSetVersions.find((entry) => entry.status === "published")?.id ?? "",
      requestOptions: options,
    });
    const now = new Date().toISOString();
    const nextRun = generateModelCandidateRun({
      state,
      request: { requestId: `candidate-request:${inputHash.slice(0, 20)}`, ...options, inputHash, idempotencyKey: `candidate:${inputHash}` },
      variants: cleanVariants,
      startedAt: now,
      completedAt: now,
    });
    setRun(nextRun);
    if (nextRun.status === "completed" && materializeAvailability.enabled) {
      materialize(nextRun);
    } else {
      persistRun(nextRun);
    }
    notify(nextRun.status === "waiting_for_review" ? "候选运行已冻结，等待人工确认后物化。" : "候选运行已完成。");
  };

  return (
    <div className="candidate-generation-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="candidate-generation-dialog" role="dialog" aria-modal="true" aria-label="生成 Model 候选">
        <header><div><span className="eyebrow">CANDIDATE SEARCH RECIPE</span><h2>生成 Model 候选</h2><p>{series.name} · {series.id} · revision {series.revision}</p></div><button type="button" onClick={onClose} aria-label="关闭"><X size={19} /></button></header>
        <div className="candidate-generation-body">
          <section className="candidate-input-card">
            <h3>1. 冻结范围与配方</h3>
            <label><span>候选搜索配方 / Revision</span><select value={recipeId} onChange={(event) => setRecipeId(event.target.value)}><option value="">选择配方</option>{matchingRecipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name} · rev {recipe.revision}</option>)}</select></label>
            <div className="candidate-sku-grid">{seriesSkus.map((sku) => <label key={sku.id}><input type="checkbox" checked={skuIds.includes(sku.id)} onChange={() => setSkuIds((current) => current.includes(sku.id) ? current.filter((id) => id !== sku.id) : [...current, sku.id])} /><span><strong>{sku.targetWeightKg} kgf</strong><small>离散目标拉力 · {sku.id} · 最近标杆 {sku.projectionMatch.projectionId}</small></span></label>)}</div>
          </section>
          <section className="candidate-input-card">
            <div className="candidate-card-title"><h3>2. 启用 Model 路线</h3><button type="button" onClick={() => setVariants((current) => [...current, blankVariant(current.length)])}><Plus size={14} />添加路线</button></div>
            <p>modelVariantKey 是跨重量稳定路线键；名称仅展示，不参与再生成匹配。</p>
            <div className="candidate-variant-list">{variants.map((variant, index) => <div key={index}><input aria-label="modelVariantKey" placeholder="如 short_fast" value={variant.modelVariantKey} onChange={(event) => updateVariant(index, { modelVariantKey: event.target.value })} /><input aria-label="路线名称" placeholder="路线显示名" value={variant.label} onChange={(event) => updateVariant(index, { label: event.target.value })} /><input aria-label="调性" placeholder="调性" value={variant.action} onChange={(event) => updateVariant(index, { action: event.target.value })} /><input aria-label="硬度" placeholder="硬度" value={variant.hardness} onChange={(event) => updateVariant(index, { hardness: event.target.value })} /><input aria-label="长度" type="number" min="0" step="0.1" placeholder="长度 m" value={variant.lengthM || ""} onChange={(event) => updateVariant(index, { lengthM: Number(event.target.value) })} /><button type="button" aria-label="移除路线" disabled={variants.length === 1} onClick={() => setVariants((current) => current.filter((_entry, candidateIndex) => candidateIndex !== index))}><Trash2 size={14} /></button></div>)}</div>
          </section>
          <section className="candidate-input-card candidate-policy-grid">
            <h3>3. 排序、阈值与检查点</h3>
            <label><span>每 SKU 最大结果</span><input type="number" min="1" max="100" value={perSkuLimit} onChange={(event) => setPerSkuLimit(Math.max(1, Number(event.target.value)))} /></label>
            <label><span>最低 Affinity（可空）</span><input type="number" value={minimumAffinity} onChange={(event) => setMinimumAffinity(event.target.value)} /></label>
            <label><span>阶段策略</span><select value={checkpointMode} onChange={(event) => setCheckpointMode(event.target.value as typeof checkpointMode)}><option value="AUTO_CONTINUE">AUTO_CONTINUE · 默认物化</option><option value="REVIEW_ON_CHANGE">REVIEW_ON_CHANGE · 首次输入暂停</option></select></label>
            <label className="candidate-check"><input type="checkbox" checked={acceptWarnings} onChange={(event) => setAcceptWarnings(event.target.checked)} />接受 warning 候选</label>
            <div className="candidate-rule-note"><ShieldCheck size={16} />硬 deny / 缺 require 只进排除统计；Affinity 只参与权威稳定排序，AI 不得改序。</div>
          </section>
          {error ? <div className="candidate-error"><AlertTriangle size={16} />{error}</div> : null}
          {run ? <section className="candidate-results"><div className="candidate-run-summary"><div><span>枚举</span><strong>{run.enumerationTotal}</strong></div><div><span>合法</span><strong>{run.legalCount}</strong></div><div><span>展示</span><strong>{run.candidates.length}</strong></div><div><span>截断</span><strong>{run.truncatedCount}</strong></div></div><code>{run.inputHash}</code>{Object.entries(run.excludedByCode).map(([code, count]) => <span className="candidate-exclusion" key={code}>{code} · {count}</span>)}<div className="candidate-result-list">{run.candidates.map((candidate) => <article key={candidate.candidateId}><div><strong>#{candidate.rank} · {candidate.variant.label}</strong><small>{candidate.skuRef.entityId} · {candidate.modelVariantKey}</small></div><span>Affinity {candidate.affinity.score.toFixed(1)}</span><span>warning {candidate.warningCount}</span><code>{candidate.candidateFingerprint.slice(0, 16)}</code><p>{candidate.rankReasons.join(" · ")}</p></article>)}</div>{!run.candidates.length ? <div className="candidate-zero"><AlertTriangle size={18} />没有合法候选；请按排除统计调整范围，不会生成空 Model。</div> : null}</section> : null}
        </div>
        <footer><span>{run?.status === "waiting_for_review" ? "等待人工确认" : run ? "运行已冻结留痕" : generateAvailability.disabledReasonText}</span>{run?.status === "waiting_for_review" ? <button type="button" className="button button-default button-md" disabled={!materializeAvailability.enabled} onClick={() => materialize(run, true)}><CheckCircle2 size={15} />确认并物化</button> : null}<button type="button" className="button button-primary button-md" disabled={!generateAvailability.enabled} onClick={generate}><Sparkles size={15} />生成并稳定排序</button></footer>
      </section>
    </div>
  );
}
