import {
  setAgentActivityStoreDiagnosticSink,
  type AgentActivityAdapter,
  type AgentActivityCancelSessionResult,
  type AgentActivityCreateSessionInput,
  type AgentActivityGoalControlResult,
  type AgentActivityController,
  type AgentActivityMessage,
  type AgentActivityMessagePage,
  type AgentActivitySession,
  type AgentActivityStatePatch,
  type AgentSessionEngine,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import { normalizeTuttidError } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import { agentActivitySessionFromTuttidSession } from "../desktopAgentActivityAdapter.ts";
import {
  agentSessionActivationError,
  normalizeComposerSettings,
  resolveComposerPermissionMode,
  toAgentHostAgentSessionFromCore,
  resolveDesktopAgentGUIProvider
} from "./desktopAgentHostProjection.ts";
import {
  desktopAgentHostWorkspaceState,
  rememberAgentSessionStateDefaults
} from "./desktopAgentHostWorkspaceState.ts";
import { loadWorkspaceAgentSessionControlState } from "./workspaceAgentSessionControlState.ts";
import type {
  IWorkspaceAgentActivityService,
  WorkspaceAgentActivityListMessagesInput,
  WorkspaceAgentActivityEnsureSessionSynchronizedInput,
  WorkspaceAgentActivityRetainSessionInput,
  WorkspaceAgentModelCatalogInvalidatedEvent
} from "../workspaceAgentActivityService.interface.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import { planDecisionOps } from "@tutti-os/agent-gui/plan-decision-ops";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import {
  createWorkspaceAgentSessionEngineHost,
  type WorkspaceAgentSessionEngineHost
} from "./workspaceAgentSessionEngineHost.ts";

export interface WorkspaceAgentActivityServiceDependencies {
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi?: Pick<
    DesktopHostFilesApi,
    "createUserDocumentsProjectDirectory"
  >;
  tuttidClient: TuttidClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  agentProviderStatusService?: Pick<IAgentProviderStatusService, "refresh">;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

type WorkspaceAgentActivityControllerEntry = WorkspaceAgentSessionEngineHost;

export class WorkspaceAgentActivityService implements IWorkspaceAgentActivityService {
  readonly _serviceBrand = undefined;

  private readonly dependencies: WorkspaceAgentActivityServiceDependencies;
  private readonly controllerEntries = new Map<
    string,
    WorkspaceAgentActivityControllerEntry
  >();
  private readonly sessionEventListenersByWorkspaceId = new Map<
    string,
    Set<(event: unknown) => void>
  >();
  private readonly modelCatalogInvalidatedListeners = new Set<
    (event: WorkspaceAgentModelCatalogInvalidatedEvent) => void
  >();
  private eventStreamStarted = false;

  constructor(dependencies: WorkspaceAgentActivityServiceDependencies) {
    // Temporary instrumentation: surface activity-store anomalies (version
    // regressions on unguarded write paths, stale-patch drops) in the desktop
    // log so field exports show which channel overwrote what. The sink slot
    // is process-global, so register once and take the workspace id from the
    // event details (the store stamps it at the emit site) — a per-workspace
    // closure would be overwritten by the next workspace and misattribute
    // diagnostics.
    setAgentActivityStoreDiagnosticSink((event, details) => {
      const flatDetails: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(details)) {
        flatDetails[key] =
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
            ? value
            : JSON.stringify(value);
      }
      void dependencies.runtimeApi
        .logTerminalDiagnostic({
          details: flatDetails,
          event: `agent.activity.store.${event}`,
          level: "warn",
          workspaceId:
            typeof details.workspaceId === "string" ? details.workspaceId : null
        })
        .catch(() => {});
    });
    this.dependencies = dependencies;
  }

  getSnapshot(workspaceId: string): AgentActivitySnapshot {
    return this.controllerEntry(workspaceId).controller.getSnapshot();
  }

  getSessionEngine(workspaceId: string): AgentSessionEngine {
    return this.controllerEntry(workspaceId).engine;
  }

  subscribe(
    workspaceId: string,
    listener: Parameters<AgentActivityController["subscribe"]>[0]
  ): () => void {
    return this.controllerEntry(workspaceId).controller.subscribe(listener);
  }

  load(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<AgentActivitySnapshot> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const entry = this.controllerEntry(normalizedWorkspaceId);
    this.reportReconcileTrace({
      agentSessionId: null,
      traceEvent: "load.requested",
      workspaceId: normalizedWorkspaceId,
      fields: {
        cachedSessionCount: entry.controller.getSnapshot().sessions.length
      }
    });
    return entry.controller.load(signal).then((snapshot) => {
      this.reportReconcileTrace({
        agentSessionId: null,
        traceEvent: "load.resolved",
        workspaceId: normalizedWorkspaceId,
        fields: {
          newestSession: agentActivitySessionReconcileDiagnosticDetails(
            snapshot.sessions[0] ?? null
          ),
          sessionCount: snapshot.sessions.length
        }
      });
      return snapshot;
    });
  }

