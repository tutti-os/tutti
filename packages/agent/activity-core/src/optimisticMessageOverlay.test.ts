import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityMessageDeltaEvent } from "./liveEvent.types.ts";
import {
  createAgentActivityOptimisticMessageOverlay,
  type AgentActivityOptimisticMessageScope
} from "./optimisticMessageOverlay.ts";
import type { AgentActivityMessage } from "./types.ts";

const scope: AgentActivityOptimisticMessageScope = {
  workspaceId: "workspace-1",
  agentSessionId: "session-1"
};

function sessionScope(
  agentSessionId: string
): AgentActivityOptimisticMessageScope {
  return { workspaceId: "workspace-1", agentSessionId };
}

function delta(
  content: AgentActivityMessageDeltaEvent["data"]["content"],
  status?: string,
  eventScope: AgentActivityOptimisticMessageScope = scope
): AgentActivityMessageDeltaEvent {
  return {
    ...eventScope,
    eventType: "message_delta",
    data: {
      ...eventScope,
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
  const [message] = overlay.project(scope, []);
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

test("authoritative reconcile clears a stale nonterminal projection before the next delta", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const initial = canonical({
    version: 1,
    payload: { text: "Hel", content: "Hel" }
  });
  overlay.reconcile(scope, [initial]);
  overlay.apply(delta({ operation: "append_text", text: "lo" }));
  assert.equal(overlay.project(scope, [initial])[0]?.payload.text, "Hello");

  const advanced = canonical({
    version: 2,
    payload: { text: "Hello world", content: "Hello world" }
  });
  overlay.reconcile(scope, [advanced]);
  assert.equal(
    overlay.project(scope, [advanced])[0]?.payload.text,
    "Hello world"
  );

  overlay.apply(delta({ operation: "append_text", text: "!" }));
  assert.equal(
    overlay.project(scope, [advanced])[0]?.payload.text,
    "Hello world!"
  );
});

test("explicit Session reset drops all state and requires a new authoritative anchor", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const base = canonical({
    version: 1,
    payload: { text: "cloud", content: "cloud" }
  });
  overlay.reconcile(scope, [base]);
  overlay.apply(delta({ operation: "append_text", text: " live" }));
  assert.equal(overlay.project(scope, [base])[0]?.payload.text, "cloud live");

  overlay.reset(scope);
  assert.equal(overlay.project(scope, [base])[0]?.payload.text, "cloud");
  assert.deepEqual(
    overlay.apply(delta({ operation: "append_text", text: " orphan" })),
    {
      applied: false,
      needsReconcile: true,
      reason: "append_without_anchor"
    }
  );

  overlay.reconcile(scope, [base]);
  assert.equal(
    overlay.apply(delta({ operation: "append_text", text: " recovered" }))
      .applied,
    true
  );
  assert.equal(
    overlay.project(scope, [base])[0]?.payload.text,
    "cloud recovered"
  );
});

test("keeps an explicitly terminal optimistic projection until canonical becomes terminal", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const initial = canonical({
    version: 1,
    payload: { text: "canonical", content: "canonical" }
  });
  overlay.reconcile(scope, [initial]);
  overlay.apply(
    delta({ operation: "append_text", text: " live final" }, "completed")
  );

  const cloudNonterminal = canonical({
    version: 2,
    status: "streaming",
    payload: { text: "canonical partial", content: "canonical partial" }
  });
  overlay.reconcile(scope, [cloudNonterminal]);
  const optimisticTerminal = overlay.project(scope, [cloudNonterminal])[0];
  assert.equal(optimisticTerminal?.status, "completed");
  assert.equal(optimisticTerminal?.payload.text, "canonical live final");

  const cloudTerminal = canonical({
    version: 3,
    status: "completed",
    completedAtUnixMs: 30,
    payload: { text: "canonical final", content: "canonical final" }
  });
  overlay.reconcile(scope, [cloudTerminal]);
  const canonicalTerminal = overlay.project(scope, [cloudTerminal]);
  assert.equal(canonicalTerminal.length, 1);
  assert.equal(canonicalTerminal[0]?.version, 3);
  assert.equal(canonicalTerminal[0]?.status, "completed");
  assert.equal(canonicalTerminal[0]?.payload.text, "canonical final");
});

