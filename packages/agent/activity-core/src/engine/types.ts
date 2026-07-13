// Workspace session engine contract types
// (docs/architecture/agent-gui-refactor-plan.md, sections 3.3 and 4.1).
//
// The engine is the single orchestration layer for agent activity: user
// intents and runtime events enter one dispatch loop, pure reducers compute
// the next state plus command descriptions, and an executor without decision
// logic performs the commands and feeds results back as new intents.
//
// This file is the skeleton contract. Domain slices (turn lifecycle, queue,
// optimistic intents) extend the intent/command unions and the state tree as
// the refactor slices land.

/**
 * Engine instances are identified by the workspace plus origin pair. Origin
 * distinguishes runtimes feeding the same workspace (for example a local
 * tuttid runtime versus an external shared-room runtime), and is a first-class
 * identity rather than a patch field. Hosts create one engine per pair and
 * inject it explicitly; module-level singletons are forbidden.
 */
export interface AgentSessionEngineIdentity {
  origin: string;
  workspaceId: string;
}

export const AGENT_SESSION_ENGINE_LOCAL_ORIGIN =
  "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME";

export type EngineConnectionStatus = "connected" | "disconnected" | "unknown";

// ---------------------------------------------------------------------------
// Intents: the only input of the engine. User intents, runtime events,
// command results, and expiries all enter the same dispatch loop.
// ---------------------------------------------------------------------------

export interface EngineConnectionChangedIntent {
  type: "engine/connectionChanged";
  status: EngineConnectionStatus;
  workspaceId?: string;
}

export interface WorkspaceReconcileRequestedIntent {
  type: "workspace/reconcileRequested";
  workspaceId: string;
  retry?: boolean;
}

/** Requests a command-port round trip; exercises the executor feedback loop. */
export interface EngineProbeRequestedIntent {
  type: "engine/probeRequested";
  probeId: string;
  timeoutMs?: number;
}

/** Asks the host clock to deliver an expiry intent at the given deadline. */
export interface EngineExpiryRequestedIntent {
  type: "engine/expiryRequested";
  expiryId: string;
  dueAtUnixMs: number;
}

export interface EngineExpiryCancelRequestedIntent {
  type: "engine/expiryCancelRequested";
  expiryId: string;
}

export type EngineCommandOutcome = "failed" | "succeeded" | "timedOut";

/**
 * Every command execution settles back into the loop as this intent, so
 * failure and timeout handling are explicit reducer transitions instead of
 * executor-side improvisation.
 */
