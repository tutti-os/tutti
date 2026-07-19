import type {
  AgentActivityMessagePage,
  AgentActivitySession,
  AgentActivitySnapshot,
  SessionReconcileResult
} from "@tutti-os/agent-activity-core";
import type { AgentActivityAdapter } from "@tutti-os/agent-activity-core";
import {
  hostMessageEventFromCore,
  reconcileAfterVersion,
  stringifyError
} from "./workspaceAgentActivityDiagnostics.ts";
import { reconcileAgentSessionMessagePages } from "./workspaceAgentActivityReconcileMessages.ts";
import type { AgentActivitySessionDetail } from "./workspaceAgentActivityReconcileTypes.ts";
import {
  sessionReconcileResultFromFound,
  sessionReconcileResultFromTransportError
} from "./workspaceAgentActivitySessionReconcileNormalizer.ts";

export interface WorkspaceAgentSessionReconcileCommandHost {
  activitySnapshot(workspaceId: string): AgentActivitySnapshot;
  emitLatestStateEvent(workspaceId: string, agentSessionId: string): void;
  emitSessionEvent(workspaceId: string, event: unknown): void;
  fetchActivitySessionDetail(
    workspaceId: string,
    agentSessionId: string,
    source: string
  ): Promise<AgentActivitySessionDetail>;
  isSessionTombstoned(workspaceId: string, agentSessionId: string): boolean;
  logTerminalDiagnostic(payload: {
    details?: Record<string, string | number | boolean | null>;
    event: string;
    level: "info" | "warn";
    workspaceId: string;
  }): void;
  markLiveReconcileSettled(workspaceId: string, agentSessionId: string): void;
  reportReconcileTrace(input: {
    agentSessionId: string | null;
    fields?: Record<string, unknown>;
    traceEvent: string;
    workspaceId: string;
  }): void;
  restoreLiveReconcileAfterFailure(
    workspaceId: string,
    agentSessionId: string
  ): void;
  sessionAdapter(workspaceId: string): AgentActivityAdapter;
  takeNextReconcileLive(workspaceId: string, agentSessionId: string): boolean;
}

export async function executeWorkspaceAgentSessionReconcileCommand(
  host: WorkspaceAgentSessionReconcileCommandHost,
  command: {
    agentSessionId: string;
    scope: "messages" | "state" | "state_and_messages";
    workspaceId: string;
  }
): Promise<SessionReconcileResult> {
  try {
    if (command.scope === "state_and_messages") {
      return await reconcileAgentSession(
        host,
        command.workspaceId,
        command.agentSessionId
      );
    }
    if (command.scope === "state") {
      return await reconcileAgentSessionState(
        host,
        command.workspaceId,
        command.agentSessionId
      );
    }
    return await reconcileAgentSessionMessages(
      host,
      command.workspaceId,
      command.agentSessionId
    );
  } catch (error: unknown) {
    host.restoreLiveReconcileAfterFailure(
      command.workspaceId,
      command.agentSessionId
    );
    const absent = sessionReconcileResultFromTransportError(error);
    if (absent) {
      host.logTerminalDiagnostic({
        details: {
          agentSessionId: command.agentSessionId,
          error: stringifyError(error),
          reconcileScope: command.scope
        },
        event: "agent.activity.reconcile_session_absent",
        level: "info",
        workspaceId: command.workspaceId
      });
      return absent;
    }
    host.logTerminalDiagnostic({
      details: { error: stringifyError(error) },
      event: "agent.activity.reconcile_failed",
      level: "warn",
      workspaceId: command.workspaceId
    });
    throw error;
  }
}

export async function reconcileAgentSessionMessages(
  host: WorkspaceAgentSessionReconcileCommandHost,
  workspaceId: string,
  agentSessionId: string
): Promise<SessionReconcileResult> {
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  const cachedSession =
    host
      .activitySnapshot(workspaceId)
      .sessions.find((session) => session.agentSessionId === agentSessionId) ??
    null;
  const messages =
    host.activitySnapshot(workspaceId).sessionMessagesById[agentSessionId];
  const afterVersion = reconcileAfterVersion(messages ?? []);
  host.reportReconcileTrace({
    agentSessionId,
    traceEvent: "reconcile.messages.requested",
    workspaceId,
    fields: { afterVersion }
  });
  const page = await reconcileAgentSessionMessagePages({
    adapter: host.sessionAdapter(workspaceId),
    agentSessionId,
    cached: messages ?? [],
    shouldAbort: () => host.isSessionTombstoned(workspaceId, agentSessionId),
    workspaceId
  });
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  host.reportReconcileTrace({
    agentSessionId,
    traceEvent: "reconcile.messages.resolved",
    workspaceId,
    fields: {
      afterVersion,
      latestVersion: page.latestVersion,
      messageCount: page.messages.length
    }
  });
  for (const message of page.messages) {
    host.emitSessionEvent(workspaceId, hostMessageEventFromCore(message));
  }
  const detail =
    cachedSession !== null
      ? {
          session: cachedSession,
          childSessions: [] as AgentActivitySession[],
          turns: cachedSession.latestTurn ? [cachedSession.latestTurn] : []
        }
      : await host.fetchActivitySessionDetail(
          workspaceId,
          agentSessionId,
          "reconcile.messages.session_fetch"
        );
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  return sessionReconcileResultFromFound({
    detail,
    messages: page.messages
  });
}

