import { deterministicHash } from "./rule-kernel";
import type {
  PartConstraint,
  PartConstraintFieldName,
  PartConstraintFieldTrace,
  PartConstraintItemPartId,
  PartConstraintSet,
  PartConstraintSetRef,
  PartConstraintSlot,
  PartConstraintSourceRevisionRef,
  PartConstraintReviewStatus,
} from "./types";

export const PART_CONSTRAINT_MIGRATOR_VERSION = "part-constraint-set/v1";
export const PART_CONSTRAINT_SOURCE_HASH_PROJECTION =
  "WITHOUT_PART_CONSTRAINT_SET_REF_V1" as const;

export const PART_CONSTRAINT_SLOTS: readonly PartConstraintSlot[] = [
  "rod",
  "reel",
  "line",
];

export const PART_CONSTRAINT_FIELDS: readonly PartConstraintFieldName[] = [
  "templateIds",
  "materialIds",
  "requiredAffixIds",
  "optionalAffixPoolIds",
  "typeIds",
];

const ITEM_PART_BY_SLOT: Record<PartConstraintSlot, PartConstraintItemPartId> = {
  rod: "part:rod",
  reel: "part:reel",
  line: "part:line",
};

const PART_CONSTRAINT_REVIEW_STATUSES = new Set<PartConstraintReviewStatus>([
  "CONFIRMED",
  "NEEDS_REVIEW",
]);

function assertReviewStatus(
  value: unknown,
  location: string,
): asserts value is PartConstraintReviewStatus {
  if (!PART_CONSTRAINT_REVIEW_STATUSES.has(value as PartConstraintReviewStatus)) {
    throw new Error(
      `PART_CONSTRAINT_REVIEW_STATUS_INVALID：${location} 的 reviewStatus 非法。`,
    );
  }
}

interface MigratedConstraintSource {
  sourceRef: PartConstraintSourceRevisionRef;
  rawPayload: unknown;
  sourceSchemaVersion: number;
  migratedAt: string;
  constraintSetId: string;
  revision?: number;
  partPayloads?: Partial<Record<PartConstraintSlot, unknown>>;
  fieldEvidence?: Partial<Record<
    PartConstraintSlot,
    Partial<Record<PartConstraintFieldName, PartConstraintFieldSourceEvidence>>
  >>;
  diagnosticCodes?: string[];
  createdBy?: string;
}

export interface PartConstraintFieldSourceEvidence {
  sourcePath: string;
  rawPayload: unknown;
  transformationCodes: string[];
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function migratedIds(
  value: unknown,
  diagnostics: Set<string>,
): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) diagnostics.add("INVALID_CONSTRAINT_FIELD_PRESERVED_RAW");
    return [];
  }
  const ids = value.filter((entry): entry is string => typeof entry === "string");
  if (ids.length !== value.length) {
    diagnostics.add("INVALID_CONSTRAINT_ID_PRESERVED_RAW");
  }
  return [...ids];
}

function traceId(
  constraintSetId: string,
  revision: number,
  slot: PartConstraintSlot,
  field: PartConstraintFieldName,
): string {
  return `${constraintSetId}:r${revision}:trace:${slot}:${field}`;
}

