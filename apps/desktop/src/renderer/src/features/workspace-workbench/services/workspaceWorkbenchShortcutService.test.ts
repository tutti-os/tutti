import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkbenchShortcutAction } from "./workspaceWorkbenchShortcutService.ts";

function keyEvent(
  init: Partial<KeyboardEvent> & { key: string }
): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    ...init
  } as KeyboardEvent;
}

test("matches configured binding", () => {
  const shortcuts = { newAgentConversation: "Meta+K", newSameTypeWindow: null };
  assert.equal(
    resolveWorkbenchShortcutAction(
      keyEvent({ key: "k", metaKey: true }),
      shortcuts
    ),
    "new-agent-conversation"
  );
});

test("returns null when binding unset", () => {
  assert.equal(
    resolveWorkbenchShortcutAction(keyEvent({ key: "k", metaKey: true }), {
      newAgentConversation: null,
      newSameTypeWindow: null
    }),
    null
  );
});
