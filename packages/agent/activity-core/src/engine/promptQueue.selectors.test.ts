import assert from "node:assert/strict";
import test from "node:test";
import { createInitialAgentSessionEngineState } from "./rootReducer.ts";
import { promptQueueReducer } from "./promptQueue.reducer.ts";
import { selectEngineHasQueuedPrompts } from "./promptQueue.selectors.ts";

test("workspace queued-prompt selector hides prompt queue storage shape", () => {
  const initial = createInitialAgentSessionEngineState();
  assert.equal(selectEngineHasQueuedPrompts(initial), false);

  const queued = promptQueueReducer(initial.promptQueue, {
    type: "queue/enqueued",
    agentSessionId: "session-1",
    workspaceId: "workspace-1",
    prompt: {
      id: "prompt-1",
      content: [{ type: "text", text: "Review" }],
      displayPrompt: "Review",
      createdAtUnixMs: 1
    }
  });
  assert.equal(
    selectEngineHasQueuedPrompts({ ...initial, promptQueue: queued.state }),
    true
  );
});