export interface EngineCommandResultIntent {
  type: "engine/commandResult";
  commandId: string;
  commandType: EngineExternalCommand["type"];
  correlationId?: string;
  outcome: EngineCommandOutcome;
  value?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Delivered by the expiry clock when a scheduled deadline elapses. Reducers
 * never read the wall clock or set timers; tests dispatch this directly.
 */
export interface EngineIntentExpiredIntent {
  type: "engine/intentExpired";
  expiryId: string;
  dueAtUnixMs: number;
}

export type EngineIntent =
  | AttentionReadIntent
  | EngineCommandResultIntent
  | EngineConnectionChangedIntent
  | EngineExpiryCancelRequestedIntent
  | EngineExpiryRequestedIntent
  | EngineIntentExpiredIntent
  | EngineProbeRequestedIntent
  | WorkspaceReconcileRequestedIntent
  | PendingIntentsIntent
  | PlanDecisionIntent
  | PromptQueueIntent
  | SessionReconcileIntent
  | SessionCommandsIntent
  | SessionLifecycleIntent;

// ---------------------------------------------------------------------------
// Commands: descriptions returned by reducers. Internal commands are handled
// by the expiry clock; external commands go through the injected command port.
// ---------------------------------------------------------------------------

export interface EngineScheduleExpiryCommand {
  type: "engine/scheduleExpiry";
  expiryId: string;
  dueAtUnixMs: number;
}

export interface EngineCancelExpiryCommand {
  type: "engine/cancelExpiry";
  expiryId: string;
}

export interface EngineExternalCommandBase {
  commandId: string;
  timeoutMs?: number;
}

/** Round-trip health probe; domain slices add real runtime commands here. */
export interface EngineProbeCommand extends EngineExternalCommandBase {
  type: "engine/probe";
}

export interface EngineReconcileWorkspaceCommand extends EngineExternalCommandBase {
  type: "engine/reconcileWorkspace";
  workspaceId: string;
}

export type EngineInternalCommand =
  | EngineCancelExpiryCommand
  | EngineScheduleExpiryCommand;

export type EngineExternalCommand =
  | AttentionReadCommand
  | EngineProbeCommand
  | EngineReconcileWorkspaceCommand
  | InteractionRespondCommand
  | PlanSubmitDecisionCommand
  | PromptQueueSendCommand
  | SessionActivateCommand
  | SessionUpdateSettingsCommand
  | SessionUnactivateCommand
  | SessionReconcileCommand
  | TurnCancelCommand;

export type EngineCommand = EngineExternalCommand | EngineInternalCommand;

export function isEngineInternalCommand(
  command: EngineCommand
): command is EngineInternalCommand {
  return (
    command.type === "engine/cancelExpiry" ||
    command.type === "engine/scheduleExpiry"
  );
}

// ---------------------------------------------------------------------------
// State tree and reducer contract.
// ---------------------------------------------------------------------------

export interface EngineRuntimeCommandResultRecord {
  commandId: string;
  errorMessage?: string;
  outcome: EngineCommandOutcome;
}

/** Engine self state: the minimal skeleton domain driving interleaving tests. */
export interface EngineRuntimeState {
  connection: EngineConnectionStatus;
  lastCommandResult: EngineRuntimeCommandResultRecord | null;
  lastExpiredIntentId: string | null;
  processedIntentCount: number;
  workspaceReconcile: {
    commandId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    status: "idle" | "loading" | "ready" | "failed" | "unknown";
  };
}

export interface AgentSessionEngineState {
  attentionReadState: AttentionReadState;
  engineRuntime: EngineRuntimeState;
  pendingIntents: PendingIntentsState;
  planDecisions: PlanDecisionState;
  promptQueue: PromptQueueState;
  sessionReconcile: SessionReconcileState;
  sessionCommands: SessionCommandsState;
  sessionLifecycle: SessionLifecycleState;
}

export interface EngineReducerResult<TState> {
  commands: readonly EngineCommand[];
  state: TState;
}

/**
 * Domain reducers are pure: no timers, no clocks, no I/O. Timing enters as
 * expiry intents; side effects leave as command descriptions.
 */
export type EngineDomainReducer<TState> = (
  state: TState,
  intent: EngineIntent
) => EngineReducerResult<TState>;

// ---------------------------------------------------------------------------
// Host-injected ports. The engine directory forbids setTimeout/setInterval;
// all scheduling goes through these ports so tests can drive a manual clock.
// ---------------------------------------------------------------------------

export interface EngineScheduledTask {
  cancel(): void;
}

export interface EngineScheduler {
  schedule(delayMs: number, task: () => void): EngineScheduledTask;
}

export interface EngineClock {
  nowUnixMs(): number;
}

/** Transport adapter surface: executes external command descriptions. */
export interface EngineCommandPort {
  execute(
    command: EngineExternalCommand,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Engine public surface.
// ---------------------------------------------------------------------------

export interface EngineDispatchOptions {
  /**
   * Coalesce this intent with other batched intents inside the frame window
   * (high-frequency streaming events). Non-batched dispatches flush pending
   * batched intents first so cross-intent ordering is preserved.
   */
  batch?: boolean;
}

export type AgentSessionEngineListener = (
  state: AgentSessionEngineState
) => void;

export interface AgentSessionEngine {
  readonly identity: AgentSessionEngineIdentity;
  dispatch(intent: EngineIntent, options?: EngineDispatchOptions): void;
  dispose(): void;
  getSnapshot(): AgentSessionEngineState;
  subscribe(listener: AgentSessionEngineListener): () => void;
}
import type {
  PromptQueueIntent,
  PromptQueueSendCommand,
  PromptQueueState
} from "./promptQueue.types.ts";
import type {
  PendingIntentsIntent,
  PendingIntentsState,
  SessionActivateCommand,
  SessionUpdateSettingsCommand,
  SessionUnactivateCommand
} from "./pendingIntents.types.ts";
import type {
  InteractionRespondCommand,
  SessionLifecycleIntent,
  SessionLifecycleState,
  TurnCancelCommand
} from "./sessionLifecycle.types.ts";
import type {
  SessionReconcileCommand,
  SessionReconcileIntent,
  SessionReconcileState
} from "./sessionReconcile.types.ts";
import type {
  AttentionReadCommand,
  AttentionReadIntent,
  AttentionReadState
} from "./attentionReadState.types.ts";
import type {
  PlanDecisionIntent,
  PlanDecisionState,
  PlanSubmitDecisionCommand
} from "./planDecision.types.ts";
import type {
  SessionCommandsIntent,
  SessionCommandsState
} from "./sessionCommands.types.ts";
