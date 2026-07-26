import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  type AgentActivityAdapter,
  type AgentActivityEditRetryInput,
  type AgentActivityRecoverEditRetryInput,
  type AgentActivitySendInput,
  type AgentSessionEngine,
  type EngineExternalCommand,
  type EngineIntent,
  type PlanSubmitDecisionResult,
  type SessionAcknowledgeForkObservedCommand,
  type SessionReconcileCommand,
  type TuttiModeActivationUpdateCommand
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import type { AgentHostAgentSessionComposerSettings } from "@shared/contracts/dto";
import { createDesktopAgentActivityAdapter } from "../desktopAgentActivityAdapter.ts";
import {
  readDesktopWorkspaceAgentReadState,
  writeDesktopWorkspaceAgentReadState
} from "../createDesktopAgentHostApi.ts";

export interface WorkspaceAgentSessionEngineHost {
  adapter: AgentActivityAdapter;
  engine: AgentSessionEngine;
  dispose(): void;
}

export interface WorkspaceAgentSessionEngineActivityObserver {
  observeCommand(command: EngineExternalCommand): void;
  observeIntent(intent: EngineIntent): void;
}

interface CreateWorkspaceAgentSessionEngineHostInput {
  activityEventObserver?: WorkspaceAgentSessionEngineActivityObserver;
  activateSession: AgentActivityRuntime["activateSession"];
  cancelTurn(input: {
    agentSessionId: string;
    signal?: AbortSignal;
    turnId: string;
    workspaceId: string;
  }): Promise<unknown>;
  reconcileSession(
    command: SessionReconcileCommand,
    signal?: AbortSignal
  ): Promise<unknown>;
  editRetry(input: AgentActivityEditRetryInput): Promise<unknown>;
  recoverEditRetry(input: AgentActivityRecoverEditRetryInput): Promise<unknown>;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  takePendingSessionRecording(workspaceId: string): string | null;
  restorePendingSessionRecording(
    workspaceId: string,
    recordingId: string
  ): void;
  sendInput(input: AgentActivitySendInput): Promise<unknown>;
  submitInteractive: AgentActivityRuntime["submitInteractive"];
  submitPlanDecision(input: {
    action: "implement";
    agentSessionId: string;
    idempotencyKey: string;
    promptKind: "plan-implementation";
    requestId: string;
    turnId: string;
    workspaceId: string;
  }): Promise<PlanSubmitDecisionResult>;
  subscribeSessionEvents(
    workspaceId: string,
    listener: (event: unknown) => void
  ): () => void;
  unactivateSession: AgentActivityRuntime["unactivateSession"];
  updateSessionSettings: AgentActivityRuntime["updateSessionSettings"];
  updateTuttiModeActivation: AgentActivityRuntime["updateTuttiModeActivation"];
  tuttidClient: TuttidClient;
  workspaceId: string;
}

