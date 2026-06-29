import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceWizardReveal,
  getAgentEnvWizardSnapshot,
  markWizardAutoStarted,
  resetAgentEnvWizardStoreForTests,
  resetWizardForOpen,
  restartWizardReveal,
  setWizardCopied,
  setWizardReportState,
  subscribeAgentEnvWizardStore,
  toggleWizardLog,
  REVEAL_ALL
} from "./agentEnvWizardStore.ts";

test("resetWizardForOpen parks reveal at REVEAL_ALL for a non-detect focus", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("install");
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, REVEAL_ALL);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "idle");
  assert.equal(getAgentEnvWizardSnapshot().autoStartedSeq, null);
});

test("resetWizardForOpen rewinds reveal to 0 for a detect focus", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("detect");
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, 0);
});

test("advanceWizardReveal increments the cursor", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("detect");
  advanceWizardReveal();
  advanceWizardReveal();
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, 2);
});

test("markWizardAutoStarted records the dedup sequence", () => {
  resetAgentEnvWizardStoreForTests();
  markWizardAutoStarted(7);
  assert.equal(getAgentEnvWizardSnapshot().autoStartedSeq, 7);
});

test("restartWizardReveal rewinds reveal and clears report state, copied, logExpanded", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("install");
  setWizardReportState("dismissed");
  setWizardCopied(true);
  toggleWizardLog();
  restartWizardReveal();
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, 0);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "idle");
  assert.equal(getAgentEnvWizardSnapshot().copied, false);
  assert.equal(getAgentEnvWizardSnapshot().logExpanded, false);
});

test("restartWizardReveal PRESERVES autoStartedSeq", () => {
  resetAgentEnvWizardStoreForTests();
  markWizardAutoStarted(5);
  restartWizardReveal();
  assert.equal(getAgentEnvWizardSnapshot().autoStartedSeq, 5);
});

test("subscribers fire on mutation", () => {
  resetAgentEnvWizardStoreForTests();
  let calls = 0;
  const unsub = subscribeAgentEnvWizardStore(() => {
    calls += 1;
  });
  advanceWizardReveal();
  unsub();
  advanceWizardReveal();
  assert.equal(calls, 1);
});
