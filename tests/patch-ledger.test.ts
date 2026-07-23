import assert from "node:assert/strict";
import test from "node:test";
import { analyzePatchPatterns, assessPatchAbsorption, appendPatchRevision, beginPatchMirrorSync, buildPatchRevision, createRuleSourceChangeDraft, emptyPatchLedger, importLegacyPatchesToLedger, migratePatchLedger, orderedPatchReferences, PatchLedgerError, projectionPatchViewFromLedger, reconcilePatchMirrorPull, recordPatchMirrorResult, rebasePatchRevision, replayPatchRevision, resolvePatchRevision, reviewPatchRevision, updatePatchMirrorSuggestion } from "../lib/patch-ledger";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { createSeedState } from "../lib/seed";

const now = "2026-07-22T00:00:00.000Z";
function makeRevision(overrides: Record<string, unknown> = {}) {
  return buildPatchRevision({
    patchId: "patch:rod:1", patchRevision: 1, scopeType: "model", layerType: "model",
    subjectEntityId: "model:rod:1", subjectName: "Old name",
    baseRuleSetVersion: "ruleset:1", baseObjectRevision: 3,
    state: "ACTIVE", mirrorSyncState: "NOT_SYNCED", attentionStates: [],
    reason: "balance", evidence: [], createdBy: "ou_editor", createdAt: now, snapshotRefs: [],
    operations: [
      { operationId: "op:set", operationIndex: 0, parameterKey: "power", operation: "set", operand: 4, before: 2, after: 4 },
      { operationId: "op:add", operationIndex: 1, parameterKey: "power", operation: "add", operand: 2, before: 4, after: 6 },
      { operationId: "op:multiply", operationIndex: 2, parameterKey: "power", operation: "multiply", operand: 3, before: 6, after: 18 },
    ], ...overrides,
  } as Parameters<typeof buildPatchRevision>[0]);
}
test("patchId and revision are idempotent and immutable on conflict", () => {
  const first=appendPatchRevision({ledger:emptyPatchLedger(),revision:makeRevision(),capabilities:["patch.create"]});
  const retry=appendPatchRevision({ledger:first.ledger,revision:makeRevision(),capabilities:["patch.create"]});
  assert.equal(retry.idempotent,true); assert.equal(retry.ledger.revisions.length,1);
  assert.throws(()=>appendPatchRevision({ledger:first.ledger,revision:makeRevision({reason:"changed"}),capabilities:["patch.create"]}), (e:unknown)=>e instanceof PatchLedgerError&&e.code==="PATCH_REVISION_IMMUTABLE");
});
test("set add multiply replay strictly by operationIndex", () => {
  const result=replayPatchRevision({power:2},makeRevision());
  assert.equal(result.value.power,18);
  assert.deepEqual(result.trace.map((x)=>x.operationId),["op:set","op:add","op:multiply"]);
  assert.deepEqual(replayPatchRevision({power:2},makeRevision()),result);
});
test("新 Patch 只接受规范操作，clear 重放、视图与 rebase 均恢复继承值", () => {
  for(const operation of ["remove","min","max"]){
    const legacy=structuredClone(makeRevision()) as unknown as Record<string,unknown>;
    ((legacy.operations as Array<Record<string,unknown>>)[0]).operation=operation;
    assert.throws(()=>buildPatchRevision(legacy as never),(error:unknown)=>
      error instanceof PatchLedgerError&&error.code==="PATCH_OPERATION_UNSUPPORTED");
  }
  const clear=makeRevision({
    patchId:"patch:clear",
    operations:[
      {operationId:"op:add",operationIndex:0,parameterKey:"power",operation:"add",operand:2,before:8,after:10},
      {operationId:"op:clear",operationIndex:1,parameterKey:"power",operation:"clear",operand:null,before:10,after:8},
    ],
  });
  const replayed=replayPatchRevision({power:8},clear);
  assert.equal(replayed.value.power,8);
  assert.deepEqual(replayed.trace.map((entry)=>entry.after),[10,8]);
  const view=projectionPatchViewFromLedger({...emptyPatchLedger(),revisions:[clear]});
  assert.deepEqual(view[0].operations,[{op:"add",path:"power",value:2},{op:"clear",path:"power"}]);

  const source={...clear,state:"REBASE_REQUIRED" as const};
  const rebased=rebasePatchRevision({
    ledger:{...emptyPatchLedger(),revisions:[source]},
    patchId:source.patchId,sourcePatchRevision:1,newBaseRuleSetVersion:"ruleset:2",
    newBaseObjectRevision:4,newBaseValues:{power:12},actor:"reviewer",rebasedAt:now,
    capabilities:["patch.rebase"],
  });
  assert.deepEqual(rebased.revision.operations.map((operation)=>[operation.before,operation.after]),[[12,14],[14,12]]);
  assert.equal(rebased.revision.state,"PENDING_REVIEW");
});
test("同一 revision 的 set/clear 冲突以及缺失继承值使用稳定错误码阻断", () => {
  assert.throws(()=>makeRevision({operations:[
    {operationId:"op:set",operationIndex:0,parameterKey:"power",operation:"set",operand:4,before:2,after:4},
    {operationId:"op:clear",operationIndex:1,parameterKey:"power",operation:"clear",operand:null,before:4,after:2},
  ]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_SET_CLEAR_CONFLICT");
  const clear=makeRevision({patchId:"patch:clear:missing",operations:[
    {operationId:"op:clear",operationIndex:0,parameterKey:"power",operation:"clear",operand:null,before:undefined,after:undefined},
  ]});
  assert.throws(()=>replayPatchRevision({},clear),(error:unknown)=>
    error instanceof PatchLedgerError&&error.code==="PATCH_CLEAR_INHERITANCE_MISSING");
});
test("PatchLedger v4 将 remove 和可验证 min/max 幂等规范化并保留 raw intent", () => {
  const removeRevision=makeRevision({
    patchId:"patch:legacy:remove",
    operations:[{operationId:"op:remove",operationIndex:0,parameterKey:"power",operation:"clear",operand:null,before:10,after:8}],
  });
  Object.assign(removeRevision.operations[0] as unknown as Record<string,unknown>,{
    operation:"remove",legacyNote:"keep-remove",
  });
  const minRevision=makeRevision({
    patchId:"patch:legacy:min",
    operations:[{operationId:"op:min",operationIndex:0,parameterKey:"power",operation:"set",operand:6,before:10,after:6}],
  });
  Object.assign(minRevision.operations[0] as unknown as Record<string,unknown>,{
    operation:"min",legacyNote:"keep-min",
  });
  const legacy={...emptyPatchLedger(),schemaVersion:4,revisions:[removeRevision,minRevision],legacyAudit:{keep:true}};
  const migrated=migratePatchLedger(legacy as never);
  const remove=migrated.revisions.find((revision)=>revision.patchId===removeRevision.patchId)!;
  const min=migrated.revisions.find((revision)=>revision.patchId===minRevision.patchId)!;
  assert.equal(migrated.schemaVersion,5);
  assert.deepEqual([remove.operations[0].operation,remove.operations[0].operand],["clear",null]);
  assert.equal((remove.operations[0].rawIntent as {legacyNote:string}).legacyNote,"keep-remove");
  assert.deepEqual([min.operations[0].operation,min.operations[0].operand],["set",6]);
  assert.equal((min.operations[0].rawIntent as {legacyNote:string}).legacyNote,"keep-min");
  assert.deepEqual((migrated as unknown as {legacyAudit:unknown}).legacyAudit,{keep:true});
  assert.equal(migrated.migrationReviewItems.some((item)=>item.id==="patch-ledger-migration:semantic"),false);
  assert.deepEqual(migratePatchLedger(migrated),migrated);
});
test("不可验证 min/max 进入复核，Snapshot 引用 revision 保持原始操作和 hash", () => {
  const invalid=makeRevision({
    patchId:"patch:legacy:min:invalid",
    operations:[{operationId:"op:min",operationIndex:0,parameterKey:"power",operation:"set",operand:6,before:10,after:7}],
  });
  (invalid.operations[0] as unknown as {operation:string}).operation="min";
  const frozen=makeRevision({
    patchId:"patch:legacy:frozen",snapshotRefs:["snapshot:frozen"],
    operations:[{operationId:"op:remove",operationIndex:0,parameterKey:"power",operation:"clear",operand:null,before:10,after:8}],
  });
  (frozen.operations[0] as unknown as {operation:string}).operation="remove";
  const frozenHash=frozen.revisionHash;
  const migrated=migratePatchLedger({...emptyPatchLedger(),schemaVersion:4,revisions:[invalid,frozen]} as never);
  assert.equal((migrated.revisions[0].operations[0] as unknown as {operation:string}).operation,"min");
  assert.ok(migrated.migrationReviewItems.some((item)=>
    item.patchId===invalid.patchId&&item.reason==="LEGACY_PATCH_FROZEN_RESULT_MISMATCH"));
  const migratedFrozen=migrated.revisions.find((revision)=>revision.patchId===frozen.patchId)!;
  assert.equal((migratedFrozen.operations[0] as unknown as {operation:string}).operation,"remove");
  assert.equal(migratedFrozen.revisionHash,frozenHash);
  assert.ok(migrated.migrationReviewItems.some((item)=>
    item.patchId===frozen.patchId&&item.reason==="LEGACY_SNAPSHOT_PATCH_OPERATION_FROZEN"));
  assert.throws(()=>orderedPatchReferences([migratedFrozen]),(error:unknown)=>
    error instanceof PatchLedgerError&&error.code==="PATCH_SNAPSHOT_OPERATION_NON_CANONICAL");
  assert.deepEqual(migratePatchLedger(migrated),migrated);
});
test("旧 Projection Patch 的 min/max 仅在冻结 before/after 可验证时导入", () => {
  const common={
    scope:"model",scopeId:"model:legacy",reason:"legacy",author:"migration",
    baseProjectionId:"projection:legacy",baseRuleSetVersion:"ruleset:1",
    baseObjectRevision:3,status:"approved",order:0,rules:[],
  };
  const imported=importLegacyPatchesToLedger(emptyPatchLedger(),[
    {...common,id:"patch:legacy:valid",operations:[
      {op:"max",path:"power",value:8,before:5,after:8,legacyField:"keep"},
    ]},
    {...common,id:"patch:legacy:review",operations:[
      {op:"min",path:"power",value:4},
    ]},
  ] as never);
  const valid=imported.revisions.find((revision)=>revision.patchId==="patch:legacy:valid")!;
  assert.deepEqual([valid.operations[0].operation,valid.operations[0].operand],["set",8]);
  assert.equal((valid.operations[0].rawIntent as {legacyField:string}).legacyField,"keep");
  assert.equal(imported.revisions.some((revision)=>revision.patchId==="patch:legacy:review"),false);
  assert.ok(imported.migrationReviewItems.some((item)=>
    item.patchId==="patch:legacy:review"&&item.reason==="LEGACY_PATCH_MIN_MAX_REVIEW_REQUIRED"));
});
test("stable ID survives rename, baseline changes rebase, missing ID is orphaned", () => {
  const r=makeRevision();
  assert.equal(resolvePatchRevision({revision:r,existingSubjectIds:["model:rod:1"],currentRuleSetVersion:"ruleset:1",currentObjectRevision:3}).state,"ACTIVE");
  assert.equal(resolvePatchRevision({revision:r,existingSubjectIds:["model:rod:1"],currentRuleSetVersion:"ruleset:2",currentObjectRevision:3}).state,"REBASE_REQUIRED");
  const orphan=resolvePatchRevision({revision:r,existingSubjectIds:["model:same-name"],currentRuleSetVersion:"ruleset:1",currentObjectRevision:3});
  assert.deepEqual(orphan.attentionStates,["ORPHANED"]); assert.equal(orphan.subjectEntityId,"model:rod:1");
});
test("review permission is separate and snapshot referenced revision is immutable", () => {
  const ledger: ReturnType<typeof emptyPatchLedger>={...emptyPatchLedger(),revisions:[makeRevision()]};
  assert.throws(()=>reviewPatchRevision({ledger,patchId:"patch:rod:1",patchRevision:1,nextState:"APPROVED",reviewer:"x",reviewedAt:now,capabilities:[]}), (e:unknown)=>e instanceof PatchLedgerError&&e.code==="PATCH_PERMISSION_DENIED");
  const frozen={...ledger,revisions:[{...ledger.revisions[0],snapshotRefs:["snapshot:1"]}]};
  assert.throws(()=>reviewPatchRevision({ledger:frozen,patchId:"patch:rod:1",patchRevision:1,nextState:"APPROVED",reviewer:"x",reviewedAt:now,capabilities:["patch.review"]}), (e:unknown)=>e instanceof PatchLedgerError&&e.code==="PATCH_REVISION_IMMUTABLE");
  assert.throws(()=>reviewPatchRevision({ledger,patchId:"patch:rod:1",patchRevision:1,nextState:"APPROVED",reviewer:"x",reviewedAt:now,capabilities:["patch.review"]}), (e:unknown)=>e instanceof PatchLedgerError&&e.code==="PATCH_OFFSET_POLICY_MISSING");
});
test("unavailable or partial mirror never reports SYNCED and retry is idempotent", () => {
  const ledger: ReturnType<typeof emptyPatchLedger>={...emptyPatchLedger(),revisions:[makeRevision()]};
  const started=beginPatchMirrorSync({ledger,patchId:"patch:rod:1",patchRevision:1,idempotencyKey:"sync:1",now,capabilities:["patch.mirror.write"]});
  assert.equal(beginPatchMirrorSync({ledger:started.ledger,patchId:"patch:rod:1",patchRevision:1,idempotencyKey:"sync:1",now,capabilities:["patch.mirror.write"]}).idempotent,true);
  const partial=recordPatchMirrorResult({ledger:started.ledger,idempotencyKey:"sync:1",connectorAvailable:true,now,operationResults:[{operationId:"op:set",status:"VERIFIED"},{operationId:"op:add",status:"WRITTEN"}]});
  assert.notEqual(partial.revisions[0].mirrorSyncState,"SYNCED");
  const failed=recordPatchMirrorResult({ledger:started.ledger,idempotencyKey:"sync:1",connectorAvailable:false,now,operationResults:[],readbackEvidence:{connector:"unsupported"}});
  assert.equal(failed.revisions[0].mirrorSyncState,"WRITE_FAILED"); assert.equal(failed.mirrorCommands[0].state,"FAILED");
});
test("镜像命令只生成规范 payload，幂等键不能绑定不同内容", () => {
  const revision=makeRevision({
    patchId:"patch:mirror:clear",
    operations:[{operationId:"op:clear",operationIndex:0,parameterKey:"power",operation:"clear",operand:null,before:10,after:8}],
  });
  const ledger={...emptyPatchLedger(),revisions:[revision]};
  const started=beginPatchMirrorSync({
    ledger,patchId:revision.patchId,patchRevision:1,idempotencyKey:"sync:canonical",
    now,capabilities:["patch.mirror.write"],
  });
  assert.equal(started.command.payloadHash.length>0,true);
  assert.deepEqual(
    [started.command.payload[0].operation,started.command.payload[0].operand],
    ["clear",null],
  );
  const changed=structuredClone(started.ledger);
  changed.revisions[0].operations[0].after=9;
  assert.throws(()=>beginPatchMirrorSync({
    ledger:changed,patchId:revision.patchId,patchRevision:1,idempotencyKey:"sync:canonical",
    now,capabilities:["patch.mirror.write"],
  }),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_MIRROR_IDEMPOTENCY_CONFLICT");
});
test("镜像拉取沿用 remove/min/max 迁移语义并隔离不可验证行", () => {
  const revision=makeRevision({
    patchId:"patch:mirror:legacy",
    operations:[{operationId:"op:set",operationIndex:0,parameterKey:"power",operation:"set",operand:6,before:10,after:6}],
  });
  const started=beginPatchMirrorSync({
    ledger:{...emptyPatchLedger(),revisions:[revision]},
    patchId:revision.patchId,patchRevision:1,idempotencyKey:"sync:legacy",
    now,capabilities:["patch.mirror.write"],
  });
  const canonical=started.command.payload[0];
  const valid=reconcilePatchMirrorPull({
    ledger:started.ledger,capabilities:["patch.mirror.pull"],remoteRows:[{
      ...canonical,remoteRowId:"row:valid",operation:"min",operand:6,
    } as never],
  });
  assert.deepEqual(valid.issues,[]);
  const invalid=reconcilePatchMirrorPull({
    ledger:started.ledger,capabilities:["patch.mirror.pull"],remoteRows:[{
      ...canonical,remoteRowId:"row:invalid",operation:"max",operand:20,after:6,
    } as never],
  });
  assert.ok(invalid.issues.some((issue)=>issue.code==="LEGACY_PATCH_FROZEN_RESULT_MISMATCH"));
  assert.ok(invalid.quarantinedRemoteRowIds.includes("row:invalid"));
  assert.deepEqual(invalid.ledger.revisions,started.ledger.revisions);
});
test("explicit mirror pull reports missing unknown duplicate rows without deleting local ledger", () => {
  const ledger: ReturnType<typeof emptyPatchLedger>={...emptyPatchLedger(),revisions:[makeRevision()]}; const before=structuredClone(ledger);
  const pulled=reconcilePatchMirrorPull({ledger,remoteDetailKeys:["unknown@1@op","unknown@1@op"],capabilities:["patch.mirror.pull"]});
  assert.deepEqual(pulled.ledger.revisions,before.revisions);
  assert.ok(pulled.issues.some((x)=>x.code==="PATCH_MIRROR_ROW_MISSING"));
  assert.ok(pulled.issues.some((x)=>x.code==="PATCH_MIRROR_UNKNOWN_KEY"));
  assert.ok(pulled.issues.some((x)=>x.code==="PATCH_MIRROR_DUPLICATE_KEY"));
});

test("镜像受控字段篡改和不完整组被隔离，并生成可补写幂等键", () => {
  const revision=makeRevision(), ledger={...emptyPatchLedger(),revisions:[revision]};
  const first=revision.operations[0];
  const pulled=reconcilePatchMirrorPull({ledger,remoteRevision:"116",pulledAt:now,capabilities:["patch.mirror.pull"],remoteRows:[{
    remoteRowId:"row:1",patchId:revision.patchId,patchRevision:1,operationId:first.operationId,operationIndex:first.operationIndex,
    scopeType:revision.scopeType,layerType:revision.layerType,subjectEntityId:"model:tampered",baseRuleSetVersion:revision.baseRuleSetVersion,
    baseObjectRevision:revision.baseObjectRevision,parameterKey:first.parameterKey,operation:first.operation,operand:first.operand,before:first.before,after:first.after,snapshotRefs:[],
  }]});
  assert.ok(pulled.issues.some((issue)=>issue.code==="PATCH_MIRROR_AUDIT_FIELD_TAMPERED"&&issue.source==="patch"));
  assert.ok(pulled.issues.some((issue)=>issue.code==="PATCH_MIRROR_GROUP_INCOMPLETE"));
  assert.deepEqual(pulled.quarantinedRemoteRowIds,["row:1"]);
  assert.equal(pulled.refillDetailKeys.length,2);
  assert.deepEqual(pulled.ledger.revisions,ledger.revisions);
});

test("协作状态 expectedRevision 冲突只进入 CONFLICT，不覆盖本地Patch", () => {
  const revision=makeRevision(), ledger={...emptyPatchLedger(),revisions:[revision]};
  const result=updatePatchMirrorSuggestion({ledger,patchId:revision.patchId,patchRevision:1,expectedRemoteRevision:"115",actualRemoteRevision:"116",value:true,now,capabilities:["patch.mirror.write"]});
  assert.equal(result.revisions[0].mirrorSyncState,"CONFLICT");
  assert.equal(result.revisions[0].revisionHash,revision.revisionHash);
  assert.ok(result.mirrorPullAudits[0].issues.some((issue)=>issue.code==="PATCH_MIRROR_EXPECTED_REVISION_CONFLICT"));
});
test("snapshot ordered patch refs and hash remain frozen after a new revision", () => {
  const v1=makeRevision(); const frozen=orderedPatchReferences([v1]); const copy=structuredClone(frozen);
  orderedPatchReferences([v1,makeRevision({patchRevision:2,supersedesPatchId:"patch:rod:1"})]);
  assert.deepEqual(frozen,copy);
  assert.deepEqual(frozen.references[0].orderedOperationIds,["op:set","op:add","op:multiply"]);
});
test("workspace v9 migrates sequentially to current ledger schema and repeated migration is idempotent", () => {
  const legacy=structuredClone(createSeedState()) as unknown as Record<string,unknown>;
  legacy.schemaVersion=9; delete legacy.patchLedger;
  const once=migrateWorkspaceState(legacy), twice=migrateWorkspaceState(once);
  assert.equal(once.schemaVersion,CURRENT_WORKSPACE_SCHEMA_VERSION); assert.deepEqual(twice.patchLedger,once.patchLedger);
  assert.equal(twice.projectionPatches.length,once.projectionPatches.length);
});

test("seed patches are persisted in the ledger and runtime view is ledger-authoritative", () => {
  const state=createSeedState();
  assert.ok(state.patchLedger.revisions.length>=4);
  const view=projectionPatchViewFromLedger(state.patchLedger);
  assert.deepEqual(view.map((patch)=>patch.id).sort(),state.patchLedger.revisions.filter((revision)=>revision.state==="ACTIVE").map((revision)=>revision.patchId).sort());
  const snapshot=state.configurationSnapshots[0];
  assert.ok(snapshot.patchReferences?.length);
  for(const reference of snapshot.patchReferences??[]){
    const revision=state.patchLedger.revisions.find((entry)=>entry.patchId===reference.patchId&&entry.patchRevision===reference.patchRevision);
    assert.ok(revision?.snapshotRefs.includes(snapshot.id));
  }
});

test("legacy snapshot without revision refs is preserved and sent to migration review", () => {
  const legacy=structuredClone(createSeedState()) as unknown as Record<string,unknown>;
  legacy.schemaVersion=9; delete legacy.patchLedger;
  const snapshots=legacy.configurationSnapshots as Array<Record<string,unknown>>;
  for(const snapshot of snapshots) delete snapshot.patchReferences;
  const before=structuredClone(snapshots);
  const migrated=migrateWorkspaceState(legacy);
  assert.deepEqual(migrated.configurationSnapshots,before);
  assert.ok(migrated.patchLedger.migrationReviewItems.some((entry)=>entry.reason==="LEGACY_SNAPSHOT_PATCH_REFERENCES_UNAVAILABLE"));
});

test("already migrated v10 workspace receives the v11 snapshot audit", () => {
  const legacy=structuredClone(createSeedState()) as unknown as Record<string,unknown>;
  legacy.schemaVersion=10;
  const snapshots=legacy.configurationSnapshots as Array<Record<string,unknown>>;
  for(const snapshot of snapshots) delete snapshot.patchReferences;
  const ledger=legacy.patchLedger as {migrationReviewItems:Array<{id:string}>};
  ledger.migrationReviewItems=ledger.migrationReviewItems.filter((entry)=>!entry.id.startsWith("patch-snapshot-migration:"));
  const migrated=migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion,CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.ok(migrated.patchLedger.migrationReviewItems.some((entry)=>entry.reason==="LEGACY_SNAPSHOT_PATCH_REFERENCES_UNAVAILABLE"));
});

test("只有 ACTIVE revision 进入运行时视图，APPROVED 仍等待显式启用", () => {
  const approved=makeRevision({patchId:"patch:approved",state:"APPROVED"});
  const active=makeRevision({patchId:"patch:active",state:"ACTIVE"});
  const view=projectionPatchViewFromLedger({...emptyPatchLedger(),revisions:[approved,active]});
  assert.deepEqual(view.map((entry)=>entry.id),["patch:active"]);
});

test("v11 只把 legacy approved 迁为 ACTIVE，不误激活原生审核态", () => {
  const legacy=structuredClone(createSeedState());
  legacy.schemaVersion=11;
  legacy.patchLedger.revisions=[
    makeRevision({patchId:"patch:legacy",state:"APPROVED",rawPayload:{status:"approved"}}),
    makeRevision({patchId:"patch:native",state:"APPROVED",rawPayload:{source:"native"}}),
  ];
  const migrated=migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion,CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(migrated.patchLedger.revisions.find((entry)=>entry.patchId==="patch:legacy")?.state,"ACTIVE");
  assert.equal(migrated.patchLedger.revisions.find((entry)=>entry.patchId==="patch:native")?.state,"APPROVED");
});
test("PatchLedger v1 顺序迁移到 v5，保留未知字段并补齐新增集合", () => {
  const legacy={...emptyPatchLedger(),schemaVersion:1,unknownAuditField:{kept:true}} as unknown as Parameters<typeof migratePatchLedger>[0];
  delete (legacy as unknown as {ruleSourceChangeDrafts?:unknown}).ruleSourceChangeDrafts;
  const migrated=migratePatchLedger(legacy);
  assert.equal(migrated.schemaVersion,5);
  assert.deepEqual(migrated.ruleSourceChangeDrafts,[]);
  assert.deepEqual(migrated.absorptionAssessments,[]);
  assert.deepEqual(migrated.mirrorPullAudits,[]);
  assert.deepEqual((migrated as unknown as {unknownAuditField:unknown}).unknownAuditField,{kept:true});
  assert.deepEqual(migratePatchLedger(migrated),migrated);
});

test("APPROVED revision 不可提前重放，只有 ACTIVE 才生效", () => {
  assert.throws(()=>replayPatchRevision({power:2},makeRevision({state:"APPROVED"})),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_NOT_REPLAYABLE");
  assert.equal(replayPatchRevision({power:2},makeRevision({state:"ACTIVE"})).value.power,18);
});

test("个体 Patch 先确定性汇总，再经独立权限人工生成共享规则草稿", () => {
  const first=makeRevision({patchId:"patch:pattern:1",subjectEntityId:"model:1",operations:[{operationId:"op:1",operationIndex:0,parameterKey:"power",operation:"add",operand:2,before:2,after:4}]});
  const second=makeRevision({patchId:"patch:pattern:2",subjectEntityId:"model:2",operations:[{operationId:"op:2",operationIndex:0,parameterKey:"power",operation:"add",operand:3,before:3,after:6}]});
  const ledger={...emptyPatchLedger(),revisions:[first,second]};
  const patterns=analyzePatchPatterns({ledger,contexts:[
    {subjectEntityId:"model:1",methodId:"method:lure",typeId:"type:rod",functionId:"function:cast",weightBandId:"band:medium"},
    {subjectEntityId:"model:2",methodId:"method:lure",typeId:"type:rod",functionId:"function:cast",weightBandId:"band:medium"},
  ]});
  assert.equal(patterns.length,1);
  assert.equal(patterns[0].frequency,2);
  assert.equal(patterns[0].direction,"increase");
  assert.throws(()=>createRuleSourceChangeDraft({ledger,pattern:patterns[0],rationale:"重复出现",createdBy:"reviewer",createdAt:now,capabilities:[]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_PERMISSION_DENIED");
  const before=structuredClone(ledger.revisions);
  const created=createRuleSourceChangeDraft({ledger,pattern:patterns[0],rationale:"重复出现，需预览跨对象影响",createdBy:"reviewer",createdAt:now,capabilities:["rules.proposal.create"]});
  assert.equal(created.draft.status,"DRAFT");
  assert.deepEqual(created.ledger.revisions,before);
  assert.equal(created.ledger.ruleSourceChangeDrafts.length,1);
  const retry=createRuleSourceChangeDraft({ledger:created.ledger,pattern:patterns[0],rationale:"重复出现，需预览跨对象影响",createdBy:"reviewer",createdAt:now,capabilities:["rules.proposal.create"]});
  assert.equal(retry.idempotent,true);
  assert.equal(retry.ledger.ruleSourceChangeDrafts.length,1);
});
test("Rebase 创建新 revision 并保留已冻结旧 revision", () => {
  const source=makeRevision({state:"REBASE_REQUIRED",snapshotRefs:["snapshot:frozen"]});
  const ledger={...emptyPatchLedger(),revisions:[source]};
  const result=rebasePatchRevision({ledger,patchId:source.patchId,sourcePatchRevision:1,newBaseRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,newBaseValues:{power:5},actor:"reviewer",rebasedAt:"2026-07-22T03:00:00.000Z",capabilities:["patch.rebase"]});
  assert.equal(result.revision.patchRevision,2);
  assert.equal(result.revision.state,"PENDING_REVIEW");
  assert.equal(result.revision.baseRuleSetVersion,"ruleset:2");
  assert.deepEqual(result.revision.operations.map((operation)=>[operation.before,operation.after]),[[5,4],[4,6],[6,18]]);
  assert.deepEqual(result.ledger.revisions[0],source);
  assert.deepEqual(result.ledger.revisions[0].snapshotRefs,["snapshot:frozen"]);
  const retry=rebasePatchRevision({ledger:result.ledger,patchId:source.patchId,sourcePatchRevision:1,newBaseRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,newBaseValues:{power:5},actor:"reviewer",rebasedAt:"2026-07-22T03:00:00.000Z",capabilities:["patch.rebase"]});
  assert.equal(retry.idempotent,true);
  assert.equal(retry.ledger.revisions.length,2);
});

test("Rebase 权限、过期源 revision 与非数值新基线明确阻断", () => {
  const source=makeRevision({state:"REBASE_REQUIRED",operations:[{operationId:"op:add",operationIndex:0,parameterKey:"power",operation:"add",operand:2,before:4,after:6}]});
  const ledger={...emptyPatchLedger(),revisions:[source]};
  const base={ledger,patchId:source.patchId,sourcePatchRevision:1,newBaseRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,newBaseValues:{power:5},actor:"reviewer",rebasedAt:now};
  assert.throws(()=>rebasePatchRevision({...base,capabilities:[]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_PERMISSION_DENIED");
  assert.throws(()=>rebasePatchRevision({...base,newBaseValues:{power:"unknown"},capabilities:["patch.rebase"]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_NUMERIC_REQUIRED");
  const withNewer={...ledger,revisions:[source,makeRevision({patchRevision:2,state:"PENDING_REVIEW"}),makeRevision({patchRevision:3,state:"PENDING_REVIEW"})]};
  assert.throws(()=>rebasePatchRevision({...base,ledger:withNewer,capabilities:["patch.rebase"]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_REBASE_SOURCE_STALE");
});

test("新 RuleSet 完全覆盖 Patch 时创建 ABSORBED 新 revision，旧 revision 与 Snapshot 引用不变", () => {
  const source=makeRevision({snapshotRefs:["snapshot:frozen"]});
  const ledger={...emptyPatchLedger(),revisions:[source],ruleSourceChangeDrafts:[{
    id:"proposal:1",patternId:"pattern:1",sourcePatchRevisionRefs:[{patchId:source.patchId,patchRevision:1}],targetLayerType:"model" as const,
    parameterKey:"power",proposedOperation:"set" as const,impactSubjectEntityIds:[source.subjectEntityId],rationale:"共享规则覆盖",status:"SUBMITTED" as const,
    createdBy:"reviewer",createdAt:now,inputHash:"proposal-hash:1",
  }]};
  const before=structuredClone(source);
  const evidence=source.operations.map((operation)=>({operationId:operation.operationId,outcome:"FULLY_COVERED" as const,oldPatchedValue:operation.after,newRuleValue:operation.after,newRulePlusPatchValue:operation.after,traceHash:"trace:"+operation.operationId}));
  const result=assessPatchAbsorption({ledger,patchId:source.patchId,sourcePatchRevision:1,ruleProposalId:"proposal:1",publishedRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,operationEvidence:evidence,assessedBy:"reviewer",assessedAt:"2026-07-22T04:00:00.000Z",capabilities:["patch.absorption.review"]});
  assert.equal(result.revision.patchRevision,2);
  assert.equal(result.revision.state,"ABSORBED");
  assert.deepEqual(result.ledger.revisions[0],before);
  assert.deepEqual(result.ledger.revisions[0].snapshotRefs,["snapshot:frozen"]);
  assert.equal(result.ledger.absorptionAssessments.length,1);
  const retry=assessPatchAbsorption({ledger:result.ledger,patchId:source.patchId,sourcePatchRevision:1,ruleProposalId:"proposal:1",publishedRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,operationEvidence:evidence,assessedBy:"another",assessedAt:"2026-07-22T05:00:00.000Z",capabilities:["patch.absorption.review"]});
  assert.equal(retry.idempotent,true);
  assert.equal(retry.ledger.revisions.length,2);
});

test("部分覆盖只在新 revision 保留显式残余操作；冲突证据进入 REBASE_REQUIRED", () => {
  const source=makeRevision();
  const proposal={id:"proposal:partial",patternId:"pattern:partial",sourcePatchRevisionRefs:[{patchId:source.patchId,patchRevision:1}],targetLayerType:"model" as const,parameterKey:"power",proposedOperation:"set" as const,impactSubjectEntityIds:[source.subjectEntityId],rationale:"部分覆盖",status:"SUBMITTED" as const,createdBy:"reviewer",createdAt:now,inputHash:"proposal-hash:partial"};
  const ledger={...emptyPatchLedger(),revisions:[source],ruleSourceChangeDrafts:[proposal]};
  const partialEvidence=source.operations.map((operation,index)=>index===0
    ? {operationId:operation.operationId,outcome:"FULLY_COVERED" as const,oldPatchedValue:operation.after,newRuleValue:operation.after,newRulePlusPatchValue:operation.after,traceHash:"trace:full"}
    : {operationId:operation.operationId,outcome:"NOT_COVERED" as const,oldPatchedValue:operation.after,newRuleValue:operation.before,newRulePlusPatchValue:operation.after,traceHash:"trace:"+operation.operationId,residualOperation:{operation:operation.operation,operand:operation.operand,before:operation.before,after:operation.after}});
  const partial=assessPatchAbsorption({ledger,patchId:source.patchId,sourcePatchRevision:1,ruleProposalId:proposal.id,publishedRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,operationEvidence:partialEvidence,assessedBy:"reviewer",assessedAt:"2026-07-22T04:00:00.000Z",capabilities:["patch.absorption.review"]});
  assert.equal(partial.revision.state,"PARTIALLY_ABSORBED");
  assert.equal(partial.revision.operations.length,2);
  assert.equal(partial.revision.operations.some((operation)=>operation.operationId==="op:set"),false);

  const rebaseSource=makeRevision({patchId:"patch:rod:rebase",operations:[{operationId:"op:rebase",operationIndex:0,parameterKey:"power",operation:"set",operand:4,before:2,after:4}]});
  const rebaseProposal={...proposal,id:"proposal:rebase",sourcePatchRevisionRefs:[{patchId:rebaseSource.patchId,patchRevision:1}]};
  const rebaseLedger={...emptyPatchLedger(),revisions:[rebaseSource],ruleSourceChangeDrafts:[rebaseProposal]};
  const rebase=assessPatchAbsorption({ledger:rebaseLedger,patchId:rebaseSource.patchId,sourcePatchRevision:1,ruleProposalId:rebaseProposal.id,publishedRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,operationEvidence:[{operationId:"op:rebase",outcome:"REBASE_REQUIRED",oldPatchedValue:4,newRuleValue:3,newRulePlusPatchValue:4,traceHash:"trace:conflict"}],assessedBy:"reviewer",assessedAt:"2026-07-22T04:00:00.000Z",capabilities:["patch.absorption.review"]});
  assert.equal(rebase.revision.state,"REBASE_REQUIRED");
});

test("Patch 吸收要求独立权限、完整 Trace、匹配规则提案和显式残余操作", () => {
  const source=makeRevision({operations:[{operationId:"op:one",operationIndex:0,parameterKey:"power",operation:"add",operand:2,before:2,after:4}]});
  const proposal={id:"proposal:guard",patternId:"pattern:guard",sourcePatchRevisionRefs:[{patchId:source.patchId,patchRevision:1}],targetLayerType:"model" as const,parameterKey:"power",proposedOperation:"add" as const,impactSubjectEntityIds:[source.subjectEntityId],rationale:"guard",status:"SUBMITTED" as const,createdBy:"reviewer",createdAt:now,inputHash:"proposal-hash:guard"};
  const ledger={...emptyPatchLedger(),revisions:[source],ruleSourceChangeDrafts:[proposal]};
  const base={ledger,patchId:source.patchId,sourcePatchRevision:1,ruleProposalId:proposal.id,publishedRuleSetVersion:"ruleset:2",newBaseObjectRevision:4,assessedBy:"reviewer",assessedAt:now};
  assert.throws(()=>assessPatchAbsorption({...base,operationEvidence:[],capabilities:["patch.absorption.review"]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_ABSORPTION_EVIDENCE_INCOMPLETE");
  assert.throws(()=>assessPatchAbsorption({...base,operationEvidence:[{operationId:"op:one",outcome:"NOT_COVERED",oldPatchedValue:4,newRuleValue:2,newRulePlusPatchValue:4,traceHash:"trace"}],capabilities:["patch.absorption.review"]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_ABSORPTION_RESIDUAL_REQUIRED");
  assert.throws(()=>assessPatchAbsorption({...base,operationEvidence:[{operationId:"op:one",outcome:"FULLY_COVERED",oldPatchedValue:4,newRuleValue:4,newRulePlusPatchValue:4,traceHash:"trace"}],capabilities:[]}),(error:unknown)=>error instanceof PatchLedgerError&&error.code==="PATCH_PERMISSION_DENIED");
});
test("Workspace 已是 v14 时仍独立迁移 PatchLedger v2 到 v5", () => {
  const state=createSeedState();
  const legacyLedger={...state.patchLedger,schemaVersion:2} as typeof state.patchLedger;
  delete (legacyLedger as unknown as {absorptionAssessments?:unknown}).absorptionAssessments;
  const migrated=migrateWorkspaceState({...state,patchLedger:legacyLedger});
  assert.equal(migrated.schemaVersion,CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(migrated.patchLedger.schemaVersion,5);
  assert.deepEqual(migrated.patchLedger.absorptionAssessments,[]);
  assert.deepEqual(migrateWorkspaceState(migrated),migrated);
});
