import assert from "node:assert/strict";
import test from "node:test";
import {
  areDesktopAgentGUIWorkbenchStatesEqual,
  createDesktopAgentGUINodeStateSource,
  createDefaultDesktopAgentGUINodeState,
  migrateLegacyDesktopAgentGUIWorkbenchState,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIWorkbenchState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUINodeState
} from "./desktopAgentGUINodeState.ts";
import { resolveDesktopAgentGUIProviderForAgentTarget } from "./ui/desktopAgentGUIWorkbenchStateHelpers.ts";

test("desktop agent gui node state preserves open valid providers", () => {
  assert.equal(
    normalizeDesktopAgentGUINodeState({
      provider: "claude-code"
    } as unknown as Partial<DesktopAgentGUINodeState>).provider,
    "claude-code"
  );
  assert.equal(
    normalizeDesktopAgentGUINodeState({
      provider: "unsupported"
    } as unknown as Partial<DesktopAgentGUINodeState>).provider,
    "unsupported"
  );
});

test("desktop agent gui workbench state only preserves whitelisted data", () => {
  const workbenchState = normalizeDesktopAgentGUIWorkbenchState({
    composerOverrides: { permissionModeId: "full-access" },
    conversationRailCollapsed: true,
    agentTargetId: "daemon-hermes",
    lastActiveAgentSessionId: "session-1",
    lastActiveAgentSessionIdByAgentTargetId: {
      "daemon-hermes": "session-1"
    },
    lastActiveConversationTitle: "A title",
    provider: "hermes"
  });

  assert.deepEqual(workbenchState, {
    agentTargetId: "daemon-hermes",
    conversationRailCollapsed: true,
    conversationRailWidthPx: null,
    lastActiveAgentSessionId: "session-1",
    lastActiveAgentSessionIdByAgentTargetId: {
      "daemon-hermes": "session-1"
    }
  });
});

test("desktop agent gui workbench projection preserves rail state and permission defaults", () => {
  assert.deepEqual(
    projectDesktopAgentGUIWorkbenchState({
      ...createDefaultDesktopAgentGUINodeState("hermes"),
      composerOverrides: { permissionModeId: "read-only" },
      conversationCount: 3,
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360.4,
      agentTargetId: "daemon-hermes",
      lastActiveAgentSessionId: "session-1",
      lastActiveAgentSessionIdByAgentTargetId: {
        "daemon-hermes": "session-1"
      }
    }),
    {
      agentTargetId: "daemon-hermes",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1",
      lastActiveAgentSessionIdByAgentTargetId: {
        "daemon-hermes": "session-1"
      }
    }
  );
});

test("desktop agent gui workbench state equality includes rail state", () => {
  assert.equal(
    areDesktopAgentGUIWorkbenchStatesEqual(
      normalizeDesktopAgentGUIWorkbenchState({
        composerOverrides: { permissionModeId: "auto" },
        conversationRailCollapsed: false,
        lastActiveAgentSessionId: "session-1"
      }),
      normalizeDesktopAgentGUIWorkbenchState({
        lastActiveAgentSessionId: "session-1",
        provider: "hermes"
      })
    ),
    true
  );
  assert.equal(
    areDesktopAgentGUIWorkbenchStatesEqual(
      normalizeDesktopAgentGUIWorkbenchState({
        conversationRailCollapsed: false,
        lastActiveAgentSessionId: "session-1"
      }),
      normalizeDesktopAgentGUIWorkbenchState({
        composerOverrides: { permissionModeId: "auto" },
        conversationRailCollapsed: true,
        lastActiveAgentSessionId: "session-1"
      })
    ),
    false
  );
  assert.equal(
    areDesktopAgentGUIWorkbenchStatesEqual(
      normalizeDesktopAgentGUIWorkbenchState(
        migrateLegacyDesktopAgentGUIWorkbenchState({
          lastActiveAgentSessionId: "session-1",
          providerTargetId: "legacy-target"
        })
      ),
      normalizeDesktopAgentGUIWorkbenchState({
        lastActiveAgentSessionId: "session-1",
        agentTargetId: "legacy-target"
      })
    ),
    true
  );
});

