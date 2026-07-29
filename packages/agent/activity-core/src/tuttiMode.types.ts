export interface AgentActivityCapabilityReference {
  capability: "tutti";
  source: "slash_command";
}

export type AgentActivityTuttiModeActivationStatus = "active" | "inactive";
export type AgentActivityTuttiModeActivationSource =
  | "slash_command"
  | "badge_remove";

export interface AgentActivityTuttiModeActivationRevision {
  activationId: string;
  revision: number;
  status: AgentActivityTuttiModeActivationStatus;
  source: AgentActivityTuttiModeActivationSource;
  /**
   * Outcome-quality preference. Optional while legacy revision producers are
   * supported; consumers fall back to orchestrationIntensity.
   */
  effect?: number;
  /**
   * Completion-speed preference. Optional while legacy revision producers are
   * supported; consumers use the balanced default when absent.
   */
  speed?: number;
  /**
   * Legacy single-axis alias of effect.
   *
   * @deprecated Use effect and speed.
   */
  orchestrationIntensity: number;
  createdAtUnixMs: number;
}

export interface AgentActivityTuttiModeActivation {
  id: string;
  workspaceId: string;
  agentSessionId: string;
  status: AgentActivityTuttiModeActivationStatus;
  currentRevision: AgentActivityTuttiModeActivationRevision;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface AgentActivityInitialTuttiModeActivation {
  status: "active";
  source: "slash_command";
  effect?: number | null;
  speed?: number | null;
  /**
   * Legacy single-axis alias of effect. Ignored when effect is present.
   *
   * @deprecated Use effect and speed.
   */
  orchestrationIntensity?: number | null;
}

export interface AgentActivityUpdateTuttiModeActivationInput {
  workspaceId: string;
  agentSessionId: string;
  status: AgentActivityTuttiModeActivationStatus;
  source: AgentActivityTuttiModeActivationSource;
  effect?: number | null;
  speed?: number | null;
  /**
   * Legacy single-axis alias of effect. Ignored when effect is present.
   *
   * @deprecated Use effect and speed.
   */
  orchestrationIntensity?: number | null;
  expectedRevision?: number | null;
  signal?: AbortSignal;
}

export interface AgentActivityUpdateTuttiModeActivationResult {
  activation: AgentActivityTuttiModeActivation;
  changed: boolean;
}
