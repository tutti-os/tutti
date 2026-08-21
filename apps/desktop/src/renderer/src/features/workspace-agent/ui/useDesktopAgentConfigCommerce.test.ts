import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import type { AgentGUIAgentConfigMenuContext } from "@tutti-os/agent-gui";
import {
  mapAgentTargetsToPresentations,
  mapAgentTargetPresentationsToAgents
} from "../services/internal/desktopAgentsService.ts";
import {
  hasDesktopLocalTuttiAgent,
  isDesktopLocalTuttiAgentConfigContext,
  shouldRenderDesktopAgentConfigCommerce
} from "./desktopAgentConfigCommerceContext.ts";

function context(
  input: Partial<AgentGUIAgentConfigMenuContext> = {}
): AgentGUIAgentConfigMenuContext {
  return {
    presentation: "menu",
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

test("agent config Commerce renders content only while enabled and signed in", () => {
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

test("daemon Tutti Agent mapping supplies the self-owned Commerce context", () => {
  const target: AgentTarget = {
    createdAtUnixMs: 1780272000000,
    enabled: true,
    iconKey: "tutti-agent",
    iconUrl: "tutti-asset://agent/tutti-agent.png",
    heroImageUrl: null,
    maskIconUrl: null,
    id: "local:tutti-agent",
    launchRef: {
      provider: "tutti-agent",
      type: "builtin_local"
    },
    name: "Tutti Agent",
    provider: "tutti-agent",
    sortOrder: 50,
    source: "system",
    updatedAtUnixMs: 1780272000000
  };
  const agent = mapAgentTargetPresentationsToAgents(
    mapAgentTargetsToPresentations([target])
  )[0];

  assert.ok(agent);
  assert.equal(hasDesktopLocalTuttiAgent([]), false);
  assert.equal(hasDesktopLocalTuttiAgent([agent]), true);
  assert.equal(
    shouldRenderDesktopAgentConfigCommerce({
      context: {
        presentation: "menu",
        agentTargetId: agent.agentTargetId,
        label: agent.name,
        ownership: agent.ownership ?? undefined,
        provider: agent.provider
      },
      enabled: true,
      hasAccount: true
    }),
    true
  );
});
