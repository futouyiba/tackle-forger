"use client";

import { AlertTriangle, CheckCircle2, DatabaseZap, FileClock, Link2, Plus, Search, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { analyzePatchPatterns, appendPatchRevision, buildPatchRevision, createRuleSourceChangeDraft } from "@/lib/patch-ledger";
import { createWorkspacePatchReview, currentPatchApprovalEvidence, preparePatchOperationFromWorkspace, reviewWorkspacePatchRevision } from "@/lib/patch-authority";
import type { PatchPatternSummary, PatchRevisionRecord, WorkspaceState } from "@/lib/types";

interface PatchLedgerWorkbenchProps {
  state: WorkspaceState;
  revision: number;
  capabilities: string[];
  actorStableId: string;
  actorName: string;
  mutate: (producer: (draft: WorkspaceState) => void, recalculate?: boolean) => void;
  notify: (message: string) => void;
  replaceWorkspace: (state: WorkspaceState, revision: number) => void;
}
interface PatchDraft {
  scopeType: "series" | "sku" | "model";
  subjectEntityId: string;
  parameterKey: string;
  operation: "set" | "add" | "multiply" | "clear";
  operand: string;
  reason: string;
}
const stateLabels: Record<PatchRevisionRecord["state"], string> = {
  DRAFT:"草稿",PENDING_REVIEW:"待审核",APPROVED:"已批准",ACTIVE:"生效中",REBASE_REQUIRED:"需要 Rebase",
  ABSORBED:"已吸收",PARTIALLY_ABSORBED:"部分吸收",WITHDRAWN:"已撤回",SUPERSEDED:"已替代",
};
const mirrorLabels: Record<PatchRevisionRecord["mirrorSyncState"], string> = {
  NOT_SYNCED:"未同步",PENDING:"等待同步",WRITING:"写入中",SYNCED:"已回读验证",
  REMOTE_CHANGED:"远端有变化",CONFLICT:"同步冲突",WRITE_FAILED:"写入失败",
};

function analysisContexts(state: WorkspaceState) {
  const contexts: Array<{subjectEntityId:string;methodId?:string;typeId?:string;functionId?:string;weightBandId?:string}> = [];
  for (const series of state.seriesDefinitions) contexts.push({subjectEntityId:series.id,methodId:series.fishingMethodId,typeId:series.typeId,functionId:series.coreFunctionId});
  for (const sku of state.skuDrawers) {
    const series=state.seriesDefinitions.find((entry)=>entry.id===sku.seriesId);
    contexts.push({subjectEntityId:sku.id,methodId:series?.fishingMethodId,typeId:series?.typeId,functionId:series?.coreFunctionId,weightBandId:sku.projectionMatch.weightTemplateId});
  }
  for (const model of state.purchasableModels) {
    const sku=state.skuDrawers.find((entry)=>entry.id===model.skuId);
    const series=state.seriesDefinitions.find((entry)=>entry.id===sku?.seriesId);
    contexts.push({subjectEntityId:model.id,methodId:series?.fishingMethodId,typeId:series?.typeId,functionId:series?.coreFunctionId,weightBandId:sku?.projectionMatch.weightTemplateId});
  }
  return contexts;
}
export function PatchLedgerWorkbench({ state, revision, capabilities, actorStableId: _actorStableId, actorName, mutate, notify, replaceWorkspace }: PatchLedgerWorkbenchProps) {
  const [query,setQuery]=useState("");
  const [selectedKey,setSelectedKey]=useState("");
  const [draft,setDraft]=useState<PatchDraft|null>(null);
  const [proposalPattern,setProposalPattern]=useState<PatchPatternSummary|null>(null);
  const [proposalRationale,setProposalRationale]=useState("");
  const revisions=useMemo(()=>[...state.patchLedger.revisions].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.patchId.localeCompare(b.patchId)||b.patchRevision-a.patchRevision),[state.patchLedger.revisions]);
  const filtered=useMemo(()=>{const needle=query.trim().toLowerCase();return needle?revisions.filter((entry)=>[entry.patchId,entry.subjectEntityId,entry.subjectName,entry.reason,entry.state,entry.mirrorSyncState].some((value)=>value.toLowerCase().includes(needle))):revisions;},[query,revisions]);
  const selected=revisions.find((entry)=>selectedKey===entry.patchId+"@"+entry.patchRevision)??filtered[0];
  const canCreate=capabilities.includes("patch.create"),canReview=capabilities.includes("patch.review");
  const canPropose=capabilities.includes("rules.proposal.create");
  const canReviewAIRuleDraft=capabilities.includes("feishu.rule_change.confirm_write");
  const patterns=useMemo(()=>analyzePatchPatterns({ledger:state.patchLedger,contexts:analysisContexts(state)}),[state]);
  const canWriteMirror=capabilities.includes("patch.mirror.write"),canPullMirror=capabilities.includes("patch.mirror.pull");
  const connectorAvailable=false;
  const publishedRuleSet=[...state.ruleSetVersions].filter((entry)=>entry.status==="published").sort((a,b)=>b.version-a.version)[0];
  const subjectOptions=draft?.scopeType==="series"
    ? state.seriesDefinitions.map((entry)=>({id:entry.id,name:entry.name,revision:entry.revision}))
    : draft?.scopeType==="sku"
      ? state.skuDrawers.map((entry)=>({id:entry.id,name:entry.id+" · "+entry.targetPullKg+" kgf",revision:entry.revision}))
      : state.purchasableModels.map((entry)=>({id:entry.id,name:entry.name,revision:entry.revision}));

  const selectedApprovalEvidence=selected?currentPatchApprovalEvidence(state,selected):undefined;

  const openCreate=()=>setDraft({scopeType:"model",subjectEntityId:state.purchasableModels[0]?.id??"",parameterKey:"",operation:"set",operand:"",reason:""});
  const createPatch=()=>{
    if(!draft||!canCreate)return;
    const subject=subjectOptions.find((entry)=>entry.id===draft.subjectEntityId);
    if(!subject||!publishedRuleSet||!draft.parameterKey.trim()||!draft.reason.trim()){notify("请选择稳定对象、填写属性键和修改原因。");return;}
    const operand=draft.operation==="clear"?null:Number(draft.operand);
    if(draft.operation!=="clear"&&!Number.isFinite(operand)){notify("set/add/multiply 的操作值必须是数字。");return;}
    let record:PatchRevisionRecord;
    const patchId="patch:"+draft.scopeType+":"+crypto.randomUUID();
    try{
      const prepared=preparePatchOperationFromWorkspace({state,scopeType:draft.scopeType,subjectEntityId:subject.id,parameterKey:draft.parameterKey.trim(),operation:draft.operation,operand});
      record=buildPatchRevision({
        patchId,patchRevision:1,scopeType:draft.scopeType,layerType:draft.scopeType,
        subjectEntityId:subject.id,subjectName:subject.name,baseRuleSetVersion:publishedRuleSet.id,
        baseObjectRevision:subject.revision,state:"PENDING_REVIEW",mirrorSyncState:"NOT_SYNCED",attentionStates:[],
        reason:draft.reason.trim(),evidence:[prepared.traceHash],createdBy:actorName,createdAt:new Date().toISOString(),snapshotRefs:[],
        operations:[{operationId:patchId+":op:1",operationIndex:0,parameterKey:draft.parameterKey.trim(),operation:draft.operation,operand,before:prepared.before,after:prepared.after}],
      });
    }catch(error){notify(error instanceof Error?error.message:"无法从当前权威面板计算 Patch Trace");return;}
    mutate((workspace)=>{
      workspace.patchLedger=appendPatchRevision({ledger:workspace.patchLedger,revision:record,capabilities}).ledger;
      if(draft.scopeType==="series"){const entity=workspace.seriesDefinitions.find((entry)=>entry.id===subject.id);if(entity&&!entity.patchIds.includes(patchId))entity.patchIds.push(patchId);}
      if(draft.scopeType==="sku"){const entity=workspace.skuDrawers.find((entry)=>entry.id===subject.id);if(entity&&!entity.patchIds.includes(patchId))entity.patchIds.push(patchId);}
      if(draft.scopeType==="model"){const entity=workspace.purchasableModels.find((entry)=>entry.id===subject.id);if(entity&&!entity.patchIds.includes(patchId))entity.patchIds.push(patchId);}
    },false);
    setSelectedKey(patchId+"@1");setDraft(null);notify("Patch revision 1 已按当前权威面板计算 Trace，等待整体结果复核。");
  };
  const reviewCurrentObject=()=>{
    if(!selected||!canReview)return;
    try{
      mutate((workspace)=>{
        const current=workspace.patchLedger.revisions.find((entry)=>entry.patchId===selected.patchId&&entry.patchRevision===selected.patchRevision);
        if(!current)throw new Error("Patch revision 不存在");
        const {batch}=createWorkspacePatchReview({state:workspace,target:current,reviewedBy:actorName,reviewedAt:new Date().toISOString()});
        workspace.patchReviewBatches=[...workspace.patchReviewBatches.filter((entry)=>entry.batchId!==batch.batchId),batch];
      },false);
      notify("当前对象的最终面板、合法范围与完整 Patch 集合已完成整体复核。");
    }catch(error){notify(error instanceof Error?error.message:"整体复核失败");}
  };
  const transition=(nextState:"APPROVED"|"ACTIVE"|"WITHDRAWN")=>{
    if(!selected||!canReview)return;
    try{
      mutate((workspace)=>{workspace.patchLedger=reviewWorkspacePatchRevision({state:workspace,patchId:selected.patchId,patchRevision:selected.patchRevision,nextState,reviewer:actorName,reviewedAt:new Date().toISOString(),capabilities}).patchLedger;},false);
      notify(nextState==="APPROVED"?"Patch 已批准，仍需显式启用。":nextState==="ACTIVE"?"Patch 已进入生效状态。":"Patch 已撤回。");
    }catch(error){notify(error instanceof Error?error.message:"Patch 状态更新失败");}
  };

  const createRuleProposal=()=>{
    if(!proposalPattern||!canPropose)return;
    try{
      mutate((workspace)=>{workspace.patchLedger=createRuleSourceChangeDraft({ledger:workspace.patchLedger,pattern:proposalPattern,rationale:proposalRationale,createdBy:actorName,createdAt:new Date().toISOString(),capabilities}).ledger;},false);
      setProposalPattern(null);setProposalRationale("");notify("已创建共享规则变更草稿；尚未写飞书、发布 RuleSet 或改变任何 Patch 状态。");
    }catch(error){notify(error instanceof Error?error.message:"规则变更草稿创建失败");}
  };
  const confirmAIRuleDraft=async(changeDraftId:string,expectedCommandHash:string)=>{
    try{
      const response=await fetch("/api/ai/rule-source-change-drafts/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:revision,changeDraftId,expectedCommandHash,idempotencyKey:`confirm-ai-rule-draft:${changeDraftId}:${expectedCommandHash}`})});
      const payload=await response.json() as {state?:WorkspaceState;revision?:number;error?:string};
      if(!response.ok||!payload.state||typeof payload.revision!=="number")throw new Error(payload.error??"AI 规则草稿确认失败");
      replaceWorkspace(payload.state,payload.revision);
      notify("AI 规则草稿已人工确认；尚未写入飞书、拉取或发布 RuleSet。");
    }catch(error){notify(error instanceof Error?error.message:"AI 规则草稿确认失败");}
  };
  return <div className="page-stack patch-ledger-page">
    <section className="patch-ledger-hero">
      <div><span className="eyebrow">AUTHORITATIVE · VERSIONED · REPLAYABLE</span><h2>Patch 权威台账</h2><p>运行时只从本地持久化账本加载 Patch。名称、飞书行号和排序不参与关联；Snapshot 引用的 revision 永不原地改写。</p></div>
      <div className="patch-ledger-actions">
        <button type="button" disabled={!canCreate} title={canCreate?"创建新的稳定 Patch revision":"缺少 Patch 创建权限"} onClick={openCreate}><Plus size={15}/>创建 Patch</button>
        <button type="button" disabled={!canPullMirror||!connectorAvailable} title={!canPullMirror?"缺少 Patch 台账拉取权限":"当前飞书工作簿尚未配置 Patch 台账连接器"}><FileClock size={15}/>显式拉取镜像</button>
        <button type="button" disabled={!canWriteMirror||!connectorAvailable} title={!canWriteMirror?"缺少 Patch 台账写入权限":"当前飞书工作簿尚未配置 Patch 台账连接器"}><DatabaseZap size={15}/>写入飞书镜像</button>
      </div>
    </section>
    <section className="patch-ledger-stats">
      <article><strong>{revisions.length}</strong><span>Patch revisions</span></article><article><strong>{revisions.filter((entry)=>entry.state==="ACTIVE").length}</strong><span>生效中</span></article><article><strong>{revisions.filter((entry)=>entry.state==="REBASE_REQUIRED").length}</strong><span>需要 Rebase</span></article><article><strong>{revisions.filter((entry)=>entry.snapshotRefs.length>0).length}</strong><span>已被 Snapshot 冻结</span></article><article><strong>{state.patchLedger.migrationReviewItems.length}</strong><span>迁移待复核</span></article>
    </section>
    {!connectorAvailable?<section className="patch-ledger-connector-note"><AlertTriangle size={18}/><div><strong>飞书 Patch 台账连接器未配置</strong><p>本地账本仍是权威来源并可完整重放。系统不会把未执行的远端写入标为成功；待工作表和连接器可用后可按幂等键安全续传。</p></div></section>:null}
    {state.patchLedger.migrationReviewItems.length?<section className="patch-ledger-migration-review"><header><div><span className="eyebrow">MIGRATION REVIEW</span><h3>迁移待复核</h3></div><strong>{state.patchLedger.migrationReviewItems.length}</strong></header><p>无法无损推断的历史数据已原样保留；系统不会改写旧 Snapshot、猜测 Patch revision 或按名称重新绑定。</p><div>{state.patchLedger.migrationReviewItems.map((item)=><article key={item.id}><span>{item.reason}</span><code>{item.patchId} · revision {item.patchRevision}</code><small>{item.id}</small></article>)}</div></section>:null}
    {draft?<section className="patch-ledger-create">
      <header><div><span className="eyebrow">NEW PATCH REVISION</span><h3>创建个体 Patch 草稿</h3><p>按稳定对象 ID 保存；名称只用于显示。个体 Patch 不会自动写入通用规则。</p></div><button type="button" aria-label="关闭" onClick={()=>setDraft(null)}><X size={18}/></button></header>
      <div className="patch-ledger-create-grid">
        <label><span>作用对象</span><select value={draft.scopeType} onChange={(event)=>{const scopeType=event.target.value as PatchDraft["scopeType"];const choices=scopeType==="series"?state.seriesDefinitions:scopeType==="sku"?state.skuDrawers:state.purchasableModels;setDraft({...draft,scopeType,subjectEntityId:choices[0]?.id??""});}}><option value="series">Series</option><option value="sku">SKU 抽屉</option><option value="model">Model</option></select></label>
        <label><span>稳定对象 ID</span><select value={draft.subjectEntityId} onChange={(event)=>setDraft({...draft,subjectEntityId:event.target.value})}>{subjectOptions.map((entry)=><option key={entry.id} value={entry.id}>{entry.name} · {entry.id}</option>)}</select></label>
        <label><span>属性键</span><input value={draft.parameterKey} onChange={(event)=>setDraft({...draft,parameterKey:event.target.value})} placeholder="例如 杆最大拉力kgf"/></label>
        <label><span>操作</span><select value={draft.operation} onChange={(event)=>setDraft({...draft,operation:event.target.value as PatchDraft["operation"]})}><option value="set">set</option><option value="add">add</option><option value="multiply">multiply</option><option value="clear">clear</option></select></label>
        <label><span>操作值</span><input type="number" disabled={draft.operation==="clear"} value={draft.operand} onChange={(event)=>setDraft({...draft,operand:event.target.value})} placeholder={draft.operation==="clear"?"clear 不需要值":"数字"}/></label>
        <label className="span-2"><span>修改原因</span><textarea value={draft.reason} onChange={(event)=>setDraft({...draft,reason:event.target.value})} placeholder="说明为何需要个体修正，以及优势与代价"/></label>
      </div><footer><span>基线：{publishedRuleSet?.id??"没有已发布 RuleSetVersion"}</span><button type="button" disabled={!publishedRuleSet} onClick={createPatch}><Plus size={15}/>保存 Patch 草稿</button></footer>
    </section>:null}
    <section className="patch-pattern-analysis">
      <header><div><span className="eyebrow">HUMAN-GATED PATTERN ANALYSIS</span><h3>个体 Patch 汇总分析</h3><p>按作用层、属性、操作、钓法、类型、功能与源重量段确定性归组；不会自动提升为通用规则。</p></div><strong>{patterns.length} 个模式</strong></header>
      <div className="patch-pattern-grid">{patterns.map((pattern)=><article key={pattern.patternId}><div><strong>{pattern.parameterKey}</strong><span>{pattern.layerType} · {pattern.operation} · {pattern.direction}</span></div><b>{pattern.frequency} 个 revision</b><small>{[pattern.methodId,pattern.typeId,pattern.functionId,pattern.weightBandId].filter(Boolean).join(" · ")||"未提供上下文维度"}</small><button type="button" disabled={!canPropose} title={canPropose?"人工归纳并创建本地共享规则草稿":"缺少 rules.proposal.create 权限"} onClick={()=>{setProposalPattern(pattern);setProposalRationale("");}}>归纳为规则草稿</button></article>)}</div>
      {!patterns.length?<p className="patch-ledger-empty">尚无可归纳的 ACTIVE / PARTIALLY_ABSORBED 个体 Patch。</p>:null}
      {proposalPattern?<div className="patch-pattern-proposal"><div><strong>共享规则变更草稿</strong><code>{proposalPattern.patternId}</code></div><textarea value={proposalRationale} onChange={(event)=>setProposalRationale(event.target.value)} placeholder="说明稳定模式、适用范围、优势与代价，以及跨对象影响预览结论"/><div><button type="button" onClick={()=>setProposalPattern(null)}>取消</button><button type="button" disabled={!proposalRationale.trim()} onClick={createRuleProposal}>仅创建本地草稿</button></div></div>:null}
      {state.patchLedger.ruleSourceChangeDrafts.length?<div className="patch-rule-drafts"><h4>共享规则草稿</h4>{state.patchLedger.ruleSourceChangeDrafts.map((draft)=><article key={draft.id}><strong>{draft.parameterKey} · {draft.proposedOperation}</strong><span>{draft.status} · {draft.sourcePatchRevisionRefs.length} 个来源 revision · 影响 {draft.impactSubjectEntityIds.length} 个对象</span><code>{draft.id}</code></article>)}</div>:null}
      {state.aiRuleSourceChangeDrafts.length?<div className="patch-rule-drafts"><h4>AI 规则源变更草稿</h4>{state.aiRuleSourceChangeDrafts.map((draft)=><article key={draft.changeDraftId}><strong>{draft.targetRuleRef.parameterKey} · {draft.proposedChange.operation} {String(draft.proposedChange.operand??"")}</strong><span>{draft.state} · 影响 {draft.impactPreview.affectedSeries} Series / {draft.impactPreview.affectedSkus} SKU / {draft.impactPreview.affectedModels} Model · 新增 {draft.impactPreview.newErrors} 个错误</span><code>{draft.changeDraftId}</code><small>规则 {draft.targetRuleRef.stableRuleId} · source {draft.targetRuleRef.sourceRevision}</small>{draft.state==="LOCAL_DRAFT"||draft.state==="IMPACT_PREVIEW_READY"?<button type="button" disabled={!canReviewAIRuleDraft||!draft.impactPreview.coverage.complete} title={!canReviewAIRuleDraft?"缺少规则写回确认权限":!draft.impactPreview.coverage.complete?"影响预览覆盖不完整，不能确认":"确认当前影响预览；不会自动写入飞书"} onClick={()=>void confirmAIRuleDraft(draft.changeDraftId,draft.commandHash)}><ShieldCheck size={15}/>人工确认草稿</button>:draft.humanReview?<small>已由 {draft.humanReview.confirmedBy} 于 {draft.humanReview.confirmedAt} 确认</small>:null}</article>)}</div>:null}
    </section>
    {state.patchLedger.absorptionAssessments.length?<section className="patch-rule-drafts"><h4>RuleSet 发布后吸收评估</h4>{state.patchLedger.absorptionAssessments.map((assessment)=><article key={assessment.assessmentId}><strong>{assessment.patchId} · revision {assessment.sourcePatchRevision} → {assessment.resultPatchRevision}</strong><span>{assessment.resultState} · {assessment.publishedRuleSetVersion} · {assessment.operationEvidence.length} 条重算证据</span><code>{assessment.assessmentId}</code></article>)}</section>:null}
    <section className="patch-ledger-layout">
      <div className="patch-ledger-list"><label className="patch-ledger-search"><Search size={15}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="按稳定 ID、状态或原因搜索"/></label><div className="patch-ledger-list-scroll">{filtered.map((entry)=>{const key=entry.patchId+"@"+entry.patchRevision;return <button type="button" className={selected===entry?"active":""} key={key} onClick={()=>setSelectedKey(key)}><span><strong>{entry.patchId}</strong><small>revision {entry.patchRevision} · {entry.layerType}</small></span><em>{stateLabels[entry.state]}</em></button>;})}{!filtered.length?<p className="patch-ledger-empty">没有符合条件的 Patch revision。</p>:null}</div></div>
      <div className="patch-ledger-detail">{selected?<><header><div><span className="eyebrow">STABLE SUBJECT</span><h3>{selected.subjectName||selected.subjectEntityId}</h3><code>{selected.subjectEntityId}</code></div><div className="patch-ledger-badges"><span>{stateLabels[selected.state]}</span><span>{mirrorLabels[selected.mirrorSyncState]}</span>{selected.attentionStates.map((attention)=><span className="warning" key={attention}>{attention}</span>)}</div></header>
        <div className="patch-ledger-review-actions">{["DRAFT","PENDING_REVIEW","APPROVED"].includes(selected.state)?<button type="button" disabled={!canReview||selected.snapshotRefs.length>0} onClick={reviewCurrentObject}><ShieldCheck size={15}/>复核当前整体结果</button>:null}{selected.state==="DRAFT"||selected.state==="PENDING_REVIEW"?<button type="button" disabled={!canReview||selected.snapshotRefs.length>0||!selectedApprovalEvidence} title={selectedApprovalEvidence?"使用当前对象的整体复核证据批准":"请先完成当前对象最终范围与完整 Patch 集合复核"} onClick={()=>transition("APPROVED")}><CheckCircle2 size={15}/>批准 revision</button>:null}{selected.state==="APPROVED"?<button type="button" disabled={!canReview||selected.snapshotRefs.length>0||!selectedApprovalEvidence} title={selectedApprovalEvidence?"使用当前对象的整体复核证据启用":"整体复核证据缺失或已失效"} onClick={()=>transition("ACTIVE")}><ShieldCheck size={15}/>启用 Patch</button>:null}{["DRAFT","PENDING_REVIEW","APPROVED"].includes(selected.state)?<button type="button" disabled={!canReview||selected.snapshotRefs.length>0} onClick={()=>transition("WITHDRAWN")}>撤回</button>:null}</div>
        {!selectedApprovalEvidence&&["DRAFT","PENDING_REVIEW","APPROVED"].includes(selected.state)?<p className="patch-ledger-empty">批准与启用已关闭：请先在 Series / SKU / Model 整体结果页完成最终范围校验和批量人工复核；Patch 无需逐条单独审批。</p>:null}
        <dl><div><dt>Patch</dt><dd>{selected.patchId} / revision {selected.patchRevision}</dd></div><div><dt>作用层</dt><dd>{selected.scopeType} · {selected.layerType}</dd></div><div><dt>基线</dt><dd>{selected.baseRuleSetVersion} · object revision {selected.baseObjectRevision}</dd></div><div><dt>创建</dt><dd>{selected.createdBy} · {selected.createdAt}</dd></div><div><dt>原因</dt><dd>{selected.reason||"未填写"}</dd></div></dl>
        <div className="patch-ledger-operations"><h4><ShieldCheck size={16}/>确定性操作顺序</h4>{[...selected.operations].sort((a,b)=>a.operationIndex-b.operationIndex).map((operation)=><div key={operation.operationId}><b>{operation.operationIndex+1}</b><code>{operation.parameterKey}</code><span>{operation.operation}</span><strong>{String(operation.operand??"—")}</strong><small>{operation.operationId}</small></div>)}</div>
        <div className="patch-ledger-snapshots"><h4><Link2 size={16}/>Snapshot 引用</h4>{selected.snapshotRefs.length?selected.snapshotRefs.map((snapshotId)=><code key={snapshotId}>{snapshotId}</code>):<span>尚未被 Snapshot 引用</span>}</div>
      </>:<p className="patch-ledger-empty">账本中还没有 Patch revision。</p>}</div>
    </section>
  </div>;
}
