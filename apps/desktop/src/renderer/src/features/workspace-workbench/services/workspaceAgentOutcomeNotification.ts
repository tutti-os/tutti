import {
  selectWorkspaceAgentConsumerSessions,
  type AgentActivityTurn,
  type CanonicalAgentSession,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { CompositeNotificationMessage } from "@renderer/lib/compositeNotificationService";
import type { DesktopI18nKey, I18nParams } from "@shared/i18n";
import type { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";

export interface WorkspaceAgentOutcomeNotificationController {
  dispose(): void;
}

export interface WorkspaceAgentOutcomeNotification {
  agentSessionId: string;
  conversationTitle: string;
  level: "error" | "success";
  provider: string;
  status: "completed" | "failed";
  workspaceId: string;
}

export interface WorkspaceAgentOutcomeForegroundNotification {
  agentName: string;
  agentSessionId: string;
  body: string;
  closeLabel: string;
  conversationTitle: string;
  level: "error" | "success";
  provider: string;
  statusLabel: string;
  workspaceId: string;
}

export interface WorkspaceAgentOutcomeForegroundNotificationPresenter {
  show(notification: WorkspaceAgentOutcomeForegroundNotification): void;
}

export interface WorkspaceAgentOutcomeNotificationControllerInput {
  foreground?: WorkspaceAgentOutcomeForegroundNotificationPresenter;
  notifications: Pick<NotificationService, "notify">;
  translate(key: DesktopI18nKey, params?: I18nParams): string;
  workspaceAgentActivityService: Pick<
    IWorkspaceAgentActivityService,
    "getSessionEngine" | "onSessionEvent"
  >;
  workspaceId: string;
}

export function createWorkspaceAgentOutcomeNotificationController(
  input: WorkspaceAgentOutcomeNotificationControllerInput
): WorkspaceAgentOutcomeNotificationController {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) return { dispose() {} };

  const engine =
    input.workspaceAgentActivityService.getSessionEngine(workspaceId);
  const settledTurns = new Set<string>();
  const liveSettledTurns = new Set<string>();
  let hasAuthoritativeBaseline =
    engine.getSnapshot().engineRuntime.workspaceReconcile.status === "ready";

  const inspectEngineState = (
    state: AgentSessionEngineState,
    notifyTransitions: boolean
  ) => {
    for (const item of selectWorkspaceAgentConsumerSessions(state)) {
      const turn = item.latestTurn;
      if (!turn) continue;
      const turnKey = sessionTurnKey(item.session.agentSessionId, turn.turnId);
      if (turn.phase !== "settled") continue;
      if (settledTurns.has(turnKey)) continue;
      if (!notifyTransitions) {
        settledTurns.add(turnKey);
        continue;
      }
      if (!liveSettledTurns.has(turnKey)) continue;
      settledTurns.add(turnKey);
      liveSettledTurns.delete(turnKey);
      const notification =
        buildWorkspaceAgentOutcomeNotificationFromSettledTurn({
          session: item.session,
          turn
        });
      if (!notification) continue;
      input.foreground?.show(
        workspaceAgentOutcomeForegroundNotification(
          notification,
          input.translate
        )
      );
      input.notifications.notify(
        workspaceAgentOutcomeNotificationMessage(notification, input.translate)
      );
    }
  };

  // A newly-created workspace engine starts empty and hydrates asynchronously.
  // Do not treat that empty pre-reconcile state as the history boundary: the
  // first authoritative snapshot can contain many previously settled turns.
  // Seed them into the baseline only after the initial reconcile completes.
  inspectEngineState(engine.getSnapshot(), false);
  const unsubscribeEngine = engine.subscribe((state) => {
    if (!hasAuthoritativeBaseline) {
      if (state.engineRuntime.workspaceReconcile.status !== "ready") return;
      inspectEngineState(state, false);
      hasAuthoritativeBaseline = true;
      return;
    }
    inspectEngineState(state, true);
  });
  const unsubscribeSessionEvents =
    input.workspaceAgentActivityService.onSessionEvent(workspaceId, (event) => {
      const turnKey = liveSettledTurnKeyFromEvent(event);
      if (!turnKey || !hasAuthoritativeBaseline) return;
      liveSettledTurns.add(turnKey);
      inspectEngineState(engine.getSnapshot(), true);
    });
  return {
    dispose() {
      unsubscribeEngine();
      unsubscribeSessionEvents();
    }
  };
}

function liveSettledTurnKeyFromEvent(event: unknown): string | null {
  const source = recordValue(event);
  if (stringValue(source?.eventType) !== "turn_update") return null;
  const data = recordValue(source?.data);
  const turn = recordValue(data?.turn) ?? data;
  if (!data || !turn || stringValue(turn.phase) !== "settled") return null;
  if (!outcomeStatusFromTurnOutcome(stringValue(turn.outcome))) return null;
  const agentSessionId =
    stringValue(turn.agentSessionId) || stringValue(data.agentSessionId);
  const turnId = stringValue(turn.turnId);
  return agentSessionId && turnId
    ? sessionTurnKey(agentSessionId, turnId)
    : null;
}
export function buildWorkspaceAgentOutcomeNotificationFromSettledTurn(input: {
  conversationTitle?: string;
  session: CanonicalAgentSession;
  turn: AgentActivityTurn;
}): WorkspaceAgentOutcomeNotification | null {
  if (input.turn.phase !== "settled" || !input.turn.turnId.trim()) return null;
  const status = outcomeStatusFromTurnOutcome(input.turn.outcome ?? "");
  const workspaceId = input.session.workspaceId.trim();
  const agentSessionId = input.session.agentSessionId.trim();
  const provider = input.session.provider.trim();
  if (!status || !workspaceId || !agentSessionId || !provider) return null;
  return {
    agentSessionId,
    conversationTitle:
      stringValue(input.conversationTitle) || input.session.title,
    level: status === "completed" ? "success" : "error",
    provider,
    status,
    workspaceId
  };
}

function workspaceAgentOutcomeNotificationMessage(
  notification: WorkspaceAgentOutcomeNotification,
  translate: WorkspaceAgentOutcomeNotificationControllerInput["translate"]
): CompositeNotificationMessage {
  const titleFallback =
    notification.conversationTitle ||
    formatWorkspaceAgentProviderName(notification.provider);
  return {
    description: translate(
      notification.status === "completed"
        ? "workspace.agentMessageCenter.outcomeNotificationCompletedBody"
        : "workspace.agentMessageCenter.outcomeNotificationFailedBody"
    ),
    level: notification.level,
    navigation: {
      agentSessionId: notification.agentSessionId,
      provider: notification.provider,
      workspaceId: notification.workspaceId
    },
    presentation: "background-only",
    title: translate(
      notification.status === "completed"
        ? "workspace.agentMessageCenter.outcomeNotificationCompletedTitle"
        : "workspace.agentMessageCenter.outcomeNotificationFailedTitle",
      {
        title:
          titleFallback || translate("workspace.agentGui.fallbackAgentLabel")
      }
    )
  };
}

function workspaceAgentOutcomeForegroundNotification(
  notification: WorkspaceAgentOutcomeNotification,
  translate: WorkspaceAgentOutcomeNotificationControllerInput["translate"]
): WorkspaceAgentOutcomeForegroundNotification {
  const agentName =
    formatWorkspaceAgentProviderName(notification.provider) ||
    translate("workspace.agentGui.fallbackAgentLabel");
  return {
    agentName,
    agentSessionId: notification.agentSessionId,
    body: translate(
      notification.status === "completed"
        ? "workspace.agentMessageCenter.outcomeNotificationCompletedBody"
        : "workspace.agentMessageCenter.outcomeNotificationFailedBody"
    ),
    closeLabel: translate("common.close"),
    conversationTitle: notification.conversationTitle,
    level: notification.level,
    provider: notification.provider,
    statusLabel: translate(
      notification.status === "completed"
        ? "workspace.agentMessageCenter.outcomeNotificationCompletedStatus"
        : "workspace.agentMessageCenter.outcomeNotificationFailedStatus"
    ),
    workspaceId: notification.workspaceId
  };
}

function outcomeStatusFromTurnOutcome(
  outcome: string
): WorkspaceAgentOutcomeNotification["status"] | null {
  switch (outcome.trim().toLowerCase()) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function formatWorkspaceAgentProviderName(provider: string): string {
  return provider
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sessionTurnKey(agentSessionId: string, turnId: string): string {
  return `${agentSessionId}\n${turnId}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
