import {
  type AgentActivityAdapter,
  type AgentActivityGoalControlResult,
  type AgentActivityController,
  type AgentActivityMessagePage,
  type AgentActivitySession,
  type AgentSessionEngine,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import { agentActivitySessionFromTuttidSession } from "../desktopAgentActivityAdapter.ts";
import {
  agentSessionActivationError,
  normalizeComposerSettings,
  resolveComposerPermissionMode,
  resolveDesktopAgentGUIProvider
} from "./desktopAgentHostProjection.ts";
import type {
  IWorkspaceAgentActivityService,
  WorkspaceAgentActivityListMessagesInput
} from "../workspaceAgentActivityService.interface.ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import {
  createWorkspaceAgentSessionEngineHost,
  type WorkspaceAgentSessionEngineHost
} from "./workspaceAgentSessionEngineHost.ts";
import { WorkspaceAgentActivityReconcileBridge } from "./workspaceAgentActivityReconcileBridge.ts";
import {
  agentActivitySessionReconcileDiagnosticDetails,
  normalizeWorkspaceId,
  registerAgentActivityStoreDiagnostics
} from "./workspaceAgentActivityDiagnostics.ts";
import { reportAgentSubmitTraceDiagnostic } from "../desktopAgentRuntimeSubmitDiagnostics.ts";

