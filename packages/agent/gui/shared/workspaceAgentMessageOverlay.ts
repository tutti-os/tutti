import {
  mergeAgentActivityMessages,
  type AgentActivityMessage
} from "@tutti-os/agent-activity-core";

export function createWorkspaceAgentActivityUserMessageIdFromClientSubmitId(
  clientSubmitId: string
): string | null {
  const normalized = clientSubmitId.trim();
  return normalized ? `client-submit:user:${normalized}` : null;
}

export function isWorkspaceAgentActivityOptimisticMessage(
  message: AgentActivityMessage
): boolean {
  return message.payload?.__agentGuiOptimisticPrompt === true;
}

export function selectWorkspaceAgentActivityOverlayMessages(input: {
  durableMessages?: readonly AgentActivityMessage[] | null;
  localMessages?: readonly AgentActivityMessage[] | null;
}): AgentActivityMessage[] {
  const durableMessages = input.durableMessages ?? [];
  const localMessages = input.localMessages ?? [];
  if (localMessages.length === 0) return [];
  const durableIdentities = new Set(
    durableMessages
      .map(workspaceAgentActivityMessageIdentity)
      .filter((identity): identity is string => identity !== null)
  );
  const durableClientSubmitIds = new Set(
    durableMessages
      .map(workspaceAgentActivityClientSubmitId)
      .filter((value): value is string => value !== null)
  );
  const durableUserPromptSignatures = new Set(
    durableMessages
      .map(workspaceAgentActivityUserPromptSignature)
      .filter((value): value is string => value !== null)
  );
  return localMessages.filter((message) => {
    const identity = workspaceAgentActivityMessageIdentity(message);
    if (identity !== null && durableIdentities.has(identity)) return false;
    if (!isWorkspaceAgentActivityOptimisticMessage(message)) return true;
    const clientSubmitId = workspaceAgentActivityClientSubmitId(message);
    if (clientSubmitId !== null && durableClientSubmitIds.has(clientSubmitId)) {
      return false;
    }
    if (clientSubmitId !== null) return true;
    const signature = workspaceAgentActivityUserPromptSignature(message);
    return signature === null || !durableUserPromptSignatures.has(signature);
  });
}

export function mergeWorkspaceAgentActivityDurableAndOverlayMessages(input: {
  durableMessages?: readonly AgentActivityMessage[] | null;
  localMessages?: readonly AgentActivityMessage[] | null;
}): AgentActivityMessage[] {
  const durableMessages = input.durableMessages ?? [];
  const overlayMessages = selectWorkspaceAgentActivityOverlayMessages(input);
  if (overlayMessages.length === 0) return [...durableMessages];
  const overlayDurableMessages = overlayMessages.filter(
    (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
  );
  const optimisticMessages = overlayMessages
    .filter(isWorkspaceAgentActivityOptimisticMessage)
    .slice()
    .sort(
      (left, right) =>
        left.occurredAtUnixMs - right.occurredAtUnixMs ||
        left.messageId.localeCompare(right.messageId)
    );
  const merged =
    overlayDurableMessages.length === 0
      ? [...durableMessages]
      : mergeAgentActivityMessages(durableMessages, overlayDurableMessages);
  return optimisticMessages.length === 0
    ? merged
    : [...merged, ...optimisticMessages];
}

function workspaceAgentActivityMessageIdentity(
  message: AgentActivityMessage
): string | null {
  const messageId = message.messageId?.trim() ?? "";
  if (messageId) return `message:${messageId}`;
  return typeof message.version === "number" && Number.isFinite(message.version)
    ? `version:${message.version}`
    : null;
}

function workspaceAgentActivityClientSubmitId(
  message: AgentActivityMessage
): string | null {
  const value = message.payload?.clientSubmitId;
  return typeof value === "string" && value.trim()
    ? `${message.agentSessionId}\u0000${value.trim()}`
    : null;
}

function workspaceAgentActivityUserPromptSignature(
  message: AgentActivityMessage
): string | null {
  if (message.role !== "user") return null;
  const text = stringField(message.payload, "text");
  const content = contentSignature(message.payload);
  return text || content !== null
    ? [message.agentSessionId, text, content ?? ""].join("\u0000")
    : null;
}

function contentSignature(payload: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(payload, "content")) return null;
  if (!Array.isArray(payload.content)) return null;
  const parts: string[] = [];
  for (const block of payload.content) {
    if (!block || typeof block !== "object") return null;
    const record = block as Record<string, unknown>;
    const type = stringField(record, "type");
    if (!type) return null;
    const fields = [
      "text",
      "mimeType",
      "data",
      "url",
      "attachmentId",
      "name",
      "path",
      "uri",
      "hostPath",
      "uploadStatus",
      "assetId",
      "kind"
    ];
    const signature = [`type=${type}`];
    for (const field of fields) {
      const value = stringField(record, field);
      if (value) signature.push(`${field}=${value}`);
    }
    if (
      typeof record.sizeBytes === "number" &&
      Number.isFinite(record.sizeBytes)
    ) {
      signature.push(`sizeBytes=${record.sizeBytes}`);
    }
    parts.push(signature.join("\u0002"));
  }
  return parts.join("\u0001");
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value.trim() : "";
}
