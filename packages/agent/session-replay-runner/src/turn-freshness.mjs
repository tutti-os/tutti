/**
 * Prefer a primary timestamp field, then a fallback (both unix ms).
 */
export function replayActivityTimestamp(value, primaryKey, fallbackKey) {
  const primary = Number(value?.[primaryKey]);
  if (Number.isFinite(primary) && primary > 0) return primary;
  const fallback = Number(value?.[fallbackKey]);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

/**
 * Whether a live turn is fresher than the recorded baseline (new id + later
 * timestamp). Used by TSH lean-state identity tracking; safe on Tutti too.
 *
 * @param {object | null | undefined} turn
 * @param {{ turnIds: Set<string>, capturedAtUnixMs: number }} baseline
 * @param {string} [recordedTurnId]
 */
export function replayActivityTurnIsFresh(turn, baseline, recordedTurnId = "") {
  const turnId = String(turn?.turnId ?? "").trim();
  const timestamp = replayActivityTimestamp(
    turn,
    "startedAtUnixMs",
    "updatedAtUnixMs"
  );
  return (
    Boolean(turnId) &&
    turnId !== String(recordedTurnId ?? "").trim() &&
    !baseline.turnIds.has(turnId) &&
    timestamp !== null &&
    timestamp > baseline.capturedAtUnixMs
  );
}

/**
 * Whether a pending interaction is fresher than the recorded baseline and
 * still bound to a fresh turn.
 *
 * @param {object | null | undefined} interaction
 * @param {Array<object> | null | undefined} turns
 * @param {{ interactionKeys: Set<string>, turnIds: Set<string>, capturedAtUnixMs: number }} baseline
 * @param {(turnId: unknown, requestId: unknown) => string} identityKey
 * @param {string} [recordedTurnId]
 */
export function replayActivityInteractionIsFresh(
  interaction,
  turns,
  baseline,
  identityKey,
  recordedTurnId = ""
) {
  const timestamp = replayActivityTimestamp(
    interaction,
    "createdAtUnixMs",
    "updatedAtUnixMs"
  );
  const turn = turns?.find(
    (candidate) => candidate?.turnId === interaction?.turnId
  );
  return (
    String(interaction?.turnId ?? "").trim() !==
      String(recordedTurnId ?? "").trim() &&
    !baseline.interactionKeys.has(
      identityKey(interaction?.turnId, interaction?.requestId)
    ) &&
    timestamp !== null &&
    timestamp > baseline.capturedAtUnixMs &&
    replayActivityTurnIsFresh(turn, baseline, recordedTurnId)
  );
}

/**
 * Resolve a pending interaction after Turn/request identities may have been
 * remapped during replay. Prefer exact (turnId, requestId), then unique turn,
 * then unique request / sole pending.
 */
export function replayPendingInteractionForIdentity(
  session,
  recordedRequestId,
  expectedTurnId
) {
  const interactions = Array.isArray(session?.pendingInteractions)
    ? session.pendingInteractions.filter(
        (interaction) =>
          interaction?.status === "pending" &&
          typeof interaction?.requestId === "string" &&
          interaction.requestId.trim() &&
          typeof interaction?.turnId === "string" &&
          interaction.turnId.trim()
      )
    : [];
  const normalizedExpectedTurnId = String(expectedTurnId ?? "").trim();
  if (normalizedExpectedTurnId) {
    const exactMatch = interactions.filter(
      (interaction) =>
        interaction.turnId === normalizedExpectedTurnId &&
        interaction.requestId === recordedRequestId
    );
    if (exactMatch.length === 1) return exactMatch[0];
    const turnMatch = interactions.filter(
      (interaction) => interaction.turnId === normalizedExpectedTurnId
    );
    return turnMatch.length === 1 ? turnMatch[0] : null;
  }
  const requestMatch = interactions.filter(
    (interaction) => interaction.requestId === recordedRequestId
  );
  if (requestMatch.length === 1) return requestMatch[0];
  return interactions.length === 1 ? interactions[0] : null;
}

/**
 * Collapse a renderer activity snapshot into Tutti-shaped turn fields for one
 * Session. Product runners supply the identity key formatter.
 *
 * @param {object | null | undefined} snapshot
 * @param {string} actualSessionId
 * @param {(turnId: unknown, requestId: unknown) => string} activityIdentityKey
 */
export function activityTurnFromRendererSnapshot(
  snapshot,
  actualSessionId,
  activityIdentityKey
) {
  if (!snapshot || typeof snapshot !== "object") return {};
  if (typeof activityIdentityKey !== "function") {
    throw new Error("activityIdentityKey is required");
  }
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const session = sessions.find(
    (item) => item?.agentSessionId === actualSessionId
  );
  const turnsById = new Map();
  const addTurn = (turn) => {
    const turnId = String(turn?.turnId ?? "").trim();
    if (
      !turnId ||
      (turn?.agentSessionId && turn.agentSessionId !== actualSessionId)
    ) {
      return;
    }
    turnsById.set(turnId, turn);
  };
  for (const turn of Array.isArray(snapshot.turns) ? snapshot.turns : []) {
    addTurn(turn);
  }
  addTurn(session?.activeTurn);
  addTurn(session?.latestTurn);
  const turns = [...turnsById.values()];
  turns.sort(
    (left, right) =>
      Number(right?.updatedAtUnixMs ?? right?.startedAtUnixMs ?? 0) -
      Number(left?.updatedAtUnixMs ?? left?.startedAtUnixMs ?? 0)
  );
  const latestTurn = turns[0]
    ? {
        turnId: turns[0].turnId,
        id: turns[0].turnId,
        phase: turns[0].phase,
        outcome: turns[0].outcome,
        startedAtUnixMs: turns[0].startedAtUnixMs,
        updatedAtUnixMs: turns[0].updatedAtUnixMs
      }
    : null;
  const pendingInteractionsByKey = new Map();
  const addPendingInteraction = (interaction) => {
    if (
      interaction?.agentSessionId &&
      interaction.agentSessionId !== actualSessionId
    ) {
      return;
    }
    if (interaction?.status !== "pending") return;
    const key = activityIdentityKey(
      interaction?.turnId,
      interaction?.requestId
    );
    if (!key || key === "\u0000") return;
    pendingInteractionsByKey.set(key, interaction);
  };
  for (const interaction of Array.isArray(snapshot.interactions)
    ? snapshot.interactions
    : []) {
    addPendingInteraction(interaction);
  }
  for (const interaction of session?.pendingInteractions ?? []) {
    addPendingInteraction(interaction);
  }
  for (const interaction of session?.latestTurnInteractions ?? []) {
    addPendingInteraction(interaction);
  }
  const pendingInteractions = [...pendingInteractionsByKey.values()];
  return {
    available: true,
    activeTurnId: session?.activeTurnId ?? session?.activeTurn?.turnId ?? null,
    latestTurn,
    pendingInteractions,
    turns,
    turnIds: turns
      .map((turn) => String(turn?.turnId ?? "").trim())
      .filter(Boolean)
  };
}
