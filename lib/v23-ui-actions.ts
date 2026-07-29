import { jcsSha256Hex } from "./canonical-json";
import { issueClientActionCommand } from "./client-action-command";
import type { ActionCode } from "./interaction-contracts";
import type { V23ProjectAffixPayload, V23ProjectAttributeOperation, V23ProjectPassivePayload, V23StableContentRef } from "./types";

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function buildV23LocalCopyPayload(input: {
  original: V23ProjectAffixPayload;
  sourceRef: V23StableContentRef;
  name: string;
  description: string;
  valueScoreText: string;
  branchJson: string;
  publishedRuleSetIds: readonly string[];
}): { payload?: V23ProjectAffixPayload; error?: string } {
  const name = input.name.trim();
  if (!input.valueScoreText.trim()) return { error: "名称和有限价值分必填。" };
  const valueScore = Number(input.valueScoreText);
  if (!name || !finite(valueScore)) return { error: "名称和有限价值分必填。" };
  let branch: unknown;
  try { branch = JSON.parse(input.branchJson); } catch { return { error: "配置 JSON 无法解析。" }; }
  if (input.original.category === "attribute") {
    if (!Array.isArray(branch) || branch.length === 0) return { error: "属性词条必须包含 operations。" };
    const ids = new Set<string>(); const indexes = new Set<number>();
    for (const candidate of branch) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { error: "operation 必须是对象。" };
      const operation = candidate as Record<string, unknown>;
      const kind = operation.operation;
      const keys = kind === "set" || kind === "enum_add"
        ? ["operationId", "operationIndex", "sourceAffixId", "sourceAffixRevision", "parameterKey", "operation", "value"]
        : kind === "clamp_add"
          ? ["operationId", "operationIndex", "sourceAffixId", "sourceAffixRevision", "parameterKey", "operation", "direction", "magnitude", "clampMin", "clampMax", "publishedMagnitudeRange"]
          : ["operationId", "operationIndex", "sourceAffixId", "sourceAffixRevision", "parameterKey", "operation", "direction", "magnitude", "publishedMagnitudeRange"];
      if (!["percent_adjust", "flat_adjust", "clamp_add", "enum_add", "set"].includes(String(kind)) || !exactKeys(operation, keys)) return { error: "operation closed schema 无效。" };
      if (typeof operation.operationId !== "string" || !operation.operationId || !Number.isSafeInteger(operation.operationIndex) || (operation.operationIndex as number) < 0
        || typeof operation.parameterKey !== "string" || !operation.parameterKey
        || operation.sourceAffixId !== input.sourceRef.id || operation.sourceAffixRevision !== input.sourceRef.revision
        || ids.has(operation.operationId) || indexes.has(operation.operationIndex as number)) return { error: "operation identity/source 无效。" };
      ids.add(operation.operationId); indexes.add(operation.operationIndex as number);
      if (kind === "set" && !["string", "number", "boolean"].includes(typeof operation.value)) return { error: "set value 无效。" };
      if (kind === "set" && typeof operation.value === "number" && !finite(operation.value)) return { error: "set value 必须有限。" };
      if (kind === "enum_add" && (typeof operation.value !== "string" || !operation.value)) return { error: "enum_add value 无效。" };
      if (!["set", "enum_add"].includes(String(kind))) {
        const range = operation.publishedMagnitudeRange as Record<string, unknown> | null;
        if (!range || Array.isArray(range) || !exactKeys(range, ["min", "max", "ruleSetVersion"])
          || !finite(operation.magnitude) || operation.magnitude < 0
          || !finite(range.min) || !finite(range.max) || range.max < range.min
          || operation.magnitude < range.min || operation.magnitude > range.max
          || typeof range.ruleSetVersion !== "string" || !range.ruleSetVersion
          || input.publishedRuleSetIds.filter((id) => id === range.ruleSetVersion).length !== 1
          || !["increase", "decrease"].includes(String(operation.direction))) return { error: "operation magnitude/range 无效。" };
        if (kind === "clamp_add" && (!finite(operation.clampMin) || !finite(operation.clampMax) || operation.clampMax < operation.clampMin)) return { error: "clamp 边界无效。" };
      }
    }
    return { payload: { ...input.original, name, description: input.description, valueScore, operations: branch as V23ProjectAttributeOperation[], passivePayload: null } };
  }
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return { error: "passivePayload 必须是对象。" };
  const passive = branch as Record<string, unknown>;
  const keys = ["skillId", "name", "itemPartId", "triggerType", "triggerDescription", "effectTarget", "effectLogicDescription", "exampleParameters", "durationDescription", "cooldownDescription", "resetDescription", "stackingDescription", "playerDescription", "simulatorReferenceKey"];
  if (!exactKeys(passive, keys) || passive.itemPartId !== input.original.itemPartId) return { error: "passivePayload closed schema/部位无效。" };
  for (const key of keys.filter((key) => !["exampleParameters", "simulatorReferenceKey"].includes(key))) {
    if (typeof passive[key] !== "string" || !passive[key]) return { error: `passivePayload.${key} 必填。` };
  }
  const examples = passive.exampleParameters;
  if (!examples || typeof examples !== "object" || Array.isArray(examples)
    || Object.values(examples).some((value) => !["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !finite(value)))
    || !(passive.simulatorReferenceKey === null || (typeof passive.simulatorReferenceKey === "string" && passive.simulatorReferenceKey.length > 0))) return { error: "passivePayload 参数或 simulator reference 无效。" };
  return { payload: { ...input.original, name, description: input.description, valueScore, operations: [], passivePayload: passive as unknown as V23ProjectPassivePayload } };
}

export function v23WritePreflight(input: { dirty: boolean; revision: number; expectedWorkspaceRevision: unknown }) {
  if (input.dirty) return { allowed: false as const, reason: "dirty" as const };
  if (input.expectedWorkspaceRevision !== input.revision) return { allowed: false as const, reason: "revision" as const };
  return { allowed: true as const };
}

export function v23LatestGeneration(current: number, response: number) { return current === response; }

export function v23CanApplyReadback(input: { current: { dirty: boolean; revision: number }; baselineRevision: number; returnedRevision: number }) {
  return !input.current.dirty && input.current.revision === input.baselineRevision && input.returnedRevision >= input.baselineRevision;
}

export async function executeV23UiAction(action: Extract<ActionCode,
  "update_part_configuration" | "create_sku" | "add_sku_affix" | "remove_inherited_affix" |
  "restore_inherited_affix" | "copy_sku_local_affix" | "update_sku_local_affix_copy" |
  "create_project_affix" | "attach_part_technology" | "remove_part_technology" |
  "attach_sku_technology" | "remove_sku_technology" | "set_sku_actual_quality"
>, idempotencyKey: string, payload: Record<string, unknown>) {
  const canonical = { ...payload };
  const businessPayload = { ...canonical, inputHash: jcsSha256Hex(canonical) };
  const invocation = await issueClientActionCommand({ action, idempotencyKey, payload: businessPayload });
  const response = await fetch("/api/v23/actions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invocation),
  });
  const result = await response.json().catch(() => null) as { error?: string; code?: string; revision?: number } | null;
  if (!response.ok || !result || !Number.isInteger(result.revision)) {
    throw new Error(result?.error ?? result?.code ?? "v23 动作未完成；未应用任何本地猜测状态。");
  }
  return result;
}

export async function previewV23WeightBand(partId: string, expectedPartRevision: number, weightBandId: string) {
  const response = await fetch("/api/v23/actions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "preview_weight_band_skus", payload: { partId, expectedPartRevision, weightBandId } }),
  });
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !result) throw new Error(typeof result?.error === "string" ? result.error : "重量段预览不可用。");
  return result;
}
