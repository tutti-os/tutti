import type {
  AgentActivitySendInput,
  AgentActivitySession,
  AgentActivitySessionDetailSnapshot,
  AgentSessionEngine,
  EngineExternalCommand,
  SessionActivateCommand,
  SessionReconcileCommand
} from "@tutti-os/agent-activity-core";
import { executeAgentActivityPromptCommand } from "@tutti-os/agent-activity-core";
import {
  agentActivityComposerOptionsFromTuttidResult,
  agentActivitySessionFromTuttidSession,
  agentActivityTurnFromTuttidTurn
} from "@tutti-os/agent-activity-tuttid-adapter";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { mobileLocale } from "../i18n";
import { toTuttidPromptContent } from "./workspaceActivityCommandSupport";

interface WorkspaceActivityCommandContext {
  client: TuttidClient;
  engine: AgentSessionEngine;
  loadComposerOptions(options?: { force?: boolean }): void;
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

export function executeWorkspaceActivityCommand(
  context: WorkspaceActivityCommandContext,
  command: EngineExternalCommand,
  signal?: AbortSignal
): Promise<unknown> {
  switch (command.type) {
    case "engine/probe":
      return Promise.resolve({ ok: true });
    case "engine/reconcileWorkspace":
      return context.reconcileWorkspace();
    case "session/activate":
      return activateSession(context, command, signal);
    case "queue/sendPrompt":
      return executeAgentActivityPromptCommand(
        {
          sendInput: (input) => sendPrompt(context, input),
          updateSessionSettings: (input) =>
            context.client.updateWorkspaceAgentSessionSettings(
              input.workspaceId,
              input.agentSessionId,
              input.settings
            )
        },
        command
      );
    case "turn/cancel":
      return context.client
        .cancelWorkspaceAgentTurn(
          command.workspaceId,
          command.agentSessionId,
          command.turnId
        )
        .then((response) => ({
          ...response,
          ...(response.turn
            ? { turn: agentActivityTurnFromTuttidTurn(response.turn) }
            : {})
        }));
    case "interaction/respond":
      return context.client
        .submitWorkspaceAgentInteractive(
          command.workspaceId,
          command.agentSessionId,
          command.requestId,
          {
            action: command.action ?? null,
            optionId: command.optionId ?? null,
            payload: command.payload ?? null,
            turnId: command.turnId
          }
        )
        .then((session) => ({ session: context.mapSession(session) }));
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
    case "session/updateSettings":
      return context.client
        .updateWorkspaceAgentSessionSettings(
          command.workspaceId,
          command.agentSessionId,
          command.settings
        )
        .then((session) => {
          const activitySession = context.mapSession(session);
          context.engine.dispatch({
            session: activitySession,
            type: "session/upserted"
          });
          const options = activitySession.agentTargetId
            ? context.engine.getSnapshot().composerOptions.optionsByTargetKey[
                activitySession.agentTargetId
              ]
            : null;
          if (options?.behavior.refreshModelOptionsAfterSettings === true) {
            context.loadComposerOptions({ force: true });
          }
          return { session: activitySession };
        });
    case "session/setPinned":
      return context.client
        .updateWorkspaceAgentSessionPin(
          command.workspaceId,
          command.agentSessionId,
          { pinned: command.pinned }
        )
        .then((session) => ({ session: context.mapSession(session) }));
    case "sessions/delete":
      return context.client
        .deleteWorkspaceAgentSessionsBatch(
          command.workspaceId,
          { sessionIds: [...command.agentSessionIds] },
          { signal }
        )
        .then((response) => ({
          cleanupFailedSessionIds: response.cleanupFailedSessionIds,
          removedMessages: response.removedMessages,
          removedSessionIds: response.removedSessionIds,
          removedSessions: response.removedSessions
        }));
    case "attention/readState/read":
    case "attention/readState/write":
    case "plan/submitDecision":
    case "session/ackForkObserved":
    case "session/forkThroughTurn":
    case "session/unactivate":
    case "tuttiMode/update":
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
  context: WorkspaceActivityCommandContext,
  command: SessionActivateCommand,
  signal?: AbortSignal
): Promise<unknown> {
  if (command.mode === "existing") {
    if (signal?.aborted) throw signal.reason;
    const detail = await context.client.getWorkspaceAgentSession(
      command.workspaceId,
      command.agentSessionId
    );
    const mapped = context.mapSessionDetail(command.agentSessionId, detail);
    context.engine.dispatch({
      ...mapped,
      type: "session/detailSnapshotReceived",
      workspaceId: command.workspaceId
    });
    return {
      activation: { mode: "existing", status: "already_attached" },
      session: mapped.session
    };
  }
  const session = await context.client.createWorkspaceAgentSession(
    command.workspaceId,
    {
      agentSessionId: command.agentSessionId,
      agentTargetId: command.agentTargetId,
      clientSubmitId: command.clientSubmitId,
      cwd: command.cwd ?? null,
      initialContent: toTuttidPromptContent(command.initialContent ?? []),
      initialDisplayPrompt: command.initialDisplayPrompt ?? null,
      ...(command.settings?.model ? { model: command.settings.model } : {}),
      ...(command.settings?.reasoningEffort
        ? { reasoningEffort: command.settings.reasoningEffort }
        : {}),
      ...(command.settings?.speed ? { speed: command.settings.speed } : {}),
      ...(command.settings?.permissionModeId
        ? { permissionModeId: command.settings.permissionModeId }
        : {}),
      ...(typeof command.settings?.planMode === "boolean"
        ? { planMode: command.settings.planMode }
        : {}),
      ...(typeof command.settings?.browserUse === "boolean"
        ? { browserUse: command.settings.browserUse }
        : {}),
      submitDiagnostics: command.submitDiagnostics,
      title: command.title ?? null,
      visible: command.visible ?? true
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

async function sendPrompt(
  context: WorkspaceActivityCommandContext,
  input: AgentActivitySendInput
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
    }
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
