import { useCallback, useRef, useState } from "react";
import type { AgentConversationFollowEndMode } from "../agentConversationFollowEndController";
import { agentTranscriptResponseSpacerHeight } from "./agentTranscriptVirtualizerLayout";

export function useAgentTranscriptResponseSpacer(input: {
  agentSessionId: string;
  bottomInsetPx(): number;
  followEndMode: AgentConversationFollowEndMode;
  isLatestTurnInProgress: boolean;
  latestTurnKey: string | null;
}) {
  const [spacer, setSpacer] = useState<{
    scopeGeneration: number;
    heightPx: number;
    turnKey: string;
  } | null>(null);
  const scopeRef = useRef({
    agentSessionId: input.agentSessionId,
    generation: 0
  });
  if (scopeRef.current.agentSessionId !== input.agentSessionId) {
    scopeRef.current = {
      agentSessionId: input.agentSessionId,
      generation: scopeRef.current.generation + 1
    };
  }
  const scopeGeneration = scopeRef.current.generation;
  const scopedSpacer =
    spacer?.scopeGeneration === scopeGeneration ? spacer : null;
  const followsEnd = input.followEndMode === "following";
  const activatesSpacer =
    followsEnd && input.isLatestTurnInProgress && input.latestTurnKey !== null;
  const dismissedActivationRef = useRef<{
    scopeGeneration: number;
    turnKey: string;
  } | null>(null);
  const activationDismissed =
    activatesSpacer &&
    dismissedActivationRef.current?.scopeGeneration === scopeGeneration &&
    dismissedActivationRef.current.turnKey === input.latestTurnKey;
  const heightPx = scopedSpacer?.heightPx ?? 0;
  const scopeGenerationRef = useRef(scopeGeneration);
  const followsEndRef = useRef(followsEnd);
  const latestTurnKeyRef = useRef(input.latestTurnKey);
  const activeTurnKeyRef = useRef(activatesSpacer ? input.latestTurnKey : null);
  const bottomInsetPxRef = useRef(input.bottomInsetPx);
  const spacerRef = useRef(scopedSpacer);
  const heightRef = useRef(heightPx);
  const updateForViewportRef = useRef<(heightPx: number) => void>(() => {});

  scopeGenerationRef.current = scopeGeneration;
  followsEndRef.current = followsEnd;
  latestTurnKeyRef.current = input.latestTurnKey;
  activeTurnKeyRef.current = activatesSpacer ? input.latestTurnKey : null;
  bottomInsetPxRef.current = input.bottomInsetPx;
  spacerRef.current = scopedSpacer;
  heightRef.current = heightPx;
  updateForViewportRef.current = (viewportHeightPx) => {
    const activeTurnKey = followsEndRef.current
      ? activeTurnKeyRef.current
      : null;
    const activeTurnDismissed =
      activeTurnKey !== null &&
      dismissedActivationRef.current?.scopeGeneration ===
        scopeGenerationRef.current &&
      dismissedActivationRef.current.turnKey === activeTurnKey;
    const spacerTurnKey =
      (activeTurnDismissed ? null : activeTurnKey) ??
      spacerRef.current?.turnKey ??
      null;
    if (!spacerTurnKey) return;
    const nextHeightPx = agentTranscriptResponseSpacerHeight({
      bottomInsetPx: bottomInsetPxRef.current(),
      viewportHeightPx
    });
    const nextSpacer = {
      scopeGeneration: scopeGenerationRef.current,
      heightPx: nextHeightPx,
      turnKey: spacerTurnKey
    };
    if (
      spacerRef.current?.scopeGeneration === nextSpacer.scopeGeneration &&
      spacerRef.current?.turnKey === spacerTurnKey &&
      spacerRef.current.heightPx === nextHeightPx
    ) {
      return;
    }
    spacerRef.current = nextSpacer;
    heightRef.current = nextHeightPx;
    setSpacer(nextSpacer);
  };

  const growHeight = useCallback((heightDeltaPx: number): void => {
    if (heightDeltaPx <= 0 || spacerRef.current === null) return;
    const nextHeightPx = spacerRef.current.heightPx + heightDeltaPx;
    const nextSpacer = {
      scopeGeneration: spacerRef.current.scopeGeneration,
      heightPx: nextHeightPx,
      turnKey: spacerRef.current.turnKey
    };
    spacerRef.current = nextSpacer;
    heightRef.current = nextHeightPx;
    setSpacer(nextSpacer);
  }, []);
  const dismissHeight = useCallback((): void => {
    const dismissedTurnKey =
      latestTurnKeyRef.current ?? spacerRef.current?.turnKey ?? null;
    if (dismissedTurnKey !== null) {
      dismissedActivationRef.current = {
        scopeGeneration: scopeGenerationRef.current,
        turnKey: dismissedTurnKey
      };
    }
    if (spacerRef.current === null) return;
    spacerRef.current = null;
    heightRef.current = 0;
    setSpacer(null);
  }, []);

  return {
    activationKey:
      activatesSpacer && !activationDismissed ? input.latestTurnKey : null,
    dismissHeight,
    growHeight,
    heightPx,
    heightRef,
    spacerRef,
    updateForViewportRef
  };
}
