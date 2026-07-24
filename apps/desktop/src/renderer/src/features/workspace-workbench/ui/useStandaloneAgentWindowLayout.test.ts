import assert from "node:assert/strict";
import test from "node:test";
import { subscribeStandaloneAgentWindowLayout } from "./useStandaloneAgentWindowLayout.ts";

test("standalone Agent layout tracks renderer resize events and host layout state", () => {
  let hostLayoutListener:
    | ((layout: { compactTitlebar: boolean; maximized: boolean }) => void)
    | undefined;
  let resizeListener: (() => void) | undefined;
  let hostDisposed = false;
  let resizeListenerRemoved = false;
  let committedFrames = 0;
  let maximized = false;

  const dispose = subscribeStandaloneAgentWindowLayout({
    commitWindowFrame: () => {
      committedFrames += 1;
    },
    hostWindowApi: {
      onLayout: (listener) => {
        hostLayoutListener = listener;
        return () => {
          hostDisposed = true;
        };
      }
    },
    resizeTarget: {
      addEventListener: (_type, listener) => {
        resizeListener = listener;
      },
      removeEventListener: (_type, listener) => {
        resizeListenerRemoved = listener === resizeListener;
      }
    },
    setIsWindowMaximized: (nextMaximized) => {
      maximized = nextMaximized;
    }
  });

  resizeListener?.();
  assert.equal(committedFrames, 1);

  hostLayoutListener?.({ compactTitlebar: false, maximized: true });
  assert.equal(committedFrames, 2);
  assert.equal(maximized, true);

  dispose();
  assert.equal(hostDisposed, true);
  assert.equal(resizeListenerRemoved, true);
});
