import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import {
  AgentTranscriptView,
  areAgentTranscriptViewPropsEqual
} from "./AgentTranscriptView";
import { AgentTurnDisclosureProvider } from "./AgentTurnDisclosureContext";
import { projectAgentConversationVM } from "../projection/agentConversationProjection";

vi.mock("../../../i18n/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../i18n/index")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        translateTestKey(key, options)
    }),
    translate: (key: string) => key
  };
});

describe("AgentTranscriptView", () => {
  it("treats status-only conversation object changes as equal for transcript rendering", () => {
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const conversation = projectAgentConversationVM(detailViewModel());
    const statusOnlyConversation = {
      ...conversation,
      activity: {
        ...conversation.activity,
        status: "idle" as const
      }
    };

    expect(
      areAgentTranscriptViewPropsEqual(
        { conversation, labels },
        { conversation: statusOnlyConversation, labels }
      )
    ).toBe(true);
  });

  it("rerenders when canonical turn timing changes", () => {
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const conversation = projectAgentConversationVM(
      detailViewModel({ sessionTurns: [canonicalTurn()] })
    );
    const settledConversation = projectAgentConversationVM(
      detailViewModel({
        sessionTurns: [
          canonicalTurn({
            phase: "settled",
            outcome: "completed",
            settledAtUnixMs: 12_000
          })
        ]
      })
    );

    expect(
      areAgentTranscriptViewPropsEqual(
        { conversation, labels },
        { conversation: settledConversation, labels }
      )
    ).toBe(false);
  });

  it("rerenders when canonical active-turn identity enables live timing", () => {
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const conversation = projectAgentConversationVM(
      detailViewModel({ sessionTurns: [canonicalTurn()] })
    );
    const activeConversation = {
      ...conversation,
      sourceDetail: {
        ...conversation.sourceDetail,
        session: {
          ...conversation.sourceDetail.session,
          activeTurnId: "turn-1"
        }
      }
    };

    expect(
      areAgentTranscriptViewPropsEqual(
        { conversation, labels },
        { conversation: activeConversation, labels }
      )
    ).toBe(false);
  });

  it("rerenders when imported history changes the assistant disclosure policy", () => {
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const conversation = projectAgentConversationVM(detailViewModel());
    const importedConversation = {
      ...conversation,
      sourceDetail: {
        ...conversation.sourceDetail,
        session: {
          ...conversation.sourceDetail.session,
          imported: true
        }
      }
    };

    expect(
      areAgentTranscriptViewPropsEqual(
        { conversation, labels },
        { conversation: importedConversation, labels }
      )
    ).toBe(false);
  });

  it("keeps the legacy transcript rows flat when canonical timing is unavailable", () => {
    const { container } = render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(detailViewModel())}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    const directRows = container.querySelectorAll(
      ":scope > .agent-gui-transcript-row"
    );
    const allRows = container.querySelectorAll(".agent-gui-transcript-row");
    expect(directRows).toHaveLength(allRows.length);
    expect(directRows.length).toBeGreaterThan(1);
    expect(
      container.querySelector("[data-agent-turn-work-section]")
    ).toBeNull();
    expect(container.querySelector(".agent-gui-transcript-turn")).toBeNull();
  });

  it("ticks canonical live turn duration once per second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const turn = canonicalTurn();
    const baseDetail = detailViewModel();
    try {
      render(
        <AgentTranscriptView
          conversation={projectAgentConversationVM(
            detailViewModel({
              session: {
                ...baseDetail.session,
                activeTurnId: turn.turnId,
                activeTurn: turn
              },
              sessionTurns: [turn],
              showProcessingIndicator: true
            })
          )}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files"
          }}
        />
      );

      expect(screen.getByText("Processed for 45s")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByText("Processed for 47s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders one live Turn work section when Goal clear occurs between its rows", () => {
    const baseDetail = detailViewModel();
    const sourceTurn = baseDetail.turns[0]!;
    const activeTurn = canonicalTurn();
    const timedToolCall = {
      ...sourceTurn.toolCalls[0]!,
      turnId: "turn-1",
      occurredAtUnixMs: 500
    };
    const conversation = projectAgentConversationVM(
      detailViewModel({
        session: {
          ...baseDetail.session,
          activeTurnId: activeTurn.turnId,
          activeTurn
        },
        sessionTurns: [activeTurn],
        goalControls: [
          {
            id: "goal-control:clear",
            action: "clear",
            body: "/goal clear",
            occurredAtUnixMs: 400
          }
        ],
        turns: [
          {
            ...sourceTurn,
            userMessage: {
              id: "user-1",
              body: "Start the goal",
              turnId: "turn-1",
              occurredAtUnixMs: 100
            },
            userMessages: [
              {
                id: "user-1",
                body: "Start the goal",
                turnId: "turn-1",
                occurredAtUnixMs: 100
              }
            ],
            agentMessages: [
              {
                id: "assistant-before-clear",
                body: "Working before clear",
                turnId: "turn-1",
                occurredAtUnixMs: 200
              }
            ],
            toolCalls: [timedToolCall],
            agentItems: [
              {
                kind: "message",
                message: {
                  id: "assistant-before-clear",
                  body: "Working before clear",
                  turnId: "turn-1",
                  occurredAtUnixMs: 200
                }
              },
              {
                kind: "tool-calls",
                id: "tools-after-clear",
                toolCalls: [timedToolCall],
                toolCallCount: 1,
                hasFailedToolCall: false
              }
            ]
          }
        ]
      })
    );
    const goalControlIndex = conversation.rows.findIndex(
      (row) => row.kind === "goal-control"
    );

    expect(goalControlIndex).toBeGreaterThan(0);
    expect(conversation.rows[goalControlIndex]?.turnId).toBeNull();
    expect(conversation.rows[goalControlIndex - 1]?.turnId).toBe("turn-1");
    expect(conversation.rows[goalControlIndex + 1]?.turnId).toBe("turn-1");

    const { container } = render(
      <AgentTranscriptView
        conversation={conversation}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    expect(
      container.querySelectorAll("[data-agent-turn-work-section]")
    ).toHaveLength(1);
    expect(screen.getAllByText("/goal clear")).toHaveLength(1);
    expect(screen.getAllByText("Working before clear")).toHaveLength(1);
  });

  it("freezes settled duration, auto-collapses work, and keeps manual expansion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500_000);
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const settledTurn = canonicalTurn({
      phase: "settled",
      outcome: "completed",
      settledAtUnixMs: 132_000
    });
    const conversation = projectAgentConversationVM(
      detailViewModel({ sessionTurns: [settledTurn] })
    );

    try {
      const { rerender } = render(
        <AgentTranscriptView conversation={conversation} labels={labels} />
      );

      expect(document.querySelector(".agent-gui-transcript-turn")).toBeNull();
      expect(
        document.querySelectorAll("[data-agent-turn-work-section]")
      ).toHaveLength(1);
      expect(screen.getByText("Total 2m 7s")).toBeTruthy();
      expect(
        screen.getAllByText(
          (_, node) => node?.textContent === "Assistant answer with README"
        )[0]
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Thought process" })
      ).toBeNull();

      const expand = screen.getByRole("button", {
        name: "Expand task details"
      });
      expect(expand).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(expand);
      act(() => {
        vi.advanceTimersByTime(16);
      });
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(
        screen.getByRole("button", { name: "Thought process", hidden: true })
      ).toBeTruthy();

      vi.advanceTimersByTime(20_000);
      expect(screen.getByText("Total 2m 7s")).toBeTruthy();

      rerender(
        <AgentTranscriptView
          conversation={{
            ...conversation,
            sourceDetail: {
              ...conversation.sourceDetail,
              sessionTurns: [{ ...settledTurn, updatedAtUnixMs: 140_000 }]
            }
          }}
          labels={labels}
        />
      );
      expect(
        screen.getByRole("button", { name: "Thought process", hidden: true })
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers manual expansion while switching sessions in one panel", () => {
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const settledTurn = canonicalTurn({
      phase: "settled",
      outcome: "completed",
      settledAtUnixMs: 15_000
    });
    const sessionOne = projectAgentConversationVM(
      detailViewModel({ sessionTurns: [settledTurn] })
    );
    const sessionTwo = {
      ...sessionOne,
      sourceDetail: {
        ...sessionOne.sourceDetail,
        session: {
          ...sessionOne.sourceDetail.session,
          agentSessionId: "session-2"
        },
        sessionTurns: [
          {
            ...settledTurn,
            agentSessionId: "session-2",
            updatedAtUnixMs: 7_000
          }
        ]
      }
    };
    const { rerender } = render(
      <AgentTurnDisclosureProvider>
        <AgentTranscriptView conversation={sessionOne} labels={labels} />
      </AgentTurnDisclosureProvider>
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand task details" })
    );
    expect(
      screen.getByRole("button", { name: "Collapse task details" })
    ).toBeTruthy();

    rerender(
      <AgentTurnDisclosureProvider>
        <AgentTranscriptView conversation={sessionTwo} labels={labels} />
      </AgentTurnDisclosureProvider>
    );
    expect(
      screen.getByRole("button", { name: "Expand task details" })
    ).toBeTruthy();

    rerender(
      <AgentTurnDisclosureProvider>
        <AgentTranscriptView conversation={sessionOne} labels={labels} />
      </AgentTurnDisclosureProvider>
    );
    expect(
      screen.getByRole("button", { name: "Collapse task details" })
    ).toBeTruthy();
  });

  it("renders workspace-agent turns with markdown, thinking, and tool disclosures", async () => {
    const onLinkAction = vi.fn();
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(detailViewModel())}
        onLinkAction={onLinkAction}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    expect(screen.getByText("User asks for a fix")).toBeTruthy();
    expect(
      screen.getAllByText(
        (_, node) => node?.textContent === "Assistant answer with README"
      )[0]
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Thought process" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
    await flushCollapsibleRevealFrames();
    expect(
      screen.getByText("Need to inspect the workspace first.")
    ).toBeTruthy();
  });

  it("does not replay the enter animation when the transient processing row appears", () => {
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files"
    };
    const { rerender } = render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            showProcessingIndicator: false
          })
        )}
        labels={labels}
      />
    );

    rerender(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            showProcessingIndicator: true,
            session: {
              ...detailViewModel().session
            }
          })
        )}
        labels={labels}
      />
    );

    const processingRow = screen
      .getByText("Planning next moves")
      .closest("[data-agent-transcript-row]");
    expect(processingRow).toBeInstanceOf(HTMLElement);
    expect(processingRow).not.toHaveAttribute(
      "data-agent-transcript-row-enter"
    );
  });

  it("renders a divider between transcript turns", () => {
    const base = detailViewModel();
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            turns: [
              base.turns[0]!,
              {
                id: "turn-2",
                userMessage: { id: "user-2", body: "Follow-up request" },
                userMessages: [{ id: "user-2", body: "Follow-up request" }],
                agentMessages: [
                  { id: "assistant-2", body: "Follow-up answer" }
                ],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false,
                agentItems: [
                  {
                    kind: "message",
                    message: { id: "assistant-2", body: "Follow-up answer" }
                  }
                ]
              }
            ]
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    const dividers = screen.getAllByTestId("agent-transcript-turn-divider");
    expect(dividers).toHaveLength(1);
  });

  it("renders user message locator ticks and scrolls to the selected message", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const base = detailViewModel();

    try {
      render(
        <AgentTranscriptView
          conversation={projectAgentConversationVM(
            detailViewModel({
              turns: [
                base.turns[0]!,
                {
                  id: "turn-2",
                  userMessage: { id: "user-2", body: "Follow-up request" },
                  userMessages: [{ id: "user-2", body: "Follow-up request" }],
                  agentMessages: [
                    { id: "assistant-2", body: "Follow-up answer" }
                  ],
                  toolCalls: [],
                  toolCallCount: 0,
                  hasFailedToolCall: false,
                  agentItems: [
                    {
                      kind: "message",
                      message: {
                        id: "assistant-2",
                        body: "Follow-up answer"
                      }
                    }
                  ]
                }
              ]
            })
          )}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files",
            userMessageLocator: "User messages"
          }}
        />
      );

      const locator = screen.getByTestId("agent-message-locator");
      expect(locator).toBeTruthy();
      expect(locator).toHaveStyle({
        "--agent-message-locator-height": "66px"
      });
      expect(
        locator.querySelector(".agent-gui-message-locator__track-segment")
      ).toHaveStyle({
        "--agent-message-locator-segment-position": "33px"
      });
      fireEvent.mouseEnter(locator);
      const panel = screen.getByTestId("agent-message-locator-panel");
      expect(within(panel).getByText("User asks for a fix")).toBeTruthy();
      expect(within(panel).getByText("Follow-up request")).toBeTruthy();
      vi.useFakeTimers();
      fireEvent.mouseLeave(locator);
      fireEvent.mouseEnter(panel);
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(screen.getByTestId("agent-message-locator-panel")).toBeTruthy();
      vi.useRealTimers();

      fireEvent.mouseEnter(
        within(panel).getByRole("button", { name: "Follow-up request" })
      );
      expect(
        within(panel)
          .getByRole("button", { name: "User asks for a fix" })
          .getAttribute("data-active")
      ).toBeNull();
      expect(
        within(panel).getByRole("button", { name: "Follow-up request" })
      ).toHaveAttribute("data-active", "true");

      fireEvent.click(
        within(panel).getByRole("button", { name: "Follow-up request" })
      );

      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "center",
        behavior: "smooth"
      });
      expect(
        locator.querySelectorAll(".agent-gui-message-locator__tick")[1]
      ).toHaveAttribute("data-selected", "true");
    } finally {
      vi.useRealTimers();
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("formats rich mention syntax as plain text in user message locator previews", () => {
    const mentionPrompt =
      "[@我打算去泰国旅游，你制定下旅游计划](mention://agent-session/session-source?workspaceId=workspace-1) 这个计划你锐评一下";
    const displayPrompt =
      "@我打算去泰国旅游，你制定下旅游计划 这个计划你锐评一下";
    const base = detailViewModel();

    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            turns: [
              {
                ...base.turns[0]!,
                userMessage: { id: "user-1", body: mentionPrompt },
                userMessages: [{ id: "user-1", body: mentionPrompt }]
              },
              {
                id: "turn-2",
                userMessage: { id: "user-2", body: "啊？" },
                userMessages: [{ id: "user-2", body: "啊？" }],
                agentMessages: [],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false,
                agentItems: []
              }
            ]
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files",
          userMessageLocator: "User messages"
        }}
      />
    );

    fireEvent.mouseEnter(screen.getByTestId("agent-message-locator"));
    const panel = screen.getByTestId("agent-message-locator-panel");
    expect(within(panel).getByText(displayPrompt)).toBeTruthy();
    expect(within(panel).getByText("啊？")).toBeTruthy();
    expect(within(panel).queryByText(mentionPrompt)).toBeNull();
  });

  it("locates the nearest user message when clicking the locator rail around a dot", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const base = detailViewModel();

    try {
      render(
        <AgentTranscriptView
          conversation={projectAgentConversationVM(
            detailViewModel({
              turns: [
                base.turns[0]!,
                {
                  id: "turn-2",
                  userMessage: { id: "user-2", body: "Follow-up request" },
                  userMessages: [{ id: "user-2", body: "Follow-up request" }],
                  agentMessages: [
                    { id: "assistant-2", body: "Follow-up answer" }
                  ],
                  toolCalls: [],
                  toolCallCount: 0,
                  hasFailedToolCall: false,
                  agentItems: [
                    {
                      kind: "message",
                      message: {
                        id: "assistant-2",
                        body: "Follow-up answer"
                      }
                    }
                  ]
                }
              ]
            })
          )}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files",
            userMessageLocator: "User messages"
          }}
        />
      );

      const locator = screen.getByTestId("agent-message-locator");
      const viewport = screen.getByTestId("agent-message-locator-viewport");
      viewport.getBoundingClientRect = () =>
        ({
          bottom: 96,
          height: 96,
          left: 0,
          right: 36,
          top: 0,
          width: 36,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect;

      fireEvent.click(viewport, { clientY: 34 });

      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "center",
        behavior: "smooth"
      });
      expect(
        locator.querySelectorAll(".agent-gui-message-locator__tick")[1]
      ).toHaveAttribute("data-selected", "true");
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("uses fixed-duration container scrolling for distant user message locator targets", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    vi.useFakeTimers();
    const base = detailViewModel();

    try {
      render(
        <div data-testid="agent-gui-timeline" style={{ overflowY: "auto" }}>
          <AgentTranscriptView
            conversation={projectAgentConversationVM(
              detailViewModel({
                turns: [
                  base.turns[0]!,
                  {
                    id: "turn-2",
                    userMessage: {
                      id: "user-2",
                      body: "Distant follow-up request"
                    },
                    userMessages: [
                      {
                        id: "user-2",
                        body: "Distant follow-up request"
                      }
                    ],
                    agentMessages: [
                      { id: "assistant-2", body: "Distant answer" }
                    ],
                    toolCalls: [],
                    toolCallCount: 0,
                    hasFailedToolCall: false,
                    agentItems: [
                      {
                        kind: "message",
                        message: {
                          id: "assistant-2",
                          body: "Distant answer"
                        }
                      }
                    ]
                  }
                ]
              })
            )}
            labels={{
              thinkingLabel: "Thought process",
              toolCallsLabel: (count) => `Tool calls (${count})`,
              processing: "Planning next moves",
              turnSummary: "Changed files",
              userMessageLocator: "User messages"
            }}
          />
        </div>
      );

      const timeline = screen.getByTestId("agent-gui-timeline");
      Object.defineProperty(timeline, "clientHeight", {
        configurable: true,
        value: 400
      });
      Object.defineProperty(timeline, "scrollHeight", {
        configurable: true,
        value: 4000
      });
      timeline.getBoundingClientRect = () =>
        ({
          bottom: 400,
          height: 400,
          left: 0,
          right: 800,
          top: 0,
          width: 800,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect;
      const distantRow = screen
        .getByText("Distant follow-up request")
        .closest<HTMLElement>("[data-agent-transcript-row]");
      expect(distantRow).toBeTruthy();
      distantRow!.getBoundingClientRect = () =>
        ({
          bottom: 3280,
          height: 80,
          left: 0,
          right: 800,
          top: 3200,
          width: 800,
          x: 0,
          y: 3200,
          toJSON: () => ({})
        }) as DOMRect;

      fireEvent.click(
        screen
          .getByTestId("agent-message-locator")
          .querySelectorAll(".agent-gui-message-locator__tick")[1]!
      );

      expect(scrollIntoView).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(timeline.scrollTop).toBe(3040);
    } finally {
      vi.useRealTimers();
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("keeps the selected locator tick visible through resize without reading viewport geometry", async () => {
    const turns = Array.from({ length: 16 }, (_, index) => ({
      id: `turn-${index + 1}`,
      userMessage: {
        id: `user-${index + 1}`,
        body: `Request ${index + 1}`
      },
      userMessages: [
        {
          id: `user-${index + 1}`,
          body: `Request ${index + 1}`
        }
      ],
      agentMessages: [
        {
          id: `assistant-${index + 1}`,
          body: `Answer ${index + 1}`
        }
      ],
      toolCalls: [],
      toolCallCount: 0,
      hasFailedToolCall: false,
      agentItems: [
        {
          kind: "message" as const,
          message: {
            id: `assistant-${index + 1}`,
            body: `Answer ${index + 1}`
          }
        }
      ]
    }));

    render(
      <div data-testid="agent-gui-timeline">
        <AgentTranscriptView
          conversation={projectAgentConversationVM(detailViewModel({ turns }))}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files",
            userMessageLocator: "User messages"
          }}
        />
      </div>
    );

    const timeline = screen.getByTestId("agent-gui-timeline");
    const locator = screen.getByTestId("agent-message-locator");
    const viewport = screen.getByTestId("agent-message-locator-viewport");
    let timelineClientHeight = 96;
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      get: () => timelineClientHeight
    });
    await flushAnimationFrame();

    let viewportClientHeightReadCount = 0;
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get: () => {
        viewportClientHeightReadCount += 1;
        return timelineClientHeight;
      }
    });

    fireEvent.click(
      locator.querySelectorAll(".agent-gui-message-locator__tick")[14]!
    );

    await waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
    });
    expect(viewportClientHeightReadCount).toBe(0);
    expect(
      locator.querySelectorAll(".agent-gui-message-locator__tick")[14]
    ).toHaveAttribute("data-selected", "true");

    const scrollTopBeforeResize = viewport.scrollTop;
    timelineClientHeight = 120;
    fireEvent(window, new Event("resize"));
    await flushAnimationFrame();

    expect(viewport.scrollTop).toBeLessThan(scrollTopBeforeResize);
    expect(viewportClientHeightReadCount).toBe(0);
  });

  it("keeps a compact locator safety inset above composer scroll padding", async () => {
    const base = detailViewModel();
    render(
      <div
        data-testid="agent-gui-timeline"
        style={{
          overflowY: "auto",
          scrollPaddingBottom: "120px"
        }}
      >
        <AgentTranscriptView
          conversation={projectAgentConversationVM(
            detailViewModel({
              turns: [
                base.turns[0]!,
                {
                  id: "turn-2",
                  userMessage: { id: "user-2", body: "Follow-up request" },
                  userMessages: [{ id: "user-2", body: "Follow-up request" }],
                  agentMessages: [
                    { id: "assistant-2", body: "Follow-up answer" }
                  ],
                  toolCalls: [],
                  toolCallCount: 0,
                  hasFailedToolCall: false,
                  agentItems: [
                    {
                      kind: "message",
                      message: {
                        id: "assistant-2",
                        body: "Follow-up answer"
                      }
                    }
                  ]
                }
              ]
            })
          )}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files",
            userMessageLocator: "User messages"
          }}
        />
      </div>
    );

    Object.defineProperty(
      screen.getByTestId("agent-gui-timeline"),
      "clientHeight",
      {
        configurable: true,
        value: 400
      }
    );
    await flushAnimationFrame();

    expect(screen.getByTestId("agent-message-locator")).toHaveStyle({
      "--agent-message-locator-visible-height": "352px"
    });
  });

  it("contains wheel scrolling inside the message locator panel", () => {
    const timelineWheel = vi.fn();
    const base = detailViewModel();
    render(
      <div data-testid="agent-gui-timeline" onWheel={timelineWheel}>
        <AgentTranscriptView
          conversation={projectAgentConversationVM(
            detailViewModel({
              turns: [
                base.turns[0]!,
                {
                  id: "turn-2",
                  userMessage: { id: "user-2", body: "Follow-up request" },
                  userMessages: [{ id: "user-2", body: "Follow-up request" }],
                  agentMessages: [
                    { id: "assistant-2", body: "Follow-up answer" }
                  ],
                  toolCalls: [],
                  toolCallCount: 0,
                  hasFailedToolCall: false,
                  agentItems: [
                    {
                      kind: "message",
                      message: {
                        id: "assistant-2",
                        body: "Follow-up answer"
                      }
                    }
                  ]
                }
              ]
            })
          )}
          labels={{
            thinkingLabel: "Thought process",
            toolCallsLabel: (count) => `Tool calls (${count})`,
            processing: "Planning next moves",
            turnSummary: "Changed files",
            userMessageLocator: "User messages"
          }}
        />
      </div>
    );

    fireEvent.mouseEnter(screen.getByTestId("agent-message-locator"));
    const panel = screen.getByTestId("agent-message-locator-panel");
    fireEvent.wheel(panel, { deltaY: 48 });

    expect(timelineWheel).not.toHaveBeenCalled();
  });

  it("does not mark loaded historical agent responses as unread", async () => {
    const base = detailViewModel();
    const loadedTurn = {
      id: "turn-2",
      userMessage: { id: "user-2", body: "Follow-up request" },
      userMessages: [{ id: "user-2", body: "Follow-up request" }],
      agentMessages: [{ id: "assistant-2", body: "Follow-up answer" }],
      toolCalls: [],
      toolCallCount: 0,
      hasFailedToolCall: false,
      agentItems: [
        {
          kind: "message" as const,
          message: {
            id: "assistant-2",
            body: "Follow-up answer"
          }
        }
      ]
    };
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files",
      userMessageLocator: "User messages"
    };
    const { rerender } = render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({ turns: [] })
        )}
        labels={labels}
      />
    );

    rerender(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({ turns: [base.turns[0]!, loadedTurn] })
        )}
        labels={labels}
      />
    );

    await act(async () => undefined);
    const locator = screen.getByTestId("agent-message-locator");
    for (const tick of locator.querySelectorAll(
      ".agent-gui-message-locator__tick"
    )) {
      expect(tick).not.toHaveAttribute("data-unread-agent-response", "true");
    }
  });

  it("marks newly answered user message locator ticks as unread until located", async () => {
    const base = detailViewModel();
    const followUpTurn = {
      id: "turn-2",
      userMessage: { id: "user-2", body: "Follow-up request" },
      userMessages: [{ id: "user-2", body: "Follow-up request" }],
      agentMessages: [],
      toolCalls: [],
      toolCallCount: 0,
      hasFailedToolCall: false,
      agentItems: []
    };
    const labels = {
      thinkingLabel: "Thought process",
      toolCallsLabel: (count: number) => `Tool calls (${count})`,
      processing: "Planning next moves",
      turnSummary: "Changed files",
      userMessageLocator: "User messages"
    };
    const conversationForTurns = (
      turns: WorkspaceAgentSessionDetailViewModel["turns"]
    ) => projectAgentConversationVM(detailViewModel({ turns }));
    const { rerender } = render(
      <AgentTranscriptView
        conversation={conversationForTurns([base.turns[0]!, followUpTurn])}
        labels={labels}
      />
    );

    const locator = screen.getByTestId("agent-message-locator");
    const initialTicks = locator.querySelectorAll(
      ".agent-gui-message-locator__tick"
    );
    expect(initialTicks[0]).not.toHaveAttribute(
      "data-unread-agent-response",
      "true"
    );
    expect(initialTicks[1]).not.toHaveAttribute(
      "data-unread-agent-response",
      "true"
    );

    rerender(
      <AgentTranscriptView
        conversation={conversationForTurns([
          base.turns[0]!,
          {
            ...followUpTurn,
            agentMessages: [{ id: "assistant-2", body: "Follow-up answer" }],
            agentItems: [
              {
                kind: "message",
                message: {
                  id: "assistant-2",
                  body: "Follow-up answer"
                }
              }
            ]
          }
        ])}
        labels={labels}
      />
    );

    await waitFor(() => {
      expect(
        locator.querySelectorAll(".agent-gui-message-locator__tick")[1]
      ).toHaveAttribute("data-unread-agent-response", "true");
    });
    expect(
      locator.querySelectorAll(".agent-gui-message-locator__tick")[0]
    ).not.toHaveAttribute("data-unread-agent-response", "true");

    fireEvent.click(
      locator.querySelectorAll(".agent-gui-message-locator__tick")[1]!
    );

    await waitFor(() => {
      expect(
        locator.querySelectorAll(".agent-gui-message-locator__tick")[1]
      ).not.toHaveAttribute("data-unread-agent-response", "true");
    });
  });

  it("renders attached thinking before assistant message content within the same row", () => {
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            turns: [
              {
                ...detailViewModel().turns[0]!,
                agentItems: [
                  {
                    kind: "thinking",
                    thinking: {
                      id: "thinking-1",
                      body: "Need to inspect the workspace first."
                    }
                  },
                  {
                    kind: "message",
                    message: {
                      id: "assistant-1",
                      body: "Assistant answer with [README](/workspace/demo/README.md)"
                    }
                  },
                  {
                    kind: "tool-calls",
                    id: "tools-1",
                    toolCalls: [
                      {
                        id: "call:1",
                        name: "Read File",
                        toolName: "read_file",
                        callType: "tool",
                        status: "Completed" as const,
                        statusKind: "completed" as const,
                        summary: "/workspace/demo/README.md",
                        payload: null
                      }
                    ],
                    toolCallCount: 1,
                    hasFailedToolCall: false,
                    summary: "/workspace/demo/README.md"
                  }
                ]
              }
            ]
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    const thinkingButton = screen.getByRole("button", {
      name: "Thought process"
    });
    const assistantFlow = document.querySelector(
      ".agent-gui-conversation__assistant-message-flow"
    );

    expect(assistantFlow).toBeTruthy();
    expect(assistantFlow?.firstElementChild?.contains(thinkingButton)).toBe(
      true
    );
  });

  it("dispatches workspace link actions from user markdown messages", async () => {
    const onLinkAction = vi.fn();
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            turns: [
              {
                ...detailViewModel().turns[0]!,
                userMessage: {
                  id: "user-1",
                  body: "Please inspect [README.md](/workspace/demo/README.md)"
                },
                userMessages: [
                  {
                    id: "user-1",
                    body: "Please inspect [README.md](/workspace/demo/README.md)"
                  }
                ]
              }
            ]
          })
        )}
        onLinkAction={onLinkAction}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    const fileMention = await waitFor(() => {
      const userMessage = document.querySelector(
        ".workspace-agents-status-panel__detail-user-message"
      );
      const mention = userMessage?.querySelector(
        '[data-agent-file-mention="true"]'
      );
      expect(mention).not.toBeNull();
      return mention as Element;
    });

    expect(fileMention).not.toBeNull();
    fireEvent.click(fileMention);

    expect(onLinkAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "open-workspace-file",
        path: "/workspace/demo/README.md"
      })
    );
  });

  it("renders agent markdown relative links as plain text", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            cwd: "/workspace/demo/reports",
            turns: [
              {
                ...detailViewModel().turns[0]!,
                agentMessages: [
                  {
                    id: "assistant-1",
                    body: "已改：[stock-dashboard.html](stock-dashboard.html)"
                  }
                ],
                agentItems: [
                  {
                    kind: "message",
                    message: {
                      id: "assistant-1",
                      body: "已改：[stock-dashboard.html](stock-dashboard.html)"
                    }
                  }
                ],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false
              }
            ]
          })
        )}
        onLinkAction={onLinkAction}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    expect(
      screen.queryByRole("link", { name: "stock-dashboard.html" })
    ).toBeNull();
    expect(screen.getByText("stock-dashboard.html")).toBeTruthy();
    expect(onLinkAction).not.toHaveBeenCalled();
  });

  it("opens explicit Markdown links to local absolute paths", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            cwd: "/Users/example/demo",
            workspaceRoot: "/Users/example/demo",
            turns: [
              {
                ...detailViewModel().turns[0]!,
                agentMessages: [
                  {
                    id: "assistant-1",
                    body: "工作区路径：[/Users/example/demo/output/imagegen/dancing-girl.png](/Users/example/demo/output/imagegen/dancing-girl.png)"
                  }
                ],
                agentItems: [
                  {
                    kind: "message",
                    message: {
                      id: "assistant-1",
                      body: "工作区路径：[/Users/example/demo/output/imagegen/dancing-girl.png](/Users/example/demo/output/imagegen/dancing-girl.png)"
                    }
                  }
                ],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false
              }
            ]
          })
        )}
        onLinkAction={onLinkAction}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("link", {
        name: "/Users/example/demo/output/imagegen/dancing-girl.png"
      })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "/Users/example/demo/output/imagegen/dancing-girl.png",
      directoryPath: "/Users/example/demo/output/imagegen",
      workspaceRoot: "/Users/example/demo",
      source: "agent-markdown"
    });
  });

  it("opens explicit Markdown links from no-project session directories", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            session: normalizeAgentActivitySession({
              ...{
                activeTurnId: null,
                latestTurnInteractions: [],
                pendingInteractions: []
              },
              workspaceId: "workspace-1",
              agentSessionId: "session-1",
              userId: "user-1",
              provider: "opencode",
              providerSessionId: "provider-session-1",
              cwd: "/Users/example/Documents/tutti/session-1",
              title: "OpenCode",
              createdAtUnixMs: 1,
              updatedAtUnixMs: 10
            }),
            cwd: "/Users/example/Documents/tutti/session-1",
            workspaceRoot: null,
            turns: [
              {
                ...detailViewModel().turns[0]!,
                agentMessages: [
                  {
                    id: "assistant-1",
                    body: "打开 [/Users/example/Documents/tutti/session-1/index.html](/Users/example/Documents/tutti/session-1/index.html)"
                  }
                ],
                agentItems: [
                  {
                    kind: "message",
                    message: {
                      id: "assistant-1",
                      body: "打开 [/Users/example/Documents/tutti/session-1/index.html](/Users/example/Documents/tutti/session-1/index.html)"
                    }
                  }
                ],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false
              }
            ]
          })
        )}
        onLinkAction={onLinkAction}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("link", {
        name: "/Users/example/Documents/tutti/session-1/index.html"
      })
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-file",
      path: "/Users/example/Documents/tutti/session-1/index.html",
      directoryPath: "/Users/example/Documents/tutti/session-1",
      workspaceRoot: "/Users/example/Documents/tutti/session-1",
      source: "agent-markdown"
    });
  });

  it("opens a zoom preview for assistant markdown images", async () => {
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
      value: vi.fn(() => "blob:transcript-image")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            cwd: "/Users/example/demo",
            workspaceRoot: "/Users/example/demo",
            turns: [
              {
                ...detailViewModel().turns[0]!,
                agentMessages: [
                  {
                    id: "assistant-1",
                    body: "![generated image](/Users/example/demo/output/imagegen/dancing-girl.png)"
                  }
                ],
                agentItems: [
                  {
                    kind: "message",
                    message: {
                      id: "assistant-1",
                      body: "![generated image](/Users/example/demo/output/imagegen/dancing-girl.png)"
                    }
                  }
                ],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false
              }
            ]
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Zoom image|common\.expandImage/
      })
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith({
      path: "/Users/example/demo/output/imagegen/dancing-girl.png"
    });
  });

  it("renders adjacent assistant message fragments inside a single assistant flow", () => {
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            turns: [
              {
                ...detailViewModel().turns[0]!,
                agentMessages: [
                  { id: "assistant-1", body: "现在可直接访问：`http://" },
                  { id: "assistant-2", body: "0.0.0.0:4173`" }
                ],
                agentItems: [
                  {
                    kind: "message",
                    message: {
                      id: "assistant-1",
                      body: "现在可直接访问：`http://"
                    }
                  },
                  {
                    kind: "message",
                    message: { id: "assistant-2", body: "0.0.0.0:4173`" }
                  }
                ],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false
              }
            ]
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    expect(
      document.querySelectorAll(
        ".agent-gui-conversation__assistant-message-flow"
      )
    ).toHaveLength(1);
    expect(screen.getByText("http://0.0.0.0:4173")).toBeTruthy();
  });

  it("renders thinking entries between tool calls inside the grouped disclosure", async () => {
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            session: {
              ...detailViewModel().session
            },
            showProcessingIndicator: false,
            turns: [
              {
                id: "turn-1",
                userMessage: { id: "user-1", body: "Ship the patch" },
                userMessages: [{ id: "user-1", body: "Ship the patch" }],
                agentMessages: [],
                toolCalls: [
                  {
                    id: "call:1",
                    name: "Read file",
                    toolName: "read_file",
                    callType: "tool",
                    status: "Completed",
                    statusKind: "completed",
                    summary: "/workspace/demo/README.md",
                    payload: null
                  },
                  {
                    id: "call:2",
                    name: "Edit file",
                    toolName: "edit_file",
                    callType: "tool",
                    status: "Completed",
                    statusKind: "completed",
                    summary: "/workspace/demo/src/App.tsx",
                    payload: null
                  }
                ],
                toolCallCount: 2,
                hasFailedToolCall: false,
                agentItems: [
                  {
                    kind: "tool-calls",
                    id: "tools-1",
                    toolCalls: [
                      {
                        id: "call:1",
                        name: "Read file",
                        toolName: "read_file",
                        callType: "tool",
                        status: "Completed",
                        statusKind: "completed",
                        summary: "/workspace/demo/README.md",
                        payload: null
                      },
                      {
                        id: "call:2",
                        name: "Edit file",
                        toolName: "edit_file",
                        callType: "tool",
                        status: "Completed",
                        statusKind: "completed",
                        summary: "/workspace/demo/src/App.tsx",
                        payload: null
                      }
                    ],
                    toolCallCount: 2,
                    hasFailedToolCall: false,
                    summary: "Changed App.tsx",
                    groupEntries: [
                      {
                        kind: "tool-call",
                        call: {
                          id: "call:1",
                          name: "Read file",
                          toolName: "read_file",
                          callType: "tool",
                          status: "Completed",
                          statusKind: "completed",
                          summary: "/workspace/demo/README.md",
                          payload: null
                        }
                      },
                      {
                        kind: "thinking",
                        thinking: {
                          id: "thinking-1",
                          body: "Need to inspect the workspace first."
                        }
                      },
                      {
                        kind: "tool-call",
                        call: {
                          id: "call:2",
                          name: "Edit file",
                          toolName: "edit_file",
                          callType: "tool",
                          status: "Completed",
                          statusKind: "completed",
                          summary: "/workspace/demo/src/App.tsx",
                          payload: null
                        }
                      }
                    ]
                  }
                ]
              }
            ]
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Tool calls (2)" }));
    await flushCollapsibleRevealFrames();
    expect(
      screen.getByRole("button", {
        name: /Read file Completed .*README\.md/,
        hidden: true
      })
    ).toBeTruthy();
    expect(screen.getByText("Edit file")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Thought process", hidden: true })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Thought process", hidden: true })
    );
    await flushCollapsibleRevealFrames();
    expect(
      screen.getByText("Need to inspect the workspace first.")
    ).toBeTruthy();
  });

  it("renders the changed-file turn summary after the turn completes", async () => {
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            activity: {
              ...detailViewModel().activity,
              changedFiles: [
                { path: "src/App.tsx", label: "src/App.tsx" },
                { path: "src/routes.ts", label: "src/routes.ts" }
              ]
            },
            session: {
              ...detailViewModel().session,
              latestTurn: {
                agentSessionId: "session-1",
                turnId: "turn-1",
                phase: "settled",
                origin: "user_prompt",
                outcome: "completed",
                startedAtUnixMs: 1,
                settledAtUnixMs: 10,
                updatedAtUnixMs: 10,
                fileChanges: {
                  files: [
                    {
                      path: "/workspace/demo/src/App.tsx",
                      change: "modified"
                    },
                    {
                      path: "/workspace/demo/src/routes.ts",
                      change: "added"
                    }
                  ]
                }
              }
            },
            sessionTurns: [
              {
                agentSessionId: "session-1",
                turnId: "turn-1",
                phase: "settled",
                origin: "user_prompt",
                outcome: "completed",
                startedAtUnixMs: 1,
                settledAtUnixMs: 10,
                updatedAtUnixMs: 10,
                fileChanges: {
                  files: [
                    {
                      path: "/workspace/demo/src/App.tsx",
                      change: "modified"
                    },
                    {
                      path: "/workspace/demo/src/routes.ts",
                      change: "added"
                    }
                  ]
                }
              }
            ],
            showProcessingIndicator: false
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand task details" })
    );
    await flushCollapsibleRevealFrames();
    await flushCollapsibleRevealFrames();
    expect(
      screen.getByText("agentHost.agentGui.turnSummaryFilesChanged")
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /App\.tsx/i
      })
    );
    await flushCollapsibleRevealFrames();
    expect(screen.getByTitle("/workspace/demo/src/App.tsx")).toBeTruthy();
    expect(screen.getByTitle("/workspace/demo/src/routes.ts")).toBeTruthy();
  });

  it("renders visible agent errors as an alert with collapsible details", async () => {
    render(
      <AgentTranscriptView
        conversation={projectAgentConversationVM(
          detailViewModel({
            turns: [
              {
                id: "turn-1",
                userMessage: { id: "user-1", body: "Start Hermes" },
                userMessages: [{ id: "user-1", body: "Start Hermes" }],
                agentMessages: [
                  {
                    id: "error-1",
                    body: "Hermes failed to start.",
                    visibleError: {
                      code: "process_exited",
                      phase: "start",
                      provider: "hermes",
                      detail: "Config invalid",
                      retryable: false
                    }
                  }
                ],
                toolCalls: [],
                toolCallCount: 0,
                hasFailedToolCall: false,
                agentItems: [
                  {
                    kind: "message",
                    message: {
                      id: "error-1",
                      body: "Hermes failed to start.",
                      visibleError: {
                        code: "process_exited",
                        phase: "start",
                        provider: "hermes",
                        detail: "Config invalid",
                        retryable: false
                      }
                    }
                  }
                ]
              }
            ]
          })
        )}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Planning next moves",
          turnSummary: "Changed files"
        }}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(
      screen.getByText("agentHost.agentGui.visibleErrorStartFailed")
    ).toBeTruthy();
    const detailsToggle = screen.getByRole("button", {
      name: "agentHost.agentGui.visibleErrorRawDetails"
    });
    expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Config invalid")).toBeNull();

    fireEvent.click(detailsToggle);
    await flushCollapsibleRevealFrames();
    expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByText("Config invalid");
    expect(details).toBeTruthy();
  });
});

