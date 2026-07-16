import { describe, expect, it } from "vitest";
import {
  normalizeAgentGUIAgents,
  projectAgentGUIAgentsToInternalTargets,
  resolveAgentGUISelectedDirectoryAgent
} from "./agents";
import type { AgentGUIAgent } from "./types";

function createAgent(
  agentTargetId: string,
  overrides: Partial<AgentGUIAgent> = {}
): AgentGUIAgent {
  return {
    agentTargetId,
    name: agentTargetId,
    iconUrl: `app://agents/${agentTargetId}.png`,
    availability: { status: "ready" },
    provider: "codex",
    ...overrides
  };
}

describe("normalizeAgentGUIAgents", () => {
  it("preserves host order and keeps agents that share a provider distinct", () => {
    const agents = normalizeAgentGUIAgents([
      createAgent("alice-codex", { name: "Alice's Codex" }),
      createAgent("bob-codex", { name: "Bob's Codex" })
    ]);

    expect(agents.map((agent) => agent.agentTargetId)).toEqual([
      "alice-codex",
      "bob-codex"
    ]);
    expect(agents.map((agent) => agent.provider)).toEqual(["codex", "codex"]);
  });

  it("drops invalid and duplicate identities while normalizing presentation", () => {
    const agents = normalizeAgentGUIAgents([
      createAgent(" alice ", {
        name: " Alice ",
        iconUrl: " app://agents/alice.png ",
        heroImageUrl: " app://agents/alice-hero.jpg ",
        description: " Shared agent ",
        owner: { name: " Owner ", avatarUrl: " app://owner.png " },
        availability: { status: "unavailable", reason: " Offline " }
      }),
      createAgent("alice"),
      createAgent("", { name: "Missing identity" }),
      createAgent("missing-name", { name: " " }),
      createAgent("missing-icon", { iconUrl: " " })
    ]);

    expect(agents).toEqual([
      {
        agentTargetId: "alice",
        name: "Alice",
        iconUrl: "app://agents/alice.png",
        heroImageUrl: "app://agents/alice-hero.jpg",
        description: "Shared agent",
        owner: { name: "Owner", avatarUrl: "app://owner.png" },
        availability: { status: "unavailable", reason: "Offline" },
        provider: "codex"
      }
    ]);
  });

  it("projects owner, quota, concurrency, and audit access without credentials", () => {
    const [agent] = normalizeAgentGUIAgents([
      createAgent("shared-agent:one", {
        owner: { userId: " owner-1 ", name: "Owner" },
        sharedAccess: {
          grantId: " grant-1 ",
          ownerUserId: " owner-1 ",
          ownerOnline: true,
          auditRequired: true,
          quota: { unit: "tokens", remaining: 0, limit: 10_000 },
          concurrency: { active: 1, limit: 2 }
        }
      })
    ]);
    expect(agent).toBeDefined();
    if (!agent) throw new Error("expected normalized shared Agent");

    expect(agent.availability).toEqual({
      status: "unavailable",
      reason: "share_quota_exhausted"
    });
    expect(agent.owner?.userId).toBe("owner-1");
    const [target] = projectAgentGUIAgentsToInternalTargets([agent]);
    expect(target).toBeDefined();
    if (!target) throw new Error("expected projected shared target");
    expect(target.disabled).toBe(true);
    expect(target.unavailableReason).toBe("share_quota_exhausted");
    expect(target.ref.sharedAccess).toEqual(agent.sharedAccess);
    expect(JSON.stringify(target)).not.toContain("credential");
  });
});

describe("resolveAgentGUISelectedDirectoryAgent", () => {
  const unavailable = createAgent("agent-a");
  unavailable.availability = { status: "unavailable" };
  const ready = createAgent("agent-b");

  it("requires an exact match for an explicit target", () => {
    expect(
      resolveAgentGUISelectedDirectoryAgent({
        agents: [unavailable, ready],
        agentTargetId: "missing-agent"
      })
    ).toBeNull();
  });

  it("keeps a missing default target exact", () => {
    expect(
      resolveAgentGUISelectedDirectoryAgent({
        agents: [unavailable, ready],
        defaultAgentTargetId: "delayed-agent"
      })
    ).toBeNull();
  });

  it("uses the first ready agent only when no explicit target exists", () => {
    expect(
      resolveAgentGUISelectedDirectoryAgent({
        agents: [unavailable, ready]
      })?.agentTargetId
    ).toBe("agent-b");
  });
});
