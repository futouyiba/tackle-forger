import type {
  PatchApplicationIssue,
  PatchApplicationResult,
  PatchRebaseDifference,
  PatchRebasePreview,
  ProjectionPatchOperation,
  ProjectionPatchRuleSource,
} from "./types";
import { stableStringify } from "./rule-kernel";

type InternalOperation =
  | ProjectionPatchOperation
  | { op: "min"; path: string; value: number }
  | { op: "max"; path: string; value: number };

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pathParts(path: string): string[] | null {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (
    !parts.length ||
    parts.some(
      (part) =>
        part === "__proto__" ||
        part === "prototype" ||
        part === "constructor",
    )
  ) {
    return null;
  }
  return parts;
}

function getAtPath(root: unknown, path: string): unknown {
  const parts = pathParts(path);
  if (!parts) return undefined;
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setAtPath(root: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = pathParts(path);
  if (!parts) return false;
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return true;
}

function removeAtPath(root: Record<string, unknown>, path: string): boolean {
  const parts = pathParts(path);
  if (!parts) return false;
  let current: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return false;
    current = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, leaf)) return false;
  delete current[leaf];
  return true;
}

function operationsForPatch(
  patch: ProjectionPatchRuleSource,
): InternalOperation[] {
  if (patch.operations?.length) return structuredClone(patch.operations);
  return patch.rules.flatMap((rule): InternalOperation[] => {
    if (
      rule.operation === "set" ||
      rule.operation === "add" ||
      rule.operation === "multiply" ||
      rule.operation === "min" ||
      rule.operation === "max"
    ) {
      return [
        {
          op: rule.operation,
          path: rule.parameterKey,
          value: rule.value as never,
        } as InternalOperation,
      ];
    }
    return [];
  });
}

function issue(
  issues: PatchApplicationIssue[],
  value: PatchApplicationIssue,
): void {
  issues.push(value);
}

function sortPatches(
  patches: ProjectionPatchRuleSource[],
): ProjectionPatchRuleSource[] {
  const scopeOrder = { series: 0, sku: 1, model: 2, final_review: 3 };
  return [...patches].sort(
    (left, right) =>
      scopeOrder[left.scope] - scopeOrder[right.scope] ||
      left.order - right.order ||
      compareText(left.id, right.id),
  );
}

export interface ApplyLayeredPatchesOptions {
  includeDrafts?: boolean;
  expectedProjectionId?: string;
  expectedRuleSetVersion?: string;
}

export function applyLayeredPatches<T extends Record<string, unknown>>(
  base: T,
  patches: ProjectionPatchRuleSource[],
  options: ApplyLayeredPatchesOptions = {},
): PatchApplicationResult<T> {
  const value = structuredClone(base);
  const trace: PatchApplicationResult<T>["trace"] = [];
  const issues: PatchApplicationIssue[] = [];
  const appliedPatchIds: string[] = [];
  const setByScopePath = new Map<string, string>();

  for (const patch of sortPatches(patches)) {
    const eligible =
      patch.status === "approved" ||
      (options.includeDrafts && patch.status === "draft");
    if (!eligible) {
      issue(issues, {
        level: "info",
        code: "PATCH_SKIPPED",
        patchId: patch.id,
        message: "Patch 状态为 " + patch.status + "，本次未应用。",
        requiresReview: false,
      });
      continue;
    }
    if (
      options.expectedProjectionId &&
      patch.baseProjectionId !== options.expectedProjectionId
    ) {
      issue(issues, {
        level: "warning",
        code: "PATCH_BASE_MISMATCH",
        patchId: patch.id,
        message:
          "Patch 基于 " + patch.baseProjectionId + "，当前投影为 " +
          options.expectedProjectionId + "。",
        requiresReview: true,
      });
    }
    if (
      options.expectedRuleSetVersion &&
      patch.baseRuleSetVersion !== options.expectedRuleSetVersion
    ) {
      issue(issues, {
        level: "warning",
        code: "PATCH_BASE_MISMATCH",
        patchId: patch.id,
        message:
          "Patch 规则版本为 " + patch.baseRuleSetVersion + "，当前为 " +
          options.expectedRuleSetVersion + "。",
        requiresReview: true,
      });
    }

    let applied = false;
    for (const operation of operationsForPatch(patch)) {
      if (!pathParts(operation.path)) {
        issue(issues, {
          level: "error",
          code: "PATCH_PATH_INVALID",
          patchId: patch.id,
          path: operation.path,
          message: "Patch 路径无效：" + operation.path,
          requiresReview: true,
        });
        continue;
      }
      if (operation.op === "set") {
        const conflictKey = patch.scope + ":" + operation.path;
        const previousPatchId = setByScopePath.get(conflictKey);
        if (previousPatchId) {
          issue(issues, {
            level: "error",
            code: "PATCH_SET_CONFLICT",
            patchId: patch.id,
            path: operation.path,
            message:
              "同一 " + patch.scope + " 作用域路径存在多个 set：" +
              previousPatchId + "、" + patch.id + "。",
            requiresReview: true,
          });
        } else {
          setByScopePath.set(conflictKey, patch.id);
        }
      }

      const before = structuredClone(getAtPath(value, operation.path));
      let after: unknown = before;
      if (operation.op === "remove") {
        if (!removeAtPath(value, operation.path)) {
          issue(issues, {
            level: "warning",
            code: "PATCH_REMOVE_MISSING",
            patchId: patch.id,
            path: operation.path,
            message: "remove 目标不存在：" + operation.path,
            requiresReview: true,
          });
          continue;
        }
        after = undefined;
      } else if (operation.op === "set") {
        setAtPath(value, operation.path, structuredClone(operation.value));
        after = structuredClone(operation.value);
      } else {
        if (typeof before !== "number" || typeof operation.value !== "number") {
          issue(issues, {
            level: "error",
            code: "PATCH_NUMERIC_REQUIRED",
            patchId: patch.id,
            path: operation.path,
            message: operation.op + " 只支持数字路径。",
            requiresReview: true,
          });
          continue;
        }
        if (operation.op === "add") after = before + operation.value;
        if (operation.op === "multiply") after = before * operation.value;
        if (operation.op === "min") after = Math.min(before, operation.value);
        if (operation.op === "max") after = Math.max(before, operation.value);
        setAtPath(value, operation.path, after);
      }
      trace.push({
        patchId: patch.id,
        scope: patch.scope,
        scopeId: patch.scopeId,
        path: operation.path,
        operation:
          operation.op === "min" || operation.op === "max"
            ? "set"
            : operation.op,
        before,
        operand: "value" in operation ? operation.value : undefined,
        after,
      });
      applied = true;
    }
    if (applied) appliedPatchIds.push(patch.id);
  }

  return { value, appliedPatchIds, trace, issues };
}

