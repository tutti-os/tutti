import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";
import type { AgentCollaborationVM } from "../contracts/agentCollaborationVM";

export const COLLABORATION_TIMELINE_ITEM_TYPE = "collaboration";

export function isCollaborationTimelineItem(
  item: Pick<WorkspaceAgentActivityTimelineItem, "itemType">
): boolean {
  return (
    item.itemType.trim().toLowerCase() === COLLABORATION_TIMELINE_ITEM_TYPE
  );
}

/**
 * Pure projection of one durable collaboration message payload into the typed
 * card view model. Returns null when the payload has no run identity, so a
 * malformed row degrades to a plain assistant message instead of a broken
 * card.
 */
export function projectAgentCollaborationVM(
  item: Pick<
    WorkspaceAgentActivityTimelineItem,
    "agentSessionId" | "payload" | "status" | "workspaceId"
  >
): AgentCollaborationVM | null {
  const payload = normalizedPayload(item.payload);
  if (!payload) {
    return null;
  }
  const runId = stringField(payload, "runId");
  const mode = stringField(payload, "mode");
  if (!runId || !mode) {
    return null;
  }
  const status =
    stringField(payload, "status") ?? item.status?.trim() ?? "running";
  return {
    kind: "collaboration",
    runId,
    workspaceId: item.workspaceId?.trim() || null,
    agentSessionId: item.agentSessionId.trim() || null,
    mode,
    status,
    triggerSource: stringField(payload, "triggerSource") ?? "user",
    triggerReason: stringField(payload, "triggerReason"),
    targetSessionId: stringField(payload, "targetSessionId"),
    targetAgentTargetId: stringField(payload, "targetAgentTargetId"),
    modelPlanId: stringField(payload, "modelPlanId"),
    modelPlanName:
      stringField(payload, "modelPlanName") ?? stringField(payload, "planName"),
    model: stringField(payload, "model"),
    contextScope: stringField(payload, "contextScope"),
    retryOfRunId: stringField(payload, "retryOfRunId"),
    attempt: positiveIntegerField(payload, "attempt") ?? 1,
    requestText: stringField(payload, "requestText"),
    resultText: stringField(payload, "resultText"),
    failureReason: stringField(payload, "failureReason"),
    failureStage: stringField(payload, "failureStage"),
    durationMs: positiveNumberField(payload, "durationMs"),
    usage: usageField(payload),
    cost: costField(payload),
    adoption: stringField(payload, "adoption") ?? "not_applicable"
  };
}

function costField(
  payload: Record<string, unknown>
): AgentCollaborationVM["cost"] {
  const cost = normalizedPayload(
    payload.cost as WorkspaceAgentActivityTimelineItem["payload"]
  );
  if (!cost) return null;
  const currency = stringField(cost, "currency");
  const estimatedMicros = nonNegativeNumberValue(cost.estimatedMicros);
  return currency && estimatedMicros !== null
    ? { currency, estimatedMicros }
    : null;
}

function positiveIntegerField(
  payload: Record<string, unknown>,
  key: string
): number | null {
  const value = nonNegativeNumberValue(payload[key]);
  return value !== null && Number.isInteger(value) && value > 0 ? value : null;
}

function usageField(
  payload: Record<string, unknown>
): AgentCollaborationVM["usage"] {
  const usage = normalizedPayload(
    payload.usage as WorkspaceAgentActivityTimelineItem["payload"]
  );
  if (!usage) {
    return null;
  }
  const inputTokens = nonNegativeNumberValue(usage.inputTokens);
  const outputTokens = nonNegativeNumberValue(usage.outputTokens);
  const cacheReadTokens = nonNegativeNumberValue(usage.cacheReadTokens);
  const cacheWriteTokens = nonNegativeNumberValue(usage.cacheWriteTokens);
  if (
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null
  ) {
    return null;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0
  };
}

function normalizedPayload(
  payload: WorkspaceAgentActivityTimelineItem["payload"]
): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : null;
}

function stringField(
  payload: Record<string, unknown>,
  key: string
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumberField(
  payload: Record<string, unknown>,
  key: string
): number | null {
  const value = nonNegativeNumberValue(payload[key]);
  return value !== null && value > 0 ? value : null;
}

function nonNegativeNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
