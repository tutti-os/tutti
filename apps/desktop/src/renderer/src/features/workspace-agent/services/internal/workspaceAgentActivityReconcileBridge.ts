import type {
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivityUpdatedEvent
} from "@tutti-os/agent-activity-core";
import {
  createAgentActivitySnapshotProjector,
  parseInlineActivityMessages,
  selectEngineSession
} from "@tutti-os/agent-activity-core";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import type {
  WorkspaceAgentActivityEnsureSessionSynchronizedInput,
  WorkspaceAgentModelCatalogInvalidatedEvent
} from "../workspaceAgentActivityService.interface.ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";
import {
  agentActivitySessionReconcileDiagnosticDetails,
  hostMessageEventFromCore,
  isWorkspaceAgentSessionNotFoundError,
  normalizeWorkspaceId,
  reconcileAfterVersion,
  stringifyError
} from "./workspaceAgentActivityDiagnostics.ts";
import { agentActivitySessionFromTuttidSession } from "../desktopAgentActivityAdapter.ts";

interface WorkspaceAgentActivityReconcileDependencies {
  eventStreamClient?: TuttidEventStreamClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  tuttidClient: TuttidClient;
}

type WorkspaceAgentActivityBridgeEvent =
  | AgentActivityUpdatedEvent
  | {
      agentSessionId: string;
      data: unknown;
      eventType: "state_patch";
      workspaceId: string;
    };

export abstract class WorkspaceAgentActivityReconcileBridge {
  private readonly reconcileDependencies: WorkspaceAgentActivityReconcileDependencies;
  private readonly entries = new Map<string, WorkspaceAgentSessionEngineHost>();
  private readonly entryCreationInProgress = new Set<string>();
  private readonly snapshotProjectors = new Map<
    string,
    ReturnType<typeof createAgentActivitySnapshotProjector>
  >();
  private readonly liveReconcileSessionKeys = new Set<string>();
  private readonly liveReconcileInFlightSessionKeys = new Set<string>();
  private readonly sessionEventListenersByWorkspaceId = new Map<
    string,
    Set<(event: unknown) => void>
  >();
  private readonly modelCatalogInvalidatedListeners = new Set<
    (event: WorkspaceAgentModelCatalogInvalidatedEvent) => void
  >();
  private readonly latestStateEventBySessionKey = new Map<
    string,
    { data: unknown; eventType: "state_patch" }
  >();
  private eventStreamStarted = false;

  protected constructor(
    dependencies: WorkspaceAgentActivityReconcileDependencies
  ) {
    this.reconcileDependencies = dependencies;
  }

  protected abstract createEntry(
    workspaceId: string
  ): WorkspaceAgentSessionEngineHost;

  protected entry(workspaceId: string): WorkspaceAgentSessionEngineHost {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.entries.get(normalizedWorkspaceId);
    if (existing) return existing;
    this.entryCreationInProgress.add(normalizedWorkspaceId);
    try {
      const entry = this.createEntry(normalizedWorkspaceId);
      this.entries.set(normalizedWorkspaceId, entry);
      this.subscribeWorkspaceEventStream(normalizedWorkspaceId);
      this.startEventStreamConnection();
      entry.engine.dispatch({
        type: "workspace/reconcileRequested",
        workspaceId: normalizedWorkspaceId
      });
      return entry;
    } finally {
      this.entryCreationInProgress.delete(normalizedWorkspaceId);
    }
  }

  protected activitySnapshot(workspaceId: string): AgentActivitySnapshot {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    let projector = this.snapshotProjectors.get(normalizedWorkspaceId);
    if (!projector) {
      projector = createAgentActivitySnapshotProjector(normalizedWorkspaceId);
      this.snapshotProjectors.set(normalizedWorkspaceId, projector);
    }
    return projector(this.entry(normalizedWorkspaceId).engine.getSnapshot());
  }

  ensureSessionSynchronized(
    input: WorkspaceAgentActivityEnsureSessionSynchronizedInput
  ): () => void {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (agentSessionId) {
      this.entry(workspaceId).engine.dispatch({
        agentSessionId,
        needsMessages: true,
        needsState: true,
        type: "session/reconcileRequested",
        workspaceId
      });
    }
    return () => {};
  }

