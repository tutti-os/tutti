import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentActivityMessageDeltaEvent } from "./liveEventParsing.ts";

test("parseAgentActivityMessageDeltaEvent cleans a valid transport payload", () => {
  const parsed = parseAgentActivityMessageDeltaEvent({
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
      occurredAtUnixMs: 100,
      content: { operation: "append_text", text: "lo" },
      payloadSet: { nested: { exact: 9_007_199_254_740_991 } },
      payloadUnset: ["stale", "stale"],
      status: "streaming"
    }
  });

  assert.deepEqual(parsed, {
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
      occurredAtUnixMs: 100,
      content: { operation: "append_text", text: "lo" },
      payloadSet: { nested: { exact: 9_007_199_254_740_991 } },
      payloadUnset: ["stale"],
      status: "streaming"
    }
  });
});

test("parseAgentActivityMessageDeltaEvent rejects malformed or mismatched data", () => {
  const base = {
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
      occurredAtUnixMs: 100,
      content: { operation: "set", value: "Hel" }
    }
  };
  assert.equal(
    parseAgentActivityMessageDeltaEvent({
      ...base,
      data: { ...base.data, agentSessionId: "session-2" }
    }),
    null
  );
  assert.equal(
    parseAgentActivityMessageDeltaEvent({
      ...base,
      data: {
        ...base.data,
        content: { operation: "append_text" }
      }
    }),
    null
  );
  assert.equal(
    parseAgentActivityMessageDeltaEvent({
      ...base,
      data: { ...base.data, content: undefined }
    }),
    null
  );
  assert.equal(
    parseAgentActivityMessageDeltaEvent({
      ...base,
      data: {
        ...base.data,
        occurredAtUnixMs: Number.MAX_SAFE_INTEGER + 1
      }
    }),
    null
  );
});

test("parseAgentActivityMessageDeltaEvent validates tool output operations", () => {
  const base = {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_delta",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      messageId: "tool-1",
      turnId: "turn-1",
      role: "assistant",
      kind: "tool_call",
      occurredAtUnixMs: 100
    }
  };
  assert.deepEqual(
    parseAgentActivityMessageDeltaEvent({
      ...base,
      data: {
        ...base.data,
        toolOutput: {
          operation: "append_text",
          text: "好",
          offsetBytes: 3
        }
      }
    })?.data.toolOutput,
    { operation: "append_text", text: "好", offsetBytes: 3 }
  );
  assert.equal(
    parseAgentActivityMessageDeltaEvent({
      ...base,
      data: {
        ...base.data,
        toolOutput: { operation: "append_text", text: "missing offset" }
      }
    }),
    null
  );
  assert.equal(
    parseAgentActivityMessageDeltaEvent({
      ...base,
      data: {
        ...base.data,
        kind: "text",
        toolOutput: { operation: "set", text: "not a tool" }
      }
    }),
    null
  );
});
