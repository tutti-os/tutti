import { describe, expect, it, vi } from "vitest";
import {
  createAgentQueuedPromptRuntime,
  type AgentQueuedPromptRuntime
} from "./agentQueuedPromptRuntimeCore";
import type { AgentGUIQueuedPromptVM } from "./agent-gui/agentGuiNode/model/agentGuiNodeTypes";

function prompt(id: string, text = id): AgentGUIQueuedPromptVM {
  return {
    id,
    content: [{ type: "text", text }],
    createdAtUnixMs: Number(id.replace(/\D/g, "")) || 1
  };
}

function enqueue(
  runtime: AgentQueuedPromptRuntime,
  workspaceId: string,
  agentSessionId: string,
  ids: readonly string[]
): void {
  for (const id of ids) {
    runtime.enqueue({ workspaceId, agentSessionId, prompt: prompt(id) });
  }
}

describe("AgentQueuedPromptRuntime", () => {
  it("keeps FIFO queues isolated by workspace and session", () => {
    const runtime = createAgentQueuedPromptRuntime();

    enqueue(runtime, "workspace-1", "session-1", ["p1", "p2"]);
    enqueue(runtime, "workspace-1", "session-2", ["p3"]);
    enqueue(runtime, "workspace-2", "session-1", ["p4"]);

    expect(
      runtime
        .getSessionSnapshot({
          workspaceId: "workspace-1",
          agentSessionId: "session-1"
        })
        .prompts.map((item) => item.id)
    ).toEqual(["p1", "p2"]);
    expect(
      runtime
        .getSessionSnapshot({
          workspaceId: "workspace-1",
          agentSessionId: "session-2"
        })
        .prompts.map((item) => item.id)
    ).toEqual(["p3"]);
    expect(
      runtime
        .getSessionSnapshot({
          workspaceId: "workspace-2",
          agentSessionId: "session-1"
        })
        .prompts.map((item) => item.id)
    ).toEqual(["p4"]);
  });

  it("supports enqueue, remove, edit-style remove, and promote", () => {
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1", "p2", "p3"]);

    runtime.promotePrompt({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      promptId: "p3"
    });
    expect(
      runtime
        .getSessionSnapshot({
          workspaceId: "workspace-1",
          agentSessionId: "session-1"
        })
        .prompts.map((item) => item.id)
    ).toEqual(["p3", "p1", "p2"]);

    expect(
      runtime.removePrompt({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        promptId: "p1"
      })?.id
    ).toBe("p1");
    expect(
      runtime
        .getSessionSnapshot({
          workspaceId: "workspace-1",
          agentSessionId: "session-1"
        })
        .prompts.map((item) => item.id)
    ).toEqual(["p3", "p2"]);
  });

  it("publishes immutable snapshots", () => {
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1"]);

    const snapshot = runtime.getSnapshot();
    const queue = runtime.getSessionSnapshot({
      workspaceId: "workspace-1",
      agentSessionId: "session-1"
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.queuesByKey)).toBe(true);
    expect(Object.isFrozen(queue)).toBe(true);
    expect(Object.isFrozen(queue.prompts)).toBe(true);
    expect(Object.isFrozen(queue.prompts[0])).toBe(true);
    expect(Object.isFrozen(queue.prompts[0]?.content)).toBe(true);
  });

  it("allows only one owner to claim a session and ignores stale complete or release", () => {
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1"]);

    const first = runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-1"
    });
    const second = runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-2"
    });

    expect(first?.prompt.id).toBe("p1");
    expect(second).toBeNull();
    expect(
      runtime.releaseClaim({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-2",
        claimId: first!.claim.claimId
      })
    ).toBe(false);
    expect(
      runtime.completeClaim({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-2",
        claimId: first!.claim.claimId
      })
    ).toBe(false);
    expect(
      runtime
        .getSessionSnapshot({
          workspaceId: "workspace-1",
          agentSessionId: "session-1"
        })
        .prompts.map((item) => item.id)
    ).toEqual(["p1"]);
  });

  it("does not let stale claim completion affect a newer claim", () => {
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1"]);

    const first = runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-1"
    })!;
    expect(
      runtime.releaseClaim({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-1",
        claimId: first.claim.claimId
      })
    ).toBe(true);
    const second = runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-2"
    })!;

    expect(
      runtime.completeClaim({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-1",
        claimId: first.claim.claimId
      })
    ).toBe(false);
    expect(
      runtime.completeClaim({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-2",
        claimId: second.claim.claimId
      })
    ).toBe(true);
    expect(
      runtime.getSessionSnapshot({
        workspaceId: "workspace-1",
        agentSessionId: "session-1"
      }).prompts
    ).toEqual([]);
  });

  it("keeps deprecated owner-wide claim release for compatibility", () => {
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1"]);
    enqueue(runtime, "workspace-1", "session-2", ["p2"]);

    expect(
      runtime.claimNextToDrain({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-1"
      })
    ).not.toBeNull();
    expect(
      runtime.claimNextToDrain({
        workspaceId: "workspace-1",
        agentSessionId: "session-2",
        ownerId: "owner-1"
      })
    ).not.toBeNull();

    runtime.releaseOwner("owner-1");

    expect(
      runtime.getSessionSnapshot({
        workspaceId: "workspace-1",
        agentSessionId: "session-1"
      }).claim
    ).toBeNull();
    expect(
      runtime.getSessionSnapshot({
        workspaceId: "workspace-1",
        agentSessionId: "session-2"
      }).claim
    ).toBeNull();
  });

  it("does not remove or promote a prompt while it is claimed", () => {
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1", "p2"]);

    const claim = runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-1"
    });

    expect(claim?.prompt.id).toBe("p1");
    expect(
      runtime.removePrompt({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        promptId: "p1"
      })
    ).toBeNull();
    runtime.promotePrompt({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      promptId: "p1"
    });
    expect(
      runtime
        .getSessionSnapshot({
          workspaceId: "workspace-1",
          agentSessionId: "session-1"
        })
        .prompts.map((item) => item.id)
    ).toEqual(["p1", "p2"]);
    expect(
      runtime.getSessionSnapshot({
        workspaceId: "workspace-1",
        agentSessionId: "session-1"
      }).claim?.claimId
    ).toBe(claim?.claim.claimId);
  });

  it("allows the original owner to complete an expired claim that was not replaced", () => {
    vi.useFakeTimers();
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1"]);

    const claim = runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-1",
      leaseMs: 10
    })!;
    vi.advanceTimersByTime(11);

    expect(
      runtime.completeClaim({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-1",
        claimId: claim.claim.claimId
      })
    ).toBe(true);
    expect(
      runtime.getSessionSnapshot({
        workspaceId: "workspace-1",
        agentSessionId: "session-1"
      }).prompts
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("notifies subscribers when a claim lease expires", () => {
    vi.useFakeTimers();
    const runtime = createAgentQueuedPromptRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);
    enqueue(runtime, "workspace-1", "session-1", ["p1"]);
    listener.mockClear();

    runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-1",
      leaseMs: 10
    });
    listener.mockClear();
    vi.advanceTimersByTime(11);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      runtime.getSessionSnapshot({
        workspaceId: "workspace-1",
        agentSessionId: "session-1"
      }).claim
    ).toBeNull();
    vi.useRealTimers();
  });

  it("releases claims when a lease expires", () => {
    vi.useFakeTimers();
    const runtime = createAgentQueuedPromptRuntime();
    enqueue(runtime, "workspace-1", "session-1", ["p1"]);

    const leased = runtime.claimNextToDrain({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      ownerId: "owner-1",
      leaseMs: 10
    });
    expect(leased).not.toBeNull();
    vi.advanceTimersByTime(11);
    expect(
      runtime.claimNextToDrain({
        workspaceId: "workspace-1",
        agentSessionId: "session-1",
        ownerId: "owner-2"
      })?.prompt.id
    ).toBe("p1");
    vi.useRealTimers();
  });
});
