import { fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMessageBlock } from "./AgentMessageBlock";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import { AgentEnvPanelActionProvider } from "../../agentEnv";
import { AgentVisibleErrorPresentationProvider } from "../../visibleError/AgentVisibleErrorPresentationContext";
import type {
  AgentVisibleErrorOverrides,
  AgentVisibleErrorPresentationScope
} from "../../agentEnv/agentErrorPresentation";

function buildRow(
  visibleError: AgentMessageContentVM["visibleError"],
  body = ""
): AgentMessageRowVM {
  return {
    kind: "message",
    id: "row-1",
    turnId: "turn-1",
    speaker: "assistant",
    occurredAtUnixMs: 0,
    thinking: [],
    messages: [
      {
        kind: "message-content",
        id: "msg-1",
        turnId: "turn-1",
        body,
        presentationKind: "content",
        occurredAtUnixMs: 0,
        visibleError
      }
    ]
  };
}

function renderBlock(
  row: AgentMessageRowVM,
  provider?: string,
  onLinkAction?: ComponentProps<typeof AgentMessageBlock>["onLinkAction"],
  visibleErrorPresentationOverrides?: AgentVisibleErrorOverrides | null,
  visibleErrorPresentationScope?: AgentVisibleErrorPresentationScope
) {
  const onOpenAgentEnvPanel = vi.fn();
  return {
    ...render(
      <AgentEnvPanelActionProvider openPanel={onOpenAgentEnvPanel}>
        <AgentVisibleErrorPresentationProvider
          scope={visibleErrorPresentationScope}
          value={visibleErrorPresentationOverrides}
        >
          <AgentMessageBlock
            workspaceRoot={null}
            basePath="/"
            row={row}
            provider={provider}
            onLinkAction={onLinkAction}
            thinkingLabel="thinking"
          />
        </AgentVisibleErrorPresentationProvider>
      </AgentEnvPanelActionProvider>
    ),
    onOpenAgentEnvPanel
  };
}

function buildFailedTextRow(body: string): AgentMessageRowVM {
  return {
    kind: "message",
    id: "row-1",
    turnId: "turn-1",
    speaker: "assistant",
    occurredAtUnixMs: 0,
    thinking: [],
    messages: [
      {
        kind: "message-content",
        id: "msg-1",
        turnId: "turn-1",
        body,
        presentationKind: "content",
        statusKind: "failed",
        occurredAtUnixMs: 0,
        visibleError: null
      }
    ]
  };
}

