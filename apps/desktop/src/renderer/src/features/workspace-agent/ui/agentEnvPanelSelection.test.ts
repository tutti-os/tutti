import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentEnvPanelProviderSelection } from "./agentEnvPanelSelection.ts";

const visibleProviders = ["claude-code", "codex", "tutti-agent"] as const;

test("agent env panel selection resolves a new request synchronously", () => {
  assert.deepEqual(
    resolveAgentEnvPanelProviderSelection({
      current: { provider: "codex", requestSequence: 1 },
      defaultProvider: "claude-code",
      lastSelectedProvider: null,
      requestedProvider: null,
      requestSequence: 2,
      visibleProviders
    }),
    { provider: "claude-code", requestSequence: 2 }
  );
});

test("agent env panel selection honors an explicit provider on a new request", () => {
  assert.deepEqual(
    resolveAgentEnvPanelProviderSelection({
      current: { provider: "claude-code", requestSequence: 1 },
      defaultProvider: "claude-code",
      lastSelectedProvider: "claude-code",
      requestedProvider: "tutti-agent",
      requestSequence: 2,
      visibleProviders
    }),
    { provider: "tutti-agent", requestSequence: 2 }
  );
});

test("agent env panel selection preserves a tab switch within one request", () => {
  assert.deepEqual(
    resolveAgentEnvPanelProviderSelection({
      current: { provider: "tutti-agent", requestSequence: 2 },
      defaultProvider: "claude-code",
      lastSelectedProvider: "codex",
      requestedProvider: "codex",
      requestSequence: 2,
      visibleProviders
    }),
    { provider: "tutti-agent", requestSequence: 2 }
  );
});

test("agent env panel selection falls back when a provider is hidden", () => {
  assert.deepEqual(
    resolveAgentEnvPanelProviderSelection({
      current: { provider: "cursor", requestSequence: 1 },
      defaultProvider: "cursor",
      lastSelectedProvider: "cursor",
      requestedProvider: "cursor",
      requestSequence: 2,
      visibleProviders
    }),
    { provider: "claude-code", requestSequence: 2 }
  );
});
