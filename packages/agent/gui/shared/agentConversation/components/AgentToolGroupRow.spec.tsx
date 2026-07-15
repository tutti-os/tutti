import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentToolGroupRowVM } from "../contracts/agentToolGroupRowVM";
import { projectAgentToolCall } from "../projection/agentToolProjection";
import { AgentToolGroupRow } from "./AgentToolGroupRow";

describe("AgentToolGroupRow", () => {
  afterEach(async () => {
    setAgentGuiI18nTestLocale("zh-CN");
  });

  it("renders approval timeline calls as collapsible tool cards", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolGroupRow
        row={{
          kind: "tool-group",
          id: "row-1",
          turnId: "turn-1",
          grouped: false,
          calls: [
            projectAgentToolCall(
              detailToolCall({
                id: "call:approval-1",
                name: "Edit /workspace/index.html",
                toolName: "Edit",
                callType: "approval",
                status: "waiting_approval",
                payload: {
                  input: {
                    requestId: "approval-request-1",
                    options: [{ optionId: "approved", label: "Approve once" }],
                    toolCall: {
                      kind: "edit",
                      title: "Edit /workspace/index.html"
                    }
                  }
                }
              })
            )
          ],
          entries: [],
          occurredAtUnixMs: 1
        }}
        label={(count) => `Tool calls (${count})`}
        thinkingLabel="Thinking"
      />
    );

    expect(screen.getByRole("button", { expanded: false })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("renders the task glyph before grouped tool call labels", async () => {
    render(
      <AgentToolGroupRow
        row={toolGroupRow()}
        label={(count) => `Tool calls (${count})`}
        thinkingLabel="Thought process"
      />
    );

    const button = screen.getByRole("button", { name: "Tool calls (2)" });
    const icon = button.querySelector(
      ".workspace-agents-status-panel__detail-tool-count-icon"
    );
    const chevron = button.querySelector(
      ".workspace-agents-status-panel__detail-tool-count-chevron"
    );
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon?.querySelector("path")?.getAttribute("d")).toContain(
      "M8.29297 14.793"
    );
    expect(chevron).toBeInTheDocument();

    fireEvent.click(button);
    await flushCollapsibleRevealFrames();

    const list = document.querySelector(
      ".workspace-agents-status-panel__detail-tool-list"
    );
    await waitFor(() =>
      expect(list?.closest(".agent-collapsible-reveal")).toHaveAttribute(
        "data-expanded",
        "true"
      )
    );
    expect(
      button.closest(".workspace-agents-status-panel__detail-tool-section")
    ).toHaveAttribute("data-tool-group-expanded", "true");
    expect(
      document.querySelectorAll(
        ".workspace-agents-status-panel__detail-tool-list-item"
      )
    ).toHaveLength(2);
  });

  it("does not render grouped file-change summaries under the tool-call count", () => {
    render(
      <AgentToolGroupRow
        row={{ ...toolGroupRow(), summary: "Changed App.tsx and 1 more files" }}
        label={(count) => `Tool calls (${count})`}
        thinkingLabel="Thought process"
      />
    );

    expect(screen.queryByText("Changed App.tsx and 1 more files")).toBeNull();
  });

  it("renders raw timeline JSON disclosure for debug session views", () => {
    render(
      <AgentToolGroupRow
        row={{
          kind: "tool-group",
          id: "row-raw",
          turnId: "turn:1",
          grouped: false,
          calls: [
            toolCall({
              sourceTimelineItems: [
                {
                  id: 42,
                  workspaceId: "room-1",
                  agentSessionId: "session-1",
                  eventId: "tool-started",
                  actorType: "agent",
                  actorId: "agent",
                  itemType: "call",
                  callType: "tool",
                  callId: "call:1",
                  name: "Read",
                  status: "started",
                  occurredAtUnixMs: 1,
                  createdAtUnixMs: 1
                }
              ]
            })
          ],
          entries: [],
          occurredAtUnixMs: 1
        }}
        label={(count) => `Tool calls (${count})`}
        thinkingLabel="Thought process"
        showRawTimelineJson
        rawTimelineJsonLabel="Raw JSON"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));

    expect(screen.getByText(/"eventId": "tool-started"/)).toBeInTheDocument();
  });

  it("keeps collapsed grouped tool details unmounted while idle", () => {
    let idleCallback: IdleRequestCallback | null = null;
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", () => undefined);

    render(
      <AgentToolGroupRow
        row={toolGroupRow()}
        label={(count) => `Tool calls (${count})`}
        thinkingLabel="Thought process"
      />
    );

    expect(
      document.querySelector(".workspace-agents-status-panel__detail-tool-list")
    ).toBeNull();

    act(() => {
      idleCallback?.({
        didTimeout: false,
        timeRemaining: () => 50
      });
    });

    expect(
      document.querySelector(".workspace-agents-status-panel__detail-tool-list")
    ).toBeNull();
  });
});

async function flushCollapsibleRevealFrames(): Promise<void> {
  await flushAnimationFrame();
  await flushAnimationFrame();
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function toolGroupRow(): AgentToolGroupRowVM {
  const calls = [
    toolCall({ id: "call:1", name: "Read file", summary: "README.md" }),
    toolCall({ id: "call:2", name: "Edit file", summary: "src/App.tsx" })
  ];
  return {
    kind: "tool-group",
    id: "group:1",
    turnId: "turn:1",
    grouped: true,
    calls,
    summary: null,
    entries: calls.map((call) => ({ kind: "tool-call", call })),
    occurredAtUnixMs: null
  };
}

function toolCall(overrides: Partial<AgentToolCallVM> = {}): AgentToolCallVM {
  return {
    kind: "tool-call",
    id: "call:1",
    turnId: "turn:1",
    name: "Tool",
    toolName: "tool",
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: "",
    compactSummary: null,
    payload: null,
    toolState: null,
    input: null,
    output: null,
    error: null,
    metadata: null,
    content: null,
    locations: null,
    rendererKind: "default",
    approval: null,
    planMode: null,
    askUserQuestion: null,
    task: null,
    occurredAtUnixMs: null,
    ...overrides
  };
}

function detailToolCall(
  overrides: Partial<WorkspaceAgentSessionDetailToolCall> = {}
): WorkspaceAgentSessionDetailToolCall {
  return {
    id: "call:1",
    name: "Tool",
    toolName: null,
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: "",
    payload: null,
    ...overrides
  };
}
