import { deterministicHash } from "./rule-kernel";
import type { ProjectionTraceStep } from "./types";

export type PerformanceSummaryDirection =
  | "positive"
  | "negative"
  | "neutral"
  | "contextual";

export type PerformanceSummaryMatcher =
  | {
      source: "technology";
      technologyId: string;
    }
  | {
      source: "affix";
      affixId: string;
    }
  | {
      source: "final_panel";
      parameterKey: string;
      comparison: "gte" | "gt" | "lte" | "lt" | "eq";
      threshold: number;
    };

export interface PerformanceSummaryRule {
  key: string;
  label: string;
  direction: PerformanceSummaryDirection;
  order: number;
  matcher: PerformanceSummaryMatcher;
}

export interface PerformanceSummaryDefinition {
  definitionId: string;
  definitionVersion: string;
  publicationState: "DRAFT" | "PUBLISHED" | "SUPERSEDED";
  rules: PerformanceSummaryRule[];
  definitionHash: string;
}

export interface PerformanceSummary {
  subjectId: string;
  subjectRevisionId: string;
  definitionId: string;
  definitionVersion: string;
  labels: Array<{
    key: string;
    label: string;
    direction: PerformanceSummaryDirection;
    magnitude?: number;
    evidenceRefs: string[];
  }>;
  inputHash: string;
}

export type PerformanceSummarySnapshot =
  | {
      status: "AVAILABLE";
      summary: PerformanceSummary;
      definitionRef: {
        definitionId: string;
        definitionVersion: string;
      };
    }
  | {
      status: "UNAVAILABLE";
      reason: "definition_missing";
    };

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function definitionContent(
  definition: PerformanceSummaryDefinition,
): Omit<PerformanceSummaryDefinition, "definitionHash"> {
  const { definitionHash: _definitionHash, ...content } = definition;
  return content;
}

export function createPerformanceSummaryDefinition(
  input: Omit<PerformanceSummaryDefinition, "definitionHash">,
): PerformanceSummaryDefinition {
  const content: Omit<PerformanceSummaryDefinition, "definitionHash"> = {
    definitionId: input.definitionId,
    definitionVersion: input.definitionVersion,
    publicationState: input.publicationState,
    rules: structuredClone(input.rules),
  };
  if (!content.definitionId.trim() || !content.definitionVersion.trim()) {
    throw new Error("PerformanceSummaryDefinition 的 definitionId 与 definitionVersion 为必填。");
  }
  validateRules(content.rules);
  return {
    ...content,
    definitionHash: deterministicHash(content),
  };
}

export function verifyPerformanceSummaryDefinition(
  definition: PerformanceSummaryDefinition,
): boolean {
  if (!definition.definitionId.trim() || !definition.definitionVersion.trim()) {
    return false;
  }
  try {
    validateRules(definition.rules);
  } catch {
    return false;
  }
  return deterministicHash(definitionContent(definition)) === definition.definitionHash;
}

function validateRules(rules: PerformanceSummaryRule[]): void {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (!rule.key.trim() || !rule.label.trim() || !Number.isInteger(rule.order)) {
      throw new Error("PerformanceSummaryDefinition 的 key、label 与整数 order 均为必填。");
    }
    if (keys.has(rule.key)) {
      throw new Error(`PerformanceSummaryDefinition 包含重复标签 key：${rule.key}。`);
    }
    keys.add(rule.key);
    if (
      rule.matcher.source === "final_panel"
      && (!rule.matcher.parameterKey.trim() || !Number.isFinite(rule.matcher.threshold))
    ) {
      throw new Error(`PerformanceSummaryDefinition 的 ${rule.key} 数值匹配器无效。`);
    }
  }
}

function numberMatches(
  value: number,
  comparison: Extract<PerformanceSummaryMatcher, { source: "final_panel" }>["comparison"],
  threshold: number,
): boolean {
  if (comparison === "gte") return value >= threshold;
  if (comparison === "gt") return value > threshold;
  if (comparison === "lte") return value <= threshold;
  if (comparison === "lt") return value < threshold;
  return Object.is(value, threshold);
}