  listSessionMessages(
    input: WorkspaceAgentActivityListMessagesInput
  ): Promise<AgentActivityMessagePage> {
    return this.controllerEntry(
      input.workspaceId
    ).controller.listSessionMessages({
      agentSessionId: input.agentSessionId,
      afterVersion: input.afterVersion,
      beforeVersion: input.beforeVersion,
      cache: input.cache,
      limit: input.limit,
      order: input.order,
      signal: input.signal
    });
  }

  async listAgentGeneratedFiles(
    input: Parameters<
      IWorkspaceAgentActivityService["listAgentGeneratedFiles"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listAgentGeneratedFiles"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    return this.dependencies.tuttidClient.listWorkspaceAgentGeneratedFiles(
      workspaceId,
      {
        limit: input.limit,
        query: input.query?.trim() || undefined,
        sessionCwd: input.sessionCwd?.trim() || undefined
      }
    );
  }

  async listSessionsPage(
    input: Parameters<IWorkspaceAgentActivityService["listSessionsPage"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionsPage"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.listWorkspaceAgentSessions(
        workspaceId,
        {
          limit: input.limit,
          searchQuery: input.searchQuery?.trim() || undefined
        },
        {
          signal: input.signal
        }
      );
    return {
      hasMore: false,
      nextCursor: undefined,
      sessions: response.sessions.map((session) =>
        agentActivitySessionFromTuttidSession(workspaceId, session)
      ),
      workspaceId: response.workspaceId
    };
  }

