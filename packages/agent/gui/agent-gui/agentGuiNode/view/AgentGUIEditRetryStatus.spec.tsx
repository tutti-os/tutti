import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGUIEditRetryStatus } from "./AgentGUIEditRetryStatus";

describe("AgentGUIEditRetryStatus", () => {
  it("lets the normal timeline own non-terminal recovery feedback", () => {
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
            rawError: secret
          } as never
        }
        onRecover={vi.fn(async () => undefined)}
      />
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps pending recovery out of the edit retry UI", () => {
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
          state: "action_required"
        }}
        onRecover={onRecover}
      />
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onRecover).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    [
      "retry_budget_exhausted",
      "Automatic recovery has reached its safety limit"
    ],
    [
      "local_state_inconsistent",
      "This conversation needs a local recovery check"
    ],
    [
      "provider_unsupported",
      "This provider does not support editing and retrying"
    ],
    ["provider_rejected", "The provider rejected the edit retry"]
  ] as const)(
    "renders %s as a generic final failure",
    (reasonCode, _legacyMessage) => {
      const secret = "sqlite provider secret";
      render(
        <AgentGUIEditRetryStatus
          presentation={
            {
              actionFeedback: null,
              actionPending: false,
              attempt: null,
              automatic: false,
              availableActions: ["reconcile"],
              editableTurnId: null,
              nextAttemptAtUnixMs: null,
              operationId: "operation-1",
              operationVersion: 1,
              reasonCode,
              state: "action_required",
              rawDiagnostic: secret
            } as never
          }
          onRecover={vi.fn(async () => undefined)}
        />
      );
      expect(screen.getByRole("alert")).toHaveTextContent("Edit retry failed");
      expect(screen.queryByText(secret)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Reconcile" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Abandon recovery" })
      ).not.toBeInTheDocument();
    }
  );

  it("does not show a card after successful recovery", () => {
    render(
      <AgentGUIEditRetryStatus
        presentation={{
          actionFeedback: null,
          actionPending: false,
          attempt: null,
          automatic: true,
          availableActions: [],
          editableTurnId: null,
          nextAttemptAtUnixMs: null,
          operationId: "operation-1",
          operationVersion: 1,
          reasonCode: null,
          state: "terminal"
        }}
        onRecover={vi.fn(async () => undefined)}
      />
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
