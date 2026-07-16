import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivitySession } from "../types.ts";
import {
  createInitialTuttiModeActivationState,
  tuttiModeActivationReducer
} from "./tuttiModeActivation.reducer.ts";
import {
  selectTuttiModeActivationPresentation,
  selectTuttiModeDraftIsActive
} from "./tuttiModeActivation.selectors.ts";

test("home Tutti intent transfers to an optimistic session and clears only after canonical hydration", () => {
  let state = createInitialTuttiModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "tuttiMode/draftSet"
  }).state;

  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialTuttiModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    tuttiModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;

  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );
  assert.equal(
    selectTuttiModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );

  const earlyNull = session(null);
  state = reduce(
    state,
    { sessions: [earlyNull], type: "session/snapshotReceived" },
    { "session-1": earlyNull }
  ).state;
  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.draftKey,
    "node-1:home"
  );
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );

  const staleInactive = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 15,
        revision: 1,
        source: "badge_remove",
        status: "inactive"
      },
      status: "inactive",
      updatedAtUnixMs: 15
    })
  );
  state = reduce(
    state,
    { session: staleInactive, type: "session/upserted" },
    { "session-1": staleInactive }
  ).state;
  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.draftKey,
    "node-1:home"
  );
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );

  const canonical = session(activeActivation());
  state = reduce(
    state,
    { sessions: [canonical], type: "session/snapshotReceived" },
    { "session-1": canonical }
  ).state;

  assert.equal(
    selectTuttiModeDraftIsActive(engineState(state), "node-1:home"),
    false
  );
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );
});

test("successful create result with the authoritative activation settles without waiting for an event", () => {
  let state = createInitialTuttiModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "tuttiMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialTuttiModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    tuttiModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;
  const canonical = session(activeActivation());
  state = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: { session: canonical }
  }).state;

  assert.equal(state.pendingCreatesBySessionId["session-1"], undefined);
  assert.equal(
    selectTuttiModeDraftIsActive(engineState(state), "node-1:home"),
    false
  );
  assert.equal(state.activationsBySessionId["session-1"]?.status, "active");
});

test("failed new-session activation preserves the home Tutti intent for retry", () => {
  let state = createInitialTuttiModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "tuttiMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialTuttiModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    tuttiModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    errorMessage: "create failed",
    outcome: "failed",
    type: "engine/commandResult"
  }).state;

  assert.equal(
    selectTuttiModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );
  assert.equal(state.pendingCreatesBySessionId["session-1"], undefined);
});

test("timed out new-session activation stays pending until canonical proof or expiry", () => {
  let state = createInitialTuttiModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "tuttiMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialTuttiModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    tuttiModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;

  const timedOut = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "timedOut",
    type: "engine/commandResult"
  });
  state = timedOut.state;

  assert.deepEqual(timedOut.commands, [
    {
      agentSessionId: "session-1",
      commandId: "tutti-mode-create-reconcile:activation-1",
      scope: "state",
      timeoutMs: 15_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.reconcileCommandId,
    "tutti-mode-create-reconcile:activation-1"
  );
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );

  const inactive = session(null);
  state = reduce(
    state,
    { session: inactive, type: "session/upserted" },
    { "session-1": inactive }
  ).state;
  assert.notEqual(state.pendingCreatesBySessionId["session-1"], undefined);

  state = reduce(
    state,
    {
      commandId: "tutti-mode-create-reconcile:activation-1",
      commandType: "session/reconcile",
      errorMessage: "network unavailable",
      outcome: "failed",
      type: "engine/commandResult"
    },
    { "session-1": inactive }
  ).state;
  assert.notEqual(state.pendingCreatesBySessionId["session-1"], undefined);
  assert.equal(
    selectTuttiModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );

  state = reduce(state, {
    dueAtUnixMs: 1_000,
    expiryId: "activation:activation-1",
    type: "engine/intentExpired"
  }).state;
  assert.equal(state.pendingCreatesBySessionId["session-1"], undefined);
  assert.equal(
    selectTuttiModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );
});

test("existing-session toggle uses the canonical revision and reconciles from the returned activation", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialTuttiModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;

  const requested = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "tutti-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "tuttiMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  );
  state = requested.state;

  assert.deepEqual(requested.commands, [
    {
      agentSessionId: "session-1",
      commandId: "tutti-mode-1",
      expectedRevision: 3,
      source: "badge_remove",
      status: "inactive",
      timeoutMs: 15_000,
      type: "tuttiMode/update",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );

  const inactive = activeActivation({
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 110,
      revision: 4,
      source: "badge_remove",
      status: "inactive"
    },
    status: "inactive",
    updatedAtUnixMs: 110
  });
  state = reduce(
    state,
    {
      commandId: "tutti-mode-1",
      commandType: "tuttiMode/update",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: { activation: inactive, changed: true }
    },
    { "session-1": canonical }
  ).state;

  const presentation = selectTuttiModeActivationPresentation(
    engineState(state),
    "session-1",
    "node-1:home"
  );
  assert.equal(presentation.active, false);
  assert.equal(presentation.updateStatus, "idle");
  assert.equal(presentation.activation?.currentRevision.revision, 4);
});

test("turn capability references never hydrate current Tutti state", () => {
  const canonical = session(null);
  const state = reduce(
    createInitialTuttiModeActivationState(),
    {
      turn: {
        agentSessionId: "session-1",
        capabilityRefs: [
          { capability: "tutti", source: "slash_command" as const }
        ],
        outcome: null,
        phase: "running",
        settledAtUnixMs: null,
        startedAtUnixMs: 1,
        turnId: "turn-1",
        updatedAtUnixMs: 1
      },
      type: "turn/upserted"
    },
    { "session-1": canonical }
  ).state;

  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );
});