  async listSessionSections(
    input: Parameters<IWorkspaceAgentActivityService["listSessionSections"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionSections"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.listWorkspaceAgentSessionSections(
        workspaceId,
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          limitPerSection: input.limitPerSection
        },
        {
          signal: input.signal
        }
      );
    const pinned = response.pinned ?? { hasMore: false, sessions: [] };
    return {
      pinned: {
        hasMore: pinned.hasMore,
        nextCursor: pinned.nextCursor,
        sessions: pinned.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(workspaceId, session)
        )
      },
      sections: response.sections.map((section) => ({
        hasMore: section.hasMore,
        kind: section.kind,
        nextCursor: section.nextCursor,
        sectionKey: section.sectionKey,
        sessions: section.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(workspaceId, session)
        ),
        userProject: section.userProject
      })),
      workspaceId: response.workspaceId
    };
  }

  async listPinnedSessionsPage(
    input: Parameters<
      IWorkspaceAgentActivityService["listPinnedSessionsPage"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listPinnedSessionsPage"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.listWorkspaceAgentPinnedSessionPage(
        workspaceId,
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          cursor: input.cursor?.trim() || undefined,
          limit: input.limit
        },
        {
          signal: input.signal
        }
      );
    return {
      hasMore: response.page.hasMore,
      nextCursor: response.page.nextCursor,
      sessions: response.page.sessions.map((session) =>
        agentActivitySessionFromTuttidSession(workspaceId, session)
      )
    };
  }

  async listSessionSectionPage(
    input: Parameters<
      IWorkspaceAgentActivityService["listSessionSectionPage"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionSectionPage"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.listWorkspaceAgentSessionSectionPage(
        workspaceId,
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          cursor: input.cursor?.trim() || undefined,
          limit: input.limit,
          sectionKey: input.sectionKey
        },
        {
          signal: input.signal
        }
      );
    return {
      hasMore: response.section.hasMore,
      kind: response.section.kind,
      nextCursor: response.section.nextCursor,
      sectionKey: response.section.sectionKey,
      sessions: response.section.sessions.map((session) =>
        agentActivitySessionFromTuttidSession(workspaceId, session)
      ),
      userProject: response.section.userProject
    };
  }

  async scanExternalSessionImports(
    workspaceId: string,
    request?: Parameters<
      IWorkspaceAgentActivityService["scanExternalSessionImports"]
    >[1]
  ): ReturnType<IWorkspaceAgentActivityService["scanExternalSessionImports"]> {
    return this.dependencies.tuttidClient.scanWorkspaceExternalAgentSessionImports(
      normalizeWorkspaceId(workspaceId),
      request
    );
  }

  async importExternalSessions(
    workspaceId: string,
    request: Parameters<
      IWorkspaceAgentActivityService["importExternalSessions"]
    >[1]
  ): ReturnType<IWorkspaceAgentActivityService["importExternalSessions"]> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const result =
      await this.dependencies.tuttidClient.importWorkspaceExternalAgentSessions(
        normalizedWorkspaceId,
        request
      );
    await Promise.all([
      this.load(normalizedWorkspaceId),
      this.dependencies.workspaceUserProjectService?.refresh()
    ]);
    return result;
  }

  async setSessionPinned(input: {
    agentSessionId: string;
    pinned: boolean;
    workspaceId: string;
  }): Promise<AgentActivitySession> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const session =
      await this.dependencies.tuttidClient.updateWorkspaceAgentSessionPin(
        workspaceId,
        input.agentSessionId,
        { pinned: input.pinned }
      );
    const activitySession = agentActivitySessionFromTuttidSession(
      workspaceId,
      session
    );
    this.upsertAuthoritativeSession(activitySession, "pin_result");
    return activitySession;
  }

  ensureSessionSynchronized(
    input: WorkspaceAgentActivityEnsureSessionSynchronizedInput
  ): () => void {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (agentSessionId) {
      void this.reconcileAgentActivityUpdate({
        agentSessionId,
        eventType: "message_update",
        workspaceId
      }).catch(input.onError ?? (() => {}));
    }
    return () => {};
  }

  retainSessionEvents(
    input: WorkspaceAgentActivityRetainSessionInput
  ): () => void {
    return this.ensureSessionSynchronized(input);
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
    return () => {
      listeners?.delete(listener);
    };
  }

  async createSession(
    input: Parameters<AgentActivityAdapter["createSession"]>[0]
  ): Promise<AgentActivitySession> {
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: input.agentSessionId?.trim() ?? null,
      event: "activity_service.create.entered",
      metadata: input.metadata,
      provider: null,
      workspaceId: input.workspaceId,
      fields: { agentTargetId: input.agentTargetId ?? null }
    });
    const entry = this.controllerEntry(input.workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: input.agentSessionId?.trim() ?? null,
      event: "activity_service.create.adapter_requested",
      metadata: input.metadata,
      provider: null,
      workspaceId: input.workspaceId,
      fields: { agentTargetId: input.agentTargetId ?? null }
    });
    const sessionInput = withNoProjectRuntimeContext(
      input,
      this.dependencies.workspaceUserProjectService
    );
    const session = await entry.adapter.createSession(sessionInput);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: session.agentSessionId,
      event: "activity_service.create.adapter_resolved",
      metadata: input.metadata,
      provider: session.provider,
      workspaceId: input.workspaceId,
      fields: { sessionStatus: session.status }
    });
    this.upsertAuthoritativeSession(session, "create_session_result");
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: session.agentSessionId,
      event: "activity_service.create.resolved",
      metadata: input.metadata,
      provider: session.provider,
      workspaceId: input.workspaceId,
      fields: { sessionStatus: session.status }
    });
    return session;
  }

  async activateSession(
    input: Parameters<AgentActivityRuntime["activateSession"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["activateSession"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const requestedAgentSessionId = input.agentSessionId.trim();
    const workspaceState = desktopAgentHostWorkspaceState(workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: requestedAgentSessionId,
      event: "activity_service.activate.entered",
      metadata: input.metadata,
      provider: null,
      workspaceId,
      fields: { agentTargetId: input.agentTargetId ?? null, mode: input.mode }
    });
    if (input.mode === "new") {
      reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
        agentSessionId: requestedAgentSessionId,
        event: "activity_service.activate.cwd_resolve_requested",
        metadata: input.metadata,
        provider: null,
        workspaceId
      });
    }
    const resolvedCwd =
      input.mode === "new"
        ? await this.resolveWorkspaceAgentCwd({
            agentSessionId: requestedAgentSessionId,
            cwd: input.cwd,
            workspaceId
          })
        : null;
    if (input.mode === "new") {
      reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
        agentSessionId: requestedAgentSessionId,
        event: "activity_service.activate.cwd_resolved",
        metadata: input.metadata,
        provider: null,
        workspaceId,
        fields: {
          agentTargetId: input.agentTargetId ?? null,
          cwd: resolvedCwd?.cwd ?? null
        }
      });
    }
    let session: AgentActivitySession;
    if (input.mode === "existing") {
      session = await this.getSession(workspaceId, requestedAgentSessionId);
    } else {
      reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
        agentSessionId: requestedAgentSessionId,
        event: "activity_service.activate.create_requested",
        metadata: input.metadata,
        provider: null,
        workspaceId,
        fields: { agentTargetId: input.agentTargetId ?? null }
      });
      session = await this.createSession({
        workspaceId,
        agentSessionId: requestedAgentSessionId,
        agentTargetId: input.agentTargetId,
        cwd: resolvedCwd?.cwd ?? null,
        initialContent: input.initialContent ?? [],
        initialDisplayPrompt: input.initialDisplayPrompt ?? null,
        metadata: input.metadata,
        model: input.settings?.model ?? null,
        planMode: input.settings?.planMode ?? null,
        permissionModeId: resolveComposerPermissionMode(input.settings),
        reasoningEffort: input.settings?.reasoningEffort ?? null,
        ...(resolvedCwd?.noProject
          ? { runtimeContext: { noProject: true } }
          : {}),
        speed: input.settings?.speed ?? null,
        title: input.title ?? null,
        visible: input.visible ?? true
      });
      reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
        agentSessionId: session.agentSessionId,
        event: "activity_service.activate.create_resolved",
        metadata: input.metadata,
        provider: session.provider,
        workspaceId,
        fields: { sessionStatus: session.status }
      });
    }
    rememberAgentSessionStateDefaults(
      workspaceState,
      session.agentSessionId,
      input.settings
    );
    const hostSession = toAgentHostAgentSessionFromCore(workspaceId, session, {
      cwd: resolvedCwd?.cwd ?? input.cwd ?? session.cwd,
      permissionModeId: resolveComposerPermissionMode(input.settings)
    });
    const activationFailed = hostSession.status === "failed";
    const activationError = agentSessionActivationError(session);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: session.agentSessionId,
      event: "activity_service.activate.resolved",
      metadata: input.metadata,
      provider: session.provider,
      workspaceId,
      fields: {
        mode: input.mode,
        sessionStatus: hostSession.status
      }
    });
    return {
      activation: {
        mode: input.mode,
        status: activationFailed
          ? "failed"
          : input.mode === "existing"
            ? "already_attached"
            : "attached"
      },
      ...(activationError ? { error: activationError } : {}),
      session: hostSession
    };
  }

  async sendInput(
    input: Parameters<AgentActivityAdapter["sendInput"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["sendInput"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      event: "activity_service.send.entered",
      metadata: input.metadata,
      workspaceId
    });
    const entry = this.controllerEntry(workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      event: "activity_service.send.adapter_requested",
      metadata: input.metadata,
      workspaceId
    });
    const result = await entry.adapter.sendInput({
      ...input,
      workspaceId
    });
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      event: "activity_service.send.adapter_resolved",
      metadata: input.metadata,
      provider: result.session.provider,
      workspaceId,
      fields: {
        sessionStatus: result.session.status,
        turnId: result.turnId,
        turnPhase: result.turnLifecycle?.phase ?? null
      }
    });
    this.upsertAuthoritativeSession(result.session, "send_input_result");
    return result;
  }

  async readSessionAttachment(input: {
    agentSessionId: string;
    attachmentId: string;
    workspaceId: string;
  }): ReturnType<IWorkspaceAgentActivityService["readSessionAttachment"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    return this.dependencies.tuttidClient.readWorkspaceAgentSessionAttachment(
      workspaceId,
      input.agentSessionId,
      input.attachmentId
    );
  }

  async cancelSession(
    input: Parameters<AgentActivityAdapter["cancelSession"]>[0]
  ): Promise<AgentActivityCancelSessionResult> {
    const entry = this.controllerEntry(input.workspaceId);
    const result = await entry.adapter.cancelSession(input);
    this.upsertAuthoritativeSession(result.session, "cancel_result");
    return result;
  }

  async cancelTurn(input: {
    agentSessionId: string;
    turnId: string;
    workspaceId: string;
  }): Promise<
    import("@tutti-os/agent-activity-core").AgentActivityTurnCancelResponse
  > {
    const cancelTurn = this.dependencies.tuttidClient.cancelWorkspaceAgentTurn;
    if (!cancelTurn) {
      throw new Error("Turn-scoped cancellation is unavailable.");
    }
    return cancelTurn(
      normalizeWorkspaceId(input.workspaceId),
      input.agentSessionId,
      input.turnId
    );
  }

  async goalControl(
    input: Parameters<AgentActivityAdapter["goalControl"]>[0]
  ): Promise<AgentActivityGoalControlResult> {
    const entry = this.controllerEntry(input.workspaceId);
    const result = await entry.adapter.goalControl(input);
    this.upsertAuthoritativeSession(result.session, "goal_control_result");
    return result;
  }

  async submitInteractive(
    input: Parameters<AgentActivityAdapter["submitInteractive"]>[0]
  ): Promise<unknown> {
    return this.controllerEntry(input.workspaceId).adapter.submitInteractive(
      input
    );
  }

  async submitPlanDecision(
    input: Parameters<IWorkspaceAgentActivityService["submitPlanDecision"]>[0]
  ): Promise<void> {
    const ops = planDecisionOps({
      promptKind: input.promptKind,
      requestId: input.requestId,
      ...(input.action ? { action: input.action } : {}),
      ...(input.optionId ? { optionId: input.optionId } : {}),
      ...(input.payload ? { payload: input.payload } : {})
    });
    for (const op of ops) {
      if (op.type === "updateSettings") {
        await this.updateSessionSettings({
          workspaceId: input.workspaceId,
          agentSessionId: input.agentSessionId,
          settings: op.settings
        });
      } else if (op.type === "sendInput") {
        await this.sendInput({
          workspaceId: input.workspaceId,
          agentSessionId: input.agentSessionId,
          content: [{ type: "text", text: op.text }]
        });
      } else {
        await this.submitInteractive({
          workspaceId: input.workspaceId,
          agentSessionId: input.agentSessionId,
          requestId: op.requestId,
          ...(op.action ? { action: op.action } : {}),
          ...(op.optionId ? { optionId: op.optionId } : {}),
          ...(op.payload ? { payload: op.payload } : {})
        });
      }
    }
  }

  async deleteSession(
    input: Parameters<AgentActivityAdapter["deleteSession"]>[0]
  ) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    const entry = this.controllerEntry(workspaceId);
    const result = await entry.adapter.deleteSession(input);
    if (result.removed) {
      this.markSessionDeleted({
        agentSessionId,
        data: { deletedAtUnixMs: Date.now() },
        workspaceId
      });
      await entry.controller.load(input.signal);
      if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
        entry.controller.removeSession(agentSessionId);
      }
    }
    return result;
  }

  async renameSession(
    input: Parameters<AgentActivityAdapter["renameSession"]>[0]
  ): Promise<AgentActivitySession> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    const entry = this.controllerEntry(workspaceId);
    const session = await entry.adapter.renameSession({
      ...input,
      agentSessionId,
      workspaceId
    });
    this.upsertAuthoritativeSession(session, "rename_session_result");
    return session;
  }

  async getSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<AgentActivitySession> {
    const activitySession = await this.fetchActivitySession(
      workspaceId,
      agentSessionId,
      "get_session"
    );
    this.upsertAuthoritativeSession(activitySession, "get_session_result");
    return activitySession;
  }

  async getComposerOptions(input: {
    agentTargetId?: string | null;
    cwd?: string | null;
    force?: boolean;
    provider?: string;
    signal?: AbortSignal;
    settings?: Parameters<typeof normalizeComposerSettings>[0] | null;
    workspaceId: string;
  }): Promise<unknown> {
    const provider = resolveDesktopAgentGUIProvider(input.provider);
    return this.controllerEntry(
      input.workspaceId
    ).controller.loadComposerOptions({
      agentTargetId: input.agentTargetId,
      provider,
      cwd: input.cwd,
      force: input.force,
      signal: input.signal,
      settings: normalizeComposerSettings(input.settings)
    });
  }

  async updateSessionSettings(input: {
    agentSessionId: string;
    settings: Parameters<typeof normalizeComposerSettings>[0];
    workspaceId: string;
  }): ReturnType<IWorkspaceAgentActivityService["updateSessionSettings"]> {
    const workspaceState = desktopAgentHostWorkspaceState(input.workspaceId);
    const session =
      await this.dependencies.tuttidClient.updateWorkspaceAgentSessionSettings(
        input.workspaceId,
        input.agentSessionId,
        normalizeComposerSettings(input.settings)
      );
    const settings = session.settings
      ? normalizeComposerSettings(session.settings)
      : normalizeComposerSettings(input.settings);
    rememberAgentSessionStateDefaults(workspaceState, session.id, settings);
    return {
      agentSessionId: input.agentSessionId,
      settings
    };
  }

  getSessionControlState(input: {
    agentSessionId: string;
    workspaceId: string;
  }) {
    return loadWorkspaceAgentSessionControlState({
      agentSessionId: input.agentSessionId,
      tuttidClient: this.dependencies.tuttidClient,
      workspaceId: input.workspaceId
    });
  }

  unactivateSession(
    input: Parameters<AgentActivityRuntime["unactivateSession"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["unactivateSession"]> {
    return Promise.resolve({
      agentSessionId: input.agentSessionId,
      buffered: false
    });
  }

  private controllerEntry(
    workspaceId: string
  ): WorkspaceAgentActivityControllerEntry {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.controllerEntries.get(normalizedWorkspaceId);
    if (existing) {
      return existing;
    }

    const entry = createWorkspaceAgentSessionEngineHost({
      activateSession: (input) => this.activateSession(input),
      cancelTurn: (input) => this.cancelTurn(input),
      loadWorkspace: (workspaceId) => this.load(workspaceId),
      reconcileSession: (command) =>
        this.executeSessionReconcileCommand(command),
      runtimeApi: this.dependencies.runtimeApi,
      sendInput: (input) => this.sendInput(input),
      tuttidClient: this.dependencies.tuttidClient,
      workspaceId: normalizedWorkspaceId
    });
    this.controllerEntries.set(normalizedWorkspaceId, entry);
    this.subscribeWorkspaceEventStream(normalizedWorkspaceId);
    this.startEventStreamConnection();
    return entry;
  }

  private async resolveWorkspaceAgentCwd(input: {
    agentSessionId: string;
    cwd: string | null | undefined;
    workspaceId: string;
  }): Promise<{ cwd: string | null; noProject: boolean }> {
    const trimmed = input.cwd?.trim() ?? "";
    if (!trimmed) {
      const directory =
        await this.dependencies.hostFilesApi?.createUserDocumentsProjectDirectory(
          {
            name: `session-${input.agentSessionId.trim()}`,
            allowExisting: true
          }
        );
      this.dependencies.workspaceUserProjectService?.rememberNoProjectPath(
        directory?.path
      );
      return { cwd: directory?.path ?? null, noProject: true };
    }
    if (trimmed !== "/") {
      return { cwd: trimmed, noProject: false };
    }
    const response =
      await this.dependencies.tuttidClient.listWorkspaceFileDirectory(
        input.workspaceId,
        {}
      );
    return { cwd: response.root, noProject: false };
  }

  private async fetchActivitySession(
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
      await this.dependencies.tuttidClient.getWorkspaceAgentSession(
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

  private upsertAuthoritativeSession(
    session: AgentActivitySession,
    source: string
  ): void {
    const workspaceId = normalizeWorkspaceId(session.workspaceId);
    this.upsertControllerSession({
      agentSessionId: session.agentSessionId,
      session,
      source,
      workspaceId
    });
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

  private reportReconcileTrace(input: {
    agentSessionId: string | null;
    traceEvent: string;
    workspaceId: string;
    fields?: Record<string, unknown>;
  }): void {
    try {
      void this.dependencies.runtimeApi
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
        .catch(() => {});
    } catch {
      // Diagnostic logging must not affect agent activity reconciliation.
    }
  }

  private markSessionDeleted(input: {
    agentSessionId: string;
    data?: unknown;
    workspaceId: string;
  }): void {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) {
      return;
    }
    const entry = this.controllerEntry(workspaceId);
    entry.engine.dispatch({ agentSessionId, type: "session/removed" });
    entry.controller.removeSession(agentSessionId);
  }

  private isSessionTombstoned(
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

  private emitSessionEvent(workspaceId: string, event: unknown): void {
    const listeners = this.sessionEventListenersByWorkspaceId.get(workspaceId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  onModelCatalogInvalidated(
    listener: (event: WorkspaceAgentModelCatalogInvalidatedEvent) => void
  ): () => void {
    this.modelCatalogInvalidatedListeners.add(listener);
    return () => {
      this.modelCatalogInvalidatedListeners.delete(listener);
    };
  }

  private handleModelCatalogInvalidated(
    event: WorkspaceAgentModelCatalogInvalidatedEvent
  ): void {
    // Drop cached composer options in every workspace controller first so a
    // listener-triggered (or later non-forced) load refetches from the daemon.
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
    const eventStreamClient = this.dependencies.eventStreamClient;
    if (!eventStreamClient) {
      return;
    }
    eventStreamClient.subscribe(
      "agent.activity.updated",
      (event) => {
        const payload = event.payload;
        if (payload.workspaceId.trim() !== workspaceId) {
          return;
        }
        this.scheduleAgentActivityUpdate({
          agentSessionId: payload.agentSessionId,
          data: payload.data,
          eventType: payload.eventType,
          workspaceId
        });
      },
      { scope: { workspaceId } }
    );
  }

  private startEventStreamConnection(): void {
    const eventStreamClient = this.dependencies.eventStreamClient;
    if (!eventStreamClient || this.eventStreamStarted) {
      return;
    }
    this.eventStreamStarted = true;
    // Global (scope-less) topic: the daemon invalidates its model catalog when
    // provider auth/config files change on disk (for example via cc-switch).
    eventStreamClient.subscribe("agent.model.catalog.invalidated", (event) => {
      this.handleModelCatalogInvalidated({
        providers: [...event.payload.providers],
        occurredAtUnixMs: event.payload.occurredAtUnixMs
      });
    });
    eventStreamClient.subscribeConnectionState((state) => {
      if (state !== "connected" && state !== "disconnected") {
        return;
      }
      for (const [workspaceId, entry] of this.controllerEntries) {
        entry.engine.dispatch({
          status: state,
          type: "engine/connectionChanged",
          workspaceId
        });
      }
    });
    void eventStreamClient.connect().catch((error: unknown) => {
      void this.dependencies.runtimeApi.logTerminalDiagnostic({
        details: { error: stringifyError(error) },
        event: "agent.activity.event_stream.connect_failed",
        level: "warn"
      });
    });
  }

  private async reconcileAgentActivityUpdate(input: {
    data?: unknown;
    agentSessionId: string;
    eventType: string;
    workspaceId: string;
  }): Promise<void> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) {
      return;
    }
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
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
    const hasCachedSession = this.hasCachedSession(workspaceId, agentSessionId);
    const inlineApplied =
      hasCachedSession &&
      this.applyInlineActivityUpdatedEvent({
        agentSessionId,
        data: input.data,
        eventType: input.eventType,
        workspaceId
      });
    this.controllerEntry(workspaceId).engine.dispatch({
      agentSessionId,
      eventType: input.eventType,
      hasCachedSession,
      hasInlineMessages: hasInlineMessagesData(input.data),
      inlineApplied,
      type: "session/activityObserved",
      workspaceId
    });
  }

  private scheduleAgentActivityUpdate(input: {
    data?: unknown;
    agentSessionId: string;
    eventType: string;
    workspaceId: string;
  }): void {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    if (!agentSessionId) {
      return;
    }
    void this.reconcileAgentActivityUpdate({
      ...input,
      agentSessionId,
      workspaceId
    });
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
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
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
    const reconciledMessages =
      entry.controller.getSnapshot().sessionMessagesById[agentSessionId] ??
      page.messages;
    this.emitSessionEvent(
      workspaceId,
      hostStatePatchEventFromSession(session, reconciledMessages)
    );
  }

  private async executeSessionReconcileCommand(command: {
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
        void this.dependencies.runtimeApi.logTerminalDiagnostic({
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
      void this.dependencies.runtimeApi.logTerminalDiagnostic({
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
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
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
    if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
      return;
    }
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
    const messages =
      this.controllerEntry(workspaceId).controller.getSnapshot()
        .sessionMessagesById[agentSessionId] ?? [];
    this.emitSessionEvent(
      workspaceId,
      hostStatePatchEventFromSession(session, messages)
    );
  }

  private applyInlineActivityUpdatedEvent(input: {
    agentSessionId: string;
    data: unknown;
    eventType: string;
    workspaceId: string;
  }): boolean {
    if (this.isSessionTombstoned(input.workspaceId, input.agentSessionId)) {
      return true;
    }
    const entry = this.controllerEntry(input.workspaceId);
    const result = entry.controller.applyActivityUpdatedEvent({
      agentSessionId: input.agentSessionId,
      data: input.data,
      eventType: input.eventType,
      workspaceId: input.workspaceId
    });
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
        ),
        statePatch: agentActivityStatePatchReconcileDiagnosticDetails(
          result.statePatch
        )
      }
    });
    for (const message of result.messages) {
      this.emitSessionEvent(
        input.workspaceId,
        hostMessageEventFromCore(message)
      );
    }
    if (result.statePatch) {
      this.emitSessionEvent(input.workspaceId, {
        data: result.statePatch,
        eventType: "state_patch"
      });
    }
    return true;
  }
}

function reportAgentSubmitTraceDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">,
  input: {
    agentSessionId: string | null;
    event: string;
    metadata: Record<string, unknown> | undefined;
    workspaceId: string;
    provider?: string | null;
    fields?: Record<string, unknown>;
  }
): void {
  const clientSubmitId = stringMetadata(input.metadata, "clientSubmitId");
  if (!clientSubmitId) {
    return;
  }
  const submittedAtUnixMs = numberMetadata(
    input.metadata,
    "clientSubmittedAtUnixMs"
  );
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details: {
          agentSessionId: input.agentSessionId,
          clientSubmitId,
          clientSubmittedAtUnixMs: submittedAtUnixMs,
          elapsedSinceClientSubmitMs:
            submittedAtUnixMs > 0
              ? Math.max(0, Date.now() - submittedAtUnixMs)
              : null,
          provider: input.provider ?? null,
          traceEvent: input.event,
          ...(input.fields ?? {})
        },
        event: "agent.submit.trace",
        level: "info",
        workspaceId: input.workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect agent submission.
  }
}

function agentActivitySessionReconcileDiagnosticDetails(
  session: AgentActivitySession | null
): Record<string, unknown> | null {
  if (!session) {
    return null;
  }
  return {
    activeTurnId: session.turnLifecycle?.activeTurnId ?? null,
    agentSessionId: session.agentSessionId,
    currentPhase: session.currentPhase ?? null,
    lastEventUnixMs: session.lastEventUnixMs ?? null,
    messageVersion: session.messageVersion ?? null,
    outcome: session.turnLifecycle?.outcome ?? null,
    provider: session.provider,
    status: session.status ?? null,
    submitAvailabilityReason: session.submitAvailability?.reason ?? null,
    submitAvailabilityState: session.submitAvailability?.state ?? null,
    turnPhase: session.turnLifecycle?.phase ?? null,
    updatedAtUnixMs: session.updatedAtUnixMs ?? null
  };
}

function agentActivityStatePatchReconcileDiagnosticDetails(
  patch: AgentActivityStatePatch | null
): Record<string, unknown> | null {
  if (!patch) {
    return null;
  }
  return {
    activeTurnId: patch.turn?.activeTurnId ?? null,
    agentSessionId: patch.agentSessionId,
    currentPhase: patch.currentPhase ?? null,
    lastEventUnixMs: patch.lastEventUnixMs ?? patch.occurredAtUnixMs ?? null,
    outcome: patch.turn?.outcome ?? null,
    provider: patch.provider ?? null,
    status: patch.lifecycleStatus ?? null,
    submitAvailabilityReason:
      patch.submitAvailability?.reason ??
      patch.turn?.submitAvailability?.reason ??
      null,
    submitAvailabilityState:
      patch.submitAvailability?.state ??
      patch.turn?.submitAvailability?.state ??
      null,
    topLevelSubmitAvailabilityState: patch.submitAvailability?.state ?? null,
    turnId: patch.turn?.turnId ?? null,
    turnPhase: patch.turn?.phase ?? null,
    turnSubmitAvailabilityState: patch.turn?.submitAvailability?.state ?? null,
    updatedAtUnixMs: patch.occurredAtUnixMs ?? null
  };
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): number {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function normalizeWorkspaceId(workspaceId: string): string {
  return workspaceId.trim() || "__default__";
}

function isWorkspaceAgentSessionNotFoundError(error: unknown): boolean {
  const normalized = normalizeTuttidError(error);
  return (
    normalized?.code === "workspace_not_found" &&
    normalized.reason === "workspace_agent_session_not_found"
  );
}

function latestMessageVersion(
  messages: readonly AgentActivityMessage[]
): number {
  return messages.reduce(
    (latest, message) => Math.max(latest, message.version),
    0
  );
}

function reconcileAfterVersion(
  messages: readonly AgentActivityMessage[]
): number {
  if (messages.length === 0 || hasUserMessage(messages)) {
    return latestMessageVersion(messages);
  }
  if (hasAgentOutputMessage(messages)) {
    return 0;
  }
  return latestMessageVersion(messages);
}

function hasInlineMessagesData(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { messages?: unknown }).messages)
  );
}