  onSessionEvent(
    workspaceId: string,
    listener: (event: unknown) => void
  ): () => void {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    let listeners = this.sessionEventListenersByWorkspaceId.get(
      normalizedWorkspaceId
    );
    if (!listeners) {
      listeners = new Set();
      this.sessionEventListenersByWorkspaceId.set(
        normalizedWorkspaceId,
        listeners
      );
    }
    listeners.add(listener);
    if (
      !this.entries.has(normalizedWorkspaceId) &&
      !this.entryCreationInProgress.has(normalizedWorkspaceId)
    ) {
      this.entry(normalizedWorkspaceId);
    }
    return () => listeners?.delete(listener);
  }

  onModelCatalogInvalidated(
    listener: (event: WorkspaceAgentModelCatalogInvalidatedEvent) => void
  ): () => void {
    this.modelCatalogInvalidatedListeners.add(listener);
    return () => this.modelCatalogInvalidatedListeners.delete(listener);
  }

  protected async fetchActivitySession(
    workspaceId: string,
    agentSessionId: string,
    source: string
  ): Promise<AgentActivitySession> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: `${source}.requested`,
      workspaceId: normalizedWorkspaceId
    });
    const session =
      await this.reconcileDependencies.tuttidClient.getWorkspaceAgentSession(
        normalizedWorkspaceId,
        agentSessionId
      );
    const activitySession = agentActivitySessionFromTuttidSession(
      normalizedWorkspaceId,
      session
    );
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: `${source}.resolved`,
      workspaceId: normalizedWorkspaceId,
      fields: {
        incomingSession:
          agentActivitySessionReconcileDiagnosticDetails(activitySession)
      }
    });
    return activitySession;
  }

  protected upsertAuthoritativeSession(
    session: AgentActivitySession,
    source: string
  ): void {
    this.upsertEngineSession({
      agentSessionId: session.agentSessionId,
      session,
      source,
      workspaceId: normalizeWorkspaceId(session.workspaceId)
    });
  }

  protected reportReconcileTrace(input: {
    agentSessionId: string | null;
    traceEvent: string;
    workspaceId: string;
    fields?: Record<string, unknown>;
  }): void {
    try {
      void this.reconcileDependencies.runtimeApi
        .logTerminalDiagnostic({
          details: {
            agentSessionId: input.agentSessionId,
            traceEvent: input.traceEvent,
            ...(input.fields ?? {})
          },
          event: "agent.activity.reconcile.trace",
          level: "info",
          workspaceId: input.workspaceId
        })
        .catch((error: unknown) => {
          console.error(
            "[workspace-agent-reconcile-diagnostic]",
            JSON.stringify({
              error: stringifyError(error),
              traceEvent: input.traceEvent,
              workspaceId: input.workspaceId
            })
          );
        });
    } catch (error: unknown) {
      console.error(
        "[workspace-agent-reconcile-diagnostic]",
        JSON.stringify({
          error: stringifyError(error),
          traceEvent: input.traceEvent,
          workspaceId: input.workspaceId
        })
      );
    }
  }

  protected markSessionDeleted(input: {
    agentSessionId: string;
    data?: unknown;
    workspaceId: string;
  }): void {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) return;
    const entry = this.entry(workspaceId);
    entry.engine.dispatch({ agentSessionId, type: "session/removed" });
    this.liveReconcileSessionKeys.delete(
      this.sessionKey(workspaceId, agentSessionId)
    );
    this.liveReconcileInFlightSessionKeys.delete(
      this.sessionKey(workspaceId, agentSessionId)
    );
  }

  protected isSessionTombstoned(
    workspaceId: string,
    agentSessionId: string
  ): boolean {
    const entry = this.entries.get(normalizeWorkspaceId(workspaceId));
    return Boolean(
      entry?.engine.getSnapshot().sessionLifecycle.deletedSessionIds[
        agentSessionId.trim()
      ]
    );
  }

  protected executeSessionReconcileCommand(command: {
    agentSessionId: string;
    scope: "messages" | "state" | "state_and_messages";
    workspaceId: string;
  }): Promise<void> {
    return this.executeSessionReconcileCommandSafely(command);
  }

  private upsertEngineSession(input: {
    agentSessionId: string;
    live?: boolean;
    session: AgentActivitySession;
    source: string;
    workspaceId: string;
  }): void {
    const entry = this.entry(input.workspaceId);
    const beforeSession =
      this.activitySnapshot(input.workspaceId).sessions.find(
        (session) => session.agentSessionId === input.agentSessionId
      ) ?? null;
    this.reportReconcileTrace({
      agentSessionId: input.agentSessionId,
      traceEvent: input.source,
      workspaceId: input.workspaceId,
      fields: {
        beforeSession:
          agentActivitySessionReconcileDiagnosticDetails(beforeSession),
        incomingSession: agentActivitySessionReconcileDiagnosticDetails(
          input.session
        )
      }
    });
    entry.engine.dispatch({
      session: input.session,
      type: "session/upserted"
    });
    if (input.live && input.session.latestTurn) {
      // Session identity must exist before attention observes the live turn so
      // its user partition can be resolved. session/upserted itself is neutral
      // to provenance and cannot consume the completion marker.
      entry.engine.dispatch({
        turn: input.session.latestTurn,
        type: "turn/upserted"
      });
    }
    const afterSession =
      this.activitySnapshot(input.workspaceId).sessions.find(
        (session) => session.agentSessionId === input.agentSessionId
      ) ?? null;
    this.reportReconcileTrace({
      agentSessionId: input.agentSessionId,
      traceEvent: `${input.source}.applied`,
      workspaceId: input.workspaceId,
      fields: {
        afterSession:
          agentActivitySessionReconcileDiagnosticDetails(afterSession)
      }
    });
    if (input.live) {
      this.liveReconcileInFlightSessionKeys.delete(
        this.sessionKey(input.workspaceId, input.agentSessionId)
      );
    }
  }

  private emitSessionEvent(workspaceId: string, event: unknown): void {
    const listeners = this.sessionEventListenersByWorkspaceId.get(workspaceId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  }

  private handleModelCatalogInvalidated(
    event: WorkspaceAgentModelCatalogInvalidatedEvent
  ): void {
    for (const entry of this.entries.values()) {
      entry.engine.dispatch({
        providers: event.providers,
        type: "composerOptions/invalidated"
      });
    }
    for (const listener of this.modelCatalogInvalidatedListeners) {
      listener({
        providers: [...event.providers],
        occurredAtUnixMs: event.occurredAtUnixMs
      });
    }
  }

  private subscribeWorkspaceEventStream(workspaceId: string): void {
    const eventStreamClient = this.reconcileDependencies.eventStreamClient;
    if (!eventStreamClient) return;
    eventStreamClient.subscribe(
      "agent.activity.updated",
      (event) => {
        const payload = event.payload;
        if (payload.workspaceId.trim() !== workspaceId) return;
        this.scheduleAgentActivityUpdate(payload);
      },
      { scope: { workspaceId } }
    );
  }

  private startEventStreamConnection(): void {
    const eventStreamClient = this.reconcileDependencies.eventStreamClient;
    if (!eventStreamClient || this.eventStreamStarted) return;
    this.eventStreamStarted = true;
    eventStreamClient.subscribe("agent.model.catalog.invalidated", (event) => {
      this.handleModelCatalogInvalidated({
        providers: [...event.payload.providers],
        occurredAtUnixMs: event.payload.occurredAtUnixMs
      });
    });
    eventStreamClient.subscribeConnectionState((state) => {
      if (state !== "connected" && state !== "disconnected") return;
      for (const [workspaceId, entry] of this.entries) {
        entry.engine.dispatch({
          status: state,
          type: "engine/connectionChanged",
          workspaceId
        });
      }
    });
    void eventStreamClient.connect().catch((error: unknown) => {
      void this.reconcileDependencies.runtimeApi.logTerminalDiagnostic({
        details: { error: stringifyError(error) },
        event: "agent.activity.event_stream.connect_failed",
        level: "warn"
      });
    });
  }

  private async reconcileAgentActivityUpdate(
    input: WorkspaceAgentActivityBridgeEvent
  ): Promise<void> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) return;
    if (input.eventType === "session_deleted") {
      this.markSessionDeleted({
        agentSessionId,
        data: input.data,
        workspaceId
      });
      this.emitSessionEvent(workspaceId, {
        data: input.data,
        eventType: input.eventType
      });
      return;
    }
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) return;
    if (input.eventType === "session_reconcile_required") {
      this.entry(workspaceId).engine.dispatch({
        agentSessionId,
        eventType: input.eventType,
        hasCachedSession: this.hasCachedSession(workspaceId, agentSessionId),
        hasInlineMessages: false,
        inlineApplied: false,
        type: "session/activityObserved",
        workspaceId
      });
      return;
    }
    if (input.eventType === "state_patch") {
      this.markNextReconcileLive(workspaceId, agentSessionId);
      this.latestStateEventBySessionKey.set(
        this.stateEventKey(workspaceId, agentSessionId),
        { data: input.data, eventType: "state_patch" }
      );
      this.entry(workspaceId).engine.dispatch({
        agentSessionId,
        needsMessages: false,
        needsState: true,
        type: "session/reconcileRequested",
        workspaceId
      });
      return;
    }
    const hasCachedSession = this.hasCachedSession(workspaceId, agentSessionId);
    const messages = parseInlineActivityMessages(input);
    if (messages.length > 0) {
      this.entry(workspaceId).engine.dispatch(
        {
          messages,
          type: "message/snapshotReceived",
          workspaceId
        },
        { batch: true }
      );
      for (const message of messages) {
        this.emitSessionEvent(workspaceId, hostMessageEventFromCore(message));
      }
    }
    if (
      input.eventType === "turn_update" ||
      input.eventType === "interaction_update"
    ) {
      this.markNextReconcileLive(workspaceId, agentSessionId);
    }
    const inlineApplied = hasCachedSession && messages.length > 0;
    this.entry(workspaceId).engine.dispatch({
      agentSessionId,
      eventType: input.eventType,
      hasCachedSession,
      hasInlineMessages: messages.length > 0,
      inlineApplied,
      type: "session/activityObserved",
      workspaceId
    });
    if (input.eventType === "turn_update") {
      this.emitSessionEvent(workspaceId, {
        data: input.data,
        eventType: input.eventType
      });
    }
  }

  private scheduleAgentActivityUpdate(
    input: WorkspaceAgentActivityBridgeEvent
  ): void {
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) return;
    void this.reconcileAgentActivityUpdate(input);
  }

  private hasCachedSession(
    workspaceId: string,
    agentSessionId: string
  ): boolean {
    return Boolean(
      selectEngineSession(
        this.entry(workspaceId).engine.getSnapshot(),
        agentSessionId
      )
    );
  }

  private async reconcileAgentSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<void> {
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) return;
    const entry = this.entry(workspaceId);
    const live = this.consumeNextReconcileLive(workspaceId, agentSessionId);
    const messages =
      this.activitySnapshot(workspaceId).sessionMessagesById[agentSessionId];
    const afterVersion = reconcileAfterVersion(messages ?? []);
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: "reconcile.combined.messages_requested",
      workspaceId,
      fields: { afterVersion }
    });
    const page = await entry.adapter.listSessionMessages({
      workspaceId,
      agentSessionId,
      afterVersion
    });
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: "reconcile.combined.messages_resolved",
      workspaceId,
      fields: {
        afterVersion,
        latestVersion: page.latestVersion,
        messageCount: page.messages.length
      }
    });
    for (const message of page.messages) {
      this.emitSessionEvent(workspaceId, hostMessageEventFromCore(message));
    }
    const session = await this.fetchActivitySession(
      workspaceId,
      agentSessionId,
      "reconcile.combined.state_fetch"
    );
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    this.upsertEngineSession({
      agentSessionId,
      live,
      session,
      source: "reconcile.combined.state_upsert",
      workspaceId
    });
    entry.engine.dispatch({
      messages: page.messages,
      type: "message/snapshotReceived",
      workspaceId
    });
    this.emitLatestStateEvent(workspaceId, agentSessionId);
  }

  private async executeSessionReconcileCommandSafely(command: {
    agentSessionId: string;
    scope: "messages" | "state" | "state_and_messages";
    workspaceId: string;
  }): Promise<void> {
    try {
      if (command.scope === "state_and_messages") {
        await this.reconcileAgentSession(
          command.workspaceId,
          command.agentSessionId
        );
      } else if (command.scope === "state") {
        await this.reconcileAgentSessionState(
          command.workspaceId,
          command.agentSessionId
        );
      } else {
        await this.reconcileAgentSessionMessages(
          command.workspaceId,
          command.agentSessionId
        );
      }
    } catch (error: unknown) {
      this.restoreLiveReconcileAfterFailure(
        command.workspaceId,
        command.agentSessionId
      );
      if (isWorkspaceAgentSessionNotFoundError(error)) {
        this.markSessionDeleted({
          agentSessionId: command.agentSessionId,
          data: { reason: "workspace_agent_session_not_found" },
          workspaceId: command.workspaceId
        });
        void this.reconcileDependencies.runtimeApi.logTerminalDiagnostic({
          details: {
            agentSessionId: command.agentSessionId,
            error: stringifyError(error)
          },
          event: "agent.activity.reconcile_session_missing",
          level: "info",
          workspaceId: command.workspaceId
        });
        return;
      }
      void this.reconcileDependencies.runtimeApi.logTerminalDiagnostic({
        details: { error: stringifyError(error) },
        event: "agent.activity.reconcile_failed",
        level: "warn",
        workspaceId: command.workspaceId
      });
      throw error;
    }
  }

  private async reconcileAgentSessionMessages(
    workspaceId: string,
    agentSessionId: string
  ): Promise<void> {
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) return;
    const entry = this.entry(workspaceId);
    const messages =
      this.activitySnapshot(workspaceId).sessionMessagesById[agentSessionId];
    const afterVersion = reconcileAfterVersion(messages ?? []);
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: "reconcile.messages.requested",
      workspaceId,
      fields: { afterVersion }
    });
    const page = await entry.adapter.listSessionMessages({
      workspaceId,
      agentSessionId,
      afterVersion
    });
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    this.reportReconcileTrace({
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
      this.emitSessionEvent(workspaceId, hostMessageEventFromCore(message));
    }
    entry.engine.dispatch({
      messages: page.messages,
      type: "message/snapshotReceived",
      workspaceId
    });
  }

  private async reconcileAgentSessionState(
    workspaceId: string,
    agentSessionId: string
  ): Promise<void> {
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) return;
    const live = this.consumeNextReconcileLive(workspaceId, agentSessionId);
    const session = await this.fetchActivitySession(
      workspaceId,
      agentSessionId,
      "reconcile.state_fetch"
    );
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    this.upsertEngineSession({
      agentSessionId,
      live,
      session,
      source: "reconcile.state_upsert",
      workspaceId
    });
    this.emitLatestStateEvent(workspaceId, agentSessionId);
  }

  private stateEventKey(workspaceId: string, agentSessionId: string): string {
    return `${normalizeWorkspaceId(workspaceId)}:${agentSessionId.trim()}`;
  }

  private emitLatestStateEvent(
    workspaceId: string,
    agentSessionId: string
  ): void {
    const key = this.stateEventKey(workspaceId, agentSessionId);
    const event = this.latestStateEventBySessionKey.get(key);
    if (!event) return;
    this.latestStateEventBySessionKey.delete(key);
    this.emitSessionEvent(normalizeWorkspaceId(workspaceId), event);
  }

  private sessionKey(workspaceId: string, agentSessionId: string): string {
    return `${normalizeWorkspaceId(workspaceId)}:${agentSessionId.trim()}`;
  }

  private markNextReconcileLive(
    workspaceId: string,
    agentSessionId: string
  ): void {
    this.liveReconcileSessionKeys.add(
      this.sessionKey(workspaceId, agentSessionId)
    );
  }

  private consumeNextReconcileLive(
    workspaceId: string,
    agentSessionId: string
  ): boolean {
    const key = this.sessionKey(workspaceId, agentSessionId);
    const live = this.liveReconcileSessionKeys.has(key);
    if (live) {
      this.liveReconcileSessionKeys.delete(key);
      this.liveReconcileInFlightSessionKeys.add(key);
    }
    return live;
  }

  private restoreLiveReconcileAfterFailure(
    workspaceId: string,
    agentSessionId: string
  ): void {
    const key = this.sessionKey(workspaceId, agentSessionId);
    if (!this.liveReconcileInFlightSessionKeys.delete(key)) return;
    if (!this.isSessionTombstoned(workspaceId, agentSessionId)) {
      this.liveReconcileSessionKeys.add(key);
    }
  }
}
