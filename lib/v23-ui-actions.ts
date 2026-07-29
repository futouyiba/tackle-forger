import { jcsSha256Hex } from "./canonical-json";
import { issueClientActionCommand } from "./client-action-command";
import type { ActionCode } from "./interaction-contracts";

export async function executeV23UiAction(action: Extract<ActionCode,
  "update_part_configuration" | "create_sku" | "add_sku_affix" | "remove_inherited_affix" |
  "restore_inherited_affix" | "copy_sku_local_affix" | "create_project_affix" | "set_sku_actual_quality"
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
