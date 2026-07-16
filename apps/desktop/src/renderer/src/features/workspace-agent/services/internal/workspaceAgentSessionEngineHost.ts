import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  type AgentActivityAdapter,
  type AgentActivitySendInput,
  type AgentSessionEngine,
  type PromptQueueSendCommand,
  type SessionActivateCommand,
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
}

interface CreateWorkspaceAgentSessionEngineHostInput {
  activateSession: AgentActivityRuntime["activateSession"];
  cancelCollaboration: NonNullable<AgentActivityRuntime["cancelCollaboration"]>;
  cancelTurn(input: {
    agentSessionId: string;
    turnId: string;
    workspaceId: string;
  }): Promise<unknown>;
  reconcileSession(command: SessionReconcileCommand): Promise<unknown>;
  retryCollaboration: NonNullable<AgentActivityRuntime["retryCollaboration"]>;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  sendInput(input: AgentActivitySendInput): Promise<unknown>;
  submitInteractive: AgentActivityRuntime["submitInteractive"];
  startAgentCollaboration: NonNullable<
    AgentActivityRuntime["startAgentCollaboration"]
  >;
  setCollaborationAdoption: NonNullable<
    AgentActivityRuntime["setCollaborationAdoption"]
  >;
  submitPlanDecision(input: {
    action: "implement";
    agentSessionId: string;
    idempotencyKey: string;
    promptKind: "plan-implementation";
    requestId: string;
    turnId: string;
    workspaceId: string;
  }): Promise<unknown>;
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

type WorkspaceAgentPromptCommandPort = Pick<
  CreateWorkspaceAgentSessionEngineHostInput,
  "sendInput" | "updateSessionSettings"
>;

export async function executeWorkspaceAgentPromptSendCommand(
  input: WorkspaceAgentPromptCommandPort,
  command: PromptQueueSendCommand
): Promise<unknown> {
  if (command.requiredSettingsPatch) {
    await input.updateSessionSettings({
      agentSessionId: command.agentSessionId,
      settings: { ...command.requiredSettingsPatch },
      workspaceId: command.workspaceId
    });
  }
  return input.sendInput({
    agentSessionId: command.agentSessionId,
    ...(command.capabilityRefs?.length
      ? { capabilityRefs: command.capabilityRefs }
      : {}),
    clientSubmitId: command.clientSubmitId,
    content: [...command.content],
    displayPrompt: command.displayPrompt ?? null,
    ...(command.guidance === true ? { guidance: true } : {}),
    ...(command.submitDiagnostics
      ? { submitDiagnostics: { ...command.submitDiagnostics } }
      : {}),
    workspaceId: command.workspaceId
  });
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
    signal,
    source: command.source,
    status: command.status,
    workspaceId: command.workspaceId
  });
}

export function createWorkspaceAgentSessionEngineHost(
  input: CreateWorkspaceAgentSessionEngineHostInput
): WorkspaceAgentSessionEngineHost {
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient: input.tuttidClient,
    runtimeApi: input.runtimeApi
  });
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => Date.now() },
    commandPort: {
      execute: async (command, options) => {
        switch (command.type) {
          case "collaboration/start":
            return input.startAgentCollaboration({
              ...command.input,
              signal: options?.signal
            });
          case "collaboration/setAdoption":
            return input.setCollaborationAdoption({
              ...command.input,
              signal: options?.signal
            });
          case "collaboration/cancel":
            return input.cancelCollaboration({
              ...command.input,
              signal: options?.signal
            });
          case "collaboration/retry":
            return input.retryCollaboration({
              ...command.input,
              signal: options?.signal
            });
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
          case "turn/cancel":
            return input.cancelTurn({
              agentSessionId: command.agentSessionId,
              turnId: command.turnId,
              workspaceId: command.workspaceId
            });
          case "queue/sendPrompt":
            return executeWorkspaceAgentPromptSendCommand(input, command);
          case "interaction/respond":
            return input.submitInteractive({
              ...(command.action ? { action: command.action } : {}),
              agentSessionId: command.agentSessionId,
              ...(command.optionId ? { optionId: command.optionId } : {}),
              ...(command.payload ? { payload: { ...command.payload } } : {}),
              requestId: command.requestId,
              turnId: command.turnId,
              workspaceId: command.workspaceId
            });
          case "plan/submitDecision":
            return input.submitPlanDecision({
              action: command.action,
              agentSessionId: command.agentSessionId,
              idempotencyKey: command.idempotencyKey,
              promptKind: command.promptKind,
              requestId: command.requestId,
              turnId: command.turnId,
              workspaceId: command.workspaceId
            });
          case "session/activate":
            return input.activateSession({
              ...activationInput(command),
              signal: options?.signal
            });
          case "session/updateSettings":
            return input.updateSessionSettings({
              agentSessionId: command.agentSessionId,
              settings: command.settings,
              workspaceId: command.workspaceId
            });
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
            return input.reconcileSession(command);
          case "session/unactivate":
            return input.unactivateSession({
              agentSessionId: command.agentSessionId,
              workspaceId: command.workspaceId
            });
        }
      }
    },
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: input.workspaceId
    },
    scheduler: {
      schedule(delayMs, task) {
        const timer = setTimeout(task, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }
    }
  });
  input.subscribeSessionEvents(input.workspaceId, (event) => {
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
  });
  return { adapter, engine };
}

function activationInput(
  command: SessionActivateCommand
): Parameters<AgentActivityRuntime["activateSession"]>[0] {
  const shared = {
    agentSessionId: command.agentSessionId,
    ...(command.automationRuleOverride
      ? {
          automationRuleOverride: {
            disabled: command.automationRuleOverride.disabled,
            ruleIds: [...command.automationRuleOverride.ruleIds]
          }
        }
      : {}),
    ...(command.capabilityRefs?.length
      ? { capabilityRefs: command.capabilityRefs }
      : {}),
    ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
    ...(command.initialContent
      ? { initialContent: [...command.initialContent] }
      : {}),
    ...(command.initialDisplayPrompt !== undefined
      ? { initialDisplayPrompt: command.initialDisplayPrompt }
      : {}),
    ...(command.initialTuttiModeActivation
      ? {
          initialTuttiModeActivation: {
            ...command.initialTuttiModeActivation
          }
        }
      : {}),
    ...(command.submitDiagnostics
      ? { submitDiagnostics: { ...command.submitDiagnostics } }
      : {}),
    ...(command.settings
      ? {
          settings: command.settings as AgentHostAgentSessionComposerSettings
        }
      : {}),
    ...(command.title !== undefined ? { title: command.title } : {}),
    ...(command.visible !== undefined ? { visible: command.visible } : {}),
    workspaceId: command.workspaceId
  };
  return command.mode === "new"
    ? {
        ...shared,
        agentTargetId: command.agentTargetId ?? "",
        clientSubmitId: command.clientSubmitId,
        mode: "new"
      }
    : {
        ...shared,
        agentTargetId: command.agentTargetId,
        mode: "existing"
      };
}