test("canonical null and inactive projections remain inactive after reload", () => {
  const neverConfigured = session(null);
  let state = reduce(
    createInitialTuttiModeActivationState(),
    { sessions: [neverConfigured], type: "session/snapshotReceived" },
    { "session-1": neverConfigured }
  ).state;
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );

  const inactive = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 20,
        revision: 4,
        source: "badge_remove",
        status: "inactive"
      },
      status: "inactive",
      updatedAtUnixMs: 20
    })
  );
  state = reduce(
    state,
    { sessions: [inactive], type: "session/snapshotReceived" },
    { "session-1": inactive }
  ).state;
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );
  assert.equal(
    state.activationsBySessionId["session-1"]?.currentRevision.revision,
    4
  );
});

test("revision conflicts and timeouts request state reconciliation", () => {
  const canonical = session(activeActivation());
  for (const result of [
    {
      errorCode: "revision_conflict",
      errorMessage: "stale revision",
      outcome: "failed" as const
    },
    {
      errorMessage: "timed out",
      outcome: "timedOut" as const
    }
  ]) {
    let state = reduce(
      createInitialTuttiModeActivationState(),
      { session: canonical, type: "session/upserted" },
      { "session-1": canonical }
    ).state;
    const requested = reduce(
      state,
      {
        agentSessionId: "session-1",
        commandId: "tutti-mode-1",
        requestedAtUnixMs: 100,
        source: "badge_remove",
        status: "inactive",
        type: "tuttiMode/updateRequested",
        workspaceId: "workspace-1"
      },
      { "session-1": canonical }
    );
    state = requested.state;
    const settled = reduce(
      state,
      {
        commandId: "tutti-mode-1",
        commandType: "tuttiMode/update",
        type: "engine/commandResult",
        ...result
      },
      { "session-1": canonical }
    );
    assert.deepEqual(settled.commands, [
      {
        agentSessionId: "session-1",
        commandId: "tutti-mode-reconcile:tutti-mode-1",
        scope: "state",
        timeoutMs: 15_000,
        type: "session/reconcile",
        workspaceId: "workspace-1"
      }
    ]);
    assert.equal(
      settled.state.updatesBySessionId["session-1"]?.updateStatus,
      "uncertain"
    );
  }
});

test("an arbitrary hydration cannot settle an uncertain update", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialTuttiModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "tutti-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "tuttiMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      commandId: "tutti-mode-1",
      commandType: "tuttiMode/update",
      errorMessage: "timed out",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;

  const reconciled = reduce(
    state,
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;

  assert.equal(
    reconciled.updatesBySessionId["session-1"]?.updateStatus,
    "uncertain"
  );
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(reconciled),
      "session-1",
      "node-1:home"
    ).active,
    false
  );
});

test("semantic revision evidence settles an uncertain update", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialTuttiModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "tutti-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "tuttiMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      commandId: "tutti-mode-1",
      commandType: "tuttiMode/update",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;
  const inactive = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 110,
        revision: 4,
        source: "badge_remove",
        status: "inactive"
      },
      status: "inactive",
      updatedAtUnixMs: 110
    })
  );

  state = reduce(
    state,
    { session: inactive, type: "session/upserted" },
    { "session-1": inactive }
  ).state;

  assert.equal(state.updatesBySessionId["session-1"], undefined);
  assert.equal(state.activationsBySessionId["session-1"]?.status, "inactive");
});

test("the owned reconcile result makes an unresolved update retryable", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialTuttiModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "tutti-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "tuttiMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      commandId: "tutti-mode-1",
      commandType: "tuttiMode/update",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;

  state = reduce(
    state,
    {
      commandId: "tutti-mode-reconcile:tutti-mode-1",
      commandType: "session/reconcile",
      outcome: "succeeded",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;

  const update = state.updatesBySessionId["session-1"];
  assert.equal(update?.updateStatus, "failed");
  assert.equal(update?.errorCode, "tutti_mode_update_not_applied");
  assert.equal(
    selectTuttiModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );
});

function reduce(
  state: ReturnType<typeof createInitialTuttiModeActivationState>,
  intent: Parameters<typeof tuttiModeActivationReducer>[1],
  sessionsById: Readonly<Record<string, AgentActivitySession>> = {}
) {
  return tuttiModeActivationReducer(state, intent, { sessionsById });
}

function engineState(
  tuttiModeActivation: ReturnType<typeof createInitialTuttiModeActivationState>
) {
  return { tuttiModeActivation } as Parameters<
    typeof selectTuttiModeActivationPresentation
  >[0];
}

function session(
  tuttiModeActivation: AgentActivitySession["tuttiModeActivation"]
): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "Session",
    tuttiModeActivation,
    updatedAtUnixMs: 100,
    workspaceId: "workspace-1"
  });
}

function activeActivation(
  overrides: Partial<
    NonNullable<AgentActivitySession["tuttiModeActivation"]>
  > = {}
): NonNullable<AgentActivitySession["tuttiModeActivation"]> {
  return {
    agentSessionId: "session-1",
    createdAtUnixMs: 10,
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 10,
      revision: 3,
      source: "slash_command",
      status: "active"
    },
    id: "activation-1",
    status: "active",
    updatedAtUnixMs: 10,
    workspaceId: "workspace-1",
    ...overrides
  };
}