function equal(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export interface PreviewPatchRebaseInput<T extends Record<string, unknown>> {
  oldBase: T;
  newBase: T;
  patches: ProjectionPatchRuleSource[];
  oldProjectionId: string;
  newProjectionId: string;
  oldRuleSetVersion: string;
  newRuleSetVersion: string;
}

export function previewPatchRebase<T extends Record<string, unknown>>(
  input: PreviewPatchRebaseInput<T>,
): PatchRebasePreview<T> {
  const oldApplication = applyLayeredPatches(input.oldBase, input.patches, {
    includeDrafts: true,
    expectedProjectionId: input.oldProjectionId,
    expectedRuleSetVersion: input.oldRuleSetVersion,
  });
  const newApplication = applyLayeredPatches(input.newBase, input.patches, {
    includeDrafts: true,
    expectedProjectionId: input.newProjectionId,
    expectedRuleSetVersion: input.newRuleSetVersion,
  });
  const issues = [...oldApplication.issues, ...newApplication.issues];
  const paths = Array.from(
    new Set(
      input.patches.flatMap((patch) =>
        operationsForPatch(patch).map((operation) => operation.path),
      ),
    ),
  ).sort(compareText);

  for (const patch of input.patches) {
    for (const operation of operationsForPatch(patch)) {
      if (
        operation.op === "set" &&
        !equal(
          getAtPath(input.oldBase, operation.path),
          getAtPath(input.newBase, operation.path),
        )
      ) {
        issue(issues, {
          level: "warning",
          code: "PATCH_BASE_MISMATCH",
          patchId: patch.id,
          path: operation.path,
          message:
            "set Patch 的基础值已变化，必须人工复核：" + operation.path,
          requiresReview: true,
        });
      }
    }
  }

  const differences: PatchRebaseDifference[] = paths
    .map((path) => ({
      path,
      oldBase: structuredClone(getAtPath(input.oldBase, path)),
      newBase: structuredClone(getAtPath(input.newBase, path)),
      oldResult: structuredClone(getAtPath(oldApplication.value, path)),
      newResult: structuredClone(getAtPath(newApplication.value, path)),
    }))
    .filter(
      (difference) =>
        !equal(difference.oldBase, difference.newBase) ||
        !equal(difference.oldResult, difference.newResult),
    );

  return {
    oldProjectionId: input.oldProjectionId,
    newProjectionId: input.newProjectionId,
    oldRuleSetVersion: input.oldRuleSetVersion,
    newRuleSetVersion: input.newRuleSetVersion,
    oldResult: oldApplication.value,
    newResult: newApplication.value,
    differences,
    issues,
    requiresReview: issues.some((entry) => entry.requiresReview),
  };
}

