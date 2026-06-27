import type { WorkspaceAgentSessionMessage } from "@tutti-os/client-tuttid-ts";

export function normalizedTuttidMessageTurnId(
  message: WorkspaceAgentSessionMessage
): string {
  const turnId = message.turnId?.trim() ?? "";
  if (!turnId) {
    throw new Error(
      `workspace agent session message ${message.messageId.trim()} is missing turnId`
    );
  }
  return turnId;
}

export function normalizedTuttidMessageOccurredAtUnixMs(
  message: WorkspaceAgentSessionMessage
): number {
  return (
    positiveNumber(message.occurredAtUnixMs) ??
    positiveNumber(message.startedAtUnixMs) ??
    positiveNumber(message.completedAtUnixMs) ??
    positiveNumber(message.createdAtUnixMs) ??
    positiveNumber(message.updatedAtUnixMs) ??
    positiveNumber(message.version) ??
    1
  );
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
