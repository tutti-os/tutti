import {
  selectEngineActiveTurn,
  selectEngineGoalControl,
  selectEngineInteraction,
  selectEngineSession,
  selectEngineSessionRuntimeAvailability,
  selectEngineSubmitWouldBeVisibleInQueue,
  selectEngineTurn,
  type AgentSessionEngineState,
  type EngineExternalCommand,
  type EngineIntent
} from "@tutti-os/agent-activity-core";

/**
 * Single registry for the per-interaction-type Agent Session Replay behavior
 * contract. One entry per replayable intent type declares:
 *
 * - the effect command types that intent may cause and whether the recorded
 *   timeline is complete only when at least one effect references it (kept in
 *   sync with `packages/agent/session-replay/activity-contract.json`);
 * - how the recorder extracts correlation keys from the live intent;
 * - alternate correlation rules the replay driver may use to bind a recorded
 *   effect to a live engine command;
 * - whether replay must materialize a commandId before dispatching;
 * - the timestamp/expiry rebase rule applied to the recorded payload;
 * - the engine-snapshot readiness predicate replay waits for.
 *
 * Adding a new replayable EngineIntent type is a deliberate, single-place
 * change: add its entry here and mirror it in activity-contract.json.
 */

export type AgentSessionReplayTimestampRebaseRule =
  | "awaitingTurnExpiresAt"
  | "none"
  | "requestExpiryWindow";

