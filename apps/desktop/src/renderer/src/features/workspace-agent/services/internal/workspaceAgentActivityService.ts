import {
  dispatchSessionMutation,
  type AgentActivityAdapter,
  type AgentActivityGoalControlResult,
  type AgentActivityMessagePage,
  type AgentActivitySession,
  type AgentSessionEngine,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type {
  Client,
  CollaborationRun,
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import {
  createClient,
  normalizeTuttidError,
  setCollaborationRunAdoption
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
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
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
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
import { reportAgentSubmitTraceDiagnostic } from "../desktopAgentRuntimeSubmitDiagnostics.ts";
import { WorkspaceAgentActivityAnalytics } from "./workspaceAgentActivityAnalytics.ts";
import { WorkspaceAgentActivityQueryOperations } from "./workspaceAgentActivityQueryOperations.ts";
import { WorkspaceAgentActivityImportOperations } from "./workspaceAgentActivityImportOperations.ts";
import { loadWorkspaceAgentComposerOptions } from "./workspaceAgentComposerOptions.ts";
import { WorkspaceAgentActivityMutationOperations } from "./workspaceAgentActivityMutationOperations.ts";

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
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic"> &
    Partial<Pick<DesktopRuntimeApi, "getBackendConfig">>;
  agentProviderStatusService?: Pick<IAgentProviderStatusService, "refresh">;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
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
  private composerOptionsCommandSequence = 1;
  private sessionMutationSequence = 1;
  // Collaboration-run/model-plan requests are not part of the TuttidClient
  // wrapper yet, so they call the generated SDK directly. The client is
  // re-resolved from the backend config on every call (cached per endpoint)
  // because the managed daemon can restart onto a new ephemeral port.
  private collaborationClientCache: {
    accessToken: string;
    baseUrl: string;
    client: Client;
  } | null = null;
  constructor(dependencies: WorkspaceAgentActivityServiceDependencies) {
    super(dependencies);
    this.dependencies = dependencies;
    this.analytics = new WorkspaceAgentActivityAnalytics({
      reporterNow: dependencies.reporterNow,
      reporterService: dependencies.reporterService,
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
      getSession: (workspaceId, agentSessionId) =>
        this.getSession(workspaceId, agentSessionId),
      hostFilesApi: dependencies.hostFilesApi,
      load: (workspaceId, signal) => this.load(workspaceId, signal),
      markSessionDeleted: (input) => this.markSessionDeleted(input),
      runtimeApi: dependencies.runtimeApi,
      sessionCommandTarget: (workspaceId) => ({
        adapter: this.entry(workspaceId).adapter
      }),
      tuttidClient: dependencies.tuttidClient,
      upsertAuthoritativeSession: (session, source) =>
        this.upsertAuthoritativeSession(session, source),
      workspaceUserProjectService: dependencies.workspaceUserProjectService
    });
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
    const entry = this.entry(workspaceId);
    return entry.engine.subscribe(() =>
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
            type: "message/snapshotReceived",
            workspaceId
          });
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
    const mutation = await dispatchSessionMutation(
      this.entry(workspaceId).engine,
      {
        agentSessionIds: input.sessionIds,
        mutationId: this.nextSessionMutationId("delete"),
        timeoutMs: 30_000,
        type: "sessions/deleteRequested",
        workspaceId
      }
    );
    if (mutation.kind !== "delete" || !mutation.deleteResult) {
      throw new Error("workspace_agent_delete_result_missing");
    }
    return {
      cleanupFailedSessionIds: [
        ...mutation.deleteResult.cleanupFailedSessionIds
      ],
      removedMessages: mutation.deleteResult.removedMessages,
      removedSessionIds: [...mutation.deleteResult.removedSessionIds],
      removedSessions: mutation.deleteResult.removedSessions
    };
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
    const agentSessionId = input.agentSessionId.trim();
    await dispatchSessionMutation(this.entry(workspaceId).engine, {
      agentSessionId,
      mutationId: this.nextSessionMutationId("pin"),
      pinned: input.pinned,
      timeoutMs: 30_000,
      type: "session/pinRequested",
      workspaceId
    });
    const activitySession = this.getSnapshot(workspaceId).sessions.find(
      (session) => session.agentSessionId === agentSessionId
    );
    if (!activitySession) {
      throw new Error("workspace_agent_pin_result_missing");
    }
    return activitySession;
  }

  async createSession(
    input: Parameters<AgentActivityAdapter["createSession"]>[0]
  ): Promise<AgentActivitySession> {
    return this.mutationOperations.createSession(input);
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
        fields: {
          agentTargetId: input.agentTargetId ?? null,
          hasInitialTuttiModeActivation:
            input.initialTuttiModeActivation != null
        }
      });
      session = await this.createSession({
        clientSubmitId: input.clientSubmitId,
        workspaceId,
        agentSessionId: requestedAgentSessionId,
        agentTargetId: input.agentTargetId,
        capabilityRefs: input.capabilityRefs ?? null,
        cwd: resolvedCwd?.cwd ?? null,
        initialContent: input.initialContent ?? [],
        initialDisplayPrompt: input.initialDisplayPrompt ?? null,
        initialTuttiModeActivation: input.initialTuttiModeActivation ?? null,
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
        status: input.mode === "existing" ? "already_attached" : "attached"
      },
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
    const entry = this.entry(workspaceId);
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
    const client = await this.resolveCollaborationClient();
    const response = await setCollaborationRunAdoption({
      body: { adoption: input.adoption },
      client,
      path: {
        collaborationRunID: input.runId,
        workspaceID: workspaceId
      },
      signal: input.signal
    });
    return agentActivityCollaborationRunFromTuttid(
      unwrapCollaborationData(
        response,
        "Collaboration adoption request failed."
      )
    );
  }

  private async resolveCollaborationClient(): Promise<Client> {
    const getBackendConfig = this.dependencies.runtimeApi.getBackendConfig;
    if (!getBackendConfig) {
      throw new Error(
        "Collaboration requests are unavailable: backend config resolver is missing."
      );
    }
    const config = await getBackendConfig();
    const cached = this.collaborationClientCache;
    if (
      cached &&
      cached.baseUrl === config.baseUrl &&
      cached.accessToken === config.accessToken
    ) {
      return cached.client;
    }
    const client = createClient({
      auth: config.accessToken,
      baseUrl: config.baseUrl,
      fetch: globalThis.fetch.bind(globalThis)
    });
    this.collaborationClientCache = {
      accessToken: config.accessToken,
      baseUrl: config.baseUrl,
      client
    };
    return client;
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
    return this.mutationOperations.renameSession(input);
  }

  async getSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<AgentActivitySession> {
    const detail = await this.fetchActivitySessionDetail(
      workspaceId,
      agentSessionId,
      "get_session"
    );
    this.upsertAuthoritativeSessionDetail(detail, "get_session_result");
    return detail.session;
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
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const entry = this.entry(workspaceId);
    return loadWorkspaceAgentComposerOptions({
      agentTargetId: input.agentTargetId,
      commandId: `composer-options:${this.composerOptionsCommandSequence++}`,
      engine: entry.engine,
      provider,
      cwd: input.cwd,
      force: input.force,
      settings: normalizeComposerSettings(input.settings),
      signal: input.signal,
      workspaceId
    });
  }

  async updateSessionSettings(input: {
    agentSessionId: string;
    settings: Parameters<typeof normalizeComposerSettings>[0];
    workspaceId: string;
  }): ReturnType<IWorkspaceAgentActivityService["updateSessionSettings"]> {
    return this.mutationOperations.updateSessionSettings(input);
  }

  updateTuttiModeActivation(
    input: Parameters<AgentActivityRuntime["updateTuttiModeActivation"]>[0]
  ): ReturnType<AgentActivityRuntime["updateTuttiModeActivation"]> {
    return this.mutationOperations.updateTuttiModeActivation(input);
  }

  unactivateSession(
    input: Parameters<AgentActivityRuntime["unactivateSession"]>[0]
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
      activateSession: async (input) => {
        const activation = await this.activateSession(input);
        this.analytics.trackEngineActivation(input, activation);
        return activation;
      },
      cancelTurn: (input) => this.cancelTurn(input),
      reconcileSession: (command) =>
        this.executeSessionReconcileCommand(command),
      runtimeApi: this.dependencies.runtimeApi,
      sendInput: async (input) => {
        const result = await this.sendInput(input);
        this.analytics.trackEngineSend(input, result);
        return result;
      },
      submitInteractive: (input) => this.submitInteractive(input),
      submitPlanDecision: (input) => this.submitPlanDecision(input),
      subscribeSessionEvents: (workspaceId, listener) =>
        this.onSessionEvent(workspaceId, listener),
      tuttidClient: this.dependencies.tuttidClient,
      unactivateSession: (input) => this.unactivateSession(input),
      updateSessionSettings: (input) => this.updateSessionSettings(input),
      updateTuttiModeActivation: (input) =>
        this.updateTuttiModeActivation(input),
      workspaceId
    });
  }

  private nextSessionMutationId(kind: "delete" | "pin"): string {
    const sequence = this.sessionMutationSequence++;
    return `${kind}:${Date.now()}:${sequence}`;
  }
}

// Local equivalent of the TuttidClient unwrap helper for direct generated-SDK
// calls: normalize protocol errors, otherwise fall back to the caller message.
function unwrapCollaborationData<TResult>(
  response: { data?: TResult; error?: unknown; response?: Response },
  fallback: string
): TResult {
  if (response.error !== undefined) {
    throw (
      normalizeTuttidError(response.error, response.response?.status ?? 0) ??
      new Error(fallback)
    );
  }
  if (response.data === undefined) {
    throw new Error(fallback);
  }
  return response.data;
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
