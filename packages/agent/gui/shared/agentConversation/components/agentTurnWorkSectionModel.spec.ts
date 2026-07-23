import { describe, expect, it } from "vitest";
import type { AgentActivityTurn } from "@tutti-os/agent-activity-core";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import type { AgentTranscriptTurnGroup } from "./agentTranscriptModel";
import {
  buildAgentTurnWorkSectionModel as buildOptionalAgentTurnWorkSectionModel,
  formatAgentTurnDuration,
  resolveAgentTurnTiming
} from "./agentTurnWorkSectionModel";

describe("agentTurnWorkSectionModel", () => {
  it("uses canonical turn timestamps for live and settled elapsed time", () => {
    expect(
      resolveAgentTurnTiming(canonicalTurn({ phase: "running" }), true)
    ).toEqual({ kind: "live", startedAtUnixMs: 5_000 });

    expect(
      resolveAgentTurnTiming(canonicalTurn({ phase: "running" }), false)
    ).toBeNull();

    expect(
      resolveAgentTurnTiming(canonicalTurn({ phase: "waiting" }), true)
    ).toEqual({ kind: "live", startedAtUnixMs: 5_000 });
    expect(
      resolveAgentTurnTiming(canonicalTurn({ phase: "submitted" }), true)
    ).toEqual({ kind: "live", startedAtUnixMs: 5_000 });
    expect(
      resolveAgentTurnTiming(canonicalTurn({ phase: "settling" }), true)
    ).toEqual({ kind: "live", startedAtUnixMs: 5_000 });

    expect(
      resolveAgentTurnTiming(
        canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 127_999
        }),
        false
      )
    ).toEqual({
      kind: "settled",
      elapsedSeconds: 122,
      stages: {
        startupSeconds: null,
        firstResponseSeconds: null,
        generationSeconds: null,
        finalizationSeconds: null
      }
    });

    expect(
      resolveAgentTurnTiming(
        canonicalTurn({ startedAtUnixMs: Number.NaN }),
        true
      )
    ).toBeNull();
    expect(
      resolveAgentTurnTiming(
        canonicalTurn({ phase: "settled", settledAtUnixMs: 4_999 }),
        false
      )
    ).toBeNull();
  });

  it("counts from client submission and splits settled turn stages", () => {
    const prompt = {
      ...message("Please fix it", null),
      occurredAtUnixMs: 2_000,
      sourceTimelineItems: [
        {
          id: 1,
          agentSessionId: "session-1",
          eventId: "user-1",
          actorType: "user",
          actorId: "user",
          itemType: "message",
          payload: { clientSubmittedAtUnixMs: 1_000 },
          occurredAtUnixMs: 2_000
        }
      ]
    };
    const reply = {
      ...message("Final answer", "Final answer", true),
      occurredAtUnixMs: 10_000,
      sourceTimelineItems: [
        {
          id: 2,
          agentSessionId: "session-1",
          eventId: "assistant-1",
          actorType: "agent",
          actorId: "session-1",
          itemType: "message",
          startedAtUnixMs: 10_000,
          completedAtUnixMs: 12_000
        }
      ]
    };

    const model = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow({ occurredAtUnixMs: 2_000, messages: [prompt] }),
        assistantRow({ occurredAtUnixMs: 10_000, messages: [reply] })
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        startedAtUnixMs: 6_000,
        settledAtUnixMs: 13_000
      })
    );

    expect(model.timing).toEqual({
      kind: "settled",
      elapsedSeconds: 12,
      stages: {
        startupSeconds: 5,
        firstResponseSeconds: 4,
        generationSeconds: 2,
        finalizationSeconds: 1
      }
    });
  });

  it("formats seconds and minute boundaries without a zero-second suffix", () => {
    expect(formatAgentTurnDuration(45)).toEqual({
      kind: "seconds",
      seconds: 45
    });
    expect(formatAgentTurnDuration(60)).toEqual({
      kind: "minutes",
      minutes: 1
    });
    expect(formatAgentTurnDuration(127)).toEqual({
      kind: "minutes-seconds",
      minutes: 2,
      seconds: 7
    });
  });

  it("does not create a disclosure model without canonical timing", () => {
    expect(
      buildOptionalAgentTurnWorkSectionModel(turnGroup([userRow()]), null)
    ).toBeNull();
    expect(
      buildOptionalAgentTurnWorkSectionModel(
        turnGroup([userRow()]),
        canonicalTurn({ phase: "running" }),
        false
      )
    ).toBeNull();
  });

  it("keeps the final assistant copy target visible and moves work around it", () => {
    const model = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow(),
        assistantRow({
          id: "assistant-row",
          messages: [
            message("draft", null),
            message("final", "Final answer", true),
            message("epilogue", null)
          ],
          thinking: [thinking("Inspecting files")]
        }),
        toolRow(),
        summaryRow()
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      }),
      false,
      { collapseIntermediateAssistantReplies: true }
    );

    expect(model.leadingRows).toHaveLength(1);
    expect(model.sections.map((section) => section.kind)).toEqual([
      "work",
      "visible",
      "work"
    ]);
    expect(model.collapseEligible).toBe(true);

    const finalRow = model.sections[1]?.rows[0]?.row;
    expect(finalRow?.kind).toBe("message");
    if (finalRow?.kind === "message") {
      expect(finalRow.id).toBe("assistant-row");
      expect(finalRow.messages.map((item) => item.body)).toEqual(["final"]);
      expect(finalRow.thinking).toEqual([]);
    }
    expect(model.sections[0]?.rows[0]?.renderKey).toBe(
      "assistant-row:turn-work-before"
    );
    expect(model.sections[1]?.rows[0]?.renderKey).toBe(
      "assistant-row:turn-final"
    );
    expect(model.sections[2]?.rows[0]?.renderKey).toBe(
      "assistant-row:turn-work-after"
    );
    const afterFinalRow = model.sections[2]?.rows[0]?.row;
    expect(afterFinalRow?.kind).toBe("message");
    if (afterFinalRow?.kind === "message") {
      expect(afterFinalRow.messages.map((item) => item.body)).toEqual([
        "epilogue"
      ]);
    }
  });

  it("uses an explicit final-text marker instead of copy availability", () => {
    const model = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow(),
        toolRow(),
        assistantRow({
          messages: [message("Visible final answer", null, true)]
        })
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      }),
      false,
      { collapseIntermediateAssistantReplies: true }
    );

    expect(model.collapseEligible).toBe(true);
    expect(model.sections).toHaveLength(2);
    expect(model.sections[1]?.rows[0]?.row.kind).toBe("message");
  });

  it("preserves interleaved user and assistant chronology in ordered sections", () => {
    const model = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow(),
        assistantRow({
          id: "assistant-1",
          messages: [message("Earlier answer", null)]
        }),
        userRow({
          id: "user-2",
          messages: [message("Follow-up", null)],
          occurredAtUnixMs: 9_000
        }),
        toolRow(),
        assistantRow({
          id: "assistant-2",
          messages: [message("Final answer", "Final answer", true)]
        })
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      }),
      false,
      { collapseIntermediateAssistantReplies: true }
    );

    expect(model.leadingRows.map(({ row }) => row.id)).toEqual(["user-row"]);
    expect(
      model.sections.map((section) => ({
        kind: section.kind,
        rowIds: section.rows.map(({ row }) => row.id)
      }))
    ).toEqual([
      { kind: "work", rowIds: ["assistant-1"] },
      { kind: "visible", rowIds: ["user-2"] },
      { kind: "work", rowIds: ["tools"] },
      { kind: "visible", rowIds: ["assistant-2"] }
    ]);
  });

  it("collapses all assistant work before the final answer for Tutti-created conversations", () => {
    const model = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow(),
        assistantRow({
          id: "assistant-progress",
          messages: [
            {
              ...message("Compacting context", null),
              presentationKind: "specific-progress"
            },
            message("Earlier answer", null)
          ],
          thinking: [thinking("Inspecting files")]
        }),
        assistantRow({
          id: "assistant-final",
          messages: [message("Final answer", "Final answer", true)]
        })
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      }),
      false,
      { collapseIntermediateAssistantReplies: true }
    );

    expect(
      model.sections.map((section) => ({
        kind: section.kind,
        bodies: section.rows.flatMap(({ row }) =>
          row.kind === "message"
            ? [
                ...row.thinking.map((item) => item.body),
                ...row.messages.map((item) => item.body)
              ]
            : []
        )
      }))
    ).toEqual([
      {
        kind: "work",
        bodies: ["Inspecting files", "Compacting context", "Earlier answer"]
      },
      {
        kind: "visible",
        bodies: ["Final answer"]
      }
    ]);
    expect(model.collapseEligible).toBe(true);
  });

  it("preserves ordinary assistant replies for imported conversation history", () => {
    const model = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow(),
        assistantRow({
          id: "assistant-earlier",
          messages: [message("Earlier answer", null)]
        }),
        toolRow(),
        assistantRow({
          id: "assistant-final",
          messages: [message("Final answer", "Final answer", true)]
        })
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      }),
      false,
      { collapseIntermediateAssistantReplies: false }
    );

    expect(
      model.sections.map((section) => ({
        kind: section.kind,
        bodies: section.rows.flatMap(({ row }) =>
          row.kind === "message" ? row.messages.map((item) => item.body) : []
        )
      }))
    ).toEqual([
      { kind: "visible", bodies: ["Earlier answer"] },
      { kind: "work", bodies: [] },
      { kind: "visible", bodies: ["Final answer"] }
    ]);
  });

  it("fails open when no visible final text is explicitly marked", () => {
    const copyOnly = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow(),
        toolRow(),
        assistantRow({ messages: [message("Copy only", "Copy only")] })
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      })
    );
    const blankMarked = buildAgentTurnWorkSectionModel(
      turnGroup([
        userRow(),
        toolRow(),
        assistantRow({ messages: [message("   ", null, true)] })
      ]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      })
    );

    expect(copyOnly.collapseEligible).toBe(false);
    expect(blankMarked.collapseEligible).toBe(false);
  });

  it("does not offer auto-collapse for abnormal or artifact-first turns", () => {
    const rows = [userRow(), toolRow(), assistantRow(), summaryRow()];

    expect(
      buildAgentTurnWorkSectionModel(
        turnGroup(rows),
        canonicalTurn({
          phase: "settled",
          outcome: "failed",
          settledAtUnixMs: 15_000
        })
      ).collapseEligible
    ).toBe(false);

    expect(
      buildAgentTurnWorkSectionModel(
        turnGroup([...rows, generatedImageRow()]),
        canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 15_000
        })
      ).collapseEligible
    ).toBe(false);

    expect(
      buildAgentTurnWorkSectionModel(
        turnGroup([
          userRow(),
          assistantRow({
            messages: [
              {
                ...message("Config invalid", null),
                visibleError: {
                  code: "invalid_config",
                  phase: null,
                  provider: "codex",
                  detail: "Config invalid",
                  retryable: false
                }
              },
              message("final", "Final answer", true)
            ]
          })
        ]),
        canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 15_000
        })
      ).collapseEligible
    ).toBe(false);
  });

  it("shows timing without a disclosure when a completed turn has only a final answer", () => {
    const model = buildAgentTurnWorkSectionModel(
      turnGroup([userRow(), assistantRow()]),
      canonicalTurn({
        phase: "settled",
        outcome: "completed",
        settledAtUnixMs: 15_000
      })
    );

    expect(model.timing).toEqual({
      kind: "settled",
      elapsedSeconds: 10,
      stages: {
        startupSeconds: 0,
        firstResponseSeconds: 9,
        generationSeconds: 0,
        finalizationSeconds: 1
      }
    });
    expect(model.collapseEligible).toBe(false);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]?.kind).toBe("visible");
  });
});

