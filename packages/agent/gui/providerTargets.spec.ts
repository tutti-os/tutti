import { describe, expect, it } from "vitest";
import {
  agentGUIProviderTargetRefsEqual,
  createLocalAgentGUIProviderTarget,
  createLocalAgentGUIProviderTargets,
  createSharedAgentGUIProviderTarget,
  normalizeAgentGUIProviderTargets,
  resolveAgentGUIProviderTarget
} from "./providerTargets";

describe("agent gui provider targets", () => {
  it("creates local targets for the default provider catalog", () => {
    expect(createLocalAgentGUIProviderTarget("codex")).toEqual({
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
      createLocalAgentGUIProviderTargets().map((target) => target.targetId)
    ).toEqual([
      "local:codex",
      "local:claude-code",
      "local:cursor",
      "local:tutti-agent",
      "local:opencode",
      "local:hermes",
      "local:openclaw"
    ]);
    expect(createLocalAgentGUIProviderTarget("cursor")).toMatchObject({
      agentTargetId: "local:cursor",
      label: "Cursor",
      provider: "cursor"
    });
    expect(createLocalAgentGUIProviderTarget("nexight")).toMatchObject({
      agentTargetId: "local:nexight",
      label: "Tutti Agent",
      provider: "nexight"
    });
    expect(createLocalAgentGUIProviderTarget("hermes")).toMatchObject({
      agentTargetId: "local:hermes",
      label: "Hermes",
      provider: "hermes"
    });
    expect(createLocalAgentGUIProviderTarget("openclaw")).toMatchObject({
      agentTargetId: "local:openclaw",
      label: "OpenClaw",
      provider: "openclaw"
    });
  });

  it("can append disabled placeholder targets for unavailable future providers", () => {
    const targets = normalizeAgentGUIProviderTargets(
      [
        createLocalAgentGUIProviderTarget("codex"),
        createLocalAgentGUIProviderTarget("claude-code")
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
        agentTargetId: "local:hermes",
        disabled: true,
        label: "Hermes",
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
    expect(agentGUIProviderTargetRefsEqual(undefined, null)).toBe(true);
  });

  it("keeps host-owned opaque target refs without interpreting kind", () => {
    const targets = normalizeAgentGUIProviderTargets([
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
      createSharedAgentGUIProviderTarget({
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
    const [target] = normalizeAgentGUIProviderTargets(
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
    const targets = normalizeAgentGUIProviderTargets([
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
    const targets = normalizeAgentGUIProviderTargets(undefined, {
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
      { disabled: false, provider: "tutti-agent" },
      { disabled: false, provider: "opencode" },
      { disabled: true, provider: "hermes" },
      { disabled: true, provider: "openclaw" }
    ]);
  });

  it("can normalize explicit targets without static catalog targets", () => {
    const targets = normalizeAgentGUIProviderTargets([], {
      useStaticCatalog: false
    });

    expect(targets).toEqual([]);
  });

  it("rejects targets whose ref provider does not match the real provider", () => {
    const targets = normalizeAgentGUIProviderTargets([
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
    const targets = normalizeAgentGUIProviderTargets([
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
      resolveAgentGUIProviderTarget({
        defaultProviderTargetId: "shared-agent:claude-1",
        provider: "codex",
        providerTargetId: "shared-agent:missing",
        providerTargets: targets
      })
    ).toMatchObject({
      targetId: "shared-agent:codex-1",
      provider: "codex"
    });
  });

  it("resolves agent target ids across providers before using provider fallback", () => {
    const targets = normalizeAgentGUIProviderTargets(
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
      resolveAgentGUIProviderTarget({
        agentTargetId: "local:claude-code",
        provider: "codex",
        providerTargets: targets
      })
    ).toMatchObject({
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      targetId: "local:claude-code"
    });
  });
});
