import assert from "node:assert/strict";
import test from "node:test";
import {
  areDesktopAgentGUIWorkbenchStatesEqual,
  createDesktopAgentGUINodeStateSource,
  createDefaultDesktopAgentGUINodeState,
  desktopAgentGUIProviderFromInstanceId,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIWorkbenchState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUINodeState
} from "./desktopAgentGUINodeState.ts";
import {
  resolveDesktopAgentGUIProviderForAgentTarget,
  withDesktopAgentGUIProviderComposerDefaults
} from "./ui/desktopAgentGUIWorkbenchStateHelpers.ts";

test("desktop agent gui node state preserves supported providers and falls back to codex", () => {
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
    "codex"
  );
});

test("desktop agent gui workbench state only preserves whitelisted data", () => {
  const workbenchState = normalizeDesktopAgentGUIWorkbenchState({
    composerOverrides: { permissionModeId: "full-access" },
    conversationRailCollapsed: true,
    agentTargetId: "daemon-gemini",
    lastActiveAgentSessionId: "session-1",
    lastActiveConversationTitle: "A title",
    provider: "gemini"
  });

  assert.deepEqual(workbenchState, {
    agentTargetId: "daemon-gemini",
    conversationRailCollapsed: true,
    conversationRailWidthPx: null,
    lastActiveAgentSessionId: "session-1"
  });
});

test("desktop agent gui workbench projection preserves rail state and permission defaults", () => {
  assert.deepEqual(
    projectDesktopAgentGUIWorkbenchState({
      ...createDefaultDesktopAgentGUINodeState("gemini"),
      composerOverrides: { permissionModeId: "read-only" },
      conversationCount: 3,
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360.4,
      agentTargetId: "daemon-gemini",
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
    }),
    {
      agentTargetId: "daemon-gemini",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
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
        provider: "gemini"
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
      normalizeDesktopAgentGUIWorkbenchState({
        lastActiveAgentSessionId: "session-1",
        providerTargetId: "legacy-target"
      }),
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
      gemini: {
        model: "gemini-pro",
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

test("desktop agent gui composer defaults are agent target keyed", () => {
  const state = withDesktopAgentGUIProviderComposerDefaults(
    {
      ...createDefaultDesktopAgentGUINodeState("codex"),
      agentTargetId: "local:codex"
    },
    "codex",
    {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    }
  );

  assert.deepEqual(state.composerOverridesByAgentTargetId, {
    "local:codex": {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    }
  });
  assert.equal(state.composerOverridesByProvider, null);
  assert.equal(state.composerOverrides, null);
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
    "claude-code"
  );
});

test("desktop agent gui target defaults do not use the fallback dock provider", () => {
  const state = withDesktopAgentGUIProviderComposerDefaults(
    {
      ...createDefaultDesktopAgentGUINodeState("claude-code"),
      agentTargetId: "local:claude-code"
    },
    "claude-code",
    {
      model: "default",
      permissionModeId: "default",
      reasoningEffort: "high"
    }
  );

  assert.deepEqual(state.composerOverridesByAgentTargetId, {
    "local:claude-code": {
      model: "default",
      permissionModeId: "default",
      reasoningEffort: "high"
    }
  });
});

test("desktop agent gui node state normalizes partial runtime data", () => {
  assert.deepEqual(
    normalizeDesktopAgentGUINodeState({
      composerOverrides: { model: "gpt-5" },
      lastActiveAgentSessionId: "session-1",
      provider: "gemini"
    }),
    {
      ...createDefaultDesktopAgentGUINodeState("gemini"),
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
      provider: "gemini"
    } as unknown as Partial<DesktopAgentGUINodeState>),
    {
      ...createDefaultDesktopAgentGUINodeState("gemini"),
      lastActiveAgentSessionId: "session-1"
    }
  );
});

test("desktop agent gui provider derives from workbench instance id", () => {
  assert.equal(desktopAgentGUIProviderFromInstanceId("agent-gui"), "codex");
  assert.equal(
    desktopAgentGUIProviderFromInstanceId("agent-gui:claude-code"),
    "claude-code"
  );
  assert.equal(
    desktopAgentGUIProviderFromInstanceId("agent-gui:gemini:panel:abc"),
    "gemini"
  );
  assert.equal(
    desktopAgentGUIProviderFromInstanceId("agent-gui:unsupported"),
    "codex"
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
    instanceId: "agent-gui:gemini",
    state: {
      agentTargetId: "daemon-gemini",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
    },
    typeId: "agent-gui"
  });

  assert.equal(notified, 1);
  assert.deepEqual(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:gemini",
      nodeId: "node-1",
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    }),
    {
      agentTargetId: "daemon-gemini",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
    }
  );

  source.writeNodeState({
    instanceId: "agent-gui:gemini",
    nodeId: "node-1",
    state: {
      agentTargetId: "daemon-gemini-2",
      conversationRailCollapsed: false,
      conversationRailWidthPx: 420,
      lastActiveAgentSessionId: "session-2"
    },
    typeId: "agent-gui"
  });

  assert.equal(notified, 2);
  assert.deepEqual(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:gemini",
      nodeId: "node-1",
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    }),
    {
      agentTargetId: "daemon-gemini-2",
      conversationRailCollapsed: false,
      conversationRailWidthPx: 420,
      lastActiveAgentSessionId: "session-2"
    }
  );
  assert.equal(
    source.readNodeState({
      instanceId: "agent-gui:gemini",
      typeId: "agent-gui"
    }),
    null
  );
  assert.equal(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:gemini",
      nodeId: "node-1",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    null
  );
});
