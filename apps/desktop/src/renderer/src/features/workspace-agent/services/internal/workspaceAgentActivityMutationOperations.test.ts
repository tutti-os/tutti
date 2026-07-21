import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityAdapter,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { WorkspaceAgentActivityMutationOperations } from "./workspaceAgentActivityMutationOperations.ts";

test("WorkspaceAgentActivityMutationOperations carries Tutti activation metadata through new-session activation", async () => {
  const createInputs: Parameters<AgentActivityAdapter["createSession"]>[0][] =
    [];
  const upserts: { session: AgentActivitySession; source: string }[] = [];
  const session = activitySession();
  const adapter = {
    async createSession(
      input: Parameters<AgentActivityAdapter["createSession"]>[0]
    ) {
      createInputs.push(input);
      return session;
    }
  } as AgentActivityAdapter;
  const operations = createOperations({
    adapter,
    upsertAuthoritativeSession: (authoritativeSession, source) => {
      upserts.push({ session: authoritativeSession, source });
    }
  });

  const result = await operations.activateSession({
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-1",
    cwd: " /workspace ",
    initialContent: [{ type: "text", text: "Build the plan" }],
    initialTuttiModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    workspaceId: " ws-1 "
  });

  assert.equal(result.activation.status, "attached");
  assert.equal(createInputs.length, 1);
  assert.deepEqual(createInputs[0]?.capabilityRefs, [
    { capability: "tutti", source: "slash_command" }
  ]);
  assert.deepEqual(createInputs[0]?.initialTuttiModeActivation, {
    source: "slash_command",
    status: "active"
  });
  assert.equal(createInputs[0]?.cwd, "/workspace");
  assert.equal(createInputs[0]?.workspaceId, "ws-1");
  assert.deepEqual(upserts, [{ session, source: "create_session_result" }]);
});

test("WorkspaceAgentActivityMutationOperations sends existing-session Tutti activation updates through the facade-owned adapter", async () => {
  const updateInputs: Parameters<
    AgentActivityAdapter["updateTuttiModeActivation"]
  >[0][] = [];
  const activation = {
    agentSessionId: "session-1",
    createdAtUnixMs: 10,
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 20,
      revision: 2,
      source: "badge_remove" as const,
      status: "inactive" as const
    },
    id: "activation-1",
    status: "inactive" as const,
    updatedAtUnixMs: 20,
    workspaceId: "ws-1"
  };
  const adapter = {
    async updateTuttiModeActivation(
      input: Parameters<AgentActivityAdapter["updateTuttiModeActivation"]>[0]
    ) {
      updateInputs.push(input);
      return { activation, changed: true };
    }
  } as AgentActivityAdapter;
  const operations = createOperations({ adapter });

  const result = await operations.updateTuttiModeActivation({
    agentSessionId: "session-1",
    expectedRevision: 1,
    source: "badge_remove",
    status: "inactive",
    workspaceId: "ws-1"
  });

  assert.deepEqual(updateInputs, [
    {
      agentSessionId: "session-1",
      expectedRevision: 1,
      source: "badge_remove",
      status: "inactive",
      workspaceId: "ws-1"
    }
  ]);
  assert.deepEqual(result, { activation, changed: true });
});

function createOperations(input: {
  adapter: AgentActivityAdapter;
  upsertAuthoritativeSession?: (
    session: AgentActivitySession,
    source: string
  ) => void;
}): WorkspaceAgentActivityMutationOperations {
  return new WorkspaceAgentActivityMutationOperations({
    getSession: async () => activitySession(),
    load: async () => {
      throw new Error("unexpected load");
    },
    markSessionDeleted: () => {},
    runtimeApi: { logTerminalDiagnostic: async () => {} },
    sessionCommandTarget: () => ({ adapter: input.adapter }),
    tuttidClient: {} as TuttidClient,
    upsertAuthoritativeSession: input.upsertAuthoritativeSession ?? (() => {})
  });
}

function activitySession(): AgentActivitySession {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/workspace",
    endedAtUnixMs: null,
    goal: null,
    imported: false,
    kind: "root",
    lastEventUnixMs: 1,
    latestTurn: null,
    latestTurnInteractions: [],
    messageVersion: 0,
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    resumable: true,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    startedAtUnixMs: 1,
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 1,
    usage: null,
    visible: true,
    workspaceId: "ws-1"
  };
}