function validatePartConstraintComponents(input: {
  constraintSetId: string;
  revision?: number;
  parts: PartConstraintSet["parts"];
  traces: PartConstraintSet["traces"];
  sourceRef: PartConstraintSourceRevisionRef;
}): Map<string, PartConstraintFieldTrace> {
  if (input.sourceRef.hashProjectionVersion !== PART_CONSTRAINT_SOURCE_HASH_PROJECTION) {
    throw new Error(
      `PART_CONSTRAINT_SOURCE_HASH_PROJECTION_UNSUPPORTED：${input.sourceRef.hashProjectionVersion} 不受支持。`,
    );
  }
  if (!Array.isArray(input.traces) || input.traces.length !== 15) {
    throw new Error(
      `PART_CONSTRAINT_TRACE_COUNT_INVALID：${input.constraintSetId} 必须恰好包含 15 条竿轮线字段 Trace。`,
    );
  }
  const tracesById = new Map<string, PartConstraintFieldTrace>();
  for (const trace of input.traces) {
    assertReviewStatus(trace.reviewStatus, `Trace ${trace.traceId}`);
    if (tracesById.has(trace.traceId)) {
      throw new Error(
        `PART_CONSTRAINT_TRACE_ID_DUPLICATE：${trace.traceId} 重复。`,
      );
    }
    tracesById.set(trace.traceId, trace);
  }

  const partSlots = Object.keys(input.parts).sort();
  if (
    partSlots.length !== PART_CONSTRAINT_SLOTS.length
    || PART_CONSTRAINT_SLOTS.some((slot) => !partSlots.includes(slot))
  ) {
    throw new Error(
      `PART_CONSTRAINT_PART_SLOTS_INVALID：${input.constraintSetId} 必须恰好包含 rod/reel/line。`,
    );
  }

  const usedTraceIds = new Set<string>();
  const tracesByComponent = new Map<string, PartConstraintFieldTrace>();
  const sourceRefHash = deterministicHash(input.sourceRef);
  for (const slot of PART_CONSTRAINT_SLOTS) {
    const part = input.parts[slot];
    assertReviewStatus(part.reviewStatus, `部位 ${slot}`);
    const expectedItemPartId = ITEM_PART_BY_SLOT[slot];
    if (part.itemPartId !== expectedItemPartId) {
      throw new Error(
        `PART_CONSTRAINT_ITEM_PART_MISMATCH：${slot} 必须映射 ${expectedItemPartId}。`,
      );
    }
    const traceRefFields = Object.keys(part.fieldTraceRefs).sort();
    if (
      traceRefFields.length !== PART_CONSTRAINT_FIELDS.length
      || PART_CONSTRAINT_FIELDS.some((field) => !traceRefFields.includes(field))
    ) {
      throw new Error(
        `PART_CONSTRAINT_FIELD_TRACE_REFS_INVALID：${slot} 必须恰好引用 5 个字段 Trace。`,
      );
    }

    const traceStatuses: PartConstraintReviewStatus[] = [];
    for (const field of PART_CONSTRAINT_FIELDS) {
      const values = part[field];
      if (
        !Array.isArray(values)
        || values.some((value) => typeof value !== "string")
      ) {
        throw new Error(
          `PART_CONSTRAINT_FIELD_VALUES_INVALID：${slot}.${field} 必须是纯字符串数组。`,
        );
      }
      const ref = part.fieldTraceRefs[field];
      const trace = tracesById.get(ref);
      if (!trace) {
        throw new Error(
          `PART_CONSTRAINT_TRACE_REF_NOT_FOUND：${ref} 不存在于 revision Trace。`,
        );
      }
      if (usedTraceIds.has(ref)) {
        throw new Error(
          `PART_CONSTRAINT_TRACE_REF_REUSED：${ref} 被多个 slot/field 复用。`,
        );
      }
      usedTraceIds.add(ref);
      if (trace.itemPartId !== expectedItemPartId || trace.field !== field) {
        throw new Error(
          `PART_CONSTRAINT_TRACE_MAPPING_INVALID：${ref} 与 ${slot}.${field} 不一致。`,
        );
      }
      if (
        input.revision !== undefined
        && ref !== traceId(input.constraintSetId, input.revision, slot, field)
      ) {
        throw new Error(
          `PART_CONSTRAINT_TRACE_REVISION_MISMATCH：${ref} 不属于 ${input.constraintSetId}@${input.revision}。`,
        );
      }
      if (!Array.isArray(trace.transformationCodes)) {
        throw new Error(
          `PART_CONSTRAINT_TRACE_TRANSFORMATION_CODES_MISSING：${ref} 缺少迁移转换证据。`,
        );
      }
      if (deterministicHash(trace.sourceRef) !== sourceRefHash) {
        throw new Error(
          `PART_CONSTRAINT_TRACE_SOURCE_REF_MISMATCH：${ref} 与集合来源 revision 不一致。`,
        );
      }
      traceStatuses.push(trace.reviewStatus);
      tracesByComponent.set(`${slot}:${field}`, trace);
    }

    const expectedPartStatus = traceStatuses.every(
      (status) => status === "CONFIRMED",
    )
      ? "CONFIRMED"
      : "NEEDS_REVIEW";
    if (part.reviewStatus !== expectedPartStatus) {
      throw new Error(
        `PART_CONSTRAINT_PART_REVIEW_STATUS_MISMATCH：${slot} 状态与字段 Trace 不一致。`,
      );
    }
  }

  if (usedTraceIds.size !== input.traces.length) {
    throw new Error(
      `PART_CONSTRAINT_TRACE_UNREFERENCED：${input.constraintSetId} 存在未被 slot/field 引用的 Trace。`,
    );
  }
  return tracesByComponent;
}

