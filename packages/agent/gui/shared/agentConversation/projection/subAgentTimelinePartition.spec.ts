import { describe, expect, it } from "vitest";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentActivityTypes";
import {
  attachSubAgentLanesToConversationVM,
  buildSubAgentLanesByCallId,
  partitionSubAgentTimelineItems,
  timelineItemOwnerCallId,
  timelineItemOwnerThreadId
} from "./subAgentTimelinePartition";
import type { AgentConversationVM } from "../contracts/agentConversationVM";

describe("subAgentTimelinePartition", () => {
  describe("timelineItemOwnerThreadId", () => {
    it("reads a non-empty ownerThreadId from the payload", () => {
      expect(
        timelineItemOwnerThreadId(
          timelineItem({
            id: 1,
            eventId: "child-1",
            payload: { ownerThreadId: "child-thread-1" }
          })
        )
      ).toBe("child-thread-1");
    });

    it("ignores blank and missing ownerThreadId values", () => {
      expect(
        timelineItemOwnerThreadId(
          timelineItem({
            id: 1,
            eventId: "parent-1",
            payload: { ownerThreadId: "   " }
          })
        )
      ).toBeNull();
      expect(
        timelineItemOwnerThreadId(timelineItem({ id: 2, eventId: "parent-2" }))
      ).toBeNull();
    });
  });

  describe("timelineItemOwnerCallId", () => {
    it("reads a non-empty ownerCallId from the payload", () => {
      expect(
        timelineItemOwnerCallId(
          timelineItem({
            id: 1,
            eventId: "child-1",
            payload: { ownerThreadId: "child-thread-1", ownerCallId: "spawn-1" }
          })
        )
      ).toBe("spawn-1");
    });

    it("ignores blank and missing ownerCallId values", () => {
      expect(
        timelineItemOwnerCallId(
          timelineItem({
            id: 1,
            eventId: "child-1",
            payload: { ownerThreadId: "child-thread-1", ownerCallId: " " }
          })
        )
      ).toBeNull();
      expect(
        timelineItemOwnerCallId(timelineItem({ id: 2, eventId: "child-2" }))
      ).toBeNull();
    });
  });

  describe("partitionSubAgentTimelineItems", () => {
    it("excludes child-thread rows from the main flow and groups them by owner", () => {
      const parentMessage = timelineItem({
        id: 1,
        eventId: "assistant-1",
        itemType: "message.assistant",
        role: "assistant",
        payload: { text: "parent output" }
      });
      const childMessage = timelineItem({
        id: 2,
        eventId: "child-msg-1",
        itemType: "message.assistant",
        role: "assistant",
        payload: { text: "child output", ownerThreadId: "child-thread-1" }
      });
      const childCall = timelineItem({
        id: 3,
        eventId: "child-call-1",
        itemType: "call.started",
        callId: "child-call-1",
        name: "Run command",
        payload: { ownerThreadId: "child-thread-1" }
      });
      const otherChildRow = timelineItem({
        id: 4,
        eventId: "child-msg-2",
        itemType: "message.assistant",
        role: "assistant",
        payload: { text: "second child", ownerThreadId: "child-thread-2" }
      });

      const partition = partitionSubAgentTimelineItems([
        parentMessage,
        childMessage,
        childCall,
        otherChildRow
      ]);

      expect(partition.mainTimelineItems).toEqual([parentMessage]);
      expect([...partition.subAgentItemsByOwner.keys()]).toEqual([
        "child-thread-1",
        "child-thread-2"
      ]);
      expect(partition.subAgentItemsByOwner.get("child-thread-1")).toEqual([
        childMessage,
        childCall
      ]);
    });

    it("returns the input array unchanged when no child rows exist", () => {
      const items = [
        timelineItem({ id: 1, eventId: "assistant-1" }),
        timelineItem({ id: 2, eventId: "assistant-2" })
      ];
      const partition = partitionSubAgentTimelineItems(items);
      expect(partition.mainTimelineItems).toBe(items);
      expect(partition.subAgentItemsByOwner.size).toBe(0);
    });
  });

  describe("buildSubAgentLanesByCallId", () => {
    it("attaches a running lane to its recorded spawn card", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "Scanning the repository layout",
          occurredAtUnixMs: 150
        }),
        childCallItem({
          id: 12,
          eventId: "child-call-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          name: "Run command",
          occurredAtUnixMs: 220
        })
      ]);

      const lanes = buildSubAgentLanesByCallId(partition);

      expect(lanes.get("spawn-1")).toEqual([
        expect.objectContaining({
          ownerThreadId: "child-thread-1",
          status: "running",
          name: null,
          task: "inspect the repository",
          latestActivity: "Run command",
          latestActivityKind: "tool",
          startedAtUnixMs: 150,
          latestActivityAtUnixMs: 220,
          terminalAtUnixMs: null
        })
      ]);
    });

    it("uses the trailing snippet of the latest assistant text as lane activity", () => {
      const longText = `intro ${"x".repeat(200)} live tail`;
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: longText,
          occurredAtUnixMs: 150
        })
      ]);

      const lane = buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0];

      expect(lane?.latestActivityKind).toBe("message");
      expect(lane?.latestActivity?.startsWith("…")).toBe(true);
      expect(lane?.latestActivity?.endsWith("live tail")).toBe(true);
      expect(lane?.latestActivity?.length).toBeLessThanOrEqual(141);
    });

    it("classifies reasoning rows as reasoning activity", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        timelineItem({
          id: 11,
          eventId: "child-think-1",
          itemType: "message.assistant_thinking",
          role: "assistant_thinking",
          payload: {
            text: "Considering options",
            ownerThreadId: "child-thread-1",
            ownerCallId: "spawn-1"
          },
          occurredAtUnixMs: 150
        })
      ]);

      const lane = buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0];

      expect(lane?.latestActivityKind).toBe("reasoning");
      expect(lane?.latestActivity).toBe("Considering options");
    });

    it("attaches each lane to its recorded spawn card, never by time affinity", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100,
          receiverThreadIds: ["child-thread-1"]
        }),
        collabCardItem({
          id: 11,
          eventId: "spawn-2-started",
          callId: "spawn-2",
          status: "running",
          occurredAtUnixMs: 110,
          receiverThreadIds: ["child-thread-2"]
        }),
        // child-1's first activity lands after spawn-2 started: any time-based
        // guess would mis-attribute it to spawn-2 while both are running. The
        // recorded ownerCallId pins it to spawn-1.
        childAssistantItem({
          id: 12,
          eventId: "child-1-msg",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "working on task one",
          occurredAtUnixMs: 150
        }),
        childAssistantItem({
          id: 13,
          eventId: "child-2-msg",
          ownerThreadId: "child-thread-2",
          ownerCallId: "spawn-2",
          text: "working on task two",
          occurredAtUnixMs: 160
        })
      ]);

      const lanes = buildSubAgentLanesByCallId(partition);

      expect(lanes.get("spawn-1")).toEqual([
        expect.objectContaining({ ownerThreadId: "child-thread-1" })
      ]);
      expect(lanes.get("spawn-2")).toEqual([
        expect.objectContaining({ ownerThreadId: "child-thread-2" })
      ]);
    });

    it("keeps a streaming child running after the spawn card completed", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        collabCardItem({
          id: 11,
          eventId: "spawn-1-completed",
          callId: "spawn-1",
          itemType: "call.completed",
          status: "completed",
          occurredAtUnixMs: 300
        }),
        childAssistantItem({
          id: 12,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "still working",
          occurredAtUnixMs: 200
        })
      ]);

      expect(
        buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0]?.status
      ).toBe("running");
    });

    it("derives a short name from the task's opening self-address", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100,
          task: "你是 repo smell reviewer。請在 /Users/asdf/Repo/tutti 做靜態分析。"
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "working",
          occurredAtUnixMs: 150
        })
      ]);

      const lane = buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0];

      expect(lane?.name).toBe("repo smell reviewer");
    });

    it("leaves the lane unnamed when the task opening is too long to be a name", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100,
          task: `你是${"很長的描述".repeat(10)}。請分析。`
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "working",
          occurredAtUnixMs: 150
        })
      ]);

      const lane = buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0];

      expect(lane?.name).toBeNull();
    });

    it("seeds placeholder lanes from a spawn card before any child rows arrive", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100,
          receiverThreadIds: ["child-thread-1", "child-thread-2"],
          task: "你是 repo smell reviewer。請分析。"
        })
      ]);

      const lanes = buildSubAgentLanesByCallId(partition).get("spawn-1");

      expect(lanes?.map((lane) => lane.ownerThreadId)).toEqual([
        "child-thread-1",
        "child-thread-2"
      ]);
      expect(lanes?.[0]?.status).toBe("running");
      expect(lanes?.[0]?.name).toBe("repo smell reviewer");
      expect(lanes?.[0]?.latestActivity).toBeNull();
      expect(lanes?.[0]?.startedAtUnixMs).toBe(100);
    });

    it("renders a receiver-less spawn (e.g. tool-rejected) as a lane carrying the call status", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "failed",
          occurredAtUnixMs: 100,
          task: "你是只讀 explorer。請分析 apps/desktop。"
        })
      ]);

      const lanes = buildSubAgentLanesByCallId(partition).get("spawn-1");

      expect(lanes).toHaveLength(1);
      expect(lanes?.[0]?.status).toBe("failed");
      expect(lanes?.[0]?.name).toBe("只讀 explorer");
      expect(lanes?.[0]?.queued).toBe(false);
    });

    it("marks a still-running receiver-less spawn as queued and cuts names at commas", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100,
          task: "你是 repo smell reviewer，請只做讀取分析，不要修改檔案。目標：分析 apps/desktop。"
        })
      ]);

      const lane = buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0];

      // codex caps concurrent sub-agents per session; a spawn beyond the cap
      // stays running with no child thread until a slot frees.
      expect(lane?.queued).toBe(true);
      expect(lane?.status).toBe("running");
      expect(lane?.name).toBe("repo smell reviewer");
    });

    it("does not seed lanes from wait/close control cards", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "wait-1-started",
          callId: "wait-1",
          status: "running",
          occurredAtUnixMs: 100,
          receiverThreadIds: ["child-thread-1"],
          agentName: "waitAgent"
        })
      ]);

      expect(buildSubAgentLanesByCallId(partition).size).toBe(0);
    });

    it("never attaches lanes to a wait/close control card, even when rows point at it", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "wait-1-started",
          callId: "wait-1",
          status: "running",
          occurredAtUnixMs: 100,
          receiverThreadIds: ["child-thread-1"],
          agentName: "waitAgent"
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "wait-1",
          text: "working",
          occurredAtUnixMs: 150
        })
      ]);

      expect(buildSubAgentLanesByCallId(partition).size).toBe(0);
    });

    it("titles the lane from the subAgentName marker and hides markers from the log", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "working",
          occurredAtUnixMs: 150
        }),
        timelineItem({
          id: 12,
          eventId: "child-name-1",
          itemType: "message.assistant",
          role: "assistant",
          payload: {
            ownerThreadId: "child-thread-1",
            ownerCallId: "spawn-1",
            messageKind: "subAgentName",
            subAgentName: "Repo smell analyst"
          },
          occurredAtUnixMs: 160
        })
      ]);

      const lane = buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0];

      expect(lane?.name).toBe("Repo smell analyst");
      // Markers are meta: they must not appear in the activity log or as the
      // latest activity.
      expect(lane?.activityLog.map((entry) => entry.text)).toEqual(["working"]);
      expect(lane?.latestActivity).toBe("working");
    });

    it("marks lanes completed from child terminal markers", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "finishing",
          occurredAtUnixMs: 200
        }),
        childLifecycleItem({
          id: 12,
          eventId: "child-terminal-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          status: "completed",
          occurredAtUnixMs: 350
        })
      ]);

      expect(buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0]).toEqual(
        expect.objectContaining({
          ownerThreadId: "child-thread-1",
          status: "completed",
          latestActivity: "finishing",
          terminalAtUnixMs: 350,
          latestActivityAtUnixMs: 350
        })
      );
    });

    it("marks lanes failed from child terminal markers with detail", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        childLifecycleItem({
          id: 11,
          eventId: "child-terminal-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          status: "failed",
          detail: "child thread exploded",
          occurredAtUnixMs: 350
        })
      ]);

      expect(buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0]).toEqual(
        expect.objectContaining({
          status: "failed",
          failureDetail: "child thread exploded"
        })
      );
    });

    it("marks lanes canceled from child terminal markers", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        }),
        childLifecycleItem({
          id: 11,
          eventId: "child-terminal-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          status: "canceled",
          occurredAtUnixMs: 350
        })
      ]);

      expect(
        buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0]?.status
      ).toBe("canceled");
    });

    it("uses agentsStates on control-tool output as a lane terminal source", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100,
          receiverThreadIds: ["child-thread-1"]
        }),
        collabCardItem({
          id: 11,
          eventId: "spawn-1-completed",
          callId: "spawn-1",
          itemType: "call.completed",
          status: "completed",
          occurredAtUnixMs: 300,
          output: {
            agentsStates: [{ threadId: "child-thread-1", status: "failed" }]
          }
        }),
        childAssistantItem({
          id: 12,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "latest child activity",
          occurredAtUnixMs: 200
        })
      ]);

      expect(
        buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0]?.status
      ).toBe("failed");
    });

    it("attaches an early-arriving lane once its spawn card exists (ordering edge)", () => {
      const partition = partitionSubAgentTimelineItems([
        childAssistantItem({
          id: 10,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "started before the card",
          occurredAtUnixMs: 90
        }),
        collabCardItem({
          id: 11,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100
        })
      ]);

      expect(
        buildSubAgentLanesByCallId(partition).get("spawn-1")?.[0]?.ownerThreadId
      ).toBe("child-thread-1");
    });

    it("hides lanes whose spawn card is outside the loaded window (partial history)", () => {
      // The spawn card lives in an older, not-yet-loaded message page. The
      // child rows carry their recorded ownerCallId but must not attach to the
      // unrelated loaded card by any guess — they stay hidden until the older
      // page loads.
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-2-started",
          callId: "spawn-2",
          status: "running",
          occurredAtUnixMs: 100,
          receiverThreadIds: ["child-thread-2"]
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "orphan output",
          occurredAtUnixMs: 150
        })
      ]);

      const lanes = buildSubAgentLanesByCallId(partition);

      expect(lanes.has("spawn-1")).toBe(false);
      expect(
        lanes
          .get("spawn-2")
          ?.some((lane) => lane.ownerThreadId === "child-thread-1")
      ).toBe(false);
    });

    it("ignores child rows without ownerCallId (recordings that predate the field)", () => {
      const partition = partitionSubAgentTimelineItems([
        collabCardItem({
          id: 10,
          eventId: "spawn-1-started",
          callId: "spawn-1",
          status: "running",
          occurredAtUnixMs: 100,
          receiverThreadIds: ["child-thread-1"]
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          text: "legacy child output",
          occurredAtUnixMs: 150
        })
      ]);

      const lanes = buildSubAgentLanesByCallId(partition).get("spawn-1");

      // The declared receiver still surfaces as a seeded placeholder lane, but
      // the legacy rows' activity never attaches by guesswork.
      expect(lanes?.map((lane) => lane.ownerThreadId)).toEqual([
        "child-thread-1"
      ]);
      expect(lanes?.[0]?.latestActivity).toBeNull();
    });

    it("returns no lanes when there is no collab card at all", () => {
      const partition = partitionSubAgentTimelineItems([
        timelineItem({
          id: 10,
          eventId: "call-1",
          itemType: "call.started",
          callId: "shell-1",
          name: "Run command",
          payload: { toolName: "Bash", callId: "shell-1" },
          occurredAtUnixMs: 100
        }),
        childAssistantItem({
          id: 11,
          eventId: "child-msg-1",
          ownerThreadId: "child-thread-1",
          ownerCallId: "spawn-1",
          text: "orphan output",
          occurredAtUnixMs: 150
        })
      ]);

      expect(buildSubAgentLanesByCallId(partition).size).toBe(0);
    });
  });

  describe("attachSubAgentLanesToConversationVM", () => {
    it("returns the conversation untouched when there are no lanes", () => {
      const conversation = { rows: [] } as unknown as AgentConversationVM;
      expect(attachSubAgentLanesToConversationVM(conversation, new Map())).toBe(
        conversation
      );
    });
  });
});