test("normalizes missing canonical workspace identity without duplicate messages or a false missing anchor", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const withoutWorkspace = canonical({
    workspaceId: undefined,
    version: 1,
    payload: { text: "Hel", content: "Hel" }
  });
  overlay.reconcile(scope, [withoutWorkspace]);
  assert.equal(
    overlay.apply(delta({ operation: "append_text", text: "lo" })).applied,
    true
  );
  const appended = overlay.project(scope, [withoutWorkspace]);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.workspaceId, scope.workspaceId);
  assert.equal(appended[0]?.payload.text, "Hello");

  overlay.reconcile(scope, [withoutWorkspace]);
  overlay.apply(delta({ operation: "set", value: "replacement" }));
  const replaced = overlay.project(scope, [withoutWorkspace]);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.payload.text, "replacement");
});

test("reconcile and reset affect only their exact workspace and Session scope", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const firstScope = sessionScope("session-1");
  const secondScope = sessionScope("session-2");
  const first = canonical({
    agentSessionId: firstScope.agentSessionId,
    payload: { text: "first", content: "first" }
  });
  const second = canonical({
    agentSessionId: secondScope.agentSessionId,
    messageId: "message-1",
    payload: { text: "second", content: "second" }
  });
  overlay.reconcile(firstScope, [first]);
  overlay.reconcile(secondScope, [second]);
  overlay.apply(
    delta(
      { operation: "append_text", text: " optimistic" },
      undefined,
      firstScope
    )
  );
  overlay.apply(
    delta(
      { operation: "append_text", text: " optimistic" },
      undefined,
      secondScope
    )
  );

  overlay.reconcile(firstScope, [first]);
  assert.equal(overlay.project(firstScope, [first])[0]?.payload.text, "first");
  assert.equal(
    overlay.project(secondScope, [second])[0]?.payload.text,
    "second optimistic"
  );

  overlay.reset(firstScope);
  assert.equal(
    overlay.project(secondScope, [second])[0]?.payload.text,
    "second optimistic"
  );
});

test("applies payload set and unset atomically", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const base = canonical({
    payload: { text: "base", private: true, preserved: "yes" }
  });
  overlay.reconcile(scope, [base]);
  const event = delta(undefined);
  event.data.payloadSet = { phase: "running" };
  event.data.payloadUnset = ["private"];
  assert.equal(overlay.apply(event).applied, true);
  assert.deepEqual(overlay.project(scope, [])[0]?.payload, {
    text: "base",
    preserved: "yes",
    phase: "running"
  });
});

test("appends normalized tool output with UTF-8 byte offsets", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const toolBase = canonical({
    messageId: "tool-1",
    kind: "tool_call",
    status: "streaming",
    payload: {
      name: "Bash",
      output: { text: "你", exitCode: null }
    }
  });
  overlay.reconcile(scope, [toolBase]);
  const event = delta(undefined);
  event.data.messageId = "tool-1";
  event.data.kind = "tool_call";
  event.data.toolOutput = {
    operation: "append_text",
    text: "好\n",
    offsetBytes: 3
  };
  assert.deepEqual(overlay.apply(event), {
    applied: true,
    needsReconcile: false
  });
  assert.deepEqual(overlay.project(scope, [toolBase])[0]?.payload.output, {
    text: "你好\n",
    exitCode: null
  });
});

test("rejects duplicate or out-of-order tool output without corrupting the overlay", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const toolBase = canonical({
    messageId: "tool-1",
    kind: "tool_call",
    status: "streaming",
    payload: { output: { text: "abc" } }
  });
  overlay.reconcile(scope, [toolBase]);
  const event = delta(undefined);
  event.data.messageId = "tool-1";
  event.data.kind = "tool_call";
  event.data.toolOutput = {
    operation: "append_text",
    text: "duplicate",
    offsetBytes: 0
  };
  assert.deepEqual(overlay.apply(event), {
    applied: false,
    needsReconcile: true,
    reason: "tool_output_offset_mismatch"
  });
  const projectedOutput = overlay.project(scope, [toolBase])[0]?.payload
    .output as { text?: string } | undefined;
  assert.equal(projectedOutput?.text, "abc");
});

test("tool output set can establish a temporary optimistic projection", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const event = delta(undefined);
  event.data.messageId = "tool-1";
  event.data.kind = "tool_call";
  event.data.toolOutput = { operation: "set", text: "first chunk" };
  assert.equal(overlay.apply(event).applied, true);
  assert.deepEqual(overlay.project(scope, [])[0]?.payload.output, {
    text: "first chunk"
  });
});
