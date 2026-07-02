import { useCallback, useMemo, useState } from "react";
import {
  type AppErrorCode,
  type AgentPromptContentBlock,
  AgentHostActivateAgentSessionResult
} from "../../../shared/contracts/dto";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import { getAppErrorCode } from "../../../shared/errors/appError";
import { useAgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUIProviderTargetRef } from "../../../types";

type AgentGUILiveState = "inactive" | "activating" | "active" | "failed";
interface AgentGUIActivateInput {
  agentSessionId: string;
  agentTargetId?: string | null;
  cwd?: string;
  initialContent?: AgentPromptContentBlock[];
  initialDisplayPrompt?: string;
  metadata?: Record<string, unknown>;
  mode: "existing" | "new";
  openclawGatewayReady?: boolean;
  provider?: string;
  providerTargetRef?: AgentGUIProviderTargetRef | null;
  settings?: AgentSessionComposerSettings;
  title?: string;
  visible?: boolean;
}

interface UseAgentGUIActivationInput {
  workspaceId: string;
  getErrorMessage: (error: unknown) => string;
  getErrorCode?: (error: unknown) => AppErrorCode | null;
}

export function useAgentGUIActivation({
  workspaceId,
  getErrorMessage,
  getErrorCode
}: UseAgentGUIActivationInput) {
  const agentActivityRuntime = useAgentActivityRuntime();
  const [liveStateBySessionId, setLiveStateBySessionId] = useState<
    Record<string, AgentGUILiveState>
  >({});
  const [activationErrorBySessionId, setActivationErrorBySessionId] = useState<
    Record<string, string | null>
  >({});
  const [activationErrorCodeBySessionId, setActivationErrorCodeBySessionId] =
    useState<Record<string, AppErrorCode | null>>({});

  const activate = useCallback(
    async (
      input: AgentGUIActivateInput
    ): Promise<AgentHostActivateAgentSessionResult> => {
      const agentSessionId = input.agentSessionId.trim();
      setLiveStateBySessionId((current) => ({
        ...current,
        [agentSessionId]: "activating"
      }));
      setActivationErrorBySessionId((current) => ({
        ...current,
        [agentSessionId]: null
      }));
      setActivationErrorCodeBySessionId((current) => ({
        ...current,
        [agentSessionId]: null
      }));
      try {
        const request =
          input.mode === "new"
            ? {
                mode: input.mode,
                workspaceId,
                agentSessionId,
                agentTargetId: input.agentTargetId,
                provider: input.provider,
                cwd: input.cwd,
                initialContent: input.initialContent,
                initialDisplayPrompt: input.initialDisplayPrompt,
                metadata: input.metadata,
                title: input.title,
                providerTargetRef: input.providerTargetRef,
                settings: input.settings,
                visible: input.visible,
                openclawGatewayReady: input.openclawGatewayReady
              }
            : {
                mode: input.mode,
                workspaceId,
                agentSessionId,
                visible: input.visible
              };
        const result = await agentActivityRuntime.activateSession(request);
        const failed =
          result.activation.status === "failed" ||
          result.session.status === "failed";
        setLiveStateBySessionId((current) => ({
          ...current,
          [agentSessionId]: failed ? "failed" : "active"
        }));
        setActivationErrorBySessionId((current) => ({
          ...current,
          [agentSessionId]: failed ? (result.error?.message ?? null) : null
        }));
        setActivationErrorCodeBySessionId((current) => ({
          ...current,
          [agentSessionId]: null
        }));
        return result;
      } catch (error) {
        setLiveStateBySessionId((current) => ({
          ...current,
          [agentSessionId]: "failed"
        }));
        setActivationErrorBySessionId((current) => ({
          ...current,
          [agentSessionId]: getErrorMessage(error)
        }));
        setActivationErrorCodeBySessionId((current) => ({
          ...current,
          [agentSessionId]: getErrorCode?.(error) ?? getAppErrorCode(error)
        }));
        throw error;
      }
    },
    [agentActivityRuntime, getErrorMessage, workspaceId]
  );

  const unactivate = useCallback(
    async (agentSessionId: string): Promise<void> => {
      const normalized = agentSessionId.trim();
      if (!normalized) {
        return;
      }
      setLiveStateBySessionId((current) => ({
        ...current,
        [normalized]: "inactive"
      }));
      try {
        await agentActivityRuntime.unactivateSession({
          workspaceId,
          agentSessionId: normalized
        });
      } catch {
        // Switching sessions is driven by durable history. A failed best-effort
        // buffer transition should not trap the user on the old conversation.
      }
    },
    [agentActivityRuntime, workspaceId]
  );

  const markFailed = useCallback(
    (agentSessionId: string, error: unknown): void => {
      const normalized = agentSessionId.trim();
      if (!normalized) {
        return;
      }
      setLiveStateBySessionId((current) => ({
        ...current,
        [normalized]: "failed"
      }));
      setActivationErrorBySessionId((current) => ({
        ...current,
        [normalized]: getErrorMessage(error)
      }));
      setActivationErrorCodeBySessionId((current) => ({
        ...current,
        [normalized]: getErrorCode?.(error) ?? getAppErrorCode(error)
      }));
    },
    [getErrorCode, getErrorMessage]
  );

  const clearFailure = useCallback((agentSessionId: string): void => {
    const normalized = agentSessionId.trim();
    if (!normalized) {
      return;
    }
    setLiveStateBySessionId((current) =>
      current[normalized] === "failed"
        ? { ...current, [normalized]: "inactive" }
        : current
    );
    setActivationErrorBySessionId((current) =>
      current[normalized] === null || current[normalized] === undefined
        ? current
        : { ...current, [normalized]: null }
    );
    setActivationErrorCodeBySessionId((current) =>
      current[normalized] === null || current[normalized] === undefined
        ? current
        : { ...current, [normalized]: null }
    );
  }, []);

  const stateFor = useCallback(
    (agentSessionId: string | null | undefined): AgentGUILiveState =>
      agentSessionId
        ? (liveStateBySessionId[agentSessionId] ?? "inactive")
        : "inactive",
    [liveStateBySessionId]
  );

  const errorFor = useCallback(
    (agentSessionId: string | null | undefined): string | null =>
      agentSessionId
        ? (activationErrorBySessionId[agentSessionId] ?? null)
        : null,
    [activationErrorBySessionId]
  );

  const codeFor = useCallback(
    (agentSessionId: string | null | undefined): AppErrorCode | null =>
      agentSessionId
        ? (activationErrorCodeBySessionId[agentSessionId] ?? null)
        : null,
    [activationErrorCodeBySessionId]
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
