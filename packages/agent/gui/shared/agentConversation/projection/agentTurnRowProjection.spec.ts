import { describe, expect, it } from "vitest";
import type {
  AgentMessageContentVM,
  AgentThinkingContentVM
} from "../contracts/agentMessageRowVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import {
  computeAgentToolGroups,
  type AgentComputedToolGroupVM
} from "./agentToolGroupingProjection";
import type { AgentTurnSequenceItemVM } from "./agentTurnSequenceProjection";
import {
  renderRun,
  tagOf,
  thinkingAbsorbedByMessage,
  toRenderUnits,
  projectTurnRows,
  type AgentRenderUnit
} from "./agentTurnRowProjection";

const TURN = "turn-1";

function thinking(
  id: string,
  ts: number | null = null
): AgentThinkingContentVM {
  return {
    kind: "thinking-content",
    id,
    turnId: TURN,
    body: id,
    occurredAtUnixMs: ts
  };
}

function message(id: string, ts: number | null = null): AgentMessageContentVM {
  return {
    kind: "message-content",
    id,
    turnId: TURN,
    body: id,
    occurredAtUnixMs: ts
  };
}

function toolCall(id: string): AgentToolCallVM {
  return {
    kind: "tool-call",
    id,
    turnId: TURN,
    rendererKind: "default",
    summary: id,
    compactSummary: null,
    occurredAtUnixMs: null
  } as AgentToolCallVM;
}

const thinkingItem = (id: string): AgentTurnSequenceItemVM => ({
  kind: "thinking",
  thinking: thinking(id)
});
const messageItem = (id: string): AgentTurnSequenceItemVM => ({
  kind: "assistant-message",
  message: message(id)
});
const userMessageItem = (id: string): AgentTurnSequenceItemVM => ({
  kind: "user-message",
  row: {
    kind: "message",
    id: `message:user:${id}`,
    turnId: TURN,
    speaker: "user",
    messages: [message(id)],
    thinking: [],
    occurredAtUnixMs: null
  }
});
const toolItem = (id: string): AgentTurnSequenceItemVM => ({
  kind: "tool-call",
  call: toolCall(id)
});

const noGroups = new Map<number, AgentComputedToolGroupVM>();
const noSkips = new Set<number>();

describe("tagOf", () => {
  const table: { item: AgentTurnSequenceItemVM; expected: string }[] = [
    { item: userMessageItem("u"), expected: "user-message" },
    { item: messageItem("m"), expected: "message" },
    { item: thinkingItem("t"), expected: "thinking" },
    { item: toolItem("c"), expected: "tool" }
  ];
  for (const { item, expected } of table) {
    it(`classifies ${item.kind} as ${expected}`, () => {
      expect(tagOf(item)).toBe(expected);
    });
  }
});

describe("thinkingAbsorbedByMessage", () => {
  const u = {
    thinking: { tag: "thinking", thinking: thinking("t") } as AgentRenderUnit,
    message: { tag: "message", message: message("m") } as AgentRenderUnit,
    tool: { tag: "tool", call: toolCall("c") } as AgentRenderUnit
  };
  const table: {
    previous: AgentRenderUnit;
    current: AgentRenderUnit;
    expected: boolean;
  }[] = [
    { previous: u.thinking, current: u.message, expected: true },
    { previous: u.thinking, current: u.thinking, expected: false },
    { previous: u.thinking, current: u.tool, expected: false },
    { previous: u.message, current: u.message, expected: false },
    { previous: u.tool, current: u.message, expected: false }
  ];
  for (const { previous, current, expected } of table) {
    it(`${previous.tag} -> ${current.tag} = ${expected}`, () => {
      expect(thinkingAbsorbedByMessage(previous, current)).toBe(expected);
    });
  }
});

describe("toRenderUnits", () => {
  it("tags message/thinking/tool items in order", () => {
    const units = toRenderUnits(
      [thinkingItem("t"), messageItem("m"), toolItem("c")],
      noGroups,
      noSkips
    );
    expect(units.map((unit) => unit.tag)).toEqual([
      "thinking",
      "message",
      "tool"
    ]);
  });

  it("keeps user messages in the turn sequence", () => {
    const units = toRenderUnits(
      [messageItem("m1"), userMessageItem("u"), messageItem("m2")],
      noGroups,
      noSkips
    );
    expect(units.map((unit) => unit.tag)).toEqual([
      "message",
      "user-message",
      "message"
    ]);
  });

  it("emits one unit per group and skips its span", () => {
    const sequence = [toolItem("c0"), toolItem("c1"), messageItem("m")];
    const group: AgentComputedToolGroupVM = {
      startIndex: 0,
      endIndex: 1,
      calls: [toolCall("c0"), toolCall("c1")],
      entries: []
    };
    const units = toRenderUnits(
      sequence,
      new Map([[0, group]]),
      new Set([0, 1])
    );
    expect(units.map((unit) => unit.tag)).toEqual(["tool-group", "message"]);
  });

  it("drops suppressed indices so neighbours become adjacent", () => {
    // thinking, <suppressed tool>, message  ->  thinking is now adjacent to message
    const units = toRenderUnits(
      [thinkingItem("t"), toolItem("c"), messageItem("m")],
      noGroups,
      new Set([1])
    );
    expect(units.map((unit) => unit.tag)).toEqual(["thinking", "message"]);
  });
});

describe("computeAgentToolGroups", () => {
  it("does not group tool calls across a mid-turn user message", () => {
    const result = computeAgentToolGroups(
      [
        toolItem("c0"),
        toolItem("c1"),
        userMessageItem("u"),
        toolItem("c2"),
        toolItem("c3")
      ],
      {}
    );

    expect(
      [...result.groups.values()].map((group) =>
        group.calls.map((call) => call.id)
      )
    ).toEqual([
      ["c0", "c1"],
      ["c2", "c3"]
    ]);
  });
});

