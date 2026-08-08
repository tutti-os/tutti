import { setTimeout as defaultDelay } from "node:timers/promises";
import {
  replayObservedTurnId,
  replayScopedEntityKey
} from "./playback-helpers.mjs";
import {
  createReplayProductPorts,
  normalizeIdleSession,
  replayAgentSessionUrl
} from "./product-ports.mjs";
import {
  activityTurnFromRendererSnapshot,
  replayActivityInteractionIsFresh,
  replayActivityTurnIsFresh,
  replayPendingInteractionForIdentity
} from "./turn-freshness.mjs";

/**
 * Shared turn-identity tracker. Lean Room observation is gated by
 * `ports.sessionObservation === "lean-activity"`.
 *
 * @param {object} plan
 * @param {object} runtime
 * @param {import("./product-ports.mjs").ReplayProductPorts} runtime.ports
 */
export function createReplayTurnIdentityTracker(plan, runtime) {
  const ports = createReplayProductPorts(runtime.ports);
  const wait = runtime.wait ?? defaultDelay;
  const lean = ports.sessionObservation === "lean-activity";
  const sessions = new Map(
    Object.entries(plan).map(([sessionId, session]) => [
      sessionId,
      {
        actualSessionId:
          session.kind === "child" && session.initialSession !== true
            ? null
            : sessionId,
        actualTurnIds: new Set(),
        initialTurnIds: new Set(session.initialTurnIds ?? []),
        kind: session.kind ?? "root",
        parentSessionId: session.parentSessionId ?? null,
        parentToolCallId: session.parentToolCallId ?? null,
        parentTurnId: session.parentTurnId ?? null,
        rootSessionId: session.rootSessionId ?? null,
        rootTurnId: session.rootTurnId ?? null,
        mappedTurnIds: new Map(),
        recordedTurnIds: session.recordedTurnIds ?? []
      }
    ])
  );
  const interactionIdentities = new Map();
  const activityBaselines = new Map();
  const activityNow =
    typeof runtime.now === "function" ? runtime.now : Date.now;

  const activityIdentityKey = (turnId, requestId) =>
    `${String(turnId ?? "").trim()}\u0000${String(requestId ?? "").trim()}`;

  const activityBaselineKey = (recordedSessionId, recordedTurnId) =>
    `${recordedSessionId}\u0000${recordedTurnId}`;

  const interactionIdentityKey = (event) => {
    const turnId = String(event.payload?.turnId ?? "").trim();
    const requestId = String(event.payload?.requestId ?? "").trim();
    return `${event.agentSessionId}\u0000${turnId}\u0000${requestId}`;
  };

  const rebaseMappedInteraction = (event, identity) => {
    const payload = {
      ...event.payload,
      requestId: identity.requestId,
      turnId: identity.turnId
    };
    return {
      ...event,
      agentSessionId: identity.agentSessionId,
      ...(event.type === "interaction/respond"
        ? {
            correlationId: replayScopedEntityKey(
              identity.agentSessionId,
              replayScopedEntityKey(payload.turnId, payload.requestId)
            )
          }
        : {}),
      payload
    };
  };

  const observeSessionTurn = (
    recordedSessionId,
    session,
    actualTurnId = replayObservedTurnId(session)
  ) => {
    const identity = sessions.get(recordedSessionId);
    if (!identity) return;
    if (!actualTurnId || identity.actualTurnIds.has(actualTurnId)) return;
    const recordedTurnId =
      identity.recordedTurnIds[identity.mappedTurnIds.size];
    if (!recordedTurnId) {
      throw new Error(
        `replay Session ${recordedSessionId} produced an unexpected Turn ${actualTurnId}`
      );
    }
    identity.actualTurnIds.add(actualTurnId);
    identity.mappedTurnIds.set(recordedTurnId, actualTurnId);
  };

  const mappedTurnId = (recordedSessionId, recordedTurnId) => {
    const identity = sessions.get(recordedSessionId);
    if (!identity || identity.initialTurnIds.has(recordedTurnId)) {
      return recordedTurnId;
    }
    const actualTurnId = identity.mappedTurnIds.get(recordedTurnId) ?? null;
    if (lean && actualTurnId === recordedTurnId) return null;
    return actualTurnId;
  };

  const activityTurnFromSnapshot = (snapshot, actualSessionId) =>
    activityTurnFromRendererSnapshot(
      snapshot,
      actualSessionId,
      activityIdentityKey
    );

  const readLocalAgentActivityTurn = async (workspaceId, actualSessionId) => {
    if (!lean) return {};
    try {
      const response = await fetch(
        `${runtime.baseURL}/v1/${ports.workspaceScopeSegment}/${encodeURIComponent(workspaceId)}/local-agent-activity`,
        { headers: runtime.headers }
      );
      if (!response.ok) return {};
      return activityTurnFromSnapshot(await response.json(), actualSessionId);
    } catch {
      return {};
    }
  };

  const readSession = async (workspaceId, actualSessionId) => {
    const response = await fetch(
      `${runtime.baseURL}${replayAgentSessionUrl(ports, workspaceId, actualSessionId)}`,
      { headers: runtime.headers }
    );
    if (!response.ok) {
      throw new Error(
        `failed to resolve replay Session identity: ${response.status} ${await response.text()}`
      );
    }
    const raw = await response.json();
    if (!lean) {
      return normalizeIdleSession(ports, raw);
    }
    const state = raw;
    const activity = await readLocalAgentActivityTurn(
      workspaceId,
      actualSessionId
    );
    let rendererActivity = {};
    if (typeof runtime.readRendererActivitySnapshot === "function") {
      try {
        rendererActivity = activityTurnFromSnapshot(
          await runtime.readRendererActivitySnapshot(),
          actualSessionId
        );
      } catch {
        rendererActivity = {};
      }
    }
    const preferredActivity =
      rendererActivity.available &&
      (rendererActivity.activeTurnId ||
        rendererActivity.latestTurn ||
        rendererActivity.turns?.length ||
        rendererActivity.pendingInteractions?.length)
        ? rendererActivity
        : activity;
    return {
      ...state,
      activeTurnId:
        state.turnLifecycle?.activeTurnId ??
        state.activeTurnId ??
        preferredActivity.activeTurnId ??
        null,
      rendererActiveTurnId: preferredActivity.activeTurnId ?? null,
      rendererObservedTurnId:
        preferredActivity.activeTurnId ??
        preferredActivity.latestTurn?.turnId ??
        null,
      rendererTurns: Array.isArray(preferredActivity.turns)
        ? preferredActivity.turns
        : [],
      latestTurn:
        state.latestTurn ??
        preferredActivity.latestTurn ??
        (state.turnLifecycle?.activeTurnId
          ? { turnId: state.turnLifecycle.activeTurnId }
          : null),
      pendingInteractions: Array.isArray(preferredActivity.pendingInteractions)
        ? preferredActivity.pendingInteractions
        : []
    };
  };

  const captureActivityBaseline = async (workspaceId, recordedSessionId) => {
    if (!lean) return;
    const identity = sessions.get(recordedSessionId);
    if (!identity || identity.kind === "child" || !identity.actualSessionId) {
      return;
    }
    const recordedTurnId =
      identity.recordedTurnIds[identity.mappedTurnIds.size];
    if (!recordedTurnId) return;
    const key = activityBaselineKey(recordedSessionId, recordedTurnId);
    if (activityBaselines.has(key)) return;
    const deadline = Date.now() + runtime.timeoutMs;
    while (Date.now() < deadline) {
      const activity = await readLocalAgentActivityTurn(
        workspaceId,
        identity.actualSessionId
      );
      if (activity.available) {
        activityBaselines.set(key, {
          capturedAtUnixMs: activityNow(),
          interactionKeys: new Set(
            activity.pendingInteractions.map((interaction) =>
              activityIdentityKey(interaction?.turnId, interaction?.requestId)
            )
          ),
          turnIds: new Set(activity.turnIds)
        });
        return;
      }
      await wait(50);
    }
    throw new Error(
      `timed out capturing replay activity baseline ${recordedSessionId}/${recordedTurnId}`
    );
  };

  const observeCurrentTurn = async (workspaceId, recordedSessionId) => {
    const actualSessionId = await resolveSession(
      workspaceId,
      recordedSessionId
    );
    if (!lean) {
      const session = await readSession(workspaceId, actualSessionId);
      observeSessionTurn(recordedSessionId, session);
      return;
    }
    const identity = sessions.get(recordedSessionId);
    const mappedBefore = identity?.mappedTurnIds.size ?? 0;
    const recordedTurnId = identity?.recordedTurnIds[mappedBefore];
    const baseline = recordedTurnId
      ? activityBaselines.get(
          activityBaselineKey(recordedSessionId, recordedTurnId)
        )
      : null;
    const deadline = Date.now() + Math.min(2_000, runtime.timeoutMs);
    while (true) {
      const session = await readSession(workspaceId, actualSessionId);
      const visible = session.rendererObservedTurnId;
      const visibleTurn = session.rendererTurns?.find(
        (turn) => turn?.turnId === visible
      );
      if (
        visible &&
        (!baseline ||
          replayActivityTurnIsFresh(visibleTurn, baseline, recordedTurnId))
      ) {
        observeSessionTurn(recordedSessionId, session, visible);
      }
      const mappedAfter = identity?.mappedTurnIds.size ?? 0;
      if (mappedAfter > mappedBefore) return;
      if (
        visible &&
        identity?.actualTurnIds.has(visible) &&
        !baseline?.turnIds.has(visible)
      ) {
        return;
      }
      if (identity && !identity.recordedTurnIds[mappedAfter]) return;
      if (Date.now() >= deadline) return;
      await wait(50);
    }
  };

  const resolveLineageTurn = async (
    workspaceId,
    recordedSessionId,
    recordedTurnId
  ) => {
    if (!recordedTurnId) return null;
    let actualTurnId = mappedTurnId(recordedSessionId, recordedTurnId);
    if (actualTurnId) return actualTurnId;
    await observeCurrentTurn(workspaceId, recordedSessionId);
    actualTurnId = mappedTurnId(recordedSessionId, recordedTurnId);
    if (!actualTurnId) {
      throw new Error(
        `replay lineage Turn identity is unresolved: ${recordedSessionId}/${recordedTurnId}`
      );
    }
    return actualTurnId;
  };

  const readSessionGraph = async (workspaceId, rootSessionId) => {
    const response = await fetch(
      `${runtime.baseURL}/v1/${ports.workspaceScopeSegment}/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(rootSessionId)}?projection=messageHydration`,
      { headers: runtime.headers }
    );
    if (!response.ok) {
      throw new Error(
        `failed to read replay Session graph: ${response.status} ${await response.text()}`
      );
    }
    const body = await response.json();
    return [
      ...(body.session ? [body.session] : []),
      ...(Array.isArray(body.childSessions) ? body.childSessions : [])
    ];
  };

  const resolveSession = async (workspaceId, recordedSessionId) => {
    const identity = sessions.get(recordedSessionId);
    if (!identity) return recordedSessionId;
    if (identity.actualSessionId) return identity.actualSessionId;
    if (
      identity.kind !== "child" ||
      !identity.rootSessionId ||
      !identity.parentSessionId ||
      !identity.parentToolCallId
    ) {
      throw new Error(
        `replay child Session lineage is incomplete: ${recordedSessionId}`
      );
    }
    const actualRootSessionId = await resolveSession(
      workspaceId,
      identity.rootSessionId
    );
    const actualParentSessionId = await resolveSession(
      workspaceId,
      identity.parentSessionId
    );
    const actualRootTurnId = await resolveLineageTurn(
      workspaceId,
      identity.rootSessionId,
      identity.rootTurnId
    );
    const actualParentTurnId = await resolveLineageTurn(
      workspaceId,
      identity.parentSessionId,
      identity.parentTurnId
    );
    const deadline = Date.now() + runtime.timeoutMs;
    while (Date.now() < deadline) {
      const candidates = (
        await readSessionGraph(workspaceId, actualRootSessionId)
      ).filter(
        (session) =>
          session.kind === "child" &&
          session.rootAgentSessionId === actualRootSessionId &&
          session.parentAgentSessionId === actualParentSessionId &&
          session.parentToolCallId === identity.parentToolCallId &&
          (!actualRootTurnId || session.rootTurnId === actualRootTurnId) &&
          (!actualParentTurnId || session.parentTurnId === actualParentTurnId)
      );
      if (candidates.length > 1) {
        throw new Error(
          `replay child Session lineage is ambiguous: ${recordedSessionId}`
        );
      }
      if (candidates.length === 1) {
        identity.actualSessionId = candidates[0].id;
        observeSessionTurn(recordedSessionId, candidates[0]);
        return identity.actualSessionId;
      }
      await wait(50);
    }
    throw new Error(
      `replay child Session identity is unresolved: ${recordedSessionId}`
    );
  };

  return {
    captureActivityBaseline,
    observeCurrentTurn,
    async rebasePendingInteraction(event) {
      if (!lean) {
        throw new Error(
          "rebasePendingInteraction requires sessionObservation=lean-activity"
        );
      }
      const actualSessionId = await resolveSession(
        event.workspaceId,
        event.agentSessionId
      );
      const deadline = Date.now() + runtime.timeoutMs;
      let latest = null;
      while (Date.now() < deadline) {
        const session = await readSession(event.workspaceId, actualSessionId);
        latest = session;
        const recordedTurnId = String(event.payload?.turnId ?? "").trim();
        const rendererTurnId = String(
          session.rendererActiveTurnId ?? session.rendererObservedTurnId ?? ""
        ).trim();
        const baseline = activityBaselines.get(
          activityBaselineKey(event.agentSessionId, recordedTurnId)
        );
        const expectedTurnId =
          (rendererTurnId !== recordedTurnId ? rendererTurnId : "") ||
          mappedTurnId(event.agentSessionId, recordedTurnId) ||
          (baseline ? "" : recordedTurnId);
        const interaction = replayPendingInteractionForIdentity(
          baseline
            ? {
                ...session,
                pendingInteractions: session.pendingInteractions.filter(
                  (candidate) =>
                    replayActivityInteractionIsFresh(
                      candidate,
                      session.rendererTurns,
                      baseline,
                      activityIdentityKey,
                      recordedTurnId
                    )
                )
              }
            : session,
          event.payload?.requestId,
          expectedTurnId
        );
        if (interaction) {
          const identity = {
            agentSessionId: actualSessionId,
            requestId: interaction.requestId,
            turnId: interaction.turnId
          };
          interactionIdentities.set(interactionIdentityKey(event), identity);
          return rebaseMappedInteraction(event, identity);
        }
        await wait(50);
      }
      throw new Error(
        `timed out resolving replay Interaction identity ${event.agentSessionId}/${event.payload?.requestId}: ${JSON.stringify(latest)}`
      );
    },
    async rebase(event) {
      if (lean) {
        const interactionIdentity = interactionIdentities.get(
          interactionIdentityKey(event)
        );
        if (interactionIdentity) {
          return rebaseMappedInteraction(event, interactionIdentity);
        }
      }
      const recordedSessionId = event.agentSessionId;
      const actualSessionId = await resolveSession(
        event.workspaceId,
        recordedSessionId
      );
      const recordedTurnId = event.payload?.turnId;
      if (typeof recordedTurnId !== "string") {
        return actualSessionId === recordedSessionId
          ? event
          : { ...event, agentSessionId: actualSessionId };
      }
      const identity = sessions.get(recordedSessionId);
      if (!identity) return event;
      if (identity.initialTurnIds.has(recordedTurnId)) {
        return actualSessionId === recordedSessionId
          ? event
          : { ...event, agentSessionId: actualSessionId };
      }
      let actualTurnId = identity.mappedTurnIds.get(recordedTurnId);
      if (lean && actualTurnId === recordedTurnId) actualTurnId = null;
      if (!actualTurnId) {
        await observeCurrentTurn(event.workspaceId, recordedSessionId);
        actualTurnId = identity.mappedTurnIds.get(recordedTurnId);
        if (lean && actualTurnId === recordedTurnId) actualTurnId = null;
      }
      if (!actualTurnId) {
        throw new Error(
          `replay Turn identity is unresolved: ${recordedSessionId}/${recordedTurnId}`
        );
      }
      const payload = {
        ...event.payload,
        turnId: actualTurnId,
        ...([
          "plan.decision",
          "plan/decisionRequested",
          "plan/submitDecision"
        ].includes(event.type) && event.payload.requestId === recordedTurnId
          ? {
              requestId: actualTurnId
            }
          : {})
      };
      return {
        ...event,
        agentSessionId: actualSessionId,
        ...(event.type === "interaction/respond" ||
        event.type === "plan/submitDecision"
          ? {
              correlationId: replayScopedEntityKey(
                actualSessionId,
                replayScopedEntityKey(payload.turnId, payload.requestId)
              )
            }
          : {}),
        payload
      };
    }
  };
}
