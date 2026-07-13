import { useMemo } from "react";
import {
  selectWorkspaceAgentConsumerSessions,
  selectPendingActivations,
  selectWorkspaceReconcileState,
  type AgentSessionEngine,
  type PendingActivationIntentRecord
} from "@tutti-os/agent-activity-core";
import { useEngineSelector } from "../../../../../shared/engine/useEngineSelector";
import {
  matchesAgentGUIConversationSummaryFilter,
  normalizeAgentGUIConversationFilter,
  type AgentGUIConversationFilter
} from "../../../../../agent-gui/agentGuiNode/model/agentGuiConversationFilter";
import type { AgentGUIProvider } from "../../../../../types";
import type { AgentGUIConversationSummary } from "../../../../../agent-gui/agentGuiNode/model/agentGuiConversationModel";
import {
  isAgentGUIProviderUnresolved,
  resolveAgentGUIConversationTitle,
  resolveAgentGUIProviderIdentity
} from "../../../../../shared/agentConversationTitleProjection.ts";

export interface AgentGUIConversationListQuery {
  conversationFilter?: AgentGUIConversationFilter | null;
  workspaceId: string;
  userId: string;
  provider: AgentGUIProvider;
  sessionOrigin: string;
}

export function useAgentGuiConversationList(
  engine: AgentSessionEngine,
  query: AgentGUIConversationListQuery | null
) {
  const workspaceReconcile = useEngineSelector(
    engine,
    selectWorkspaceReconcileState
  );
  const sessions = useEngineSelector(
    engine,
    selectWorkspaceAgentConsumerSessions,
    consumerSessionsEqual
  );
  const pendingActivations = useEngineSelector(
    engine,
    selectPendingActivations,
    pendingActivationsEqual
  );
  return useMemo(() => {
    if (!query) return null;
    const canonicalIds = new Set(
      sessions.map((item) => item.session.agentSessionId)
    );
    const latestNewActivationBySessionId = new Map(
      pendingActivations
        .filter(
          (activation) =>
            activation.mode === "new" && activation.status !== "failed"
        )
        .map((activation) => [activation.agentSessionId, activation] as const)
    );
    const pendingConversations = pendingActivations
      .filter(
        (activation) =>
          activation.mode === "new" &&
          activation.status !== "failed" &&
          !canonicalIds.has(activation.agentSessionId)
      )
      .map((activation): AgentGUIConversationSummary => {
        const provider = resolveAgentGUIProviderIdentity({
          sessionProvider: query.provider
        });
        const { title, titleFallback } = resolveAgentGUIConversationTitle(
          activation.title ?? "",
          provider
        );
        return {
          agentTargetId: activation.agentTargetId,
          cwd: activation.cwd,
          id: activation.agentSessionId,
          provider,
          sortTimeUnixMs: activation.requestedAtUnixMs,
          status: "working",
          title,
          titleFallback,
          updatedAtUnixMs: activation.requestedAtUnixMs,
          userId: query.userId
        };
      });
    const conversations = [
      ...sessions
        .filter((item) => item.session.workspaceId === query.workspaceId)
        .map((item): AgentGUIConversationSummary => {
          const provider = resolveAgentGUIProviderIdentity({
            sessionProvider: item.session.provider
          });
          const canonicalUpdatedAtUnixMs =
            item.session.updatedAtUnixMs ?? item.session.createdAtUnixMs ?? 0;
          const activation = latestNewActivationBySessionId.get(
            item.session.agentSessionId
          );
          const activationIsNewer =
            activation !== undefined &&
            activation.requestedAtUnixMs > canonicalUpdatedAtUnixMs;
          const { title, titleFallback } = resolveAgentGUIConversationTitle(
            activationIsNewer && activation.title
              ? activation.title
              : item.session.title,
            provider
          );
          return {
            agentTargetId: item.session.agentTargetId ?? null,
            cwd: item.session.cwd,
            id: item.session.agentSessionId,
            pinnedAtUnixMs: item.session.pinnedAtUnixMs ?? null,
            provider,
            resumable: item.session.resumable,
            sortTimeUnixMs: activationIsNewer
              ? activation.requestedAtUnixMs
              : (item.latestTurn?.updatedAtUnixMs ?? canonicalUpdatedAtUnixMs),
            status:
              item.displayStatus === "idle" ? "ready" : item.displayStatus,
            title,
            titleFallback,
            updatedAtUnixMs: activationIsNewer
              ? activation.requestedAtUnixMs
              : canonicalUpdatedAtUnixMs,
            userId: item.session.userId?.trim() ?? ""
          };
        }),
      ...pendingConversations
    ]
      .filter((conversation) => {
        if (query.conversationFilter) {
          return matchesAgentGUIConversationSummaryFilter(
            conversation,
            normalizeAgentGUIConversationFilter(query.conversationFilter)
          );
        }
        return (
          conversation.provider === query.provider ||
          isAgentGUIProviderUnresolved(conversation.provider)
        );
      })
      .sort(
        (left, right) =>
          (right.sortTimeUnixMs ?? right.updatedAtUnixMs) -
            (left.sortTimeUnixMs ?? left.updatedAtUnixMs) ||
          left.id.localeCompare(right.id)
      );
    return {
      conversations,
      error: workspaceReconcile.errorMessage,
      initialized:
        workspaceReconcile.status === "ready" ||
        workspaceReconcile.status === "failed" ||
        workspaceReconcile.status === "unknown",
      isLoading:
        workspaceReconcile.status === "idle" ||
        workspaceReconcile.status === "loading",
      query,
      queryKey: [
        query.workspaceId,
        query.userId,
        query.provider,
        query.sessionOrigin
      ].join("::")
    };
  }, [pendingActivations, query, sessions, workspaceReconcile]);
}

function pendingActivationsEqual(
  left: readonly PendingActivationIntentRecord[],
  right: readonly PendingActivationIntentRecord[]
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function consumerSessionsEqual(
  left: ReturnType<typeof selectWorkspaceAgentConsumerSessions>,
  right: ReturnType<typeof selectWorkspaceAgentConsumerSessions>
): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      item.session === other.session &&
      item.activeTurn === other.activeTurn &&
      item.latestTurn === other.latestTurn &&
      item.pendingInteractions === other.pendingInteractions &&
      item.displayStatus === other.displayStatus
    );
  });
}