export function assertPartConstraintSetRevisionStructure(
  constraintSet: PartConstraintSet,
): void {
  if (
    typeof constraintSet.constraintSetId !== "string"
    || !constraintSet.constraintSetId.trim()
  ) {
    throw new Error(
      "PART_CONSTRAINT_SET_ID_INVALID：constraintSetId 必须是非空稳定身份。",
    );
  }
  if (
    !Number.isSafeInteger(constraintSet.revision)
    || constraintSet.revision < 1
  ) {
    throw new Error(
      `PART_CONSTRAINT_SET_REVISION_INVALID：${constraintSet.constraintSetId} 的 revision 必须是 >= 1 的安全整数。`,
    );
  }
  assertReviewStatus(
    constraintSet.reviewStatus,
    `${constraintSet.constraintSetId}@${constraintSet.revision}`,
  );
  validatePartConstraintComponents({
    constraintSetId: constraintSet.constraintSetId,
    revision: constraintSet.revision,
    parts: constraintSet.parts,
    traces: constraintSet.traces,
    sourceRef: constraintSet.sourceRef,
  });
  const expectedSetStatus = Object.values(constraintSet.parts).every(
    (part) => part.reviewStatus === "CONFIRMED",
  )
    ? "CONFIRMED"
    : "NEEDS_REVIEW";
  if (constraintSet.reviewStatus !== expectedSetStatus) {
    throw new Error(
      `PART_CONSTRAINT_SET_REVIEW_STATUS_MISMATCH：${constraintSet.constraintSetId}@${constraintSet.revision} 状态与部位状态不一致。`,
    );
  }
}

/**
 * Creates the immutable migration carrier used by schema v18.
 * It deliberately never confirms migrated values: only a later human action may
 * create a CONFIRMED revision.
 */
export function createNeedsReviewPartConstraintSet(
  input: MigratedConstraintSource,
): PartConstraintSet {
  const revision = input.revision ?? 1;
  const traces: PartConstraintFieldTrace[] = [];
  const setDiagnostics = new Set(input.diagnosticCodes ?? []);
  const parts = Object.fromEntries(PART_CONSTRAINT_SLOTS.map((slot) => {
    const itemPartId = ITEM_PART_BY_SLOT[slot];
    const rawPart = input.partPayloads?.[slot];
    const part = recordOf(rawPart);
    const fieldTraceRefs = {} as Record<PartConstraintFieldName, string>;
    const values = {} as Record<PartConstraintFieldName, string[]>;

    if (!rawPart || Object.keys(part).length === 0) {
      setDiagnostics.add("PART_CONSTRAINT_SOURCE_MISSING");
    }

    for (const field of PART_CONSTRAINT_FIELDS) {
      const fieldDiagnostics = new Set<string>();
      const evidence = input.fieldEvidence?.[slot]?.[field];
      values[field] = migratedIds(part[field], fieldDiagnostics);
      if (values[field].length) fieldDiagnostics.add("UNVERIFIED_LEGACY_IDS");
      if (field === "typeIds" && values[field].length) {
        fieldDiagnostics.add("UNCONFIRMED_PART_TYPE_CLASSIFICATION");
      }
      if (input.sourceRef.revisionId === null) {
        fieldDiagnostics.add("SOURCE_REVISION_MISSING");
      }
      const id = traceId(input.constraintSetId, revision, slot, field);
      fieldTraceRefs[field] = id;
      traces.push({
        traceId: id,
        itemPartId,
        field,
        sourceRef: structuredClone(input.sourceRef),
        sourcePath: evidence?.sourcePath ?? (
          input.partPayloads?.[slot] === undefined
            ? "$"
            : `$.partConstraints.${slot}.${field}`
        ),
        transformationCodes: [...(evidence?.transformationCodes ?? [])],
        reviewStatus: "NEEDS_REVIEW",
        diagnosticCodes: [...fieldDiagnostics].sort(),
        rawPayload: structuredClone(evidence ? evidence.rawPayload : part[field]),
      });
      for (const code of fieldDiagnostics) setDiagnostics.add(code);
    }

    const knownFields = new Set<string>([...PART_CONSTRAINT_FIELDS, "notes"]);
    if (typeof part.notes === "string" && part.notes) {
      setDiagnostics.add("LEGACY_PART_NOTES_PRESERVED_RAW");
    }
    if (Object.keys(part).some((field) => !knownFields.has(field))) {
      setDiagnostics.add("UNKNOWN_PART_FIELDS_PRESERVED_RAW");
    }

    const constraint: PartConstraint = {
      itemPartId,
      reviewStatus: "NEEDS_REVIEW",
      templateIds: values.templateIds,
      materialIds: values.materialIds,
      requiredAffixIds: values.requiredAffixIds,
      optionalAffixPoolIds: values.optionalAffixPoolIds,
      typeIds: values.typeIds,
      fieldTraceRefs,
    };
    return [slot, constraint];
  })) as Record<PartConstraintSlot, PartConstraint>;

  const withoutHash: Omit<PartConstraintSet, "contentHash"> = {
    constraintSetId: input.constraintSetId,
    revision,
    reviewStatus: "NEEDS_REVIEW",
    parts,
    sourceRef: structuredClone(input.sourceRef),
    traces,
    migrationEvidence: {
      migratorVersion: PART_CONSTRAINT_MIGRATOR_VERSION,
      sourceSchemaVersion: input.sourceSchemaVersion,
      migratedAt: input.migratedAt,
      diagnosticCodes: [...setDiagnostics].sort(),
      rawPayload: structuredClone(input.rawPayload),
    },
    createdBy: input.createdBy ?? "workspace-migration",
    createdAt: input.migratedAt,
  };
  const constraintSet = {
    ...withoutHash,
    contentHash: partConstraintSetContentHash(withoutHash),
  };
  assertPartConstraintSetRevisionStructure(constraintSet);
  return constraintSet;
}

