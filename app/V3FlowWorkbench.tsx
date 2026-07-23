"use client";

import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  GitBranch,
  Layers3,
  LockKeyhole,
  PackageCheck,
  PackageSearch,
  Scale,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { hydrateV3Seed } from "@/lib/v3-seed";
import { projectionPatchViewFromLedger } from "@/lib/patch-ledger";
import { isProductSkuChainEnabled } from "@/lib/enabled-item-parts";
import { validationIssueLevel } from "@/lib/validation-issues";
import type {
  ConfigurationSnapshot,
  ProjectionPatchRuleSource,
  PurchasableModel,
  SkuDrawer,
  WorkspaceState,
} from "@/lib/types";

type FlowStage = "projection" | "compatibility" | "series" | "models" | "publish";
type SourceView = "rules" | "patches";

interface V3FlowWorkbenchProps {
  state: WorkspaceState;
  mutate: (producer: (draft: WorkspaceState) => void, recalculate?: boolean) => void;
  notify: (message: string) => void;
  initialSeriesId?: string;
}

const stages: Array<{ key: FlowStage; index: string; label: string; hint: string }> = [
  { key: "projection", index: "01", label: "最近模板", hint: "离散命中" },
  { key: "compatibility", index: "02", label: "兼容判定", hint: "硬规则 / Affinity" },
  { key: "series", index: "03", label: "系列约束", hint: "身份与不变量" },
  { key: "models", index: "04", label: "SKU / Model", hint: "抽屉与购买项" },
  { key: "publish", index: "05", label: "发布治理", hint: "冻结与升级" },
];

const qualityMeta = {
  quality_c_green: { letter: "C", name: "绿", color: "#23945f" },
  quality_b_blue: { letter: "B", name: "蓝", color: "#3b6fde" },
  quality_a_purple: { letter: "A", name: "紫", color: "#7658c8" },
  quality_s_orange: { letter: "S", name: "橙", color: "#d77b18" },
} as const;

function profileName(state: WorkspaceState, id: string | undefined) {
  if (!id) return "未指定";
  const catalogs = [
    state.methodProfiles,
    state.itemTypeProfiles,
    state.functionProfiles,
    state.performanceProfiles,
  ];
  for (const catalog of catalogs) {
    const found = catalog.find((item) => item.id === id);
    if (found) return found.name;
  }
  return id;
}

function formatValue(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    approved: "已批准",
    published: "已发布",
    superseded: "已取代",
    pending: "待复核",
    rejected: "已拒绝",
    submitted: "审批中",
  };
  return labels[status] ?? status;
}

function orderedPatches(state: WorkspaceState, sku: SkuDrawer | undefined, model: PurchasableModel | undefined) {
  if (!sku) return [];
  const series = state.seriesDefinitions.find((item) => item.id === sku.seriesId);
  const ids = new Set([...(series?.patchIds ?? []), ...sku.patchIds, ...(model?.patchIds ?? [])]);
  const scopeOrder = { series: 0, sku: 1, model: 2, final_review: 3 };
  return projectionPatchViewFromLedger(state.patchLedger)
    .filter((patch) => ids.has(patch.id))
    .sort((left, right) => scopeOrder[left.scope] - scopeOrder[right.scope] || left.order - right.order || left.id.localeCompare(right.id));
}

function PatchStack({ patches }: { patches: ProjectionPatchRuleSource[] }) {
  return (
    <div className="v3-patch-stack">
      {patches.map((patch, index) => (
        <div className="v3-patch-row" key={patch.id}>
          <span className="v3-patch-order">{index + 1}</span>
          <div>
            <strong>{patch.scope === "series" ? "SeriesPatch" : patch.scope === "sku" ? "SkuPatch" : "ModelPatch"}</strong>
            <small>{patch.reason || patch.id}</small>
          </div>
          <span className="v3-source-tag patch">Patch</span>
          <em>{patch.operations?.length ?? patch.rules.length} 项</em>
        </div>
      ))}
      {!patches.length ? <div className="v3-empty-inline">当前选择没有人工 Patch。</div> : null}
    </div>
  );
}

