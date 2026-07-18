import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentGUIAgentTarget } from "../../../types";
import { useAgentGUIProviderCatalogSelection } from "./useAgentGUIProviderCatalogSelection";

describe("useAgentGUIProviderCatalogSelection handoff catalog", () => {
  it("uses an independent ready target catalog for handoff", () => {
    const local = target("local-codex", "codex");
    const shared = target("shared-agent:claude", "claude-code");
    const unavailable = {
      ...target("shared-agent:offline", "codex"),
      disabled: true
    };
    const { result } = renderHook(() =>
      useAgentGUIProviderCatalogSelection({
        agentTargets: [local],
        agentTargetsLoading: false,
        comingSoonProviders: undefined,
        data: {
          agentTargetId: local.agentTargetId,
          lastActiveAgentSessionId: null,
          provider: local.provider
        },
        defaultAgentTargetId: local.agentTargetId,
        handoffAgentTargets: [local, shared, unavailable],
        handoffAgentTargetsLoading: false,
        providerRailMode: "exact",
        providerReadinessGates: null
      })
    );

    expect(result.current.normalizedProviderTargets).toEqual([local]);
    expect(result.current.handoffAgentTargets).toEqual([local, shared]);
  });

  it("uses the runtime catalog when no independent handoff catalog is supplied", () => {
    const local = target("local-codex", "codex");
    const { result } = renderHook(() =>
      useAgentGUIProviderCatalogSelection({
        agentTargets: [local],
        agentTargetsLoading: false,
        comingSoonProviders: undefined,
        data: {
          agentTargetId: local.agentTargetId,
          lastActiveAgentSessionId: null,
          provider: local.provider
        },
        defaultAgentTargetId: local.agentTargetId,
        handoffAgentTargets: undefined,
        handoffAgentTargetsLoading: undefined,
        providerRailMode: "exact",
        providerReadinessGates: null
      })
    );

    expect(result.current.handoffAgentTargets).toEqual([local]);
  });
});

function target(agentTargetId: string, provider: string): AgentGUIAgentTarget {
  return {
    agentTargetId,
    label: agentTargetId,
    provider,
    ref: { agentTargetId, kind: "agent-directory", provider },
    targetId: agentTargetId
  };
}
