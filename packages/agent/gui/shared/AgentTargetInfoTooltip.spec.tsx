import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGUIAgentTargetInfoRenderer } from "../types";
import { AgentTargetInfoTooltip } from "./AgentTargetInfoTooltip";

afterEach(cleanup);

describe("AgentTargetInfoTooltip", () => {
  it("lazily uses the target label when the Host renderer returns null", async () => {
    const renderer: AgentGUIAgentTargetInfoRenderer = vi.fn(() => null);

    render(
      <TooltipProvider delayDuration={0}>
        <AgentTargetInfoTooltip
          fallbackLabel="Shared Codex"
          renderer={renderer}
          surface="provider-rail"
          target={{
            agentTargetId: "agent:shared",
            label: "Shared Codex",
            provider: "codex",
            ref: { kind: "shared", provider: "codex" },
            targetId: "shared:codex"
          }}
        >
          <button type="button">Agent information</button>
        </AgentTargetInfoTooltip>
      </TooltipProvider>
    );

    expect(renderer).not.toHaveBeenCalled();

    fireEvent.pointerMove(
      screen.getByRole("button", { name: "Agent information" }),
      { pointerType: "mouse" }
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Shared Codex"
    );
    expect(renderer).toHaveBeenCalledWith({
      surface: "provider-rail",
      target: expect.objectContaining({ agentTargetId: "agent:shared" })
    });
  });
});
