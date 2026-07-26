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
  errorReason?: string;
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
  | SessionMutationsIntent
  | SessionCommandsIntent
  | SessionLifecycleIntent
  | ComposerOptionsIntent
  | EditRetryIntent
  | TuttiModeActivationIntent;

// ---------------------------------------------------------------------------
// Commands: descriptions returned by reducers. Internal commands are handled
// by the expiry clock; external commands go through the injected command port.
// ---------------------------------------------------------------------------

export interface EngineScheduleExpiryCommand {
  type: "engine/scheduleExpiry";
  expiryId: string;
  dueAtUnixMs: number;
}

/**
 * Schedules an expiry relative to command application time. This keeps
 * reducer-owned retry backoff pure: reducers describe a delay while the
 * Engine clock resolves the absolute deadline.
 */
export interface EngineScheduleExpiryAfterCommand {
  type: "engine/scheduleExpiryAfter";
  expiryId: string;
  delayMs: number;
}

export interface EngineCancelExpiryCommand {
  type: "engine/cancelExpiry";
  expiryId: string;
}

/** Cancels one in-flight external command without coupling reducers to I/O. */
export interface EngineAbortExternalCommand {
  type: "engine/abortExternalCommand";
  reason: string;
  targetCommandId: string;
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

export type EngineExpiryCommand =
  | EngineCancelExpiryCommand
  | EngineScheduleExpiryAfterCommand
  | EngineScheduleExpiryCommand;

export type EngineInternalCommand =
  | EngineAbortExternalCommand
  | EngineExpiryCommand;

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
  | SessionMutationCommand
  | TurnCancelCommand
  | ComposerOptionsCommand
  | EditRetryCommand
  | TuttiModeActivationCommand;

export type EngineExternalCommandExceptPlanDecision = Exclude<
  EngineExternalCommand,
  PlanSubmitDecisionCommand
>;

type AgentSessionEffectCommand =
  | Extract<
      SessionMutationCommand,
      { type: "session/setPinned" | "sessions/delete" }
    >
  | InteractionRespondCommand
  | PromptQueueSendCommand
  | SessionActivateCommand
  | SessionUpdateSettingsCommand
  | TurnCancelCommand;

export type EngineExtensionCommand = Exclude<
  EngineExternalCommandExceptPlanDecision,
  AgentSessionEffectCommand
>;

export type EngineCommand = EngineExternalCommand | EngineInternalCommand;

export function isEngineInternalCommand(
  command: EngineCommand
): command is EngineInternalCommand {
  return (
    command.type === "engine/abortExternalCommand" ||
    command.type === "engine/cancelExpiry" ||
    command.type === "engine/scheduleExpiryAfter" ||
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
  editRetry: EditRetryState;
  engineRuntime: EngineRuntimeState;
  pendingIntents: PendingIntentsState;
  planDecisions: PlanDecisionState;
  promptQueue: PromptQueueState;
  sessionReconcile: SessionReconcileState;
  sessionMutations: SessionMutationsState;
  sessionCommands: SessionCommandsState;
  sessionLifecycle: SessionLifecycleState;
  sessionMessages: SessionMessagesState;
  composerOptions: ComposerOptionsState;
  tuttiModeActivation: TuttiModeActivationState;
}

export interface EngineReducerResult<TState> {
  commands: readonly EngineCommand[];
  followUpIntents?: readonly EngineIntent[];
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

export interface EngineEffectOptions {
  signal?: AbortSignal;
}

interface AgentSessionActivateEffectInputBase {
  agentSessionId: string;
  capabilityRefs?: readonly AgentActivityCapabilityReference[];
  cwd?: string;
  initialContent?: AgentPromptContentBlock[];
  initialDisplayPrompt?: string;
  railPlacement?: AgentActivityRailPlacement;
  settings?: AgentActivitySessionSettings;
  submitDiagnostics?: Readonly<AgentActivitySubmitDiagnostics>;
  title?: string;
  visible?: boolean;
  workspaceId: string;
}

/**
 * Host-neutral activation request. Engine commands stay private orchestration
 * details; hosts implement lifecycle capabilities in domain terms.
 */
export type AgentSessionActivateEffectInput =
  | (AgentSessionActivateEffectInputBase & {
      agentTargetId: string;
      clientSubmitId: string;
      initialGoalControl?: Readonly<AgentActivityInitialGoalControl>;
      initialTuttiModeActivation?: AgentActivityInitialTuttiModeActivation;
      mode: "new";
    })
  | (AgentSessionActivateEffectInputBase & {
      agentTargetId?: string | null;
      clientSubmitId?: never;
      mode: "existing";
    });

export interface AgentSessionEffectPort {
  activateSession(
    input: AgentSessionActivateEffectInput,
    options?: EngineEffectOptions
  ): Promise<unknown>;
  cancelTurn(
    input: AgentActivityCancelTurnInput,
    options?: EngineEffectOptions
  ): Promise<unknown>;
  deleteSessions(
    input: Omit<AgentActivityDeleteSessionsInput, "signal">,
    options?: EngineEffectOptions
  ): Promise<unknown>;
  respondToInteraction(
    input: AgentActivitySubmitInteractiveInput,
    options?: EngineEffectOptions
  ): Promise<unknown>;
  sendInput(
    input: AgentActivitySendInput,
    options?: EngineEffectOptions
  ): Promise<unknown>;
  setSessionPinned(
    input: Omit<AgentActivitySetSessionPinnedInput, "signal">,
    options?: EngineEffectOptions
  ): Promise<unknown>;
  updateSessionSettings(
    input: {
      agentSessionId: string;
      commandId: string;
      correlationId: string;
      settings: AgentActivitySessionSettings;
      workspaceId: string;
    },
    options?: EngineEffectOptions
  ): Promise<unknown>;
}

interface EngineCommandPortBase {
  observe?(command: EngineExternalCommand): void;
  executePlanDecision?(
    command: PlanSubmitDecisionCommand,
    options?: EngineEffectOptions
  ): Promise<PlanSubmitDecisionResult>;
}

/**
 * Compatibility surface for published-package consumers that still translate
 * the complete command union themselves.
 */
export interface EngineCommandPort extends EngineCommandPortBase {
  effects?: never;
  kind?: "legacy";
  execute(
    command: EngineExternalCommandExceptPlanDecision,
    options?: EngineEffectOptions
  ): Promise<unknown>;
}

/**
 * Preferred host surface. The Engine owns shared lifecycle projection and the
 * host executes only platform/product extensions.
 */
export interface EngineTypedCommandPort extends EngineCommandPortBase {
  effects: AgentSessionEffectPort;
  execute(
    command: EngineExtensionCommand,
    options?: EngineEffectOptions
  ): Promise<unknown>;
  kind: "typed";
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

export type AgentSessionEngineIntentObserver = (intent: EngineIntent) => void;

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
  PlanSubmitDecisionCommand,
  PlanSubmitDecisionResult
} from "./planDecision.types.ts";
import type {
  SessionCommandsIntent,
  SessionCommandsState
} from "./sessionCommands.types.ts";
import type { SessionMessagesState } from "./sessionMessages.types.ts";
import type {
  ComposerOptionsCommand,
  ComposerOptionsIntent,
  ComposerOptionsState
} from "./composerOptions.types.ts";
import type {
  SessionMutationCommand,
  SessionMutationsIntent,
  SessionMutationsState
} from "./sessionMutations.types.ts";
import type {
  TuttiModeActivationCommand,
  TuttiModeActivationIntent,
  TuttiModeActivationState
} from "./tuttiModeActivation.types.ts";
import type {
  AgentActivityCancelTurnInput,
  AgentActivityDeleteSessionsInput,
  AgentActivityInitialGoalControl,
  AgentActivitySendInput,
  AgentActivitySetSessionPinnedInput,
  AgentActivitySessionSettings,
  AgentActivitySubmitDiagnostics,
  AgentActivitySubmitInteractiveInput,
  AgentPromptContentBlock
} from "../types.ts";
import type { AgentActivityRailPlacement } from "../railPlacement.types.ts";
import type {
  AgentActivityCapabilityReference,
  AgentActivityInitialTuttiModeActivation
} from "../tuttiMode.types.ts";
import type {
  EditRetryCommand,
  EditRetryIntent,
  EditRetryState
} from "./editRetry.types.ts";
