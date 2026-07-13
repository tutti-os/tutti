import type { AgentActivitySession } from "./types.ts";

export type AgentActivitySessionInput = Pick<
  AgentActivitySession,
  "agentSessionId" | "cwd" | "provider" | "title" | "workspaceId"
> &
  Partial<AgentActivitySession>;

export function normalizeAgentActivitySession<const Provider extends string>(
  source: AgentActivitySessionInput & {
    provider: Provider;
    providerSessionId: string;
  }
): AgentActivitySession & { provider: Provider; providerSessionId: string };
export function normalizeAgentActivitySession(
  source: AgentActivitySessionInput
): AgentActivitySession;
export function normalizeAgentActivitySession(
  source: AgentActivitySessionInput
): AgentActivitySession {
  const createdAtUnixMs = source.createdAtUnixMs ?? source.startedAtUnixMs ?? 0;
  const updatedAtUnixMs =
    source.updatedAtUnixMs ?? source.lastEventUnixMs ?? createdAtUnixMs;
  return {
    ...source,
    agentTargetId: source.agentTargetId ?? null,
    providerSessionId: source.providerSessionId ?? null,
    activeTurnId: source.activeTurnId ?? source.activeTurn?.turnId ?? null,
    activeTurn: source.activeTurn ?? null,
    latestTurn: source.latestTurn ?? source.activeTurn ?? null,
    latestTurnInteractions: source.latestTurnInteractions ?? [],
    pendingInteractions: source.pendingInteractions ?? [],
    settings: source.settings ?? {},
    permissionConfig: source.permissionConfig ?? {
      configurable: false,
      modes: []
    },
    capabilities: source.capabilities ?? null,
    usage: source.usage ?? null,
    backgroundAgents: source.backgroundAgents ?? null,
    goal: source.goal ?? null,
    imported: source.imported ?? false,
    visible: source.visible ?? true,
    resumable: source.resumable ?? false,
    messageVersion: source.messageVersion ?? 0,
    lastEventUnixMs: source.lastEventUnixMs ?? updatedAtUnixMs,
    startedAtUnixMs: source.startedAtUnixMs ?? createdAtUnixMs,
    endedAtUnixMs: source.endedAtUnixMs ?? null,
    pinnedAtUnixMs: source.pinnedAtUnixMs ?? null,
    createdAtUnixMs,
    updatedAtUnixMs
  };
}
