import type { AgentGUINodeData } from "../../../types";

export type AgentGUIRememberedSessionSelection =
  | { kind: "none" }
  | { agentSessionId: string; kind: "restore" }
  | { agentSessionId: string; kind: "stale" };

interface PendingSessionTarget {
  agentSessionId: string;
  agentTargetId?: string | null;
}

function normalizeOptionalText(
  value: string | null | undefined
): string | null {
  return value?.trim() || null;
}

export function resolveAgentGUISessionMemoryTarget(input: {
  agentSessionId: string | null;
  canonicalAgentTargetId?: string | null;
  pendingActivation?: PendingSessionTarget | null;
  projectedAgentTargetId?: string | null;
}): string | null {
  const agentSessionId = normalizeOptionalText(input.agentSessionId);
  if (!agentSessionId) return null;
  const pendingAgentTargetId =
    normalizeOptionalText(input.pendingActivation?.agentSessionId) ===
    agentSessionId
      ? normalizeOptionalText(input.pendingActivation?.agentTargetId)
      : null;
  return (
    normalizeOptionalText(input.canonicalAgentTargetId) ??
    normalizeOptionalText(input.projectedAgentTargetId) ??
    pendingAgentTargetId
  );
}

export function rememberAgentGUIActiveConversation(
  current: AgentGUINodeData,
  agentSessionId: string | null,
  agentTargetId?: string | null
): AgentGUINodeData {
  const normalizedAgentSessionId = normalizeOptionalText(agentSessionId);
  const normalizedAgentTargetId = normalizeOptionalText(agentTargetId);
  const rememberedAgentSessionId = normalizedAgentTargetId
    ? (current.lastActiveAgentSessionIdByAgentTargetId?.[
        normalizedAgentTargetId
      ] ?? null)
    : null;
  if (
    current.lastActiveAgentSessionId === normalizedAgentSessionId &&
    (!normalizedAgentSessionId ||
      !normalizedAgentTargetId ||
      rememberedAgentSessionId === normalizedAgentSessionId)
  ) {
    return current;
  }
  return {
    ...current,
    lastActiveAgentSessionId: normalizedAgentSessionId,
    ...(normalizedAgentSessionId && normalizedAgentTargetId
      ? {
          lastActiveAgentSessionIdByAgentTargetId: {
            ...(current.lastActiveAgentSessionIdByAgentTargetId ?? {}),
            [normalizedAgentTargetId]: normalizedAgentSessionId
          }
        }
      : {})
  };
}

export function forgetAgentGUISessionMemories(
  current: AgentGUINodeData,
  agentSessionIds: ReadonlySet<string>
): AgentGUINodeData {
  if (agentSessionIds.size === 0) return current;
  const nextEntries = Object.entries(
    current.lastActiveAgentSessionIdByAgentTargetId ?? {}
  ).filter(([, agentSessionId]) => !agentSessionIds.has(agentSessionId));
  const nextMemories =
    nextEntries.length > 0 ? Object.fromEntries(nextEntries) : null;
  const nextActiveAgentSessionId =
    current.lastActiveAgentSessionId &&
    agentSessionIds.has(current.lastActiveAgentSessionId)
      ? null
      : current.lastActiveAgentSessionId;
  if (
    nextActiveAgentSessionId === current.lastActiveAgentSessionId &&
    nextEntries.length ===
      Object.keys(current.lastActiveAgentSessionIdByAgentTargetId ?? {}).length
  ) {
    return current;
  }
  return {
    ...current,
    lastActiveAgentSessionId: nextActiveAgentSessionId,
    lastActiveAgentSessionIdByAgentTargetId: nextMemories
  };
}

export function resolveAgentGUIRememberedSessionSelection(input: {
  data: AgentGUINodeData;
  deleted: boolean;
  knownAgentTargetId?: string | null;
  targetAgentTargetId: string | null;
}): AgentGUIRememberedSessionSelection {
  const targetAgentTargetId = normalizeOptionalText(input.targetAgentTargetId);
  if (!targetAgentTargetId) return { kind: "none" };
  const agentSessionId = normalizeOptionalText(
    input.data.lastActiveAgentSessionIdByAgentTargetId?.[targetAgentTargetId]
  );
  if (!agentSessionId) return { kind: "none" };
  const knownAgentTargetId = normalizeOptionalText(input.knownAgentTargetId);
  return input.deleted ||
    (knownAgentTargetId !== null && knownAgentTargetId !== targetAgentTargetId)
    ? { agentSessionId, kind: "stale" }
    : { agentSessionId, kind: "restore" };
}
