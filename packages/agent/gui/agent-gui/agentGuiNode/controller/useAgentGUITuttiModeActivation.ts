import {
  selectTuttiModeActivationPresentation,
  tuttiModeActivationPresentationsEqual,
  type AgentSessionEngine,
  type TuttiModeActivationPresentation
} from "@tutti-os/agent-activity-core";
import { useCallback, useMemo, useRef } from "react";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";

interface UseAgentGUITuttiModeActivationInput {
  activeConversationId: string | null;
  draftKey: string;
  engine: AgentSessionEngine;
  workspaceId: string;
}

export function resolveAgentGUITuttiModeDraftKey(
  nodeId: string | null | undefined
): string {
  return `agent-gui:${nodeId?.trim() || "default"}:tutti-mode:home`;
}

export function useAgentGUITuttiModeActivation({
  activeConversationId,
  draftKey,
  engine,
  workspaceId
}: UseAgentGUITuttiModeActivationInput) {
  const commandSequenceRef = useRef(0);
  const presentation = useEngineSelector(
    engine,
    useCallback(
      (state) =>
        selectTuttiModeActivationPresentation(
          state,
          activeConversationId,
          draftKey
        ),
      [activeConversationId, draftKey]
    ),
    tuttiModeActivationPresentationsEqual
  );
  const updatePending = isTuttiModeActivationPending(presentation);
  const setActive = useCallback(
    (active: boolean): void => {
      if (updatePending || presentation.active === active) return;
      const agentSessionId = activeConversationId?.trim() ?? "";
      if (!agentSessionId) {
        engine.dispatch({
          active,
          draftKey,
          occurredAtUnixMs: Date.now(),
          type: "tuttiMode/draftSet"
        });
        return;
      }
      commandSequenceRef.current += 1;
      const requestedAtUnixMs = Date.now();
      engine.dispatch({
        agentSessionId,
        commandId: `tutti-mode:${workspaceId}:${agentSessionId}:${requestedAtUnixMs}:${commandSequenceRef.current}`,
        requestedAtUnixMs,
        source: active ? "slash_command" : "badge_remove",
        status: active ? "active" : "inactive",
        type: "tuttiMode/updateRequested",
        workspaceId
      });
    },
    [
      activeConversationId,
      draftKey,
      engine,
      presentation.active,
      updatePending,
      workspaceId
    ]
  );
  const retry = useCallback((): void => {
    if (presentation.updateStatus !== "failed") return;
    setActive(!presentation.active);
  }, [presentation.active, presentation.updateStatus, setActive]);
  const setOrchestrationIntensity = useCallback(
    (value: number): void => {
      const agentSessionId = activeConversationId?.trim() ?? "";
      if (!agentSessionId) {
        engine.dispatch({
          active: true,
          draftKey,
          occurredAtUnixMs: Date.now(),
          orchestrationIntensity: value,
          type: "tuttiMode/draftSet"
        });
        return;
      }
      commandSequenceRef.current += 1;
      const requestedAtUnixMs = Date.now();
      engine.dispatch({
        agentSessionId,
        commandId: `tutti-mode:${workspaceId}:${agentSessionId}:${requestedAtUnixMs}:${commandSequenceRef.current}`,
        orchestrationIntensity: value,
        requestedAtUnixMs,
        source: "slash_command",
        status: "active",
        type: "tuttiMode/updateRequested",
        workspaceId
      });
    },
    [activeConversationId, draftKey, engine, workspaceId]
  );

  return useMemo(
    () => ({
      ...presentation,
      retry,
      setActive,
      setOrchestrationIntensity,
      updatePending
    }),
    [presentation, retry, setActive, setOrchestrationIntensity, updatePending]
  );
}

function isTuttiModeActivationPending(
  presentation: TuttiModeActivationPresentation
): boolean {
  return (
    presentation.updateStatus === "pending_create" ||
    presentation.updateStatus === "updating" ||
    presentation.updateStatus === "uncertain"
  );
}