function canonicalTurn(
  overrides: Partial<AgentActivityTurn> = {}
): AgentActivityTurn {
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

function buildAgentTurnWorkSectionModel(
  ...args: Parameters<typeof buildOptionalAgentTurnWorkSectionModel>
): NonNullable<ReturnType<typeof buildOptionalAgentTurnWorkSectionModel>> {
  const model = buildOptionalAgentTurnWorkSectionModel(...args);
  expect(model).not.toBeNull();
  return model!;
}

function turnGroup(rows: AgentTranscriptRowVM[]): AgentTranscriptTurnGroup {
  return {
    key: "turn-1",
    turnId: "turn-1",
    rows: rows.map((row, rowIndex) => ({ row, rowIndex }))
  };
}

function userRow(
  overrides: Partial<Extract<AgentTranscriptRowVM, { kind: "message" }>> = {}
): AgentTranscriptRowVM {
  return {
    kind: "message",
    id: "user-row",
    turnId: "turn-1",
    speaker: "user",
    messages: [message("Please fix it", null)],
    thinking: [],
    occurredAtUnixMs: 5_000,
    ...overrides
  };
}

function assistantRow(
  overrides: Partial<Extract<AgentTranscriptRowVM, { kind: "message" }>> = {}
): AgentTranscriptRowVM {
  return {
    kind: "message",
    id: "assistant-row",
    turnId: "turn-1",
    speaker: "assistant",
    messages: [message("Final answer", "Final answer", true)],
    thinking: [],
    occurredAtUnixMs: 14_000,
    ...overrides
  };
}

function message(
  body: string,
  copyText: string | null,
  isTurnFinalText = false
) {
  return {
    kind: "message-content" as const,
    id: `message:${body}`,
    turnId: "turn-1",
    body,
    presentationKind: "content" as const,
    copyText,
    ...(isTurnFinalText ? { isTurnFinalText: true as const } : {}),
    occurredAtUnixMs: 14_000
  };
}

function thinking(body: string) {
  return {
    kind: "thinking-content" as const,
    id: `thinking:${body}`,
    turnId: "turn-1",
    body,
    occurredAtUnixMs: 7_000
  };
}

function toolRow(): AgentTranscriptRowVM {
  return {
    kind: "tool-group",
    id: "tools",
    turnId: "turn-1",
    grouped: true,
    calls: [],
    entries: [],
    occurredAtUnixMs: 8_000
  };
}

function summaryRow(): AgentTranscriptRowVM {
  return {
    kind: "turn-summary",
    id: "summary",
    turnId: "turn-1",
    files: [],
    fileCount: 0,
    modifiedCount: 0,
    createdCount: 0,
    occurredAtUnixMs: 15_000
  };
}

function generatedImageRow(): AgentTranscriptRowVM {
  return {
    kind: "generated-image",
    id: "image",
    turnId: "turn-1",
    sourceCallId: "image-call",
    uri: "file:///tmp/image.png",
    mimeType: "image/png",
    prompt: "A test image",
    occurredAtUnixMs: 12_000
  };
}
