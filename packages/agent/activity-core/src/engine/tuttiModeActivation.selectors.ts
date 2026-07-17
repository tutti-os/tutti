import type { AgentActivityTuttiModeActivation } from "../types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export interface TuttiModeActivationPresentation {
  activation: AgentActivityTuttiModeActivation | null;
  active: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  orchestrationIntensity: number;
  updateStatus: "idle" | "pending_create" | "updating" | "failed" | "uncertain";
}

const DEFAULT_ORCHESTRATION_INTENSITY = 50;

export function selectTuttiModeDraftIsActive(
  state: AgentSessionEngineState,
  draftKey: string
): boolean {
  return (
    state.tuttiModeActivation.draftsByKey[draftKey.trim()]?.active === true
  );
}

export function selectTuttiModeDraftOrchestrationIntensity(
  state: AgentSessionEngineState,
  draftKey: string
): number | null {
  return (
    state.tuttiModeActivation.draftsByKey[draftKey.trim()]
      ?.orchestrationIntensity ?? null
  );
}

export function selectTuttiModeActivationPresentation(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  draftKey: string
): TuttiModeActivationPresentation {
  const sessionId = agentSessionId?.trim() ?? "";
  const draftIntensity = selectTuttiModeDraftOrchestrationIntensity(
    state,
    draftKey
  );
  if (!sessionId) {
    return {
      activation: null,
      active: selectTuttiModeDraftIsActive(state, draftKey),
      errorCode: null,
      errorMessage: null,
      orchestrationIntensity: draftIntensity ?? DEFAULT_ORCHESTRATION_INTENSITY,
      updateStatus: "idle"
    };
  }
  const update = state.tuttiModeActivation.updatesBySessionId[sessionId];
  const activation =
    state.tuttiModeActivation.activationsBySessionId[sessionId] ?? null;
  if (update) {
    return {
      activation,
      active:
        update.updateStatus === "failed"
          ? activation?.status === "active"
          : update.status === "active",
      errorCode: update.errorCode,
      errorMessage: update.errorMessage,
      orchestrationIntensity:
        update.orchestrationIntensity ??
        activation?.currentRevision.orchestrationIntensity ??
        draftIntensity ??
        DEFAULT_ORCHESTRATION_INTENSITY,
      updateStatus:
        update.updateStatus === "inFlight" ? "updating" : update.updateStatus
    };
  }
  const pending =
    state.tuttiModeActivation.pendingCreatesBySessionId[sessionId];
  if (pending) {
    return {
      activation,
      active: pending.initialActivation.status === "active",
      errorCode: null,
      errorMessage: null,
      orchestrationIntensity:
        pending.initialActivation.orchestrationIntensity ??
        activation?.currentRevision.orchestrationIntensity ??
        draftIntensity ??
        DEFAULT_ORCHESTRATION_INTENSITY,
      updateStatus: "pending_create"
    };
  }
  return {
    activation,
    active: activation?.status === "active",
    errorCode: null,
    errorMessage: null,
    orchestrationIntensity:
      activation?.currentRevision.orchestrationIntensity ??
      draftIntensity ??
      DEFAULT_ORCHESTRATION_INTENSITY,
    updateStatus: "idle"
  };
}

export function tuttiModeActivationPresentationsEqual(
  left: TuttiModeActivationPresentation,
  right: TuttiModeActivationPresentation
): boolean {
  return (
    left.active === right.active &&
    left.errorCode === right.errorCode &&
    left.errorMessage === right.errorMessage &&
    left.orchestrationIntensity === right.orchestrationIntensity &&
    left.updateStatus === right.updateStatus &&
    activationIdentity(left.activation) === activationIdentity(right.activation)
  );
}

function activationIdentity(
  activation: AgentActivityTuttiModeActivation | null
): string {
  return activation
    ? `${activation.id}:${activation.currentRevision.revision}:${activation.status}`
    : "";
}
