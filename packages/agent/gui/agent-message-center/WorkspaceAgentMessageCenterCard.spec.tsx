import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSessionEngine,
  normalizeAgentActivitySession
} from "@tutti-os/agent-activity-core";
import { createTestEngineCommandPort } from "../shared/testing/createTestAgentSessionEngine";
import {
  messageCenterStackPreviewNodes,
  messageCenterStackPreviewText,
  WorkspaceAgentMessageCenterCard
} from "./WorkspaceAgentMessageCenterCard";
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentMessageCenterPresentation
} from "./workspaceAgentMessageCenterEngineModel";
import type { WorkspaceAgentMessageCenterItem } from "./workspaceAgentMessageCenterModel";

describe("messageCenterStackPreviewText", () => {
  it("renders agent-session mention links as plain text instead of raw markdown", () => {
    const text = messageCenterStackPreviewText(
      item({
        summary:
          "[@查看昨天提交的代码](mention://agent-session/e8399a9c-da59-485c-b0bf-68c745d36867?workspaceId=ws-1)"
      })
    );

    expect(text).not.toContain("mention://");
    expect(text).not.toContain("[@");
    expect(text).toContain("查看昨天提交的代码");
  });
});

describe("messageCenterStackPreviewNodes", () => {
  it("renders a session mention as a static chip with the session icon", () => {
    const { container } = render(
      <>
        {messageCenterStackPreviewNodes(
          item({
            summary:
              "[@查看昨天提交的代码](mention://agent-session/e8399a9c-da59-485c-b0bf-68c745d36867?workspaceId=ws-1)"
          })
        )}
      </>
    );

    const chip = container.querySelector('[data-agent-mention-kind="session"]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.textContent).toContain("查看昨天提交的代码");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("mention://");
  });

  it("renders workspace-issue and workspace-app mentions with their own icon", () => {
    const { container } = render(
      <>
        {messageCenterStackPreviewNodes(
          item({
            summary:
              "[@修一下这个 bug](mention://workspace-issue/issue-1?workspaceId=ws-1) [@AI 文档](mention://workspace-app/ai-doc?workspaceId=ws-1)"
          })
        )}
      </>
    );

    expect(
      container.querySelector('[data-agent-mention-kind="workspace-issue"]')
        ?.textContent
    ).toContain("修一下这个 bug");
    expect(
      container.querySelector('[data-agent-mention-kind="workspace-app"]')
        ?.textContent
    ).toContain("AI 文档");
  });
});

describe("WorkspaceAgentMessageCenterCard open session", () => {
  it("forwards the canonical Agent target with the Session identity", () => {
    const targetItem = item({ summary: "Ready" });
    targetItem.agentTargetId = "local:agent-b";
    const onOpenChat = vi.fn();

    render(
      <WorkspaceAgentMessageCenterCard
        item={targetItem}
        isSubmitting={false}
        onOpenChat={onOpenChat}
        onSubmitPrompt={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(onOpenChat).toHaveBeenCalledWith({
      agentSessionId: "codex-1",
      agentTargetId: "local:agent-b",
      provider: "codex"
    });
  });
});

describe("WorkspaceAgentMessageCenterCard hidden delegate sessions", () => {
  // The Issue task card path: a Tutti Mode delegate run session is hidden
  // (visible=false) from ambient surfaces, but the card allowlists its exact
  // target session, and the resulting item must render an answerable prompt.
  it("renders an answerable pending prompt for an allowlisted hidden delegate session", () => {
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: async () => ({})
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        normalizeAgentActivitySession({
          activeTurnId: "turn-1",
          latestTurnInteractions: [],
          workspaceId: "workspace-1",
          agentSessionId: "delegate-1",
          provider: "codex",
          cwd: "/workspace",
          title: "Delegated task",
          visible: false,
          activeTurn: {
            turnId: "turn-1",
            agentSessionId: "delegate-1",
            origin: "user_prompt",
            phase: "waiting",
            startedAtUnixMs: 10,
            updatedAtUnixMs: 21
          },
          pendingInteractions: [
            {
              requestId: "request-approval",
              agentSessionId: "delegate-1",
              turnId: "turn-1",
              kind: "approval",
              status: "pending",
              toolName: "Bash",
              input: {
                command: "pnpm test",
                options: [{ optionId: "allow", label: "Allow" }]
              },
              createdAtUnixMs: 21,
              updatedAtUnixMs: 21
            }
          ]
        })
      ]
    });

    const model = buildWorkspaceAgentMessageCenterModelFromEngine(
      selectWorkspaceAgentMessageCenterPresentation(engine.getSnapshot()),
      { workspaceId: "workspace-1", sessionMessagesById: {} },
      { includeHiddenSessionIds: ["delegate-1"] }
    );
    const delegateItem = model.items.find(
      (candidate) => candidate.agentSessionId === "delegate-1"
    );
    expect(delegateItem?.pendingPrompt).not.toBeNull();

    render(
      <WorkspaceAgentMessageCenterCard
        item={delegateItem!}
        isSubmitting={false}
        onOpenChat={() => undefined}
        onSubmitPrompt={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});

describe("WorkspaceAgentMessageCenterCard prompt presentation", () => {
  it("supports a full prompt without repeating the digest summary", () => {
    const pendingItem = item({ summary: "Allow the complete command?" });
    pendingItem.status = "waiting";
    pendingItem.pendingInteractionTarget = {
      agentSessionId: "codex-1",
      turnId: "turn-1",
      requestId: "request-1"
    };
    pendingItem.pendingPrompt = {
      kind: "approval",
      id: "approval:request-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Run command",
      toolName: "Bash",
      status: "pending",
      input: { command: "printf a && printf b" },
      options: [{ id: "allow", label: "Allow", kind: "allow" }],
      output: null,
      occurredAtUnixMs: 1
    };

    const { container } = render(
      <WorkspaceAgentMessageCenterCard
        item={pendingItem}
        isSubmitting={false}
        promptVariant="full"
        showSummaryWithPrompt={false}
        onOpenChat={() => undefined}
        onSubmitPrompt={() => undefined}
      />
    );

    expect(screen.getByText("printf a && printf b")).toBeTruthy();
    expect(screen.queryByText("Allow the complete command?")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(container.textContent).not.toContain("Allow the complete command?");
  });

  it("disables prompt controls separately from submitting and exposes the reason", () => {
    const pendingItem = item({ summary: "Allow the complete command?" });
    pendingItem.status = "waiting";
    pendingItem.pendingInteractionTarget = {
      agentSessionId: "codex-1",
      turnId: "turn-1",
      requestId: "request-1"
    };
    pendingItem.pendingPrompt = {
      kind: "approval",
      id: "approval:request-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Run command",
      toolName: "Bash",
      status: "pending",
      input: { command: "printf a" },
      options: [{ id: "allow", label: "Allow", kind: "allow" }],
      output: null,
      occurredAtUnixMs: 1
    };

    render(
      <WorkspaceAgentMessageCenterCard
        item={pendingItem}
        isSubmitting={false}
        isInteractionDisabled
        interactionDisabledReason="The shared Agent owner is offline"
        onOpenChat={() => undefined}
        onSubmitPrompt={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(
      screen.getByRole("group", {
        name: "The shared Agent owner is offline"
      })
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("does not focus or render an empty description when the disabled reason is absent", () => {
    const pendingItem = item({ summary: "Allow the complete command?" });
    pendingItem.status = "waiting";
    pendingItem.pendingInteractionTarget = {
      agentSessionId: "codex-1",
      turnId: "turn-1",
      requestId: "request-1"
    };
    pendingItem.pendingPrompt = {
      kind: "approval",
      id: "approval:request-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Run command",
      toolName: "Bash",
      status: "pending",
      input: { command: "printf a" },
      options: [{ id: "allow", label: "Allow", kind: "allow" }],
      output: null,
      occurredAtUnixMs: 1
    };

    const { container } = render(
      <WorkspaceAgentMessageCenterCard
        item={pendingItem}
        isSubmitting={false}
        isInteractionDisabled
        onOpenChat={() => undefined}
        onSubmitPrompt={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    const disabledGroup = container.querySelector<HTMLElement>(
      '[data-agent-interaction-disabled="true"]'
    );
    expect(disabledGroup).not.toBeNull();
    expect(disabledGroup).not.toHaveAttribute("aria-label");
    expect(disabledGroup).not.toHaveAttribute("tabindex");
  });

  it("keeps the summary when a leaving or read-only card cannot render its prompt", () => {
    const pendingItem = item({ summary: "Allow the complete command?" });
    pendingItem.status = "waiting";
    pendingItem.pendingPrompt = {
      kind: "approval",
      id: "approval:request-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Run command",
      toolName: "Bash",
      status: "pending",
      input: { command: "printf a && printf b" },
      options: [{ id: "allow", label: "Allow", kind: "allow" }],
      output: null,
      occurredAtUnixMs: 1
    };

    render(
      <WorkspaceAgentMessageCenterCard
        interactive={false}
        item={pendingItem}
        isSubmitting={false}
        promptVariant="full"
        showSummaryWithPrompt={false}
        onOpenChat={() => undefined}
        onSubmitPrompt={() => undefined}
      />
    );

    expect(screen.getByText("Allow the complete command?")).toBeTruthy();
    expect(screen.queryByText("printf a && printf b")).toBeNull();
  });
});

function item(overrides: { summary: string }): WorkspaceAgentMessageCenterItem {
  return {
    id: "message-center-codex-1",
    agentSessionId: "codex-1",
    provider: "codex",
    userId: null,
    title: "codex-1",
    identity: null,
    cwd: "/workspace",
    status: "working",
    digest: {
      primary: {
        kind: "progress",
        summary: overrides.summary,
        occurredAtUnixMs: 1
      }
    },
    lastAgentMessageSummary: "",
    lastAgentMessageAtUnixMs: 1,
    pendingInteractionTarget: null,
    pendingPrompt: null,
    needsAttentionKind: null,
    needsAttentionSummary: null,
    sortTimeUnixMs: 1
  };
}