function timelineItem(
  overrides: Partial<WorkspaceAgentActivityTimelineItem> & {
    id: number;
    eventId: string;
  }
): WorkspaceAgentActivityTimelineItem {
  return {
    workspaceId: "room-1",
    agentSessionId: "session-1",
    actorType: "agent",
    actorId: "codex",
    itemType: "message.assistant",
    occurredAtUnixMs: overrides.id,
    createdAtUnixMs: overrides.id,
    ...overrides
  };
}

function collabCardItem({
  id,
  eventId,
  callId,
  status,
  occurredAtUnixMs,
  itemType = "call.started",
  output,
  receiverThreadIds,
  task = "inspect the repository",
  agentName = "spawnAgent"
}: {
  id: number;
  eventId: string;
  callId: string;
  status: string;
  occurredAtUnixMs: number;
  itemType?: string;
  output?: Record<string, unknown>;
  receiverThreadIds?: readonly string[];
  task?: string;
  agentName?: string;
}): WorkspaceAgentActivityTimelineItem {
  return timelineItem({
    id,
    eventId,
    itemType,
    callType: "tool",
    callId,
    name: "spawnAgent",
    status,
    payload: {
      callId,
      name: "spawnAgent",
      toolName: "Agent",
      kind: "execute",
      status,
      input: {
        task,
        agentName,
        ...(receiverThreadIds ? { receiverThreadIds } : {})
      },
      ...(output ? { output } : {})
    },
    occurredAtUnixMs,
    createdAtUnixMs: occurredAtUnixMs
  });
}

