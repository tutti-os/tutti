import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGUIVinylPlayer } from "./AgentGUIVinylPlayer";

describe("AgentGUIVinylPlayer", () => {
  beforeEach(() => {
    vi.spyOn(window, "Image").mockImplementation(function MockImage() {
      const image = document.createElement("img");
      Object.defineProperties(image, {
        complete: { configurable: true, value: true },
        naturalWidth: { configurable: true, value: 1 }
      });
      return image;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the selected shared agent owner badge", () => {
    const { container } = render(
      <AgentGUIVinylPlayer
        isPlaying={false}
        selectedAgent={{
          agentTargetId: "shared-agent:alice-codex",
          targetId: "shared-agent:alice-codex",
          provider: "codex",
          label: "Codex",
          iconUrl: "https://cdn.example.com/codex.png",
          badge: {
            iconUrl: "https://cdn.example.com/alice.png",
            label: "Alice"
          }
        }}
      />
    );

    expect(
      container.querySelector('[data-agent-owner-badge="true"] img')
    ).toHaveAttribute("src", "https://cdn.example.com/alice.png");
  });

  it("omits the owner badge for a local agent", () => {
    const { container } = render(
      <AgentGUIVinylPlayer
        isPlaying={false}
        selectedAgent={{
          agentTargetId: "local:codex",
          targetId: "local:codex",
          provider: "codex",
          label: "Codex",
          iconUrl: "https://cdn.example.com/codex.png"
        }}
      />
    );

    expect(
      container.querySelector('[data-agent-owner-badge="true"]')
    ).toBeNull();
  });
});
