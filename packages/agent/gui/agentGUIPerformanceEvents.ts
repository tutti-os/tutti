import type {
  PendingActivationCommandOutcome,
  PendingActivationLastObservedStage,
  PendingActivationSnapshotOutcome
} from "@tutti-os/agent-activity-core";

export type AgentGUIPerformanceDurationBucket =
  | "lt_1s"
  | "1s_to_3s"
  | "3s_to_10s"
  | "10s_to_30s"
  | "30s_to_60s"
  | "gte_60s";

export type AgentGUIFirstTokenKind = "other" | "plan" | "reasoning" | "text";

export type AgentGUIComposerOptionsLoadSource = "runtime" | "session-engine";

interface AgentGUIPerformanceEventBase {
  agentSessionId: string;
  durationBucket: AgentGUIPerformanceDurationBucket;
  durationMs: number;
  observedAtUnixMs: number;
  operationId: string;
  provider: string;
  startedAtUnixMs: number;
  workspaceId: string;
}

export type AgentGUIPerformanceEvent =
  | (AgentGUIPerformanceEventBase & {
      commandDurationMs?: number;
      commandOutcome: PendingActivationCommandOutcome;
      errorCategory?: string;
      hasInitialPrompt: boolean;
      lastObservedStage: PendingActivationLastObservedStage;
      mode: "existing" | "new";
      outcome: "confirmed" | "failed";
      snapshotDurationMs?: number;
      snapshotOutcome: PendingActivationSnapshotOutcome;
      type: "session_activation_settled";
    })
  | (AgentGUIPerformanceEventBase & {
      errorCategory?: string;
      outcome: "accepted" | "failed";
      queued: boolean;
      source: "activation" | "submit";
      turnId: string | null;
      type: "prompt_admission_settled";
    })
  | (AgentGUIPerformanceEventBase & {
      firstTokenKind: AgentGUIFirstTokenKind;
      queued: boolean;
      source: "activation" | "submit";
      turnId: string;
      type: "prompt_first_token_received";
    })
  | (AgentGUIPerformanceEventBase & {
      errorCategory?: string;
      outcome: "canceled" | "completed" | "failed" | "interrupted";
      source: "activation" | "submit";
      turnId: string;
      type: "turn_settled";
    })
  | {
      agentTargetId: string;
      force: boolean;
      hasDirectory: boolean;
      observedAtUnixMs: number;
      operationId: string;
      provider: string;
      source: AgentGUIComposerOptionsLoadSource;
      startedAtUnixMs: number;
      type: "composer_options_load_started";
      workspaceId: string;
    }
  | {
      agentTargetId: string;
      durationBucket: AgentGUIPerformanceDurationBucket;
      durationMs: number;
      errorCategory?: string;
      force: boolean;
      hasDirectory: boolean;
      modelCount?: number;
      observedAtUnixMs: number;
      operationId: string;
      outcome: "completed" | "failed";
      provider: string;
      source: AgentGUIComposerOptionsLoadSource;
      startedAtUnixMs: number;
      type: "composer_options_load_settled";
      workspaceId: string;
    };

export type AgentGUIComposerOptionsPerformanceEvent = Extract<
  AgentGUIPerformanceEvent,
  { type: "composer_options_load_settled" | "composer_options_load_started" }
>;
