import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeDesktopAgentGUIPrefillPromptActivation,
  resolveDesktopAgentGUIPrefillPromptActivation
} from "./desktopAgentGUIPrefillPromptActivation.ts";
import { desktopAgentGUIPrefillPromptActivationType } from "../desktopAgentGUINodeState.ts";

test("resolveDesktopAgentGUIPrefillPromptActivation extracts valid prefill requests", () => {
  assert.deepEqual(
    resolveDesktopAgentGUIPrefillPromptActivation({
      payload: {
        agentTargetId: " local:codex ",
        draftPrompt: " Review this issue ",
        model: " gpt-5.4 ",
        modelPlanId: " plan-codex ",
        provider: "codex",
        userProjectPath: " /workspace/app/ "
      },
      sequence: 7,
      type: desktopAgentGUIPrefillPromptActivationType
    }),
    {
      agentTargetId: "local:codex",
      draftPrompt: "Review this issue",
      model: "gpt-5.4",
      modelPlanId: "plan-codex",
      provider: "codex",
      sequence: 7,
      userProjectPath: "/workspace/app/"
    }
  );

  assert.equal(
    resolveDesktopAgentGUIPrefillPromptActivation({
      payload: { draftPrompt: "   " },
      sequence: 8,
      type: desktopAgentGUIPrefillPromptActivationType
    }),
    null
  );
});

test("consumeDesktopAgentGUIPrefillPromptActivation clears matched activation once", () => {
  const cleared: unknown[] = [];
  const handled: number[] = [];
  const activation = {
    payload: { draftPrompt: " Draft only " },
    sequence: 11,
    type: desktopAgentGUIPrefillPromptActivationType
  };

  assert.deepEqual(
    consumeDesktopAgentGUIPrefillPromptActivation({
      activation,
      clearNodeActivation: (nodeId, sequence) => {
        cleared.push({ nodeId, sequence });
      },
      handledSequence: null,
      markHandled: (sequence) => {
        handled.push(sequence);
      },
      nodeId: "node-1"
    }),
    {
      draftPrompt: "Draft only",
      sequence: 11
    }
  );
  assert.deepEqual(handled, [11]);
  assert.deepEqual(cleared, [{ nodeId: "node-1", sequence: 11 }]);

  assert.equal(
    consumeDesktopAgentGUIPrefillPromptActivation({
      activation,
      clearNodeActivation: (nodeId, sequence) => {
        cleared.push({ nodeId, sequence });
      },
      handledSequence: 11,
      markHandled: (sequence) => {
        handled.push(sequence);
      },
      nodeId: "node-1"
    }),
    null
  );
  assert.deepEqual(handled, [11]);
  assert.deepEqual(cleared, [{ nodeId: "node-1", sequence: 11 }]);
});
