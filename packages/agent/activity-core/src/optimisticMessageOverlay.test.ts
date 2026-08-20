import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityMessageDeltaEvent } from "./liveEvent.types.ts";
import {
  createAgentActivityOptimisticMessageOverlay,
  type AgentActivityOptimisticMessageScope
} from "./optimisticMessageOverlay.ts";
import type { AgentActivityMessage, AgentActivityTurn } from "./types.ts";

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

function effectiveTurn(
  overrides: Partial<AgentActivityTurn> = {}
): AgentActivityTurn {
  return {
    agentSessionId: scope.agentSessionId,
    origin: "user_prompt",
    phase: "settled",
    startedAtUnixMs: 10,
    turnId: "turn-1",
    updatedAtUnixMs: 20,
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

test("canonical merge advances a confirmed nonterminal projection before the next delta", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const initial = canonical({
    version: 1,
    payload: { text: "Hel", content: "Hel" }
  });
  overlay.mergeCanonical(scope, [initial]);
  overlay.apply(delta({ operation: "append_text", text: "lo" }));
  assert.equal(overlay.project(scope, [initial])[0]?.payload.text, "Hello");

  const advanced = canonical({
    version: 2,
    payload: { text: "Hello world", content: "Hello world" }
  });
  overlay.mergeCanonical(scope, [advanced]);
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
  overlay.mergeCanonical(scope, [base]);
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

  overlay.mergeCanonical(scope, [base]);
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
  overlay.mergeCanonical(scope, [initial]);
  overlay.apply(
    delta({ operation: "append_text", text: " live final" }, "completed")
  );

  const cloudNonterminal = canonical({
    version: 2,
    status: "streaming",
    payload: { text: "canonical partial", content: "canonical partial" }
  });
  overlay.mergeCanonical(scope, [cloudNonterminal]);
  const optimisticTerminal = overlay.project(scope, [cloudNonterminal])[0];
  assert.equal(optimisticTerminal?.status, "completed");
  assert.equal(optimisticTerminal?.payload.text, "canonical live final");

  const cloudTerminal = canonical({
    version: 3,
    status: "completed",
    completedAtUnixMs: 30,
    payload: { text: "canonical final", content: "canonical final" }
  });
  overlay.mergeCanonical(scope, [cloudTerminal]);
  const canonicalTerminal = overlay.project(scope, [cloudTerminal]);
  assert.equal(canonicalTerminal.length, 1);
  assert.equal(canonicalTerminal[0]?.version, 3);
  assert.equal(canonicalTerminal[0]?.status, "completed");
  assert.equal(canonicalTerminal[0]?.payload.text, "canonical final");
});

test("authoritative history removes a terminal optimistic row from a retracted Turn", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const initial = canonical({
    payload: {
      clientSubmitId: "submit-1",
      text: "old answer",
      content: "old answer"
    }
  });
  overlay.mergeCanonical(scope, [initial]);
  overlay.apply(
    delta({ operation: "set", value: "old final answer" }, "completed")
  );
  assert.equal(overlay.project(scope, [initial]).length, 1);

  overlay.reconcileAuthoritativeHistory(scope, [], []);

  assert.deepEqual(overlay.project(scope, []), []);
});

test("authoritative history preserves terminal optimistic rows whose stable identity remains effective", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const initial = canonical({
    payload: {
      clientSubmitId: "submit-1",
      text: "answer",
      content: "answer"
    }
  });
  overlay.mergeCanonical(scope, [initial]);
  overlay.apply(
    delta({ operation: "set", value: "final answer" }, "completed")
  );

  overlay.reconcileAuthoritativeHistory(scope, [], [effectiveTurn()]);
  assert.equal(overlay.project(scope, []).length, 1);

  overlay.reconcileAuthoritativeHistory(
    scope,
    [
      canonical({
        messageId: "replacement-message",
        turnId: "turn-2",
        payload: { clientSubmitId: "submit-1", text: "replacement" }
      })
    ],
    [effectiveTurn({ turnId: "turn-2" })]
  );
  assert.equal(
    overlay
      .project(scope, [])
      .some((message) => message.messageId === "message-1"),
    true
  );
});

