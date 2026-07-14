import type {
  AgentActivitySession,
  AgentActivityUpdatedEvent
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
  hasInlineMessagesData,
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
  private readonly controllerEntries = new Map<
    string,
    WorkspaceAgentSessionEngineHost
  >();
  private readonly controllerEntryCreationInProgress = new Set<string>();
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

  protected abstract createControllerEntry(
    workspaceId: string
  ): WorkspaceAgentSessionEngineHost;

  protected controllerEntry(
    workspaceId: string
  ): WorkspaceAgentSessionEngineHost {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.controllerEntries.get(normalizedWorkspaceId);
    if (existing) return existing;
    this.controllerEntryCreationInProgress.add(normalizedWorkspaceId);
    try {
      const entry = this.createControllerEntry(normalizedWorkspaceId);
      this.controllerEntries.set(normalizedWorkspaceId, entry);
      this.subscribeWorkspaceEventStream(normalizedWorkspaceId);
      this.startEventStreamConnection();
      entry.engine.dispatch({
        type: "workspace/reconcileRequested",
        workspaceId: normalizedWorkspaceId
      });
      return entry;
    } finally {
      this.controllerEntryCreationInProgress.delete(normalizedWorkspaceId);
    }
  }

  ensureSessionSynchronized(
    input: WorkspaceAgentActivityEnsureSessionSynchronizedInput
  ): () => void {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (agentSessionId) {
      this.controllerEntry(workspaceId).engine.dispatch({
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
      !this.controllerEntries.has(normalizedWorkspaceId) &&
      !this.controllerEntryCreationInProgress.has(normalizedWorkspaceId)
    ) {
      this.controllerEntry(normalizedWorkspaceId);
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
    this.upsertControllerSession({
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
    const entry = this.controllerEntry(workspaceId);
    entry.engine.dispatch({ agentSessionId, type: "session/removed" });
    entry.controller.removeSession(agentSessionId);
  }

  protected isSessionTombstoned(
    workspaceId: string,
    agentSessionId: string
  ): boolean {
    const entry = this.controllerEntries.get(normalizeWorkspaceId(workspaceId));
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

  private upsertControllerSession(input: {
    agentSessionId: string;
    session: AgentActivitySession;
    source: string;
    workspaceId: string;
  }): void {
    const entry = this.controllerEntry(input.workspaceId);
    const beforeSession =
      entry.controller
        .getSnapshot()
        .sessions.find(
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
    entry.controller.upsertSession(input.session);
    const afterSession =
      entry.controller
        .getSnapshot()
        .sessions.find(
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

  private handleModelCatalogInvalidated(
    event: WorkspaceAgentModelCatalogInvalidatedEvent
  ): void {
    for (const entry of this.controllerEntries.values()) {
      entry.controller.invalidateComposerOptions({
        providers: event.providers
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
      for (const [workspaceId, entry] of this.controllerEntries) {
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
      this.controllerEntry(workspaceId).engine.dispatch({
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
      this.latestStateEventBySessionKey.set(
        this.stateEventKey(workspaceId, agentSessionId),
        { data: input.data, eventType: "state_patch" }
      );
      this.controllerEntry(workspaceId).engine.dispatch({
        agentSessionId,
        needsMessages: false,
        needsState: true,
        type: "session/reconcileRequested",
        workspaceId
      });
      return;
    }
    const hasCachedSession = this.hasCachedSession(workspaceId, agentSessionId);
    const inlineApplied =
      hasCachedSession && this.applyInlineActivityUpdatedEvent(input);
    this.controllerEntry(workspaceId).engine.dispatch({
      agentSessionId,
      eventType: input.eventType,
      hasCachedSession,
      hasInlineMessages: hasInlineMessagesData(input.data),
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
    return this.controllerEntry(workspaceId)
      .controller.getSnapshot()
      .sessions.some((session) => session.agentSessionId === agentSessionId);
  }

  private async reconcileAgentSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<void> {
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) return;
    const entry = this.controllerEntry(workspaceId);
    const messages =
      entry.controller.getSnapshot().sessionMessagesById[agentSessionId];
    const afterVersion = reconcileAfterVersion(messages ?? []);
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: "reconcile.combined.messages_requested",
      workspaceId,
      fields: { afterVersion }
    });
    const page = await entry.controller.listSessionMessages({
      agentSessionId,
      afterVersion
    });
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      entry.controller.removeSession(agentSessionId);
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
      entry.controller.removeSession(agentSessionId);
      return;
    }
    this.upsertControllerSession({
      agentSessionId,
      session,
      source: "reconcile.combined.state_upsert",
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
    const entry = this.controllerEntry(workspaceId);
    const messages =
      entry.controller.getSnapshot().sessionMessagesById[agentSessionId];
    const afterVersion = reconcileAfterVersion(messages ?? []);
    this.reportReconcileTrace({
      agentSessionId,
      traceEvent: "reconcile.messages.requested",
      workspaceId,
      fields: { afterVersion }
    });
    const page = await entry.controller.listSessionMessages({
      agentSessionId,
      afterVersion
    });
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      entry.controller.removeSession(agentSessionId);
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
  }

  private async reconcileAgentSessionState(
    workspaceId: string,
    agentSessionId: string
  ): Promise<void> {
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) return;
    const session = await this.fetchActivitySession(
      workspaceId,
      agentSessionId,
      "reconcile.state_fetch"
    );
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      this.controllerEntry(workspaceId).controller.removeSession(
        agentSessionId
      );
      return;
    }
    this.upsertControllerSession({
      agentSessionId,
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

  private applyInlineActivityUpdatedEvent(
    input: AgentActivityUpdatedEvent
  ): boolean {
    if (this.isSessionTombstoned(input.workspaceId, input.agentSessionId)) {
      return true;
    }
    const result = this.controllerEntry(
      input.workspaceId
    ).controller.applyActivityUpdatedEvent(input);
    if (!result.applied) {
      this.reportReconcileTrace({
        agentSessionId: input.agentSessionId,
        traceEvent: "inline.not_applied",
        workspaceId: input.workspaceId,
        fields: { eventType: input.eventType }
      });
      return false;
    }
    this.reportReconcileTrace({
      agentSessionId: input.agentSessionId,
      traceEvent: "inline.applied",
      workspaceId: input.workspaceId,
      fields: {
        eventType: input.eventType,
        incomingSession: agentActivitySessionReconcileDiagnosticDetails(
          result.session
        )
      }
    });
    for (const message of result.messages) {
      this.emitSessionEvent(
        input.workspaceId,
        hostMessageEventFromCore(message)
      );
    }
    return true;
  }
}
