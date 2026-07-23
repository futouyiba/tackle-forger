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
} from "./types";

export const PART_CONSTRAINT_MIGRATOR_VERSION = "part-constraint-set/v1";

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

interface MigratedConstraintSource {
  sourceRef: PartConstraintSourceRevisionRef;
  rawPayload: unknown;
  sourceSchemaVersion: number;
  migratedAt: string;
  constraintSetId: string;
  revision?: number;
  partPayloads?: Partial<Record<PartConstraintSlot, unknown>>;
  diagnosticCodes?: string[];
  createdBy?: string;
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
        sourcePath: input.partPayloads?.[slot] === undefined
          ? "$"
          : `$.partConstraints.${slot}.${field}`,
        reviewStatus: "NEEDS_REVIEW",
        diagnosticCodes: [...fieldDiagnostics].sort(),
        rawPayload: structuredClone(part[field]),
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
  return {
    ...withoutHash,
    contentHash: deterministicHash(withoutHash),
  };
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
  const revision = constraintSets.find(
    (entry) =>
      entry.constraintSetId === ref.constraintSetId
      && entry.revision === ref.revision,
  );
  if (!revision) {
    throw new Error(
      `PART_CONSTRAINT_SET_REF_NOT_FOUND：${ref.constraintSetId}@${ref.revision} 不存在。`,
    );
  }
  if (revision.contentHash !== ref.contentHash) {
    throw new Error(
      `PART_CONSTRAINT_SET_HASH_MISMATCH：${ref.constraintSetId}@${ref.revision} 内容哈希不一致。`,
    );
  }
  return revision;
}

export function partConstraintSetBlockingTraceRefs(
  constraintSet: PartConstraintSet,
): string[] {
  return constraintSet.traces
    .filter((trace) => trace.reviewStatus === "NEEDS_REVIEW")
    .map((trace) => trace.traceId);
}
