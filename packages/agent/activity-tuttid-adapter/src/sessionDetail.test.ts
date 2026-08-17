import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceAgentEditRetryAvailability,
  WorkspaceAgentSession,
  WorkspaceAgentSessionDetailResponse,
  WorkspaceAgentTurn
} from "@tutti-os/client-tuttid-ts";
import { agentActivitySessionDetailFromTuttid } from "./index.ts";

test("detail mapping preserves the authoritative root, children, and Turns", () => {
  const detail = agentActivitySessionDetailFromTuttid(
    "workspace-1",
    "root-1",
    {
      editRetry: {
        ...createEditRetryAvailability(),
        availableActions: ["reconcile"],
        eligible: true,
        historyRevision: 7,
        operationId: "operation-1",
        recoveryState: "recovery_required",
        supported: true,
        turnId: "turn-root-1"
      },
      projection: "full",
      lifecycleCapabilitiesProjected: true,
      session: createSession({
        id: "root-1",
        isolation: {
          baseCommit: "abc123",
          branch: "tutti/session/root-1",
          mode: "worktree",
          worktreeId: "worktree-1",
          worktreePath: "/worktrees/root-1"
        },
        kind: "root"
      }),
      childSessions: [
        createSession({
          id: "child-1",
          kind: "child",
          parentAgentSessionId: "root-1",
          parentTurnId: "turn-root-1",
          rootAgentSessionId: "root-1",
          rootTurnId: "turn-root-1"
        })
      ],
      turns: [
        createTurn({
          agentSessionId: "root-1",
          capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
          turnId: "turn-root-1"
        })
      ]
    } satisfies WorkspaceAgentSessionDetailResponse,
    { currentUserId: "account-user-1" }
  );

  assert.equal(detail.session.agentSessionId, "root-1");
  assert.equal(detail.session.userId, "account-user-1");
  assert.equal(detail.session.lifecycleCapabilitiesProjected, true);
  assert.deepEqual(detail.session.isolation, {
    baseCommit: "abc123",
    branch: "tutti/session/root-1",
    mode: "worktree",
    worktreeId: "worktree-1",
    worktreePath: "/worktrees/root-1"
  });
  assert.deepEqual(detail.editRetry, {
    availableActions: ["reconcile"],
    eligible: true,
    historyRevision: 7,
    operationId: "operation-1",
    recoveryState: "recovery_required",
    supported: true,
    turnId: "turn-root-1"
  });
  assert.deepEqual(
    detail.childSessions.map((session) => ({
      agentSessionId: session.agentSessionId,
      parentAgentSessionId: session.parentAgentSessionId,
      rootAgentSessionId: session.rootAgentSessionId,
      lifecycleCapabilitiesProjected: session.lifecycleCapabilitiesProjected,
      isolation: session.isolation,
      userId: session.userId
    })),
    [
      {
        agentSessionId: "child-1",
        parentAgentSessionId: "root-1",
        rootAgentSessionId: "root-1",
        lifecycleCapabilitiesProjected: true,
        isolation: null,
        userId: "account-user-1"
      }
    ]
  );
  assert.deepEqual(
    detail.turns.map((turn) => [turn.agentSessionId, turn.turnId]),
    [["root-1", "turn-root-1"]]
  );
  assert.deepEqual(detail.turns[0]?.capabilityRefs, [
    { capability: "tutti", source: "slash_command" }
  ]);
});

test("detail mapping keeps unresolved capability projections out of authoritative reads", () => {
  const detail = {
    editRetry: createEditRetryAvailability(),
    projection: "messageHydration",
    lifecycleCapabilitiesProjected: false,
    session: createSession({ id: "root-1", kind: "root" }),
    childSessions: [],
    turns: []
  } satisfies WorkspaceAgentSessionDetailResponse;

  assert.doesNotThrow(() =>
    agentActivitySessionDetailFromTuttid("workspace-1", "root-1", detail, {
      currentUserId: "account-user-1"
    })
  );
  assert.equal(
    agentActivitySessionDetailFromTuttid("workspace-1", "root-1", detail, {
      currentUserId: "account-user-1"
    }).session.lifecycleCapabilitiesProjected,
    false
  );
  const inconsistent = {
    ...detail,
    lifecycleCapabilitiesProjected: true
  };
  assert.throws(
    () =>
      agentActivitySessionDetailFromTuttid(
        "workspace-1",
        "root-1",
        inconsistent,
        {
          currentUserId: "account-user-1"
        }
      ),
    /lifecycle capability projection does not match detail projection/
  );
});

