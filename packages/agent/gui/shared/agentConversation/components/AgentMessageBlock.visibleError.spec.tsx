import { fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMessageBlock } from "./AgentMessageBlock";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import { AgentEnvPanelActionProvider } from "../../agentEnv";

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
        occurredAtUnixMs: 0,
        visibleError
      }
    ]
  };
}

function renderBlock(
  row: AgentMessageRowVM,
  provider?: string,
  onLinkAction?: ComponentProps<typeof AgentMessageBlock>["onLinkAction"]
) {
  const onOpenAgentEnvPanel = vi.fn();
  return {
    ...render(
      <AgentEnvPanelActionProvider openPanel={onOpenAgentEnvPanel}>
        <AgentMessageBlock
          workspaceRoot={null}
          basePath="/"
          row={row}
          provider={provider}
          onLinkAction={onLinkAction}
          thinkingLabel="thinking"
        />
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
        statusKind: "failed",
        occurredAtUnixMs: 0,
        visibleError: null
      }
    ]
  };
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
    const { getAllByRole, onOpenAgentEnvPanel } = renderBlock(
      buildRow({
        code: "process_exited",
        phase: "turn",
        provider: "codex",
        detail: "exited with code 1",
        retryable: false
      })
    );

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

  it("tucks the raw payload behind a single 'Raw error' disclosure", () => {
    const { getByText, queryByText } = renderBlock(
      buildRow({
        code: "cli_not_found",
        phase: "start",
        provider: "codex",
        detail: "spawn codex ENOENT",
        retryable: false
      })
    );

    expect(queryByText("spawn codex ENOENT")).toBeNull();
    fireEvent.click(getByText("Raw error"));
    expect(getByText("spawn codex ENOENT")).toBeTruthy();
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

  it("shows an insufficient-credits card that opens Tutti subscription plans", () => {
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
      getByText("Your Tutti credits are insufficient to continue this request.")
    ).toBeTruthy();
    expect(queryByText("Open setup")).toBeNull();
    fireEvent.click(getByText("View plans"));
    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-url",
      url: "https://tutti.sh/profile/plan",
      source: "agent-markdown"
    });
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

    expect(getByText("Upgrade your plan to continue")).toBeTruthy();
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

  it("leaves a non-env failed message as plain text (no card)", () => {
    const { queryByText } = renderBlock(
      buildFailedTextRow("rate limit exceeded, try again later"),
      "codex"
    );
    expect(queryByText("Sign in")).toBeNull();
  });
});
