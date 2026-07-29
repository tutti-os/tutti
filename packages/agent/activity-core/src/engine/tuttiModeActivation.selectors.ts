import type { AgentActivityTuttiModeActivation } from "../types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export interface TuttiModeActivationPresentation {
  activation: AgentActivityTuttiModeActivation | null;
  active: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  effect?: number;
  speed?: number;
  /** @deprecated Use effect and speed. */
  orchestrationIntensity: number;
  updateStatus: "idle" | "pending_create" | "updating" | "failed" | "uncertain";
}

export interface ResolvedTuttiModeActivationPresentation extends TuttiModeActivationPresentation {
  effect: number;
  speed: number;
}

const DEFAULT_PREFERENCE = 50;

export function selectTuttiModeDraftIsActive(
  state: AgentSessionEngineState,
  draftKey: string
): boolean {
  return (
    state.tuttiModeActivation.draftsByKey[draftKey.trim()]?.active === true
  );
}

export function selectTuttiModeDraftPreferences(
  state: AgentSessionEngineState,
  draftKey: string
): { effect: number | null; speed: number | null } {
  const draft = state.tuttiModeActivation.draftsByKey[draftKey.trim()];
  return {
    effect: draft?.effect ?? draft?.orchestrationIntensity ?? null,
    speed: draft?.speed ?? null
  };
}

/**
 * @deprecated Use selectTuttiModeDraftPreferences.
 */
export function selectTuttiModeDraftOrchestrationIntensity(
  state: AgentSessionEngineState,
  draftKey: string
): number | null {
  return selectTuttiModeDraftPreferences(state, draftKey).effect;
}

export function selectTuttiModeActivationPresentation(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  draftKey: string
): ResolvedTuttiModeActivationPresentation {
  const sessionId = agentSessionId?.trim() ?? "";
  const draftPreferences = selectTuttiModeDraftPreferences(state, draftKey);
  if (!sessionId) {
    return {
      activation: null,
      active: selectTuttiModeDraftIsActive(state, draftKey),
      errorCode: null,
      errorMessage: null,
      effect: draftPreferences.effect ?? DEFAULT_PREFERENCE,
      speed: draftPreferences.speed ?? DEFAULT_PREFERENCE,
      orchestrationIntensity: draftPreferences.effect ?? DEFAULT_PREFERENCE,
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
      effect:
        update.effect ??
        update.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
      speed:
        update.speed ??
        activationSpeed(activation) ??
        draftPreferences.speed ??
        DEFAULT_PREFERENCE,
      orchestrationIntensity:
        update.effect ??
        update.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
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
      effect:
        pending.initialActivation.effect ??
        pending.initialActivation.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
      speed:
        pending.initialActivation.speed ??
        activationSpeed(activation) ??
        draftPreferences.speed ??
        DEFAULT_PREFERENCE,
      orchestrationIntensity:
        pending.initialActivation.effect ??
        pending.initialActivation.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
      updateStatus: "pending_create"
    };
  }
  return {
    activation,
    active: activation?.status === "active",
    errorCode: null,
    errorMessage: null,
    effect:
      activationEffect(activation) ??
      draftPreferences.effect ??
      DEFAULT_PREFERENCE,
    speed:
      activationSpeed(activation) ??
      draftPreferences.speed ??
      DEFAULT_PREFERENCE,
    orchestrationIntensity:
      activationEffect(activation) ??
      draftPreferences.effect ??
      DEFAULT_PREFERENCE,
    updateStatus: "idle"
  };
}

function activationEffect(
  activation: AgentActivityTuttiModeActivation | null
): number | null {
  return activation
    ? (activation.currentRevision.effect ??
        activation.currentRevision.orchestrationIntensity)
    : null;
}

function activationSpeed(
  activation: AgentActivityTuttiModeActivation | null
): number | null {
  return activation
    ? (activation.currentRevision.speed ?? DEFAULT_PREFERENCE)
    : null;
}

export function tuttiModeActivationPresentationsEqual(
  left: TuttiModeActivationPresentation,
  right: TuttiModeActivationPresentation
): boolean {
  return (
    left.active === right.active &&
    left.errorCode === right.errorCode &&
    left.errorMessage === right.errorMessage &&
    left.effect === right.effect &&
    left.speed === right.speed &&
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
