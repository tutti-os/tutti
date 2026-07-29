import type {
  AgentSessionActivateEffectInput,
  AgentSessionEffectPort,
  AgentActivityCancelTurnInput,
  AgentActivitySendInput,
  AgentActivitySession,
  AgentActivitySessionDetailSnapshot,
  AgentActivitySessionSettings,
  AgentActivitySubmitInteractiveInput,
  AgentSessionEngine,
  EngineEffectOptions,
  EngineExtensionCommand,
  SessionReconcileCommand
} from "@tutti-os/agent-activity-core";
import {
  agentActivityComposerOptionsFromTuttidResult,
  agentActivitySessionFromTuttidSession,
  agentActivityTurnFromTuttidTurn
} from "@tutti-os/agent-activity-tuttid-adapter";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { mobileLocale } from "../i18n";
import { toTuttidPromptContent } from "./workspaceActivityCommandSupport";

interface WorkspaceActivityEngineCommandContext {
  client: TuttidClient;
  engine: AgentSessionEngine;
  mapSession(
    session: Parameters<typeof agentActivitySessionFromTuttidSession>[1]
  ): AgentActivitySession;
  mapSessionDetail(
    expectedAgentSessionId: string,
    detail: Awaited<ReturnType<TuttidClient["getWorkspaceAgentSession"]>>
  ): AgentActivitySessionDetailSnapshot;
  reconcileSession(
    command: SessionReconcileCommand,
    signal?: AbortSignal
  ): Promise<unknown>;
  reconcileWorkspace(): Promise<unknown>;
}

export function createWorkspaceActivityEffectPort(
  getContext: () => WorkspaceActivityEngineCommandContext
): AgentSessionEffectPort {
  return {
    activateSession: (input, options) =>
      activateSession(getContext(), input, options?.signal),
    cancelTurn: (input, options) =>
      cancelTurn(getContext(), input, options?.signal),
    deleteSessions: (input, options) =>
      deleteSessions(getContext(), input, options?.signal),
    respondToInteraction: (input, options) =>
      respondToInteraction(getContext(), input, options?.signal),
    sendInput: (input, options) =>
      sendPrompt(getContext(), input, options?.signal),
    setSessionPinned: (input, options) =>
      setSessionPinned(getContext(), input, options?.signal),
    updateSessionSettings: (input, options) =>
      updateSessionSettings(getContext(), input, options?.signal)
  };
}

export function executeWorkspaceActivityExtensionCommand(
  context: WorkspaceActivityEngineCommandContext,
  command: EngineExtensionCommand,
  options?: EngineEffectOptions
): Promise<unknown> {
  const signal = options?.signal;
  switch (command.type) {
    case "engine/probe":
      return Promise.resolve({ ok: true });
    case "engine/reconcileWorkspace":
      return context.reconcileWorkspace();
    case "session/reconcile":
      return context.reconcileSession(command, signal);
    case "composerOptions/load":
      return context.client
        .getAgentProviderComposerOptions(
          command.provider as Parameters<
            TuttidClient["getAgentProviderComposerOptions"]
          >[0],
          {
            agentTargetId: command.targetKey,
            ...(command.cwd ? { cwd: command.cwd } : {}),
            locale: mobileLocale,
            workspaceId: command.workspaceId,
            settings: command.settings ?? {}
          },
          { signal }
        )
        .then((result) =>
          agentActivityComposerOptionsFromTuttidResult(command.provider, result)
        );
    case "attention/readState/read":
    case "attention/readState/write":
    case "session/ackForkObserved":
    case "session/forkThroughTurn":
    case "session/unactivate":
    case "tuttiMode/update":
    // Mobile does not expose edit and retry yet. Keep this explicit so the
    // shared Engine command union cannot silently reach the exhaustive case.
    case "turn/editRetry":
    case "turn/recoverEditRetry":
      return Promise.reject(
        new Error(`unsupported mobile agent command: ${command.type}`)
      );
    default:
      return assertNeverEngineCommand(command);
  }
}

function assertNeverEngineCommand(command: never): never {
  throw new Error(
    `unhandled mobile agent command: ${(command as { type?: unknown }).type}`
  );
}

async function activateSession(
  context: WorkspaceActivityEngineCommandContext,
  input: AgentSessionActivateEffectInput,
  signal?: AbortSignal
): Promise<unknown> {
  if (input.mode === "existing") {
    if (signal?.aborted) throw signal.reason;
    const detail = await context.client.getWorkspaceAgentSession(
      input.workspaceId,
      input.agentSessionId,
      undefined,
      ...requestOptionsArgs(signal)
    );
    const mapped = context.mapSessionDetail(input.agentSessionId, detail);
    context.engine.dispatch({
      ...mapped,
      type: "session/detailSnapshotReceived",
      workspaceId: input.workspaceId
    });
    return {
      activation: { mode: "existing", status: "already_attached" },
      session: mapped.session
    };
  }
  const session = await context.client.createWorkspaceAgentSession(
    input.workspaceId,
    {
      agentSessionId: input.agentSessionId,
      agentTargetId: input.agentTargetId,
      ...(input.capabilityRefs?.length
        ? {
            capabilityRefs: input.capabilityRefs.map((reference) => ({
              ...reference
            }))
          }
        : {}),
      clientSubmitId: input.clientSubmitId,
      cwd: input.cwd ?? null,
      initialContent: toTuttidPromptContent(input.initialContent ?? []),
      initialDisplayPrompt: input.initialDisplayPrompt ?? null,
      ...(input.initialTuttiModeActivation
        ? {
            initialTuttiModeActivation: {
              ...input.initialTuttiModeActivation
            }
          }
        : {}),
      ...(input.railPlacement
        ? { railPlacement: { ...input.railPlacement } }
        : {}),
      ...(input.settings?.model ? { model: input.settings.model } : {}),
      ...(input.settings?.reasoningEffort
        ? { reasoningEffort: input.settings.reasoningEffort }
        : {}),
      ...(input.settings?.speed ? { speed: input.settings.speed } : {}),
      ...(input.settings?.permissionModeId
        ? { permissionModeId: input.settings.permissionModeId }
        : {}),
      ...(typeof input.settings?.planMode === "boolean"
        ? { planMode: input.settings.planMode }
        : {}),
      ...(typeof input.settings?.browserUse === "boolean"
        ? { browserUse: input.settings.browserUse }
        : {}),
      submitDiagnostics: input.submitDiagnostics,
      title: input.title ?? null,
      visible: input.visible ?? true
    },
    { signal }
  );
  const activitySession = context.mapSession(session);
  context.engine.dispatch({
    session: activitySession,
    type: "session/upserted"
  });
  return {
    activation: { mode: "new", status: "attached" },
    session: activitySession
  };
}

