import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { createWorkspaceAgentEngineSendAnalytics } from "./workspaceAgentEngineSendAnalytics.ts";

function collectingReporter() {
  const events: ReporterEventInput[] = [];
  return {
    events,
    reporterService: {
      trackEvents: async (batch: ReporterEventInput[]) => {
        events.push(...batch);
      }
    }
  };
}

function eventNames(events: ReporterEventInput[]): string[] {
  return events.map((event) => event.name);
}

const activatedSession = {
  agentSessionId: "session-1",
  cwd: "/projects/demo",
  provider: "claude-code"
};

test("engine send analytics reports session_started and message_sent for new activations", async () => {
  const { events, reporterService } = collectingReporter();
  const analytics = createWorkspaceAgentEngineSendAnalytics({
    reporterService
  });

  await analytics.trackSessionActivated(
    {
      agentSessionId: "session-1",
      agentTargetId: "local:claude-code",
      clientSubmitId: "submit-1",
      initialContent: [{ type: "text", text: "hello agent" }],
      mode: "new",
      settings: { model: "opus", permissionModeId: "ask-before-write" },
      workspaceId: "ws-1"
    },
    {
      activation: { mode: "new", status: "attached" },
      session: activatedSession as never
    } as never
  );

  const names = eventNames(events);
  assert.ok(names.includes("agent.session_started"));
  assert.ok(names.includes("agent.message_sent"));
  const sessionStarted = events.find(
    (event) => event.name === "agent.session_started"
  );
  assert.equal(sessionStarted?.params?.provider, "claude-code");
  assert.equal(sessionStarted?.params?.permission_mode, "ask-before-write");
  assert.equal(sessionStarted?.params?.source, "launchpad");
  const messageSent = events.find(
    (event) => event.name === "agent.message_sent"
  );
  assert.equal(messageSent?.params?.provider, "claude-code");
  assert.equal(messageSent?.params?.conversation_index, 1);
  const nodeResults = events.filter(
    (event) => event.name === "agent.node_result"
  );
  assert.deepEqual(
    nodeResults.map((event) => event.params?.node),
    ["activate_session", "session_started_reported", "message_sent_reported"]
  );
});

test("engine send analytics skips funnel events for existing-session activations", async () => {
  const { events, reporterService } = collectingReporter();
  const analytics = createWorkspaceAgentEngineSendAnalytics({
    reporterService
  });

  await analytics.trackSessionActivated(
    {
      agentSessionId: "session-1",
      mode: "existing",
      workspaceId: "ws-1"
    },
    {
      activation: { mode: "existing", status: "already_attached" },
      session: activatedSession as never
    } as never
  );

  assert.deepEqual(eventNames(events), ["agent.node_result"]);
});

test("engine send analytics skips funnel events for failed activations", async () => {
  const { events, reporterService } = collectingReporter();
  const analytics = createWorkspaceAgentEngineSendAnalytics({
    reporterService
  });

  await analytics.trackSessionActivated(
    {
      agentSessionId: "session-1",
      agentTargetId: "local:claude-code",
      clientSubmitId: "submit-1",
      mode: "new",
      workspaceId: "ws-1"
    },
    {
      activation: { mode: "new", status: "failed" },
      error: { code: "boom", message: "activation failed" },
      session: activatedSession as never
    } as never
  );

  const names = eventNames(events);
  assert.ok(!names.includes("agent.session_started"));
  assert.ok(!names.includes("agent.message_sent"));
  const nodeResult = events.find((event) => event.name === "agent.node_result");
  assert.equal(nodeResult?.params?.status, "failure");
});

test("engine send analytics reports message_sent with queue state for sends", async () => {
  const { events, reporterService } = collectingReporter();
  const analytics = createWorkspaceAgentEngineSendAnalytics({
    reporterService
  });

  await analytics.trackSendInputResolved(
    {
      agentSessionId: "session-1",
      clientSubmitId: "submit-2",
      content: [{ type: "text", text: "/compact please" }],
      submitDiagnostics: { queued: true },
      workspaceId: "ws-1"
    },
    {
      kind: "turn",
      session: activatedSession,
      turn: { phase: "submitted" },
      turnId: "turn-1"
    } as never
  );

  const messageSent = events.find(
    (event) => event.name === "agent.message_sent"
  );
  assert.equal(messageSent?.params?.is_queued, true);
  assert.equal(messageSent?.params?.has_slash_command, true);
  assert.equal(messageSent?.params?.provider, "claude-code");
  const nodeResults = events.filter(
    (event) => event.name === "agent.node_result"
  );
  assert.deepEqual(
    nodeResults.map((event) => event.params?.node),
    ["send_input_request", "message_sent_reported"]
  );
});

test("engine send analytics reports message_stopped for canceled turns", async () => {
  const { events, reporterService } = collectingReporter();
  const analytics = createWorkspaceAgentEngineSendAnalytics({
    reporterService
  });

  await analytics.trackTurnCanceled({
    agentSessionId: "session-1",
    provider: "codex"
  });

  assert.deepEqual(eventNames(events), ["agent.message_stopped"]);
  assert.equal(events[0]?.params?.provider, "codex");
});

test("engine send analytics reports a failed send_input_request node", async () => {
  const { events, reporterService } = collectingReporter();
  const analytics = createWorkspaceAgentEngineSendAnalytics({
    reporterService
  });

  await analytics.trackSendInputFailed(
    {
      agentSessionId: "session-1",
      clientSubmitId: "submit-3",
      content: [{ type: "text", text: "hello" }],
      workspaceId: "ws-1"
    },
    new Error("network down")
  );

  assert.deepEqual(eventNames(events), ["agent.node_result"]);
  const nodeResult = events[0];
  assert.equal(nodeResult?.params?.node, "send_input_request");
  assert.equal(nodeResult?.params?.status, "failure");
});
