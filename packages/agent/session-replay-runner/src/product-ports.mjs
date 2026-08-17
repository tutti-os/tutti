/**
 * Product dialect ports for shared playback / turn-identity / stimuli.
 *
 * Do not fork Tutti vs Room controllers — inject path + transport command
 * dialects here. Scope segments and command spellings are opaque strings;
 * never hardcode a product name inside the shared controllers.
 */

/** @typedef {"realtime" | "fast-forward"} ReplayTimingMode */

/**
 * @typedef {object} ReplayTransportCommands
 * @property {string} setTimingMode
 * @property {string} setProviderCursor
 * @property {string} clearProviderCursor
 */

/**
 * @typedef {object} ReplayTimingSeekPolicy
 * @property {boolean} [preferFastForward] Keep FF after land (batch mode).
 * @property {boolean} [forceRealtimeSeek] Never FF while seeking.
 */

/**
 * @typedef {"canonical" | "lean-activity"} ReplaySessionObservation
 * - canonical: Session GET body (Tutti workspaces agent-sessions).
 * - lean-activity: Room `/state` + optional local-agent-activity / renderer
 *   snapshot enrichment for turn identity.
 */

/**
 * @typedef {object} ReplayProductPorts
 * @property {string} workspaceScopeSegment HTTP scope (`workspaces` / `rooms`).
 * @property {ReplayTransportCommands} transportCommands
 * @property {(mode: ReplayTimingMode) => string} encodeTimingModeValue
 * @property {(state: object) => { timingMode: ReplayTimingMode } & object} normalizePlaybackState
 * @property {ReplayTimingSeekPolicy} [timingSeekPolicy]
 * @property {boolean} [fastForwardOnAutomaticSeek] FF when auto-advancing (default true).
 * @property {boolean} [applyControlBeforeReconcileTarget]
 * @property {boolean} [applyControlWhileWaitingBeforeActivity]
 * @property {boolean} [watchSessionsDuringPlayback]
 * @property {boolean} [agentSessionStateSuffix] Append `/state` to session GETs.
 * @property {ReplaySessionObservation} [sessionObservation]
 * @property {boolean} [failIdleWaitOnTerminalSession]
 * @property {boolean} [captureActivityBaselinesInStimuli]
 * @property {boolean} [rebasePendingInteractionForResponseRequested]
 * @property {(stateDirectory: string) => string | Promise<string>} [listenerInfoPath]
 * @property {(message: string) => void} [log]
 */

/** Kebab-case transport commands (Tutti daemon dialect). */
export const KEBAB_REPLAY_TRANSPORT_COMMANDS = Object.freeze({
  setTimingMode: "set-timing-mode",
  setProviderCursor: "set-provider-cursor",
  clearProviderCursor: "clear-provider-cursor"
});

/** camelCase transport commands (Room / TSH daemon dialect). */
export const CAMEL_REPLAY_TRANSPORT_COMMANDS = Object.freeze({
  setTimingMode: "setTimingMode",
  setProviderCursor: "setProviderCursor",
  clearProviderCursor: "clearProviderCursor"
});

/**
 * Encode timing mode for kebab command payloads (`fast-forward` / `realtime`).
 * @param {ReplayTimingMode} mode
 */
export function encodeKebabTimingModeValue(mode) {
  return mode;
}

/**
 * Encode timing mode for camelCase command payloads (`fastForward` / `realtime`).
 * @param {ReplayTimingMode} mode
 */
export function encodeCamelTimingModeValue(mode) {
  return mode === "fast-forward" ? "fastForward" : mode;
}

/**
 * Normalize playback GET when `timingMode` is always present.
 * @param {object} state
 */
export function normalizePlaybackStateRequireTimingMode(state) {
  if (
    typeof state?.paused !== "boolean" ||
    !Number.isFinite(state.playbackElapsedMs) ||
    state.playbackElapsedMs < 0 ||
    !Number.isFinite(state.speed) ||
    state.speed <= 0 ||
    !Array.isArray(state.providerConnections) ||
    !["realtime", "fast-forward"].includes(state.timingMode)
  ) {
    throw new Error("replay playback state is invalid");
  }
  return state;
}

/**
 * Normalize playback GET that may derive `timingMode` from `fastForward`.
 * @param {object} state
 */
export function normalizePlaybackStateDeriveTimingMode(state) {
  const timingMode =
    state?.timingMode ?? (state?.fastForward ? "fast-forward" : "realtime");
  if (
    typeof state?.paused !== "boolean" ||
    !Number.isFinite(state.playbackElapsedMs) ||
    state.playbackElapsedMs < 0 ||
    !Number.isFinite(state.speed) ||
    state.speed <= 0 ||
    typeof state?.fastForward !== "boolean" ||
    !Array.isArray(state.providerConnections) ||
    !["realtime", "fast-forward"].includes(timingMode)
  ) {
    throw new Error("replay playback state is invalid");
  }
  return { ...state, timingMode };
}

/**
 * Build `/v1/{scope}/.../agent-sessions/{id}` (+ optional `/state`).
 *
 * @param {{
 *   workspaceScopeSegment: string,
 *   workspaceId: string,
 *   agentSessionId: string,
 *   stateSuffix?: boolean,
 *   query?: string
 * }} input
 */
