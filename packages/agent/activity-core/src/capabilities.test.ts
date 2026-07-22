import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CAPABILITY_KEYS,
  agentActivitySessionCapabilitiesFromIds,
  hasAgentCapability,
  resolveAgentActivityCapability
} from "./capabilities.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivitySessionCapabilities
} from "./types.ts";

test("runtime capabilities take precedence over composer options", () => {
  assert.equal(
    resolveAgentActivityCapability("compact", {
      sessionCapabilities: { compact: false, interrupt: true },
      composerOptions: composerOptions({ capabilities: ["compact"] })
    }),
    false
  );
  assert.equal(
    resolveAgentActivityCapability("compact", {
      sessionCapabilities: { compact: true }
    }),
    true
  );
});

test("falls back to composer options when session has no capability list", () => {
  assert.equal(
    resolveAgentActivityCapability("skills", {
      composerOptions: composerOptions({ capabilities: ["skills"] })
    }),
    true
  );
});

test("returns null when no capability data exists", () => {
  assert.equal(resolveAgentActivityCapability("compact", {}), null);
});

test("checks one runtime capability without provider inference", () => {
  assert.equal(hasAgentCapability({ planMode: true }, "planMode"), true);
  assert.equal(hasAgentCapability({}, "planMode"), false);
});

test("imageInput resolves from the capabilities list only", () => {
  assert.equal(
    resolveAgentActivityCapability("imageInput", {
      sessionCapabilities: { imageInput: true }
    }),
    true
  );
  assert.equal(resolveAgentActivityCapability("imageInput", {}), null);
});

test("vocabulary matches the Go side", () => {
  assert.deepEqual([...AGENT_CAPABILITY_KEYS].sort(), [
    "activeTurnGuidance",
    "browserUse",
    "compact",
    "computerUse",
    "goalPause",
    "imageInput",
    "interrupt",
    "modelImageInputRequired",
    "modelPlanBinding",
    "modelSwitch",
    "permissionModeChangeDeferred",
    "permissionModeChangeDuringTurn",
    "planImplementation",
    "planMode",
    "rateLimits",
    "resumeRunningTurn",
    "review",
    "skills",
    "tokenUsage"
  ]);
});

test("canonical capability ids project to the closed activity record", () => {
  const capabilities = agentActivitySessionCapabilitiesFromIds([
    "tokenUsage",
    "goalPause",
    "unknown"
  ]);

  assert.equal(capabilities.tokenUsage, true);
  assert.equal(capabilities.goalPause, true);
  assert.equal(capabilities.interrupt, false);
  assert.deepEqual(Object.keys(capabilities), [...AGENT_CAPABILITY_KEYS]);
});

function composerOptions(input: {
  capabilities?: readonly string[];
}): AgentActivityComposerOptions {
  const capabilities = input.capabilities ?? [];
  return {
    provider: "codex",
    capabilities: Object.fromEntries(
      AGENT_CAPABILITY_KEYS.map((key) => [key, capabilities.includes(key)])
    ) as unknown as AgentActivitySessionCapabilities,
    models: [],
    reasoningEfforts: [],
    speeds: [],
    permissionConfig: null,
    capabilityCatalog: [],
    skills: [],
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: false,
      refreshModelOptionsAfterSettings: false,
      prewarmDraftSession: false,
      planModeExclusiveWithPermissionMode: false
    },
    loadedAtUnixMs: 1
  };
}
