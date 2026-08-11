import {
  selectPlanTurnDismissed,
  selectSessionMessages,
  selectWorkspaceAgentConsumerSessions,
  type AgentActivitySession,
  type AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import { latestPlanTurnId } from "./planImplementationPresentation";

type AgentSessionEngineSnapshot = Parameters<
  typeof selectWorkspaceAgentConsumerSessions
>[0];

/**
 * Shared predicate for the synthesized plan-implementation wait. Durable
 * approval / question / exit-plan waits already ride pendingInteractions;
 * this predicate is the matching cross-surface fact for plan confirmation so
 * rail, conversation list, and attention do not each invent a private rule.
 */
export function consumerAwaitingPlanImplementation(input: {
  capabilities: AgentActivitySession["capabilities"] | null | undefined;
  dismissed: boolean;
  latestTurn: AgentActivityTurn | null | undefined;
  messages: readonly {
    turnId?: string | null;
    occurredAtUnixMs?: number | null;
    createdAtUnixMs?: number | null;
    seq?: number | null;
    payload?: Record<string, unknown> | null;
  }[];
}): boolean {
  const latestTurn = input.latestTurn;
  if (
    !latestTurn ||
    latestTurn.phase !== "settled" ||
    latestTurn.outcome !== "completed" ||
    input.capabilities?.planImplementation !== true ||
    input.capabilities?.planMode !== true ||
    input.dismissed
  ) {
    return false;
  }
  return latestPlanTurnId(input.messages) === latestTurn.turnId;
}

export function selectRootAgentSessionIdsAwaitingPlanImplementation(
  state: AgentSessionEngineSnapshot
): readonly string[] {
  const sessionIds: string[] = [];
  for (const consumer of selectWorkspaceAgentConsumerSessions(state)) {
    const sessionId = consumer.session.agentSessionId;
    if (
      !consumerAwaitingPlanImplementation({
        capabilities: consumer.session.capabilities,
        dismissed: selectPlanTurnDismissed(
          state,
          sessionId,
          consumer.latestTurn?.turnId
        ),
        latestTurn: consumer.latestTurn,
        messages: sessionMessagesForPlanDetection(state, consumer.session)
      })
    ) {
      continue;
    }
    sessionIds.push(sessionId);
  }
  return sessionIds;
}

function sessionMessagesForPlanDetection(
  state: AgentSessionEngineSnapshot,
  session: Pick<AgentActivitySession, "agentSessionId" | "providerSessionId">
) {
  for (const id of [session.agentSessionId, session.providerSessionId]) {
    const messages = selectSessionMessages(state, id);
    if (messages.length > 0) {
      return messages;
    }
  }
  return [];
}
