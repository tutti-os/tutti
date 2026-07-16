import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import { extractAgentMcpToolTarget } from "../../agentMcpToolTarget";
import { normalizeAgentApprovalPurpose } from "../agentApprovalPurpose";
import type {
  AgentApprovalItemVM,
  AgentApprovalOptionVM
} from "../contracts/agentApprovalItemVM";
import { isExitPlanSwitchModeInput } from "../exitPlanOptions";

export function projectAgentApprovalItem(
  call: WorkspaceAgentSessionDetailToolCall,
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null
): AgentApprovalItemVM | null {
  const callType = normalizeToken(call.callType);
  const toolName = normalizeToken(call.toolName);
  if (callType !== "approval" && toolName !== "approval") {
    return null;
  }
  const requestId =
    stringValue(input?.requestId) ??
    stringValue(call.payload?.requestId) ??
    stringValue(output?.requestId);
  if (!requestId) {
    return null;
  }
  const options = normalizeApprovalOptions(
    arrayValue(input?.options) ?? arrayValue(call.payload?.options) ?? []
  );
  if (isExitPlanSwitchModeInput(input)) {
    return null;
  }
  const mcpTarget = extractAgentMcpToolTarget({
    input,
    payload: call.payload,
    toolName: call.toolName,
    name: call.name
  });
  const approvalPurpose = normalizeAgentApprovalPurpose(
    call.payload?.approvalPurpose
  );
  return {
    kind: "approval",
    id: call.id,
    turnId: call.turnId ?? "turn:unknown",
    requestId,
    callId: call.id.replace(/^call:/, ""),
    ...(approvalPurpose ? { approvalPurpose } : {}),
    title: mcpTarget?.displayName ?? (call.summary.trim() || call.name),
    toolName: call.toolName,
    status: stringValue(call.payload?.status) ?? call.status,
    input,
    options,
    output,
    occurredAtUnixMs: call.occurredAtUnixMs ?? null
  };
}

function normalizeApprovalOptions(
  values: readonly unknown[]
): AgentApprovalOptionVM[] {
  return values.flatMap((value) => {
    const option = objectValue(value);
    const id = stringValue(option?.optionId) ?? stringValue(option?.id);
    if (!id) {
      return [];
    }
    const label =
      stringValue(option?.name) ??
      stringValue(option?.label) ??
      stringValue(option?.title) ??
      stringValue(option?.kind) ??
      id;
    return [
      {
        id,
        label,
        kind: stringValue(option?.kind) ?? "",
        ...(stringValue(option?.description)
          ? { description: stringValue(option?.description) as string }
          : {})
      }
    ];
  });
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
