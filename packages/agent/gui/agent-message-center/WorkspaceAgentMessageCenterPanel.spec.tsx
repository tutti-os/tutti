import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  messageCenterFiltersStorageKey,
  writeMessageCenterFilterPreferences
} from "./messageCenterFilterPreferences";
import {
  WorkspaceAgentMessageCenterCard,
  WorkspaceAgentMessageCenterPanel
} from "./WorkspaceAgentMessageCenterPanel";
import type {
  WorkspaceAgentMessageCenterItem,
  WorkspaceAgentMessageCenterModel
} from "./workspaceAgentMessageCenterModel";

const baseItem: WorkspaceAgentMessageCenterItem = {
  id: "message-center-session-1",
  agentSessionId: "session-1",
  provider: "codex",
  userId: null,
  title: "整理本地文件夹",
  identity: null,
  cwd: "/workspace",
  status: "completed",
  digest: {
    primary: {
      kind: "outcome",
      summary: "已完成。",
      occurredAtUnixMs: 1
    }
  },
  lastAgentMessageSummary: "已完成。",
  lastAgentMessageAtUnixMs: 1,
  pendingPrompt: null,
  needsAttentionKind: null,
  needsAttentionSummary: null,
  sortTimeUnixMs: 1
};

function createMessageCenterItem(
  overrides: Partial<WorkspaceAgentMessageCenterItem> & {
    agentSessionId: string;
    title: string;
  }
): WorkspaceAgentMessageCenterItem {
  const item = {
    ...baseItem,
    id: `message-center-${overrides.agentSessionId}`,
    lastAgentMessageSummary: `${overrides.title} summary`,
    sortTimeUnixMs: 1,
    ...overrides
  };
  return withTestDigest(item, overrides.digest);
}

function createTestCardItem(
  overrides: Partial<WorkspaceAgentMessageCenterItem> = {}
): WorkspaceAgentMessageCenterItem {
  const item = {
    ...baseItem,
    ...overrides
  };
  return withTestDigest(item, overrides.digest);
}

function withTestDigest(
  item: WorkspaceAgentMessageCenterItem,
  digest: WorkspaceAgentMessageCenterItem["digest"] | undefined
): WorkspaceAgentMessageCenterItem {
  return {
    ...item,
    digest: digest ?? createTestDigest(item)
  };
}

function createTestDigest(
  item: WorkspaceAgentMessageCenterItem
): WorkspaceAgentMessageCenterItem["digest"] {
  const summary =
    item.lastAgentMessageSummary.trim() ||
    item.needsAttentionSummary?.trim() ||
    item.pendingPrompt?.title.trim() ||
    item.title;
  return {
    primary: {
      kind: testDigestKind(item),
      summary,
      occurredAtUnixMs: item.lastAgentMessageAtUnixMs ?? null
    }
  };
}

function testDigestKind(
  item: WorkspaceAgentMessageCenterItem
): WorkspaceAgentMessageCenterItem["digest"]["primary"]["kind"] {
  if (item.pendingPrompt || item.needsAttentionKind) {
    return "input-required";
  }
  if (item.status === "failed") {
    return "error";
  }
  if (
    item.status === "completed" ||
    item.status === "canceled" ||
    item.status === "idle"
  ) {
    return "outcome";
  }
  if (item.status === "working") {
    return "progress";
  }
  return "summary";
}

function createWaitingItem(
  overrides: Partial<WorkspaceAgentMessageCenterItem> & {
    agentSessionId: string;
    title: string;
  }
): WorkspaceAgentMessageCenterItem {
  return createMessageCenterItem({
    status: "waiting",
    pendingPrompt: {
      kind: "approval",
      id: `approval:${overrides.agentSessionId}`,
      turnId: "turn-1",
      requestId: `request-${overrides.agentSessionId}`,
      callId: `request-${overrides.agentSessionId}`,
      title: "Approval",
      status: "waiting_approval",
      toolName: "Bash",
      input: null,
      options: [],
      output: null,
      occurredAtUnixMs: 1
    },
    ...overrides
  });
}

function createMessageCenterModel(
  items: WorkspaceAgentMessageCenterItem[]
): WorkspaceAgentMessageCenterModel {
  return {
    waitingCount: items.filter((item) => item.pendingPrompt !== null).length,
    items,
    counts: {
      all: items.length,
      working: items.filter(
        (item) => item.status === "working" && item.pendingPrompt === null
      ).length,
      waiting: items.filter((item) => item.pendingPrompt !== null).length,
      completed: items.filter((item) =>
        ["canceled", "completed", "idle"].includes(item.status)
      ).length,
      failed: items.filter((item) => item.status === "failed").length
    }
  };
}

function openViewOptions(): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: "View options" }), {
    button: 0,
    ctrlKey: false
  });
}