function traceEvidence(
  trace: ProjectionTraceStep[],
  parameterKey: string,
): string[] {
  return trace
    .flatMap((step) =>
      step.contributions
        .filter((entry) => entry.parameterKey === parameterKey)
        .map((entry) =>
          `trace:${step.layer}:${entry.sequence}:${entry.sourceId}:${entry.ruleId}`,
        ),
    )
    .sort(compareUtf8);
}

export function unavailablePerformanceSummary(): PerformanceSummarySnapshot {
  return { status: "UNAVAILABLE", reason: "definition_missing" };
}

export function derivePerformanceSummary(input: {
  subjectId: string;
  subjectRevisionId: string;
  definition?: PerformanceSummaryDefinition;
  technologyIds: string[];
  affixIds: string[];
  finalPanelValues: Record<string, number | string>;
  attributeTrace: ProjectionTraceStep[];
}): PerformanceSummarySnapshot {
  if (!input.definition) return unavailablePerformanceSummary();
  if (
    input.definition.publicationState !== "PUBLISHED"
    || !verifyPerformanceSummaryDefinition(input.definition)
  ) {
    throw new Error("PerformanceSummaryDefinition 未发布或完整性校验失败。");
  }

  const technologyIds = [...new Set(input.technologyIds)].sort(compareUtf8);
  const affixIds = [...new Set(input.affixIds)].sort(compareUtf8);
  const finalPanelValues = Object.fromEntries(
    Object.entries(input.finalPanelValues).sort(([left], [right]) => compareUtf8(left, right)),
  );
  const labels = [...input.definition.rules]
    .sort((left, right) => left.order - right.order || compareUtf8(left.key, right.key))
    .flatMap((rule) => {
      if (rule.matcher.source === "technology") {
        return technologyIds.includes(rule.matcher.technologyId)
          ? [{
              key: rule.key,
              label: rule.label,
              direction: rule.direction,
              evidenceRefs: [`technology:${rule.matcher.technologyId}`],
            }]
          : [];
      }
      if (rule.matcher.source === "affix") {
        return affixIds.includes(rule.matcher.affixId)
          ? [{
              key: rule.key,
              label: rule.label,
              direction: rule.direction,
              evidenceRefs: [`affix:${rule.matcher.affixId}`],
            }]
          : [];
      }
      const value = finalPanelValues[rule.matcher.parameterKey];
      if (
        typeof value !== "number"
        || !Number.isFinite(value)
        || !numberMatches(value, rule.matcher.comparison, rule.matcher.threshold)
      ) {
        return [];
      }
      return [{
        key: rule.key,
        label: rule.label,
        direction: rule.direction,
        magnitude: Math.abs(value - rule.matcher.threshold),
        evidenceRefs: [
          `final_panel:${rule.matcher.parameterKey}`,
          ...traceEvidence(input.attributeTrace, rule.matcher.parameterKey),
        ],
      }];
    });

  const hashInput = {
    subjectId: input.subjectId,
    subjectRevisionId: input.subjectRevisionId,
    definitionId: input.definition.definitionId,
    definitionVersion: input.definition.definitionVersion,
    definitionHash: input.definition.definitionHash,
    technologyIds,
    affixIds,
    finalPanelValues,
    attributeTrace: structuredClone(input.attributeTrace),
  };
  const summary: PerformanceSummary = {
    subjectId: input.subjectId,
    subjectRevisionId: input.subjectRevisionId,
    definitionId: input.definition.definitionId,
    definitionVersion: input.definition.definitionVersion,
    labels,
    inputHash: deterministicHash(hashInput),
  };
  return {
    status: "AVAILABLE",
    summary,
    definitionRef: {
      definitionId: input.definition.definitionId,
      definitionVersion: input.definition.definitionVersion,
    },
  };
}
