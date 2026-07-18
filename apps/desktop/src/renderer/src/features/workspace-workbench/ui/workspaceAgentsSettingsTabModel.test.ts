import assert from "node:assert/strict";
import test from "node:test";
import {
  filterVisibleAgentProviders,
  resolveAgentDeepLinkOutcome
} from "./workspaceAgentsSettingsTabModel.ts";

test("Agents list hides preview providers only while Preview Agents is off", () => {
  const providers = ["codex", "claude-code", "hermes"];
  assert.deepEqual(filterVisibleAgentProviders(providers, false), [
    "codex",
    "claude-code"
  ]);
  assert.deepEqual(filterVisibleAgentProviders(providers, true), providers);
});

test("deep link focuses a visible provider row", () => {
  const outcome = resolveAgentDeepLinkOutcome({
    previewEnabled: true,
    provider: "hermes",
    visibleProviders: ["codex", "hermes"]
  });
  assert.deepEqual(outcome, { kind: "focus", provider: "hermes" });
});

test("deep link to a hidden preview agent surfaces a hint, not silence", () => {
  const outcome = resolveAgentDeepLinkOutcome({
    previewEnabled: false,
    provider: "hermes",
    visibleProviders: ["codex", "claude-code"]
  });
  assert.deepEqual(outcome, { kind: "preview-hidden", provider: "hermes" });
});

test("deep link to a stable provider always focuses (panel-open state agnostic)", () => {
  const outcome = resolveAgentDeepLinkOutcome({
    previewEnabled: false,
    provider: "codex",
    visibleProviders: ["codex", "claude-code"]
  });
  assert.deepEqual(outcome, { kind: "focus", provider: "codex" });
});

test("deep link with no provider or an unknown provider yields no action", () => {
  assert.equal(
    resolveAgentDeepLinkOutcome({
      previewEnabled: true,
      provider: null,
      visibleProviders: ["codex"]
    }),
    null
  );
  assert.equal(
    resolveAgentDeepLinkOutcome({
      previewEnabled: true,
      provider: "not-a-managed-agent",
      visibleProviders: ["codex"]
    }),
    null
  );
});