export interface AgentSessionReplayIntentReadinessInput {
  agentSessionId: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface AgentSessionReplayIntentContract {
  /**
   * Ordered correlation fields read from the live intent. The first
   * non-empty string becomes the recorded primary correlationId; every
   * non-empty value becomes a correlation candidate for effect causation.
   */
  readonly correlationKeys: readonly string[];
  /** Effect command types this intent may cause (activity-contract.json). */
  readonly effects: readonly EngineExternalCommand["type"][];
  /**
   * Additional correlation candidates beyond `correlationKeys`, extracted
   * from nested or derived intent data (for example queued prompt identity
   * or a deterministic engine-side cancel commandId).
   */
  readonly extraCorrelationCandidates?: (
    source: Readonly<Record<string, unknown>>
  ) => readonly string[];
  /** Engine-snapshot readiness predicate; omitted means always ready. */
  readonly isReady?: (
    snapshot: AgentSessionEngineState,
    input: AgentSessionReplayIntentReadinessInput
  ) => boolean;
  /**
   * Deterministic engine commandId this intent's payload pre-binds during
   * replay so the driver can correlate an effect whose live command carries
   * neither the recorded correlationId nor a materialized replay commandId.
   */
  readonly replayEffectCommandIdFromPayload?: (
    payload: Readonly<Record<string, unknown>>
  ) => string | null;
  /** Replay must materialize a cassette-scoped commandId before dispatch. */
  readonly replayMaterializesCommandId: boolean;
  /** Timeline completeness: at least one effect must reference this intent. */
  readonly requiresEffect: boolean;
  /** Timestamp/expiry rebase rule applied when replay dispatches the intent. */
  readonly timestampRebase: AgentSessionReplayTimestampRebaseRule;
}

export interface AgentSessionReplayEffectContract {
  /**
   * Declared alternate correlation rule: the recorded effect and the live
   * command correlate when this payload field is a non-empty string on the
   * event and strictly equal on the command. A new-session activation has two
   * stable IDs: the intent and recording correlate it by clientSubmitId while
   * the engine command correlates it by requestId, so `session/activate`
   * declares clientSubmitId here.
   */
  readonly alternateCorrelationPayloadField?: string;
  /** Payload fields that stay stable between recording and replay. */
  readonly stableFields: readonly string[];
}

const requireSessionCancelReadiness = (
  snapshot: AgentSessionEngineState,
  { agentSessionId, payload }: AgentSessionReplayIntentReadinessInput
): boolean => {
  const session = selectEngineSession(snapshot, agentSessionId);
  const turnId = optionalString(payload.turnId)?.trim();
  const activeTurnId = session?.activeTurnId;
  const turn = selectEngineActiveTurn(snapshot, agentSessionId);
  return Boolean(
    session &&
    activeTurnId &&
    (!turnId || turnId === activeTurnId) &&
    turn?.phase !== "settled"
  );
};

const agentSessionReplayIntentContracts = {
  "activation/requested": {
    correlationKeys: ["clientSubmitId", "requestId"],
    effects: ["session/activate"],
    isReady: (snapshot, { agentSessionId, payload }) =>
      payload.mode !== "existing" ||
      Boolean(selectEngineSession(snapshot, agentSessionId)),
    replayMaterializesCommandId: false,
    requiresEffect: true,
    timestampRebase: "requestExpiryWindow"
  },
  "goal/controlRequested": {
    correlationKeys: ["clientSubmitId", "commandId"],
    effects: ["goal/control"],
    isReady: (snapshot, { agentSessionId }) => {
      const session = selectEngineSession(snapshot, agentSessionId);
      const runtimeAvailability = selectEngineSessionRuntimeAvailability(
        snapshot,
        agentSessionId
      );
      const goalControl = selectEngineGoalControl(snapshot, agentSessionId);
      return Boolean(
        session &&
        runtimeAvailability?.state !== "blocked" &&
        goalControl?.status !== "pending" &&
        goalControl?.status !== "pending_create" &&
        goalControl?.status !== "unknown"
      );
    },
    replayMaterializesCommandId: true,
    requiresEffect: true,
    timestampRebase: "none"
  },
  "interaction/responseRequested": {
    correlationKeys: ["commandId", "requestId"],
    effects: ["interaction/respond"],
    isReady: (snapshot, { agentSessionId, payload }) => {
      const turnId = optionalString(payload.turnId)?.trim();
      const requestId = optionalString(payload.requestId)?.trim();
      return Boolean(
        turnId &&
        requestId &&
        selectEngineInteraction(snapshot, agentSessionId, turnId, requestId)
          ?.status === "pending"
      );
    },
    replayMaterializesCommandId: true,
    requiresEffect: true,
    timestampRebase: "none"
  },
  "plan/decisionRequested": {
    correlationKeys: ["idempotencyKey", "commandId", "requestId"],
    effects: ["plan/submitDecision"],
    isReady: (snapshot, { agentSessionId, payload }) => {
      const session = selectEngineSession(snapshot, agentSessionId);
      const turnId = optionalString(payload.turnId)?.trim();
      const turn = selectEngineTurn(snapshot, agentSessionId, turnId);
      return Boolean(
        session && turn?.phase === "settled" && turn.outcome === "completed"
      );
    },
    replayMaterializesCommandId: true,
    requiresEffect: true,
    timestampRebase: "none"
  },
  "plan/feedbackRequested": {
    correlationKeys: ["clientSubmitId", "requestId"],
    effects: ["queue/sendPrompt"],
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "requestExpiryWindow"
  },
  "queue/enqueued": {
    correlationKeys: [],
    effects: [],
    extraCorrelationCandidates: (source) => {
      const prompt = source.prompt;
      if (!prompt || typeof prompt !== "object") return [];
      const record = prompt as { clientSubmitId?: unknown; id?: unknown };
      return nonEmptyStrings([record.clientSubmitId, record.id]);
    },
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "none"
  },
  "queue/removed": {
    correlationKeys: ["promptId"],
    effects: [],
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "none"
  },
  "queue/resumed": {
    correlationKeys: [],
    effects: [],
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "none"
  },
  "queue/sendNowRequested": {
    correlationKeys: ["promptId"],
    // Sending a queued prompt now may first cancel the active turn through
    // the engine cancel command created with this intent's cancelCommandId
    // (sessionLifecycle reducer, "queue/sendNowRequested" case).
    effects: ["queue/sendPrompt", "turn/cancel"],
    extraCorrelationCandidates: (source) =>
      nonEmptyStrings([source.cancelCommandId]),
    replayEffectCommandIdFromPayload: (payload) =>
      optionalNonEmptyString(payload.cancelCommandId),
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "none"
  },
  "queue/suspended": {
    correlationKeys: [],
    effects: [],
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "none"
  },
  "session/cancelRequested": {
    correlationKeys: ["commandId"],
    effects: ["turn/cancel"],
    isReady: requireSessionCancelReadiness,
    replayMaterializesCommandId: true,
    requiresEffect: false,
    timestampRebase: "awaitingTurnExpiresAt"
  },
  "session/settingsUpdateRequested": {
    correlationKeys: ["commandId"],
    effects: ["session/updateSettings"],
    isReady: (snapshot, { agentSessionId }) =>
      Boolean(selectEngineSession(snapshot, agentSessionId)),
    replayMaterializesCommandId: true,
    requiresEffect: true,
    timestampRebase: "none"
  },
  "session/stopRequested": {
    correlationKeys: ["commandId"],
    effects: ["turn/cancel"],
    isReady: requireSessionCancelReadiness,
    replayMaterializesCommandId: true,
    requiresEffect: false,
    timestampRebase: "awaitingTurnExpiresAt"
  },
  "submit/canceled": {
    correlationKeys: ["clientSubmitId"],
    effects: [],
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "none"
  },
  "submit/requested": {
    correlationKeys: ["clientSubmitId"],
    // A send_now submit over an active turn first cancels that turn through
    // the deterministic engine commandId `submit:cancel:<clientSubmitId>`
    // (sessionLifecycle reducer, "submit/requested" case).
    effects: ["queue/sendPrompt", "session/activate", "turn/cancel"],
    extraCorrelationCandidates: (source) => {
      const cancelCommandId = submitSendNowCancelCommandId(source);
      return cancelCommandId ? [cancelCommandId] : [];
    },
    replayEffectCommandIdFromPayload: (payload) =>
      submitSendNowCancelCommandId(payload),
    // Busy-queue submits were recorded while submit was unavailable. Wait until
    // the engine again admits a visible queue row before replaying them; otherwise
    // admission recomputes available→immediate send and the composer blue bar
    // never appears (and later provider outbound order mismatches).
    isReady: (snapshot, { agentSessionId, payload }) => {
      const diagnostics = payload.submitDiagnostics;
      const queued =
        diagnostics !== null &&
        typeof diagnostics === "object" &&
        "queued" in diagnostics &&
        (diagnostics as { queued?: unknown }).queued === true;
      if (!queued) return true;
      return selectEngineSubmitWouldBeVisibleInQueue(snapshot, agentSessionId);
    },
    replayMaterializesCommandId: false,
    requiresEffect: false,
    timestampRebase: "requestExpiryWindow"
  }
} as const satisfies Partial<
  Record<EngineIntent["type"], AgentSessionReplayIntentContract>
>;

export type ReplayableAgentSessionIntentType =
  keyof typeof agentSessionReplayIntentContracts;

const agentSessionReplayEffectContracts = {
  "goal/control": {
    stableFields: ["action", "clientSubmitId", "objective"]
  },
  "interaction/respond": {
    stableFields: ["action", "optionId", "payload", "requestId", "turnId"]
  },
  "plan/submitDecision": {
    stableFields: [
      "action",
      "idempotencyKey",
      "payload",
      "promptKind",
      "requestId",
      "turnId"
    ]
  },
  "queue/sendPrompt": {
    stableFields: [
      "capabilityRefs",
      "clientSubmitId",
      "content",
      "displayPrompt",
      "guidance",
      "promptId",
      "routing",
      "runtimeContent",
      "settings"
    ]
  },
  "session/activate": {
    alternateCorrelationPayloadField: "clientSubmitId",
    stableFields: [
      "agentTargetId",
      "capabilityRefs",
      "clientSubmitId",
      "cwd",
      "initialContent",
      "initialDisplayPrompt",
      "initialGoalControl",
      "initialTuttiModeActivation",
      "mode",
      "railPlacement",
      "settings",
      "submitDiagnostics",
      "title",
      "visible"
    ]
  },
  "session/updateSettings": {
    stableFields: ["settings"]
  },
  "turn/cancel": {
    stableFields: ["turnId"]
  }
} as const satisfies Partial<
  Record<EngineExternalCommand["type"], AgentSessionReplayEffectContract>
>;

export type ReplayableAgentSessionEffectCommandType =
  keyof typeof agentSessionReplayEffectContracts;

/**
 * Replayable-typed commands the engine creates from reducer-internal
 * continuations rather than from a host-dispatched intent. They have no
 * recordable cause by design: replaying the causing intent re-creates them
 * deterministically, so the recorder deliberately skips them instead of
 * registering a recording defect.
 */
const engineInternalEffectCommandRules: readonly {
  commandIdPrefix: string;
  commandType: EngineExternalCommand["type"];
}[] = [
  // Composer settings attached to a still-pending activation
  // (pendingIntents.activationSettings follow-up intent).
  {
    commandIdPrefix: "activation-settings:",
    commandType: "session/updateSettings"
  },
  // Settings precondition dispatched before a queued prompt is sent
  // (promptExecution reducer follow-up intent).
  { commandIdPrefix: "prompt:settings:", commandType: "session/updateSettings" }
];

export function isReplayableAgentSessionActivityIntentType(
  type: EngineIntent["type"]
): type is ReplayableAgentSessionIntentType {
  return Object.hasOwn(agentSessionReplayIntentContracts, type);
}

const replayableEffectCommandTypes: ReadonlySet<string> = new Set(
  Object.values(agentSessionReplayIntentContracts).flatMap(
    (contract) => contract.effects
  )
);

export function isReplayableAgentSessionActivityEffectCommand(
  type: EngineExternalCommand["type"]
): boolean {
  return replayableEffectCommandTypes.has(type);
}

export function isEngineInternalAgentSessionReplayEffectCommand(
  type: EngineExternalCommand["type"],
  commandId: string
): boolean {
  return engineInternalEffectCommandRules.some(
    (rule) =>
      rule.commandType === type && commandId.startsWith(rule.commandIdPrefix)
  );
}

export function agentSessionReplayIntentContractOf(
  type: string
): AgentSessionReplayIntentContract | null {
  return Object.hasOwn(agentSessionReplayIntentContracts, type)
    ? agentSessionReplayIntentContracts[
        type as ReplayableAgentSessionIntentType
      ]
    : null;
}

export function agentSessionReplayIntentAllowsEffect(
  intentType: string,
  effectType: EngineExternalCommand["type"]
): boolean {
  const contract = agentSessionReplayIntentContractOf(intentType);
  return Boolean(contract?.effects.includes(effectType));
}

export function agentSessionReplayIntentCorrelationId(
  intent: EngineIntent
): string | undefined {
  const contract = agentSessionReplayIntentContractOf(intent.type);
  if (!contract) return undefined;
  const source = intent as unknown as Readonly<Record<string, unknown>>;
  for (const key of contract.correlationKeys) {
    const candidate = optionalNonEmptyString(source[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

export function agentSessionReplayIntentCorrelationCandidates(
  intent: EngineIntent
): readonly string[] {
  const contract = agentSessionReplayIntentContractOf(intent.type);
  if (!contract) return [];
  const source = intent as unknown as Readonly<Record<string, unknown>>;
  const candidates = new Set<string>();
  for (const key of contract.correlationKeys) {
    const candidate = optionalNonEmptyString(source[key]);
    if (candidate) candidates.add(candidate);
  }
  for (const candidate of contract.extraCorrelationCandidates?.(source) ?? []) {
    candidates.add(candidate);
  }
  return [...candidates];
}

export function agentSessionReplayIntentRequiresCommandId(
  type: string
): boolean {
  return (
    agentSessionReplayIntentContractOf(type)?.replayMaterializesCommandId ===
    true
  );
}

export function agentSessionReplayEffectCommandIdBinding(
  type: string,
  payload: Readonly<Record<string, unknown>>
): string | null {
  return (
    agentSessionReplayIntentContractOf(
      type
    )?.replayEffectCommandIdFromPayload?.(payload) ?? null
  );
}

export function rebaseAgentSessionReplayIntentPayload(
  type: string,
  recordedPayload: Readonly<Record<string, unknown>>,
  occurredAtUnixMs: number,
  nowUnixMs: number
): Readonly<Record<string, unknown>> {
  const payload = structuredClone(recordedPayload) as Record<string, unknown>;
  const rule =
    agentSessionReplayIntentContractOf(type)?.timestampRebase ?? "none";
  if (rule === "awaitingTurnExpiresAt") {
    const dueAtUnixMs = payload.awaitingTurnExpiresAtUnixMs;
    return typeof dueAtUnixMs === "number" && Number.isFinite(dueAtUnixMs)
      ? {
          ...payload,
          awaitingTurnExpiresAtUnixMs:
            nowUnixMs + Math.max(1, dueAtUnixMs - occurredAtUnixMs)
        }
      : payload;
  }
  if (rule !== "requestExpiryWindow") return payload;
  const requestedAtUnixMs = payload.requestedAtUnixMs;
  const expiresAtUnixMs = payload.expiresAtUnixMs;
  if (
    typeof requestedAtUnixMs !== "number" ||
    !Number.isFinite(requestedAtUnixMs) ||
    typeof expiresAtUnixMs !== "number" ||
    !Number.isFinite(expiresAtUnixMs)
  ) {
    return payload;
  }
  return {
    ...payload,
    expiresAtUnixMs:
      nowUnixMs + Math.max(0, expiresAtUnixMs - requestedAtUnixMs),
    requestedAtUnixMs: nowUnixMs
  };
}

export function stableAgentSessionReplayEffectFields(
  type: string
): readonly string[] | undefined {
  return Object.hasOwn(agentSessionReplayEffectContracts, type)
    ? agentSessionReplayEffectContracts[
        type as ReplayableAgentSessionEffectCommandType
      ].stableFields
    : undefined;
}

export function alternateAgentSessionReplayEffectCorrelationField(
  type: string
): string | null {
  if (!Object.hasOwn(agentSessionReplayEffectContracts, type)) return null;
  const contract: AgentSessionReplayEffectContract =
    agentSessionReplayEffectContracts[
      type as ReplayableAgentSessionEffectCommandType
    ];
  return contract.alternateCorrelationPayloadField ?? null;
}

export function isAgentSessionReplayIntentReady(
  snapshot: AgentSessionEngineState,
  event: {
    agentSessionId?: string;
    payload: Readonly<Record<string, unknown>>;
    type: string;
  }
): boolean {
  const agentSessionId = event.agentSessionId?.trim();
  if (!agentSessionId) return true;
  const contract = agentSessionReplayIntentContractOf(event.type);
  if (!contract?.isReady) return true;
  return contract.isReady(snapshot, { agentSessionId, payload: event.payload });
}

/** Raw registry view for the activity-contract.json synchronization test. */
export function agentSessionReplayIntentContractEntries(): readonly [
  ReplayableAgentSessionIntentType,
  AgentSessionReplayIntentContract
][] {
  return Object.entries(agentSessionReplayIntentContracts) as [
    ReplayableAgentSessionIntentType,
    AgentSessionReplayIntentContract
  ][];
}

function submitSendNowCancelCommandId(
  source: Readonly<Record<string, unknown>>
): string | null {
  if (source.routing !== "send_now") return null;
  const clientSubmitId = optionalNonEmptyString(source.clientSubmitId);
  return clientSubmitId ? `submit:cancel:${clientSubmitId}` : null;
}

function nonEmptyStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const candidate = optionalNonEmptyString(value);
    if (candidate) result.push(candidate);
  }
  return result;
}

function optionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
