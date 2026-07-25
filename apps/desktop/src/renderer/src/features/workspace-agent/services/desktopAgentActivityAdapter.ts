import {
  workspaceAgentSessionStatus,
  type AgentActivityAdapter,
  type AgentActivitySession,
  type AgentPromptContentBlock
} from "@tutti-os/agent-activity-core";
import {
  agentActivityMessageFromTuttidMessage,
  agentActivitySessionFromTuttidSession as mapAgentActivitySessionFromTuttidSession,
  agentActivityTuttiModeActivationFromTuttid
} from "@tutti-os/agent-activity-tuttid-adapter";
export {
  agentActivityMessageFromTuttidMessage,
  agentActivityTurnFromTuttidTurn
} from "@tutti-os/agent-activity-tuttid-adapter";
import type {
  TuttidClient,
  AgentSubmitDiagnostics,
  AgentPromptContentBlock as TuttidAgentPromptContentBlock,
  CreateWorkspaceAgentSessionRequest,
  SendWorkspaceAgentSessionInputRequest,
  WorkspaceAgentSession,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import { getActiveLocale } from "../../../i18n/runtime.ts";
import { wrapLocalizedTuttidErrorIfSpecific } from "../../../lib/desktopErrors.ts";
import { agentActivityComposerOptionsFromTuttidResult } from "../../../lib/agentComposerOptionsProjection.ts";
import { reportAgentSubmitTraceDiagnostic as reportDesktopAgentSubmitTrace } from "./desktopAgentRuntimeSubmitDiagnostics.ts";
import { DESKTOP_AGENT_GUI_CURRENT_USER_ID } from "./desktopAgentGuiIdentity.ts";

export interface CreateDesktopAgentActivityAdapterInput {
  composerOptionsRequestTimeoutMs?: number;
  tuttidClient: TuttidClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
}

const defaultComposerOptionsRequestTimeoutMs = 15_000;
const agentActivitySessionListLimit = 100;

export function agentActivitySessionFromTuttidSession(
  workspaceId: string,
  session: WorkspaceAgentSession
): AgentActivitySession {
  return mapAgentActivitySessionFromTuttidSession(workspaceId, session, {
    currentUserId: DESKTOP_AGENT_GUI_CURRENT_USER_ID
  });
}

export function createDesktopAgentActivityAdapter({
  composerOptionsRequestTimeoutMs = defaultComposerOptionsRequestTimeoutMs,
  tuttidClient,
  runtimeApi
}: CreateDesktopAgentActivityAdapterInput): AgentActivityAdapter {
  return {
    async listSessions(input) {
      const response = await tuttidClient.listWorkspaceAgentSessions(
        input.workspaceId,
        { limit: agentActivitySessionListLimit }
      );
      return {
        sessions: response.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(input.workspaceId, session)
        )
      };
    },
    async listSessionMessages(input) {
      const startedAt = Date.now();
      reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
        afterVersion: input.afterVersion ?? 0,
        agentSessionId: input.agentSessionId,
        beforeVersion: input.beforeVersion ?? null,
        event: "requested",
        limit: input.limit ?? null,
        order: input.order ?? null
      });
      try {
        const response = await tuttidClient.listWorkspaceAgentSessionMessages(
          input.workspaceId,
          input.agentSessionId,
          {
            afterVersion: input.afterVersion ?? 0,
            beforeVersion: input.beforeVersion,
            order: input.order,
            limit: input.limit
          }
        );
        const messages = response.messages.map((message) =>
          agentActivityMessageFromTuttidMessage(input.workspaceId, message)
        );
        const versions = messages
          .map((message) => message.version)
          .filter((version) => Number.isFinite(version));
        reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
          agentSessionId: input.agentSessionId,
          durationMs: Date.now() - startedAt,
          event: "resolved",
          firstVersion: versions.length ? Math.min(...versions) : null,
          hasMore: response.hasMore,
          lastVersion: versions.length ? Math.max(...versions) : null,
          latestVersion: response.latestVersion,
          messageCount: messages.length
        });
        return {
          hasMore: response.hasMore,
          latestVersion: response.latestVersion,
          messages
        };
      } catch (error) {
        reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
          agentSessionId: input.agentSessionId,
          durationMs: Date.now() - startedAt,
          event: "failed",
          ...normalizeDesktopAgentDiagnosticError(error)
        });
        throw error;
      }
    },
    async loadComposerOptions(input) {
      const startedAt = Date.now();
      const cwd = input.cwd?.trim();
      const agentTargetId = input.agentTargetId?.trim();
      try {
        const result = await withAbortableRequestTimeout(
          (signal) =>
            tuttidClient.getAgentProviderComposerOptions(
              workspaceAgentProvider(input.provider),
              {
                ...(agentTargetId ? { agentTargetId } : {}),
                ...(cwd ? { cwd } : {}),
                workspaceId: input.workspaceId,
                settings: input.settings ?? {}
              },
              { signal }
            ),
          {
            signal: input.signal,
            timeoutMessage: "Agent composer options request timed out.",
            timeoutMs: composerOptionsRequestTimeoutMs
          }
        );
        reportDesktopAgentComposerOptionsDiagnostic(
          runtimeApi,
          input.workspaceId,
          {
            agentTargetId: agentTargetId ?? null,
            durationMs: Date.now() - startedAt,
            provider: input.provider,
            status: "ready"
          }
        );
        return agentActivityComposerOptionsFromTuttidResult(
          input.provider,
          result
        );
      } catch (error) {
        reportDesktopAgentComposerOptionsDiagnostic(
          runtimeApi,
          input.workspaceId,
          {
            agentTargetId: agentTargetId ?? null,
            durationMs: Date.now() - startedAt,
            provider: input.provider,
            status: "error",
            ...normalizeDesktopAgentDiagnosticError(error)
          }
        );
        throw error;
      }
    },
    async createSession(input) {
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId?.trim() ?? null,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.create.entered",
        provider: null,
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId
      });
      try {
        const agentSessionId =
          input.agentSessionId?.trim() || createDesktopAgentActivitySessionId();
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.create.http_requested",
          provider: null,
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId,
          fields: {
            hasInitialTuttiModeActivation:
              input.initialTuttiModeActivation != null
          }
        });
        const agentTargetId = requiredAgentTargetId(input.agentTargetId);
        const request: CreateWorkspaceAgentSessionRequest = {
          agentSessionId,
          agentTargetId,
          ...(input.capabilityRefs?.length
            ? {
                capabilityRefs: input.capabilityRefs.map(
                  toTuttidCapabilityReference
                )
              }
            : {}),
          clientSubmitId: input.clientSubmitId,
          cwd: input.cwd ?? null,
          initialContent: toTuttidPromptContentBlocks(
            input.initialContent ?? []
          ),
          initialDisplayPrompt: input.initialDisplayPrompt ?? null,
          ...(input.initialTuttiModeActivation
            ? {
                initialTuttiModeActivation: {
                  ...input.initialTuttiModeActivation
                }
              }
            : {}),
          ...(input.submitDiagnostics
            ? {
                submitDiagnostics: toTuttidSubmitDiagnostics(
                  input.submitDiagnostics
                )
              }
            : {}),
          model: input.model ?? null,
          noProject:
            input.noProject ?? (normalizeText(input.cwd) ? null : true),
          ...(input.railPlacement
            ? { railPlacement: { ...input.railPlacement } }
            : {}),
          planMode: input.planMode ?? null,
          permissionModeId: input.permissionModeId ?? null,
          reasoningEffort: input.reasoningEffort ?? null,
          speed: input.speed ?? null,
          title: input.title ?? null,
          visible: input.visible ?? null
        };
        const session = await tuttidClient.createWorkspaceAgentSession(
          input.workspaceId,
          request,
          { signal: input.signal }
        );
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId: session.id,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.create.resolved",
          provider: session.provider,
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId,
          fields: { sessionStatus: workspaceAgentSessionStatus(session) }
        });
        return agentActivitySessionFromTuttidSession(
          input.workspaceId,
          session
        );
      } catch (error) {
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId: input.agentSessionId?.trim() ?? null,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.create.failed",
          fields: {
            ...normalizeDesktopAgentDiagnosticError(error),
            hasInitialTuttiModeActivation:
              input.initialTuttiModeActivation != null
          },
          provider: null,
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId
        });
        throw wrapLocalizedTuttidErrorIfSpecific(error, getActiveLocale());
      }
    },
    async sendInput(input) {
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.send.entered",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId
      });
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.send.http_requested",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId
      });
      const request: SendWorkspaceAgentSessionInputRequest = {
        clientSubmitId: input.clientSubmitId,
        ...(input.capabilityRefs?.length
          ? {
              capabilityRefs: input.capabilityRefs.map(
                toTuttidCapabilityReference
              )
            }
          : {}),
        content: toTuttidPromptContentBlocks(input.content),
        displayPrompt: input.displayPrompt ?? null,
        ...(input.guidance === true ? { guidance: true } : {}),
        ...(input.submitDiagnostics
          ? {
              submitDiagnostics: toTuttidSubmitDiagnostics(
                input.submitDiagnostics
              )
            }
          : {})
      };
      let result: Awaited<
        ReturnType<TuttidClient["sendWorkspaceAgentSessionInput"]>
      >;
      try {
        result = await tuttidClient.sendWorkspaceAgentSessionInput(
          input.workspaceId,
          input.agentSessionId,
          request
        );
      } catch (error) {
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId: input.agentSessionId,
          clientSubmitId: input.clientSubmitId,
          event: "renderer_adapter.send.failed",
          fields: normalizeDesktopAgentDiagnosticError(error),
          submitDiagnostics: input.submitDiagnostics,
          workspaceId: input.workspaceId
        });
        throw wrapLocalizedTuttidErrorIfSpecific(error, getActiveLocale());
      }
      if (result.kind === "goalControl") {
        return {
          kind: "goalControl",
          goal: result.goal ?? result.session.goal ?? null,
          session: agentActivitySessionFromTuttidSession(
            input.workspaceId,
            result.session
          )
        };
      }
      if (!result.turn || !result.turnId) {
        throw new Error("workspace_agent.send_response_turn_required");
      }
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "renderer_adapter.send.resolved",
        provider: result.session.provider,
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId,
        fields: {
          sessionStatus: workspaceAgentSessionStatus(result.session),
          turnId: result.turnId,
          turnPhase: result.turn.phase
        }
      });
      return {
        kind: "turn",
        session: agentActivitySessionFromTuttidSession(
          input.workspaceId,
          result.session
        ),
        turnId: result.turnId,
        turn: result.turn
      };
    },
    async updateTuttiModeActivation(input) {
      const response =
        await tuttidClient.updateWorkspaceAgentSessionTuttiModeActivation(
          input.workspaceId,
          input.agentSessionId,
          {
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
            ...(input.orchestrationIntensity === undefined
              ? {}
              : { orchestrationIntensity: input.orchestrationIntensity }),
            source: input.source,
            status: input.status
          },
          { signal: input.signal }
        );
      if (!response.activation) {
        throw new Error("workspace_agent.tutti_mode_activation_required");
      }
      return {
        activation: agentActivityTuttiModeActivationFromTuttid(
          response.activation
        ),
        changed: response.changed
      };
    },
    async goalControl(input) {
      const result = await tuttidClient.goalControlWorkspaceAgentSession(
        input.workspaceId,
        input.agentSessionId,
        {
          action: input.action,
          ...(input.objective !== undefined
            ? { objective: input.objective }
            : {})
        }
      );
      return {
        goal: result.session.goal ?? null,
        session: agentActivitySessionFromTuttidSession(
          input.workspaceId,
          result.session
        )
      };
    },
    async submitInteractive(input) {
      const session = await tuttidClient.submitWorkspaceAgentInteractive(
        input.workspaceId,
        input.agentSessionId,
        input.requestId,
        {
          turnId: input.turnId,
          action: input.action ?? null,
          optionId: input.optionId ?? null,
          payload: input.payload ?? null
        }
      );
      return {
        session: agentActivitySessionFromTuttidSession(
          input.workspaceId,
          session
        )
      };
    },
    async deleteSession(input) {
      return await tuttidClient.deleteWorkspaceAgentSession(
        input.workspaceId,
        input.agentSessionId
      );
    },
    async deleteSessions(input) {
      const response = await tuttidClient.deleteWorkspaceAgentSessionsBatch(
        input.workspaceId,
        { sessionIds: [...input.agentSessionIds] },
        { signal: input.signal }
      );
      return {
        cleanupFailedSessionIds: response.cleanupFailedSessionIds,
        removedMessages: response.removedMessages,
        removedSessionIds: response.removedSessionIds,
        removedSessions: response.removedSessions
      };
    },
    async renameSession(input) {
      const session = await tuttidClient.updateWorkspaceAgentSessionTitle(
        input.workspaceId,
        input.agentSessionId,
        { title: input.title }
      );
      return agentActivitySessionFromTuttidSession(input.workspaceId, session);
    },
    async setSessionPinned(input) {
      const session = await tuttidClient.updateWorkspaceAgentSessionPin(
        input.workspaceId,
        input.agentSessionId,
        { pinned: input.pinned }
      );
      return agentActivitySessionFromTuttidSession(input.workspaceId, session);
    }
  };
}

