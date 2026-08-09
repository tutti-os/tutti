import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import { resolveCaptureAgentCapabilities } from "./captureAgentCapabilities.ts";

function composerOptions(
  overrides: Partial<AgentActivityComposerOptions> = {}
): AgentActivityComposerOptions {
  return {
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: true,
      planModeExclusiveWithPermissionMode: false,
      prewarmDraftSession: false,
      refreshModelOptionsAfterSettings: false
    },
    capabilities: {
      activeTurnGuidance: false,
      browserUse: false,
      compact: false,
      computerUse: false,
      goalPause: false,
      imageInput: true,
      interrupt: false,
      modelImageInputRequired: false,
      modelPlanBinding: false,
      modelSwitch: false,
      permissionModeChangeDeferred: false,
      permissionModeChangeDuringTurn: false,
      planImplementation: false,
      planMode: false,
      rateLimits: false,
      resumeRunningTurn: false,
      review: false,
      skills: false,
      tokenUsage: false
    },
    loadedAtUnixMs: 1,
    models: [],
    provider: "codex",
    reasoningEfforts: [],
    skills: [],
    speeds: [],
    ...overrides
  };
}

test("capture capabilities require authoritative image input support", () => {
  assert.deepEqual(
    resolveCaptureAgentCapabilities(composerOptions({ capabilities: null })),
    { imageInput: false, workspaceReferences: true }
  );
  assert.deepEqual(resolveCaptureAgentCapabilities(composerOptions()), {
    imageInput: true,
    workspaceReferences: true
  });
});

test("capture capabilities honor model-specific image support", () => {
  const required = composerOptions({
    capabilities: {
      ...composerOptions().capabilities!,
      modelImageInputRequired: true
    },
    effectiveModel: "text-only",
    models: [{ value: "text-only", label: "Text", supportsImageInput: false }]
  });
  assert.deepEqual(resolveCaptureAgentCapabilities(required), {
    imageInput: false,
    workspaceReferences: true
  });
  assert.deepEqual(
    resolveCaptureAgentCapabilities({
      ...required,
      effectiveModel: "vision",
      models: [{ value: "vision", label: "Vision", supportsImageInput: true }]
    }),
    { imageInput: true, workspaceReferences: true }
  );
});
