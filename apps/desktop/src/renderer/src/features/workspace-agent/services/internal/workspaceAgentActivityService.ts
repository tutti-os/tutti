import {
  agentActivitySessionMessageWindowFromDescendingPage,
  type AgentActivityAdapter,
  type AgentActivityComposerOptions,
  type AgentActivityGoalControlResult,
  type AgentActivityMessagePage,
  type AgentActivitySession,
  type AgentActivitySessionDetailSnapshot,
  type AgentSessionActivateEffectResult,
  type AgentSessionEngine,
  type AgentActivitySnapshot,
  type EngineEffectOptions,
  type EngineExternalCommand,
  type EngineIntent
} from "@tutti-os/agent-activity-core";
import type {
  AgentProviderStatusListResponse,
  CollaborationRun,
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { DesktopWorkspaceUiMode } from "@shared/preferences";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  normalizeComposerSettings,
  resolveComposerPermissionMode,
  resolveDesktopAgentGUIProvider
} from "./desktopAgentHostProjection.ts";
import type {
  IWorkspaceAgentActivityService,
  WorkspaceAgentActivityListMessagesInput
} from "../workspaceAgentActivityService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import {
  createWorkspaceAgentSessionEngineHost,
  type WorkspaceAgentSessionEngineHost
} from "./workspaceAgentSessionEngineHost.ts";
import { WorkspaceAgentActivityReconcileBridge } from "./workspaceAgentActivityReconcileBridge.ts";
import {
  agentActivitySessionReconcileDiagnosticDetails,
  normalizeWorkspaceId
} from "./workspaceAgentActivityDiagnostics.ts";
import { WorkspaceAgentActivityAnalytics } from "./workspaceAgentActivityAnalytics.ts";
import { WorkspaceAgentActivityQueryOperations } from "./workspaceAgentActivityQueryOperations.ts";
import { WorkspaceAgentActivityImportOperations } from "./workspaceAgentActivityImportOperations.ts";
import { WorkspaceAgentActivityMutationOperations } from "./workspaceAgentActivityMutationOperations.ts";
import {
  logAgentComposerSettingsDiagnostic,
  reportAgentSubmitTraceDiagnostic
} from "../desktopAgentRuntimeSubmitDiagnostics.ts";
import { reportAgentSessionSettingsChanges } from "./agentSessionSettingsAnalytics.ts";
import { AgentSessionReplayActivityBridge } from "../../../agent-session-replay/services/agentSessionReplayActivityBridge.ts";

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
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  forceRefreshAgentProviderStatuses?: (
    providers: WorkspaceAgentProvider[]
  ) => Promise<AgentProviderStatusListResponse | null>;
  resolveAgentTargetProvider?: (
    agentTargetId: string
  ) => WorkspaceAgentProvider | null;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
  sessionReplayEnabled?: boolean;
  uiMode?: DesktopWorkspaceUiMode;
}

type WorkspaceAgentActivityEntry = WorkspaceAgentSessionEngineHost;