test("rejects a nonterminal delta after canonical terminal truth", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const terminal = canonical({
    status: "completed",
    completedAtUnixMs: 30,
    payload: { text: "final", content: "final" }
  });
  overlay.mergeCanonical(scope, [terminal]);

  assert.deepEqual(
    overlay.apply(delta({ operation: "append_text", text: " late" })),
    {
      applied: false,
      needsReconcile: true,
      reason: "late_after_terminal"
    }
  );
  assert.equal(overlay.project(scope, [terminal])[0]?.payload.text, "final");
});

test("allows a terminal set to correct an earlier terminal projection", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const terminal = canonical({
    status: "completed",
    completedAtUnixMs: 30,
    payload: { text: "first final", content: "first final" }
  });
  overlay.mergeCanonical(scope, [terminal]);

  assert.deepEqual(
    overlay.apply(
      delta({ operation: "set", value: "corrected final" }, "completed")
    ),
    {
      applied: true,
      needsReconcile: false
    }
  );
  assert.equal(
    overlay.project(scope, [terminal])[0]?.payload.text,
    "corrected final"
  );
});

test("normalizes missing canonical workspace identity without duplicate messages or a false missing anchor", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const withoutWorkspace = canonical({
    workspaceId: undefined,
    version: 1,
    payload: { text: "Hel", content: "Hel" }
  });
  overlay.mergeCanonical(scope, [withoutWorkspace]);
  assert.equal(
    overlay.apply(delta({ operation: "append_text", text: "lo" })).applied,
    true
  );
  const appended = overlay.project(scope, [withoutWorkspace]);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.workspaceId, scope.workspaceId);
  assert.equal(appended[0]?.payload.text, "Hello");

  overlay.mergeCanonical(scope, [withoutWorkspace]);
  overlay.apply(delta({ operation: "set", value: "replacement" }));
  const replaced = overlay.project(scope, [withoutWorkspace]);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.payload.text, "replacement");
});

test("canonical merge and reset affect only their exact workspace and Session scope", () => {
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
  overlay.mergeCanonical(firstScope, [first]);
  overlay.mergeCanonical(secondScope, [second]);
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

  overlay.mergeCanonical(firstScope, [first]);
  assert.equal(
    overlay.project(firstScope, [first])[0]?.payload.text,
    "first optimistic"
  );
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

test("partial canonical confirmation preserves an unrelated optimistic append anchor", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  overlay.apply(delta({ operation: "set", value: "正在" }));
  const unrelated = canonical({
    messageId: "message-2",
    version: 1,
    payload: { text: "其他消息", content: "其他消息" }
  });

  overlay.mergeCanonical(scope, [unrelated]);

  assert.deepEqual(
    overlay.apply(delta({ operation: "append_text", text: "检查" })),
    { applied: true, needsReconcile: false }
  );
  const projected = overlay.project(scope, [unrelated]);
  assert.equal(
    projected.find((message) => message.messageId === "message-1")?.payload
      .text,
    "正在检查"
  );
  assert.equal(
    projected.find((message) => message.messageId === "message-2")?.payload
      .text,
    "其他消息"
  );
});

test("ordinary canonical omission preserves an optimistic append anchor", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  overlay.apply(delta({ operation: "set", value: "正在" }));

  overlay.mergeCanonical(scope, []);

  assert.deepEqual(
    overlay.apply(delta({ operation: "append_text", text: "检查" })),
    { applied: true, needsReconcile: false }
  );
  assert.equal(overlay.project(scope, [])[0]?.payload.text, "正在检查");
});

test("projects a gapped canonical tool preview as a stable output anchor", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const toolPreview = canonical({
    messageId: "tool-1",
    version: 3,
    kind: "tool_call",
    status: "running",
    payload: { toolName: "Read", title: "Read" }
  });
  overlay.previewCanonical(scope, [toolPreview]);

  assert.equal(overlay.project(scope, [])[0]?.messageId, "tool-1");
  const output = delta(undefined);
  output.data.messageId = "tool-1";
  output.data.kind = "tool_call";
  output.data.toolOutput = {
    operation: "append_text",
    text: "first output",
    offsetBytes: 0
  };
  assert.deepEqual(overlay.apply(output), {
    applied: true,
    needsReconcile: false
  });
  assert.deepEqual(overlay.project(scope, [])[0]?.payload.output, {
    text: "first output"
  });
});