function toTuttidCapabilityReference(reference: {
  capability: string;
  source: "slash_command";
}): { capability: "tutti"; source: "slash_command" } {
  if (reference.capability !== "tutti") {
    throw new Error(
      `Unsupported workspace agent capability reference: ${reference.capability}`
    );
  }
  return { capability: "tutti", source: reference.source };
}

function reportDesktopAgentMessageListDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">,
  workspaceId: string,
  details: Record<string, string | number | boolean | null>
): void {
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details,
        event: "agent.activity.messages.list",
        level: details.event === "failed" ? "warn" : "info",
        workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect message loading.
  }
}

function reportDesktopAgentComposerOptionsDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">,
  workspaceId: string,
  details: Record<string, string | number | boolean | null>
): void {
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details,
        event: "agent.composer_options.load",
        level: details.status === "error" ? "warn" : "info",
        workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect composer option loading.
  }
}

function normalizeDesktopAgentDiagnosticError(
  error: unknown
): Record<string, string | number | boolean | null> {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const record = error as Error & {
    code?: unknown;
    reason?: unknown;
    retryable?: unknown;
    statusCode?: unknown;
  };
  return {
    ...(typeof record.code === "string" ? { errorCode: record.code } : {}),
    errorMessageLength: error.message.length,
    errorName: error.name,
    ...(typeof record.reason === "string"
      ? { errorReason: record.reason }
      : {}),
    ...(typeof record.retryable === "boolean"
      ? { errorRetryable: record.retryable }
      : {}),
    ...(typeof record.statusCode === "number"
      ? { errorStatusCode: record.statusCode }
      : {})
  };
}

export function createDesktopAgentActivitySessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}

function toTuttidSubmitDiagnostics(input: {
  blockCount?: number;
  hasImage?: boolean;
  promptLength?: number;
  queued?: boolean;
  source?: string;
  submittedAtUnixMs?: number;
}): AgentSubmitDiagnostics {
  return {
    ...(input.blockCount !== undefined ? { blockCount: input.blockCount } : {}),
    ...(input.hasImage !== undefined ? { hasImage: input.hasImage } : {}),
    ...(input.promptLength !== undefined
      ? { promptLength: input.promptLength }
      : {}),
    ...(input.queued !== undefined ? { queued: input.queued } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.submittedAtUnixMs !== undefined
      ? { submittedAtUnixMs: input.submittedAtUnixMs }
      : {})
  };
}

function requiredAgentTargetId(value: string | null | undefined): string {
  const agentTargetId = normalizeText(value);
  if (!agentTargetId) {
    throw new Error("Agent target id is required to create an agent session.");
  }
  return agentTargetId;
}

function toTuttidPromptContentBlocks(
  content: readonly AgentPromptContentBlock[]
): TuttidAgentPromptContentBlock[] {
  return content.flatMap((block) => {
    if (block.type === "file") {
      throw new Error(
        "File prompt blocks must be uploaded before desktop submission."
      );
    }
    const nextBlock: TuttidAgentPromptContentBlock = { type: block.type };
    if (block.attachmentId !== undefined) {
      nextBlock.attachmentId = block.attachmentId;
    }
    if (block.data !== undefined) {
      nextBlock.data = block.data;
    }
    if (block.url !== undefined) {
      nextBlock.url = block.url;
    }
    if (block.mimeType !== undefined) {
      nextBlock.mimeType =
        block.mimeType as TuttidAgentPromptContentBlock["mimeType"];
    }
    if (block.name !== undefined) {
      nextBlock.name = block.name;
    }
    if (block.path !== undefined) {
      nextBlock.path = block.path;
    }
    if (block.text !== undefined) {
      nextBlock.text = block.text;
    }
    return [nextBlock];
  });
}

function withAbortableRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMessage: string;
    timeoutMs: number;
  }
): Promise<T> {
  const controller = new AbortController();
  const racers: Array<Promise<T>> = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  if (options.signal) {
    if (options.signal.aborted) {
      const error = abortSignalError(options.signal);
      controller.abort(error);
      return Promise.reject(error);
    }
    racers.push(
      new Promise<never>((_, reject) => {
        abortListener = () => {
          const error = abortSignalError(options.signal);
          controller.abort(error);
          reject(error);
        };
        options.signal?.addEventListener("abort", abortListener, {
          once: true
        });
      })
    );
  }

  racers.push(request(controller.signal));

  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    racers.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = Object.assign(new Error(options.timeoutMessage), {
            code: "ETIMEDOUT"
          });
          controller.abort(error);
          reject(error);
        }, options.timeoutMs);
      })
    );
  }

  return Promise.race(racers).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
  });
}

function abortSignalError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Agent composer options request was cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workspaceAgentProvider(value: string): WorkspaceAgentProvider {
  return value as WorkspaceAgentProvider;
}
