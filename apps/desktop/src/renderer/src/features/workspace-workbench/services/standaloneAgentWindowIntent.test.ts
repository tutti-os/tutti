import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopAgentGUIOpenSessionActivationType,
  desktopAgentGUIPrefillPromptActivationType
} from "../../workspace-agent/desktopAgentGUINodeState.ts";
import { createAgentWindowIntent } from "../../../../../shared/contracts/windowIntent.ts";
import {
  createStandaloneAgentWindowLaunchPayload,
  resolveStandaloneAgentInitialActivation,
  resolveStandaloneAgentWindowBootstrap
} from "./standaloneAgentWindowIntent.ts";

test("standalone Agent decodes opaque Fusion launch payload in the renderer", () => {
  assert.deepEqual(
    resolveStandaloneAgentWindowBootstrap(
      createAgentWindowIntent({
        launchPayload: {
          agentFeature: "manage",
          agentSessionId: " payload-session ",
          agentTargetId: " target-1 ",
          agents: [
            {
              agentTargetId: " target-1 ",
              availability: { status: "ready" },
              iconUrl: " icon ",
              name: " Codex ",
              provider: "codex"
            }
          ],
          autoSubmit: true,
          draftPrompt: " inspect this ",
          provider: " claude-code ",
          userProjectPath: " /tmp/project "
        },
        resourceID: "resource-session",
        windowInstanceID: "window-1",
        workspaceID: "workspace-1"
      })
    ),
    {
      agentFeature: "manage",
      agentSessionId: "payload-session",
      agentTargetId: "target-1",
      agents: [
        {
          agentTargetId: "target-1",
          availability: { status: "ready" },
          iconUrl: "icon",
          name: "Codex",
          provider: "codex"
        }
      ],
      autoSubmit: true,
      draftPrompt: "inspect this",
      fusionWindowId: "window-1",
      provider: "claude-code",
      providerStatusSnapshot: null,
      userProjectPath: "/tmp/project"
    }
  );
});

test("standalone Agent rejects unknown opaque features and keeps the native resource fallback", () => {
  const bootstrap = resolveStandaloneAgentWindowBootstrap(
    createAgentWindowIntent({
      launchPayload: { agentFeature: "unknown" },
      resourceID: "resource-session",
      workspaceID: "workspace-1"
    })
  );

  assert.equal(bootstrap.agentFeature, null);
  assert.equal(bootstrap.agentSessionId, "resource-session");
});

test("standalone Agent launch payload creator normalizes renderer-owned fields", () => {
  assert.deepEqual(
    createStandaloneAgentWindowLaunchPayload({
      agentSessionId: " session-1 ",
      autoSubmit: true,
      draftPrompt: " prompt ",
      provider: "codex"
    }),
    {
      agentSessionId: "session-1",
      autoSubmit: true,
      draftPrompt: "prompt",
      provider: "codex"
    }
  );
});

test("standalone Agent drops malformed nested bootstrap values", () => {
  const bootstrap = resolveStandaloneAgentWindowBootstrap(
    createAgentWindowIntent({
      launchPayload: {
        agents: [
          null,
          {
            agentTargetId: "bad-agent",
            availability: { status: "ready" },
            iconUrl: "icon",
            name: "Bad",
            provider: "evil"
          }
        ],
        provider: "evil",
        providerStatusSnapshot: {
          capturedAt: "2026-07-12T00:00:00.000Z",
          defaultProvider: "evil",
          error: null,
          isLoading: false,
          pendingActions: [{}, { actionId: "refresh", provider: "codex" }],
          statuses: [
            null,
            { provider: "codex" },
            {
              actions: [],
              adapter: { command: ["codex"], installed: true },
              auth: { status: "authenticated" },
              availability: { status: "ready" },
              cli: { installed: true },
              provider: "codex"
            }
          ]
        }
      },
      workspaceID: "workspace-1"
    })
  );

  assert.equal(bootstrap.provider, null);
  assert.deepEqual(bootstrap.agents, []);
  assert.deepEqual(bootstrap.providerStatusSnapshot, {
    capturedAt: "2026-07-12T00:00:00.000Z",
    defaultProvider: null,
    error: null,
    isLoading: false,
    pendingActions: [{ actionId: "refresh", provider: "codex" }],
    statuses: [
      {
        actions: [],
        adapter: { command: ["codex"], installed: true },
        auth: { status: "authenticated" },
        availability: { status: "ready" },
        cli: { installed: true },
        provider: "codex"
      }
    ]
  });
});

test("standalone Agent initial activation gives an existing session priority", () => {
  const activation = resolveStandaloneAgentInitialActivation({
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    autoSubmit: true,
    draftPrompt: "ignored draft",
    provider: "codex",
    userProjectPath: "/workspace"
  });

  assert.deepEqual(activation, {
    payload: { agentSessionId: "session-1" },
    sequence: 1,
    type: desktopAgentGUIOpenSessionActivationType
  });
});

test("standalone Agent initial activation preserves draft handoff fields", () => {
  const activation = resolveStandaloneAgentInitialActivation({
    agentSessionId: null,
    agentTargetId: "target-1",
    autoSubmit: true,
    draftPrompt: "  investigate this  ",
    provider: "codex",
    userProjectPath: "/workspace"
  });

  assert.deepEqual(activation, {
    payload: {
      agentTargetId: "target-1",
      autoSubmit: true,
      draftPrompt: "investigate this",
      provider: "codex",
      userProjectPath: "/workspace"
    },
    sequence: 1,
    type: desktopAgentGUIPrefillPromptActivationType
  });
});
