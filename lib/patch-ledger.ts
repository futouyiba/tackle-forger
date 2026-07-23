import { deterministicHash } from "./rule-kernel";
import { assertPatchReviewCoverage, assertPatchRevisionDeterministicallyReplayable, assertPublishedPatchOffsetPolicy, invalidatePatchReviewBatch, PatchOffsetPolicyError } from "./patch-offset-policy";
import type { PatchAbsorptionAssessment, PatchAbsorptionOperationEvidence, PatchLedger, PatchMirrorOperationResult, PatchMirrorPayloadRow, PatchMirrorPullAudit, PatchMirrorRemoteRow, PatchMirrorSyncCommand, PatchMirrorValidationIssue, PatchOffsetPolicyVersion, PatchOperationRecord, PatchPatternSummary, PatchReviewBatch, PatchReviewSubjectRef, PatchRevisionRecord, PatchSnapshotReference, PatchValidationWaiver, ProjectionPatchRuleSource, RuleSourceChangeDraft, WorkspacePolicyRecord } from "./types";

export const CURRENT_PATCH_LEDGER_SCHEMA_VERSION = 5;
export type PatchLedgerCapability = "patch.create" | "patch.review" | "patch.mirror.write" | "patch.mirror.pull" | "patch.rebase" | "patch.absorption.review" | "rules.proposal.create";
export class PatchLedgerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type RawPatchOperation = Record<string, unknown>;
const CANONICAL_PATCH_OPERATIONS = new Set(["set", "add", "multiply", "clear"]);