function childAssistantItem({
  id,
  eventId,
  ownerThreadId,
  ownerCallId,
  text,
  occurredAtUnixMs
}: {
  id: number;
  eventId: string;
  ownerThreadId: string;
  ownerCallId?: string;
  text: string;
  occurredAtUnixMs: number;
}): WorkspaceAgentActivityTimelineItem {
  return timelineItem({
    id,
    eventId,
    itemType: "message.assistant",
    role: "assistant",
    payload: { text, ownerThreadId, ...(ownerCallId ? { ownerCallId } : {}) },
    occurredAtUnixMs,
    createdAtUnixMs: occurredAtUnixMs
  });
}

function childCallItem({
  id,
  eventId,
  ownerThreadId,
  ownerCallId,
  name,
  occurredAtUnixMs
}: {
  id: number;
  eventId: string;
  ownerThreadId: string;
  ownerCallId?: string;
  name: string;
  occurredAtUnixMs: number;
}): WorkspaceAgentActivityTimelineItem {
  return timelineItem({
    id,
    eventId,
    itemType: "call.started",
    callType: "tool",
    callId: `${eventId}-call`,
    name,
    status: "running",
    payload: {
      name,
      ownerThreadId,
      ...(ownerCallId ? { ownerCallId } : {}),
      callId: `${eventId}-call`
    },
    occurredAtUnixMs,
    createdAtUnixMs: occurredAtUnixMs
  });
}

function childLifecycleItem({
  id,
  eventId,
  ownerThreadId,
  ownerCallId,
  status,
  detail,
  occurredAtUnixMs
}: {
  id: number;
  eventId: string;
  ownerThreadId: string;
  ownerCallId?: string;
  status: "completed" | "failed" | "canceled";
  detail?: string;
  occurredAtUnixMs: number;
}): WorkspaceAgentActivityTimelineItem {
  return timelineItem({
    id,
    eventId,
    itemType: "message.assistant",
    role: "assistant",
    status,
    payload: {
      ownerThreadId,
      ...(ownerCallId ? { ownerCallId } : {}),
      messageKind: "subAgentLifecycle",
      subAgentLifecycleStatus: status,
      ...(detail ? { detail } : {})
    },
    occurredAtUnixMs,
    createdAtUnixMs: occurredAtUnixMs
  });
}