test("keeps a newer tool preview across an older ordinary canonical read", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const preview = canonical({
    messageId: "tool-1",
    version: 3,
    kind: "tool_call",
    status: "running",
    payload: { toolName: "Read", title: "new preview" }
  });
  overlay.previewCanonical(scope, [preview]);

  overlay.mergeCanonical(scope, [
    canonical({
      messageId: "tool-1",
      version: 2,
      kind: "tool_call",
      status: "running",
      payload: { toolName: "Read", title: "old canonical" }
    })
  ]);

  assert.equal(overlay.project(scope, [])[0]?.version, 3);
  assert.equal(overlay.project(scope, [])[0]?.payload.title, "new preview");
});

test("authoritative history preserves a tool preview only while its Turn is active", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const preview = canonical({
    messageId: "tool-1",
    version: 3,
    kind: "tool_call",
    status: "running",
    payload: { toolName: "Read", title: "Read" }
  });
  overlay.previewCanonical(scope, [preview]);

  overlay.reconcileAuthoritativeHistory(
    scope,
    [],
    [effectiveTurn({ phase: "running" })]
  );
  assert.equal(overlay.project(scope, []).length, 1);

  overlay.reconcileAuthoritativeHistory(scope, [], [effectiveTurn()]);
  assert.deepEqual(overlay.project(scope, []), []);
});

test("terminal canonical confirmation replaces a tool preview without duplication", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const running = canonical({
    messageId: "tool-1",
    version: 3,
    kind: "tool_call",
    status: "running",
    payload: { toolName: "Read", title: "Read" }
  });
  const completed = canonical({
    messageId: "tool-1",
    version: 4,
    kind: "tool_call",
    status: "completed",
    completedAtUnixMs: 30,
    payload: { toolName: "Read", title: "Read", output: { text: "done" } }
  });
  overlay.previewCanonical(scope, [running]);

  overlay.mergeCanonical(scope, [completed]);

  const projected = overlay.project(scope, [completed]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.status, "completed");
  assert.deepEqual(projected[0]?.payload.output, { text: "done" });
});

test("a canceled gapped tool preview updates in place before authoritative confirmation", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  overlay.previewCanonical(scope, [
    canonical({
      messageId: "tool-1",
      version: 3,
      kind: "tool_call",
      status: "running",
      payload: { toolName: "Read", title: "Read" }
    })
  ]);

  overlay.previewCanonical(scope, [
    canonical({
      messageId: "tool-1",
      version: 4,
      kind: "tool_call",
      status: "canceled",
      completedAtUnixMs: 30,
      payload: { toolName: "Read", title: "Read" }
    })
  ]);

  const projected = overlay.project(scope, []);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.messageId, "tool-1");
  assert.equal(projected[0]?.status, "canceled");
});

test("authoritative history preserves a nonterminal projection for an active Turn", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  overlay.apply(delta({ operation: "set", value: "正在检查" }));

  overlay.reconcileAuthoritativeHistory(
    scope,
    [],
    [effectiveTurn({ phase: "running" })]
  );

  assert.equal(overlay.project(scope, [])[0]?.payload.text, "正在检查");
});

test("authoritative history clears a nonterminal projection after its Turn settles", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  overlay.apply(delta({ operation: "set", value: "正在检查" }));

  overlay.reconcileAuthoritativeHistory(scope, [], [effectiveTurn()]);

  assert.deepEqual(overlay.project(scope, []), []);
});

test("applies payload set and unset atomically", () => {
  const overlay = createAgentActivityOptimisticMessageOverlay();
  const base = canonical({
    payload: { text: "base", private: true, preserved: "yes" }
  });
  overlay.mergeCanonical(scope, [base]);
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
  overlay.mergeCanonical(scope, [toolBase]);
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
  overlay.mergeCanonical(scope, [toolBase]);
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
