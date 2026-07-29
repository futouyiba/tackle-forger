import { jcsSha256Hex } from "./canonical-json";
import type {
  V23AffixDefinition,
  V23ProjectAffixPayload,
  V23StableContentRef,
  V23TechnologyDefinition,
  WorkspaceState,
} from "./types";

export class V23TechnologyError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "V23TechnologyError";
  }
}

function exactRef(left: V23StableContentRef, right: V23StableContentRef) {
  return left.id === right.id
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

export function v23TechnologyContentHash(
  definition: Omit<V23TechnologyDefinition, "contentHash">,
): string {
  return jcsSha256Hex(definition);
}

export function resolveV23AffixDefinition(
  state: Pick<WorkspaceState, "v23AffixDefinitions">,
  ref: V23StableContentRef,
): V23AffixDefinition {
  const matches = state.v23AffixDefinitions.filter((entry) =>
    entry.affixId === ref.id
    && entry.revision === ref.revision
    && entry.contentHash === ref.contentHash);
  if (matches.length !== 1) {
    throw new V23TechnologyError("V23_AFFIX_REF_UNRESOLVED", `词条引用 ${ref.id}@${ref.revision} 无法唯一解析。`);
  }
  return matches[0]!;
}

export function resolveV23TechnologyDefinition(
  state: Pick<WorkspaceState, "v23TechnologyDefinitions">,
  ref: V23StableContentRef,
): V23TechnologyDefinition {
  const matches = state.v23TechnologyDefinitions.filter((entry) =>
    entry.technologyId === ref.id
    && entry.revision === ref.revision
    && entry.contentHash === ref.contentHash);
  if (matches.length !== 1) {
    throw new V23TechnologyError(
      "V23_TECHNOLOGY_REF_UNRESOLVED",
      `Technology 引用 ${ref.id}@${ref.revision} 无法唯一解析。`,
    );
  }
  return matches[0]!;
}

export function currentV23TechnologyDefinition(
  state: Pick<WorkspaceState, "v23TechnologyDefinitions" | "v23TechnologyHeads">,
  technologyId: string,
): V23TechnologyDefinition {
  const heads = state.v23TechnologyHeads.filter((entry) => entry.technologyId === technologyId);
  if (heads.length !== 1) {
    throw new V23TechnologyError("V23_TECHNOLOGY_HEAD_UNRESOLVED", "Technology head 不唯一或不存在。");
  }
  const matches = state.v23TechnologyDefinitions.filter((entry) =>
    entry.technologyId === technologyId && entry.revision === heads[0]!.revision);
  if (matches.length !== 1) {
    throw new V23TechnologyError("V23_TECHNOLOGY_HEAD_UNRESOLVED", "Technology head 无法解析。");
  }
  return matches[0]!;
}

export function validateV23TechnologyDefinition(
  state: Pick<WorkspaceState, "v23AffixDefinitions">,
  definition: V23TechnologyDefinition,
): void {
  const expected = v23TechnologyContentHash({
    technologyId: definition.technologyId,
    revision: definition.revision,
    itemPartId: definition.itemPartId,
    name: definition.name,
    description: definition.description,
    memberAffixRefs: definition.memberAffixRefs,
    enabled: definition.enabled,
  });
  if (expected !== definition.contentHash) {
    throw new V23TechnologyError("V23_TECHNOLOGY_CONTENT_HASH_MISMATCH", "Technology contentHash 不匹配。");
  }
  if (definition.memberAffixRefs.length === 0) {
    throw new V23TechnologyError("V23_TECHNOLOGY_EMPTY", "Technology 必须至少包含一个成员。");
  }
  const ids = new Set<string>();
  const semantics = new Map<string, V23ProjectAffixPayload>();
  for (const ref of definition.memberAffixRefs) {
    if (ids.has(ref.id)) {
      throw new V23TechnologyError("V23_TECHNOLOGY_MEMBER_DUPLICATE", "Technology 成员稳定 ID 不得重复。");
    }
    ids.add(ref.id);
    const affix = resolveV23AffixDefinition(state, ref);
    if (!affix.payload.enabled || affix.payload.itemPartId !== definition.itemPartId) {
      throw new V23TechnologyError(
        "V23_TECHNOLOGY_MEMBER_INVALID",
        "Technology 成员必须启用且与 Technology 部位一致。",
      );
    }
    const prior = semantics.get(affix.payload.semanticContributionKey);
    if (
      prior
      && (prior.stackingPolicy === "dedupe" || affix.payload.stackingPolicy === "dedupe")
    ) {
      throw new V23TechnologyError(
        "V23_TECHNOLOGY_SEMANTIC_CONTRIBUTION_CONFLICT",
        "Technology 成员语义贡献冲突。",
      );
    }
    semantics.set(affix.payload.semanticContributionKey, affix.payload);
  }
}

export function expandV23TechnologyRefs(
  state: Pick<WorkspaceState, "v23TechnologyDefinitions" | "v23AffixDefinitions">,
  refs: readonly V23StableContentRef[],
  itemPartId: string,
): Array<{ ref: V23StableContentRef; payload: V23ProjectAffixPayload }> {
  const technologies = new Set<string>();
  const members = new Map<string, { ref: V23StableContentRef; payload: V23ProjectAffixPayload }>();
  for (const ref of refs) {
    if (technologies.has(ref.id)) {
      throw new V23TechnologyError("V23_TECHNOLOGY_REF_DUPLICATE", "Technology 稳定 ID 不得重复挂载。");
    }
    technologies.add(ref.id);
    const technology = resolveV23TechnologyDefinition(state, ref);
    validateV23TechnologyDefinition(state, technology);
    if (!technology.enabled) {
      throw new V23TechnologyError("V23_TECHNOLOGY_DISABLED", "禁用的 Technology 不得参与展开。");
    }
    if (technology.itemPartId !== itemPartId) {
      throw new V23TechnologyError("V23_TECHNOLOGY_ITEM_PART_MISMATCH", "Technology 与目标 Part 不一致。");
    }
    for (const memberRef of technology.memberAffixRefs) {
      const affix = resolveV23AffixDefinition(state, memberRef);
      const prior = members.get(memberRef.id);
      if (prior && !exactRef(prior.ref, memberRef)) {
        throw new V23TechnologyError(
          "V23_TECHNOLOGY_MEMBER_IDENTITY_CONFLICT",
          "多个 Technology 对同一词条稳定 ID 指向不同 revision。",
        );
      }
      if (!prior) members.set(memberRef.id, { ref: memberRef, payload: affix.payload });
    }
  }
  return [...members.values()];
}
