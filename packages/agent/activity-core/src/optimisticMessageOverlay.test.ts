import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityMessageDeltaEvent } from "./liveEvent.types.ts";
import { createAgentActivityOptimisticMessageOverlay } from "./optimisticMessageOverlay.ts";
import type { AgentActivityMessage } from "./types.ts";

function delta(
  content: AgentActivityMessageDeltaEvent["data"]["content"],
  status?: string
): AgentActivityMessageDeltaEvent {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      messageId: "message-1",
      turnId: "turn-1",
      role: "assistant",
      kind: "text",
      occurredAtUnixMs: 20,
      content,
      status
    }
  };
}

function canonical(
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    version: 2,
    turnId: "turn-1",
    role: "assistant",
    kind: "text",
    payload: { text: "canonical", content: "canonical" },
    occurredAtUnixMs: 10,
    ...overrides
  };
}

test("materializes set plus append without exposing transport sequencing", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  assert.deepEqual(overlay.apply(delta({ operation: "set", value: "Hel" })), {
    applied: true,
    needsReconcile: false
  });
  assert.deepEqual(
    overlay.apply(delta({ operation: "append_text", text: "lo" })),
    {
      applied: true,
      needsReconcile: false
    }
  );
  const [message] = overlay.project([]);
  assert.equal(message?.payload.text, "Hello");
  assert.equal(message?.version, 0);
  assert.equal("seq" in (message ?? {}), false);
  assert.equal("epoch" in (message ?? {}), false);
});

test("requires an anchor before append and requests reconcile", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  assert.deepEqual(
    overlay.apply(delta({ operation: "append_text", text: "orphan" })),
    {
      applied: false,
      needsReconcile: true,
      reason: "append_without_anchor"
    }
  );
});

test("keeps optimistic terminal over cloud nonterminal and clears on cloud terminal", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  overlay.reconcile([canonical()]);
  overlay.apply(
    delta({ operation: "append_text", text: " live" }, "completed")
  );
  assert.equal(overlay.project([canonical()])[0]?.status, "completed");
  assert.equal(
    overlay.project([canonical()])[0]?.payload.text,
    "canonical live"
  );

  const terminal = canonical({
    status: "completed",
    completedAtUnixMs: 30,
    payload: { text: "canonical final" }
  });
  overlay.reconcile([terminal]);
  assert.equal(overlay.project([terminal])[0]?.payload.text, "canonical final");
});

test("applies payload set and unset atomically", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  overlay.reconcile([
    canonical({ payload: { text: "base", private: true, preserved: "yes" } })
  ]);
  const event = delta(undefined);
  event.data.payloadSet = { phase: "running" };
  event.data.payloadUnset = ["private"];
  assert.equal(overlay.apply(event).applied, true);
  assert.deepEqual(overlay.project([])[0]?.payload, {
    text: "base",
    preserved: "yes",
    phase: "running"
  });
});