function cancelTurn(
  context: WorkspaceActivityEngineCommandContext,
  input: AgentActivityCancelTurnInput,
  signal?: AbortSignal
): Promise<unknown> {
  return context.client
    .cancelWorkspaceAgentTurn(
      input.workspaceId,
      input.agentSessionId,
      input.turnId,
      ...requestOptionsArgs(signal)
    )
    .then((response) => ({
      ...response,
      ...(response.turn
        ? { turn: agentActivityTurnFromTuttidTurn(response.turn) }
        : {})
    }));
}

function deleteSessions(
  context: WorkspaceActivityEngineCommandContext,
  input: {
    agentSessionIds: readonly string[];
    workspaceId: string;
  },
  signal?: AbortSignal
): Promise<unknown> {
  return context.client
    .deleteWorkspaceAgentSessionsBatch(
      input.workspaceId,
      { sessionIds: [...input.agentSessionIds] },
      ...requestOptionsArgs(signal)
    )
    .then((response) => ({
      cleanupFailedSessionIds: response.cleanupFailedSessionIds,
      removedMessages: response.removedMessages,
      removedSessionIds: response.removedSessionIds,
      removedSessions: response.removedSessions
    }));
}

function respondToInteraction(
  context: WorkspaceActivityEngineCommandContext,
  input: AgentActivitySubmitInteractiveInput,
  signal?: AbortSignal
): Promise<unknown> {
  return context.client
    .submitWorkspaceAgentInteractive(
      input.workspaceId,
      input.agentSessionId,
      input.requestId,
      {
        action: input.action ?? null,
        optionId: input.optionId ?? null,
        payload: input.payload ?? null,
        turnId: input.turnId
      },
      ...requestOptionsArgs(signal)
    )
    .then((session) => ({ session: context.mapSession(session) }));
}

function setSessionPinned(
  context: WorkspaceActivityEngineCommandContext,
  input: {
    agentSessionId: string;
    pinned: boolean;
    workspaceId: string;
  },
  signal?: AbortSignal
): Promise<unknown> {
  return context.client
    .updateWorkspaceAgentSessionPin(
      input.workspaceId,
      input.agentSessionId,
      { pinned: input.pinned },
      ...requestOptionsArgs(signal)
    )
    .then((session) => ({ session: context.mapSession(session) }));
}

function updateSessionSettings(
  context: WorkspaceActivityEngineCommandContext,
  input: {
    agentSessionId: string;
    settings: AgentActivitySessionSettings;
    workspaceId: string;
  },
  signal?: AbortSignal
): Promise<unknown> {
  return context.client
    .updateWorkspaceAgentSessionSettings(
      input.workspaceId,
      input.agentSessionId,
      input.settings,
      ...requestOptionsArgs(signal)
    )
    .then((session) => {
      const activitySession = context.mapSession(session);
      return {
        agentSessionId: input.agentSessionId,
        session: activitySession,
        settings: activitySession.settings
      };
    });
}

async function sendPrompt(
  context: WorkspaceActivityEngineCommandContext,
  input: AgentActivitySendInput,
  signal?: AbortSignal
): Promise<unknown> {
  const result = await context.client.sendWorkspaceAgentSessionInput(
    input.workspaceId,
    input.agentSessionId,
    {
      ...(input.capabilityRefs?.length
        ? {
            capabilityRefs: input.capabilityRefs.map((reference) => ({
              ...reference
            }))
          }
        : {}),
      clientSubmitId: input.clientSubmitId,
      content: toTuttidPromptContent(input.content),
      displayPrompt: input.displayPrompt ?? null,
      guidance: input.guidance ?? false,
      submitDiagnostics: input.submitDiagnostics
    },
    ...requestOptionsArgs(signal)
  );
  if (result.kind === "goalControl") {
    return {
      kind: "goalControl",
      goal: result.goal ?? result.session.goal ?? null,
      session: context.mapSession(result.session)
    };
  }
  return {
    kind: "turn",
    session: context.mapSession(result.session),
    turn: agentActivityTurnFromTuttidTurn(result.turn),
    turnId: result.turnId
  };
}

function requestOptionsArgs(
  signal: AbortSignal | undefined
): [] | [{ signal: AbortSignal }] {
  return signal === undefined ? [] : [{ signal }];
}