test("desktop agent gui workbench state ignores composer overrides by provider", () => {
  const workbenchState = normalizeDesktopAgentGUIWorkbenchState({
    composerOverridesByProvider: {
      codex: {
        model: "gpt-5",
        permissionModeId: "auto",
        reasoningEffort: "high"
      },
      hermes: {
        model: "hermes-pro",
        permissionModeId: "full-access",
        reasoningEffort: "medium"
      },
      unsupported: {
        model: "ignored"
      }
    }
  });

  assert.equal("composerOverridesByProvider" in workbenchState, false);
});

test("desktop agent gui workbench state ignores composer overrides by agent target", () => {
  const workbenchState = normalizeDesktopAgentGUIWorkbenchState({
    composerOverridesByAgentTargetId: {
      "local:codex": {
        model: "gpt-5",
        permissionModeId: "auto",
        reasoningEffort: "high"
      }
    }
  });

  assert.equal("composerOverridesByAgentTargetId" in workbenchState, false);
});

test("desktop agent gui target state resolves composer defaults from the target provider", () => {
  assert.equal(
    resolveDesktopAgentGUIProviderForAgentTarget(
      "local:claude-code",
      [
        {
          agentTargetId: "local:codex",
          provider: "codex"
        },
        {
          agentTargetId: "local:claude-code",
          provider: "claude-code"
        }
      ],
      "codex"
    ),
    "claude-code"
  );
  assert.equal(
    resolveDesktopAgentGUIProviderForAgentTarget(null, [], "codex"),
    "codex"
  );
  assert.equal(
    resolveDesktopAgentGUIProviderForAgentTarget(
      "local:claude-code",
      [],
      "codex"
    ),
    "codex"
  );
});

test("desktop agent gui node state normalizes partial runtime data", () => {
  assert.deepEqual(
    normalizeDesktopAgentGUINodeState({
      composerOverrides: { model: "gpt-5" },
      lastActiveAgentSessionId: "session-1",
      provider: "hermes"
    }),
    {
      ...createDefaultDesktopAgentGUINodeState("hermes"),
      composerOverrides: { model: "gpt-5" },
      lastActiveAgentSessionId: "session-1"
    }
  );
});

test("desktop agent gui node state ignores removed legacy composer defaults", () => {
  assert.deepEqual(
    normalizeDesktopAgentGUINodeState({
      defaultModel: "gpt-5",
      defaultPlanMode: true,
      defaultReasoningEffort: "high",
      lastActiveAgentSessionId: "session-1",
      provider: "hermes"
    } as unknown as Partial<DesktopAgentGUINodeState>),
    {
      ...createDefaultDesktopAgentGUINodeState("hermes"),
      lastActiveAgentSessionId: "session-1"
    }
  );
});

test("desktop agent gui node state source consumes instance launch state after node state is written", (t) => {
  const source = createDesktopAgentGUINodeStateSource({
    workspaceId: "workspace-1"
  });
  let notified = 0;
  const unsubscribe =
    source.externalStateSource.subscribe?.(() => {
      notified += 1;
    }) ?? (() => undefined);
  t.after(unsubscribe);

  source.writeNodeState({
    instanceId: "agent-gui:hermes",
    state: {
      agentTargetId: "daemon-hermes",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
    },
    typeId: "agent-gui"
  });

  assert.equal(notified, 1);
  assert.deepEqual(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:hermes",
      nodeId: "node-1",
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    }),
    {
      agentTargetId: "daemon-hermes",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
    }
  );

  source.writeNodeState({
    instanceId: "agent-gui:hermes",
    nodeId: "node-1",
    state: {
      agentTargetId: "daemon-hermes-2",
      conversationRailCollapsed: false,
      conversationRailWidthPx: 420,
      lastActiveAgentSessionId: "session-2"
    },
    typeId: "agent-gui"
  });

  assert.equal(notified, 2);
  assert.deepEqual(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:hermes",
      nodeId: "node-1",
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    }),
    {
      agentTargetId: "daemon-hermes-2",
      conversationRailCollapsed: false,
      conversationRailWidthPx: 420,
      lastActiveAgentSessionId: "session-2"
    }
  );
  assert.equal(
    source.readNodeState({
      instanceId: "agent-gui:hermes",
      typeId: "agent-gui"
    }),
    null
  );
  assert.equal(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:hermes",
      nodeId: "node-1",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    null
  );
});