function buildCompletedTextRow(body: string): AgentMessageRowVM {
  const row = buildFailedTextRow(body);
  const message = row.messages[0];
  if (message) {
    message.statusKind = "completed";
  }
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentVisibleErrorMessage", () => {
  it("routes an env-fixable run failure to the matching wizard step", () => {
    const { getByText, getAllByRole, onOpenAgentEnvPanel } = renderBlock(
      buildRow(
        {
          // The real code a missing CLI surfaces as at run time.
          code: "cli_not_found",
          phase: "start",
          provider: "codex",
          detail: "spawn codex ENOENT",
          retryable: false
        },
        // The raw body must NOT be surfaced as the card title.
        "codex exited: spawn codex ENOENT"
      )
    );

    expect(
      getByText(
        "Codex CLI wasn't found, so it couldn't run. Set it up to continue."
      )
    ).toBeTruthy();
    expect(() => getByText("codex exited: spawn codex ENOENT")).toThrow();

    const action = getAllByRole("button").find(
      (button) => button.textContent === "Connect"
    );
    expect(action).toBeTruthy();

    fireEvent.click(action as HTMLButtonElement);
    expect(onOpenAgentEnvPanel).toHaveBeenCalledWith({
      provider: "codex",
      focus: "install"
    });
  });

  it("offers a self-detect escape hatch for ambiguous hard failures", () => {
    const { getAllByRole, queryByText, onOpenAgentEnvPanel } = renderBlock(
      buildRow(
        {
          code: "process_exited",
          phase: "turn",
          provider: "codex",
          detail: "exited with code 1",
          retryable: false
        },
        "provider process exited with secret diagnostics"
      )
    );

    expect(
      queryByText("provider process exited with secret diagnostics")
    ).toBeNull();
    const action = getAllByRole("button").find(
      (button) => button.textContent === "Open setup"
    );
    expect(action).toBeTruthy();
    fireEvent.click(action as HTMLButtonElement);
    expect(onOpenAgentEnvPanel).toHaveBeenCalledWith({
      provider: "codex",
      focus: "detect"
    });
  });

  it("keeps the remediation action when the provider is unavailable", () => {
    const { getAllByRole, onOpenAgentEnvPanel } = renderBlock(
      buildRow({
        code: "cli_not_found",
        phase: "start",
        provider: null,
        detail: "spawn failed",
        retryable: false
      })
    );

    const action = getAllByRole("button").find(
      (button) => button.textContent === "Connect"
    );
    expect(action).toBeTruthy();
    fireEvent.click(action as HTMLButtonElement);
    expect(onOpenAgentEnvPanel).toHaveBeenCalledWith({
      provider: null,
      focus: "install"
    });
  });

  it("does not render raw provider payloads in the product card", () => {
    const { queryByText } = renderBlock(
      buildRow({
        code: "cli_not_found",
        phase: "start",
        provider: "codex",
        detail: "spawn codex ENOENT",
        retryable: false
      })
    );

    expect(queryByText("spawn codex ENOENT")).toBeNull();
    expect(queryByText("Raw error")).toBeNull();
  });

  it("reveals shared-agent raw details only after the disclosure is opened", () => {
    const { getByRole, getByText } = renderBlock(
      buildRow({
        code: "provider_error",
        phase: "turn",
        provider: "claude-code",
        detail: "provider response: account is not authenticated",
        detailAvailable: true,
        retryable: false
      })
    );

    const disclosure = getByRole("button", { name: "Raw error" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      getByText("provider response: account is not authenticated")
    ).toBeTruthy();
  });

  it("shows a sanitized provider error directly without rewriting it", () => {
    const { getByText, queryByRole } = renderBlock(
      buildRow({
        code: "provider_unavailable",
        phase: "turn",
        provider: "claude-code",
        origin: "provider",
        detail: "relay returned HTTP 503: upstream overloaded",
        detailAvailable: true,
        retryable: true
      })
    );

    expect(
      getByText("relay returned HTTP 503: upstream overloaded")
    ).toBeTruthy();
    expect(queryByRole("button", { name: "Raw error" })).toBeNull();
  });

  it("does not offer provider login for a relay-scoped 401", () => {
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "provider_error",
        phase: "turn",
        provider: "claude-code",
        origin: "provider",
        detail: "relay rejected request: HTTP 401",
        retryable: false
      })
    );

    expect(getByText("relay rejected request: HTTP 401")).toBeTruthy();
    expect(queryByText("Sign in")).toBeNull();
  });

  it("shows accurate copy but NO wizard CTA for transient/server-side failures", () => {
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "request_timed_out",
        phase: "turn",
        provider: "codex",
        detail: null,
        retryable: true
      })
    );

    expect(getByText("Codex request timed out")).toBeTruthy();
    // No env-panel call-to-action — the wizard cannot fix a transient timeout.
    expect(queryByText("Set up")).toBeNull();
    expect(queryByText("Open setup")).toBeNull();
    expect(queryByText("Sign in")).toBeNull();
  });

  it("fails closed without Host Commerce context", () => {
    const onLinkAction = vi.fn();
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "insufficient_credits",
        phase: "turn",
        provider: "tutti-agent",
        detail:
          "unexpected status 402 Payment Required: pre-deduct credits failed",
        retryable: false
      }),
      "tutti-agent",
      onLinkAction
    );

    expect(
      getByText("Tutti has insufficient credits or account balance to continue")
    ).toBeTruthy();
    expect(queryByText("Open setup")).toBeNull();
    expect(queryByText("View credit options")).toBeNull();
    expect(onLinkAction).not.toHaveBeenCalled();
  });

  it("renders a generic Host error override without exposing Commerce state", () => {
    const onLinkAction = vi.fn();
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "insufficient_credits",
        phase: "turn",
        provider: "tutti-agent",
        detail: "private provider billing payload",
        retryable: false
      }),
      "tutti-agent",
      onLinkAction,
      {
        insufficient_credits: {
          message: "Recharge credits to continue",
          providers: ["tutti-agent"],
          action: {
            label: "Recharge credits",
            url: "https://example.test/credits"
          }
        }
      }
    );

    expect(getByText("Recharge credits to continue")).toBeTruthy();
    expect(queryByText("private provider billing payload")).toBeNull();
    fireEvent.click(getByText("Recharge credits"));
    expect(onLinkAction).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "agent-external-action",
        type: "open-url",
        url: "https://example.test/credits"
      })
    );
  });

  it("shows sharer guidance instead of local authentication recovery", () => {
    const { getByRole, getByText, queryByText, onOpenAgentEnvPanel } =
      renderBlock(
        buildRow({
          code: "auth_required",
          phase: "turn",
          provider: "codex",
          detail: "owner diagnostic: local Codex login is required",
          detailAvailable: true,
          retryable: false
        }),
        "codex",
        undefined,
        undefined,
        "shared_caller"
      );

    expect(
      getByText("Codex needs authentication or configuration")
    ).toBeTruthy();
    expect(
      getByText("Contact the person who shared this Agent, then try again.")
    ).toBeTruthy();
    expect(queryByText("Sign in")).toBeNull();
    expect(onOpenAgentEnvPanel).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Raw error" }));
    expect(
      getByText("owner diagnostic: local Codex login is required")
    ).toBeTruthy();
  });

  it("does not expose a caller Commerce action for an Owner credit failure", () => {
    const onLinkAction = vi.fn();
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "insufficient_credits",
        phase: "turn",
        provider: "tutti-agent",
        detail: "owner balance is insufficient",
        retryable: false
      }),
      "tutti-agent",
      onLinkAction,
      {
        insufficient_credits: {
          message: "Recharge credits to continue",
          providers: ["tutti-agent"],
          action: {
            label: "Recharge credits",
            url: "https://example.test/credits"
          }
        }
      },
      "shared_caller"
    );

    expect(
      getByText("Tutti has insufficient credits or account balance to continue")
    ).toBeTruthy();
    expect(
      getByText("Contact the person who shared this Agent, then try again.")
    ).toBeTruthy();
    expect(queryByText("Recharge credits to continue")).toBeNull();
    expect(queryByText("Recharge credits")).toBeNull();
    expect(onLinkAction).not.toHaveBeenCalled();
  });

  it("preserves neutral transient copy while suppressing local setup actions", () => {
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "network_error",
        phase: "turn",
        provider: "codex",
        detail: null,
        retryable: true
      }),
      "codex",
      undefined,
      undefined,
      "shared_caller"
    );

    expect(
      getByText("Codex couldn't reach the network to complete this request.")
    ).toBeTruthy();
    expect(
      queryByText("Contact the person who shared this Agent, then try again.")
    ).toBeNull();
    expect(queryByText("Check network")).toBeNull();
  });

  it("does not apply a Tutti Commerce override to another provider", () => {
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "insufficient_credits",
        phase: "turn",
        provider: "codex",
        detail: "insufficient credits",
        retryable: false
      }),
      "codex",
      vi.fn(),
      {
        insufficient_credits: {
          message: "Recharge Tutti credits",
          providers: ["tutti-agent"],
          action: {
            label: "Recharge",
            url: "https://example.test/credits"
          }
        }
      }
    );

    expect(
      getByText("Codex has insufficient credits or account balance to continue")
    ).toBeTruthy();
    expect(queryByText("Recharge Tutti credits")).toBeNull();
    expect(queryByText("Recharge")).toBeNull();
  });

  it("shows Cursor plan-limit cards as a calm warning status, not a danger alert", () => {
    const { getByText, getByRole, queryByText } = renderBlock(
      buildRow({
        code: "quota_or_rate_limit",
        phase: "turn",
        provider: "cursor",
        detail: "Upgrade your plan to continue",
        retryable: false
      })
    );

    expect(
      getByText(
        "Cursor request failed because a quota or rate limit was reached"
      )
    ).toBeTruthy();
    expect(getByRole("status")).toBeTruthy();
    expect(queryByText("Open setup")).toBeNull();
    expect(queryByText("Sign in")).toBeNull();
  });

  it("recovers a failed plain auth message into the wizard card (Claude 401)", () => {
    const { getByText, getAllByRole, onOpenAgentEnvPanel } = renderBlock(
      buildFailedTextRow(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials"
      ),
      "claude-code"
    );
    // Rendered as the structured card (not dead red text), routing to the wizard.
    expect(
      getByText("Claude Code needs authentication or configuration")
    ).toBeTruthy();
    const action = getAllByRole("button").find(
      (button) => button.textContent === "Sign in"
    );
    expect(action).toBeTruthy();
    fireEvent.click(action as HTMLButtonElement);
    expect(onOpenAgentEnvPanel).toHaveBeenCalledWith({
      provider: "claude-code",
      focus: "auth"
    });
  });

  it("recovers a failed Claude 522 response into a timeout card", () => {
    const rawError =
      'API Error: 522 {"title":"Error 522: Connection timed out"}';
    const { getByText, queryByText } = renderBlock(
      buildFailedTextRow(rawError),
      "claude-code"
    );

    expect(getByText("Claude Code request timed out")).toBeTruthy();
    expect(queryByText(rawError)).toBeNull();
  });

  it("recovers Claude SDK's completed login notice into the wizard card", () => {
    const { getByText, queryByText } = renderBlock(
      buildCompletedTextRow("Not logged in · Please run /login"),
      "claude-code"
    );

    expect(
      getByText("Claude Code needs authentication or configuration")
    ).toBeTruthy();
    expect(getByText("Sign in")).toBeTruthy();
    expect(queryByText("Not logged in · Please run /login")).toBeNull();
  });

  it("leaves a non-env failed message as plain text (no card)", () => {
    const { queryByText } = renderBlock(
      buildFailedTextRow("rate limit exceeded, try again later"),
      "codex"
    );
    expect(queryByText("Sign in")).toBeNull();
  });
});
