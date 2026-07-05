import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDefaultAppFactoryProvider,
  resolveSelectedAppFactoryProvider
} from "./appFactoryProviderDefaults.ts";

test("app factory provider defaults prefer codex when available", () => {
  assert.equal(
    resolveDefaultAppFactoryProvider([
      { provider: "claude-code" },
      { provider: "codex" }
    ]),
    "codex"
  );
});

test("app factory provider defaults prefer configured provider when available", () => {
  assert.equal(
    resolveDefaultAppFactoryProvider(
      [{ provider: "claude-code" }, { provider: "codex" }],
      "claude-code"
    ),
    "claude-code"
  );
});

test("app factory provider defaults map legacy configured provider to agent target", () => {
  assert.equal(
    resolveDefaultAppFactoryProvider(
      [
        { agentTargetId: "local:codex", provider: "codex" },
        { agentTargetId: "local:claude-code", provider: "claude-code" }
      ],
      "claude-code"
    ),
    "local:claude-code"
  );
});

test("app factory provider defaults fall back to first enabled provider", () => {
  assert.equal(
    resolveDefaultAppFactoryProvider([
      { disabled: true, provider: "codex" },
      { provider: "claude-code" }
    ]),
    "claude-code"
  );
});

test("app factory provider defaults fall back when configured provider is disabled", () => {
  assert.equal(
    resolveDefaultAppFactoryProvider(
      [{ disabled: true, provider: "claude-code" }, { provider: "codex" }],
      "claude-code"
    ),
    "codex"
  );
});

test("app factory selected provider keeps valid existing selection", () => {
  assert.equal(
    resolveSelectedAppFactoryProvider("claude-code", [
      { provider: "claude-code" },
      { provider: "codex" }
    ]),
    "claude-code"
  );
});

test("app factory selected provider maps legacy selection to agent target", () => {
  assert.equal(
    resolveSelectedAppFactoryProvider("claude-code", [
      { agentTargetId: "local:claude-code", provider: "claude-code" },
      { agentTargetId: "local:codex", provider: "codex" }
    ]),
    "local:claude-code"
  );
});

test("app factory selected provider resolves missing selection to default", () => {
  assert.equal(
    resolveSelectedAppFactoryProvider("", [
      { provider: "claude-code" },
      { provider: "codex" }
    ]),
    "codex"
  );
});