test("detail mapping fails the entire aggregate when a child violates protocol v2", () => {
  const child = createSession({
    id: "child-1",
    kind: "child",
    parentAgentSessionId: "root-1",
    rootAgentSessionId: "root-1"
  });
  const malformedChild = { ...child } as Record<string, unknown>;
  delete malformedChild.railSectionKey;

  assert.throws(
    () =>
      agentActivitySessionDetailFromTuttid(
        "workspace-1",
        "root-1",
        {
          editRetry: createEditRetryAvailability(),
          projection: "full",
          lifecycleCapabilitiesProjected: true,
          session: createSession({ id: "root-1", kind: "root" }),
          childSessions: [malformedChild as WorkspaceAgentSession],
          turns: []
        },
        { currentUserId: "account-user-1" }
      ),
    /Protocol v2 contract error:.*railSectionKey/
  );
});

test("detail mapping rejects a response for a different requested Session", () => {
  assert.throws(
    () =>
      agentActivitySessionDetailFromTuttid(
        "workspace-1",
        "requested-1",
        {
          editRetry: createEditRetryAvailability(),
          projection: "full",
          lifecycleCapabilitiesProjected: true,
          session: createSession({ id: "other-1", kind: "root" }),
          childSessions: [],
          turns: []
        },
        { currentUserId: "account-user-1" }
      ),
    /root Session id.*does not match requested id/
  );
});

test("detail mapping rejects children outside the requested hierarchy", () => {
  assert.throws(
    () =>
      agentActivitySessionDetailFromTuttid(
        "workspace-1",
        "root-1",
        {
          editRetry: createEditRetryAvailability(),
          projection: "full",
          lifecycleCapabilitiesProjected: true,
          session: createSession({ id: "root-1", kind: "root" }),
          childSessions: [
            createSession({
              id: "foreign-child",
              kind: "child",
              parentAgentSessionId: "foreign-root",
              rootAgentSessionId: "root-1"
            })
          ],
          turns: []
        },
        { currentUserId: "account-user-1" }
      ),
    /outside the requested Session hierarchy/
  );
});

test("detail mapping accepts descendants below a requested child Session", () => {
  const detail = agentActivitySessionDetailFromTuttid(
    "workspace-1",
    "child-1",
    {
      editRetry: createEditRetryAvailability(),
      projection: "full",
      lifecycleCapabilitiesProjected: true,
      session: createSession({
        id: "child-1",
        kind: "child",
        parentAgentSessionId: "root-1",
        rootAgentSessionId: "root-1"
      }),
      childSessions: [
        createSession({
          id: "nested-child-1",
          kind: "child",
          parentAgentSessionId: "child-1",
          rootAgentSessionId: "root-1"
        })
      ],
      turns: [createTurn({ agentSessionId: "child-1", turnId: "child-turn-1" })]
    },
    { currentUserId: "account-user-1" }
  );

  assert.equal(detail.session.agentSessionId, "child-1");
  assert.equal(detail.childSessions[0]?.agentSessionId, "nested-child-1");
});

test("detail mapping rejects malformed or foreign Turns atomically", () => {
  for (const turn of [
    createTurn({ agentSessionId: "child-1", turnId: "turn-child-1" }),
    createTurn({ agentSessionId: "root-1", turnId: " " })
  ]) {
    assert.throws(
      () =>
        agentActivitySessionDetailFromTuttid(
          "workspace-1",
          "root-1",
          {
            editRetry: createEditRetryAvailability(),
            projection: "full",
            lifecycleCapabilitiesProjected: true,
            session: createSession({ id: "root-1", kind: "root" }),
            childSessions: [],
            turns: [turn]
          },
          { currentUserId: "account-user-1" }
        ),
      /Turn.*must be owned by requested Session/
    );
  }
});

function createEditRetryAvailability(): WorkspaceAgentEditRetryAvailability {
  return {
    availableActions: [],
    eligible: false,
    historyRevision: 0,
    recoveryState: "completed",
    supported: false
  };
}

function createSession(
  overrides: Partial<WorkspaceAgentSession>
): WorkspaceAgentSession {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentTargetId: "target-1",
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/workspace",
    endedAtUnixMs: null,
    forkedFrom: null,
    goal: null,
    goalSyncState: null,
    id: "session-1",
    imported: false,
    kind: "root",
    latestTurn: null,
    latestTurnInteractions: [],
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    messageVersion: 0,
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    railSectionKey: "conversations",
    resumable: true,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 2,
    usage: null,
    visible: true,
    ...overrides
  };
}

function createTurn(
  overrides: Pick<WorkspaceAgentTurn, "agentSessionId" | "turnId"> &
    Partial<WorkspaceAgentTurn>
): WorkspaceAgentTurn {
  const { agentSessionId, turnId, ...rest } = overrides;
  return {
    agentSessionId,
    completedCommand: null,
    error: null,
    fileChanges: null,
    origin: "user_prompt",
    outcome: null,
    phase: "settled",
    providerForkBindingAvailable: false,
    providerForkBindingState: "recovery_required",
    settledAtUnixMs: 3,
    startedAtUnixMs: 1,
    turnId,
    updatedAtUnixMs: 3,
    ...rest
  };
}