function hasUserMessage(messages: readonly AgentActivityMessage[]): boolean {
  return messages.some(
    (message) => message.role.trim().toLowerCase() === "user"
  );
}

function hasAgentOutputMessage(
  messages: readonly AgentActivityMessage[]
): boolean {
  return messages.some((message) => {
    const role = message.role.trim().toLowerCase();
    const kind = message.kind.trim().toLowerCase();
    return role === "assistant" || role === "agent" || kind === "tool_call";
  });
}

function hostStatePatchEventFromSession(
  session: AgentActivitySession,
  messages: readonly AgentActivityMessage[] = []
): unknown {
  const inferredTurnState = inferActiveTurnState(session, messages);
  return {
    data: {
      agentSessionId: session.agentSessionId,
      currentPhase:
        inferredTurnState?.phase ?? session.currentPhase ?? undefined,
      cwd: session.cwd,
      lastError: session.lastError ?? undefined,
      lifecycleStatus: session.status,
      model: session.model ?? undefined,
      occurredAtUnixMs:
        session.lastEventUnixMs ??
        session.updatedAtUnixMs ??
        session.createdAtUnixMs ??
        Date.now(),
      provider: session.provider,
      providerSessionId: session.providerSessionId ?? undefined,
      runtimeContext: session.runtimeContext ?? undefined,
      ...(session.pendingInteractive !== undefined
        ? { pendingInteractive: session.pendingInteractive }
        : {}),
      title: session.title,
      ...(inferredTurnState
        ? {
            turn: {
              phase: inferredTurnState.phase,
              turnId: inferredTurnState.turnId
            }
          }
        : {}),
      workspaceId: session.workspaceId
    },
    eventType: "state_patch"
  };
}