function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("workspace_reconcile_aborted")
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error("workspace_reconcile_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export interface WorkspaceAgentActivityServiceDependencies {
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi?: Pick<
    DesktopHostFilesApi,
    "createUserDocumentsProjectDirectory" | "selectAppArchive"
  >;
  tuttidClient: TuttidClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  agentProviderStatusService?: Pick<IAgentProviderStatusService, "refresh">;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

type WorkspaceAgentActivityControllerEntry = WorkspaceAgentSessionEngineHost;

export class WorkspaceAgentActivityService
  extends WorkspaceAgentActivityReconcileBridge
  implements IWorkspaceAgentActivityService
{
  readonly _serviceBrand = undefined;

  private readonly dependencies: WorkspaceAgentActivityServiceDependencies;
  private readonly workspaceLoadsInFlight = new Map<
    string,
    Promise<AgentActivitySnapshot>
  >();
  constructor(dependencies: WorkspaceAgentActivityServiceDependencies) {
    super(dependencies);
    // Temporary instrumentation: surface activity-store anomalies (version
    // regressions on unguarded write paths, stale-patch drops) in the desktop
    // log so field exports show which channel overwrote what. The sink slot
    // is process-global, so register once and take the workspace id from the
    // event details (the store stamps it at the emit site) — a per-workspace
    // closure would be overwritten by the next workspace and misattribute
    // diagnostics.
    registerAgentActivityStoreDiagnostics(dependencies.runtimeApi);
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
    const inFlight = this.workspaceLoadsInFlight.get(normalizedWorkspaceId);
    if (inFlight) return waitForPromiseWithSignal(inFlight, signal);

    const entry = this.controllerEntry(normalizedWorkspaceId);
    this.reportReconcileTrace({
      agentSessionId: null,
      traceEvent: "load.requested",
      workspaceId: normalizedWorkspaceId,
      fields: {
        cachedSessionCount: entry.controller.getSnapshot().sessions.length
      }
    });
    if (
      entry.engine.getSnapshot().engineRuntime.workspaceReconcile.status !==
      "loading"
    ) {
      entry.engine.dispatch({
        retry: true,
        type: "workspace/reconcileRequested",
        workspaceId: normalizedWorkspaceId
      });
    }
    const loadPromise = this.waitForWorkspaceReconcile(entry)
      .then((snapshot) => {
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
      })
      .finally(() => {
        if (
          this.workspaceLoadsInFlight.get(normalizedWorkspaceId) === loadPromise
        ) {
          this.workspaceLoadsInFlight.delete(normalizedWorkspaceId);
        }
      });
    this.workspaceLoadsInFlight.set(normalizedWorkspaceId, loadPromise);
    return waitForPromiseWithSignal(loadPromise, signal);
  }

  private waitForWorkspaceReconcile(
    entry: WorkspaceAgentActivityControllerEntry
  ): Promise<AgentActivitySnapshot> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const settle = () => {
        const reconcile =
          entry.engine.getSnapshot().engineRuntime.workspaceReconcile;
        if (reconcile.status === "ready") {
          unsubscribe();
          resolve(entry.controller.getSnapshot());
        } else if (
          reconcile.status === "failed" ||
          reconcile.status === "unknown"
        ) {
          unsubscribe();
          reject(
            new Error(
              reconcile.errorMessage ??
                reconcile.errorCode ??
                "workspace_reconcile_failed"
            )
          );
        }
      };
      unsubscribe = entry.engine.subscribe(settle);
      settle();
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

  async countSessionSection(
    input: Parameters<IWorkspaceAgentActivityService["countSessionSection"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["countSessionSection"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.countWorkspaceAgentSessionSection(
        workspaceId,
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          sectionKey: input.sectionKey
        },
        { signal: input.signal }
      );
    return {
      agentTargetId: response.agentTargetId,
      count: response.count,
      sectionKey: response.sectionKey,
      workspaceId: response.workspaceId
    };
  }

  async deleteSessionSection(
    input: Parameters<IWorkspaceAgentActivityService["deleteSessionSection"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["deleteSessionSection"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.deleteWorkspaceAgentSessionSection(
        workspaceId,
        {
          agentTargetId: input.agentTargetId?.trim() || undefined,
          sectionKey: input.sectionKey
        },
        { signal: input.signal }
      );
    const entry = this.controllerEntry(workspaceId);
    const removedSessionIds = response.removedSessionIds
      .map((id) => id.trim())
      .filter(Boolean);
    for (const agentSessionId of removedSessionIds) {
      this.markSessionDeleted({
        agentSessionId,
        data: { deletedAtUnixMs: Date.now() },
        workspaceId
      });
    }
    if (removedSessionIds.length > 0) {
      await entry.controller.load(input.signal);
      for (const agentSessionId of removedSessionIds) {
        if (this.isSessionTombstoned(workspaceId, agentSessionId)) {
          entry.controller.removeSession(agentSessionId);
        }
      }
    }
    return {
      agentTargetId: response.agentTargetId,
      removedMessages: response.removedMessages,
      removedSessionIds,
      removedSessions: response.removedSessions,
      sectionKey: response.sectionKey,
      workspaceId: response.workspaceId
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

  async selectExternalSessionImportArchive(): Promise<string | null> {
    return (await this.dependencies.hostFilesApi?.selectAppArchive()) ?? null;
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

  async createSession(
    input: Parameters<AgentActivityAdapter["createSession"]>[0]
  ): Promise<AgentActivitySession> {
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: input.agentSessionId?.trim() ?? null,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.create.entered",
      provider: null,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId: input.workspaceId,
      fields: { agentTargetId: input.agentTargetId ?? null }
    });
    const entry = this.controllerEntry(input.workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: input.agentSessionId?.trim() ?? null,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.create.adapter_requested",
      provider: null,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId: input.workspaceId,
      fields: { agentTargetId: input.agentTargetId ?? null }
    });
    const session = await entry.adapter.createSession(input);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: session.agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.create.adapter_resolved",
      provider: session.provider,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId: input.workspaceId,
      fields: { activeTurnPhase: session.activeTurn?.phase ?? null }
    });
    this.upsertAuthoritativeSession(session, "create_session_result");
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: session.agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.create.resolved",
      provider: session.provider,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId: input.workspaceId,
      fields: { activeTurnPhase: session.activeTurn?.phase ?? null }
    });
    return session;
  }

  async activateSession(
    input: Parameters<AgentActivityRuntime["activateSession"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["activateSession"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const requestedAgentSessionId = input.agentSessionId.trim();
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: requestedAgentSessionId,
      clientSubmitId: input.mode === "new" ? input.clientSubmitId : null,
      event: "activity_service.activate.entered",
      provider: null,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId,
      fields: { agentTargetId: input.agentTargetId ?? null, mode: input.mode }
    });
    if (input.mode === "new") {
      reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
        agentSessionId: requestedAgentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "activity_service.activate.cwd_resolve_requested",
        provider: null,
        submitDiagnostics: input.submitDiagnostics,
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
        clientSubmitId: input.clientSubmitId,
        event: "activity_service.activate.cwd_resolved",
        provider: null,
        submitDiagnostics: input.submitDiagnostics,
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
        clientSubmitId: input.clientSubmitId,
        event: "activity_service.activate.create_requested",
        provider: null,
        submitDiagnostics: input.submitDiagnostics,
        workspaceId,
        fields: { agentTargetId: input.agentTargetId ?? null }
      });
      session = await this.createSession({
        clientSubmitId: input.clientSubmitId,
        workspaceId,
        agentSessionId: requestedAgentSessionId,
        agentTargetId: input.agentTargetId,
        cwd: resolvedCwd?.cwd ?? null,
        initialContent: input.initialContent ?? [],
        initialDisplayPrompt: input.initialDisplayPrompt ?? null,
        submitDiagnostics: input.submitDiagnostics,
        model: input.settings?.model ?? null,
        planMode: input.settings?.planMode ?? null,
        permissionModeId: resolveComposerPermissionMode(input.settings),
        reasoningEffort: input.settings?.reasoningEffort ?? null,
        ...(resolvedCwd?.noProject ? { noProject: true } : {}),
        speed: input.settings?.speed ?? null,
        title: input.title ?? null,
        visible: input.visible ?? true,
        signal: input.signal
      });
      reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
        agentSessionId: session.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "activity_service.activate.create_resolved",
        provider: session.provider,
        submitDiagnostics: input.submitDiagnostics,
        workspaceId,
        fields: { activeTurnPhase: session.activeTurn?.phase ?? null }
      });
    }
    const activationError = agentSessionActivationError(session);
    const activationFailed = activationError !== undefined;
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: session.agentSessionId,
      clientSubmitId: input.mode === "new" ? input.clientSubmitId : null,
      event: "activity_service.activate.resolved",
      provider: session.provider,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId,
      fields: {
        mode: input.mode,
        activeTurnPhase: session.activeTurn?.phase ?? null,
        latestTurnOutcome: session.latestTurn?.outcome ?? null
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
      session
    };
  }

  async sendInput(
    input: Parameters<AgentActivityAdapter["sendInput"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["sendInput"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.send.entered",
      submitDiagnostics: input.submitDiagnostics,
      workspaceId
    });
    const entry = this.controllerEntry(workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.send.adapter_requested",
      submitDiagnostics: input.submitDiagnostics,
      workspaceId
    });
    const result = await entry.adapter.sendInput({
      ...input,
      workspaceId
    });
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.send.adapter_resolved",
      provider: result.session.provider,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId,
      fields: {
        turnOutcome: result.turn.outcome ?? null,
        turnId: result.turnId,
        turnPhase: result.turn.phase
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
  ): ReturnType<IWorkspaceAgentActivityService["submitInteractive"]> {
    return this.controllerEntry(input.workspaceId).adapter.submitInteractive(
      input
    );
  }

  async submitPlanDecision(
    input: Parameters<IWorkspaceAgentActivityService["submitPlanDecision"]>[0]
  ) {
    return this.dependencies.tuttidClient.submitWorkspaceAgentPlanDecision(
      input.workspaceId,
      input.agentSessionId,
      input.turnId,
      input.requestId,
      {
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        promptKind: input.promptKind
      }
    );
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
    agentTargetId: string;
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
      targetKey: input.agentTargetId,
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
    const session =
      await this.dependencies.tuttidClient.updateWorkspaceAgentSessionSettings(
        input.workspaceId,
        input.agentSessionId,
        normalizeComposerSettings(input.settings)
      );
    const settings = session.settings
      ? normalizeComposerSettings(session.settings)
      : normalizeComposerSettings(input.settings);
    return {
      agentSessionId: input.agentSessionId,
      settings,
      session: agentActivitySessionFromTuttidSession(input.workspaceId, session)
    };
  }

  unactivateSession(
    input: Parameters<AgentActivityRuntime["unactivateSession"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["unactivateSession"]> {
    return Promise.resolve({
      agentSessionId: input.agentSessionId,
      buffered: false
    });
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
    if (trimmed !== "/") return { cwd: trimmed, noProject: false };
    const response =
      await this.dependencies.tuttidClient.listWorkspaceFileDirectory(
        input.workspaceId,
        {}
      );
    return { cwd: response.root, noProject: false };
  }

  protected createControllerEntry(
    workspaceId: string
  ): WorkspaceAgentActivityControllerEntry {
    return createWorkspaceAgentSessionEngineHost({
      activateSession: (input) => this.activateSession(input),
      cancelTurn: (input) => this.cancelTurn(input),
      reconcileSession: (command) =>
        this.executeSessionReconcileCommand(command),
      runtimeApi: this.dependencies.runtimeApi,
      sendInput: (input) => this.sendInput(input),
      submitInteractive: (input) => this.submitInteractive(input),
      submitPlanDecision: (input) => this.submitPlanDecision(input),
      subscribeSessionEvents: (workspaceId, listener) =>
        this.onSessionEvent(workspaceId, listener),
      tuttidClient: this.dependencies.tuttidClient,
      unactivateSession: (input) => this.unactivateSession(input),
      updateSessionSettings: (input) => this.updateSessionSettings(input),
      workspaceId
    });
  }
}
