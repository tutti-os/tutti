import { describe, expect, it } from "vitest";
import {
  normalizeAgentGUIAgents,
  projectAgentGUIAgentsToTargets,
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

  it("drops invalid and duplicate identities while retaining iconless Agents", () => {
    const agents = normalizeAgentGUIAgents([
      createAgent(" alice ", {
        name: " Alice ",
        iconUrl: " app://agents/alice.png ",
        maskIconUrl: " app://agents/alice-mask.png ",
        heroImageUrl: " app://agents/alice-hero.jpg ",
        description: " Shared agent ",
        ownerDeviceLabel: " Owner MacBook Pro ",
        owner: { name: " Owner ", avatarUrl: " app://owner.png " },
        ownership: "shared",
        availability: { status: "unavailable", reason: " Offline " }
      }),
      createAgent("alice"),
      createAgent("", { name: "Missing identity" }),
      createAgent("missing-name", { name: " " }),
      {
        agentTargetId: "missing-icon",
        name: "missing-icon",
        iconUrl: "",
        availability: { status: "ready" },
        provider: "codex"
      }
    ]);

    expect(agents).toEqual([
      {
        agentTargetId: "alice",
        name: "Alice",
        iconUrl: "app://agents/alice.png",
        maskIconUrl: "app://agents/alice-mask.png",
        heroImageUrl: "app://agents/alice-hero.jpg",
        description: "Shared agent",
        ownerDeviceLabel: "Owner MacBook Pro",
        owner: { name: "Owner", avatarUrl: "app://owner.png" },
        ownership: "shared",
        availability: { status: "unavailable", reason: "Offline" },
        provider: "codex"
      },
      {
        agentTargetId: "missing-icon",
        name: "missing-icon",
        iconUrl: "",
        availability: { status: "ready" },
        provider: "codex"
      }
    ]);
  });
});

describe("projectAgentGUIAgentsToTargets", () => {
  it("preserves explicit ownership independently from owner presentation", () => {
    const [target] = projectAgentGUIAgentsToTargets([
      createAgent("agent-a", {
        owner: { name: "Current User", avatarUrl: "app://owner.png" },
        ownerDeviceLabel: "Current User Mac mini",
        ownership: "self"
      })
    ]);

    expect(target).toMatchObject({
      ownership: "self",
      ownerLabel: "Current User",
      ownerDeviceLabel: "Current User Mac mini",
      badge: { iconUrl: "app://owner.png" }
    });
  });

  it("projects the mask icon independently from the canonical icon", () => {
    const [target] = projectAgentGUIAgentsToTargets([
      createAgent("agent-a", {
        maskIconUrl: "app://agents/agent-a-mask.png"
      })
    ]);

    expect(target).toMatchObject({
      iconUrl: "app://agents/agent-a.png",
      maskIconUrl: "app://agents/agent-a-mask.png"
    });
  });

  it("keeps an Agent without decorative icon metadata selectable", () => {
    const agents = normalizeAgentGUIAgents([
      createAgent("workspace-agent:reviewer", { iconUrl: " " })
    ]);

    const [target] = projectAgentGUIAgentsToTargets(agents);

    expect(target).toMatchObject({
      agentTargetId: "workspace-agent:reviewer",
      iconUrl: "",
      targetId: "workspace-agent:reviewer"
    });
    expect(target?.disabled).toBeUndefined();
  });

  it("preserves availability separately from disabled interaction state", () => {
    const [target] = projectAgentGUIAgentsToTargets([
      createAgent("agent-a", {
        availability: { status: "unavailable", reason: "Offline" }
      })
    ]);

    expect(target).toMatchObject({
      agentTargetId: "agent-a",
      availability: { status: "unavailable", reason: "Offline" },
      disabled: true,
      unavailableReason: "Offline"
    });
    expect(target?.availability?.status).not.toBe("coming_soon");
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
