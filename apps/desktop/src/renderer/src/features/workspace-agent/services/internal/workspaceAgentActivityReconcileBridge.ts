import {
  type AgentActivityMessagePage,
  type AgentActivitySession,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import {
  createAgentActivitySnapshotProjector,
  parseInlineActivityMessages,
  selectEngineSession
} from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityEnsureSessionSynchronizedInput } from "../workspaceAgentActivityService.interface.ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";
import {
  agentActivitySessionReconcileDiagnosticDetails,
  hostMessageEventFromCore,
  isWorkspaceAgentSessionNotFoundError,
  normalizeWorkspaceId,
  reconcileAfterVersion,
  stringifyError
} from "./workspaceAgentActivityDiagnostics.ts";
import {
  agentActivitySessionFromTuttidSession,
  agentActivityTurnFromTuttidTurn
} from "../desktopAgentActivityAdapter.ts";
import {
  analyzeInlineMessageVersionContinuity,
  reconcileAgentSessionMessagePages
} from "./workspaceAgentActivityReconcileMessages.ts";
import type {
  AgentActivitySessionDetail,
  WorkspaceAgentActivityBridgeEvent,
  WorkspaceAgentActivityReconcileDependencies
} from "./workspaceAgentActivityReconcileTypes.ts";
import { WorkspaceAgentComposerOptionsInvalidationCoordinator } from "./workspaceAgentComposerOptionsInvalidationCoordinator.ts";

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
  private readonly composerOptionsInvalidation =
    new WorkspaceAgentComposerOptionsInvalidationCoordinator(() =>
      this.entries.values()
    );
  private readonly latestStateEventBySessionKey = new Map<
    string,
    { data: unknown; eventType: "state_patch" }
  >();
  private readonly eventStreamDisposables: Array<() => void> = [];
  private disposed = false;
  private eventStreamStarted = false;
  private eventStreamConnectionState: "connected" | "disconnected" | null =
    null;

  protected constructor(
    dependencies: WorkspaceAgentActivityReconcileDependencies
  ) {
    this.reconcileDependencies = dependencies;
  }

  protected abstract createEntry(
    workspaceId: string
  ): WorkspaceAgentSessionEngineHost;

  protected entry(workspaceId: string): WorkspaceAgentSessionEngineHost {
    if (this.disposed) {
      throw new Error("Workspace agent activity service is disposed");
    }
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
    if (this.disposed) {
      return () => {};
    }
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

  readonly onModelCatalogInvalidated =
    this.composerOptionsInvalidation.onModelCatalogInvalidated.bind(
      this.composerOptionsInvalidation
    );
  readonly onComposerDefaultsInvalidated =
    this.composerOptionsInvalidation.onComposerDefaultsInvalidated.bind(
      this.composerOptionsInvalidation
    );

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.dispose();
    }
    this.entries.clear();
    for (const dispose of this.eventStreamDisposables.splice(0)) {
      dispose();
    }
    this.sessionEventListenersByWorkspaceId.clear();
    this.composerOptionsInvalidation.dispose();
    this.snapshotProjectors.clear();
    this.liveReconcileSessionKeys.clear();
    this.liveReconcileInFlightSessionKeys.clear();
    this.latestStateEventBySessionKey.clear();
  }

  protected async fetchActivitySessionDetail(
    workspaceId: string,
    agentSessionId: string,
    source: string
  ): Promise<AgentActivitySessionDetail> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: `${source}.requested`,
      workspaceId: normalizedWorkspaceId
    });
    const detail =
      await this.reconcileDependencies.tuttidClient.getWorkspaceAgentSession(
        normalizedWorkspaceId,
        agentSessionId
      );
    const activitySession = agentActivitySessionFromTuttidSession(
      normalizedWorkspaceId,
      detail.session
    );
    const childSessions = detail.childSessions.map((session) =>
      agentActivitySessionFromTuttidSession(normalizedWorkspaceId, session)
    );
    const turns = detail.turns.map(agentActivityTurnFromTuttidTurn);
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: `${source}.resolved`,
      workspaceId: normalizedWorkspaceId,
      fields: {
        incomingSession:
          agentActivitySessionReconcileDiagnosticDetails(activitySession),
        childSessionIds: childSessions.map((session) => session.agentSessionId)
      }
    });
    return { session: activitySession, childSessions, turns };
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

  protected upsertAuthoritativeSessionDetail(
    detail: AgentActivitySessionDetail,
    source: string,
    options: { live?: boolean } = {}
  ): void {
    this.upsertEngineSession({
      agentSessionId: detail.session.agentSessionId,
      live: options.live,
      session: detail.session,
      source,
      workspaceId: normalizeWorkspaceId(detail.session.workspaceId)
    });
    const entry = this.entry(detail.session.workspaceId);
    for (const turn of detail.turns) {
      entry.engine.dispatch({ type: "turn/upserted", turn });
    }
    for (const childSession of detail.childSessions) {
      this.upsertAuthoritativeSession(childSession, `${source}.child`);
    }
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

  private subscribeWorkspaceEventStream(workspaceId: string): void {
    const eventStreamClient = this.reconcileDependencies.eventStreamClient;
    if (!eventStreamClient) return;
    this.eventStreamDisposables.push(
      eventStreamClient.subscribe(
        "agent.activity.updated",
        (event) => {
          const payload = event.payload;
          if (payload.workspaceId.trim() !== workspaceId) return;
          this.scheduleAgentActivityUpdate(payload);
        },
        { scope: { workspaceId } }
      )
    );
  }

  private startEventStreamConnection(): void {
    const eventStreamClient = this.reconcileDependencies.eventStreamClient;
    if (!eventStreamClient || this.eventStreamStarted) return;
    this.eventStreamStarted = true;
    this.eventStreamDisposables.push(
      ...this.composerOptionsInvalidation.subscribe(eventStreamClient),
      eventStreamClient.subscribeConnectionState((state) => {
        if (state !== "connected" && state !== "disconnected") return;
        const recoveredFromDisconnect =
          this.eventStreamConnectionState === "disconnected" &&
          state === "connected";
        this.eventStreamConnectionState = state;
        for (const [workspaceId, entry] of this.entries) {
          entry.engine.dispatch({
            status: state,
            type: "engine/connectionChanged",
            workspaceId
          });
          if (recoveredFromDisconnect) {
            this.reconcileCachedSessionMessagesAfterReconnect(workspaceId);
          }
        }
      })
    );
    void eventStreamClient.connect().catch((error: unknown) => {
      void this.reconcileDependencies.runtimeApi.logTerminalDiagnostic({
        details: { error: stringifyError(error) },
        event: "agent.activity.event_stream.connect_failed",
        level: "warn"
      });
    });
  }

  private reconcileCachedSessionMessagesAfterReconnect(
    workspaceId: string
  ): void {
    const messagesBySessionId =
      this.activitySnapshot(workspaceId).sessionMessagesById;
    for (const [agentSessionId, messages] of Object.entries(
      messagesBySessionId
    )) {
      if (messages.length === 0) continue;
      this.entry(workspaceId).engine.dispatch({
        agentSessionId,
        needsMessages: true,
        needsState: false,
        type: "session/reconcileRequested",
        workspaceId
      });
    }
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
    const cachedMessages =
      this.activitySnapshot(workspaceId).sessionMessagesById[agentSessionId] ??
      [];
    const inlineContinuity = analyzeInlineMessageVersionContinuity(
      cachedMessages,
      messages
    );
    const canApplyInlineMessages =
      messages.length > 0 && inlineContinuity.continuous;
    if (canApplyInlineMessages) {
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
    } else if (messages.length > 0) {
      this.reportReconcileTrace({
        agentSessionId,
        traceEvent: "realtime.message_version_gap_detected",
        workspaceId,
        fields: { ...inlineContinuity }
      });
    }
    if (
      input.eventType === "turn_update" ||
      input.eventType === "interaction_update"
    ) {
      this.markNextReconcileLive(workspaceId, agentSessionId);
    }
    const inlineApplied = hasCachedSession && canApplyInlineMessages;
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
    const discoveryDetail = await this.fetchActivitySessionDetail(
      workspaceId,
      agentSessionId,
      "reconcile.combined.discovery_fetch"
    );
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    const reconcileMessages = async (
      sessions: AgentActivitySession[]
    ): Promise<AgentActivityMessagePage[]> =>
      Promise.all(
        sessions.map(async (session) => {
          const sessionId = session.agentSessionId;
          const cached =
            this.activitySnapshot(workspaceId).sessionMessagesById[sessionId];
          const afterVersion = reconcileAfterVersion(cached ?? []);
          this.reportReconcileTrace({
            agentSessionId: sessionId,
            traceEvent: "reconcile.combined.messages_requested",
            workspaceId,
            fields: { afterVersion, requestedSessionId: agentSessionId }
          });
          const page = await reconcileAgentSessionMessagePages({
            adapter: entry.adapter,
            agentSessionId: sessionId,
            cached: cached ?? [],
            shouldAbort: () => this.isSessionTombstoned(workspaceId, sessionId),
            workspaceId
          });
          this.reportReconcileTrace({
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
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    const detail = await this.fetchActivitySessionDetail(
      workspaceId,
      agentSessionId,
      "reconcile.combined.state_fetch"
    );
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    const discoveredSessionIds = new Set(
      discoveredSessions.map((session) => session.agentSessionId)
    );
    const newlyDiscoveredSessions = detail.childSessions.filter(
      (session) => !discoveredSessionIds.has(session.agentSessionId)
    );
    pages.push(...(await reconcileMessages(newlyDiscoveredSessions)));
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    this.upsertAuthoritativeSessionDetail(
      detail,
      "reconcile.combined.state_upsert",
      { live }
    );
    const reconciledMessages = pages.flatMap((page) => page.messages);
    for (const message of reconciledMessages) {
      this.emitSessionEvent(workspaceId, hostMessageEventFromCore(message));
    }
    entry.engine.dispatch({
      messages: reconciledMessages,
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
    const page = await reconcileAgentSessionMessagePages({
      adapter: entry.adapter,
      agentSessionId,
      cached: messages ?? [],
      shouldAbort: () => this.isSessionTombstoned(workspaceId, agentSessionId),
      workspaceId
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
    const detail = await this.fetchActivitySessionDetail(
      workspaceId,
      agentSessionId,
      "reconcile.state_fetch"
    );
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    this.upsertAuthoritativeSessionDetail(detail, "reconcile.state_upsert", {
      live
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
