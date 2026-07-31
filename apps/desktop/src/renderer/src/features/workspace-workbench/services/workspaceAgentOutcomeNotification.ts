import {
  selectWorkspaceAgentConsumerSessions,
  type AgentActivityTurn,
  type CanonicalAgentSession,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { CompositeNotificationMessage } from "@renderer/lib/compositeNotificationService";
import type { DesktopI18nKey, I18nParams } from "@shared/i18n";
import type {
  AgentsService,
  IWorkspaceAgentActivityService
} from "@renderer/features/workspace-agent";

export interface WorkspaceAgentOutcomeNotificationController {
  dispose(): void;
}

export interface WorkspaceAgentOutcomeNotification {
  agentTargetId: string | null;
  agentSessionId: string;
  conversationTitle: string;
  level: "error" | "success";
  provider: string;
  status: "completed" | "failed";
  turnId: string;
  workspaceId: string;
}

export interface WorkspaceAgentOutcomeForegroundNotification {
  agentIconUrl: string | null;
  agentName: string;
  agentSessionId: string;
  body: string;
  closeLabel: string;
  conversationTitle: string;
  level: "error" | "success";
  provider: string;
  statusLabel: string;
  turnId: string;
  workspaceId: string;
}

export interface WorkspaceAgentOutcomeForegroundNotificationPresenter {
  show(notification: WorkspaceAgentOutcomeForegroundNotification): void;
}

export interface WorkspaceAgentOutcomeNotificationControllerInput {
  agentDirectory: Pick<AgentsService, "getAgentPresentation"> & {
    load(signal?: AbortSignal): Promise<unknown>;
  };
  foreground?: WorkspaceAgentOutcomeForegroundNotificationPresenter;
  notifications: Pick<NotificationService, "notify">;
  translate(key: DesktopI18nKey, params?: I18nParams): string;
  onNotificationEmitted?(notification: WorkspaceAgentOutcomeNotification): void;
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
  const pendingNotifications: WorkspaceAgentOutcomeNotification[] = [];
  let disposed = false;
  let agentDirectoryLoadSettled = false;
  let hasAuthoritativeBaseline =
    engine.getSnapshot().engineRuntime.workspaceReconcile.status === "ready";

  const emitNotification = (
    notification: WorkspaceAgentOutcomeNotification
  ) => {
    if (disposed) return;
    const agentPresentation = workspaceAgentOutcomePresentation(
      notification,
      input.agentDirectory,
      input.translate
    );
    input.onNotificationEmitted?.(notification);
    input.foreground?.show(
      workspaceAgentOutcomeForegroundNotification(
        notification,
        agentPresentation,
        input.translate
      )
    );
    input.notifications.notify(
      workspaceAgentOutcomeNotificationMessage(
        notification,
        agentPresentation,
        input.translate
      )
    );
  };
  const settleAgentDirectoryLoad = () => {
    if (agentDirectoryLoadSettled) return;
    agentDirectoryLoadSettled = true;
    const notifications = pendingNotifications.splice(0);
    for (const notification of notifications) {
      emitNotification(notification);
    }
  };
  void input.agentDirectory
    .load()
    .then(settleAgentDirectoryLoad, settleAgentDirectoryLoad);

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
      if (agentDirectoryLoadSettled) {
        emitNotification(notification);
      } else {
        pendingNotifications.push(notification);
      }
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
      disposed = true;
      pendingNotifications.length = 0;
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
    agentTargetId: input.session.agentTargetId?.trim() || null,
    agentSessionId,
    conversationTitle: input.session.title,
    level: status === "completed" ? "success" : "error",
    provider,
    status,
    turnId: input.turn.turnId,
    workspaceId
  };
}

function workspaceAgentOutcomeNotificationMessage(
  notification: WorkspaceAgentOutcomeNotification,
  agentPresentation: WorkspaceAgentOutcomeAgentPresentation,
  translate: WorkspaceAgentOutcomeNotificationControllerInput["translate"]
): CompositeNotificationMessage {
  const titleFallback =
    notification.conversationTitle || agentPresentation.agentName;
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
  agentPresentation: WorkspaceAgentOutcomeAgentPresentation,
  translate: WorkspaceAgentOutcomeNotificationControllerInput["translate"]
): WorkspaceAgentOutcomeForegroundNotification {
  return {
    agentIconUrl: agentPresentation.agentIconUrl,
    agentName: agentPresentation.agentName,
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
    turnId: notification.turnId,
    workspaceId: notification.workspaceId
  };
}

interface WorkspaceAgentOutcomeAgentPresentation {
  agentIconUrl: string | null;
  agentName: string;
}

function workspaceAgentOutcomePresentation(
  notification: WorkspaceAgentOutcomeNotification,
  agentDirectory: WorkspaceAgentOutcomeNotificationControllerInput["agentDirectory"],
  translate: WorkspaceAgentOutcomeNotificationControllerInput["translate"]
): WorkspaceAgentOutcomeAgentPresentation {
  const target = notification.agentTargetId
    ? agentDirectory.getAgentPresentation({
        agentTargetId: notification.agentTargetId
      })
    : null;
  return {
    agentIconUrl: target?.iconUrl.trim() || null,
    agentName:
      target?.name.trim() || translate("workspace.agentGui.fallbackAgentLabel")
  };
}

export function workspaceAgentOutcomeNotificationKey(
  notification: Pick<
    WorkspaceAgentOutcomeNotification,
    "agentSessionId" | "turnId" | "workspaceId"
  >
): string {
  return [
    "workspace-agent-outcome",
    notification.workspaceId,
    notification.agentSessionId,
    notification.turnId
  ].join(":");
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