function own(record: RawPatchOperation, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function rawOperationName(operation: RawPatchOperation): unknown {
  return operation.operation ?? operation.op;
}

function normalizeLegacyOperation(input: {
  raw: RawPatchOperation;
  operationId: string;
  operationIndex: number;
  baseRuleSetVersion: string;
  baseObjectRevision: number;
}): Omit<PatchOperationRecord, "patchId" | "patchRevision"> {
  const name = rawOperationName(input.raw);
  const parameterKey = input.raw.parameterKey ?? input.raw.path;
  if (typeof parameterKey !== "string" || !parameterKey.trim()) {
    throw new PatchLedgerError("PATCH_PARAMETER_KEY_REQUIRED", "Patch operation parameterKey is required");
  }
  const operand = own(input.raw, "operand") ? input.raw.operand
    : own(input.raw, "value") ? input.raw.value
    : null;
  const before = input.raw.before;
  const after = input.raw.after;
  if (name === "remove" || name === "clear") {
    return {
      operationId: input.operationId,
      operationIndex: input.operationIndex,
      parameterKey,
      operation: "clear",
      operand: null,
      before,
      after,
      ...(name === "remove" || operand !== null
        ? { rawIntent: structuredClone(input.raw) }
        : {}),
    };
  }
  if (name === "min" || name === "max") {
    if (
      !input.baseRuleSetVersion.trim()
      || !Number.isSafeInteger(input.baseObjectRevision)
      || input.baseObjectRevision < 1
      || typeof before !== "number"
      || typeof operand !== "number"
      || typeof after !== "number"
      || !Number.isFinite(before)
      || !Number.isFinite(operand)
      || !Number.isFinite(after)
    ) {
      throw new PatchLedgerError(
        "LEGACY_PATCH_MIN_MAX_REVIEW_REQUIRED",
        "旧 min/max 缺少可验证的冻结基底、before 或 after",
      );
    }
    const expected = name === "min" ? Math.min(before, operand) : Math.max(before, operand);
    if (!Object.is(expected, after)) {
      throw new PatchLedgerError(
        "LEGACY_PATCH_FROZEN_RESULT_MISMATCH",
        "旧 min/max 的 after 与冻结基底求值结果不一致",
      );
    }
    return {
      operationId: input.operationId,
      operationIndex: input.operationIndex,
      parameterKey,
      operation: "set",
      operand: after,
      before,
      after,
      rawIntent: structuredClone(input.raw),
    };
  }
  if (!CANONICAL_PATCH_OPERATIONS.has(String(name))) {
    throw new PatchLedgerError("PATCH_OPERATION_UNSUPPORTED", "Patch operation must be set/add/multiply/clear");
  }
  return {
    operationId: input.operationId,
    operationIndex: input.operationIndex,
    parameterKey,
    operation: name as "set" | "add" | "multiply",
    operand,
    before,
    after,
  };
}

function assertCanonicalOperation(operation: PatchOperationRecord | Omit<PatchOperationRecord, "patchId" | "patchRevision">): void {
  if (!CANONICAL_PATCH_OPERATIONS.has(String(operation.operation))) {
    throw new PatchLedgerError("PATCH_OPERATION_UNSUPPORTED", "New Patch records only accept set/add/multiply/clear");
  }
  if (!operation.parameterKey.trim()) {
    throw new PatchLedgerError("PATCH_PARAMETER_KEY_REQUIRED", "Patch operation parameterKey is required");
  }
  if (operation.operation === "clear" && operation.operand !== null) {
    throw new PatchLedgerError("PATCH_CLEAR_OPERAND_INVALID", "clear operand must be null");
  }
  if (
    (operation.operation === "add" || operation.operation === "multiply")
    && (typeof operation.operand !== "number" || !Number.isFinite(operation.operand))
  ) {
    throw new PatchLedgerError("PATCH_NUMERIC_REQUIRED", "add/multiply require a finite numeric operand");
  }
}

function mirrorPayloadForRevision(revision: PatchRevisionRecord): PatchMirrorPayloadRow[] {
  return sortedOperations(revision.operations).map((operation) => {
    assertCanonicalOperation(operation);
    return {
      patchId: revision.patchId,
      patchRevision: revision.patchRevision,
      operationId: operation.operationId,
      operationIndex: operation.operationIndex,
      scopeType: revision.scopeType,
      layerType: revision.layerType,
      subjectEntityId: revision.subjectEntityId,
      baseRuleSetVersion: revision.baseRuleSetVersion,
      baseObjectRevision: revision.baseObjectRevision,
      parameterKey: operation.parameterKey,
      operation: operation.operation,
      operand: operation.operation === "clear" ? null : structuredClone(operation.operand),
      before: structuredClone(operation.before),
      after: structuredClone(operation.after),
      snapshotRefs: structuredClone(revision.snapshotRefs),
    };
  });
}
export function emptyPatchLedger(): PatchLedger {
  return { schemaVersion: CURRENT_PATCH_LEDGER_SCHEMA_VERSION, revisions: [], mirrorCommands: [], ruleSourceChangeDrafts: [], absorptionAssessments: [], mirrorPullAudits: [], migrationReviewItems: [] };
}
function migrationSemanticFingerprint(revisions: PatchRevisionRecord[]): string {
  return deterministicHash(revisions.map((revision)=>({
    patchId:revision.patchId,patchRevision:revision.patchRevision,
    orderedOperations:[...revision.operations].sort((a,b)=>a.operationIndex-b.operationIndex||a.operationId.localeCompare(b.operationId)).map((operation)=>{
      try {
        const normalized = normalizeLegacyOperation({
          raw: operation as unknown as RawPatchOperation,
          operationId: operation.operationId,
          operationIndex: operation.operationIndex,
          baseRuleSetVersion: revision.baseRuleSetVersion,
          baseObjectRevision: revision.baseObjectRevision,
        });
        return {
          operationId:normalized.operationId,operationIndex:normalized.operationIndex,parameterKey:normalized.parameterKey,operation:normalized.operation,
          operand:normalized.operand,before:normalized.before,after:normalized.after,
        };
      } catch {
        return {
          operationId:operation.operationId,operationIndex:operation.operationIndex,parameterKey:operation.parameterKey,operation:operation.operation,
          operand:operation.operand,before:operation.before,after:operation.after,
        };
      }
    }),
  })).sort((a,b)=>a.patchId.localeCompare(b.patchId)||a.patchRevision-b.patchRevision));
}
export function verifyPatchLedgerMigrationSemantics(before:PatchRevisionRecord[], after:PatchRevisionRecord[]):{valid:boolean;beforeHash:string;afterHash:string}{
  const beforeHash=migrationSemanticFingerprint(before), afterHash=migrationSemanticFingerprint(after);
  return {valid:before.length===after.length&&beforeHash===afterHash,beforeHash,afterHash};
}
export function migratePatchLedger(input: PatchLedger | Record<string, unknown>): PatchLedger {
  const source = structuredClone(input) as PatchLedger & Record<string, unknown>;
  const version = typeof source.schemaVersion === "number" ? source.schemaVersion : 1;
  if (version > CURRENT_PATCH_LEDGER_SCHEMA_VERSION || version < 1) {
    throw new PatchLedgerError("PATCH_LEDGER_SCHEMA_UNSUPPORTED", "Unsupported PatchLedger schema version");
  }
  const beforeRevisions=Array.isArray(source.revisions)?structuredClone(source.revisions):[];
  let migrated = source;
  if (version === 1) migrated = { ...migrated, schemaVersion: 2, ruleSourceChangeDrafts: [] } as PatchLedger & Record<string, unknown>;
  if (migrated.schemaVersion === 2) migrated = { ...migrated, schemaVersion: 3, absorptionAssessments: [] } as PatchLedger & Record<string, unknown>;
  if (migrated.schemaVersion === 3) migrated = { ...migrated, schemaVersion: 4, mirrorPullAudits: [] } as PatchLedger & Record<string, unknown>;
  if (migrated.schemaVersion === 4) {
    const migrationReviewItems = Array.isArray(migrated.migrationReviewItems)
      ? structuredClone(migrated.migrationReviewItems)
      : [];
    const revisions = (Array.isArray(migrated.revisions) ? migrated.revisions : []).map((revision) => {
      const rawRevision = revision as PatchRevisionRecord;
      const requiresNormalization = rawRevision.operations.some((operation) => {
        if (!CANONICAL_PATCH_OPERATIONS.has(String((operation as unknown as RawPatchOperation).operation))) {
          return true;
        }
        try {
          assertCanonicalOperation(operation);
          return false;
        } catch {
          return true;
        }
      });
      if (!requiresNormalization) return rawRevision;
      const reviewId = `patch-operation-migration:${rawRevision.patchId}@${rawRevision.patchRevision}`;
      if (rawRevision.snapshotRefs.length) {
        if (!migrationReviewItems.some((item) => item.id === reviewId)) {
          migrationReviewItems.push({
            id: reviewId,
            patchId: rawRevision.patchId,
            patchRevision: rawRevision.patchRevision,
            reason: "LEGACY_SNAPSHOT_PATCH_OPERATION_FROZEN",
            preservedPayload: structuredClone(rawRevision),
          });
        }
        return rawRevision;
      }
      try {
        const operations = rawRevision.operations.map((operation) => ({
          ...normalizeLegacyOperation({
            raw: operation as unknown as RawPatchOperation,
            operationId: operation.operationId,
            operationIndex: operation.operationIndex,
            baseRuleSetVersion: rawRevision.baseRuleSetVersion,
            baseObjectRevision: rawRevision.baseObjectRevision,
          }),
          patchId: rawRevision.patchId,
          patchRevision: rawRevision.patchRevision,
        }));
        for (const operation of operations) assertCanonicalOperation(operation);
        const normalized = { ...rawRevision, operations };
        return { ...normalized, revisionHash: patchRevisionHash(normalized) };
      } catch (error) {
        if (!migrationReviewItems.some((item) => item.id === reviewId)) {
          migrationReviewItems.push({
            id: reviewId,
            patchId: rawRevision.patchId,
            patchRevision: rawRevision.patchRevision,
            reason: error instanceof PatchLedgerError ? error.code : "LEGACY_PATCH_REQUIRES_REVIEW",
            preservedPayload: structuredClone(rawRevision),
          });
        }
        return rawRevision;
      }
    });
    const mirrorCommands = (Array.isArray(migrated.mirrorCommands) ? migrated.mirrorCommands : []).map((command) => {
      const legacyCommand = command as PatchMirrorSyncCommand & Record<string, unknown>;
      if (typeof legacyCommand.payloadHash === "string" && Array.isArray(legacyCommand.payload)) return legacyCommand;
      const revision = revisions.find((entry) =>
        entry.patchId === legacyCommand.patchId && entry.patchRevision === legacyCommand.patchRevision);
      try {
        if (!revision) throw new PatchLedgerError("PATCH_REVISION_NOT_FOUND", "Mirror command revision not found");
        const payload = mirrorPayloadForRevision(revision);
        return { ...legacyCommand, payload, payloadHash: deterministicHash(payload) };
      } catch (error) {
        const reviewId = `patch-mirror-command-migration:${legacyCommand.idempotencyKey}`;
        if (!migrationReviewItems.some((item) => item.id === reviewId)) {
          migrationReviewItems.push({
            id: reviewId,
            patchId: legacyCommand.patchId,
            patchRevision: legacyCommand.patchRevision,
            reason: error instanceof PatchLedgerError ? error.code : "LEGACY_PATCH_MIRROR_PAYLOAD_REVIEW_REQUIRED",
            preservedPayload: structuredClone(legacyCommand),
          });
        }
        return { ...legacyCommand, payload: [], payloadHash: deterministicHash([]) };
      }
    });
    migrated = { ...migrated, schemaVersion: 5, revisions, mirrorCommands, migrationReviewItems } as PatchLedger & Record<string, unknown>;
  }
  const result={
    ...migrated,
    revisions: Array.isArray(migrated.revisions) ? migrated.revisions : [],
    mirrorCommands: Array.isArray(migrated.mirrorCommands) ? migrated.mirrorCommands : [],
    ruleSourceChangeDrafts: Array.isArray(migrated.ruleSourceChangeDrafts) ? migrated.ruleSourceChangeDrafts : [],
    absorptionAssessments: Array.isArray(migrated.absorptionAssessments) ? migrated.absorptionAssessments : [],
    mirrorPullAudits: Array.isArray(migrated.mirrorPullAudits) ? migrated.mirrorPullAudits : [],
    migrationReviewItems: Array.isArray(migrated.migrationReviewItems) ? migrated.migrationReviewItems : [],
  } as PatchLedger;
  const verification=verifyPatchLedgerMigrationSemantics(beforeRevisions,result.revisions);
  if(!verification.valid&&!result.migrationReviewItems.some((item)=>item.id==="patch-ledger-migration:semantic")) result.migrationReviewItems.push({
    id:"patch-ledger-migration:semantic",patchId:"PATCH_LEDGER",patchRevision:version,reason:"PATCH_LEDGER_MIGRATION_SEMANTIC_MISMATCH",
    preservedPayload:{beforeHash:verification.beforeHash,afterHash:verification.afterHash,source:structuredClone(input)},
  });
  return result;
}
function requireCapability(capabilities: Iterable<string>, required: PatchLedgerCapability) {
  if (!new Set(capabilities).has(required)) throw new PatchLedgerError("PATCH_PERMISSION_DENIED", "Missing " + required);
}
function sortedOperations(operations: PatchOperationRecord[]) {
  return [...operations].sort((a, b) => a.operationIndex - b.operationIndex || a.operationId.localeCompare(b.operationId));
}
export function patchRevisionHash(record: Omit<PatchRevisionRecord, "revisionHash">): string {
  return deterministicHash({ ...record, operations: sortedOperations(record.operations) });
}
export function buildPatchRevision(input: Omit<PatchRevisionRecord, "revisionHash" | "operations"> & {
  operations: Array<Omit<PatchOperationRecord, "patchId" | "patchRevision"> | PatchOperationRecord>;
}): PatchRevisionRecord {
  if (!input.patchId.trim() || !input.subjectEntityId.trim()) throw new PatchLedgerError("PATCH_STABLE_ID_REQUIRED", "Stable IDs required");
  if (!Number.isSafeInteger(input.patchRevision) || input.patchRevision < 1) throw new PatchLedgerError("PATCH_REVISION_INVALID", "Invalid revision");
  if (!input.operations.length) throw new PatchLedgerError("PATCH_OPERATION_REQUIRED", "Operations required");
  const ids = new Set<string>(), indexes = new Set<number>();
  const setParameters = new Set<string>(), clearParameters = new Set<string>();
  const operations = input.operations.map((op) => {
    if (!op.operationId.trim() || ids.has(op.operationId)) throw new PatchLedgerError("PATCH_OPERATION_ID_CONFLICT", "Duplicate operation ID");
    if (!Number.isSafeInteger(op.operationIndex) || op.operationIndex < 0 || indexes.has(op.operationIndex)) throw new PatchLedgerError("PATCH_OPERATION_ORDER_CONFLICT", "Duplicate operation order");
    assertCanonicalOperation(op);
    if (op.operation === "set") {
      if (setParameters.has(op.parameterKey)) throw new PatchLedgerError("PATCH_SET_CONFLICT", "Multiple set operations target the same parameter");
      if (clearParameters.has(op.parameterKey)) throw new PatchLedgerError("PATCH_SET_CLEAR_CONFLICT", "set and clear compete in the same Patch revision");
      setParameters.add(op.parameterKey);
    }
    if (op.operation === "clear") {
      if (setParameters.has(op.parameterKey)) throw new PatchLedgerError("PATCH_SET_CLEAR_CONFLICT", "set and clear compete in the same Patch revision");
      clearParameters.add(op.parameterKey);
    }
    ids.add(op.operationId); indexes.add(op.operationIndex);
    return { ...op, patchId: input.patchId, patchRevision: input.patchRevision };
  }) as PatchOperationRecord[];
  const record = { ...input, operations: sortedOperations(operations) };
  return { ...record, revisionHash: patchRevisionHash(record) };
}
export function importLegacyPatchesToLedger(ledger: PatchLedger, patches: ProjectionPatchRuleSource[]): PatchLedger {
  const next = structuredClone(ledger);
  for (const patch of patches) {
    if (next.revisions.some((entry) => entry.patchId === patch.id)) continue;
    const rawPatch = patch as unknown as Record<string, unknown>;
    const rawOperations: RawPatchOperation[] = Array.isArray(rawPatch.operations) && rawPatch.operations.length
      ? rawPatch.operations as RawPatchOperation[]
      : Array.isArray(rawPatch.rules)
        ? (rawPatch.rules as RawPatchOperation[]).map((rule): RawPatchOperation => ({
            operation: rule.operation,
            parameterKey: rule.parameterKey,
            operand: rule.value,
            before: rule.before,
            after: rule.after,
            rawRule: structuredClone(rule),
          }))
        : [];
    if (!rawOperations.length) {
      next.migrationReviewItems.push({ id: "patch-import:" + patch.id, patchId: patch.id, patchRevision: 1, reason: "LEGACY_PATCH_OPERATION_MISSING", preservedPayload: structuredClone(patch) });
      continue;
    }
    try {
      const baseObjectRevision = Number.isSafeInteger(rawPatch.baseObjectRevision)
        ? Number(rawPatch.baseObjectRevision)
        : 1;
      next.revisions.push(buildPatchRevision({
        patchId: patch.id, patchRevision: 1, scopeType: patch.scope, layerType: patch.scope,
        subjectEntityId: patch.scopeId, subjectName: patch.scopeId,
        baseRuleSetVersion: patch.baseRuleSetVersion, baseObjectRevision,
        state: patch.status === "approved" ? "ACTIVE" : patch.status === "superseded" ? "SUPERSEDED" : "DRAFT",
        mirrorSyncState: "NOT_SYNCED", attentionStates: [], reason: patch.reason, evidence: [],
        createdBy: patch.author, createdAt: patch.createdAt ?? "1970-01-01T00:00:00.000Z",
        snapshotRefs: [], rawPayload: structuredClone(patch),
        operations: rawOperations.map((operation, operationIndex) => normalizeLegacyOperation({
          raw: operation,
          operationId: typeof operation.operationId === "string"
            ? operation.operationId
            : patch.id + ":op:" + String(operationIndex + 1),
          operationIndex: Number.isSafeInteger(operation.operationIndex)
            ? Number(operation.operationIndex)
            : operationIndex,
          baseRuleSetVersion: patch.baseRuleSetVersion,
          baseObjectRevision,
        })),
      }));
    } catch (error) {
      next.migrationReviewItems.push({
        id: "patch-import:" + patch.id,
        patchId: patch.id,
        patchRevision: 1,
        reason: error instanceof PatchLedgerError ? error.code : "LEGACY_PATCH_REQUIRES_REVIEW",
        preservedPayload: structuredClone(patch),
      });
    }
  }
  return next;
}
export function projectionPatchViewFromLedger(ledger: PatchLedger): ProjectionPatchRuleSource[] {
  const latest = new Map<string, PatchRevisionRecord>();
  for (const revision of ledger.revisions) {
    const previous = latest.get(revision.patchId);
    if (!previous || revision.patchRevision > previous.patchRevision) latest.set(revision.patchId, revision);
  }
  return [...latest.values()]
    .filter((revision) => revision.state === "ACTIVE" && !revision.attentionStates.includes("ORPHANED"))
    .sort((left, right) => left.patchId.localeCompare(right.patchId))
    .map((revision) => {
      const raw = revision.rawPayload as { baseProjectionId?: unknown } | undefined;
      return {
        id: revision.patchId,
        scope: revision.scopeType === "derivation" ? "model" : revision.scopeType,
        scopeId: revision.subjectEntityId,
        reason: revision.reason,
        author: revision.createdBy,
        createdAt: revision.createdAt,
        baseProjectionId: typeof raw?.baseProjectionId === "string" ? raw.baseProjectionId : revision.subjectEntityId,
        baseRuleSetVersion: revision.baseRuleSetVersion,
        status: "approved" as const,
        order: revision.operations[0]?.operationIndex ?? 0,
        rules: [],
        operations: sortedOperations(revision.operations).map((operation) => {
          assertCanonicalOperation(operation);
          return operation.operation === "clear"
            ? { op: "clear" as const, path: operation.parameterKey }
            : { op: operation.operation, path: operation.parameterKey, value: operation.operand as number };
        }),
      };
    });
}

export function appendPatchRevision(input: { ledger: PatchLedger; revision: PatchRevisionRecord; capabilities: Iterable<string> }) {
  requireCapability(input.capabilities, "patch.create");
  const revision = buildPatchRevision({ ...input.revision, operations: input.revision.operations });
  const existing = input.ledger.revisions.find((r) => r.patchId === revision.patchId && r.patchRevision === revision.patchRevision);
  if (existing) {
    if (existing.revisionHash !== revision.revisionHash) throw new PatchLedgerError("PATCH_REVISION_IMMUTABLE", "Revision cannot be rewritten");
    return { ledger: input.ledger, revision: existing, idempotent: true };
  }
  const latest = input.ledger.revisions.filter((r) => r.patchId === revision.patchId).sort((a,b) => b.patchRevision-a.patchRevision)[0];
  if (latest && revision.patchRevision !== latest.patchRevision + 1) throw new PatchLedgerError("PATCH_REVISION_SEQUENCE_CONFLICT", "Revision sequence conflict");
  return { ledger: { ...input.ledger, revisions: [...input.ledger.revisions, revision] }, revision, idempotent: false };
}
export function reviewPatchRevision(input:{ledger:PatchLedger;patchId:string;patchRevision:number;nextState:"APPROVED"|"ACTIVE"|"WITHDRAWN";reviewer:string;reviewedAt:string;capabilities:Iterable<string>;approvalEvidence?:{policy?:WorkspacePolicyRecord|PatchOffsetPolicyVersion;reviewBatch?:PatchReviewBatch;waivers?:PatchValidationWaiver[];subjectRef:PatchReviewSubjectRef;objectInputHash:string;patchSetHash:string}}):PatchLedger{
  requireCapability(input.capabilities,"patch.review");
  const target=input.ledger.revisions.find((r)=>r.patchId===input.patchId&&r.patchRevision===input.patchRevision);
  if(!target) throw new PatchLedgerError("PATCH_REVISION_NOT_FOUND","Revision not found");
  if(target.snapshotRefs.length) throw new PatchLedgerError("PATCH_REVISION_IMMUTABLE","Snapshot-referenced revision is immutable");
  if(input.nextState==="APPROVED"||input.nextState==="ACTIVE"){
    try{
      assertPublishedPatchOffsetPolicy(input.approvalEvidence?.policy);
      if(!input.approvalEvidence) throw new PatchOffsetPolicyError("PATCH_REVIEW_EVIDENCE_MISSING","批准 Patch 前必须完成整体人工复核。");
      const expectedScope=target.scopeType==="derivation"?"model":target.scopeType;
      if(input.approvalEvidence.subjectRef.scopeType!==expectedScope
        || input.approvalEvidence.subjectRef.entityId!==target.subjectEntityId
        || input.approvalEvidence.subjectRef.revision!==target.baseObjectRevision){
        throw new PatchOffsetPolicyError(
          "PATCH_REVIEW_EVIDENCE_STALE",
          "Patch 基底对象 revision 已变化，旧整体复核证据不能批准当前 revision。",
        );
      }
      assertPatchRevisionDeterministicallyReplayable(target);
      const evidence=assertPatchReviewCoverage({
        batch:input.approvalEvidence.reviewBatch,
        policyVersion:input.approvalEvidence.policy.version,
        subjectRef:input.approvalEvidence.subjectRef,
        objectInputHash:input.approvalEvidence.objectInputHash,
        patchSetHash:input.approvalEvidence.patchSetHash,
        patchReference:{patchId:target.patchId,patchRevision:target.patchRevision,orderedOperationIds:sortedOperations(target.operations).map((operation)=>operation.operationId)},
      });
      if(input.approvalEvidence.reviewBatch?.gate!=="REVIEW") throw new PatchOffsetPolicyError("PATCH_RANGE_EVALUATION_GATE_MISMATCH","Patch 批准必须使用 REVIEW 关口整体复核证据。");
      const uncovered=evidence.rangeResults.filter((result)=>!result.valid).filter((result)=>!result.issueFingerprint||!(input.approvalEvidence?.waivers??[]).some((waiver)=>
        waiver.issueFingerprint===result.issueFingerprint&&waiver.gate==="REVIEW"&&waiver.policyVersion===input.approvalEvidence?.policy?.version&&waiver.objectInputHash===evidence.objectInputHash&&waiver.patchSetHash===evidence.patchSetHash));
      if(uncovered.length) throw new PatchOffsetPolicyError("PATCH_FINAL_VALUE_OUT_OF_RANGE","REVIEW 关口仍有未获匹配 Waiver 的累计最终值越界。");
    }catch(error){
      if(error instanceof PatchOffsetPolicyError) throw new PatchLedgerError(error.code,error.message);
      throw error;
    }
  }
  const next=buildPatchRevision({...target,state:input.nextState,reviewedBy:input.reviewer,reviewedAt:input.reviewedAt,operations:target.operations});
  return {...input.ledger,revisions:input.ledger.revisions.map((r)=>r===target?next:r)};
}
export function reviewPatchBatch(input:{ledger:PatchLedger;reviewBatch:PatchReviewBatch;policy?:WorkspacePolicyRecord|PatchOffsetPolicyVersion;waivers?:PatchValidationWaiver[];currentObjects:Array<{subjectRef:PatchReviewSubjectRef;objectInputHash:string;patchSetHash:string}>;nextState:"APPROVED"|"ACTIVE";reviewer:string;reviewedAt:string;capabilities:Iterable<string>}):PatchLedger{
  requireCapability(input.capabilities,"patch.review");
  if(input.reviewBatch.gate!=="REVIEW") throw new PatchLedgerError("PATCH_RANGE_EVALUATION_GATE_MISMATCH","批量 Patch 批准只接受 REVIEW 关口证据");
  const currentHashes=Object.fromEntries(input.currentObjects.map((current)=>[`${current.subjectRef.scopeType}:${current.subjectRef.entityId}@${current.subjectRef.revision}`,current.objectInputHash]));
  const reviewBatch=invalidatePatchReviewBatch({batch:input.reviewBatch,currentObjectInputHashes:currentHashes});
  let ledger=input.ledger;
  const objects=[...reviewBatch.objectEvidence].sort((left,right)=>left.subjectRef.entityId.localeCompare(right.subjectRef.entityId)||left.subjectRef.revision-right.subjectRef.revision);
  for(const evidence of objects){
    const current=input.currentObjects.find((entry)=>entry.subjectRef.scopeType===evidence.subjectRef.scopeType&&entry.subjectRef.entityId===evidence.subjectRef.entityId);
    if(!current||evidence.state!=="FRESH"||current.objectInputHash!==evidence.objectInputHash||current.patchSetHash!==evidence.patchSetHash){
      throw new PatchLedgerError("PATCH_REVIEW_EVIDENCE_STALE",`对象 ${evidence.subjectRef.entityId} 的当前 revision、RuleSet、输入或 PatchSet 已变化`);
    }
    for(const reference of evidence.patchReferences){
      const target=ledger.revisions.find((revision)=>revision.patchId===reference.patchId&&revision.patchRevision===reference.patchRevision);
      if(!target) throw new PatchLedgerError("PATCH_REVISION_NOT_FOUND",`批量复核引用的 ${reference.patchId}@${reference.patchRevision} 不存在`);
      if(target.state===input.nextState) continue;
      ledger=reviewPatchRevision({
        ledger,patchId:reference.patchId,patchRevision:reference.patchRevision,nextState:input.nextState,
        reviewer:input.reviewer,reviewedAt:input.reviewedAt,capabilities:input.capabilities,
        approvalEvidence:{policy:input.policy,reviewBatch,waivers:input.waivers,subjectRef:current.subjectRef,objectInputHash:current.objectInputHash,patchSetHash:current.patchSetHash},
      });
    }
  }
  return ledger;
}
export type PatchMirrorPullIssue = PatchMirrorValidationIssue;
const mirrorKey = (patchId:string, patchRevision:number, operationId:string) => patchId+"@"+patchRevision+"@"+operationId;
function mirrorIssue(code:PatchMirrorValidationIssue["code"], key:string, message:string, extra:Partial<PatchMirrorValidationIssue>={}):PatchMirrorValidationIssue {
  return {source:"patch",code,severity:"ERROR",key,message,...extra};
}
export function reconcilePatchMirrorPull(input:{ledger:PatchLedger;remoteDetailKeys?:string[];remoteRows?:PatchMirrorRemoteRow[];remoteRevision?:string;pulledAt?:string;capabilities:Iterable<string>}):{ledger:PatchLedger;issues:PatchMirrorPullIssue[];quarantinedRemoteRowIds:string[];refillDetailKeys:string[]}{
  requireCapability(input.capabilities,"patch.mirror.pull");
  const localByKey=new Map(input.ledger.revisions.flatMap((r)=>r.operations.map((o)=>[mirrorKey(r.patchId,r.patchRevision,o.operationId),{revision:r,operation:o}] as const)));
  const issues:PatchMirrorPullIssue[]=[];
  const quarantined=new Set<string>();
  const normalizedRemoteRows=(input.remoteRows??[]).flatMap((row) => {
    try {
      const normalized = normalizeLegacyOperation({
        raw: row as unknown as RawPatchOperation,
        operationId: row.operationId,
        operationIndex: row.operationIndex,
        baseRuleSetVersion: row.baseRuleSetVersion,
        baseObjectRevision: row.baseObjectRevision,
      });
      assertCanonicalOperation(normalized);
      return [{
        ...row,
        operation: normalized.operation,
        operand: normalized.operand,
        before: normalized.before,
        after: normalized.after,
      } as PatchMirrorRemoteRow];
    } catch (error) {
      const code = error instanceof PatchLedgerError
        ? error.code as PatchMirrorValidationIssue["code"]
        : "PATCH_OPERATION_UNSUPPORTED";
      issues.push(mirrorIssue(
        code,
        mirrorKey(row.patchId,row.patchRevision,row.operationId),
        "远端旧 Patch 操作无法无损规范化，已隔离等待复核",
        {patchId:row.patchId,patchRevision:row.patchRevision,operationId:row.operationId,remoteRowId:row.remoteRowId},
      ));
      quarantined.add(row.remoteRowId);
      return [];
    }
  });
  const rows=normalizedRemoteRows.length?normalizedRemoteRows:(input.remoteDetailKeys??[]).map((key,index)=>({remoteRowId:"legacy:"+index,key}));
  const counts=new Map<string,number>();
  for(const row of rows){const key="key" in row?row.key:mirrorKey(row.patchId,row.patchRevision,row.operationId);counts.set(key,(counts.get(key)??0)+1);}
  for(const key of localByKey.keys()) if(!counts.has(key)) issues.push(mirrorIssue("PATCH_MIRROR_ROW_MISSING",key,"飞书镜像缺少本地权威操作行"));
  for(const [key,count] of counts) {
    if(!localByKey.has(key)) issues.push(mirrorIssue("PATCH_MIRROR_UNKNOWN_KEY",key,"飞书镜像包含未知稳定ID"));
    if(count>1) issues.push(mirrorIssue("PATCH_MIRROR_DUPLICATE_KEY",key,"飞书镜像明细幂等键重复"));
  }
  for(const row of normalizedRemoteRows){
    const key=mirrorKey(row.patchId,row.patchRevision,row.operationId), local=localByKey.get(key);
    if(!local||counts.get(key)!==1){quarantined.add(row.remoteRowId);continue;}
    const controlled: Array<[string,unknown,unknown]>=[
      ["operationIndex",row.operationIndex,local.operation.operationIndex],["scopeType",row.scopeType,local.revision.scopeType],
      ["layerType",row.layerType,local.revision.layerType],["subjectEntityId",row.subjectEntityId,local.revision.subjectEntityId],
      ["baseRuleSetVersion",row.baseRuleSetVersion,local.revision.baseRuleSetVersion],["baseObjectRevision",row.baseObjectRevision,local.revision.baseObjectRevision],
      ["parameterKey",row.parameterKey,local.operation.parameterKey],["operation",row.operation,local.operation.operation],
      ["operand",row.operand,local.operation.operand],["before",row.before,local.operation.before],["after",row.after,local.operation.after],
      ["snapshotRefs",row.snapshotRefs,local.revision.snapshotRefs],
    ];
    for(const [field,remote,expected] of controlled) if(deterministicHash(remote)!==deterministicHash(expected)){
      issues.push(mirrorIssue("PATCH_MIRROR_AUDIT_FIELD_TAMPERED",key,"飞书受控审计字段与本地权威账本不一致",{patchId:row.patchId,patchRevision:row.patchRevision,operationId:row.operationId,remoteRowId:row.remoteRowId,field})); quarantined.add(row.remoteRowId);
    }
    for(const entry of row.collaborationEntries??[]) if(!entry.entryId.trim()||!entry.authorId.trim()||!entry.authoredAt.trim()||!entry.remoteRevision.trim()){
      issues.push(mirrorIssue("PATCH_MIRROR_COLLABORATION_INVALID",key,"协作记录必须保留作者、时间与revision",{remoteRowId:row.remoteRowId})); quarantined.add(row.remoteRowId);
    }
  }
  for(const revision of input.ledger.revisions){
    const keys=revision.operations.map((op)=>mirrorKey(revision.patchId,revision.patchRevision,op.operationId));
    const present=keys.filter((key)=>counts.get(key)===1).length;
    if(present>0&&present<keys.length) issues.push(mirrorIssue("PATCH_MIRROR_GROUP_INCOMPLETE",revision.patchId+"@"+revision.patchRevision,"飞书镜像中的Patch revision明细组不完整",{patchId:revision.patchId,patchRevision:revision.patchRevision}));
  }
  const refillDetailKeys=issues.filter((issue)=>issue.code==="PATCH_MIRROR_ROW_MISSING").map((issue)=>issue.key).sort();
  const audit:PatchMirrorPullAudit={pulledAt:input.pulledAt??new Date(0).toISOString(),remoteRevision:input.remoteRevision??"UNKNOWN",issues,quarantinedRemoteRowIds:[...quarantined].sort(),refillDetailKeys};
  return {ledger:{...input.ledger,mirrorPullAudits:[...input.ledger.mirrorPullAudits,audit]},issues,quarantinedRemoteRowIds:audit.quarantinedRemoteRowIds,refillDetailKeys};
}

export function updatePatchMirrorSuggestion(input:{ledger:PatchLedger;patchId:string;patchRevision:number;expectedRemoteRevision:string;actualRemoteRevision:string;value:boolean;now:string;capabilities:Iterable<string>}):PatchLedger{
  requireCapability(input.capabilities,"patch.mirror.write");
  const revision=input.ledger.revisions.find((r)=>r.patchId===input.patchId&&r.patchRevision===input.patchRevision);
  if(!revision) throw new PatchLedgerError("PATCH_REVISION_NOT_FOUND","Revision not found");
  if(input.expectedRemoteRevision!==input.actualRemoteRevision){
    const issue=mirrorIssue("PATCH_MIRROR_EXPECTED_REVISION_CONFLICT",input.patchId+"@"+input.patchRevision,"协作状态远端revision已变化，禁止覆盖",{patchId:input.patchId,patchRevision:input.patchRevision});
    const audit:PatchMirrorPullAudit={pulledAt:input.now,remoteRevision:input.actualRemoteRevision,issues:[issue],quarantinedRemoteRowIds:[],refillDetailKeys:[]};
    return {...input.ledger,revisions:input.ledger.revisions.map((r)=>r===revision?{...r,mirrorSyncState:"CONFLICT" as const}:r),mirrorPullAudits:[...input.ledger.mirrorPullAudits,audit]};
  }
  return {...input.ledger,revisions:input.ledger.revisions.map((r)=>r===revision?{...r,mirrorSyncState:"REMOTE_CHANGED" as const,rawPayload:{original:r.rawPayload,sharedRuleSuggestion:{value:input.value,remoteRevision:input.actualRemoteRevision}}}:r)};
}
export function resolvePatchRevision(input: { revision: PatchRevisionRecord; existingSubjectIds: Iterable<string>; currentRuleSetVersion: string; currentObjectRevision: number }): PatchRevisionRecord {
  if (!new Set(input.existingSubjectIds).has(input.revision.subjectEntityId)) return { ...input.revision, attentionStates: ["ORPHANED"] };
  if (input.revision.baseRuleSetVersion !== input.currentRuleSetVersion || input.revision.baseObjectRevision !== input.currentObjectRevision) return { ...input.revision, state: "REBASE_REQUIRED", attentionStates: [] };
  return { ...input.revision, attentionStates: [] };
}
export function replayPatchRevision(base: Record<string, unknown>, revision: PatchRevisionRecord) {
  if (revision.state !== "ACTIVE") throw new PatchLedgerError("PATCH_NOT_REPLAYABLE", "Only ACTIVE revisions are replayable");
  const inherited = structuredClone(base);
  const value = structuredClone(base), trace: Array<{operationId:string;before:unknown;after:unknown}> = [];
  for (const op of sortedOperations(revision.operations)) {
    assertCanonicalOperation(op);
    const before = value[op.parameterKey];
    if (op.operation === "set") value[op.parameterKey] = op.operand;
    else if (op.operation === "clear") {
      if (!Object.prototype.hasOwnProperty.call(inherited, op.parameterKey)) {
        throw new PatchLedgerError("PATCH_CLEAR_INHERITANCE_MISSING", "clear target no longer has an inherited value");
      }
      value[op.parameterKey] = structuredClone(inherited[op.parameterKey]);
    }
    else {
      if (typeof before !== "number" || typeof op.operand !== "number") throw new PatchLedgerError("PATCH_NUMERIC_REQUIRED", "Numeric operation required");
      value[op.parameterKey] = op.operation === "add" ? before + op.operand : before * op.operand;
    }
    trace.push({ operationId: op.operationId, before, after: value[op.parameterKey] });
  }
  return { value, trace };
}
export function orderedPatchReferences(revisions: PatchRevisionRecord[]): { references: PatchSnapshotReference[]; patchSetHash: string } {
  const layerOrder: Record<PatchRevisionRecord["layerType"], number> = {
    derivation: 0,
    series: 1,
    sku: 2,
    model: 3,
    final_review: 4,
    projection_pin: 5,
  };
  for (const revision of revisions) {
    for (const operation of revision.operations) {
      try {
        assertCanonicalOperation(operation);
      } catch {
        throw new PatchLedgerError(
          "PATCH_SNAPSHOT_OPERATION_NON_CANONICAL",
          "Snapshot references may only freeze set/add/multiply/clear Patch revisions",
        );
      }
    }
  }
  const references = [...revisions].sort((a,b)=>
    layerOrder[a.layerType]-layerOrder[b.layerType]
    || a.subjectEntityId.localeCompare(b.subjectEntityId)
    || a.patchId.localeCompare(b.patchId)
    || a.patchRevision-b.patchRevision).map((r)=>({
    patchId:r.patchId, patchRevision:r.patchRevision, orderedOperationIds:sortedOperations(r.operations).map((op)=>op.operationId),
  }));
  return { references, patchSetHash: deterministicHash(references) };
}
export function beginPatchMirrorSync(input: { ledger: PatchLedger; patchId:string; patchRevision:number; idempotencyKey:string; expectedRemoteRevision?:string; now:string; capabilities:Iterable<string> }) {
  requireCapability(input.capabilities, "patch.mirror.write");
  const revision=input.ledger.revisions.find((r)=>r.patchId===input.patchId&&r.patchRevision===input.patchRevision);
  if(!revision) throw new PatchLedgerError("PATCH_REVISION_NOT_FOUND","Revision not found");
  const payload = mirrorPayloadForRevision(revision);
  const payloadHash = deterministicHash(payload);
  const old = input.ledger.mirrorCommands.find((c)=>c.idempotencyKey===input.idempotencyKey);
  if (old) {
    if (old.patchId !== input.patchId || old.patchRevision !== input.patchRevision || old.payloadHash !== payloadHash) {
      throw new PatchLedgerError("PATCH_MIRROR_IDEMPOTENCY_CONFLICT", "Mirror idempotency key is already bound to a different canonical payload");
    }
    return { ledger:input.ledger, command:old, idempotent:true };
  }
  const command:PatchMirrorSyncCommand={idempotencyKey:input.idempotencyKey,patchId:input.patchId,patchRevision:input.patchRevision,payloadHash,payload,expectedRemoteRevision:input.expectedRemoteRevision,state:"PENDING",operationResults:revision.operations.map((op)=>({operationId:op.operationId,status:"PENDING"})),createdAt:input.now,updatedAt:input.now};
  return {ledger:{...input.ledger,revisions:input.ledger.revisions.map((r)=>r===revision?{...r,mirrorSyncState:"PENDING" as const}:r),mirrorCommands:[...input.ledger.mirrorCommands,command]},command,idempotent:false};
}
export function recordPatchMirrorResult(input:{ledger:PatchLedger;idempotencyKey:string;operationResults:PatchMirrorOperationResult[];readbackEvidence?:unknown;connectorAvailable:boolean;now:string}):PatchLedger{
  const command=input.ledger.mirrorCommands.find((c)=>c.idempotencyKey===input.idempotencyKey);
  if(!command) throw new PatchLedgerError("PATCH_MIRROR_COMMAND_NOT_FOUND","Command not found");
  const incoming=new Map(input.operationResults.map((r)=>[r.operationId,r]));
  const results=command.operationResults.map((r)=>incoming.get(r.operationId)??r);
  const synced=input.connectorAvailable&&results.length>0&&results.every((r)=>r.status==="VERIFIED");
  const failed=!input.connectorAvailable||results.some((r)=>r.status==="FAILED");
  const mirrorState: PatchRevisionRecord["mirrorSyncState"]=synced?"SYNCED":failed?"WRITE_FAILED":"WRITING";
  return {...input.ledger,revisions:input.ledger.revisions.map((r)=>r.patchId===command.patchId&&r.patchRevision===command.patchRevision?{...r,mirrorSyncState:mirrorState}:r),mirrorCommands:input.ledger.mirrorCommands.map((c)=>c===command?{...c,state:synced?"COMPLETED":failed?"FAILED":"READBACK_REQUIRED",operationResults:results,readbackEvidence:input.readbackEvidence,updatedAt:input.now}:c)};
}
export function verifyPatchSetHash(references: PatchSnapshotReference[], expectedHash:string){return deterministicHash(references)===expectedHash;}

export interface PatchAnalysisContext {
  subjectEntityId: string;
  methodId?: string;
  typeId?: string;
  functionId?: string;
  weightBandId?: string;
}

function operationDirection(operation: PatchOperationRecord): PatchPatternSummary["direction"] {
  if (operation.operation === "clear") return "clear";
  if (operation.operation === "set") return "replace";
  if (typeof operation.operand !== "number") return "mixed";
  if (operation.operation === "add") return operation.operand > 0 ? "increase" : operation.operand < 0 ? "decrease" : "mixed";
  return operation.operand > 1 ? "increase" : operation.operand >= 0 && operation.operand < 1 ? "decrease" : "mixed";
}

export function analyzePatchPatterns(input: { ledger: PatchLedger; contexts?: PatchAnalysisContext[] }): PatchPatternSummary[] {
  const contexts = new Map((input.contexts ?? []).map((context) => [context.subjectEntityId, context]));
  const groups = new Map<string, { layerType: PatchRevisionRecord["layerType"]; parameterKey: string; operation: PatchOperationRecord["operation"]; context: PatchAnalysisContext; refs: Map<string, {patchId:string;patchRevision:number}>; subjects: Set<string>; directions: Set<PatchPatternSummary["direction"]> }>();
  for (const revision of input.ledger.revisions) {
    if (!["ACTIVE", "PARTIALLY_ABSORBED"].includes(revision.state) || revision.attentionStates.includes("ORPHANED")) continue;
    const context = contexts.get(revision.subjectEntityId) ?? { subjectEntityId: revision.subjectEntityId };
    for (const operation of sortedOperations(revision.operations)) {
      const key = deterministicHash({ layerType: revision.layerType, operation: operation.operation, parameterKey: operation.parameterKey, methodId: context.methodId, typeId: context.typeId, functionId: context.functionId, weightBandId: context.weightBandId });
      const group = groups.get(key) ?? { layerType: revision.layerType, parameterKey: operation.parameterKey, operation: operation.operation, context, refs: new Map(), subjects: new Set(), directions: new Set() };
      group.refs.set(revision.patchId + "@" + revision.patchRevision, { patchId: revision.patchId, patchRevision: revision.patchRevision });
      group.subjects.add(revision.subjectEntityId);
      group.directions.add(operationDirection(operation));
      groups.set(key, group);
    }
  }
  return [...groups.entries()].map(([groupKey, group]) => {
    const patchRevisionRefs = [...group.refs.values()].sort((a,b)=>a.patchId.localeCompare(b.patchId)||a.patchRevision-b.patchRevision);
    const subjectEntityIds = [...group.subjects].sort();
    const direction = group.directions.size === 1 ? [...group.directions][0] : "mixed";
    const content = { groupKey, direction, patchRevisionRefs, subjectEntityIds };
    const analysisHash = deterministicHash(content);
    return { patternId: "patch-pattern:" + analysisHash, layerType: group.layerType, parameterKey: group.parameterKey, operation: group.operation, direction, methodId: group.context.methodId, typeId: group.context.typeId, functionId: group.context.functionId, weightBandId: group.context.weightBandId, patchRevisionRefs, subjectEntityIds, frequency: patchRevisionRefs.length, analysisHash };
  }).sort((a,b)=>b.frequency-a.frequency||a.patternId.localeCompare(b.patternId));
}

export function createRuleSourceChangeDraft(input: { ledger: PatchLedger; pattern: PatchPatternSummary; rationale: string; createdBy: string; createdAt: string; capabilities: Iterable<string> }): { ledger: PatchLedger; draft: RuleSourceChangeDraft; idempotent: boolean } {
  requireCapability(input.capabilities, "rules.proposal.create");
  if (!input.rationale.trim()) throw new PatchLedgerError("RULE_PROPOSAL_RATIONALE_REQUIRED", "Rationale required");
  const current = analyzePatchPatterns({ ledger: input.ledger }).find((pattern) => pattern.patternId === input.pattern.patternId);
  const pattern = current ?? input.pattern;
  const inputHash = deterministicHash({ patternId: pattern.patternId, analysisHash: pattern.analysisHash, rationale: input.rationale.trim() });
  const existing = input.ledger.ruleSourceChangeDrafts.find((draft) => draft.inputHash === inputHash);
  if (existing) return { ledger: input.ledger, draft: existing, idempotent: true };
  const draft: RuleSourceChangeDraft = { id: "rule-source-change:" + inputHash, patternId: pattern.patternId, sourcePatchRevisionRefs: structuredClone(pattern.patchRevisionRefs), targetLayerType: pattern.layerType, parameterKey: pattern.parameterKey, proposedOperation: pattern.operation, impactSubjectEntityIds: structuredClone(pattern.subjectEntityIds), rationale: input.rationale.trim(), status: "DRAFT", createdBy: input.createdBy, createdAt: input.createdAt, inputHash };
  return { ledger: { ...input.ledger, ruleSourceChangeDrafts: [...input.ledger.ruleSourceChangeDrafts, draft] }, draft, idempotent: false };
}
export function assessPatchAbsorption(input: {
  ledger: PatchLedger;
  patchId: string;
  sourcePatchRevision: number;
  ruleProposalId: string;
  publishedRuleSetVersion: string;
  newBaseObjectRevision: number;
  operationEvidence: PatchAbsorptionOperationEvidence[];
  assessedBy: string;
  assessedAt: string;
  capabilities: Iterable<string>;
}): { ledger: PatchLedger; assessment: PatchAbsorptionAssessment; revision: PatchRevisionRecord; idempotent: boolean } {
  requireCapability(input.capabilities, "patch.absorption.review");
  const source = input.ledger.revisions.find((revision) => revision.patchId === input.patchId && revision.patchRevision === input.sourcePatchRevision);
  if (!source) throw new PatchLedgerError("PATCH_REVISION_NOT_FOUND", "Revision not found");
  if (!["ACTIVE", "PARTIALLY_ABSORBED"].includes(source.state)) {
    throw new PatchLedgerError("PATCH_ABSORPTION_SOURCE_INVALID", "Only ACTIVE or PARTIALLY_ABSORBED revisions can be assessed");
  }
  if (!input.publishedRuleSetVersion.trim() || input.publishedRuleSetVersion === source.baseRuleSetVersion) {
    throw new PatchLedgerError("PATCH_ABSORPTION_RULESET_INVALID", "A different published RuleSetVersion is required");
  }
  if (!Number.isSafeInteger(input.newBaseObjectRevision) || input.newBaseObjectRevision < 1) {
    throw new PatchLedgerError("PATCH_ABSORPTION_BASE_INVALID", "New object revision is invalid");
  }
  const proposal = input.ledger.ruleSourceChangeDrafts.find((draft) => draft.id === input.ruleProposalId);
  if (!proposal || !proposal.sourcePatchRevisionRefs.some((ref) => ref.patchId === source.patchId && ref.patchRevision === source.patchRevision)) {
    throw new PatchLedgerError("PATCH_ABSORPTION_PROPOSAL_MISMATCH", "Rule proposal does not reference the source Patch revision");
  }
  const expectedIds = sortedOperations(source.operations).map((operation) => operation.operationId);
  const evidenceIds = input.operationEvidence.map((evidence) => evidence.operationId);
  if (new Set(evidenceIds).size !== evidenceIds.length || deterministicHash([...evidenceIds].sort()) !== deterministicHash([...expectedIds].sort())) {
    throw new PatchLedgerError("PATCH_ABSORPTION_EVIDENCE_INCOMPLETE", "Exactly one evidence record is required for every operation");
  }
  const evidenceById = new Map(input.operationEvidence.map((evidence) => [evidence.operationId, evidence]));
  const operationEvidence = expectedIds.map((operationId) => structuredClone(evidenceById.get(operationId)!));
  for (const evidence of operationEvidence) {
    if (!evidence.traceHash.trim()) throw new PatchLedgerError("PATCH_ABSORPTION_TRACE_REQUIRED", "Every operation requires deterministic recalculation Trace");
    if (["PARTIALLY_COVERED", "NOT_COVERED"].includes(evidence.outcome) && !evidence.residualOperation) {
      throw new PatchLedgerError("PATCH_ABSORPTION_RESIDUAL_REQUIRED", "Uncovered semantics require an explicit residual operation");
    }
  }
  const inputHash = deterministicHash({
    patchId: source.patchId,
    sourcePatchRevision: source.patchRevision,
    sourceRevisionHash: source.revisionHash,
    ruleProposalId: input.ruleProposalId,
    publishedRuleSetVersion: input.publishedRuleSetVersion,
    newBaseObjectRevision: input.newBaseObjectRevision,
    operationEvidence,
  });
  const existingAssessment = input.ledger.absorptionAssessments.find((assessment) => assessment.inputHash === inputHash);
  if (existingAssessment) {
    const revision = input.ledger.revisions.find((item) => item.patchId === existingAssessment.patchId && item.patchRevision === existingAssessment.resultPatchRevision);
    if (!revision) throw new PatchLedgerError("PATCH_ABSORPTION_RESULT_MISSING", "Assessment result revision is missing");
    return { ledger: input.ledger, assessment: existingAssessment, revision, idempotent: true };
  }
  const latest = input.ledger.revisions.filter((revision) => revision.patchId === source.patchId).sort((left, right) => right.patchRevision - left.patchRevision)[0];
  if (latest !== source) throw new PatchLedgerError("PATCH_ABSORPTION_SOURCE_STALE", "Only the latest Patch revision can be assessed");

  const outcomes = operationEvidence.map((evidence) => evidence.outcome);
  const resultState: PatchAbsorptionAssessment["resultState"] = outcomes.includes("REBASE_REQUIRED")
    ? "REBASE_REQUIRED"
    : outcomes.every((outcome) => outcome === "FULLY_COVERED")
      ? "ABSORBED"
      : outcomes.some((outcome) => outcome === "FULLY_COVERED" || outcome === "PARTIALLY_COVERED")
        ? "PARTIALLY_ABSORBED"
        : "ACTIVE";
  const nextPatchRevision = source.patchRevision + 1;
  const residualEvidence = operationEvidence.filter((evidence) => evidence.outcome !== "FULLY_COVERED" && evidence.outcome !== "REBASE_REQUIRED");
  const operations = resultState === "ACTIVE" || resultState === "PARTIALLY_ABSORBED"
    ? residualEvidence.map((evidence, operationIndex) => ({
      operationId: `${source.patchId}:op:${nextPatchRevision}:${operationIndex + 1}`,
      operationIndex,
      parameterKey: source.operations.find((operation) => operation.operationId === evidence.operationId)!.parameterKey,
      ...evidence.residualOperation!,
    }))
    : sortedOperations(source.operations).map((operation, operationIndex) => ({
      ...operation,
      operationId: `${source.patchId}:audit:${nextPatchRevision}:${operationIndex + 1}`,
      operationIndex,
    }));
  if (!operations.length) throw new PatchLedgerError("PATCH_ABSORPTION_OPERATION_REQUIRED", "Assessment result must retain auditable operations");

  const assessmentId = `patch-absorption:${inputHash}`;
  const revision = buildPatchRevision({
    ...source,
    patchRevision: nextPatchRevision,
    baseRuleSetVersion: input.publishedRuleSetVersion,
    baseObjectRevision: input.newBaseObjectRevision,
    state: resultState,
    mirrorSyncState: "NOT_SYNCED",
    attentionStates: [],
    reason: `${source.reason}\nRuleSet 吸收评估：${assessmentId}`,
    evidence: [...source.evidence, assessmentId, ...operationEvidence.map((item) => item.traceHash)],
    createdBy: input.assessedBy,
    createdAt: input.assessedAt,
    reviewedBy: input.assessedBy,
    reviewedAt: input.assessedAt,
    supersedesPatchId: source.patchId,
    ruleProposalId: input.ruleProposalId,
    snapshotRefs: [],
    rawPayload: { absorptionAssessmentId: assessmentId, sourceRevisionHash: source.revisionHash },
    operations,
  });
  const assessment: PatchAbsorptionAssessment = {
    assessmentId,
    patchId: source.patchId,
    sourcePatchRevision: source.patchRevision,
    resultPatchRevision: revision.patchRevision,
    ruleProposalId: input.ruleProposalId,
    publishedRuleSetVersion: input.publishedRuleSetVersion,
    resultState,
    operationEvidence,
    inputHash,
    assessedBy: input.assessedBy,
    assessedAt: input.assessedAt,
  };
  return {
    ledger: {
      ...input.ledger,
      revisions: [...input.ledger.revisions, revision],
      absorptionAssessments: [...input.ledger.absorptionAssessments, assessment],
    },
    assessment,
    revision,
    idempotent: false,
  };
}
export function rebasePatchRevision(input: {
  ledger: PatchLedger;
  patchId: string;
  sourcePatchRevision: number;
  newBaseRuleSetVersion: string;
  newBaseObjectRevision: number;
  newBaseValues: Record<string, unknown>;
  actor: string;
  rebasedAt: string;
  capabilities: Iterable<string>;
}): { ledger: PatchLedger; revision: PatchRevisionRecord; idempotent: boolean } {
  requireCapability(input.capabilities, "patch.rebase");
  const source = input.ledger.revisions.find((revision) => revision.patchId === input.patchId && revision.patchRevision === input.sourcePatchRevision);
  if (!source) throw new PatchLedgerError("PATCH_REVISION_NOT_FOUND", "Revision not found");
  const latest = input.ledger.revisions.filter((revision) => revision.patchId === input.patchId).sort((a,b)=>b.patchRevision-a.patchRevision)[0];
  if (latest !== source && latest?.patchRevision !== source.patchRevision + 1) throw new PatchLedgerError("PATCH_REBASE_SOURCE_STALE", "Only latest Patch revision can be rebased");
  if (!input.newBaseRuleSetVersion.trim() || !Number.isSafeInteger(input.newBaseObjectRevision) || input.newBaseObjectRevision < 1) {
    throw new PatchLedgerError("PATCH_REBASE_BASE_INVALID", "New baseline is invalid");
  }
  const inherited = structuredClone(input.newBaseValues);
  const values = structuredClone(input.newBaseValues);
  const operations = sortedOperations(source.operations).map((operation) => {
    assertCanonicalOperation(operation);
    const before = values[operation.parameterKey];
    let after: unknown;
    if (operation.operation === "set") after = operation.operand;
    else if (operation.operation === "clear") {
      if (!Object.prototype.hasOwnProperty.call(inherited, operation.parameterKey)) {
        throw new PatchLedgerError("PATCH_CLEAR_INHERITANCE_MISSING", "clear target no longer represents an inheritable value");
      }
      after = structuredClone(inherited[operation.parameterKey]);
    }
    else {
      if (typeof before !== "number" || typeof operation.operand !== "number") throw new PatchLedgerError("PATCH_NUMERIC_REQUIRED", "Numeric operation requires a numeric new baseline");
      after = operation.operation === "add" ? before + operation.operand : before * operation.operand;
    }
    values[operation.parameterKey] = after;
    return { ...operation, operationId: input.patchId + ":op:" + String(source.patchRevision + 1) + ":" + String(operation.operationIndex + 1), before, after };
  });
  const revision = buildPatchRevision({
    ...source,
    patchRevision: source.patchRevision + 1,
    baseRuleSetVersion: input.newBaseRuleSetVersion,
    baseObjectRevision: input.newBaseObjectRevision,
    state: "PENDING_REVIEW",
    mirrorSyncState: "NOT_SYNCED",
    attentionStates: [],
    createdBy: input.actor,
    createdAt: input.rebasedAt,
    reviewedBy: undefined,
    reviewedAt: undefined,
    supersedesPatchId: source.patchId,
    ruleProposalId: undefined,
    snapshotRefs: [],
    operations,
  });
  const existing = input.ledger.revisions.find((entry) => entry.patchId === revision.patchId && entry.patchRevision === revision.patchRevision);
  if (existing) {
    if (existing.revisionHash !== revision.revisionHash) throw new PatchLedgerError("PATCH_REVISION_IMMUTABLE", "Rebase retry conflicts with existing revision");
    return { ledger: input.ledger, revision: existing, idempotent: true };
  }
  return { ledger: { ...input.ledger, revisions: [...input.ledger.revisions, revision] }, revision, idempotent: false };
}
