import type {
  AgentActivityAdapter,
  AgentActivityGoalControlResult,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type {
  Client,
  CollaborationRun,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import {
  cancelCollaborationRun,
  createCollaborationRun,
  normalizeTuttidError,
  retryCollaborationRun,
  setCollaborationRunAdoption
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/index.ts";
import { agentActivitySessionFromTuttidSession } from "../desktopAgentActivityAdapter.ts";
import { reportAgentSubmitTraceDiagnostic } from "../desktopAgentRuntimeSubmitDiagnostics.ts";
import type { IWorkspaceAgentActivityService } from "../workspaceAgentActivityService.interface.ts";
import {
  agentSessionActivationError,
  normalizeComposerSettings,
  resolveComposerPermissionMode
} from "./desktopAgentHostProjection.ts";
import { normalizeWorkspaceId } from "./workspaceAgentActivityDiagnostics.ts";

interface WorkspaceAgentActivityMutationCommandTarget {
  adapter: AgentActivityAdapter;
}

export interface WorkspaceAgentActivityMutationOperationsDependencies {
  getSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<AgentActivitySession>;
  hostFilesApi?: Pick<
    DesktopHostFilesApi,
    "createUserDocumentsProjectDirectory"
  >;
  load(workspaceId: string, signal?: AbortSignal): Promise<unknown>;
  markSessionDeleted(input: {
    agentSessionId: string;
    data?: unknown;
    workspaceId: string;
  }): void;
  resolveCollaborationClient(): Promise<Client>;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  sessionCommandTarget(
    workspaceId: string
  ): WorkspaceAgentActivityMutationCommandTarget;
  tuttidClient: TuttidClient;
  upsertAuthoritativeSession(
    session: AgentActivitySession,
    source: string
  ): void;
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "rememberNoProjectPath"
  >;
}

export class WorkspaceAgentActivityMutationOperations {
  private readonly dependencies: WorkspaceAgentActivityMutationOperationsDependencies;

  constructor(
    dependencies: WorkspaceAgentActivityMutationOperationsDependencies
  ) {
    this.dependencies = dependencies;
  }

  async deleteSessionsBatch(
    input: Parameters<IWorkspaceAgentActivityService["deleteSessionsBatch"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["deleteSessionsBatch"]> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const response =
      await this.dependencies.tuttidClient.deleteWorkspaceAgentSessionsBatch(
        workspaceId,
        { sessionIds: input.sessionIds },
        { signal: input.signal }
      );
    const removedSessionIds = response.removedSessionIds
      .map((id) => id.trim())
      .filter(Boolean);
    for (const agentSessionId of removedSessionIds) {
      this.dependencies.markSessionDeleted({
        agentSessionId,
        data: { deletedAtUnixMs: Date.now() },
        workspaceId
      });
    }
    if (removedSessionIds.length > 0) {
      await this.dependencies.load(workspaceId, input.signal);
    }
    return {
      removedMessages: response.removedMessages,
      removedSessionIds,
      removedSessions: response.removedSessions
    };
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
    this.dependencies.upsertAuthoritativeSession(activitySession, "pin_result");
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
    const target = this.dependencies.sessionCommandTarget(input.workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: input.agentSessionId?.trim() ?? null,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.create.adapter_requested",
      provider: null,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId: input.workspaceId,
      fields: { agentTargetId: input.agentTargetId ?? null }
    });
    const session = await target.adapter.createSession(input);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId: session.agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.create.adapter_resolved",
      provider: session.provider,
      submitDiagnostics: input.submitDiagnostics,
      workspaceId: input.workspaceId,
      fields: { activeTurnPhase: session.activeTurn?.phase ?? null }
    });
    this.dependencies.upsertAuthoritativeSession(
      session,
      "create_session_result"
    );
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
      session = await this.dependencies.getSession(
        workspaceId,
        requestedAgentSessionId
      );
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
        automationRuleOverride: input.automationRuleOverride ?? null,
        capabilityRefs: input.capabilityRefs ?? null,
        cwd: resolvedCwd?.cwd ?? null,
        initialContent: input.initialContent ?? [],
        initialDisplayPrompt: input.initialDisplayPrompt ?? null,
        initialTuttiModeActivation: input.initialTuttiModeActivation ?? null,
        submitDiagnostics: input.submitDiagnostics,
        model: input.settings?.model ?? null,
        modelPlanId: input.settings?.modelPlanId ?? null,
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
    const target = this.dependencies.sessionCommandTarget(workspaceId);
    reportAgentSubmitTraceDiagnostic(this.dependencies.runtimeApi, {
      agentSessionId,
      clientSubmitId: input.clientSubmitId,
      event: "activity_service.send.adapter_requested",
      submitDiagnostics: input.submitDiagnostics,
      workspaceId
    });
    const result = await target.adapter.sendInput({ ...input, workspaceId });
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
    this.dependencies.upsertAuthoritativeSession(
      result.session,
      "send_input_result"
    );
    return result;
  }

  async cancelTurn(input: {
    agentSessionId: string;
    turnId: string;
    workspaceId: string;
  }): Promise<
    import("@tutti-os/agent-activity-core").AgentActivityTurnCancelResponse
  > {
    return this.dependencies.tuttidClient.cancelWorkspaceAgentTurn(
      normalizeWorkspaceId(input.workspaceId),
      input.agentSessionId,
      input.turnId
    );
  }

  async startModelConsult(
    input: Parameters<
      NonNullable<IWorkspaceAgentActivityService["startModelConsult"]>
    >[0]
  ): ReturnType<
    NonNullable<IWorkspaceAgentActivityService["startModelConsult"]>
  > {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const client = await this.dependencies.resolveCollaborationClient();
    const response = await createCollaborationRun({
      body: {
        contextText: input.contextText?.trim() || undefined,
        mode: "consult",
        model: input.model,
        modelPlanId: input.modelPlanId,
        question: input.question,
        sourceSessionId: input.agentSessionId,
        triggerReason: "composer_consult",
        triggerSource: "user"
      },
      client,
      path: { workspaceID: workspaceId },
      signal: input.signal
    });
    return agentActivityCollaborationRunFromTuttid(
      unwrapCollaborationData(response, "Model consult request failed.")
    );
  }

  async startAgentCollaboration(
    input: Parameters<
      NonNullable<IWorkspaceAgentActivityService["startAgentCollaboration"]>
    >[0]
  ): ReturnType<
    NonNullable<IWorkspaceAgentActivityService["startAgentCollaboration"]>
  > {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const client = await this.dependencies.resolveCollaborationClient();
    const response = await createCollaborationRun({
      body: {
        contextScope: input.contextScope,
        contextText: input.contextText?.trim() || undefined,
        mode: input.mode,
        model: input.model?.trim() || undefined,
        modelPlanId: input.modelPlanId?.trim() || undefined,
        question: input.question,
        sourceSessionId: input.agentSessionId,
        targetAgentTargetId: input.targetAgentTargetId,
        triggerReason: input.triggerReason?.trim() || "composer_agent_mention",
        triggerSource: "user"
      },
      client,
      path: { workspaceID: workspaceId },
      signal: input.signal
    });
    return agentActivityCollaborationRunFromTuttid(
      unwrapCollaborationData(response, "Agent collaboration request failed.")
    );
  }

  async setCollaborationAdoption(
    input: Parameters<
      NonNullable<IWorkspaceAgentActivityService["setCollaborationAdoption"]>
    >[0]
  ): ReturnType<
    NonNullable<IWorkspaceAgentActivityService["setCollaborationAdoption"]>
  > {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const client = await this.dependencies.resolveCollaborationClient();
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

  async cancelCollaboration(
    input: Parameters<
      NonNullable<IWorkspaceAgentActivityService["cancelCollaboration"]>
    >[0]
  ): ReturnType<
    NonNullable<IWorkspaceAgentActivityService["cancelCollaboration"]>
  > {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const client = await this.dependencies.resolveCollaborationClient();
    const response = await cancelCollaborationRun({
      client,
      path: {
        collaborationRunID: input.runId,
        workspaceID: workspaceId
      },
      signal: input.signal
    });
    return agentActivityCollaborationRunFromTuttid(
      unwrapCollaborationData(response, "Collaboration cancel request failed.")
    );
  }

  async retryCollaboration(
    input: Parameters<
      NonNullable<IWorkspaceAgentActivityService["retryCollaboration"]>
    >[0]
  ): ReturnType<
    NonNullable<IWorkspaceAgentActivityService["retryCollaboration"]>
  > {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const client = await this.dependencies.resolveCollaborationClient();
    const response = await retryCollaborationRun({
      client,
      path: {
        collaborationRunID: input.runId,
        workspaceID: workspaceId
      },
      signal: input.signal
    });
    return agentActivityCollaborationRunFromTuttid(
      unwrapCollaborationData(response, "Collaboration retry request failed.")
    );
  }

  async setAutomationRuleOverride(
    input: Parameters<
      NonNullable<IWorkspaceAgentActivityService["setAutomationRuleOverride"]>
    >[0]
  ): ReturnType<
    NonNullable<IWorkspaceAgentActivityService["setAutomationRuleOverride"]>
  > {
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
    const target = this.dependencies.sessionCommandTarget(input.workspaceId);
    const result = await target.adapter.goalControl(input);
    this.dependencies.upsertAuthoritativeSession(
      result.session,
      "goal_control_result"
    );
    return result;
  }

  async submitInteractive(
    input: Parameters<AgentActivityAdapter["submitInteractive"]>[0]
  ): ReturnType<IWorkspaceAgentActivityService["submitInteractive"]> {
    return this.dependencies
      .sessionCommandTarget(input.workspaceId)
      .adapter.submitInteractive(input);
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
    const target = this.dependencies.sessionCommandTarget(workspaceId);
    const result = await target.adapter.deleteSession(input);
    if (result.removed) {
      this.dependencies.markSessionDeleted({
        agentSessionId,
        data: { deletedAtUnixMs: Date.now() },
        workspaceId
      });
      await this.dependencies.load(workspaceId, input.signal);
    }
    return result;
  }

  async renameSession(
    input: Parameters<AgentActivityAdapter["renameSession"]>[0]
  ): Promise<AgentActivitySession> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const agentSessionId = input.agentSessionId.trim();
    const target = this.dependencies.sessionCommandTarget(workspaceId);
    const session = await target.adapter.renameSession({
      ...input,
      agentSessionId,
      workspaceId
    });
    this.dependencies.upsertAuthoritativeSession(
      session,
      "rename_session_result"
    );
    return session;
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

  updateTuttiModeActivation(
    input: Parameters<AgentActivityRuntime["updateTuttiModeActivation"]>[0]
  ): ReturnType<AgentActivityRuntime["updateTuttiModeActivation"]> {
    return this.dependencies
      .sessionCommandTarget(input.workspaceId)
      .adapter.updateTuttiModeActivation(input);
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
}

export function unwrapCollaborationData<TResult>(
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
  attempt: number;
  completedAtUnixMs: number | null;
  contextScope: string | null;
  durationMs: number | null;
  cost: { currency: string; estimatedMicros: number } | null;
  failureReason: string | null;
  failureStage: string | null;
  id: string;
  mode: CollaborationRun["mode"];
  model: string | null;
  modelPlanId: string | null;
  resultText: string | null;
  retryOfRunId: string | null;
  sourceSessionId: string | null;
  startedAtUnixMs: number | null;
  status: CollaborationRun["status"];
  targetAgentTargetId: string | null;
  targetSessionId: string | null;
  triggerReason: string | null;
  triggerSource: CollaborationRun["triggerSource"];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
  workspaceId: string;
} {
  return {
    adoption: run.adoption,
    attempt: run.attempt,
    completedAtUnixMs: unixMsFromIsoTimestamp(run.completedAt),
    contextScope: run.contextScope ?? null,
    durationMs: run.durationMs ?? null,
    cost: run.cost
      ? {
          currency: run.cost.currency,
          estimatedMicros: run.cost.estimatedMicros
        }
      : null,
    failureReason: run.failureReason ?? null,
    failureStage: run.failureStage ?? null,
    id: run.id,
    mode: run.mode,
    model: run.model ?? null,
    modelPlanId: run.modelPlanId ?? null,
    resultText: run.resultText ?? null,
    retryOfRunId: run.retryOfRunId ?? null,
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
          outputTokens: run.usage.outputTokens,
          cacheReadTokens: run.usage.cacheReadTokens,
          cacheWriteTokens: run.usage.cacheWriteTokens
        }
      : null,
    workspaceId: run.workspaceId
  };
}

function unixMsFromIsoTimestamp(
  value: string | null | undefined
): number | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