interface WorkspaceAgentForkObservationAckClient {
  acknowledgeWorkspaceAgentSessionForkOperation(
    workspaceId: string,
    operationId: string,
    options: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export function executeWorkspaceAgentTuttiModeUpdateCommand(
  input: Pick<
    CreateWorkspaceAgentSessionEngineHostInput,
    "updateTuttiModeActivation"
  >,
  command: TuttiModeActivationUpdateCommand,
  signal?: AbortSignal
): Promise<unknown> {
  return input.updateTuttiModeActivation({
    agentSessionId: command.agentSessionId,
    ...(command.expectedRevision === undefined
      ? {}
      : { expectedRevision: command.expectedRevision }),
    ...(command.effect === undefined &&
    command.orchestrationIntensity === undefined
      ? {}
      : {
          effect: command.effect ?? command.orchestrationIntensity
        }),
    ...(command.speed === undefined ? {} : { speed: command.speed }),
    signal,
    source: command.source,
    status: command.status,
    workspaceId: command.workspaceId
  });
}

export function executeWorkspaceAgentForkObservedAckCommand(
  client: WorkspaceAgentForkObservationAckClient,
  command: SessionAcknowledgeForkObservedCommand,
  signal?: AbortSignal
): Promise<unknown> {
  return client.acknowledgeWorkspaceAgentSessionForkOperation(
    command.workspaceId,
    command.operationId,
    { ...(signal === undefined ? {} : { signal }) }
  );
}

export function createWorkspaceAgentSessionEngineHost(
  input: CreateWorkspaceAgentSessionEngineHostInput
): WorkspaceAgentSessionEngineHost {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: input.tuttidClient,
    runtimeApi: input.runtimeApi,
    takePendingSessionRecording: input.takePendingSessionRecording,
    restorePendingSessionRecording: input.restorePendingSessionRecording
  });
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => Date.now() },
    commandPort: {
      kind: "typed",
      effects: {
        activateSession: (effectInput, options) =>
          input.activateSession({
            ...effectInput,
            ...(effectInput.settings
              ? {
                  settings:
                    effectInput.settings as AgentHostAgentSessionComposerSettings
                }
              : {}),
            signal: options?.signal
          }),
        cancelTurn: (effectInput, options) =>
          input.cancelTurn({ ...effectInput, signal: options?.signal }),
        deleteSessions: (effectInput, options) =>
          adapter.deleteSessions({
            ...effectInput,
            signal: options?.signal
          }),
        respondToInteraction: (effectInput, options) =>
          input.submitInteractive({
            ...effectInput,
            signal: options?.signal
          }),
        sendInput: (effectInput, options) =>
          input.sendInput({
            ...effectInput,
            signal: options?.signal
          }),
        setSessionPinned: async (effectInput, options) => {
          const session = await adapter.setSessionPinned({
            ...effectInput,
            signal: options?.signal
          });
          return { session };
        },
        updateSessionSettings: (
          { agentSessionId, settings, workspaceId },
          options
        ) =>
          input.updateSessionSettings({
            agentSessionId,
            signal: options?.signal,
            settings: settings as AgentHostAgentSessionComposerSettings,
            workspaceId
          })
      },
      executePlanDecision: (command) => {
        return input.submitPlanDecision({
          action: command.action,
          agentSessionId: command.agentSessionId,
          idempotencyKey: command.idempotencyKey,
          promptKind: command.promptKind,
          requestId: command.requestId,
          turnId: command.turnId,
          workspaceId: command.workspaceId
        });
      },
      execute: async (command, options): Promise<unknown> => {
        switch (command.type) {
          case "attention/readState/read":
            return readDesktopWorkspaceAgentReadState({
              roomId: command.workspaceId,
              userId: command.userId
            });
          case "attention/readState/write":
            return Promise.all([
              writeDesktopWorkspaceAgentReadState({
                roomId: command.workspaceId,
                userId: command.userId,
                kind: "completed",
                readIds: [...command.completed.readIds],
                unreadIds: [...command.completed.unreadIds]
              }),
              writeDesktopWorkspaceAgentReadState({
                roomId: command.workspaceId,
                userId: command.userId,
                kind: "failed",
                readIds: [...command.failed.readIds],
                unreadIds: [...command.failed.unreadIds]
              })
            ]);
          case "composerOptions/load":
            return adapter.loadComposerOptions({
              agentTargetId: command.targetKey,
              ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
              provider: command.provider,
              ...(command.settings !== undefined
                ? { settings: command.settings }
                : {}),
              signal: options?.signal,
              workspaceId: command.workspaceId
            });
          case "turn/editRetry":
            return input.editRetry({
              agentSessionId: command.agentSessionId,
              clientOperationId: command.clientOperationId,
              editedText: command.editedText,
              expectedHistoryRevision: command.expectedHistoryRevision,
              signal: options?.signal,
              turnId: command.turnId,
              workspaceId: command.workspaceId
            });
          case "turn/recoverEditRetry":
            return input.recoverEditRetry({
              action: command.action,
              agentSessionId: command.agentSessionId,
              operationId: command.operationId,
              signal: options?.signal,
              workspaceId: command.workspaceId
            });
          case "session/forkThroughTurn":
            return adapter.forkSession({
              requestId: command.requestId,
              signal: options?.signal,
              sourceAgentSessionId: command.sourceAgentSessionId,
              targetAgentSessionId: command.targetAgentSessionId,
              turnId: command.turnId,
              workspaceId: command.workspaceId
            });
          case "session/ackForkObserved":
            return executeWorkspaceAgentForkObservedAckCommand(
              input.tuttidClient,
              command,
              options?.signal
            );
          case "tuttiMode/update":
            return executeWorkspaceAgentTuttiModeUpdateCommand(
              input,
              command,
              options?.signal
            );
          case "engine/probe":
            return Promise.resolve({ ok: true });
          case "engine/reconcileWorkspace": {
            // Historical/pull path: fetch the authoritative session list over
            // HTTP and hand it to the engine as a historical snapshot. This
            // never lights attention (live=false); realtime completions come in
            // via turn/upserted on the reconcile push path instead.
            const list = await adapter.listSessions({
              workspaceId: command.workspaceId
            });
            engine.dispatch({
              sessions: list.sessions,
              type: "session/snapshotReceived"
            });
            return list;
          }
          case "session/reconcile":
            return input.reconcileSession(command, options?.signal);
          case "session/unactivate":
            return input.unactivateSession({
              agentSessionId: command.agentSessionId,
              workspaceId: command.workspaceId
            });
        }
      },
      observe: (command) =>
        observeWorkspaceAgentEngineCommand(input.activityEventObserver, command)
    },
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: input.workspaceId
    },
    ...(input.activityEventObserver
      ? {
          intentObserver: input.activityEventObserver.observeIntent.bind(
            input.activityEventObserver
          )
        }
      : {}),
    scheduler: {
      schedule(delayMs, task) {
        const timer = setTimeout(task, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }
    }
  });
  const unsubscribeSessionEvents = input.subscribeSessionEvents(
    input.workspaceId,
    (event) => {
      if (!event || typeof event !== "object") return;
      const candidate = event as {
        eventType?: unknown;
        data?: { agentSessionId?: unknown; commands?: unknown };
      };
      if (
        candidate.eventType !== "available_commands_update" ||
        typeof candidate.data?.agentSessionId !== "string" ||
        !Array.isArray(candidate.data.commands)
      )
        return;
      engine.dispatch({
        agentSessionId: candidate.data.agentSessionId,
        commands: candidate.data.commands,
        type: "session/availableCommandsReceived",
        workspaceId: input.workspaceId
      });
    }
  );
  return {
    adapter,
    engine,
    dispose() {
      unsubscribeSessionEvents();
      engine.dispose();
    }
  };
}

function observeWorkspaceAgentEngineCommand(
  observer: WorkspaceAgentSessionEngineActivityObserver | undefined,
  command: EngineExternalCommand
): void {
  try {
    observer?.observeCommand(command);
  } catch {
    // Recording is optional developer instrumentation. It must not block the
    // command that owns the actual product behavior.
  }
}