export class WorkspaceAgentActivityService
  extends WorkspaceAgentActivityReconcileBridge
  implements IWorkspaceAgentActivityService
{
  readonly _serviceBrand = undefined;

  private readonly analytics: WorkspaceAgentActivityAnalytics;
  private readonly dependencies: WorkspaceAgentActivityServiceDependencies;
  private readonly importOperations: WorkspaceAgentActivityImportOperations;
  private readonly mutationOperations: WorkspaceAgentActivityMutationOperations;
  private readonly queryOperations: WorkspaceAgentActivityQueryOperations;
  private readonly workspaceLoadsInFlight = new Map<
    string,
    Promise<AgentActivitySnapshot>
  >();
  private readonly sessionReplayActivityBridge: AgentSessionReplayActivityBridge;
  constructor(dependencies: WorkspaceAgentActivityServiceDependencies) {
    super(dependencies);
    this.dependencies = dependencies;
    this.sessionReplayActivityBridge = new AgentSessionReplayActivityBridge({
      enabled: dependencies.sessionReplayEnabled,
      tuttidClient: dependencies.tuttidClient
    });
    this.analytics = new WorkspaceAgentActivityAnalytics({
      forceRefreshAgentProviderStatuses:
        dependencies.forceRefreshAgentProviderStatuses,
      reporterNow: dependencies.reporterNow,
      reporterService: dependencies.reporterService,
      resolveAgentTargetProvider: dependencies.resolveAgentTargetProvider,
      workspaceUserProjectService: dependencies.workspaceUserProjectService
    });
    this.queryOperations = new WorkspaceAgentActivityQueryOperations(
      dependencies.tuttidClient
    );
    this.importOperations = new WorkspaceAgentActivityImportOperations({
      hostFilesApi: dependencies.hostFilesApi,
      refreshActivity: (workspaceId) => this.load(workspaceId),
      refreshUserProjects: () =>
        this.dependencies.workspaceUserProjectService?.refresh(),
      tuttidClient: dependencies.tuttidClient
    });
    this.mutationOperations = new WorkspaceAgentActivityMutationOperations({
      runtimeApi: dependencies.runtimeApi,
      sessionCommandTarget: (workspaceId) => ({
        adapter: this.entry(workspaceId).commandAdapter
      }),
      tuttidClient: dependencies.tuttidClient,
      upsertAuthoritativeSession: (session, source) =>
        this.upsertAuthoritativeSession(session, source)
    });
  }

  armNextSessionRecording(workspaceId: string, recordingId: string): void {
    this.sessionReplayActivityBridge.armNextSessionRecording(
      workspaceId,
      recordingId
    );
  }

  clearNextSessionRecording(workspaceId: string, recordingId?: string): void {
    this.sessionReplayActivityBridge.clearNextSessionRecording(
      workspaceId,
      recordingId
    );
  }

  startSessionActivityEventRecording(
    workspaceId: string,
    recordingId: string
  ): void {
    this.sessionReplayActivityBridge.startSessionActivityEventRecording(
      workspaceId,
      recordingId
    );
  }

  sealSessionActivityEventRecording(
    workspaceId: string,
    recordingId: string
  ): Promise<void> {
    return this.sessionReplayActivityBridge.sealSessionActivityEventRecording(
      workspaceId,
      recordingId
    );
  }

  discardSessionActivityEventRecording(
    workspaceId: string,
    recordingId: string
  ): void {
    this.sessionReplayActivityBridge.discardSessionActivityEventRecording(
      workspaceId,
      recordingId
    );
  }

  addSessionEngineActivityObserver(
    workspaceId: string,
    observer: {
      observeCommand(command: EngineExternalCommand): void;
      observeIntent(intent: EngineIntent): void;
    }
  ): () => void {
    return this.sessionReplayActivityBridge.addSessionEngineActivityObserver(
      workspaceId,
      observer
    );
  }

  private takeNextSessionRecording(workspaceId: string): string | null {
    return this.sessionReplayActivityBridge.takePendingSessionRecording(
      workspaceId
    );
  }

  private restoreNextSessionRecording(
    workspaceId: string,
    recordingId: string
  ): void {
    this.sessionReplayActivityBridge.restorePendingSessionRecording(
      workspaceId,
      recordingId
    );
  }

  getSnapshot(workspaceId: string): AgentActivitySnapshot {
    return this.activitySnapshot(workspaceId);
  }

  getSessionEngine(workspaceId: string): AgentSessionEngine {
    return this.entry(workspaceId).engine;
  }

  subscribe(
    workspaceId: string,
    listener: (snapshot: AgentActivitySnapshot) => void
  ): () => void {
    return this.subscribeActivitySnapshot(workspaceId, () =>
      listener(this.activitySnapshot(workspaceId))
    );
  }

  load(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<AgentActivitySnapshot> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const inFlight = this.workspaceLoadsInFlight.get(normalizedWorkspaceId);
    if (inFlight) return waitForPromiseWithSignal(inFlight, signal);

    const entry = this.entry(normalizedWorkspaceId);
    this.reportReconcileTrace({
      agentSessionId: null,
      traceEvent: "load.requested",
      workspaceId: normalizedWorkspaceId,
      fields: {
        cachedSessionCount: this.activitySnapshot(normalizedWorkspaceId)
          .sessions.length
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
    entry: WorkspaceAgentActivityEntry
  ): Promise<AgentActivitySnapshot> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const settle = () => {
        const reconcile =
          entry.engine.getSnapshot().engineRuntime.workspaceReconcile;
        if (reconcile.status === "ready") {
          unsubscribe();
          resolve(this.activitySnapshot(entry.engine.identity.workspaceId));
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
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const entry = this.entry(workspaceId);
    return entry.adapter
      .listSessionMessages({
        workspaceId,
        agentSessionId: input.agentSessionId,
        afterVersion: input.afterVersion,
        beforeVersion: input.beforeVersion,
        limit: input.limit,
        order: input.order,
        signal: input.signal
      })
      .then((page) => {
        if (input.cache !== false) {
          entry.engine.dispatch({
            messages: page.messages,
            ...(input.order === "desc"
              ? {
                  sessionMessageWindows: [
                    {
                      agentSessionId: input.agentSessionId,
                      ...agentActivitySessionMessageWindowFromDescendingPage(
                        page
                      )
                    }
                  ]
                }
              : {}),
            type: "message/snapshotReceived",
            workspaceId
          });
          this.reconcileOptimisticMessages(workspaceId, input.agentSessionId);
        }
        return page;
      });
  }

  async listAgentGeneratedFiles(
    input: Parameters<
      IWorkspaceAgentActivityService["listAgentGeneratedFiles"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listAgentGeneratedFiles"]> {
    return this.queryOperations.listAgentGeneratedFiles(input);
  }

  async listSessionsPage(
    input: Parameters<IWorkspaceAgentActivityService["listSessionsPage"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionsPage"]> {
    return this.queryOperations.listSessionsPage(input);
  }

  async listSessionSections(
    input: Parameters<IWorkspaceAgentActivityService["listSessionSections"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionSections"]> {
    return this.queryOperations.listSessionSections(input);
  }

  async listPinnedSessionsPage(
    input: Parameters<
      IWorkspaceAgentActivityService["listPinnedSessionsPage"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listPinnedSessionsPage"]> {
    return this.queryOperations.listPinnedSessionsPage(input);
  }

  async listSessionSectionPage(
    input: Parameters<
      IWorkspaceAgentActivityService["listSessionSectionPage"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["listSessionSectionPage"]> {
    return this.queryOperations.listSessionSectionPage(input);
  }

  async listSessionSectionDeletionCandidates(
    input: Parameters<
      IWorkspaceAgentActivityService["listSessionSectionDeletionCandidates"]
    >[0]
  ): ReturnType<
    IWorkspaceAgentActivityService["listSessionSectionDeletionCandidates"]
  > {
    return this.queryOperations.listSessionSectionDeletionCandidates(input);
  }

  async deleteSessionsBatch(
    input: Parameters<IWorkspaceAgentActivityService["deleteSessionsBatch"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["deleteSessionsBatch"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    return this.entry(workspaceId).engine.deleteSessions({
      agentSessionIds: input.sessionIds,
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  async scanExternalSessionImports(
    workspaceId: string,
    request?: Parameters<
      IWorkspaceAgentActivityService["scanExternalSessionImports"]
    >[1]
  ): ReturnType<IWorkspaceAgentActivityService["scanExternalSessionImports"]> {
    return this.importOperations.scan(workspaceId, request);
  }

  async importExternalSessions(
    workspaceId: string,
    request: Parameters<
      IWorkspaceAgentActivityService["importExternalSessions"]
    >[1]
  ): ReturnType<IWorkspaceAgentActivityService["importExternalSessions"]> {
    return this.importOperations.import(workspaceId, request);
  }

  async selectExternalSessionImportArchive(): Promise<string | null> {
    return this.importOperations.selectArchive();
  }

  async setSessionPinned(input: {
    agentSessionId: string;
    pinned: boolean;
    workspaceId: string;
  }): Promise<AgentActivitySession> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    return this.entry(workspaceId).engine.setSessionPinned({
      agentSessionId: input.agentSessionId,
      pinned: input.pinned
    });
  }

  async createSession(
    input: Parameters<AgentActivityAdapter["createSession"]>[0]
  ): Promise<AgentActivitySession> {
    const session = await this.executeCreateSessionEffect(input);
    this.upsertAuthoritativeSession(session, "create_session_result");
    return session;
  }

  private async executeCreateSessionEffect(
    input: Parameters<AgentActivityAdapter["createSession"]>[0],
    options?: EngineEffectOptions
  ): Promise<AgentActivitySession> {
    try {
      return options
        ? await this.mutationOperations.executeEngineCreateSession(
            input,
            options
          )
        : await this.mutationOperations.createSession(input);
    } catch (error) {
      this.analytics.trackSessionCreateFailure({
        agentTargetId: input.agentTargetId
      });
      throw error;
    }
  }

  async activateSession(
    input: Parameters<IWorkspaceAgentActivityService["activateSession"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["activateSession"]> {
    const result = await this.executeSessionActivationEffect(input);
    if ("detail" in result) {
      this.upsertAuthoritativeSessionDetail(
        result.detail,
        "get_session_result"
      );
    } else {
      this.upsertAuthoritativeSession(result.session, "create_session_result");
    }
    return result;
  }

  private async executeSessionActivationEffect(
    input: Parameters<IWorkspaceAgentActivityService["activateSession"]>[0],
    options?: EngineEffectOptions
  ): Promise<AgentSessionActivateEffectResult> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const requestedAgentSessionId = input.agentSessionId.trim();
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: requestedAgentSessionId,
      clientSubmitId: input.mode === "new" ? input.clientSubmitId : null,
      event: "activity_service.activate.entered",
      provider: null,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId,
      fields: {
        agentTargetId: input.agentTargetId ?? null,
        hasInitialTuttiModeActivation:
          input.mode === "new" && input.initialTuttiModeActivation != null,
        mode: input.mode
      }
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
    let detail: AgentActivitySessionDetailSnapshot | null = null;
    let session: AgentActivitySession;
    if (input.mode === "existing") {
      detail = await this.fetchActivitySessionDetail(
        workspaceId,
        requestedAgentSessionId,
        "get_session",
        "full",
        input.signal
      );
      session = detail.session;
    } else {
      reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
        agentSessionId: requestedAgentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "activity_service.activate.create_requested",
        provider: null,
        submitDiagnostics: input.submitDiagnostics,
        workspaceId,
        fields: {
          agentTargetId: input.agentTargetId ?? null,
          hasInitialTuttiModeActivation:
            input.initialTuttiModeActivation != null
        }
      });
      session = await this.executeCreateSessionEffect(
        {
          clientSubmitId: input.clientSubmitId,
          workspaceId,
          agentSessionId: requestedAgentSessionId,
          agentTargetId: input.agentTargetId,
          capabilityRefs: input.capabilityRefs ?? null,
          cwd: resolvedCwd?.cwd ?? null,
          ...(input.isolation ? { isolation: input.isolation } : {}),
          initialGoalControl: input.initialGoalControl ?? null,
          initialContent: input.initialContent ?? [],
          initialDisplayPrompt: input.initialDisplayPrompt ?? null,
          initialTuttiModeActivation: input.initialTuttiModeActivation ?? null,
          submitDiagnostics: input.submitDiagnostics,
          ...(typeof input.settings?.browserUse === "boolean"
            ? { browserUse: input.settings.browserUse }
            : {}),
          model: input.settings?.model ?? null,
          planMode: input.settings?.planMode ?? null,
          permissionModeId: resolveComposerPermissionMode(input.settings),
          reasoningEffort: input.settings?.reasoningEffort ?? null,
          ...(resolvedCwd?.noProject ? { noProject: true } : {}),
          ...(input.railPlacement
            ? { railPlacement: { ...input.railPlacement } }
            : {}),
          speed: input.settings?.speed ?? null,
          title: input.title ?? null,
          visible: input.visible ?? true,
          signal: input.signal
        },
        options
      );
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
    if (input.mode === "existing") {
      if (!detail) {
        throw new Error("workspace_agent_activation_detail_missing");
      }
      return {
        activation: { mode: "existing", status: "already_attached" },
        detail,
        session
      };
    }
    return {
      activation: { mode: "new", status: "attached" },
      session
    };
  }

  async sendInput(
    input: Parameters<AgentActivityAdapter["sendInput"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["sendInput"]> {
    const result = await this.executeSendInputEffect(input);
    this.upsertAuthoritativeSession(result.session, "send_input_result");
    return result;
  }

  private async executeSendInputEffect(
    input: Parameters<AgentActivityAdapter["sendInput"]>[0],
    options?: EngineEffectOptions
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
    const entry = this.entry(workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.send.adapter_requested",
      submitDiagnostics: input.submitDiagnostics,
      workspaceId
    });
    const normalizedInput = { ...input, workspaceId };
    const result = options
      ? await entry.commandAdapter.sendInput(normalizedInput, options)
      : await entry.adapter.sendInput(normalizedInput);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.send.adapter_resolved",
      provider: result.session.provider,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId,
      fields:
        result.kind === "goalControl"
          ? { resultKind: "goalControl" }
          : {
              resultKind: "turn",
              turnOutcome: result.turn.outcome ?? null,
              turnId: result.turnId,
              turnPhase: result.turn.phase
            }
    });
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
    signal?: AbortSignal;
    turnId: string;
    workspaceId: string;
  }): Promise<
    import("@tutti-os/agent-activity-core").AgentActivityTurnCancelResponse
  > {
    return this.mutationOperations.cancelTurn(input);
  }

  async setCollaborationAdoption(
    input: Parameters<
      NonNullable<IWorkspaceAgentActivityService["setCollaborationAdoption"]>
    >[0]
  ): ReturnType<
    NonNullable<IWorkspaceAgentActivityService["setCollaborationAdoption"]>
  > {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const run =
      await this.dependencies.tuttidClient.setCollaborationRunAdoption(
        workspaceId,
        input.runId,
        { adoption: input.adoption },
        { signal: input.signal }
      );
    return agentActivityCollaborationRunFromTuttid(run);
  }

  async listAutomationRules(input: {
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<{
    rules: {
      id: string;
      name: string;
      enabled: boolean;
      trigger: string;
      action: string;
    }[];
  }> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.listAutomationRules(workspaceId);
    return {
      rules: response.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        trigger: rule.trigger,
        // The automation domain retired its action split; every rule
        // launches a follow-up session. The runtime summary field stays for
        // contract stability and is no longer populated from the daemon.
        action: ""
      }))
    };
  }

  async getAutomationRuleOverride(input: {
    agentSessionId: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<{
    agentSessionId: string;
    workspaceId: string;
    disabled: boolean;
    ruleIds: string[];
  }> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const override =
      await this.dependencies.tuttidClient.getAgentSessionAutomationRuleOverride(
        workspaceId,
        input.agentSessionId
      );
    return {
      agentSessionId: override.agentSessionId,
      workspaceId: override.workspaceId,
      disabled: override.disabled,
      ruleIds: [...override.ruleIds]
    };
  }

  async setAutomationRuleOverride(input: {
    agentSessionId: string;
    disabled: boolean;
    ruleIds: string[];
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<{
    agentSessionId: string;
    workspaceId: string;
    disabled: boolean;
    ruleIds: string[];
  }> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const override =
      await this.dependencies.tuttidClient.setAgentSessionAutomationRuleOverride(
        workspaceId,
        input.agentSessionId,
        { disabled: input.disabled, ruleIds: [...input.ruleIds] }
      );
    return {
      agentSessionId: override.agentSessionId,
      workspaceId: override.workspaceId,
      disabled: override.disabled,
      ruleIds: [...override.ruleIds]
    };
  }

  async goalControl(
    input: Parameters<AgentActivityAdapter["goalControl"]>[0]
  ): Promise<AgentActivityGoalControlResult> {
    return this.mutationOperations.goalControl(input);
  }

  async submitInteractive(
    input: Parameters<AgentActivityAdapter["submitInteractive"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["submitInteractive"]> {
    return this.mutationOperations.submitInteractive(input);
  }

  async submitPlanDecision(
    input: Parameters<IWorkspaceAgentActivityService["submitPlanDecision"]>[0]
  ) {
    return this.mutationOperations.submitPlanDecision(input);
  }

  async deleteSession(
    input: Parameters<AgentActivityAdapter["deleteSession"]>[0]
  ) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    const result = await this.deleteSessionsBatch({
      sessionIds: [agentSessionId],
      signal: input.signal,
      workspaceId
    });
    return {
      cleanupFailed: result.cleanupFailedSessionIds.includes(agentSessionId),
      removed: result.removedSessionIds.includes(agentSessionId)
    };
  }

  async renameSession(
    input: Parameters<AgentActivityAdapter["renameSession"]>[0]
  ): Promise<AgentActivitySession> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    return this.entry(workspaceId).engine.renameSession({
      agentSessionId: input.agentSessionId,
      ...(input.signal ? { signal: input.signal } : {}),
      title: input.title
    });
  }

  async getSession(
    workspaceId: string,
    agentSessionId: string,
    signal?: AbortSignal
  ): Promise<AgentActivitySession> {
    const detail = await this.fetchActivitySessionDetail(
      workspaceId,
      agentSessionId,
      "get_session",
      "full",
      signal
    );
    this.upsertAuthoritativeSessionDetail(detail, "get_session_result");
    return detail.session;
  }

  async getComposerOptions(input: {
    agentTargetId: string;
    cwd?: string | null;
    force?: boolean;
    waitForFreshModelCatalog?: boolean;
    provider?: string;
    section?: "full" | "core" | "capabilities" | "connectors";
    signal?: AbortSignal;
    settings?: Parameters<typeof normalizeComposerSettings>[0] | null;
    workspaceId: string;
  }): Promise<AgentActivityComposerOptions> {
    const provider = resolveDesktopAgentGUIProvider(input.provider);
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const entry = this.entry(workspaceId);
    return entry.engine.loadComposerOptions({
      cwd: input.cwd,
      force: input.force,
      waitForFreshModelCatalog: input.waitForFreshModelCatalog,
      provider,
      ...(input.section && input.section !== "full"
        ? { section: input.section }
        : {}),
      settings: normalizeComposerSettings(input.settings),
      signal: input.signal,
      targetKey: input.agentTargetId
    });
  }

  async updateSessionSettings(input: {
    agentSessionId: string;
    signal?: AbortSignal;
    settings: Parameters<typeof normalizeComposerSettings>[0];
    workspaceId: string;
  }): ReturnType<IWorkspaceAgentActivityService["updateSessionSettings"]> {
    return this.mutationOperations.updateSessionSettings(input);
  }

  private async executeEngineSessionSettingsUpdate(
    input: Parameters<
      IWorkspaceAgentActivityService["updateSessionSettings"]
    >[0],
    options: EngineEffectOptions
  ): ReturnType<IWorkspaceAgentActivityService["updateSessionSettings"]> {
    const previousState =
      this.getSnapshot(input.workspaceId).sessions.find(
        (session) => session.agentSessionId === input.agentSessionId
      ) ??
      (await this.getSession(
        input.workspaceId,
        input.agentSessionId,
        input.signal
      ));
    const previousSettings = normalizeComposerSettings(
      previousState.settings ?? {}
    );
    logAgentComposerSettingsDiagnostic({
      agentSessionId: input.agentSessionId,
      event: "agent.gui.composer_settings.update_requested",
      nextSettings: input.settings,
      previousSettings,
      provider: previousState.provider,
      runtimeApi: this.dependencies.runtimeApi,
      source: "session",
      workspaceId: input.workspaceId
    });
    let result: Awaited<
      ReturnType<IWorkspaceAgentActivityService["updateSessionSettings"]>
    >;
    try {
      result = await this.mutationOperations.executeEngineUpdateSessionSettings(
        input,
        options
      );
    } catch (error) {
      logAgentComposerSettingsDiagnostic({
        agentSessionId: input.agentSessionId,
        error,
        event: "agent.gui.composer_settings.update_failed",
        nextSettings: input.settings,
        previousSettings,
        provider: previousState.provider,
        runtimeApi: this.dependencies.runtimeApi,
        source: "session",
        workspaceId: input.workspaceId
      });
      throw error;
    }
    const normalizedResult = {
      ...result,
      settings: normalizeComposerSettings(result.settings)
    };
    await reportAgentSessionSettingsChanges({
      agentSessionId: normalizedResult.agentSessionId,
      nextSettings: normalizedResult.settings,
      previousSettings,
      provider: previousState.provider,
      reporterNow: this.dependencies.reporterNow,
      reporterService: this.dependencies.reporterService
    });
    logAgentComposerSettingsDiagnostic({
      agentSessionId: normalizedResult.agentSessionId,
      event: "agent.gui.composer_settings.changed",
      nextSettings: normalizedResult.settings,
      previousSettings,
      provider: previousState.provider,
      runtimeApi: this.dependencies.runtimeApi,
      source: "session",
      workspaceId: input.workspaceId
    });
    return normalizedResult;
  }

  updateTuttiModeActivation(
    input: Parameters<
      IWorkspaceAgentActivityService["updateTuttiModeActivation"]
    >[0]
  ): ReturnType<IWorkspaceAgentActivityService["updateTuttiModeActivation"]> {
    return this.mutationOperations.updateTuttiModeActivation(input);
  }

  unactivateSession(
    input: Parameters<IWorkspaceAgentActivityService["unactivateSession"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["unactivateSession"]> {
    return this.mutationOperations.unactivateSession(input);
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

  protected createEntry(workspaceId: string): WorkspaceAgentActivityEntry {
    return createWorkspaceAgentSessionEngineHost({
      ...(this.dependencies.sessionReplayEnabled
        ? {
            activityEventObserver:
              this.sessionReplayActivityBridge.createSessionEngineActivityObserver(
                workspaceId
              ),
            takePendingSessionRecording: (entryWorkspaceId: string) =>
              this.takeNextSessionRecording(entryWorkspaceId),
            restorePendingSessionRecording: (
              entryWorkspaceId: string,
              recordingId: string
            ) => this.restoreNextSessionRecording(entryWorkspaceId, recordingId)
          }
        : {}),
      executeEngineActivateSession: async (input, options) => {
        try {
          const activation = await this.executeSessionActivationEffect(
            input,
            options
          );
          this.analytics.trackEngineActivation(input, activation);
          return activation;
        } catch (error) {
          this.analytics.trackEngineActivationFailure(input, error);
          throw error;
        }
      },
      executeEngineCancelTurn: (input, options) =>
        this.mutationOperations.executeEngineCancelTurn(input, options),
      executeEngineGoalControl: (input, options) =>
        this.mutationOperations.executeEngineGoalControl(input, options),
      reconcileSession: (command, signal) =>
        this.executeSessionReconcileCommand(command, signal),
      runtimeApi: this.dependencies.runtimeApi,
      uiMode: this.dependencies.uiMode,
      executeEngineSendInput: async (input, options) => {
        try {
          const result = await this.executeSendInputEffect(input, options);
          this.analytics.trackEngineSend(input, result);
          return result;
        } catch (error) {
          this.analytics.trackEngineSendFailure(input, error);
          throw error;
        }
      },
      executeEngineSubmitInteractive: (input, options) =>
        this.mutationOperations.executeEngineSubmitInteractive(input, options),
      executeEngineSubmitPlanDecision: (input, options) =>
        this.mutationOperations.executeEngineSubmitPlanDecision(input, options),
      subscribeSessionEvents: (workspaceId, listener) =>
        this.onSessionEvent(workspaceId, listener),
      tuttidClient: this.dependencies.tuttidClient,
      unactivateSession: (input) => this.unactivateSession(input),
      executeEngineUpdateSessionSettings: (input, options) =>
        this.executeEngineSessionSettingsUpdate(input, options),
      updateTuttiModeActivation: (input) =>
        this.updateTuttiModeActivation(input),
      workspaceId
    });
  }
}

function agentActivityCollaborationRunFromTuttid(run: CollaborationRun): {
  adoption: CollaborationRun["adoption"];
  completedAtUnixMs: number | null;
  contextScope: string | null;
  durationMs: number | null;
  failureReason: string | null;
  id: string;
  mode: CollaborationRun["mode"];
  model: string | null;
  modelPlanId: string | null;
  resultText: string | null;
  sourceSessionId: string | null;
  startedAtUnixMs: number | null;
  status: CollaborationRun["status"];
  targetAgentTargetId: string | null;
  targetSessionId: string | null;
  triggerReason: string | null;
  triggerSource: CollaborationRun["triggerSource"];
  usage: { inputTokens: number; outputTokens: number } | null;
  workspaceId: string;
} {
  return {
    adoption: run.adoption,
    completedAtUnixMs: unixMsFromIsoTimestamp(run.completedAt),
    contextScope: run.contextScope ?? null,
    durationMs: run.durationMs ?? null,
    failureReason: run.failureReason ?? null,
    id: run.id,
    mode: run.mode,
    model: run.model ?? null,
    modelPlanId: run.modelPlanId ?? null,
    resultText: run.resultText ?? null,
    sourceSessionId: run.sourceSessionId ?? null,
    startedAtUnixMs: unixMsFromIsoTimestamp(run.startedAt),
    status: run.status,
    targetAgentTargetId: run.targetAgentTargetId ?? null,
    targetSessionId: run.targetSessionId ?? null,
    triggerReason: run.triggerReason ?? null,
    triggerSource: run.triggerSource,
    usage: run.usage
      ? {
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens
        }
      : null,
    workspaceId: run.workspaceId
  };
}

function unixMsFromIsoTimestamp(
  value: string | null | undefined
): number | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
