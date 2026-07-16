import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { useComposerAutomationRuleOverride } from "./useComposerAutomationRuleOverride";

function Harness({
  agentSessionId,
  runtime
}: {
  agentSessionId: string | null;
  runtime: AgentActivityRuntime;
}) {
  const result = useComposerAutomationRuleOverride({
    agentSessionId,
    disabled: false,
    runtime,
    workspaceId: "workspace-1"
  });
  return (
    <>
      {result.controls}
      <output data-testid="automation-override">
        {JSON.stringify(result.override)}
      </output>
    </>
  );
}

function runtimeWithAutomation(
  overrides: Partial<AgentActivityRuntime> = {}
): AgentActivityRuntime {
  return {
    listAutomationRules: vi.fn().mockResolvedValue({
      rules: [
        {
          id: "rule-review",
          name: "Review completed work",
          enabled: true,
          trigger: "on_task_complete",
          action: "consult"
        }
      ]
    }),
    setAutomationRuleOverride: vi.fn().mockImplementation(async (input) => ({
      agentSessionId: input.agentSessionId,
      workspaceId: input.workspaceId,
      disabled: input.disabled,
      ruleIds: input.ruleIds
    })),
    ...overrides
  } as AgentActivityRuntime;
}

describe("session AutomationRule composer override", () => {
  it("stages an off override for a new Session before submission", async () => {
    const runtime = runtimeWithAutomation();
    render(<Harness agentSessionId={null} runtime={runtime} />);

    await screen.findByText("Automation");
    fireEvent.click(screen.getByLabelText("Automation"));
    fireEvent.click(
      screen.getByRole("option", { name: "Off for this session" })
    );

    expect(screen.getByTestId("automation-override")).toHaveTextContent(
      '{"disabled":true,"ruleIds":[]}'
    );
    expect(runtime.setAutomationRuleOverride).not.toHaveBeenCalled();
  });

  it("persists a selected rule immediately for an active Session", async () => {
    const setOverride = vi.fn().mockImplementation(async (input) => ({
      agentSessionId: input.agentSessionId,
      workspaceId: input.workspaceId,
      disabled: input.disabled,
      ruleIds: input.ruleIds
    }));
    const runtime = runtimeWithAutomation({
      getAutomationRuleOverride: vi.fn().mockResolvedValue({
        agentSessionId: "session-1",
        workspaceId: "workspace-1",
        disabled: false,
        ruleIds: []
      }),
      setAutomationRuleOverride: setOverride
    });
    render(<Harness agentSessionId="session-1" runtime={runtime} />);

    await screen.findByText("Automation");
    fireEvent.click(screen.getByLabelText("Automation"));
    fireEvent.click(
      screen.getByRole("option", { name: "Review completed work" })
    );

    await waitFor(() =>
      expect(setOverride).toHaveBeenCalledWith({
        agentSessionId: "session-1",
        workspaceId: "workspace-1",
        disabled: false,
        ruleIds: ["rule-review"]
      })
    );
    expect(screen.getByTestId("automation-override")).toHaveTextContent(
      '{"disabled":false,"ruleIds":["rule-review"]}'
    );
  });
});
