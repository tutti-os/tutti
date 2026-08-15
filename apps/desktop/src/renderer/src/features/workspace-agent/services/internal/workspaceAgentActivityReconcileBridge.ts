import {
  type AgentActivitySession,
  type AgentActivitySnapshot,
  type AgentActivitySessionDetailSnapshot,
  type AgentActivitySessionReconcileExecutor,
  type SessionReconcileCommand,
  type SessionDetailSnapshotReceivedIntent
} from "@tutti-os/agent-activity-core";
import {
  createAgentActivitySnapshotProjector,
  createAgentActivitySessionReconcileExecutor,
  createAgentActivityWorkspaceEventCoordinator,
  selectEngineSession,
  selectLatestActivationForSession
} from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityEnsureSessionSynchronizedInput } from "../workspaceAgentActivityService.interface.ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";
import {
  agentActivitySessionReconcileDiagnosticDetails,
  hostMessageEventFromCore,
  isWorkspaceAgentSessionNotFoundError,
  normalizeWorkspaceId,
  stringifyError
} from "./workspaceAgentActivityDiagnostics.ts";
import { agentActivitySessionDetailFromTuttid } from "../desktopAgentActivityAdapter.ts";
import type {
  WorkspaceAgentActivityBridgeEvent,
  WorkspaceAgentActivityReconcileDependencies
} from "./workspaceAgentActivityReconcileTypes.ts";
import { WorkspaceAgentComposerOptionsInvalidationCoordinator } from "./workspaceAgentComposerOptionsInvalidationCoordinator.ts";
import { editRetryAvailabilityFromTuttid } from "./workspaceAgentEditRetry.ts";

