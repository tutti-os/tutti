import type { WorkspaceAgentSessionMessage } from "@tutti-os/client-tuttid-ts";

export interface PendingSubmission {
  agentSessionID: string;
  agentTargetID: string | null;
  clientSubmitID: string;
  creating: boolean;
  text: string;
}

export function resolvePendingSubmission(
  current: PendingSubmission | null,
  input: {
    agentSessionID: string | null;
    agentTargetID: string | null;
    creating: boolean;
    text: string;
  }
): PendingSubmission {
  if (
    current &&
    current.text === input.text &&
    current.creating === input.creating &&
    (input.creating || current.agentSessionID === input.agentSessionID) &&
    current.agentTargetID === (input.creating ? input.agentTargetID : null)
  ) {
    return current;
  }
  return {
    agentSessionID: input.creating
      ? createEntityID()
      : (input.agentSessionID ?? ""),
    agentTargetID: input.creating ? input.agentTargetID : null,
    clientSubmitID: createEntityID(),
    creating: input.creating,
    text: input.text
  };
}

export function mergeMessages(
  current: WorkspaceAgentSessionMessage[],
  incoming: WorkspaceAgentSessionMessage[]
): WorkspaceAgentSessionMessage[] {
  const byID = new Map(current.map((message) => [message.messageId, message]));
  for (const message of incoming) {
    const previous = byID.get(message.messageId);
    if (!previous || message.version >= previous.version) {
      byID.set(message.messageId, message);
    }
  }
  return [...byID.values()].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.messageId.localeCompare(right.messageId)
  );
}

function createEntityID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}
