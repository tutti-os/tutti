import type {
  AgentActivityInitialTuttiModeActivation,
  AgentActivityTuttiModeActivation,
  AgentActivityTuttiModeActivationSource,
  AgentActivityTuttiModeActivationStatus
} from "../types.ts";

export interface TuttiModeDraftIntentRecord {
  active: true;
  draftKey: string;
  occurredAtUnixMs: number;
  /** null = 未选择,交给 daemon 默认值。 */
  orchestrationIntensity: number | null;
  source: "slash_command";
}

export interface TuttiModePendingCreateRecord {
  agentSessionId: string;
  draftKey: string;
  initialActivation: AgentActivityInitialTuttiModeActivation;
  reconcileCommandId: string | null;
  requestId: string;
  workspaceId: string;
}

export type TuttiModeActivationUpdateStatus =
  | "inFlight"
  | "failed"
  | "uncertain";

export interface TuttiModeActivationUpdateRecord {
  agentSessionId: string;
  commandId: string;
  errorCode: string | null;
  errorMessage: string | null;
  expectedRevision: number | null;
  orchestrationIntensity: number | null;
  reconcileCommandId: string | null;
  requestedAtUnixMs: number;
  source: AgentActivityTuttiModeActivationSource;
  status: AgentActivityTuttiModeActivationStatus;
  updateStatus: TuttiModeActivationUpdateStatus;
  workspaceId: string;
}

export interface TuttiModeActivationState {
  activationsBySessionId: Readonly<
    Record<string, AgentActivityTuttiModeActivation | null>
  >;
  draftsByKey: Readonly<Record<string, TuttiModeDraftIntentRecord>>;
  pendingCreatesBySessionId: Readonly<
    Record<string, TuttiModePendingCreateRecord>
  >;
  updatesBySessionId: Readonly<Record<string, TuttiModeActivationUpdateRecord>>;
}

export interface TuttiModeDraftSetIntent {
  type: "tuttiMode/draftSet";
  active: boolean;
  draftKey: string;
  occurredAtUnixMs: number;
  orchestrationIntensity?: number | null;
}

export interface TuttiModeActivationUpdateRequestedIntent {
  type: "tuttiMode/updateRequested";
  agentSessionId: string;
  commandId: string;
  orchestrationIntensity?: number | null;
  requestedAtUnixMs: number;
  source: AgentActivityTuttiModeActivationSource;
  status: AgentActivityTuttiModeActivationStatus;
  workspaceId: string;
}

export type TuttiModeActivationIntent =
  | TuttiModeDraftSetIntent
  | TuttiModeActivationUpdateRequestedIntent;

export interface TuttiModeActivationUpdateCommand {
  type: "tuttiMode/update";
  agentSessionId: string;
  commandId: string;
  expectedRevision?: number;
  orchestrationIntensity?: number;
  source: AgentActivityTuttiModeActivationSource;
  status: AgentActivityTuttiModeActivationStatus;
  timeoutMs?: number;
  workspaceId: string;
}

export type TuttiModeActivationCommand = TuttiModeActivationUpdateCommand;
