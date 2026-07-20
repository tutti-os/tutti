import assert from "node:assert/strict";
import test from "node:test";
import {
  filterVisibleAgentProviders,
  resolveAgentDeepLinkOutcome
} from "./workspaceAgentsSettingsTabModel.ts";

test("Agents list hides early-access integrations only while the gate is off", () => {
  const providers = ["codex", "claude-code", "hermes", "openclaw"];
  assert.deepEqual(filterVisibleAgentProviders(providers, false, false), [
    "codex",
    "claude-code"
  ]);
  assert.deepEqual(
    filterVisibleAgentProviders(providers, true, false),
    providers
  );
});

test("Agents list only shows Tutti Agent while Tutti Agent Switch is on", () => {
  const providers = ["codex", "tutti-agent", "hermes"];
  assert.deepEqual(filterVisibleAgentProviders(providers, true, false), [
    "codex",
    "hermes"
  ]);
  assert.deepEqual(
    filterVisibleAgentProviders(providers, true, true),
    providers
  );
});

test("deep link focuses a visible provider row", () => {
  const outcome = resolveAgentDeepLinkOutcome({
    earlyAccessEnabled: true,
    provider: "hermes",
    visibleProviders: ["codex", "hermes"]
  });
  assert.deepEqual(outcome, { kind: "focus", provider: "hermes" });
});

test("deep link to a hidden early-access integration surfaces a hint", () => {
  const outcome = resolveAgentDeepLinkOutcome({
    earlyAccessEnabled: false,
    provider: "openclaw",
    visibleProviders: ["codex", "claude-code"]
  });
  assert.deepEqual(outcome, {
    kind: "early-access-hidden",
    provider: "openclaw"
  });
});

test("deep link to a stable provider always focuses (panel-open state agnostic)", () => {
  const outcome = resolveAgentDeepLinkOutcome({
    earlyAccessEnabled: false,
    provider: "codex",
    visibleProviders: ["codex", "claude-code"]
  });
  assert.deepEqual(outcome, { kind: "focus", provider: "codex" });
});

test("deep link with no provider or an unknown provider yields no action", () => {
  assert.equal(
    resolveAgentDeepLinkOutcome({
      earlyAccessEnabled: true,
      provider: null,
      visibleProviders: ["codex"]
    }),
    null
  );
  assert.equal(
    resolveAgentDeepLinkOutcome({
      earlyAccessEnabled: true,
      provider: "not-a-managed-agent",
      visibleProviders: ["codex"]
    }),
    null
  );
});
