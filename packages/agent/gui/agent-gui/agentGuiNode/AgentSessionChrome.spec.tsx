import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertTriangle } from "lucide-react";
import { AgentChromeNotice, AgentSessionChrome } from "./AgentSessionChrome";
import { setAgentGuiI18nTestLocale } from "../../i18n/testUtils";
import type { AgentGUISessionChrome } from "./model/agentGuiNodeTypes";

describe("AgentSessionChrome", () => {
  beforeEach(() => {
    setAgentGuiI18nTestLocale("en");
  });

  it("wraps standalone danger notices in session chrome with icon color hooks", () => {
    render(
      <AgentChromeNotice
        tone="danger"
        role="alert"
        title="Current working directory missing"
        description="This conversation's working directory no longer exists"
        icon={<AlertTriangle aria-hidden="true" size={16} />}
      />
    );

    const notice = screen.getByRole("alert");
    expect(notice.className).toContain("agent-gui-chrome__card--danger");
    expect(notice.closest(".agent-gui-chrome__session-chrome")).not.toBeNull();
    expect(notice.querySelector(".agent-gui-chrome__icon")).not.toBeNull();
  });

  it("renders auth, approval, and recovery sections", () => {
    const onSubmitApprovalOption = vi.fn();
    const onRetryActivation = vi.fn();

    render(
      <AgentSessionChrome
        chrome={chromeState()}
        isRespondingApproval={false}
        onSubmitApprovalOption={onSubmitApprovalOption}
        onRetryActivation={onRetryActivation}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    expect(screen.queryByText("Authentication required")).toBeNull();
    expect(
      screen.getByText("Please sign in to continue this session.")
    ).toBeTruthy();
    expect(screen.getByText("Approval required")).toBeTruthy();
    expect(
      screen.getByText("Waiting for permission to run the command")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, proceed" }));
    expect(onSubmitApprovalOption).toHaveBeenCalledWith(
      "request-1",
      "allow_once"
    );

    const retryButtons = screen.getAllByRole("button", { name: "Retry" });
    expect(retryButtons).toHaveLength(2);
    for (const retryButton of retryButtons) {
      expect(retryButton.className).toContain("h-7");
    }
    fireEvent.click(retryButtons[0]!);
    fireEvent.click(retryButtons[1]!);
    expect(onRetryActivation).toHaveBeenCalledTimes(2);
  });

  it("renders auth failures with the compact warning chrome style", () => {
    render(
      <AgentSessionChrome
        chrome={{
          auth: {
            message: "Unauthorized request."
          },
          approval: null,
          recovery: null,
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    const warningChrome = screen
      .getByText("Unauthorized request.")
      .closest("section");
    expect(warningChrome).not.toBeNull();
    expect(warningChrome?.className).toContain(
      "agent-gui-chrome__card--warning"
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("runs the auth login action from auth failures", () => {
    const onAuthLogin = vi.fn();
    render(
      <AgentSessionChrome
        chrome={{
          auth: {
            message: "Please sign in to continue this session."
          },
          approval: null,
          recovery: null,
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onAuthLogin={onAuthLogin}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authLogin: "Sign in",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new conversation"
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onAuthLogin).toHaveBeenCalledTimes(1);
  });

  it("keeps long compact chrome messages collapsed until the user expands them", () => {
    const onRetryActivation = vi.fn();
    const message =
      "Codex ACP requires authentication in the runtime VM. Sync the Codex host credentials, then retry this session.";
    const restoreOverflowMock = mockElementOverflow({
      clientHeight: 20,
      clientWidth: 100,
      scrollHeight: 20,
      scrollWidth: 240
    });

    try {
      render(
        <AgentSessionChrome
          chrome={{
            auth: {
              message
            },
            approval: null,
            recovery: null,
            rawState: null
          }}
          isRespondingApproval={false}
          onSubmitApprovalOption={vi.fn()}
          onRetryActivation={onRetryActivation}
          onContinueInNewConversation={vi.fn()}
          labels={{
            approvalRequired: "Approval required",
            authRequired: "Authentication required",
            activatingSession: "Connecting session...",
            retryActivation: "Retry",
            continueInNewConversation: "Continue in new session"
          }}
        />
      );

      const warningChrome = screen.getByText(message).closest("section");
      expect(warningChrome).not.toBeNull();
      expect(warningChrome).toHaveAttribute("data-expandable", "true");
      expect(warningChrome).toHaveAttribute("data-expanded", "false");
      expect(screen.getByText(message)).toHaveAttribute("title", message);
      expect(
        screen.getByTestId("agent-session-chrome-auth-expand-cue")
      ).toBeTruthy();

      fireEvent.click(warningChrome!);
      expect(warningChrome).toHaveAttribute("data-expanded", "true");

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetryActivation).toHaveBeenCalledTimes(1);
      expect(warningChrome).toHaveAttribute("data-expanded", "true");
    } finally {
      restoreOverflowMock();
    }
  });

  it("does not expand compact recovery chrome when the message already fits", () => {
    const message = "Something went wrong. Please try again.";

    render(
      <AgentSessionChrome
        chrome={{
          auth: null,
          approval: null,
          recovery: {
            kind: "failed",
            message,
            canRetry: false
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    const recoveryChrome = screen.getByText(message).closest("section");
    expect(recoveryChrome).not.toBeNull();
    expect(recoveryChrome).toHaveAttribute("data-expandable", "false");
    expect(recoveryChrome).toHaveAttribute("data-expanded", "false");

    fireEvent.click(recoveryChrome!);

    expect(recoveryChrome).toHaveAttribute("data-expandable", "false");
    expect(recoveryChrome).toHaveAttribute("data-expanded", "false");
  });

  it("renders warning recovery chrome with danger color without alert behavior", () => {
    render(
      <AgentSessionChrome
        chrome={{
          auth: null,
          approval: null,
          recovery: {
            kind: "warning",
            message:
              "This model can only be used in a new session to preserve context.",
            canRetry: false
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    const recoveryChrome = screen
      .getByText(
        "This model can only be used in a new session to preserve context."
      )
      .closest("section");
    expect(recoveryChrome).not.toBeNull();
    expect(recoveryChrome?.className).toContain(
      "agent-gui-chrome__card--danger"
    );
    expect(recoveryChrome?.className).not.toContain(
      "agent-gui-chrome__card--warning"
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders a continue-in-new-conversation action for non-local recovery failures", () => {
    const onContinueInNewConversation = vi.fn();

    const { container } = render(
      <AgentSessionChrome
        chrome={{
          auth: null,
          approval: null,
          recovery: {
            kind: "failed",
            message: "This session is not recoverable on this machine.",
            canRetry: false,
            followupAction: "continue-in-new-conversation"
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={onContinueInNewConversation}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    const continueButton = screen.getByRole("button", {
      name: "Continue in new session"
    });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      container.querySelector(".agent-gui-chrome__message-slot")
    ).toBeTruthy();
    expect(
      continueButton.closest(".agent-gui-chrome__inline-actions")
    ).toBeTruthy();
    expect(continueButton.closest(".agent-gui-chrome__card")).toHaveAttribute(
      "data-has-inline-actions",
      "true"
    );
    expect(continueButton).toHaveAttribute("data-slot", "button");
    expect(continueButton).toHaveAttribute("data-variant", "ghost");
    expect(continueButton).toHaveAttribute("data-size", "sm");
    expect(continueButton.className).toContain(
      "agent-gui-chrome__danger-ghost-button"
    );

    fireEvent.click(continueButton);

    expect(onContinueInNewConversation).toHaveBeenCalledTimes(1);
  });

  it("uses the localized activating label for recovery chrome while reconnecting", () => {
    const { container } = render(
      <AgentSessionChrome
        chrome={{
          auth: null,
          approval: null,
          recovery: {
            kind: "activating",
            message: "Reconnecting to the live agent session…"
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    expect(screen.getByText("Connecting session")).toBeTruthy();
    expect(
      container.querySelector(".tsh-inline-loading-ellipsis")
    ).toBeTruthy();
    expect(
      container.querySelectorAll(".tsh-inline-loading-ellipsis span")
    ).toHaveLength(3);
    expect(
      screen.getByTestId("agent-session-chrome-connecting-icon")
    ).toBeTruthy();
    expect(screen.queryByText("Connecting session...")).toBeNull();
    expect(
      screen.queryByText("Reconnecting to the live agent session…")
    ).toBeNull();
  });

  it("replaces auth chrome with activating recovery chrome while connecting", () => {
    render(
      <AgentSessionChrome
        chrome={{
          auth: {
            message: "Please sign in to continue this session."
          },
          approval: null,
          recovery: {
            kind: "activating",
            message: "Reconnecting to the live agent session…"
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    expect(
      screen.queryByText("Please sign in to continue this session.")
    ).toBeNull();
    expect(screen.getByText("Connecting session")).toBeTruthy();
    expect(
      screen.queryByText("Reconnecting to the live agent session…")
    ).toBeNull();
  });

  it("hides the retry action when recovery chrome marks the session as non-retryable", () => {
    render(
      <AgentSessionChrome
        chrome={{
          auth: null,
          approval: null,
          recovery: {
            kind: "failed",
            message:
              "This session history is still available, but the session cannot be restored.",
            canRetry: false
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        labels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
      />
    );

    expect(
      screen.queryByRole("button", {
        name: "Retry"
      })
    ).toBeNull();
  });
});

function chromeState(): AgentGUISessionChrome {
  return {
    auth: {
      message: "Please sign in to continue this session."
    },
    approval: {
      kind: "approval",
      id: "approval:call-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Waiting for permission to run the command",
      status: "waiting_approval",
      toolName: "Bash",
      input: null,
      options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }],
      output: null,
      occurredAtUnixMs: 1
    },
    recovery: {
      kind: "failed",
      message: "Connection dropped while restoring the session."
    },
    rawState: null
  };
}

function mockElementOverflow(dimensions: {
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
}): () => void {
  const descriptors = {
    clientHeight: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    ),
    clientWidth: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth"
    ),
    scrollHeight: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight"
    ),
    scrollWidth: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollWidth"
    )
  };

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => dimensions.clientHeight
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => dimensions.clientWidth
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => dimensions.scrollHeight
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => dimensions.scrollWidth
  });

  return () => {
    for (const [property, descriptor] of Object.entries(descriptors)) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, property, descriptor);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
          property
        ];
      }
    }
  };
}
