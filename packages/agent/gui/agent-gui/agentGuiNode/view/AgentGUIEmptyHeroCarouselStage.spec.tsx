import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGUIAgentAvatarPresentation } from "../model/agentGuiAgentAvatarPresentation";

vi.mock("../AgentGUIHeroAgentCarousel", () => ({
  AgentGUIHeroAgentCarousel: () => <div data-testid="carousel" />
}));

import { AgentGUIEmptyHeroCarouselStage } from "./AgentGUIEmptyHeroCarouselStage";

const items: readonly AgentGUIAgentAvatarPresentation[] = [
  {
    agentTargetId: "codex",
    iconUrl: "codex.png",
    label: "Codex",
    provider: "codex",
    targetId: "codex"
  },
  {
    agentTargetId: "claude",
    iconUrl: "claude.png",
    label: "Claude",
    provider: "claude",
    targetId: "claude"
  }
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentGUIEmptyHeroCarouselStage", () => {
  it("does not measure a fully occluded carousel", () => {
    const getBoundingClientRect = vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect"
    );

    render(
      <AgentGUIEmptyHeroCarouselStage
        isActive={false}
        isVisible={false}
        items={items}
        providerSelectLabel="Select provider"
      >
        <div data-carousel-placeholder />
      </AgentGUIEmptyHeroCarouselStage>
    );

    expect(getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("measures live carousel alignment", () => {
    const { container } = render(
      <AgentGUIEmptyHeroCarouselStage
        isActive={false}
        isVisible
        items={items}
        providerSelectLabel="Select provider"
      >
        <div data-carousel-placeholder />
      </AgentGUIEmptyHeroCarouselStage>
    );

    const layer = container.querySelector<HTMLElement>(
      ".agent-gui-node__empty-hero-carousel-layer"
    );
    expect(
      layer?.style.getPropertyValue("--agent-gui-hero-carousel-slot-top")
    ).toBe("0px");
    expect(
      layer?.style.getPropertyValue("--agent-gui-hero-carousel-slot-left")
    ).toBe("0px");
  });

  it("defers alignment measurement after the selected provider updates", () => {
    const requestFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    const getBoundingClientRect = vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect"
    );
    const view = render(
      <AgentGUIEmptyHeroCarouselStage
        activeAgentTargetId="codex"
        isActive
        isVisible
        items={items}
        providerSelectLabel="Select provider"
      >
        <div data-carousel-placeholder />
      </AgentGUIEmptyHeroCarouselStage>
    );
    getBoundingClientRect.mockClear();

    view.rerender(
      <AgentGUIEmptyHeroCarouselStage
        activeAgentTargetId="claude"
        isActive
        isVisible
        items={items}
        providerSelectLabel="Select provider"
      >
        <div data-carousel-placeholder />
      </AgentGUIEmptyHeroCarouselStage>
    );

    expect(getBoundingClientRect).not.toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });
});
