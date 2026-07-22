import {
  selectSessionActivationPresentations,
  sessionActivationPresentationMapsEqual,
  type AgentActivityInitialGoalControl,
  type AgentActivitySubmitDiagnostics,
  type PendingActivationIntentRecord,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { useCallback, useMemo, useRef } from "react";
import {
  type AppErrorCode,
  type AgentPromptContentBlock
} from "../../../shared/contracts/dto";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";

type AgentGUILiveState = "inactive" | "activating" | "active" | "failed";

interface AgentGUIActivateInputBase {
  agentSessionId: string;
  cwd?: string;
  initialContent?: AgentPromptContentBlock[];
  initialTurnExpected?: boolean;
  initialGoalControl?: AgentActivityInitialGoalControl;
  railSectionKey?: string;
  initialDisplayPrompt?: string;
  runtimeContent?: AgentPromptContentBlock[];
  submitDiagnostics?: AgentActivitySubmitDiagnostics;
  settings?: AgentSessionComposerSettings;
  title?: string;
  visible?: boolean;
}

type AgentGUIActivateInput =
  | (AgentGUIActivateInputBase & {
      agentTargetId: string;
      clientSubmitId: string;
      mode: "new";
      optimisticTitle?: string;
    })
  | (AgentGUIActivateInputBase & {
      agentTargetId?: string | null;
      clientSubmitId?: never;
      mode: "existing";
      optimisticTitle?: never;
    });

interface UseAgentGUIActivationInput {
  engine: AgentSessionEngine;
  workspaceId: string;
  getErrorMessage: (error: unknown) => string;
  getErrorCode?: (error: unknown) => AppErrorCode | null;
}

const ACTIVATION_EXPIRY_MS = 45_000;

export function isPendingNewConversationActivation(
  activation:
    | Pick<PendingActivationIntentRecord, "mode" | "status">
    | null
    | undefined
): boolean {
  return (
    activation?.mode === "new" &&
    (activation.status === "requested" || activation.status === "uncertain")
  );
}

export function isPendingNewConversationActivationForSession(
  activation:
    | Pick<PendingActivationIntentRecord, "agentSessionId" | "mode" | "status">
    | null
    | undefined,
  agentSessionId: string | null | undefined
): boolean {
  const normalizedSessionId = agentSessionId?.trim() ?? "";
  return Boolean(
    normalizedSessionId &&
    activation?.agentSessionId.trim() === normalizedSessionId &&
    isPendingNewConversationActivation(activation)
  );
}

export function useAgentGUIActivation({
  engine,
  workspaceId,
  getErrorMessage,
  getErrorCode
}: UseAgentGUIActivationInput) {
  const requestSequenceRef = useRef(0);
  const presentations = useEngineSelector(
    engine,
    selectSessionActivationPresentations,
    sessionActivationPresentationMapsEqual
  );

  const nextRequestId = (kind: string, agentSessionId: string): string => {
    requestSequenceRef.current += 1;
    return `${kind}:${workspaceId}:${agentSessionId}:${Date.now()}:${requestSequenceRef.current}`;
  };

  const activate = useCallback(
    (input: AgentGUIActivateInput): string | null => {
      const agentSessionId = input.agentSessionId.trim();
      const agentTargetId = input.agentTargetId?.trim() ?? "";
      if (!agentSessionId) {
        return null;
      }
      if (input.mode === "new" && !agentTargetId) {
        return null;
      }

      const requestedAtUnixMs = Date.now();
      const requestId = nextRequestId("activation", agentSessionId);
      const clientSubmitId = input.clientSubmitId?.trim() ?? "";
      if (input.mode === "new" && !clientSubmitId) {
        return null;
      }
      const sharedIntent = {
        type: "activation/requested",
        agentSessionId,
        ...(input.initialContent ? { content: input.initialContent } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        expiresAtUnixMs: requestedAtUnixMs + ACTIVATION_EXPIRY_MS,
        ...(input.initialTurnExpected !== undefined
          ? { initialTurnExpected: input.initialTurnExpected }
          : {}),
        ...(input.initialGoalControl
          ? { initialGoalControl: { ...input.initialGoalControl } }
          : {}),
        ...(input.railSectionKey?.trim()
          ? { railSectionKey: input.railSectionKey.trim() }
          : {}),
        ...(input.initialDisplayPrompt
          ? { initialDisplayPrompt: input.initialDisplayPrompt }
          : {}),
        ...(input.runtimeContent
          ? { runtimeContent: input.runtimeContent }
          : {}),
        ...(input.submitDiagnostics
          ? { submitDiagnostics: input.submitDiagnostics }
          : {}),
        requestedAtUnixMs,
        requestId,
        ...(input.settings
          ? {
              settings: input.settings
            }
          : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.visible !== undefined ? { visible: input.visible } : {}),
        workspaceId
      } as const;
      if (input.mode === "new") {
        engine.dispatch({
          ...sharedIntent,
          agentTargetId,
          clientSubmitId,
          mode: "new",
          ...(input.optimisticTitle
            ? { optimisticTitle: input.optimisticTitle }
            : {})
        });
      } else {
        engine.dispatch({
          ...sharedIntent,
          ...(agentTargetId ? { agentTargetId } : {}),
          mode: "existing"
        });
      }
      return requestId;
    },
    [engine, workspaceId]
  );

  const unactivate = useCallback(
    (agentSessionId: string): Promise<void> => {
      const normalized = agentSessionId.trim();
      if (!normalized) {
        return Promise.resolve();
      }
      engine.dispatch({
        type: "activation/unactivateRequested",
        agentSessionId: normalized,
        commandId: nextRequestId("unactivate", normalized),
        workspaceId
      });
      return Promise.resolve();
    },
    [engine, workspaceId]
  );

  const markFailed = useCallback(
    (agentSessionId: string, error: unknown): void => {
      const normalized = agentSessionId.trim();
      if (!normalized) {
        return;
      }
      engine.dispatch({
        type: "activation/failureRecorded",
        agentSessionId: normalized,
        errorCode: getErrorCode?.(error) ?? null,
        errorMessage: getErrorMessage(error),
        occurredAtUnixMs: Date.now(),
        requestId: nextRequestId("activation-failure", normalized),
        workspaceId
      });
    },
    [engine, getErrorCode, getErrorMessage, workspaceId]
  );

  const clearFailure = useCallback(
    (agentSessionId: string): void => {
      const normalized = agentSessionId.trim();
      if (normalized) {
        engine.dispatch({
          type: "activation/failureCleared",
          agentSessionId: normalized
        });
      }
    },
    [engine]
  );

  const stateFor = useCallback(
    (agentSessionId: string | null | undefined): AgentGUILiveState =>
      (agentSessionId ? presentations[agentSessionId]?.status : null) ??
      "inactive",
    [presentations]
  );
  const errorFor = useCallback(
    (agentSessionId: string | null | undefined): string | null =>
      (agentSessionId ? presentations[agentSessionId]?.errorMessage : null) ??
      null,
    [presentations]
  );
  const codeFor = useCallback(
    (agentSessionId: string | null | undefined): AppErrorCode | null =>
      ((agentSessionId
        ? presentations[agentSessionId]?.errorCode
        : null) as AppErrorCode | null) ?? null,
    [presentations]
  );

  return useMemo(
    () => ({
      activate,
      clearFailure,
      markFailed,
      unactivate,
      stateFor,
      errorFor,
      codeFor
    }),
    [
      activate,
      clearFailure,
      codeFor,
      errorFor,
      markFailed,
      stateFor,
      unactivate
    ]
  );
}
