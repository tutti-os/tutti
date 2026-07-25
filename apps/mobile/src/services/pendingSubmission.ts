export interface PendingSubmission {
  agentSessionId: string;
  agentTargetId: string | null;
  clientSubmitId: string;
  creating: boolean;
  text: string;
}

export function resolvePendingSubmission(
  current: PendingSubmission | null,
  input: {
    agentSessionId: string | null;
    agentTargetId: string | null;
    creating: boolean;
    text: string;
  }
): PendingSubmission {
  if (
    current &&
    current.text === input.text &&
    current.creating === input.creating &&
    (input.creating || current.agentSessionId === input.agentSessionId) &&
    current.agentTargetId === (input.creating ? input.agentTargetId : null)
  ) {
    return current;
  }
  return {
    agentSessionId: input.creating
      ? createEntityId()
      : (input.agentSessionId ?? ""),
    agentTargetId: input.creating ? input.agentTargetId : null,
    clientSubmitId: createEntityId(),
    creating: input.creating,
    text: input.text
  };
}

function createEntityId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}