export function replayAgentSessionPath(input) {
  const scope = String(input.workspaceScopeSegment ?? "").trim();
  if (!scope) {
    throw new Error("replayAgentSessionPath requires workspaceScopeSegment");
  }
  const workspace = encodeURIComponent(input.workspaceId);
  const session = encodeURIComponent(input.agentSessionId);
  const suffix = input.stateSuffix ? "/state" : "";
  const query = input.query ? `?${input.query}` : "";
  return `/v1/${scope}/${workspace}/agent-sessions/${session}${suffix}${query}`;
}

/**
 * @param {{ workspaceScopeSegment: string, agentSessionStateSuffix?: boolean }} ports
 * @param {string} workspaceId
 * @param {string} agentSessionId
 */
export function replayAgentSessionUrl(ports, workspaceId, agentSessionId) {
  return replayAgentSessionPath({
    workspaceScopeSegment: ports.workspaceScopeSegment,
    workspaceId,
    agentSessionId,
    stateSuffix: ports.agentSessionStateSuffix === true
  });
}

/**
 * Normalize a Session GET body for idle / terminal checks.
 * @param {{ agentSessionStateSuffix?: boolean }} ports
 * @param {object} raw
 */
export function normalizeIdleSession(ports, raw) {
  if (!ports.agentSessionStateSuffix) {
    return raw?.session ?? raw;
  }
  return {
    ...raw,
    activeTurnId: raw?.turnLifecycle?.activeTurnId ?? raw?.activeTurnId ?? null
  };
}

/**
 * Validate + freeze product ports for shared controllers.
 *
 * @param {ReplayProductPorts} input
 * @returns {Readonly<Required<Pick<ReplayProductPorts,
 *   "workspaceScopeSegment" | "transportCommands" | "encodeTimingModeValue" |
 *   "normalizePlaybackState" | "timingSeekPolicy" | "fastForwardOnAutomaticSeek" |
 *   "applyControlBeforeReconcileTarget" | "applyControlWhileWaitingBeforeActivity" |
 *   "watchSessionsDuringPlayback" | "agentSessionStateSuffix" | "sessionObservation" |
 *   "failIdleWaitOnTerminalSession" | "captureActivityBaselinesInStimuli" |
 *   "rebasePendingInteractionForResponseRequested">> & ReplayProductPorts>}
 */
export function createReplayProductPorts(input) {
  if (!input || typeof input !== "object") {
    throw new Error("createReplayProductPorts requires an options object");
  }
  const workspaceScopeSegment = String(
    input.workspaceScopeSegment ?? ""
  ).trim();
  if (!workspaceScopeSegment) {
    throw new Error("ReplayProductPorts.workspaceScopeSegment is required");
  }
  const transportCommands = input.transportCommands;
  if (
    !transportCommands ||
    typeof transportCommands.setTimingMode !== "string" ||
    typeof transportCommands.setProviderCursor !== "string" ||
    typeof transportCommands.clearProviderCursor !== "string" ||
    !transportCommands.setTimingMode.trim() ||
    !transportCommands.setProviderCursor.trim() ||
    !transportCommands.clearProviderCursor.trim()
  ) {
    throw new Error("ReplayProductPorts.transportCommands are required");
  }
  if (typeof input.encodeTimingModeValue !== "function") {
    throw new Error("ReplayProductPorts.encodeTimingModeValue is required");
  }
  if (typeof input.normalizePlaybackState !== "function") {
    throw new Error("ReplayProductPorts.normalizePlaybackState is required");
  }
  const sessionObservation = input.sessionObservation ?? "canonical";
  if (
    sessionObservation !== "canonical" &&
    sessionObservation !== "lean-activity"
  ) {
    throw new Error(
      `ReplayProductPorts.sessionObservation is invalid: ${sessionObservation}`
    );
  }
  return Object.freeze({
    workspaceScopeSegment,
    transportCommands: Object.freeze({ ...transportCommands }),
    encodeTimingModeValue: input.encodeTimingModeValue,
    normalizePlaybackState: input.normalizePlaybackState,
    timingSeekPolicy: Object.freeze({ ...(input.timingSeekPolicy ?? {}) }),
    fastForwardOnAutomaticSeek: input.fastForwardOnAutomaticSeek !== false,
    applyControlBeforeReconcileTarget:
      input.applyControlBeforeReconcileTarget === true,
    applyControlWhileWaitingBeforeActivity:
      input.applyControlWhileWaitingBeforeActivity === true,
    watchSessionsDuringPlayback: input.watchSessionsDuringPlayback === true,
    agentSessionStateSuffix: input.agentSessionStateSuffix === true,
    sessionObservation,
    failIdleWaitOnTerminalSession: input.failIdleWaitOnTerminalSession === true,
    captureActivityBaselinesInStimuli:
      input.captureActivityBaselinesInStimuli === true,
    rebasePendingInteractionForResponseRequested:
      input.rebasePendingInteractionForResponseRequested === true,
    listenerInfoPath: input.listenerInfoPath,
    log: input.log
  });
}
