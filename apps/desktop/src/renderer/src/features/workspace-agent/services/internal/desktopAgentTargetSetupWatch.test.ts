import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHostAgentTargetSetupSnapshot } from "@tutti-os/agent-gui";
import { createDesktopAgentTargetSetupWatch } from "./desktopAgentTargetSetupWatch.ts";

test("target setup watch loads, installs, polls, and stops after unsubscribe", async () => {
  const notInstalled = snapshot("not_installed");
  const installing = snapshot("installing");
  const ready = snapshot("ready");
  let getCalls = 0;
  let installCalls = 0;
  const observedStates: Array<{ loading: boolean; status?: string }> = [];
  const watch = createDesktopAgentTargetSetupWatch({
    agentTargetId: "extension:gemini",
    get: async () => (++getCalls === 1 ? notInstalled : ready),
    install: async () => {
      installCalls += 1;
      return installing;
    },
    authenticate: async () => ready,
    pollIntervalMs: 1
  });
  let resolveInitial: () => void = () => undefined;
  let resolveReady: () => void = () => undefined;
  const initialLoaded = new Promise<void>((resolve) => {
    resolveInitial = resolve;
  });
  const readyLoaded = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const unsubscribe = watch.subscribe((state) => {
    observedStates.push({
      loading: state.loading,
      status: state.snapshot?.status
    });
    if (state.snapshot?.status === "not_installed") resolveInitial();
    if (state.snapshot?.status === "ready") resolveReady();
  });

  await initialLoaded;
  await watch.install({
    planDigest: "a".repeat(64),
    clientActionId: "client-1"
  });
  assert.deepEqual(watch.getSnapshot().snapshot, installing);
  await readyLoaded;
  assert.equal(getCalls, 2);
  assert.equal(installCalls, 1);
  assert.equal(
    observedStates.some(
      (state) => state.status === "installing" && state.loading
    ),
    false,
    "background progress polling must not restart runtime detection"
  );

  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(getCalls, 2);
});

test("target setup watch authenticates and polls until ready", async () => {
  const authRequired = {
    ...snapshot("auth_required"),
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }]
  };
  const authenticating = {
    ...snapshot("authenticating"),
    action: {
      actionId: "auth-1",
      clientActionId: "client-auth-1",
      kind: "authenticate" as const,
      status: "running" as const,
      phase: "authenticating" as const,
      errorCode: null,
      errorMessage: null
    }
  };
  const ready = snapshot("ready");
  let getCalls = 0;
  const watch = createDesktopAgentTargetSetupWatch({
    agentTargetId: "extension:gemini",
    get: async () => (++getCalls === 1 ? authRequired : ready),
    install: async () => authenticating,
    authenticate: async ({ methodId }) => {
      assert.equal(methodId, "oauth-personal");
      return authenticating;
    },
    pollIntervalMs: 1
  });
  let resolveAuthRequired: () => void = () => undefined;
  let resolveReady: () => void = () => undefined;
  const authRequiredLoaded = new Promise<void>((resolve) => {
    resolveAuthRequired = resolve;
  });
  const readyLoaded = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const unsubscribe = watch.subscribe((state) => {
    if (state.snapshot?.status === "auth_required") resolveAuthRequired();
    if (state.snapshot?.status === "ready") resolveReady();
  });

  await authRequiredLoaded;
  await watch.authenticate({
    methodId: "oauth-personal",
    clientActionId: "client-auth-1"
  });
  assert.equal(watch.getSnapshot().snapshot?.status, "authenticating");
  await readyLoaded;
  assert.equal(getCalls, 2);
  unsubscribe();
});

test("target setup watch keeps polling pending setup after a transient refresh failure", async () => {
  const notInstalled = snapshot("not_installed");
  const installing = snapshot("installing");
  const ready = snapshot("ready");
  let getCalls = 0;
  const observedStates: Array<{
    failed: boolean;
    loading: boolean;
    status?: string;
  }> = [];
  const watch = createDesktopAgentTargetSetupWatch({
    agentTargetId: "extension:gemini",
    get: async () => {
      getCalls += 1;
      if (getCalls === 1) return notInstalled;
      if (getCalls === 2) throw new Error("temporary status fetch failure");
      return ready;
    },
    install: async () => installing,
    authenticate: async () => ready,
    pollIntervalMs: 1
  });
  let resolveInitial: () => void = () => undefined;
  let resolveFailedPoll: () => void = () => undefined;
  let resolveReady: () => void = () => undefined;
  const initialLoaded = new Promise<void>((resolve) => {
    resolveInitial = resolve;
  });
  const failedPollObserved = new Promise<void>((resolve) => {
    resolveFailedPoll = resolve;
  });
  const readyLoaded = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const unsubscribe = watch.subscribe((state) => {
    observedStates.push({
      failed: state.failed,
      loading: state.loading,
      status: state.snapshot?.status
    });
    if (state.snapshot?.status === "not_installed") resolveInitial();
    if (state.snapshot?.status === "installing" && state.failed) {
      resolveFailedPoll();
    }
    if (state.snapshot?.status === "ready") resolveReady();
  });

  await initialLoaded;
  await watch.install({
    planDigest: "a".repeat(64),
    clientActionId: "client-1"
  });
  await failedPollObserved;
  await readyLoaded;

  assert.equal(getCalls, 3);
  assert.equal(
    observedStates.some(
      (state) => state.status === "installing" && state.failed && !state.loading
    ),
    true,
    "transient background failure must surface without restarting detection loading"
  );
  unsubscribe();
});

function snapshot(
  status: AgentHostAgentTargetSetupSnapshot["status"]
): AgentHostAgentTargetSetupSnapshot {
  return {
    agentTargetId: "extension:gemini",
    authMethods: [],
    account: null,
    status,
    runtimeSource: null,
    runtimeVersion: null,
    reason: null,
    plan: null,
    action: null
  };
}