export function V3FlowWorkbench({ state, mutate, notify, initialSeriesId }: V3FlowWorkbenchProps) {
  const [stage, setStage] = useState<FlowStage>("projection");
  const [sourceView, setSourceView] = useState<SourceView>("rules");
  const productSkus = useMemo(
    () => state.skuDrawers.filter((sku) => isProductSkuChainEnabled(
      state.seriesDefinitions.find((series) => series.id === sku.seriesId),
      sku,
      state.skuDrawers,
    )),
    [state.seriesDefinitions, state.skuDrawers],
  );
  const [selectedSkuId, setSelectedSkuId] = useState(
    productSkus.find((sku) => sku.seriesId === initialSeriesId)?.id
      ?? productSkus[0]?.id
      ?? "",
  );
  const selectedSku = productSkus.find((item) => item.id === selectedSkuId) ?? productSkus[0];
  const [selectedModelId, setSelectedModelId] = useState(selectedSku?.defaultModelId ?? selectedSku?.modelIds[0] ?? "");

  const effectiveModelId = selectedSku?.modelIds.includes(selectedModelId) ? selectedModelId : selectedSku?.defaultModelId ?? selectedSku?.modelIds[0] ?? "";
  const selectedModel = state.purchasableModels.find((item) => item.id === effectiveModelId);
  const selectedSeries = state.seriesDefinitions.find((item) => item.id === selectedSku?.seriesId);
  const selectedCollection = state.collections.find((item) => item.id === selectedSeries?.collectionId);
  const selectedProjection = state.derivedProjections.find((item) => item.id === selectedSku?.projectionMatch.projectionId);
  const selectedSnapshot = state.configurationSnapshots.find((item) => item.id === selectedModel?.configurationSnapshotId);
  const patches = useMemo(() => orderedPatches(state, selectedSku, selectedModel), [state, selectedSku, selectedModel]);
  const pendingUpgrade = state.upgradeCandidates.find((item) => item.modelId === selectedModel?.id && item.status === "pending");

  const seriesSkus = selectedSeries
    ? productSkus.filter((item) => item.seriesId === selectedSeries.id).sort((left, right) => left.targetWeightKg - right.targetWeightKg)
    : productSkus;
  const seriesModels = selectedSku
    ? state.purchasableModels.filter((item) => selectedSku.modelIds.includes(item.id))
    : [];

  const ruleSetVersion = selectedSku?.projectionMatch.ruleSetVersion ?? state.ruleSetVersions[0]?.id ?? "—";
  const quality = selectedSeries ? qualityMeta[selectedSeries.qualityId] : qualityMeta.quality_c_green;
  const blockingCount = selectedSku?.validationSummary.filter((issue) => validationIssueLevel(issue) === "error").length ?? 0;
  const warningCount = selectedSku?.validationSummary.filter((issue) => validationIssueLevel(issue) === "warning").length ?? 0;

  const approveUpgrade = () => {
    if (!pendingUpgrade) return;
    mutate((draft) => {
      const upgrade = draft.upgradeCandidates.find((item) => item.id === pendingUpgrade.id);
      if (!upgrade) return;
      upgrade.status = "approved";
      upgrade.reviewedAt = new Date().toISOString();
      upgrade.reviewer = "本地管理员";
      draft.governanceAuditLog.push({
        id: "audit-" + crypto.randomUUID(),
        action: "review_upgrade",
        entityType: "UpgradeCandidate",
        entityId: upgrade.id,
        actor: "本地管理员",
        occurredAt: upgrade.reviewedAt,
        details: { summary: "批准升级候选；旧 ConfigurationSnapshot 保持冻结。", fromSnapshotId: upgrade.fromSnapshotId, proposedProjectionId: upgrade.proposedProjectionId },
      });
    }, false);
    notify("升级候选已批准；旧快照仍保持冻结。");
  };
  const loadExampleChain = () => {
    const hydrated = hydrateV3Seed(state);
    if (!hydrated.skuDrawers.length || !hydrated.purchasableModels.length) {
      notify("当前规则资料不足，或已存在未完成的商品身份；请先补齐后再载入示例链。");
      return;
    }
    mutate((draft) => {
      Object.assign(draft, hydrated);
    }, false);
    notify("已载入 v3 示例商品链；保存后会形成新的工作区版本。");
  };


  if (!selectedSku || !selectedSeries) {
    return (
      <div className="v3-empty-state">
        <PackageSearch size={34} />
        <strong>尚未形成 v3 商品链</strong>
        <span>当前工作区只有已迁移的规则数据。可主动载入一条示例链，检查从最近模板到冻结发布的完整体验；原有数据不会被覆盖。</span>
        <button type="button" className="v3-empty-action" onClick={loadExampleChain}>
          <Sparkles size={15} />载入 v3 示例链
        </button>
        <small>此操作只产生未保存修改，不会静默写入历史版本。</small>
      </div>
    );
  }

  return (
    <div className="v3-flow-page">
      <section className="v3-command-bar">
        <div>
          <span className="eyebrow">V3 PRODUCT PIPELINE</span>
          <h2>{selectedCollection?.name ?? "产品集合"} / {selectedSeries.name}</h2>
          <p>规则源与人工 Patch 分层呈现，每一个选择都能追踪、复核和重放。</p>
        </div>
        <div className="v3-command-status">
          <span><CircleDot size={14} />规则版本 <strong>{ruleSetVersion}</strong></span>
          <span className={blockingCount ? "danger" : "success"}>{blockingCount ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}{blockingCount ? `${blockingCount} 个阻断` : "可继续生产"}</span>
          <span><LockKeyhole size={14} />{state.configurationSnapshots.length} 个冻结快照</span>
        </div>
      </section>

      <section className="v3-stage-rail" aria-label="v3 制造阶段">
        {stages.map((item, index) => (
          <button type="button" key={item.key} className={stage === item.key ? "active" : ""} onClick={() => setStage(item.key)}>
            <span>{item.index}</span>
            <div><strong>{item.label}</strong><small>{item.hint}</small></div>
            {index < stages.length - 1 ? <ChevronRight className="v3-stage-arrow" size={17} /> : null}
          </button>
        ))}
      </section>

      <section className="v3-context-strip">
        <div><span>钓法</span><strong>{profileName(state, selectedSeries.fishingMethodId)}</strong></div>
        <div><span>类型</span><strong>{profileName(state, selectedSeries.typeId)}</strong></div>
        <div><span>核心功能</span><strong>{profileName(state, selectedSeries.coreFunctionId)}</strong></div>
        <div><span>品质</span><strong style={{ color: quality.color }}>{quality.letter} / {quality.name}</strong></div>
        <div><span>重量曲线</span><strong>{selectedSeries.targetWeightsKg.join(" / ")} kg</strong></div>
        <div><span>修正规则</span><strong>{patches.length} 层 Patch</strong></div>
      </section>

      <div className="v3-layout">
        <aside className="v3-entity-browser">
          <div className="v3-section-head"><div><span className="eyebrow">SKU DRAWERS</span><h3>重量抽屉</h3></div><span>{seriesSkus.length}</span></div>
          <div className="v3-sku-list">
            {seriesSkus.map((sku) => (
              <button type="button" key={sku.id} className={selectedSku.id === sku.id ? "active" : ""} onClick={() => { setSelectedSkuId(sku.id); setSelectedModelId(sku.defaultModelId ?? sku.modelIds[0] ?? ""); }}>
                <span className="v3-weight-mark">{formatValue(sku.targetWeightKg)}<small>kgf</small></span>
                <div><strong>{sku.id}</strong><small>基底 {sku.projectionMatch.weightTemplateId}</small></div>
                <em>{sku.modelIds.length} 型号</em>
              </button>
            ))}
          </div>
          <div className="v3-browser-divider" />
          <div className="v3-section-head compact"><div><span className="eyebrow">PURCHASABLE</span><h3>Model</h3></div></div>
          <div className="v3-model-list">
            {seriesModels.map((model) => (
              <button type="button" key={model.id} className={selectedModel?.id === model.id ? "active" : ""} onClick={() => setSelectedModelId(model.id)}>
                <span><Boxes size={16} /></span>
                <div><strong>{model.name}</strong><small>{model.action} · {model.hardness} · {model.lengthM}m</small></div>
                {model.id === selectedSku.defaultModelId ? <em>默认</em> : null}
              </button>
            ))}
          </div>
        </aside>

        <main className="v3-stage-content">
          {stage === "projection" ? (
            <>
              <div className="v3-stage-title"><div><span className="eyebrow">DETERMINISTIC MATCH</span><h3>最近离散模板命中</h3><p>目标重量只命中已有模板，不在相邻模板之间插值。</p></div><span className="v3-decision-badge"><BadgeCheck size={16} />唯一结果</span></div>
              <div className="v3-projection-hero">
                <div><span>目标拉力规格</span><strong>{selectedSku.targetWeightKg}<small> kgf</small></strong></div>
                <ArrowRight size={22} />
                <div><span>最近模板</span><strong>{selectedSku.projectionMatch.anchorWeightKg}<small> kg</small></strong></div>
                <ArrowRight size={22} />
                <div className="result"><span>派生 Projection</span><strong>{selectedSku.projectionMatch.projectionId}</strong></div>
              </div>
              <div className="v3-grid-two">
                <div className="v3-info-card">
                  <div className="v3-info-title"><Scale size={17} /><strong>决策依据</strong><span className="v3-source-tag rule">规则源</span></div>
                  <ul>{selectedSku.projectionMatch.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  <dl><div><dt>比例距离</dt><dd>{formatValue(selectedSku.projectionMatch.weightDistance)}</dd></div><div><dt>Affinity</dt><dd>{formatValue(selectedSku.projectionMatch.affinityScore)}</dd></div><div><dt>属性距离</dt><dd>{formatValue(selectedSku.projectionMatch.normalizedAttributeDistance)}</dd></div></dl>
                </div>
                <div className="v3-info-card">
                  <div className="v3-info-title"><GitBranch size={17} /><strong>匹配 Trace</strong><em>{selectedSku.projectionMatch.trace.length} 步</em></div>
                  <div className="v3-trace-list">{selectedSku.projectionMatch.trace.map((item, index) => <div key={index}><span>{index + 1}</span><div><strong>{item.stage}</strong><small>{item.detail}</small></div></div>)}</div>
                </div>
              </div>
            </>
          ) : null}

          {stage === "compatibility" ? (
            <>
              <div className="v3-stage-title"><div><span className="eyebrow">TWO-LAYER DECISION</span><h3>硬兼容与软适配分开判定</h3><p>硬规则决定能否生成；Affinity 只负责评分、排序和解释。</p></div></div>
              <div className="v3-compat-grid">
                <div className="v3-compat-card hard"><span><ShieldCheck size={18} />硬 Compatibility</span><strong>{selectedSnapshot?.compatibilityReport.allowed ?? true ? "允许生成" : "阻止生成"}</strong><small>{selectedSnapshot?.compatibilityReport.decisiveRuleIds.length ?? 0} 条决定规则</small><ul>{(selectedSnapshot?.compatibilityReport.suggestions ?? ["当前组合未触发硬阻断。"] ).map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div className="v3-compat-operator">≠</div>
                <div className="v3-compat-card affinity"><span><Sparkles size={18} />Affinity Score</span><strong>{formatValue(selectedSnapshot?.affinityReport.score ?? selectedSku.projectionMatch.affinityScore)}</strong><small>低分仍可生成</small><ul>{(selectedSnapshot?.affinityReport.contributions ?? []).filter((item) => item.ruleId).slice(0, 4).map((item) => <li key={item.axis}><b>{item.axis}</b>{item.reason}</li>)}</ul></div>
              </div>
              <div className="v3-rule-matrix"><div className="v3-info-title"><Layers3 size={17} /><strong>规则命中解释</strong><span className="v3-source-tag rule">规则源</span></div><div className="v3-matrix-head"><span>层</span><span>结果</span><span>边界</span><span>行为</span></div><div><span>硬兼容</span><strong className="success">ALLOW</strong><span>deny / require / allow</span><span>冲突时立即阻断</span></div><div><span>软适配</span><strong>{formatValue(selectedSku.projectionMatch.affinityScore)}</strong><span>-3 ～ +3 / 轴</span><span>仅影响排序与说明</span></div></div>
            </>
          ) : null}

          {stage === "series" ? (
            <>
              <div className="v3-stage-title"><div><span className="eyebrow">SERIES INVARIANTS</span><h3>{selectedSeries.name} 系列约束</h3><p>{selectedSeries.concept}</p></div><span className={blockingCount ? "v3-decision-badge warning" : "v3-decision-badge"}>{blockingCount ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{blockingCount ? "需要处理" : "不变量通过"}</span></div>
              <div className="v3-invariant-list">
                {[
                  ["钓法 / 类型", `${profileName(state, selectedSeries.fishingMethodId)} / ${profileName(state, selectedSeries.typeId)}`, "严格身份"],
                  ["功能专精", `${profileName(state, selectedSeries.coreFunctionId)} · ${selectedSeries.functionIntensityPolicy.mode === "fixed" ? selectedSeries.functionIntensityPolicy.intensity : "重量曲线"}`, "functionIntensity ≠ 品质"],
                  ["品质档", `${quality.letter} / ${quality.name}`, "C绿 B蓝 A紫 S橙"],
                  ["核心词条", `${selectedSeries.coreAffixIds.length} 个必带`, "型号不得移除"],
                  ["签名轴", `${selectedSeries.signature.length} 组方向约束`, "偏离需显式报告"],
                  ["重量曲线", selectedSeries.targetWeightsKg.map((weight) => `${weight}kg`).join(" → "), "保持单调"],
                ].map(([title, value, hint]) => <div key={title}><span className="v3-invariant-check"><CheckCircle2 size={16} /></span><div><strong>{title}</strong><small>{hint}</small></div><b>{value}</b></div>)}
              </div>
              {selectedSku.validationSummary.length ? <div className="v3-validation-box"><strong>当前 SKU 校验</strong>{selectedSku.validationSummary.map((issue, index) => <div key={issue.code + index} className={validationIssueLevel(issue)}><span>{validationIssueLevel(issue) === "error" ? "阻断" : validationIssueLevel(issue) === "warning" ? "警告" : "信息"}</span><p>{issue.message}</p></div>)}</div> : null}
            </>
          ) : null}

          {stage === "models" ? (
            <>
              <div className="v3-stage-title"><div><span className="eyebrow">IDENTITY BOUNDARY</span><h3>SKU 是抽屉，Model 才是购买对象</h3><p>同一重量抽屉共享投影基底，不同 Model 通过独立 Patch、词条和组件形成最终商品。</p></div></div>
              <div className="v3-identity-map"><div className="drawer"><span><PackageSearch size={19} />SKU DRAWER</span><strong>{selectedSku.id}</strong><small>{selectedSku.targetWeightKg} kg · {selectedSku.modelIds.length} 个 Model</small></div><ArrowRight size={21} />{seriesModels.map((model) => <button key={model.id} type="button" className={model.id === selectedModel?.id ? "active" : ""} onClick={() => setSelectedModelId(model.id)}><Boxes size={17} /><strong>{model.name}</strong><small>¥ {model.price}</small></button>)}</div>
              <div className="v3-source-switch"><div><button type="button" className={sourceView === "rules" ? "active" : ""} onClick={() => setSourceView("rules")}>规则源结果</button><button type="button" className={sourceView === "patches" ? "active" : ""} onClick={() => setSourceView("patches")}>人工 Patch</button></div><span>{sourceView === "rules" ? "展示不可直接覆盖的派生基底" : "固定顺序：Series → SKU → Model"}</span></div>
              {sourceView === "rules" ? <div className="v3-panel-grid">{Object.entries(selectedProjection?.values ?? {}).slice(0, 12).map(([key, value]) => <div key={key}><span>{key}</span><strong>{formatValue(value)}</strong><small>Projection</small></div>)}{!Object.keys(selectedProjection?.values ?? {}).length ? <div className="v3-empty-inline">派生投影没有面板字段。</div> : null}</div> : <PatchStack patches={patches} />}
              <div className="v3-model-spec"><div><span>动作 / 硬度</span><strong>{selectedModel?.action ?? "—"} / {selectedModel?.hardness ?? "—"}</strong></div><div><span>长度</span><strong>{selectedModel?.lengthM ?? "—"} m</strong></div><div><span>技术包</span><strong>{selectedModel?.technologyIds.length ?? 0}</strong></div><div><span>属性 / 被动词条</span><strong>{selectedModel?.attributeAffixIds.length ?? 0} / {selectedModel?.passiveAffixIds.length ?? 0}</strong></div><div><span>被动执行</span><strong>只保存 / 计分 / 展示</strong></div></div>
            </>
          ) : null}

          {stage === "publish" ? (
            <>
              <div className="v3-stage-title"><div><span className="eyebrow">IMMUTABLE RELEASE</span><h3>快照冻结与显式升级</h3><p>已发布配置不会被上游规则静默重算；变化只能进入升级候选。</p></div>{selectedSnapshot ? <span className="v3-decision-badge"><LockKeyhole size={16} />快照已冻结</span> : <span className="v3-decision-badge warning"><AlertTriangle size={16} />尚未发布</span>}</div>
              {selectedSnapshot ? <SnapshotCard snapshot={selectedSnapshot} /> : <div className="v3-empty-inline large">当前 Model 仍是草稿，完成阻断校验后方可发布快照。</div>}
              <div className="v3-governance-grid">
                <div className="v3-governance-card"><div><span className="eyebrow">UPGRADE CANDIDATE</span><h4>{pendingUpgrade ? "检测到上游变化" : "暂无待处理升级"}</h4></div>{pendingUpgrade ? <><p>Projection {pendingUpgrade.patchRebasePreview.oldProjectionId} → {pendingUpgrade.proposedProjectionId}</p><div className="v3-diff-list">{pendingUpgrade.differences.slice(0, 5).map((diff) => <div key={diff.path}><span>{diff.path}</span><del>{formatValue(diff.oldResult)}</del><ArrowRight size={13} /><ins>{formatValue(diff.newResult)}</ins></div>)}</div><button type="button" className="v3-primary-action" onClick={approveUpgrade}><PackageCheck size={16} />批准升级候选</button></> : <p>旧快照与当前规则版本一致，暂不需要升级。</p>}</div>
                <div className="v3-governance-card"><div><span className="eyebrow">RULE PROPOSALS</span><h4>Patch 沉淀为规则</h4></div><p>只有已批准 Patch 能提交规则变更提案，原始 Patch 仍保留审计来源。</p><div className="v3-proposal-list">{state.ruleChangeProposals.slice(0, 3).map((proposal) => <div key={proposal.id}><span className={`v3-status ${proposal.status}`}>{statusLabel(proposal.status)}</span><div><strong>{proposal.title}</strong><small>{proposal.impactEntityIds.length} 个受影响实体</small></div></div>)}{!state.ruleChangeProposals.length ? <div className="v3-empty-inline">暂无规则变更提案。</div> : null}</div></div>
              </div>
            </>
          ) : null}
        </main>

        <aside className="v3-context-panel">
          <div className="v3-section-head compact"><div><span className="eyebrow">CURRENT SELECTION</span><h3>选择上下文</h3></div></div>
              <div className="v3-selection-card"><span className="v3-weight-mark large">{selectedSku.targetWeightKg}<small>kgf</small></span><div><strong>{selectedModel?.name ?? "未选择 Model"}</strong><small>{selectedSeries.name}</small></div></div>
          <dl className="v3-facts"><div><dt>Projection</dt><dd>{selectedSku.projectionMatch.projectionId}</dd></div><div><dt>命中模式</dt><dd>{selectedSku.projectionMatch.pinnedByUser ? "人工 Pin" : "自动最近"}</dd></div><div><dt>规则版本</dt><dd>{ruleSetVersion}</dd></div><div><dt>Patch</dt><dd>{patches.length} 层</dd></div><div><dt>校验</dt><dd className={blockingCount ? "danger" : "success"}>{blockingCount ? `${blockingCount} 阻断` : warningCount ? `${warningCount} 警告` : "通过"}</dd></div><div><dt>快照</dt><dd>{selectedSnapshot ? `v${selectedSnapshot.version}` : "未发布"}</dd></div></dl>
          <div className="v3-context-note"><LockKeyhole size={16} /><p><strong>发布边界</strong>购买引用只指向已发布 Model 和 ConfigurationSnapshot，不直接依赖可变规则。</p></div>
        </aside>
      </div>
    </div>
  );
}

function SnapshotCard({ snapshot }: { snapshot: ConfigurationSnapshot }) {
  const quality = qualityMeta[snapshot.qualityReport.qualityId];
  return (
    <div className="v3-snapshot-card">
      <div className="v3-snapshot-lock"><LockKeyhole size={23} /></div>
      <div><span>ConfigurationSnapshot</span><strong>{snapshot.id}</strong><small>发布于 {new Date(snapshot.publishedAt).toLocaleString("zh-CN")}</small></div>
      <dl><div><dt>内容哈希</dt><dd>{snapshot.contentHash.slice(0, 12)}…</dd></div><div><dt>Projection</dt><dd>{snapshot.projectionId}</dd></div><div><dt>品质</dt><dd style={{ color: quality.color }}>{quality.letter} / {quality.name}</dd></div><div><dt>面板字段</dt><dd>{Object.keys(snapshot.finalPanelValues).length}</dd></div></dl>
      <span className="v3-frozen-tag">IMMUTABLE</span>
    </div>
  );
}
