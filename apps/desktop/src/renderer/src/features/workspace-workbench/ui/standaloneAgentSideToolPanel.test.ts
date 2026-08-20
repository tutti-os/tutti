import assert from "node:assert/strict";
import test from "node:test";
import {
  closeStandaloneAgentSideWithRecovery,
  resolveStandaloneAgentSideTabReconciliation,
  shouldCloseStandaloneAgentSide,
  shouldRestoreStandaloneAgentSide
} from "./standaloneAgentSideToolPanel.ts";

test("Side tab reconciliation opens, retains, replaces, and removes exact identities", () => {
  const first = {
    sideAgentSessionId: "side-1",
    sourceAgentSessionId: "source-1"
  };
  assert.deepEqual(
    resolveStandaloneAgentSideTabReconciliation({ current: null, next: first }),
    { closeTabId: null, open: first }
  );
  assert.deepEqual(
    resolveStandaloneAgentSideTabReconciliation({
      current: { ...first, tabId: "tab-1" },
      next: first
    }),
    { closeTabId: null, open: null }
  );
  const reparented = {
    sideAgentSessionId: "side-1",
    sourceAgentSessionId: "source-2"
  };
  assert.deepEqual(
    resolveStandaloneAgentSideTabReconciliation({
      current: { ...first, tabId: "tab-1" },
      next: reparented
    }),
    { closeTabId: "tab-1", open: reparented }
  );
  const second = {
    sideAgentSessionId: "side-2",
    sourceAgentSessionId: "source-1"
  };
  assert.deepEqual(
    resolveStandaloneAgentSideTabReconciliation({
      current: { ...first, tabId: "tab-1" },
      next: second
    }),
    { closeTabId: "tab-1", open: second }
  );
  assert.deepEqual(
    resolveStandaloneAgentSideTabReconciliation({
      current: { ...second, tabId: "tab-2" },
      next: null
    }),
    { closeTabId: "tab-2", open: null }
  );
});

test("closing a stale Side tab cannot close a newer runtime Side", () => {
  const current = {
    sideAgentSessionId: "side-1",
    sourceAgentSessionId: "source-1",
    tabId: "tab-1"
  };
  assert.equal(
    shouldCloseStandaloneAgentSide({
      closingTabId: "tab-1",
      current,
      projection: current
    }),
    true
  );
  assert.equal(
    shouldCloseStandaloneAgentSide({
      closingTabId: "tab-1",
      current,
      projection: {
        sideAgentSessionId: "side-2",
        sourceAgentSessionId: "source-1"
      }
    }),
    false
  );
  assert.equal(
    shouldCloseStandaloneAgentSide({
      closingTabId: "tab-stale",
      current,
      projection: current
    }),
    false
  );
});

test("a failed close restores only the same exact runtime Side", () => {
  const closing = {
    sideAgentSessionId: "side-1",
    sourceAgentSessionId: "source-1"
  };
  assert.equal(
    shouldRestoreStandaloneAgentSide({ closing, projection: closing }),
    true
  );
  assert.equal(
    shouldRestoreStandaloneAgentSide({
      closing,
      projection: { ...closing, sideAgentSessionId: "side-2" }
    }),
    false
  );
  assert.equal(
    shouldRestoreStandaloneAgentSide({ closing, projection: null }),
    false
  );
});

test("close failure restores the exact Side while success does not", async () => {
  const closing = {
    sideAgentSessionId: "side-1",
    sourceAgentSessionId: "source-1"
  };
  const restored: (typeof closing)[] = [];
  await closeStandaloneAgentSideWithRecovery({
    closing,
    close: async () => {
      throw new Error("daemon unavailable");
    },
    getProjection: () => closing,
    restore: (identity) => restored.push(identity)
  });
  await closeStandaloneAgentSideWithRecovery({
    closing,
    close: async () => {},
    getProjection: () => closing,
    restore: (identity) => restored.push(identity)
  });

  assert.deepEqual(restored, [closing]);
});
