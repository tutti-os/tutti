import { describe, expect, it } from "vitest";
import {
  projectAgentGUIAgentTargetAvatar,
  resolveAgentGUIAgentAvatarIconUrl
} from "./agentGuiAgentAvatarPresentation";

describe("agent gui agent avatar presentation", () => {
  it("projects identity, resolved icon, and badge from one agent target", () => {
    expect(
      projectAgentGUIAgentTargetAvatar({
        targetId: "shared-agent:alice-codex",
        agentTargetId: "shared-agent:alice-codex",
        provider: "codex",
        ref: { kind: "agent-directory", provider: "codex" },
        label: "Alice's Codex",
        iconUrl: " app://agents/alice-codex.png ",
        badge: {
          iconUrl: "app://people/alice.png",
          label: "Alice"
        }
      })
    ).toEqual({
      targetId: "shared-agent:alice-codex",
      agentTargetId: "shared-agent:alice-codex",
      provider: "codex",
      label: "Alice's Codex",
      iconUrl: "app://agents/alice-codex.png",
      badge: {
        iconUrl: "app://people/alice.png",
        label: "Alice"
      }
    });
  });

  it("uses the managed agent artwork when a target has no custom icon", () => {
    expect(resolveAgentGUIAgentAvatarIconUrl("codex")).toContain("codex");
  });
});
