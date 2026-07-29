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
  const setPreference = useCallback(
    (preference: "effect" | "speed", value: number): void => {
      const agentSessionId = activeConversationId?.trim() ?? "";
      if (!agentSessionId) {
        engine.dispatch({
          active: true,
          draftKey,
          occurredAtUnixMs: Date.now(),
          [preference]: value,
          type: "tuttiMode/draftSet"
        });
        return;
      }
      commandSequenceRef.current += 1;
      const requestedAtUnixMs = Date.now();
      engine.dispatch({
        agentSessionId,
        commandId: `tutti-mode:${workspaceId}:${agentSessionId}:${requestedAtUnixMs}:${commandSequenceRef.current}`,
        [preference]: value,
        requestedAtUnixMs,
        source: "slash_command",
        status: "active",
        type: "tuttiMode/updateRequested",
        workspaceId
      });
    },
    [activeConversationId, draftKey, engine, workspaceId]
  );
  const setEffect = useCallback(
    (value: number): void => setPreference("effect", value),
    [setPreference]
  );
  const setSpeed = useCallback(
    (value: number): void => setPreference("speed", value),
    [setPreference]
  );

  return useMemo(
    () => ({
      ...presentation,
      effect: presentation.effect ?? presentation.orchestrationIntensity,
      speed: presentation.speed ?? 50,
      retry,
      setActive,
      setEffect,
      setSpeed,
      updatePending
    }),
    [presentation, retry, setActive, setEffect, setSpeed, updatePending]
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