function hostMessageEventFromCore(message: AgentActivityMessage): unknown {
  return {
    data: {
      agentSessionId: message.agentSessionId,
      completedAtUnixMs: message.completedAtUnixMs,
      kind: message.kind,
      messageId: message.messageId,
      occurredAtUnixMs: message.occurredAtUnixMs,
      payload: message.payload,
      role: message.role,
      seq: message.version,
      version: message.version,
      startedAtUnixMs: message.startedAtUnixMs,
      status: message.status ?? undefined,
      turnId: message.turnId,
      workspaceId: message.workspaceId
    },
    eventType: "message_update"
  };
}

function withNoProjectRuntimeContext<T extends AgentActivityCreateSessionInput>(
  input: T,
  workspaceUserProjectService:
    | Pick<IWorkspaceUserProjectService, "isNoProjectPath">
    | undefined
): T {
  const cwd = input.cwd?.trim() ?? "";
  const noProject =
    !cwd || workspaceUserProjectService?.isNoProjectPath(cwd) === true;
  if (!noProject) {
    return input;
  }
  return {
    ...input,
    runtimeContext: {
      ...(input.runtimeContext ?? {}),
      noProject: true
    }
  };
}

function inferActiveTurnState(
  session: AgentActivitySession,
  messages: readonly AgentActivityMessage[]
): { phase: "waiting" | "working"; turnId: string } | null {
  if (isTerminalSessionStatus(session.status)) {
    return null;
  }
  const latestMessage = latestMessageWithTurn(messages);
  const turnId = latestMessage?.turnId?.trim() ?? "";
  if (!latestMessage || !turnId) {
    return null;
  }
  const turnMessages = messages.filter(
    (message) => message.turnId?.trim() === turnId
  );
  if (
    turnMessages.some(
      (message) => normalizeStatus(message.status) === "waiting"
    )
  ) {
    return { phase: "waiting", turnId };
  }
  if (
    turnMessages.some((message) =>
      ["running", "streaming", "working"].includes(
        normalizeStatus(message.status)
      )
    )
  ) {
    return { phase: "working", turnId };
  }
  if (latestMessage.role.trim().toLowerCase() === "user") {
    return { phase: "working", turnId };
  }
  return null;
}

function latestMessageWithTurn(
  messages: readonly AgentActivityMessage[]
): AgentActivityMessage | null {
  return messages.reduce<AgentActivityMessage | null>((latest, message) => {
    if (!message.turnId?.trim()) {
      return latest;
    }
    if (!latest) {
      return message;
    }
    return compareMessageOrder(message, latest) > 0 ? message : latest;
  }, null);
}

function compareMessageOrder(
  left: AgentActivityMessage,
  right: AgentActivityMessage
): number {
  return (
    left.version - right.version ||
    (left.occurredAtUnixMs ?? 0) - (right.occurredAtUnixMs ?? 0)
  );
}

function isTerminalSessionStatus(status: string): boolean {
  return ["canceled", "completed", "failed"].includes(normalizeStatus(status));
}

function normalizeStatus(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? "";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