describe("WorkspaceAgentMessageCenterCard", () => {
  it("reports the provider and semantic action when submitting a notification prompt", () => {
    const onNotificationActioned = vi.fn();
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={{
          waitingCount: 1,
          items: [
            createTestCardItem({
              status: "waiting",
              pendingPrompt: {
                kind: "approval",
                id: "approval:request-1",
                turnId: "turn-1",
                requestId: "request-1",
                callId: "request-1",
                title: "Approval",
                status: "waiting_approval",
                toolName: "Bash",
                input: null,
                options: [
                  {
                    id: "allow_once",
                    label: "Yes",
                    kind: "allow_once",
                    description: ""
                  }
                ],
                output: null,
                occurredAtUnixMs: 1
              }
            })
          ],
          counts: {
            all: 1,
            working: 0,
            waiting: 1,
            completed: 0,
            failed: 0
          }
        }}
        onClose={vi.fn()}
        onNotificationActioned={onNotificationActioned}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Yes, proceed" }));

    expect(onNotificationActioned).toHaveBeenCalledWith({
      action: "accept",
      provider: "codex"
    });
  });

  it("hides approval shortcut hints inside message center prompt cards", () => {
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            status: "waiting",
            pendingPrompt: {
              kind: "approval",
              id: "approval:request-1",
              turnId: "turn-1",
              requestId: "request-1",
              callId: "request-1",
              title: "Approval",
              status: "waiting_approval",
              toolName: "Bash",
              input: null,
              options: [
                {
                  id: "allow_once",
                  label: "Yes",
                  kind: "allow_once",
                  description: ""
                },
                {
                  id: "reject",
                  label: "No, and tell Codex what to do differently",
                  kind: "reject_once",
                  description: ""
                }
              ],
              output: null,
              occurredAtUnixMs: 1
            }
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByRole("button", { name: "Yes, proceed" })).toBeTruthy();
    expect(screen.queryByText("Enter")).toBeNull();
    expect(screen.queryByText(/Enter$/)).toBeNull();
  });

  it("renders the runtime exit-plan modes (including newer ones) with localized copy", () => {
    const onSubmitPrompt = vi.fn();
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            status: "waiting",
            pendingPrompt: {
              kind: "exit-plan",
              requestId: "plan-request-1",
              title: "Exit plan mode",
              // Runtime mode options (keep-planning `plan` already filtered out
              // by extractExitPlanModeOptions). `auto` is newer than the curated
              // fallback list and must still render via id-keyed localization.
              options: [
                {
                  id: "acceptEdits",
                  label: "Yes, and auto-accept edits",
                  kind: "acceptEdits"
                },
                {
                  id: "default",
                  label: "Yes, and manually approve edits",
                  kind: "default"
                },
                {
                  id: "bypassPermissions",
                  label: "Yes, and bypass permissions",
                  kind: "bypassPermissions"
                },
                { id: "auto", label: "Yes, and use auto mode", kind: "auto" }
              ],
              keepPlanningOptionId: "plan"
            }
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={onSubmitPrompt}
        />
      </TooltipProvider>
    );

    // Known ids render localized copy, not the raw runtime label.
    expect(
      screen.getByRole("button", {
        name: "Accept edits Auto-approve file edits"
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Allow all Do not prompt for tools"
      })
    ).toBeTruthy();
    // The newer `auto` mode is surfaced (the curated fallback list omits it).
    expect(
      screen.getByRole("button", {
        name: "Auto Let the agent choose when to ask"
      })
    ).toBeTruthy();
    // Keep-planning stays reachable in the compact deck.
    expect(screen.getByRole("button", { name: "Keep planning" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Auto Let the agent choose when to ask"
      })
    );

    // The runtime option id passes through verbatim.
    expect(onSubmitPrompt).toHaveBeenCalledWith({
      requestId: "plan-request-1",
      action: "allow",
      optionId: "auto"
    });

    // Declining must carry the runtime's keep-planning option id (the daemon
    // models exit-plan as an approval that requires one), not a bare deny.
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onSubmitPrompt).toHaveBeenCalledWith({
      requestId: "plan-request-1",
      action: "deny",
      optionId: "plan"
    });
  });

  it("falls back to the curated mode list when the runtime sent no exit-plan options", () => {
    const onSubmitPrompt = vi.fn();
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            status: "waiting",
            pendingPrompt: {
              kind: "exit-plan",
              requestId: "plan-request-2",
              title: "Exit plan mode",
              options: []
            }
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={onSubmitPrompt}
        />
      </TooltipProvider>
    );

    expect(
      screen.getByRole("button", {
        name: "Accept edits Auto-approve file edits"
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Ask for approval Prompt before each tool"
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Allow all Do not prompt for tools"
      })
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Accept edits Auto-approve file edits"
      })
    );

    expect(onSubmitPrompt).toHaveBeenCalledWith({
      requestId: "plan-request-2",
      action: "allow",
      optionId: "acceptEdits"
    });
  });

  it("shows waiting status when a completed session still has a pending prompt", () => {
    const { container } = render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            status: "completed",
            pendingPrompt: {
              kind: "approval",
              id: "approval:request-1",
              turnId: "turn-1",
              requestId: "request-1",
              callId: "request-1",
              title: "Approval",
              status: "waiting_approval",
              toolName: "Approval",
              input: null,
              options: [],
              output: null,
              occurredAtUnixMs: 1
            }
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    const card = container.querySelector(
      '[data-message-center-item-id="message-center-session-1"]'
    );
    expect(card).toHaveAttribute("data-status", "waiting");
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("shows canceled status instead of collapsing the card label to completed", () => {
    const { container } = render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            status: "canceled",
            lastAgentMessageSummary: "Stopped by user."
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    const card = container.querySelector(
      '[data-message-center-item-id="message-center-session-1"]'
    );
    expect(card).toHaveAttribute("data-status", "canceled");
    expect(screen.getByText("Canceled")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("renders the card body from the message center digest", () => {
    const { container } = render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            digest: {
              primary: {
                kind: "progress",
                summary: "Digest progress summary",
                occurredAtUnixMs: 30
              }
            },
            lastAgentMessageSummary: "Legacy summary"
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByText("Digest progress summary")).toBeTruthy();
    expect(screen.queryByText("Legacy summary")).toBeNull();
    expect(
      container.querySelector(
        '[data-message-center-item-id="message-center-session-1"]'
      )
    ).toHaveAttribute("data-message-center-digest-kind", "progress");
  });

  it("hides generic approval summaries when the prompt has structured details", () => {
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            status: "waiting",
            lastAgentMessageSummary: "Approval",
            pendingPrompt: {
              kind: "approval",
              id: "approval:request-1",
              turnId: "turn-1",
              requestId: "request-1",
              callId: "request-1",
              title: "requestId: request-1",
              status: "waiting_approval",
              toolName: "Approval",
              input: {
                toolCall: {
                  input: {
                    command: "date"
                  }
                }
              },
              options: [
                {
                  id: "allow_once",
                  label: "Yes",
                  kind: "allow_once",
                  description: ""
                }
              ],
              output: null,
              occurredAtUnixMs: 1
            }
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getByText("date")).toBeTruthy();
    expect(screen.queryByText("Approval")).toBeNull();
  });

  it("uses the card agent provider name in approval prompt headings", () => {
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            provider: "codex",
            status: "waiting",
            pendingPrompt: {
              kind: "approval",
              id: "approval:request-1",
              turnId: "turn-1",
              requestId: "request-1",
              callId: "request-1",
              title: "Approval",
              status: "waiting_approval",
              toolName: "Approval",
              input: null,
              options: [
                {
                  id: "allow_once",
                  label: "Yes",
                  kind: "allow_once",
                  description: ""
                }
              ],
              output: null,
              occurredAtUnixMs: 1
            }
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByText("Codex requests your authorization")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "整理本地文件夹" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Yes/i })).toBeTruthy();
    expect(screen.queryByText("Agent requests your authorization")).toBeNull();
  });

  it("renders caller-provided user and agent identity in the card footer", () => {
    const { container } = render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            identity: {
              userName: "Jessica",
              userAvatarUrl: "https://cdn.example.com/jessica.png",
              agentName: "Codex",
              agentAvatarUrl: "https://cdn.example.com/codex.png"
            }
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByText("Jessica")).toBeInTheDocument();
    expect(screen.getByText("&")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(
      container.querySelector(".workspace-agent-message-center__identity")
    ).toBeInTheDocument();
    expect(
      container.querySelector(
        ".workspace-agent-message-center__identity-avatar-stack"
      )
    ).toBeInTheDocument();
    expect(
      container.querySelector('img[src="https://cdn.example.com/jessica.png"]')
    ).toBeTruthy();
    expect(
      container.querySelector('img[src="https://cdn.example.com/codex.png"]')
    ).toBeTruthy();
    expect(
      container.querySelector('img[src="https://cdn.example.com/codex.png"]')
    ).toBeTruthy();
  });

  it("renders summary relative file links as plain text", () => {
    const onLinkAction = vi.fn();
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            cwd: "/Users/local/.tutti/agent/sessions/2026-06-05-001",
            lastAgentMessageSummary:
              "已完成项目文件总结，并新增文档：[PROJECT_SUMMARY.md](PROJECT_SUMMARY.md)"
          })}
          isSubmitting={false}
          onLinkAction={onLinkAction}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(
      screen.queryByRole("link", { name: "PROJECT_SUMMARY.md" })
    ).toBeNull();
    expect(screen.getByText("PROJECT_SUMMARY.md")).toBeInTheDocument();
    expect(onLinkAction).not.toHaveBeenCalled();
  });
  it("enables zoom for markdown images in the summary", async () => {
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:message-center-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            cwd: "/Users/local/.tutti/agent/sessions/2026-06-05-001",
            lastAgentMessageSummary:
              "![generated image](/Users/local/.tutti/agent/sessions/2026-06-05-001/output/imagegen/sheep.png)"
          })}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Zoom image/
      })
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith({
      path: "/Users/local/.tutti/agent/sessions/2026-06-05-001/output/imagegen/sheep.png"
    });
  });

  it("preserves the card provider for providerless session links", () => {
    const onLinkAction = vi.fn();
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={createTestCardItem({
            provider: "claude-code",
            lastAgentMessageSummary:
              "继续 [Claude 会话](mention://agent-session/session-2?workspaceId=workspace-1)"
          })}
          isSubmitting={false}
          onLinkAction={onLinkAction}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: "Claude 会话" }));

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-agent-session",
      workspaceId: "workspace-1",
      agentSessionId: "session-2",
      provider: "claude-code",
      source: "agent-markdown"
    });
  });

  it("hides the interactive prompt surface when interactive is false", () => {
    const promptItem: WorkspaceAgentMessageCenterItem = {
      ...baseItem,
      status: "waiting",
      pendingPrompt: {
        kind: "approval",
        id: "approval:request-1",
        turnId: "turn-1",
        requestId: "request-1",
        callId: "request-1",
        title: "Approval",
        status: "waiting_approval",
        toolName: "Bash",
        input: null,
        options: [
          {
            id: "allow_once",
            label: "Yes",
            kind: "allow_once",
            description: ""
          }
        ],
        output: null,
        occurredAtUnixMs: 1
      }
    };

    const { rerender } = render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={promptItem}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(screen.getByRole("button", { name: "Yes, proceed" })).toBeTruthy();

    rerender(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterCard
          item={promptItem}
          interactive={false}
          isSubmitting={false}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(screen.queryByRole("button", { name: "Yes, proceed" })).toBeNull();
  });
});

describe("WorkspaceAgentMessageCenterPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("reopens the view options menu after the trigger closes it", async () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "working-session",
            title: "Running task",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: "View options" });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("groups visible message center items by status when selected", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createWaitingItem({
            agentSessionId: "waiting-session",
            title: "Needs approval"
          }),
          createMessageCenterItem({
            agentSessionId: "failed-session",
            title: "Request failed",
            status: "failed"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session",
            title: "Running task",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "completed-session",
            title: "Done task",
            status: "completed"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    openViewOptions();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Status" }));

    // Interactive waiting item is in the deck (PR #151), not a status group.
    expect(
      screen.getByTestId("workspace-agent-message-center-attention-deck")
    ).toHaveAttribute(
      "data-deck-top-item-id",
      "message-center-waiting-session"
    );
    expect(screen.queryByRole("heading", { name: "Waiting · 1" })).toBeNull();

    // Non-interactive items still group by status.
    const errorHeading = screen.getByRole("heading", { name: "Error · 1" });
    const runningHeading = screen.getByRole("heading", {
      name: "Running · 1"
    });
    const completedHeading = screen.getByRole("heading", {
      name: "Completed · 1"
    });
    expect(
      errorHeading.querySelector('[data-slot="status-dot"]')
    ).toHaveAttribute("data-tone", "red");
    expect(
      runningHeading.querySelector('[data-slot="status-dot"]')
    ).toHaveAttribute("data-tone", "blue");
    expect(
      runningHeading.querySelector('[data-slot="status-dot"]')
    ).toHaveAttribute("data-pulse", "true");
    expect(
      completedHeading.querySelector('[data-slot="status-dot"]')
    ).toHaveAttribute("data-tone", "green");
  });

  it("filters message center items by status from the view menu", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createWaitingItem({
            agentSessionId: "waiting-session",
            title: "Needs approval"
          }),
          createMessageCenterItem({
            agentSessionId: "completed-session",
            title: "Done task",
            status: "completed"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session",
            title: "Running task",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    openViewOptions();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Running 1" })
    );

    expect(screen.getByText("Done task")).toBeTruthy();
    expect(screen.getByText("Needs approval")).toBeTruthy();
    expect(screen.queryByText("Running task")).toBeNull();
  });

  it("filters attention deck items by status from the view menu", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createWaitingItem({
            agentSessionId: "waiting-session",
            title: "Needs approval"
          }),
          createMessageCenterItem({
            agentSessionId: "completed-session",
            title: "Done task",
            status: "completed"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    openViewOptions();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Waiting 1" })
    );

    expect(screen.queryByText("Needs approval")).toBeNull();
    expect(screen.getByText("Done task")).toBeTruthy();
  });

  it("filters message center items by agent from view options", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "codex-session",
            provider: "codex",
            title: "Codex task",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "gemini-session",
            provider: "gemini",
            title: "Gemini task",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    openViewOptions();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Codex 1" }));

    expect(screen.queryByText("Codex task")).toBeNull();
    expect(screen.getByText("Gemini task")).toBeTruthy();
  });

  it("groups the agent view by agent and user identity", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "codex-jessica-1",
            provider: "codex",
            userId: "user-a",
            title: "Jessica task 1",
            status: "working",
            identity: {
              userName: "Jessica",
              userAvatarUrl: "https://cdn.example.com/jessica.png",
              agentName: "Codex",
              agentAvatarUrl: "https://cdn.example.com/codex.png"
            }
          }),
          createMessageCenterItem({
            agentSessionId: "codex-jessica-2",
            provider: "codex",
            userId: "user-a",
            title: "Jessica task 2",
            status: "working",
            identity: {
              userName: "Jessica",
              userAvatarUrl: "https://cdn.example.com/jessica.png",
              agentName: "Codex",
              agentAvatarUrl: "https://cdn.example.com/codex.png"
            }
          }),
          createMessageCenterItem({
            agentSessionId: "codex-taylor",
            provider: "codex",
            userId: "user-b",
            title: "Taylor task",
            status: "working",
            identity: {
              userName: "Taylor",
              userAvatarUrl: "https://cdn.example.com/taylor.png",
              agentName: "Codex",
              agentAvatarUrl: "https://cdn.example.com/codex.png"
            }
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    openViewOptions();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Agent" }));

    const jessicaGroup = screen
      .getByRole("heading", { name: "Jessica & Codex · 2" })
      .closest("section");
    const taylorGroup = screen
      .getByRole("heading", { name: "Taylor & Codex · 1" })
      .closest("section");

    expect(jessicaGroup).toHaveTextContent("Jessica task 1");
    expect(jessicaGroup).not.toHaveTextContent("Taylor task");
    expect(taylorGroup).toHaveTextContent("Taylor task");
    expect(taylorGroup).not.toHaveTextContent("Jessica task 1");
    expect(
      jessicaGroup?.querySelector(
        ".workspace-agent-message-center__identity-avatar-stack"
      )
    ).toBeInTheDocument();
    expect(
      jessicaGroup?.querySelector(
        'img[src="https://cdn.example.com/jessica.png"]'
      )
    ).toBeTruthy();
  });

  it("collapses grouped cards into a summary card with stack edges exposed below", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "working-session-1",
            title: "Running task 1",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-2",
            title: "Running task 2",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-3",
            title: "Running task 3",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-4",
            title: "Running task 4",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-5",
            title: "Running task 5",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const stack = screen.getByTestId(
      "workspace-agent-message-stack-working:agent-user:codex:unknown-user"
    );
    expect(stack).toHaveAttribute(
      "data-stack-top-item-id",
      "message-center-working-session-1"
    );
    expect(stack).toHaveAttribute("data-stack-count", "5");
    expect(stack).toHaveAttribute("data-stack-state", "collapsed");
    expect(stack).toHaveAttribute("data-stack-motion", "smooth");
    expect(stack.querySelector("[data-message-center-item-id]")).toBeNull();

    const summary = screen.getByTestId(
      "workspace-agent-message-stack-summary-working:agent-user:codex:unknown-user"
    );
    expect(summary).toHaveAttribute("data-stack-summary-count", "5");
    expect(summary).toHaveAttribute("data-stack-provider", "codex");
    expect(summary).toHaveTextContent("5 messages");
    expect(summary.querySelector("img")).toHaveClass("rounded-full");
    expect(summary).toHaveTextContent("Running task 1 summary");
    expect(summary).not.toHaveTextContent("more");
    expect(summary).not.toHaveTextContent("Running task 2 summary");
    expect(screen.queryByText("Running task 3")).toBeNull();
    expect(screen.queryByText("Running task 4")).toBeNull();
    expect(screen.queryByText("Running task 5")).toBeNull();
  });

  it("aggregates stacked cards by agent provider and user inside a group", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "codex-session-1",
            provider: "codex",
            userId: "user-a",
            title: "Codex task 1",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "codex-session-2",
            provider: "codex",
            userId: "user-a",
            title: "Codex task 2",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "codex-session-3",
            provider: "codex",
            userId: "user-b",
            title: "Codex task 3",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "gemini-session-1",
            provider: "gemini",
            userId: "user-a",
            title: "Gemini task 1",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "gemini-session-2",
            provider: "gemini",
            userId: "user-a",
            title: "Gemini task 2",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "claude-session-1",
            provider: "claude-code",
            title: "Claude task 1",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const codexStack = screen.getByTestId(
      "workspace-agent-message-stack-working:agent-user:codex:user-a"
    );
    expect(codexStack).toHaveAttribute("data-stack-count", "2");
    const geminiStack = screen.getByTestId(
      "workspace-agent-message-stack-working:agent-user:gemini:user-a"
    );
    expect(geminiStack).toHaveAttribute("data-stack-count", "2");
    expect(
      screen.getByTestId(
        "workspace-agent-message-stack-summary-working:agent-user:codex:user-a"
      )
    ).toHaveTextContent("2 messages");
    expect(
      screen.getByTestId(
        "workspace-agent-message-stack-summary-working:agent-user:codex:user-a"
      )
    ).toHaveAttribute("data-stack-user-id", "user-a");
    expect(
      screen.getByTestId(
        "workspace-agent-message-stack-summary-working:agent-user:gemini:user-a"
      )
    ).toHaveTextContent("2 messages");
    expect(
      screen.queryByTestId(
        "workspace-agent-message-stack-working:agent-user:codex:user-b"
      )
    ).toBeNull();
    expect(screen.getByText("Codex task 3")).toBeTruthy();

    expect(
      screen.queryByTestId(
        "workspace-agent-message-stack-working:agent-user:claude-code:unknown-user"
      )
    ).toBeNull();
    expect(screen.getByText("Claude task 1")).toBeTruthy();
  });

  it("renders user and agent avatars in collapsed stack summaries", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "codex-session-1",
            provider: "codex",
            userId: "user-a",
            title: "Codex task 1",
            status: "working",
            identity: {
              userName: "Jessica",
              userAvatarUrl: "https://cdn.example.com/jessica.png",
              agentName: "Codex",
              agentAvatarUrl: "https://cdn.example.com/codex.png"
            }
          }),
          createMessageCenterItem({
            agentSessionId: "codex-session-2",
            provider: "codex",
            userId: "user-a",
            title: "Codex task 2",
            status: "working",
            identity: {
              userName: "Jessica",
              userAvatarUrl: "https://cdn.example.com/jessica.png",
              agentName: "Codex",
              agentAvatarUrl: "https://cdn.example.com/codex.png"
            }
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const summary = screen.getByTestId(
      "workspace-agent-message-stack-summary-working:agent-user:codex:user-a"
    );

    expect(
      summary.querySelector(
        ".workspace-agent-message-center__identity-avatar-stack"
      )
    ).toBeInTheDocument();
    const imageSources = Array.from(summary.querySelectorAll("img")).map(
      (image) => image.getAttribute("src")
    );
    expect(imageSources).toContain("https://cdn.example.com/jessica.png");
    expect(imageSources).toContain("https://cdn.example.com/codex.png");
  });

  it("expands and collapses a stacked card group", async () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "working-session-1",
            title: "Running task 1",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-2",
            title: "Running task 2",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-3",
            title: "Running task 3",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-4",
            title: "Running task 4",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-5",
            title: "Running task 5",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand 5 collapsed messages" })
    );

    const expandedStack = screen.getByTestId(
      "workspace-agent-message-stack-working:agent-user:codex:unknown-user"
    );
    expect(expandedStack).toHaveAttribute("data-stack-state", "expanded");
    expect(
      expandedStack.querySelector(
        '[data-message-center-item-id="message-center-working-session-1"]'
      )
    ).toBeTruthy();
    expect(screen.getByText("Running task 3")).toBeTruthy();
    expect(screen.getByText("Running task 4")).toBeTruthy();
    expect(screen.getByText("Running task 5")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.queryByTestId(
          "workspace-agent-message-stack-summary-working:agent-user:codex:unknown-user"
        )
      ).toBeNull();
    });
    expect(
      screen
        .getAllByText("5 messages")
        .some((element) =>
          element.parentElement?.classList.contains("text-[13px]")
        )
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse expanded messages" })
    );

    const collapsedStack = screen.getByTestId(
      "workspace-agent-message-stack-working:agent-user:codex:unknown-user"
    );
    expect(collapsedStack).toHaveAttribute("data-stack-state", "collapsed");
    await waitFor(() => {
      expect(screen.queryByText("Running task 3")).toBeNull();
    });
    expect(
      screen.getByTestId(
        "workspace-agent-message-stack-summary-working:agent-user:codex:unknown-user"
      )
    ).toHaveTextContent("5 messages");
    expect(screen.queryByText("Running task 4")).toBeNull();
    expect(screen.queryByText("Running task 5")).toBeNull();
  });

  it("shows full oversized stack labels and batches all expanded cards", async () => {
    const items = Array.from({ length: 127 }, (_, index) =>
      createMessageCenterItem({
        agentSessionId: `working-session-${index + 1}`,
        title: `Running task ${index + 1}`,
        status: "working"
      })
    );

    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel(items)}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const stack = screen.getByTestId(
      "workspace-agent-message-stack-working:agent-user:codex:unknown-user"
    );
    expect(stack).toHaveAttribute("data-stack-count", "127");

    const summary = screen.getByTestId(
      "workspace-agent-message-stack-summary-working:agent-user:codex:unknown-user"
    );
    expect(summary).toHaveAttribute("data-stack-summary-count", "127");
    expect(summary).toHaveTextContent("127 messages");

    fireEvent.click(
      screen.getByRole("button", { name: "Expand 127 collapsed messages" })
    );

    expect(stack).toHaveAttribute("data-stack-state", "expanded");
    expect(screen.getByText("Running task 24")).toBeTruthy();
    expect(screen.queryByText("Running task 100")).toBeNull();
    expect(
      stack.querySelectorAll("[data-message-center-item-id]").length
    ).toBeLessThan(100);

    await waitFor(
      () => {
        expect(
          stack.querySelectorAll("[data-message-center-item-id]")
        ).toHaveLength(127);
      },
      { timeout: 5000 }
    );

    expect(screen.getByText("Running task 127")).toBeTruthy();
    expect(
      screen
        .getAllByText("127 messages")
        .some((element) =>
          element.parentElement?.classList.contains("text-[13px]")
        )
    ).toBe(true);
  });

  it("expands a stack for a highlighted stacked item and still collapses on demand", async () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        highlightedItemId="message-center-working-session-3"
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "working-session-1",
            title: "Running task 1",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-2",
            title: "Running task 2",
            status: "working"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session-3",
            title: "Running task 3",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const stack = screen.getByTestId(
      "workspace-agent-message-stack-working:agent-user:codex:unknown-user"
    );
    expect(stack).toHaveAttribute("data-stack-state", "expanded");
    expect(screen.getByText("Running task 3")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse expanded messages" })
    );

    expect(stack).toHaveAttribute("data-stack-state", "collapsed");
    await waitFor(() => {
      expect(screen.queryByText("Running task 3")).toBeNull();
    });
  });

  it("summarizes completed cards in a collapsed stack", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "completed-session-1",
            title: "Completed task 1",
            status: "completed"
          }),
          createMessageCenterItem({
            agentSessionId: "completed-session-2",
            title: "Completed task 2",
            status: "completed"
          }),
          createMessageCenterItem({
            agentSessionId: "completed-session-3",
            title: "Completed task 3",
            status: "completed"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const stack = screen.getByTestId(
      "workspace-agent-message-stack-completed:agent-user:codex:unknown-user"
    );
    expect(stack).toHaveAttribute(
      "data-stack-top-item-id",
      "message-center-completed-session-1"
    );
    expect(stack).toHaveAttribute("data-stack-count", "3");

    const summary = screen.getByTestId(
      "workspace-agent-message-stack-summary-completed:agent-user:codex:unknown-user"
    );
    expect(summary).toHaveTextContent("3 messages");
    expect(summary).toHaveTextContent("Completed task 1 summary");
    expect(summary).not.toHaveTextContent("more");
    expect(summary).not.toHaveTextContent("Completed task 2 summary");
    expect(screen.queryByText("Completed task 3")).toBeNull();
  });

  it("splits completions finished within ten minutes into a recent group", () => {
    const now = Date.now();
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "recent-session",
            title: "Just finished",
            status: "completed",
            sortTimeUnixMs: now - 60_000,
            lastAgentMessageAtUnixMs: now - 60_000
          }),
          createMessageCenterItem({
            agentSessionId: "old-session",
            title: "Finished long ago",
            status: "completed",
            sortTimeUnixMs: now - 60 * 60_000,
            lastAgentMessageAtUnixMs: now - 60 * 60_000
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Recently completed · 1" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Completed · 1" })).toBeTruthy();

    const recentSection = screen
      .getByRole("heading", { name: "Recently completed · 1" })
      .closest("section");
    expect(recentSection).not.toBeNull();
    expect(recentSection).toHaveTextContent("Just finished");
    expect(recentSection).not.toHaveTextContent("Finished long ago");
  });

  it("splits failed items out of the needs-attention group in the priority view", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "attention-session",
            title: "Awaiting input",
            status: "working",
            needsAttentionKind: "question",
            needsAttentionSummary: "Needs a decision"
          }),
          createMessageCenterItem({
            agentSessionId: "failed-session",
            title: "Request failed",
            status: "failed"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Needs attention · 1" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Error · 1" })).toBeTruthy();

    const attentionSection = screen
      .getByRole("heading", { name: "Needs attention · 1" })
      .closest("section");
    expect(attentionSection).not.toBeNull();
    expect(attentionSection).toHaveTextContent("Awaiting input");
    expect(attentionSection).not.toHaveTextContent("Request failed");
  });

  it("shows a filtered empty state with a clear filters action", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createMessageCenterItem({
            agentSessionId: "working-session",
            title: "Running task",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    openViewOptions();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Running 1" })
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByText("Running task")).toBeNull();
    expect(
      screen.getByText("No messages match the current filters")
    ).toBeTruthy();
    expect(screen.queryByText("No agent messages yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByText("Running task")).toBeTruthy();
    expect(
      screen.queryByText("No messages match the current filters")
    ).toBeNull();
  });

  it("renders interactive items in the attention deck instead of the groups", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createWaitingItem({
            agentSessionId: "waiting-session",
            title: "Needs approval"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session",
            title: "Running task",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    const deck = screen.getByTestId(
      "workspace-agent-message-center-attention-deck"
    );
    expect(deck).toHaveAttribute(
      "data-deck-top-item-id",
      "message-center-waiting-session"
    );
    // The interactive item is no longer rendered inside a "Needs attention" group section.
    expect(
      screen.queryByRole("heading", { name: /Needs attention · / })
    ).toBeNull();
    // Non-interactive items still render in the normal list.
    expect(screen.getByText("Running task")).toBeTruthy();
  });

  it("hides the deck when filters hide the interactive item", () => {
    render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([
          createWaitingItem({
            agentSessionId: "waiting-session",
            title: "Needs approval"
          }),
          createMessageCenterItem({
            agentSessionId: "working-session",
            title: "Running task",
            status: "working"
          })
        ])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={vi.fn()}
      />
    );

    // Filter to only statuses with no matching items.
    openViewOptions();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Waiting 1" })
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Running 1" })
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(
      screen.queryByTestId("workspace-agent-message-center-attention-deck")
    ).toBeNull();
    expect(
      screen.getByText("No messages match the current filters")
    ).toBeTruthy();
  });

  describe("localStorage persistence", () => {
    afterEach(() => {
      window.localStorage.removeItem(messageCenterFiltersStorageKey);
    });

    it("reads and applies stored groupBy on mount", () => {
      // Approach (a): write groupBy: "status" before mount, then assert that
      // the panel renders status-group section headings instead of priority headings.
      writeMessageCenterFilterPreferences({
        groupBy: "status",
        statusFilters: null,
        providerFilters: null
      });

      render(
        <WorkspaceAgentMessageCenterPanel
          open
          model={createMessageCenterModel([
            createMessageCenterItem({
              agentSessionId: "working-session",
              title: "Running task",
              status: "working"
            }),
            createMessageCenterItem({
              agentSessionId: "completed-session",
              title: "Done task",
              status: "completed"
            })
          ])}
          onClose={vi.fn()}
          onOpenChat={vi.fn()}
          onSubmitPrompt={vi.fn()}
        />
      );

      // With groupBy "status", items appear under status headings (not priority).
      expect(screen.getByRole("heading", { name: "Running · 1" })).toBeTruthy();
      expect(
        screen.getByRole("heading", { name: "Completed · 1" })
      ).toBeTruthy();
      // Priority-mode heading should not be present.
      expect(
        screen.queryByRole("heading", { name: /Needs attention/ })
      ).toBeNull();
    });
  });

  it("advances to the next interactive card after the top one is answered", () => {
    const onSubmitPrompt = vi.fn();
    const model = createMessageCenterModel([
      createWaitingItem({
        agentSessionId: "first",
        title: "Approve first",
        sortTimeUnixMs: 20,
        pendingPrompt: {
          kind: "approval",
          id: "approval:first",
          turnId: "turn-1",
          requestId: "request-first",
          callId: "request-first",
          title: "Approval",
          status: "waiting_approval",
          toolName: "Bash",
          input: null,
          options: [
            {
              id: "allow_once",
              label: "Yes",
              kind: "allow_once",
              description: ""
            }
          ],
          output: null,
          occurredAtUnixMs: 20
        }
      }),
      createWaitingItem({
        agentSessionId: "second",
        title: "Approve second",
        sortTimeUnixMs: 10,
        pendingPrompt: {
          kind: "approval",
          id: "approval:second",
          turnId: "turn-1",
          requestId: "request-second",
          callId: "request-second",
          title: "Approval",
          status: "waiting_approval",
          toolName: "Bash",
          input: null,
          options: [
            {
              id: "allow_once",
              label: "Yes",
              kind: "allow_once",
              description: ""
            }
          ],
          output: null,
          occurredAtUnixMs: 10
        }
      })
    ]);

    const { rerender } = render(
      <WorkspaceAgentMessageCenterPanel
        open
        model={model}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={onSubmitPrompt}
      />
    );

    // Top is "first"; answer it.
    fireEvent.click(screen.getByRole("button", { name: "Yes, proceed" }));
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "first" })
    );

    // Model refreshes without "first" -> deck advances to "second".
    rerender(
      <WorkspaceAgentMessageCenterPanel
        open
        model={createMessageCenterModel([model.items[1]!])}
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onSubmitPrompt={onSubmitPrompt}
      />
    );

    expect(
      screen.getByTestId("workspace-agent-message-center-attention-deck")
    ).toHaveAttribute("data-deck-top-item-id", "message-center-second");
  });
});
