import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTerminalClipboardShortcut,
  type TerminalClipboardShortcutEvent
} from "./terminalClipboardShortcuts.ts";

function createEvent(
  overrides: Partial<TerminalClipboardShortcutEvent> = {}
): TerminalClipboardShortcutEvent {
  return {
    altKey: false,
    ctrlKey: true,
    key: "c",
    metaKey: false,
    repeat: false,
    shiftKey: false,
    type: "keydown",
    ...overrides
  };
}

test("copies a selection with Ctrl+C and preserves Ctrl+C as PTY input otherwise", () => {
  assert.equal(
    resolveTerminalClipboardShortcut(createEvent(), {
      hasSelection: true,
      platform: "other"
    }),
    "copy"
  );
  assert.equal(
    resolveTerminalClipboardShortcut(createEvent(), {
      hasSelection: false,
      platform: "other"
    }),
    null
  );
});

test("pastes with Ctrl+V and Ctrl+Shift+V", () => {
  for (const shiftKey of [false, true]) {
    assert.equal(
      resolveTerminalClipboardShortcut(createEvent({ key: "v", shiftKey }), {
        hasSelection: false,
        platform: "other"
      }),
      "paste"
    );
  }
});

test("supports the Windows terminal Insert-key clipboard shortcuts", () => {
  assert.equal(
    resolveTerminalClipboardShortcut(
      createEvent({ key: "Insert", shiftKey: true }),
      {
        hasSelection: false,
        platform: "other"
      }
    ),
    "paste"
  );
  assert.equal(
    resolveTerminalClipboardShortcut(createEvent({ key: "Insert" }), {
      hasSelection: true,
      platform: "other"
    }),
    "copy"
  );
});

test("uses Command shortcuts on macOS and does not treat Control as Command", () => {
  assert.equal(
    resolveTerminalClipboardShortcut(
      createEvent({ ctrlKey: false, key: "c", metaKey: true }),
      { hasSelection: true, platform: "mac" }
    ),
    "copy"
  );
  assert.equal(
    resolveTerminalClipboardShortcut(
      createEvent({ ctrlKey: false, key: "v", metaKey: true }),
      { hasSelection: false, platform: "mac" }
    ),
    "paste"
  );
  assert.equal(
    resolveTerminalClipboardShortcut(createEvent({ key: "v" }), {
      hasSelection: false,
      platform: "mac"
    }),
    null
  );
});

test("ignores keyup, repeats, and Alt-modified shortcuts", () => {
  for (const overrides of [
    { type: "keyup" },
    { repeat: true },
    { altKey: true }
  ]) {
    assert.equal(
      resolveTerminalClipboardShortcut(createEvent(overrides), {
        hasSelection: true,
        platform: "other"
      }),
      null
    );
  }
});
