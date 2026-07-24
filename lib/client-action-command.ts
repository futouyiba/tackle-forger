import type {
  ActionCode,
  ActionCommandPayloadRef,
} from "./interaction-contracts";

export async function issueClientActionCommand(input: {
  action: ActionCode;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}): Promise<{ actionId: string; payloadRefId: string }> {
  const response = await fetch("/api/action-commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = (await response.json().catch(() => null)) as
    | {
      actionId?: string;
      commandPayloadRef?: ActionCommandPayloadRef;
      error?: string;
    }
    | null;
  if (
    !response.ok
    || !result?.actionId
    || !result.commandPayloadRef?.payloadRefId
  ) {
    throw new Error(result?.error ?? "服务端无法签发状态写命令。");
  }
  return {
    actionId: result.actionId,
    payloadRefId: result.commandPayloadRef.payloadRefId,
  };
}