describe("renderRun", () => {
  it("renders a tool group row", () => {
    const group: AgentComputedToolGroupVM = {
      startIndex: 0,
      endIndex: 1,
      calls: [toolCall("c0"), toolCall("c1")],
      entries: []
    };
    const row = renderRun([{ tag: "tool-group", group }], TURN);
    expect(row.kind).toBe("tool-group");
    expect(row.id).toBe(`tool-group:${TURN}:c0+c1`);
  });

  it("renders a single tool row", () => {
    const row = renderRun([{ tag: "tool", call: toolCall("c") }], TURN);
    expect(row.kind).toBe("tool-group");
    expect(row.id).toBe("tool-row:c");
  });

  it("renders a lone thinking row carrying its thinking", () => {
    const row = renderRun(
      [{ tag: "thinking", thinking: thinking("t", 5) }],
      TURN
    );
    expect(row).toMatchObject({
      kind: "message",
      id: `message:thinking:${TURN}:t`,
      messages: [],
      occurredAtUnixMs: 5
    });
    expect(
      row.kind === "message" && row.thinking.map((entry) => entry.id)
    ).toEqual(["t"]);
  });

  it("renders a message row that absorbs preceding thinking", () => {
    const row = renderRun(
      [
        { tag: "thinking", thinking: thinking("t") },
        { tag: "message", message: message("m", 9) }
      ],
      TURN
    );
    expect(row).toMatchObject({
      kind: "message",
      id: "message:assistant:m",
      occurredAtUnixMs: 9
    });
    expect(
      row.kind === "message" && row.thinking.map((entry) => entry.id)
    ).toEqual(["t"]);
    expect(
      row.kind === "message" && row.messages.map((entry) => entry.id)
    ).toEqual(["m"]);
  });

  it("renders a message row with empty thinking when none precedes it", () => {
    const row = renderRun([{ tag: "message", message: message("m") }], TURN);
    expect(row.kind === "message" && row.thinking).toEqual([]);
  });

  it("renders a user message row without changing its identity", () => {
    const item = userMessageItem("u");
    if (item.kind !== "user-message") throw new Error("expected user message");
    expect(renderRun([{ tag: "user-message", row: item.row }], TURN)).toBe(
      item.row
    );
  });
});

describe("projectTurnRows (behaviour preserved end-to-end)", () => {
  const rowShape = (rows: ReturnType<typeof projectTurnRows>) =>
    rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      thinking:
        row.kind === "message"
          ? row.thinking.map((entry) => entry.id)
          : undefined
    }));

  it("absorbs a thinking immediately followed by a message", () => {
    const rows = projectTurnRows(
      [thinkingItem("t"), messageItem("m")],
      noGroups,
      noSkips,
      TURN
    );
    expect(rowShape(rows)).toEqual([
      { kind: "message", id: "message:assistant:m", thinking: ["t"] }
    ]);
  });

  it("only the immediately-preceding thinking is absorbed; earlier ones stand alone", () => {
    const rows = projectTurnRows(
      [thinkingItem("t1"), thinkingItem("t2"), messageItem("m")],
      noGroups,
      noSkips,
      TURN
    );
    expect(rowShape(rows)).toEqual([
      { kind: "message", id: `message:thinking:${TURN}:t1`, thinking: ["t1"] },
      { kind: "message", id: "message:assistant:m", thinking: ["t2"] }
    ]);
  });

  it("a thinking followed by a tool becomes its own row", () => {
    const rows = projectTurnRows(
      [thinkingItem("t"), toolItem("c")],
      noGroups,
      noSkips,
      TURN
    );
    expect(rowShape(rows)).toEqual([
      { kind: "message", id: `message:thinking:${TURN}:t`, thinking: ["t"] },
      { kind: "tool-group", id: "tool-row:c", thinking: undefined }
    ]);
  });

  it("a group between thinking and message breaks absorption", () => {
    const sequence = [
      thinkingItem("t"),
      toolItem("c0"),
      toolItem("c1"),
      messageItem("m")
    ];
    const group: AgentComputedToolGroupVM = {
      startIndex: 1,
      endIndex: 2,
      calls: [toolCall("c0"), toolCall("c1")],
      entries: []
    };
    const rows = projectTurnRows(
      sequence,
      new Map([[1, group]]),
      new Set([1, 2]),
      TURN
    );
    expect(rowShape(rows)).toEqual([
      { kind: "message", id: `message:thinking:${TURN}:t`, thinking: ["t"] },
      {
        kind: "tool-group",
        id: `tool-group:${TURN}:c0+c1`,
        thinking: undefined
      },
      { kind: "message", id: "message:assistant:m", thinking: [] }
    ]);
  });

  it("a suppressed tool between thinking and message keeps absorption", () => {
    const rows = projectTurnRows(
      [thinkingItem("t"), toolItem("c"), messageItem("m")],
      noGroups,
      new Set([1]),
      TURN
    );
    expect(rowShape(rows)).toEqual([
      { kind: "message", id: "message:assistant:m", thinking: ["t"] }
    ]);
  });

  it("a user message is a visible boundary between assistant rows", () => {
    const rows = projectTurnRows(
      [messageItem("m1"), userMessageItem("u"), messageItem("m2")],
      noGroups,
      noSkips,
      TURN
    );
    expect(rows.map((row) => row.id)).toEqual([
      "message:assistant:m1",
      "message:user:u",
      "message:assistant:m2"
    ]);
  });
});
