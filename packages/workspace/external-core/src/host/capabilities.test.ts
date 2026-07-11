import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTuttiExternalCapabilities } from "./capabilities.ts";

test("deduplicates and freezes valid host capabilities", () => {
  const capabilities = normalizeTuttiExternalCapabilities({
    atProviders: ["file", "file"],
    managedAiProviders: ["openai", "openai"],
    operations: ["app.getContext", "app.getContext"],
    workspaceAgentProviders: ["codex", "codex"],
    workspaceFeatures: ["agent-chat", "agent-chat"]
  });
  assert.deepEqual(capabilities, {
    atProviders: ["file"],
    managedAiProviders: ["openai"],
    operations: ["app.getContext"],
    workspaceAgentProviders: ["codex"],
    workspaceFeatures: ["agent-chat"]
  });
  assert.equal(Object.isFrozen(capabilities), true);
  for (const value of Object.values(capabilities)) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("rejects malformed host capability domains", () => {
  for (const capabilities of [
    { operations: ["not.real"] },
    { atProviders: ["evil"], operations: [] },
    { managedAiProviders: ["evil"], operations: [] },
    { operations: [], workspaceAgentProviders: ["evil"] },
    { operations: [], workspaceFeatures: ["evil"] },
    { atProviders: null, operations: [] },
    { operations: null }
  ]) {
    assert.throws(
      () => normalizeTuttiExternalCapabilities(capabilities as never),
      /capabilities (are invalid|must be an object)/
    );
  }
});