export abstract class WorkspaceAgentActivityReconcileBridge {
  private readonly reconcileDependencies: WorkspaceAgentActivityReconcileDependencies;
  private readonly entries = new Map<string, WorkspaceAgentSessionEngineHost>();
  private readonly entryCreationInProgress = new Set<string>();
  private readonly snapshotProjectors = new Map<
    string,
    ReturnType<typeof createAgentActivitySnapshotProjector>
  >();
  private readonly eventCoordinators = new Map<
    string,
    ReturnType<typeof createAgentActivityWorkspaceEventCoordinator>
  >();
  private readonly sessionReconcileExecutors = new Map<
    string,
    AgentActivitySessionReconcileExecutor
  >();
  private readonly sessionEventListenersByWorkspaceId = new Map<
    string,
    Set<(event: unknown) => void>
  >();
  private readonly composerOptionsInvalidation =
    new WorkspaceAgentComposerOptionsInvalidationCoordinator(() =>
      this.entries.values()
    );
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
    const canonical = projector(
      this.entry(normalizedWorkspaceId).engine.getSnapshot()
    );
    return this.eventCoordinator(normalizedWorkspaceId).project(canonical);
  }

  protected subscribeActivitySnapshot(
    workspaceId: string,
    listener: () => void
  ): () => void {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const entry = this.entry(normalizedWorkspaceId);
    const unsubscribeEngine = entry.engine.subscribe(listener);
    const unsubscribeOptimistic = this.eventCoordinator(
      normalizedWorkspaceId
    ).subscribe(listener);
    return () => {
      unsubscribeEngine();
      unsubscribeOptimistic();
    };
  }

  protected reconcileOptimisticMessages(
    workspaceId: string,
    agentSessionId: string
  ): void {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const normalizedAgentSessionId = agentSessionId.trim();
    if (!normalizedAgentSessionId) return;
    this.eventCoordinator(normalizedWorkspaceId).reconcileMessages(
      normalizedAgentSessionId
    );
  }

  ensureSessionSynchronized(
    input: WorkspaceAgentActivityEnsureSessionSynchronizedInput
  ): () => void {
    // Desktop owns one workspace-scoped event stream, so focusing a Session
    // needs an exact reconcile but does not acquire a per-Session subscription.
    // Keep the release hook for hosts that implement a narrower stream lease.
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
  readonly onConnectorCatalogInvalidated =
    this.composerOptionsInvalidation.onConnectorCatalogInvalidated.bind(
      this.composerOptionsInvalidation
    );
  readonly invalidateConnectorCatalog =
    this.composerOptionsInvalidation.invalidateConnectorCatalog.bind(
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
    for (const coordinator of this.eventCoordinators.values()) {
      coordinator.dispose();
    }
    this.eventCoordinators.clear();
    this.sessionReconcileExecutors.clear();
  }

  protected async fetchActivitySessionDetail(
    workspaceId: string,
    agentSessionId: string,
    source: string,
    projection: "full" | "messageHydration" = "full",
    signal?: AbortSignal
  ): Promise<AgentActivitySessionDetailSnapshot> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    if (source) {
      this.reportReconcileTrace({
        agentSessionId,
        traceEvent: `${source}.requested`,
        workspaceId: normalizedWorkspaceId
      });
    }
    const detail =
      await this.reconcileDependencies.tuttidClient.getWorkspaceAgentSession(
        normalizedWorkspaceId,
        agentSessionId,
        projection,
        { signal }
      );
    const mapped = agentActivitySessionDetailFromTuttid(
      normalizedWorkspaceId,
      agentSessionId,
      detail
    );
    if (source) {
      this.reportReconcileTrace({
        agentSessionId,
        traceEvent: `${source}.resolved`,
        workspaceId: normalizedWorkspaceId,
        fields: {
          incomingSession: agentActivitySessionReconcileDiagnosticDetails(
            mapped.session
          ),
          childSessionIds: mapped.childSessions.map(
            (session) => session.agentSessionId
          )
        }
      });
    }
    return {
      ...mapped,
      editRetry: editRetryAvailabilityFromTuttid(detail.editRetry)
    };
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
    detail: AgentActivitySessionDetailSnapshot,
    source: string,
    options: Pick<
      SessionDetailSnapshotReceivedIntent,
      "live" | "messages" | "sessionMessageWindows"
    > = {}
  ): void {
    const workspaceId = normalizeWorkspaceId(detail.session.workspaceId);
    const agentSessionId = detail.session.agentSessionId;
    const beforeSession =
      this.activitySnapshot(workspaceId).sessions.find(
        (session) => session.agentSessionId === agentSessionId
      ) ?? null;
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: source,
      workspaceId,
      fields: {
        beforeSession:
          agentActivitySessionReconcileDiagnosticDetails(beforeSession),
        childSessionIds: detail.childSessions.map(
          (session) => session.agentSessionId
        ),
        incomingSession: agentActivitySessionReconcileDiagnosticDetails(
          detail.session
        )
      }
    });
    this.entry(workspaceId).engine.dispatch({
      childSessions: detail.childSessions,
      editRetry: detail.editRetry,
      ...(options.live ? { live: true } : {}),
      ...(options.messages ? { messages: options.messages } : {}),
      session: detail.session,
      ...(options.sessionMessageWindows
        ? { sessionMessageWindows: options.sessionMessageWindows }
        : {}),
      turns: detail.turns,
      type: "session/detailSnapshotReceived",
      workspaceId
    });
    const afterSession =
      this.activitySnapshot(workspaceId).sessions.find(
        (session) => session.agentSessionId === agentSessionId
      ) ?? null;
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: `${source}.applied`,
      workspaceId,
      fields: {
        afterSession:
          agentActivitySessionReconcileDiagnosticDetails(afterSession)
      }
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
          level: "debug",
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
    this.eventCoordinator(workspaceId).removeSession(agentSessionId);
  }

  protected isSessionTombstoned(
    workspaceId: string,
    agentSessionId: string
  ): boolean {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const coordinator = this.eventCoordinators.get(normalizedWorkspaceId);
    if (coordinator) return coordinator.isSessionDeleted(agentSessionId);
    const entry = this.entries.get(normalizedWorkspaceId);
    return Boolean(
      entry?.engine.getSnapshot().sessionLifecycle.deletedSessionIds[
        agentSessionId.trim()
      ]
    );
  }

  protected executeSessionReconcileCommand(
    command: SessionReconcileCommand,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.executeSessionReconcileCommandSafely(command, signal);
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
        live: true,
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
      ),
      eventStreamClient.subscribe(
        "workspace.tuttimode.updated",
        (event) => {
          const agentSessionId = event.payload.agentSessionId.trim();
          if (!agentSessionId) return;
          const entry = this.entries.get(workspaceId);
          if (!entry) return;
          const snapshot = entry.engine.getSnapshot();
          const pendingActivation = selectLatestActivationForSession(
            snapshot,
            agentSessionId
          );
          if (
            !selectEngineSession(snapshot, agentSessionId) &&
            pendingActivation?.mode === "new" &&
            (pendingActivation.status === "requested" ||
              pendingActivation.status === "uncertain")
          ) {
            return;
          }
          entry.engine.dispatch({
            agentSessionId,
            needsMessages: false,
            needsState: true,
            type: "session/reconcileRequested",
            workspaceId
          });
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
        this.eventStreamConnectionState = state;
        for (const [workspaceId, entry] of this.entries) {
          entry.engine.dispatch({
            status: state,
            type: "engine/connectionChanged",
            workspaceId
          });
          this.eventCoordinator(workspaceId).eventStreamConnectionChanged({
            status: state
          });
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

  private async reconcileAgentActivityUpdate(
    input: WorkspaceAgentActivityBridgeEvent
  ): Promise<void> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) return;
    const result = this.eventCoordinator(workspaceId).ingestEvent(input);
    if (result.reason === "invalid_delta") {
      this.reportReconcileTrace({
        agentSessionId,
        traceEvent: "realtime.message_delta_invalid",
        workspaceId
      });
    } else if (result.inlineGap) {
      this.reportReconcileTrace({
        agentSessionId,
        traceEvent: "realtime.message_version_gap_detected",
        workspaceId,
        fields: { ...result.inlineGap }
      });
    }
    if (result.optimisticMessage) {
      this.emitSessionEvent(
        workspaceId,
        hostMessageEventFromCore(result.optimisticMessage)
      );
    }
    if (result.inlineApplied) {
      for (const message of result.inlineMessages) {
        this.emitSessionEvent(workspaceId, hostMessageEventFromCore(message));
      }
    }
    if (input.eventType === "session_deleted" && result.accepted) {
      this.emitSessionEvent(workspaceId, {
        data: input.data,
        eventType: input.eventType
      });
    }
    if (input.eventType === "turn_update" && result.accepted) {
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

  private eventCoordinator(
    workspaceId: string
  ): ReturnType<typeof createAgentActivityWorkspaceEventCoordinator> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.eventCoordinators.get(normalizedWorkspaceId);
    if (existing) return existing;
    const coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine: this.entry(normalizedWorkspaceId).engine,
      readCanonicalSnapshot: () =>
        this.canonicalActivitySnapshot(normalizedWorkspaceId),
      workspaceId: normalizedWorkspaceId
    });
    this.eventCoordinators.set(normalizedWorkspaceId, coordinator);
    if (this.eventStreamConnectionState) {
      this.entry(normalizedWorkspaceId).engine.dispatch({
        status: this.eventStreamConnectionState,
        type: "engine/connectionChanged",
        workspaceId: normalizedWorkspaceId
      });
      coordinator.eventStreamConnectionChanged({
        status: this.eventStreamConnectionState
      });
    }
    return coordinator;
  }

  private canonicalActivitySnapshot(
    workspaceId: string
  ): AgentActivitySnapshot {
    let projector = this.snapshotProjectors.get(workspaceId);
    if (!projector) {
      projector = createAgentActivitySnapshotProjector(workspaceId);
      this.snapshotProjectors.set(workspaceId, projector);
    }
    return projector(this.entry(workspaceId).engine.getSnapshot());
  }

  private sessionReconcileExecutor(
    workspaceId: string
  ): AgentActivitySessionReconcileExecutor {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.sessionReconcileExecutors.get(normalizedWorkspaceId);
    if (existing) return existing;
    const entry = this.entry(normalizedWorkspaceId);
    const executor = createAgentActivitySessionReconcileExecutor({
      childMessageHydration: "session_hierarchy",
      engine: entry.engine,
      isSessionDeleted: (agentSessionId) =>
        this.isSessionTombstoned(normalizedWorkspaceId, agentSessionId),
      onTrace: (event) => {
        const detail = event.type === "messages" ? undefined : event.detail;
        const traceEvent =
          event.type === "detail"
            ? event.phase === "discovery"
              ? `reconcile.combined.discovery_fetch.${event.status}`
              : event.phase === "final"
                ? `reconcile.combined.state_fetch.${event.status}`
                : `reconcile.state_fetch.${event.status}`
            : event.type === "messages"
              ? event.scope === "combined"
                ? `reconcile.combined.messages_${event.status}`
                : `reconcile.messages.${event.status}`
              : event.scope === "state_and_messages"
                ? event.status === "applying"
                  ? "reconcile.combined.state_upsert"
                  : "reconcile.combined.state_upsert.applied"
                : event.status === "applying"
                  ? "reconcile.state_upsert"
                  : "reconcile.state_upsert.applied";
        this.reportReconcileTrace({
          agentSessionId:
            event.type === "detailApply"
              ? event.detail.session.agentSessionId
              : event.agentSessionId,
          fields: {
            ...(event.type === "messages"
              ? {
                  afterVersion: event.afterVersion,
                  latestVersion: event.latestVersion,
                  messageCount: event.messageCount,
                  messageVersion: event.messageVersion,
                  requestedSessionId: event.requestedAgentSessionId
                }
              : {}),
            ...(detail
              ? {
                  childSessionIds: detail.childSessions.map(
                    (session) => session.agentSessionId
                  ),
                  incomingSession:
                    agentActivitySessionReconcileDiagnosticDetails(
                      detail.session
                    ),
                  ...(event.type === "detailApply"
                    ? event.status === "applying"
                      ? {
                          beforeSession:
                            agentActivitySessionReconcileDiagnosticDetails(
                              this.canonicalActivitySnapshot(
                                normalizedWorkspaceId
                              ).sessions.find(
                                (session) =>
                                  session.agentSessionId ===
                                  detail.session.agentSessionId
                              ) ?? null
                            )
                        }
                      : {
                          afterSession:
                            agentActivitySessionReconcileDiagnosticDetails(
                              this.canonicalActivitySnapshot(
                                normalizedWorkspaceId
                              ).sessions.find(
                                (session) =>
                                  session.agentSessionId ===
                                  detail.session.agentSessionId
                              ) ?? null
                            )
                        }
                    : {})
                }
              : {})
          },
          traceEvent,
          workspaceId: normalizedWorkspaceId
        });
      },
      port: {
        getSessionDetail: ({ agentSessionId, projection, signal }) =>
          this.fetchActivitySessionDetail(
            normalizedWorkspaceId,
            agentSessionId,
            "",
            projection === "message_hydration" ? "messageHydration" : "full",
            signal
          ),
        listSessionMessages: (query) => entry.adapter.listSessionMessages(query)
      },
      reconcileAuthoritativeHistory: (agentSessionId, messages, turns) =>
        this.eventCoordinator(
          normalizedWorkspaceId
        ).reconcileAuthoritativeHistory(agentSessionId, messages, turns),
      reconcileOptimisticMessages: (agentSessionId) =>
        this.reconcileOptimisticMessages(normalizedWorkspaceId, agentSessionId),
      workspaceId: normalizedWorkspaceId
    });
    this.sessionReconcileExecutors.set(normalizedWorkspaceId, executor);
    return executor;
  }

  private async executeSessionReconcileCommandSafely(
    command: SessionReconcileCommand,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      const result = await this.sessionReconcileExecutor(
        command.workspaceId
      ).execute(command, { signal });
      if (result.status === "applied") {
        for (const message of result.appliedMessages) {
          this.emitSessionEvent(
            command.workspaceId,
            hostMessageEventFromCore(message)
          );
        }
      }
      return result;
    } catch (error: unknown) {
      if (isWorkspaceAgentSessionNotFoundError(error)) {
        void this.reconcileDependencies.runtimeApi.logTerminalDiagnostic({
          details: {
            agentSessionId: command.agentSessionId,
            error: stringifyError(error)
          },
          event: "agent.activity.reconcile_session_absent",
          level: "info",
          workspaceId: command.workspaceId
        });
        throw error;
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
}