export function partConstraintSourceContentHash(
  source: object,
): string {
  const {
    partConstraintSetRef: _partConstraintSetRef,
    ...projected
  } = source as Record<string, unknown>;
  void _partConstraintSetRef;
  return deterministicHash(projected);
}

export function partConstraintSourceStableId(
  source: object,
  sourceType: string,
): string {
  const id = (source as Record<string, unknown>).id;
  if (typeof id === "string" && id.trim()) return id;
  return `missing:${sourceType}:${partConstraintSourceContentHash(source)}`;
}

export function partConstraintSourceRevisionId(
  source: object,
): string | null {
  const record = source as Record<string, unknown>;
  const revision = record.revisionId ?? record.revision;
  if (
    (typeof revision === "string" && revision.trim())
    || (typeof revision === "number" && Number.isFinite(revision))
  ) {
    return String(revision);
  }
  return null;
}

export function partConstraintSetContentHash(
  constraintSet: Omit<PartConstraintSet, "contentHash"> | PartConstraintSet,
): string {
  const {
    contentHash: _contentHash,
    ...content
  } = constraintSet as PartConstraintSet;
  void _contentHash;
  return deterministicHash(content);
}

export function resolvePartConstraintSourceRevision<T extends object>(
  sources: readonly T[],
  ref: PartConstraintSourceRevisionRef,
): T {
  if (ref.hashProjectionVersion !== PART_CONSTRAINT_SOURCE_HASH_PROJECTION) {
    throw new Error(
      `PART_CONSTRAINT_SOURCE_HASH_PROJECTION_UNSUPPORTED：${ref.hashProjectionVersion} 不受支持。`,
    );
  }
  const matches = sources.filter((source) => {
    if (partConstraintSourceStableId(source, ref.sourceType) !== ref.sourceId) {
      return false;
    }
    return partConstraintSourceRevisionId(source) === ref.revisionId;
  });
  if (!matches.length) {
    throw new Error(
      `PART_CONSTRAINT_SOURCE_REF_NOT_FOUND：${ref.sourceId}@${ref.revisionId ?? "missing"} 不存在。`,
    );
  }
  if (matches.length !== 1) {
    throw new Error(
      `PART_CONSTRAINT_SOURCE_REVISION_DUPLICATE：${ref.sourceId}@${ref.revisionId ?? "missing"} 必须唯一。`,
    );
  }
  if (partConstraintSourceContentHash(matches[0]) !== ref.contentHash) {
    throw new Error(
      `PART_CONSTRAINT_SOURCE_HASH_MISMATCH：${ref.sourceId}@${ref.revisionId ?? "missing"} 内容哈希不一致。`,
    );
  }
  return matches[0];
}

