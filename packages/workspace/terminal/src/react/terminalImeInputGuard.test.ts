import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalImeInputGuard,
  type TerminalImeKeyEvent
} from "./terminalImeInputGuard.ts";

test("terminal IME guard suppresses terminal input while composition is active", () => {
  const guard = createTerminalImeInputGuard({});

  guard.handleCompositionStart();

  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "z" })), false);
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: " " })), false);
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "Enter" })), false);
  assert.equal(
    guard.shouldProcessKeyEvent(keyEvent({ key: "ArrowDown" })),
    false
  );
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "Shift" })), true);
});

test("terminal IME guard allows regular input outside composition", () => {
  const guard = createTerminalImeInputGuard({});

  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "a" })), true);
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "Enter" })), true);
});

test("terminal IME guard suppresses the key that commits composition", () => {
  let now = 1_000;
  const guard = createTerminalImeInputGuard({ now: () => now });
  const event = keyEvent({
    key: "Enter",
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  });

  guard.handleCompositionStart();
  guard.handleCompositionEnd();

  assert.equal(guard.shouldProcessKeyEvent(event), false);
  now += 100;
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "a" })), true);
});

test("terminal IME guard prevents native input for post-composition commit keys", () => {
  let preventDefaultCalls = 0;
  let stopPropagationCalls = 0;
  const guard = createTerminalImeInputGuard({});

  guard.handleCompositionStart();
  guard.handleCompositionEnd();

  assert.equal(
    guard.shouldProcessKeyEvent(
      keyEvent({
        key: " ",
        preventDefault: () => {
          preventDefaultCalls += 1;
        },
        stopPropagation: () => {
          stopPropagationCalls += 1;
        }
      })
    ),
    false
  );
  assert.equal(preventDefaultCalls, 1);
  assert.equal(stopPropagationCalls, 1);
});

test("terminal IME guard keeps the post-composition window open for repeated native events", () => {
  let now = 1_000;
  const guard = createTerminalImeInputGuard({ now: () => now });

  guard.handleCompositionStart();
  guard.handleCompositionEnd();

  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: " " })), false);
  now += 10;
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: " " })), false);
  now += 100;
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: " " })), true);
});

test("terminal IME guard does not prevent native input during active composition", () => {
  let preventDefaultCalls = 0;
  const guard = createTerminalImeInputGuard({});

  guard.handleCompositionStart();

  assert.equal(
    guard.shouldProcessKeyEvent(
      keyEvent({
        key: "z",
        preventDefault: () => {
          preventDefaultCalls += 1;
        }
      })
    ),
    false
  );
  assert.equal(preventDefaultCalls, 0);
});

test("terminal IME guard does not suppress delayed input after composition", () => {
  let now = 1_000;
  const guard = createTerminalImeInputGuard({ now: () => now });

  guard.handleCompositionStart();
  guard.handleCompositionEnd();
  now += 100;

  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "a" })), true);
});

test("terminal IME guard consumes post-composition state for shortcuts", () => {
  const guard = createTerminalImeInputGuard({});

  guard.handleCompositionStart();
  guard.handleCompositionEnd();

  assert.equal(
    guard.shouldProcessKeyEvent(keyEvent({ ctrlKey: true, key: "c" })),
    true
  );
  assert.equal(guard.shouldProcessKeyEvent(keyEvent({ key: "a" })), true);
});

function keyEvent(
  overrides: Partial<TerminalImeKeyEvent>
): TerminalImeKeyEvent {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "a",
    metaKey: false,
    type: "keydown",
    ...overrides
  };
}
