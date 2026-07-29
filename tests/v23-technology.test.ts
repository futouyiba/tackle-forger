import assert from "node:assert/strict";
import test from "node:test";
import { jcsSha256Hex } from "../lib/canonical-json";
import {
  expandV23TechnologyRefs,
  validateV23TechnologyDefinition,
  v23TechnologyContentHash,
  V23TechnologyError,
} from "../lib/v23-technology";
import type {
  V23AffixDefinition,
  V23TechnologyDefinition,
  WorkspaceState,
} from "../lib/types";

function affix(id: string, semantic = id, itemPartId = "part:rod"): V23AffixDefinition {
  const payload = {
    name: id, category: "attribute" as const, itemPartId,
    semanticContributionKey: semantic, stackingPolicy: "dedupe" as const,
    generationPolicy: "technology_only" as const, rarity: "common" as const,
    valueScore: 1, tags: [], description: "", enabled: true,
    operations: [{
      operationId: `op:${id}`, operationIndex: 0, sourceAffixId: id,
      sourceAffixRevision: 1, parameterKey: "pull",
      operation: "flat_adjust" as const, direction: "increase" as const,
      magnitude: 1,
      publishedMagnitudeRange: { min: 0, max: 2, ruleSetVersion: "ruleset" },
    }],
    passivePayload: null,
  };
  return {
    affixId: id,
    revision: 1,
    payload,
    contentHash: jcsSha256Hex({ affixId: id, revision: 1, payload }),
  };
}

function technology(
  member: V23AffixDefinition,
  overrides: Partial<Omit<V23TechnologyDefinition, "contentHash">> = {},
): V23TechnologyDefinition {
  const value = {
    technologyId: "technology:one", revision: 1,
    itemPartId: "part:rod" as const, name: "One", description: "",
    memberAffixRefs: [{
      id: member.affixId, revision: member.revision, contentHash: member.contentHash,
    }],
    enabled: true,
    ...overrides,
  };
  return { ...value, contentHash: v23TechnologyContentHash(value) };
}

test("immutable Technology expands exact members and adds no score of its own", () => {
  const member = affix("affix:one");
  const definition = technology(member);
  const state = {
    v23AffixDefinitions: [member],
    v23TechnologyDefinitions: [definition],
  } as Pick<WorkspaceState, "v23AffixDefinitions" | "v23TechnologyDefinitions">;
  validateV23TechnologyDefinition(state, definition);
  assert.deepEqual(expandV23TechnologyRefs(state, [{
    id: definition.technologyId,
    revision: definition.revision,
    contentHash: definition.contentHash,
  }], "part:rod"), [{
    ref: definition.memberAffixRefs[0],
    payload: member.payload,
  }]);
  assert.equal(Object.hasOwn(definition, "valueScore"), false);
  assert.equal(Object.hasOwn(definition, "operations"), false);
});

test("Technology rejects hash, disabled expansion, cross-Part, duplicates and semantic conflicts", () => {
  const first = affix("affix:first", "same");
  const second = affix("affix:second", "same");
  const state = {
    v23AffixDefinitions: [first, second],
    v23TechnologyDefinitions: [] as V23TechnologyDefinition[],
  } as Pick<WorkspaceState, "v23AffixDefinitions" | "v23TechnologyDefinitions">;
  const valid = technology(first);
  assert.throws(
    () => validateV23TechnologyDefinition(state, { ...valid, contentHash: "0".repeat(64) }),
    (error: unknown) => error instanceof V23TechnologyError
      && error.code === "V23_TECHNOLOGY_CONTENT_HASH_MISMATCH",
  );
  assert.throws(() => validateV23TechnologyDefinition(state, technology(first, {
    memberAffixRefs: [valid.memberAffixRefs[0]!, valid.memberAffixRefs[0]!],
  })), /MEMBER_DUPLICATE/);
  assert.throws(() => validateV23TechnologyDefinition(state, technology(first, {
    memberAffixRefs: [
      valid.memberAffixRefs[0]!,
      { id: second.affixId, revision: 1, contentHash: second.contentHash },
    ],
  })), /SEMANTIC_CONTRIBUTION_CONFLICT/);
  assert.throws(
    () => validateV23TechnologyDefinition(state, technology(first, { itemPartId: "part:line" })),
    /MEMBER_INVALID/,
  );
  const disabled = technology(first, { enabled: false });
  state.v23TechnologyDefinitions = [disabled];
  assert.throws(() => expandV23TechnologyRefs(state, [{
    id: disabled.technologyId, revision: 1, contentHash: disabled.contentHash,
  }], "part:rod"), /TECHNOLOGY_DISABLED/);
});
