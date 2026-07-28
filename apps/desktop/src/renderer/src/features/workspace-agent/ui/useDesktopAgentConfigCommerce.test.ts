import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGUIAgentConfigMenuContext } from "@tutti-os/agent-gui";
import {
  isDesktopLocalTuttiAgentConfigContext,
  shouldRenderDesktopAgentConfigCommerce
} from "./desktopAgentConfigCommerceContext.ts";

function context(
  input: Partial<AgentGUIAgentConfigMenuContext> = {}
): AgentGUIAgentConfigMenuContext {
  return {
    agentTargetId: "local:tutti-agent",
    label: "Tutti Agent",
    ownership: "self",
    provider: "tutti-agent",
    ...input
  };
}

test("agent config Commerce is scoped to the self-owned Tutti Agent target", () => {
  assert.equal(isDesktopLocalTuttiAgentConfigContext(context()), true);
  assert.equal(
    isDesktopLocalTuttiAgentConfigContext(
      context({ agentTargetId: "local:codex", provider: "codex" })
    ),
    false
  );
  assert.equal(
    isDesktopLocalTuttiAgentConfigContext(context({ ownership: "shared" })),
    false
  );
});

test("agent config Commerce falls back while disabled or signed out", () => {
  assert.equal(
    shouldRenderDesktopAgentConfigCommerce({
      context: context(),
      enabled: true,
      hasAccount: true
    }),
    true
  );
  assert.equal(
    shouldRenderDesktopAgentConfigCommerce({
      context: context(),
      enabled: false,
      hasAccount: true
    }),
    false
  );
  assert.equal(
    shouldRenderDesktopAgentConfigCommerce({
      context: context(),
      enabled: true,
      hasAccount: false
    }),
    false
  );
});