async function reconcileAgentSession(
  host: WorkspaceAgentSessionReconcileCommandHost,
  workspaceId: string,
  agentSessionId: string
): Promise<SessionReconcileResult> {
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  const live = host.takeNextReconcileLive(workspaceId, agentSessionId);
  const discoveryDetail = await host.fetchActivitySessionDetail(
    workspaceId,
    agentSessionId,
    "reconcile.combined.discovery_fetch"
  );
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  const reconcileMessages = async (
    sessions: AgentActivitySession[]
  ): Promise<AgentActivityMessagePage[]> =>
    Promise.all(
      sessions.map(async (session) => {
        const sessionId = session.agentSessionId;
        const cached =
          host.activitySnapshot(workspaceId).sessionMessagesById[sessionId];
        const afterVersion = reconcileAfterVersion(cached ?? []);
        host.reportReconcileTrace({
          agentSessionId: sessionId,
          traceEvent: "reconcile.combined.messages_requested",
          workspaceId,
          fields: { afterVersion, requestedSessionId: agentSessionId }
        });
        const page = await reconcileAgentSessionMessagePages({
          adapter: host.sessionAdapter(workspaceId),
          agentSessionId: sessionId,
          cached: cached ?? [],
          shouldAbort: () => host.isSessionTombstoned(workspaceId, sessionId),
          workspaceId
        });
        host.reportReconcileTrace({
          agentSessionId: sessionId,
          traceEvent: "reconcile.combined.messages_resolved",
          workspaceId,
          fields: {
            afterVersion,
            latestVersion: page.latestVersion,
            messageCount: page.messages.length,
            requestedSessionId: agentSessionId
          }
        });
        return page;
      })
    );
  const discoveredSessions = [
    discoveryDetail.session,
    ...discoveryDetail.childSessions
  ];
  const pages = await reconcileMessages(discoveredSessions);
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  const detail = await host.fetchActivitySessionDetail(
    workspaceId,
    agentSessionId,
    "reconcile.combined.state_fetch"
  );
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  const discoveredSessionIds = new Set(
    discoveredSessions.map((session) => session.agentSessionId)
  );
  const newlyDiscoveredSessions = detail.childSessions.filter(
    (session) => !discoveredSessionIds.has(session.agentSessionId)
  );
  pages.push(...(await reconcileMessages(newlyDiscoveredSessions)));
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  const reconciledMessages = pages.flatMap((page) => page.messages);
  for (const message of reconciledMessages) {
    host.emitSessionEvent(workspaceId, hostMessageEventFromCore(message));
  }
  host.emitLatestStateEvent(workspaceId, agentSessionId);
  if (live) {
    host.markLiveReconcileSettled(workspaceId, agentSessionId);
  }
  return sessionReconcileResultFromFound({
    detail,
    live,
    messages: reconciledMessages
  });
}

async function reconcileAgentSessionState(
  host: WorkspaceAgentSessionReconcileCommandHost,
  workspaceId: string,
  agentSessionId: string
): Promise<SessionReconcileResult> {
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  const live = host.takeNextReconcileLive(workspaceId, agentSessionId);
  const detail = await host.fetchActivitySessionDetail(
    workspaceId,
    agentSessionId,
    "reconcile.state_fetch"
  );
  if (host.isSessionTombstoned(workspaceId, agentSessionId)) {
    return { kind: "absent" };
  }
  host.emitLatestStateEvent(workspaceId, agentSessionId);
  if (live) {
    host.markLiveReconcileSettled(workspaceId, agentSessionId);
  }
  return sessionReconcileResultFromFound({ detail, live });
}
