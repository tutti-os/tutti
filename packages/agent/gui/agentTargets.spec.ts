import { describe, expect, it } from "vitest";
import {
  agentGUIAgentTargetRefsEqual,
  createLocalAgentGUIAgentTarget,
  createLocalAgentGUIAgentTargets,
  createSharedAgentGUIAgentTarget,
  normalizeAgentGUIAgentTargets,
  resolveAgentGUIAgentTarget
} from "./agentTargets";

describe("agent gui provider targets", () => {
  it("keeps migration-window default providers unique", () => {
    const providers = createLocalAgentGUIAgentTargets().map(
      (target) => target.provider
    );
    expect(new Set(providers).size).toBe(providers.length);
  });

  it("creates local targets for the default provider catalog", () => {
    expect(createLocalAgentGUIAgentTarget("codex")).toEqual({
      targetId: "local:codex",
      agentTargetId: "local:codex",
      provider: "codex",
      ref: {
        kind: "local",
        provider: "codex"
      },
      label: "Codex"
    });
    expect(
      createLocalAgentGUIAgentTargets().map((target) => target.targetId)
    ).toEqual([
      "local:codex",
      "local:claude-code",
      "local:cursor",
      "local:tutti-agent",
      "local:opencode",
      "local:nexight",
      "local:hermes",
      "local:openclaw"
    ]);
    expect(createLocalAgentGUIAgentTarget("cursor")).toMatchObject({
      agentTargetId: "local:cursor",
      label: "Cursor",
      provider: "cursor"
    });
    expect(createLocalAgentGUIAgentTarget("nexight")).toMatchObject({
      agentTargetId: "local:nexight",
      label: "Nexight",
      provider: "nexight"
    });
    expect(createLocalAgentGUIAgentTarget("hermes")).toMatchObject({
      agentTargetId: "local:hermes",
      label: "Hermes Agent",
      provider: "hermes"
    });
    expect(createLocalAgentGUIAgentTarget("openclaw")).toMatchObject({
      agentTargetId: "local:openclaw",
      label: "OpenClaw",
      provider: "openclaw"
    });
  });

  it("can append disabled placeholder targets for unavailable future providers", () => {
    const targets = normalizeAgentGUIAgentTargets(
      [
        createLocalAgentGUIAgentTarget("codex"),
        createLocalAgentGUIAgentTarget("claude-code")
      ],
      {
        includeDisabledPlaceholders: true,
        useStaticCatalog: false
      }
    );

    expect(
      targets.map((target) => ({
        agentTargetId: target.agentTargetId ?? null,
        disabled: target.disabled === true,
        label: target.label,
        provider: target.provider
      }))
    ).toEqual([
      {
        agentTargetId: "local:codex",
        disabled: false,
        label: "Codex",
        provider: "codex"
      },
      {
        agentTargetId: "local:claude-code",
        disabled: false,
        label: "Claude Code",
        provider: "claude-code"
      },
      {
        agentTargetId: "local:tutti-agent",
        disabled: true,
        label: "Tutti Agent",
        provider: "tutti-agent"
      },
      {
        agentTargetId: "local:nexight",
        disabled: true,
        label: "Nexight",
        provider: "nexight"
      },
      {
        agentTargetId: "local:hermes",
        disabled: true,
        label: "Hermes Agent",
        provider: "hermes"
      },
      {
        agentTargetId: "local:openclaw",
        disabled: true,
        label: "OpenClaw",
        provider: "openclaw"
      }
    ]);
  });

  it("treats nullish provider target refs as equal", () => {
    expect(agentGUIAgentTargetRefsEqual(undefined, null)).toBe(true);
  });

  it("keeps host-owned opaque target refs without interpreting kind", () => {
    const targets = normalizeAgentGUIAgentTargets([
      {
        targetId: "shared-agent:agent-1",
        provider: "codex",
        ref: {
          kind: "shared-agent",
          provider: "codex",
          sharedAgentId: "agent-1"
        },
        label: "Alice's Codex"
      }
    ]);

    expect(targets).toEqual([
      {
        targetId: "shared-agent:agent-1",
        provider: "codex",
        ref: {
          kind: "shared-agent",
          provider: "codex",
          sharedAgentId: "agent-1"
        },
        label: "Alice's Codex"
      }
    ]);
  });

  it("creates shared agent targets with owner and availability metadata", () => {
    expect(
      createSharedAgentGUIAgentTarget({
        provider: "codex",
        sharedAgentId: " agent-1 ",
        agentTargetId: " cp-target-1 ",
        label: "Alice's Codex",
        badge: {
          iconUrl: " app://alice-avatar.png ",
          label: " Alice avatar "
        },
        ownerLabel: " Alice ",
        iconUrl: " app://alice.png ",
        unavailableReason: " owner_offline ",
        disabled: true,
        ref: {
          ownerUserId: "user-1"
        }
      })
    ).toEqual({
      targetId: "shared-agent:agent-1",
      agentTargetId: "cp-target-1",
      provider: "codex",
      ref: {
        kind: "shared-agent",
        provider: "codex",
        sharedAgentId: "agent-1",
        ownerUserId: "user-1"
      },
      label: "Alice's Codex",
      badge: {
        iconUrl: "app://alice-avatar.png",
        label: "Alice avatar"
      },
      ownerLabel: "Alice",
      iconUrl: "app://alice.png",
      unavailableReason: "owner_offline",
      disabled: true
    });
  });

  it("drops whitespace-only optional target metadata during normalization", () => {
    const [target] = normalizeAgentGUIAgentTargets(
      [
        {
          targetId: " shared-agent:agent-1 ",
          provider: "codex",
          ref: {
            kind: " shared-agent ",
            provider: "codex",
            sharedAgentId: "agent-1"
          },
          label: " Alice's Codex ",
          badge: {
            iconUrl: " ",
            label: " "
          },
          description: " ",
          ownerLabel: " ",
          iconUrl: " ",
          unavailableReason: " "
        }
      ],
      { useStaticCatalog: false }
    );

    expect(target).toEqual({
      targetId: "shared-agent:agent-1",
      provider: "codex",
      ref: {
        kind: "shared-agent",
        provider: "codex",
        sharedAgentId: "agent-1"
      },
      label: "Alice's Codex"
    });
  });

  it("keeps same target ids for different real providers", () => {
    const targets = normalizeAgentGUIAgentTargets([
      {
        targetId: "default",
        provider: "codex",
        ref: {
          kind: "shared-agent",
          provider: "codex",
          sharedAgentId: "codex-1"
        },
        label: "Codex default"
      },
      {
        targetId: "default",
        provider: "claude-code",
        ref: {
          kind: "shared-agent",
          provider: "claude-code",
          sharedAgentId: "claude-1"
        },
        label: "Claude default"
      }
    ]);

    expect(targets).toHaveLength(2);
    expect(targets.map((target) => target.provider)).toEqual([
      "codex",
      "claude-code"
    ]);
  });

  it("marks future providers disabled in the static provider catalog", () => {
    const targets = normalizeAgentGUIAgentTargets(undefined, {
      includeDisabledPlaceholders: true
    });

    expect(
      targets.map((target) => ({
        disabled: target.disabled === true,
        provider: target.provider
      }))
    ).toEqual([
      { disabled: false, provider: "codex" },
      { disabled: false, provider: "claude-code" },
      { disabled: false, provider: "cursor" },
      { disabled: true, provider: "tutti-agent" },
      { disabled: false, provider: "opencode" },
      { disabled: true, provider: "nexight" },
      { disabled: true, provider: "hermes" },
      { disabled: true, provider: "openclaw" }
    ]);
  });

  it("can normalize explicit targets without static catalog targets", () => {
    const targets = normalizeAgentGUIAgentTargets([], {
      useStaticCatalog: false
    });

    expect(targets).toEqual([]);
  });

  it("rejects targets whose ref provider does not match the real provider", () => {
    const targets = normalizeAgentGUIAgentTargets([
      {
        targetId: "shared-agent:agent-1",
        provider: "codex",
        ref: {
          kind: "shared-agent",
          provider: "claude-code",
          sharedAgentId: "agent-1"
        },
        label: "Invalid Codex"
      }
    ]);

    expect(targets.map((target) => target.targetId)).toContain("local:codex");
    expect(targets).not.toContainEqual(
      expect.objectContaining({ targetId: "shared-agent:agent-1" })
    );
  });

  it("resolves targets only within the selected real provider", () => {
    const targets = normalizeAgentGUIAgentTargets([
      {
        targetId: "shared-agent:codex-1",
        provider: "codex",
        ref: {
          kind: "shared-agent",
          provider: "codex",
          sharedAgentId: "codex-1"
        },
        label: "Alice's Codex"
      },
      {
        targetId: "shared-agent:claude-1",
        provider: "claude-code",
        ref: {
          kind: "shared-agent",
          provider: "claude-code",
          sharedAgentId: "claude-1"
        },
        label: "Bob's Claude"
      }
    ]);

    expect(
      resolveAgentGUIAgentTarget({
        agentTargetId: "shared-agent:missing",
        defaultAgentTargetId: "shared-agent:claude-1",
        provider: "codex",
        agentTargets: targets
      })
    ).toMatchObject({
      targetId: "shared-agent:codex-1",
      provider: "codex"
    });
  });

  it("resolves agent target ids across providers before using provider fallback", () => {
    const targets = normalizeAgentGUIAgentTargets(
      [
        {
          targetId: "local:codex",
          agentTargetId: "local:codex",
          provider: "codex",
          ref: {
            kind: "local",
            provider: "codex"
          },
          label: "Codex"
        },
        {
          targetId: "local:claude-code",
          agentTargetId: "local:claude-code",
          provider: "claude-code",
          ref: {
            kind: "local",
            provider: "claude-code"
          },
          label: "Claude Code"
        }
      ],
      { useStaticCatalog: false }
    );

    expect(
      resolveAgentGUIAgentTarget({
        agentTargetId: "local:claude-code",
        provider: "codex",
        agentTargets: targets
      })
    ).toMatchObject({
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      targetId: "local:claude-code"
    });
  });
});
