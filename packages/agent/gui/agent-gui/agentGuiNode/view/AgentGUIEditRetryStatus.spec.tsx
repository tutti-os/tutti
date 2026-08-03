import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGUIEditRetryStatus } from "./AgentGUIEditRetryStatus";

describe("AgentGUIEditRetryStatus", () => {
  it("renders generic feedback without raw diagnostics and only Host actions", () => {
    const secret = "provider secret error";
    render(
      <AgentGUIEditRetryStatus
        presentation={
          {
            actionFeedback: "request_failed",
            actionPending: false,
            attempt: 2,
            automatic: false,
            availableActions: ["reconcile"],
            editableTurnId: null,
            nextAttemptAtUnixMs: 1_700_000_000_000,
            operationId: "operation-1",
            operationVersion: 4,
            reasonCode: "provider_outcome_unknown",
            state: "action_required",
            rawError: secret,
          } as never
        }
        onRecover={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Recovery request failed. Try again.",
    );
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Abandon recovery" }),
    ).not.toBeInTheDocument();
  });

  it("disables every available recovery action while an action is pending", () => {
    const onRecover = vi.fn(async () => undefined);
    render(
      <AgentGUIEditRetryStatus
        presentation={{
          actionFeedback: "refreshing",
          actionPending: true,
          attempt: null,
          automatic: false,
          availableActions: ["reconcile", "retry_replacement", "abandon"],
          editableTurnId: null,
          nextAttemptAtUnixMs: null,
          operationId: "operation-1",
          operationVersion: 4,
          reasonCode: "recovery_required",
          state: "action_required",
        }}
        onRecover={onRecover}
      />,
    );

    for (const label of ["Reconcile", "Retry message", "Abandon recovery"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onRecover).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "State changed. Refreshing…",
    );
  });

  it.each([
    ["retry_budget_exhausted", "Automatic recovery has reached its safety limit"],
    ["local_state_inconsistent", "This conversation needs a local recovery check"],
  ] as const)("renders %s safely and only Host actions", (reasonCode, message) => {
    const secret = "sqlite provider secret";
    render(<AgentGUIEditRetryStatus presentation={{ actionFeedback: null, actionPending: false, attempt: null, automatic: false, availableActions: ["reconcile"], editableTurnId: null, nextAttemptAtUnixMs: null, operationId: "operation-1", operationVersion: 1, reasonCode, state: "action_required", rawDiagnostic: secret } as never} onRecover={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abandon recovery" })).not.toBeInTheDocument();
  });
});
