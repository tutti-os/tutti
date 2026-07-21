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
  orchestrationIntensity?: number | null;
}

export interface AgentActivityUpdateTuttiModeActivationInput {
  workspaceId: string;
  agentSessionId: string;
  status: AgentActivityTuttiModeActivationStatus;
  source: AgentActivityTuttiModeActivationSource;
  orchestrationIntensity?: number | null;
  expectedRevision?: number | null;
  signal?: AbortSignal;
}

export interface AgentActivityUpdateTuttiModeActivationResult {
  activation: AgentActivityTuttiModeActivation;
  changed: boolean;
}
