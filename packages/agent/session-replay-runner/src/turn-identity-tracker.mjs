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
import {
  createReplayDeadline,
  fetchWithReplayDeadline,
  readReplayResponseJson,
  readReplayResponseText,
  waitWithReplayDeadline
} from "./replay-http.mjs";

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
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const signal = runtime.signal;
  const operationDeadline = (label, timeoutMs = runtime.timeoutMs) =>
    createReplayDeadline(timeoutMs, { signal, label });
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

  const readLocalAgentActivityTurn = async (
    workspaceId,
    actualSessionId,
    deadline = operationDeadline("replay local agent activity")
  ) => {
    if (!lean) return {};
    try {
      const response = await fetchWithReplayDeadline(
        fetchImpl,
        `${runtime.baseURL}/v1/${ports.workspaceScopeSegment}/${encodeURIComponent(workspaceId)}/local-agent-activity`,
        { headers: runtime.headers },
        deadline
      );
      if (!response.ok) return {};
      return activityTurnFromSnapshot(
        await readReplayResponseJson(response, deadline),
        actualSessionId
      );
    } catch {
      if (signal?.aborted) throw signal.reason;
      return {};
    }
  };

  const readSession = async (
    workspaceId,
    actualSessionId,
    deadline = operationDeadline("replay Session observation")
  ) => {
    const response = await fetchWithReplayDeadline(
      fetchImpl,
      `${runtime.baseURL}${replayAgentSessionUrl(ports, workspaceId, actualSessionId)}`,
      { headers: runtime.headers },
      deadline
    );
    if (!response.ok) {
      throw new Error(
        `failed to resolve replay Session identity: ${response.status} ${await readReplayResponseText(response, deadline)}`
      );
    }
    const raw = await readReplayResponseJson(response, deadline);
    if (!lean) {
      return normalizeIdleSession(ports, raw);
    }
    const state = raw;
    const activity = await readLocalAgentActivityTurn(
      workspaceId,
      actualSessionId,
      deadline
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
    const deadline = operationDeadline(
      `replay activity baseline ${recordedSessionId}`
    );
    while (deadline.remainingMs() > 0) {
      const activity = await readLocalAgentActivityTurn(
        workspaceId,
        identity.actualSessionId,
        deadline
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
      await waitWithReplayDeadline(wait, 50, deadline);
    }
    throw new Error(
      `timed out capturing replay activity baseline ${recordedSessionId}/${recordedTurnId}`
    );
  };

  const observeCurrentTurn = async (
    workspaceId,
    recordedSessionId,
    suppliedDeadline = null
  ) => {
    const deadline =
      suppliedDeadline ??
      operationDeadline(
        `replay turn observation ${recordedSessionId}`,
        Math.min(2_000, runtime.timeoutMs)
      );
    const actualSessionId = await resolveSession(
      workspaceId,
      recordedSessionId,
      deadline
    );
    if (!lean) {
      const session = await readSession(workspaceId, actualSessionId, deadline);
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
    while (deadline.remainingMs() > 0) {
      const session = await readSession(workspaceId, actualSessionId, deadline);
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
      await waitWithReplayDeadline(wait, 50, deadline);
    }
  };

  const resolveLineageTurn = async (
    workspaceId,
    recordedSessionId,
    recordedTurnId,
    suppliedDeadline = null
  ) => {
    if (!recordedTurnId) return null;
    let actualTurnId = mappedTurnId(recordedSessionId, recordedTurnId);
    if (actualTurnId) return actualTurnId;
    await observeCurrentTurn(workspaceId, recordedSessionId, suppliedDeadline);
    actualTurnId = mappedTurnId(recordedSessionId, recordedTurnId);
    if (!actualTurnId) {
      throw new Error(
        `replay lineage Turn identity is unresolved: ${recordedSessionId}/${recordedTurnId}`
      );
    }
    return actualTurnId;
  };

  const readSessionGraph = async (
    workspaceId,
    rootSessionId,
    deadline = operationDeadline("replay Session graph")
  ) => {
    const response = await fetchWithReplayDeadline(
      fetchImpl,
      `${runtime.baseURL}/v1/${ports.workspaceScopeSegment}/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(rootSessionId)}?projection=messageHydration`,
      { headers: runtime.headers },
      deadline
    );
    if (!response.ok) {
      throw new Error(
        `failed to read replay Session graph: ${response.status} ${await readReplayResponseText(response, deadline)}`
      );
    }
    const body = await readReplayResponseJson(response, deadline);
    return [
      ...(body.session ? [body.session] : []),
      ...(Array.isArray(body.childSessions) ? body.childSessions : [])
    ];
  };

  const resolveSession = async (
    workspaceId,
    recordedSessionId,
    suppliedDeadline = null
  ) => {
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
    const deadline =
      suppliedDeadline ??
      operationDeadline(`replay child Session ${recordedSessionId}`);
    const actualRootSessionId = await resolveSession(
      workspaceId,
      identity.rootSessionId,
      deadline
    );
    const actualParentSessionId = await resolveSession(
      workspaceId,
      identity.parentSessionId,
      deadline
    );
    const actualRootTurnId = await resolveLineageTurn(
      workspaceId,
      identity.rootSessionId,
      identity.rootTurnId,
      deadline
    );
    const actualParentTurnId = await resolveLineageTurn(
      workspaceId,
      identity.parentSessionId,
      identity.parentTurnId,
      deadline
    );
    const matchesFamily = (session) =>
      session.kind === "child" &&
      session.rootAgentSessionId === actualRootSessionId &&
      session.parentAgentSessionId === actualParentSessionId;
    const matchesLineage = (session) =>
      matchesFamily(session) &&
      (!actualRootTurnId || session.rootTurnId === actualRootTurnId) &&
      (!actualParentTurnId || session.parentTurnId === actualParentTurnId);

    const claimUnique = (candidates, label) => {
      if (candidates.length > 1) {
        throw new Error(
          `replay child Session lineage is ambiguous (${label}): ${recordedSessionId}`
        );
      }
      if (candidates.length === 1) {
        identity.actualSessionId = candidates[0].id;
        observeSessionTurn(recordedSessionId, candidates[0]);
        return identity.actualSessionId;
      }
      return null;
    };

    let lastGraph = [];
    while (deadline.remainingMs() > 0) {
      const graph = await readSessionGraph(
        workspaceId,
        actualRootSessionId,
        deadline
      );
      lastGraph = graph;
      // Prefer sticky parentToolCallId when present. Tutti remints tool_call /
      // approval callIds across record→replay (alpha-equivalent in compare), so
      // fall back to unique lineage/family matches the same way remapped Turns
      // already resolve.
      const claimed =
        claimUnique(
          graph.filter(
            (session) =>
              matchesLineage(session) &&
              session.parentToolCallId === identity.parentToolCallId
          ),
          "callId"
        ) ||
        claimUnique(graph.filter(matchesLineage), "lineage") ||
        claimUnique(graph.filter(matchesFamily), "family");
      if (claimed) return claimed;
      await waitWithReplayDeadline(wait, 50, deadline);
    }
    const childSummaries = lastGraph
      .filter((session) => session?.kind === "child")
      .map((session) => ({
        id: session.id ?? null,
        rootAgentSessionId: session.rootAgentSessionId ?? null,
        parentAgentSessionId: session.parentAgentSessionId ?? null,
        rootTurnId: session.rootTurnId ?? null,
        parentTurnId: session.parentTurnId ?? null,
        parentToolCallId: session.parentToolCallId ?? null
      }));
    throw new Error(
      `replay child Session identity is unresolved: ${recordedSessionId}` +
        `; wanted root=${actualRootSessionId} parent=${actualParentSessionId}` +
        ` rootTurn=${actualRootTurnId ?? "<none>"} parentTurn=${actualParentTurnId ?? "<none>"}` +
        ` parentToolCallId=${identity.parentToolCallId}` +
        `; graphChildren=${JSON.stringify(childSummaries)}`
    );
  };

  return {
    captureActivityBaseline,
    observeCurrentTurn,
    async rebasePendingInteraction(event, suppliedDeadline = null) {
      if (!lean) {
        throw new Error(
          "rebasePendingInteraction requires sessionObservation=lean-activity"
        );
      }
      const deadline =
        suppliedDeadline ??
        operationDeadline(
          `replay Interaction identity ${event.payload?.requestId ?? ""}`
        );
      const actualSessionId = await resolveSession(
        event.workspaceId,
        event.agentSessionId,
        deadline
      );
      let latest = null;
      while (deadline.remainingMs() > 0) {
        const session = await readSession(
          event.workspaceId,
          actualSessionId,
          deadline
        );
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
        await waitWithReplayDeadline(wait, 50, deadline);
      }
      throw new Error(
        `timed out resolving replay Interaction identity ${event.agentSessionId}/${event.payload?.requestId}: ${JSON.stringify(latest)}`
      );
    },
    async rebase(event, suppliedDeadline = null) {
      if (lean) {
        const interactionIdentity = interactionIdentities.get(
          interactionIdentityKey(event)
        );
        if (interactionIdentity) {
          return rebaseMappedInteraction(event, interactionIdentity);
        }
      }
      const recordedSessionId = event.agentSessionId;
      const deadline =
        suppliedDeadline ??
        operationDeadline(`replay Turn identity ${recordedSessionId}`);
      const actualSessionId = await resolveSession(
        event.workspaceId,
        recordedSessionId,
        deadline
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
        await observeCurrentTurn(
          event.workspaceId,
          recordedSessionId,
          deadline
        );
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