async function flushCollapsibleRevealFrames(): Promise<void> {
  await flushAnimationFrame();
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function detailViewModel(
  overrides: Partial<WorkspaceAgentSessionDetailViewModel> = {}
): WorkspaceAgentSessionDetailViewModel {
  return {
    activity: {
      id: "activity-1",
      sessionId: "session-1",
      agentName: "Codex",
      agentProvider: "codex",
      title: "Codex",
      latestActivitySummary: "Working",
      status: "working",
      sortTimeUnixMs: 10,
      changedFiles: [],
      userId: "user-1",
      userName: "Taylor",
      userAvatarUrl: ""
    },
    session: normalizeAgentActivitySession({
      ...{
        activeTurnId: null,
        latestTurnInteractions: [],
        pendingInteractions: []
      },
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      userId: "user-1",
      provider: "codex",
      providerSessionId: "provider-session-1",
      cwd: "/workspace/demo",
      title: "Codex",
      createdAtUnixMs: 1,
      updatedAtUnixMs: 10
    }),
    cwd: "/workspace/demo",
    workspaceRoot: "/workspace/demo",
    turns: [
      {
        id: "turn-1",
        userMessage: { id: "user-1", body: "User asks for a fix" },
        userMessages: [{ id: "user-1", body: "User asks for a fix" }],
        agentMessages: [
          {
            id: "assistant-1",
            body: "Assistant answer with [README](/workspace/demo/README.md)"
          }
        ],
        toolCalls: [
          {
            id: "call:1",
            name: "Read File",
            toolName: "read_file",
            callType: "tool",
            status: "Completed" as const,
            statusKind: "completed" as const,
            summary: "/workspace/demo/README.md",
            payload: null
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: [
          {
            kind: "message",
            message: {
              id: "assistant-1",
              body: "Assistant answer with [README](/workspace/demo/README.md)"
            }
          },
          {
            kind: "thinking",
            thinking: {
              id: "thinking-1",
              body: "Need to inspect the workspace first."
            }
          },
          {
            kind: "tool-calls",
            id: "tools-1",
            toolCalls: [
              {
                id: "call:1",
                name: "Read File",
                toolName: "read_file",
                callType: "tool",
                status: "Completed" as const,
                statusKind: "completed" as const,
                summary: "/workspace/demo/README.md",
                payload: null
              }
            ],
            toolCallCount: 1,
            hasFailedToolCall: false
          }
        ]
      }
    ],
    ...overrides
  };
}

function canonicalTurn(
  overrides: Partial<
    NonNullable<WorkspaceAgentSessionDetailViewModel["sessionTurns"]>[number]
  > = {}
): NonNullable<WorkspaceAgentSessionDetailViewModel["sessionTurns"]>[number] {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt",
    phase: "running",
    startedAtUnixMs: 5_000,
    turnId: "turn-1",
    updatedAtUnixMs: 6_000,
    ...overrides
  };
}

function translateTestKey(
  key: string,
  options: Record<string, unknown> = {}
): string {
  const minutes = Number(options.minutes ?? 0);
  const seconds = Number(options.seconds ?? 0);
  switch (key) {
    case "agentHost.agentGui.turnProcessedSeconds":
      return `Processed for ${seconds}s`;
    case "agentHost.agentGui.turnProcessedMinutes":
      return `Processed for ${minutes}m`;
    case "agentHost.agentGui.turnProcessedMinutesSeconds":
      return `Processed for ${minutes}m ${seconds}s`;
    case "agentHost.agentGui.turnTotalSeconds":
      return `Total ${seconds}s`;
    case "agentHost.agentGui.turnTotalMinutes":
      return `Total ${minutes}m`;
    case "agentHost.agentGui.turnTotalMinutesSeconds":
      return `Total ${minutes}m ${seconds}s`;
    case "agentHost.agentGui.expandTurnWork":
      return "Expand task details";
    case "agentHost.agentGui.collapseTurnWork":
      return "Collapse task details";
    default:
      return key;
  }
}