export function partConstraintSetRef(
  constraintSet: PartConstraintSet,
): PartConstraintSetRef {
  return {
    constraintSetId: constraintSet.constraintSetId,
    revision: constraintSet.revision,
    contentHash: constraintSet.contentHash,
  };
}

/**
 * Exact immutable-ref boundary for #50. It resolves no "latest" aliases and
 * performs no candidate enumeration.
 */
export function resolvePartConstraintSetRef(
  constraintSets: readonly PartConstraintSet[],
  ref: PartConstraintSetRef,
): PartConstraintSet {
  const revisions = constraintSets.filter(
    (entry) =>
      entry.constraintSetId === ref.constraintSetId
      && entry.revision === ref.revision,
  );
  if (!revisions.length) {
    throw new Error(
      `PART_CONSTRAINT_SET_REF_NOT_FOUND：${ref.constraintSetId}@${ref.revision} 不存在。`,
    );
  }
  if (revisions.length !== 1) {
    throw new Error(
      `PART_CONSTRAINT_SET_REVISION_DUPLICATE：${ref.constraintSetId}@${ref.revision} 必须唯一。`,
    );
  }
  const revision = revisions[0];
  const computedHash = partConstraintSetContentHash(revision);
  if (revision.contentHash !== computedHash) {
    throw new Error(
      `PART_CONSTRAINT_SET_CONTENT_TAMPERED：${ref.constraintSetId}@${ref.revision} 存储内容与哈希不一致。`,
    );
  }
  if (computedHash !== ref.contentHash) {
    throw new Error(
      `PART_CONSTRAINT_SET_HASH_MISMATCH：${ref.constraintSetId}@${ref.revision} 内容哈希不一致。`,
    );
  }
  assertPartConstraintSetRevisionStructure(revision);
  return revision;
}

export function createPartConstraintSetRevision(input: {
  current: PartConstraintSet;
  expectedCurrentRef: PartConstraintSetRef;
  parts: PartConstraintSet["parts"];
  traces: PartConstraintSet["traces"];
  sourceRef: PartConstraintSourceRevisionRef;
  createdBy: string;
  createdAt: string;
}): PartConstraintSet {
  resolvePartConstraintSetRef([input.current], input.expectedCurrentRef);
  const tracesByComponent = validatePartConstraintComponents({
    constraintSetId: input.current.constraintSetId,
    parts: input.parts,
    traces: input.traces,
    sourceRef: input.sourceRef,
  });
  const revision = input.current.revision + 1;
  const parts = structuredClone(input.parts);
  const traces = PART_CONSTRAINT_SLOTS.flatMap((slot) =>
    PART_CONSTRAINT_FIELDS.map((field) => {
      const nextTraceId = traceId(
        input.current.constraintSetId,
        revision,
        slot,
        field,
      );
      parts[slot].fieldTraceRefs[field] = nextTraceId;
      return {
        ...structuredClone(tracesByComponent.get(`${slot}:${field}`)!),
        traceId: nextTraceId,
      };
    })
  );
  const reviewStatus = Object.values(input.parts).every(
    (part) => part.reviewStatus === "CONFIRMED",
  )
    ? "CONFIRMED" as const
    : "NEEDS_REVIEW" as const;
  const withoutHash: Omit<PartConstraintSet, "contentHash"> = {
    constraintSetId: input.current.constraintSetId,
    revision,
    reviewStatus,
    parts,
    sourceRef: structuredClone(input.sourceRef),
    traces,
    migrationEvidence: structuredClone(input.current.migrationEvidence),
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  };
  const next = {
    ...withoutHash,
    contentHash: partConstraintSetContentHash(withoutHash),
  };
  assertPartConstraintSetRevisionStructure(next);
  return next;
}

export function partConstraintSetBlockingTraceRefs(
  constraintSet: PartConstraintSet,
): string[] {
  return constraintSet.traces
    .filter((trace) => trace.reviewStatus === "NEEDS_REVIEW")
    .map((trace) => trace.traceId);
}
