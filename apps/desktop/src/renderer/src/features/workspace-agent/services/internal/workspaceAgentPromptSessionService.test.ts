import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { WorkspaceAgentPromptSessionService } from "./workspaceAgentPromptSessionService.ts";

function activatedSession(input: {
  agentSessionId: string;
  cwd?: string;
  workspaceId?: string | null;
}) {
  return normalizeAgentActivitySession({
    workspaceId: input.workspaceId ?? "workspace-1",
    agentSessionId: input.agentSessionId,
    provider: "codex" as const,
    providerSessionId: input.agentSessionId,
    cwd: input.cwd ?? "",
    title: "Codex",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1
  });
}

function createLegacyAgentReporterService(
  reporterCalls: ReporterEventInput[][]
) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      const legacyEvents = events
        .filter((event) => event.name !== "agent.node_result")
        .map(stripAgentAnalyticsErrorFields);
      if (legacyEvents.length > 0) {
        reporterCalls.push(legacyEvents);
      }
    }
  };
}

function stripAgentAnalyticsErrorFields(
  event: ReporterEventInput
): ReporterEventInput {
  if (!event.name.startsWith("agent.")) {
    return event;
  }
  const eventParams = event.params ?? {};
  const {
    error_code: _errorCode,
    error_message: _errorMessage,
    ...params
  } = eventParams;
  return { ...event, params };
}

test("workspace agent prompt session service creates a new session with initial prompt content", async () => {
  let capturedActivation: unknown;
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceAgentPromptSessionService({
    reporterNow: () => 1749124800000,
    reporterService: createLegacyAgentReporterService(reporterCalls),
    workspaceAgentActivityService: {
      async activateSession(input) {
        capturedActivation = input;
        return {
          activation: { mode: "new", status: "attached" },
          session: activatedSession(input)
        };
      }
    }
  });

  const result = await service.createSession({
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    cwd: "/workspace/project",
    prompt: "  Build the feature  ",
    source: "issue_manager",
    title: "Build feature",
    workspaceId: "workspace-1"
  });

  const activation = capturedActivation as Record<string, unknown>;
  assert.match(String(activation.clientSubmitId), /^prompt-session:/);
  assert.deepEqual(
    { ...activation, clientSubmitId: "generated" },
    {
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      clientSubmitId: "generated",
      cwd: "/workspace/project",
      initialContent: [{ type: "text", text: "Build the feature" }],
      mode: "new",
      title: "Build feature",
      visible: true,
      workspaceId: "workspace-1"
    }
  );
  assert.deepEqual(result, {
    agentSessionId: "session-1",
    provider: "codex"
  });
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "agent.session_started",
        params: {
          agent_session_id: "session-1",
          has_custom_model: false,
          has_project: true,
          permission_mode: null,
          provider: "codex",
          source: "issue_manager"
        }
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "agent.message_sent",
        params: {
          agent_session_id: "session-1",
          conversation_index: 1,
          has_file_mention: false,
          has_slash_command: false,
          is_queued: false,
          provider: "codex"
        }
      }
    ]
  ]);
});

test("workspace agent prompt session service reports successful node results", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceAgentPromptSessionService({
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    workspaceAgentActivityService: {
      async activateSession(input) {
        return {
          activation: { mode: "new", status: "attached" },
          session: activatedSession(input)
        };
      }
    }
  });

  await service.createSession({
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    prompt: "Build the feature",
    workspaceId: "workspace-1"
  });

  const nodeResults = reporterCalls
    .flat()
    .filter((event) => event.name === "agent.node_result");
  assert.deepEqual(
    nodeResults.map((event) => ({
      flow: event.params?.flow,
      node: event.params?.node,
      status: event.params?.status
    })),
    [
      {
        flow: "session_create",
        node: "prompt_validated",
        status: "success"
      },
      {
        flow: "session_create",
        node: "activate_session",
        status: "success"
      },
      {
        flow: "session_create",
        node: "session_started_reported",
        status: "success"
      },
      {
        flow: "session_create",
        node: "message_sent_reported",
        status: "success"
      }
    ]
  );
  for (const event of nodeResults) {
    assert.deepEqual(
      {
        durationMs: event.params?.duration_ms,
        errorCode: event.params?.error_code,
        errorMessage: event.params?.error_message,
        legacyNodeName: event.params?.node_name,
        legacySuccess: event.params?.success
      },
      {
        durationMs: null,
        errorCode: "agent_error_none",
        errorMessage: "",
        legacyNodeName: event.params?.node,
        legacySuccess: true
      }
    );
  }
});

test("workspace agent prompt session service rejects failed activation", async () => {
  const service = new WorkspaceAgentPromptSessionService({
    workspaceAgentActivityService: {
      async activateSession(input) {
        return {
          activation: { mode: "new", status: "failed" },
          error: {
            code: "provider_unavailable",
            message: "provider unavailable"
          },
          session: activatedSession(input)
        };
      }
    }
  });

  await assert.rejects(
    () =>
      service.createSession({
        agentTargetId: "local:codex",
        prompt: "Build",
        workspaceId: "workspace-1"
      }),
    /provider unavailable/
  );
});

test("workspace agent prompt session service maps user project selection to cwd", async () => {
  let capturedActivation: unknown;
  const service = new WorkspaceAgentPromptSessionService({
    workspaceAgentActivityService: {
      async activateSession(input) {
        capturedActivation = input;
        return {
          activation: { mode: "new", status: "attached" },
          session: activatedSession(input)
        };
      }
    },
    workspaceUserProjectService: {
      isNoProjectPath(path) {
        return path === "/workspace/no-project";
      }
    }
  });

  await service.createSession({
    agentSessionId: "session-2",
    agentTargetId: "local:codex",
    cwd: "/workspace/fallback",
    prompt: "Build",
    userProjectPath: "/workspace/project",
    workspaceId: "workspace-1"
  });

  assert.equal(
    (capturedActivation as { cwd?: string }).cwd,
    "/workspace/project"
  );

  await service.createSession({
    agentSessionId: "session-3",
    agentTargetId: "local:codex",
    cwd: "/workspace/fallback",
    prompt: "Build",
    userProjectPath: "/workspace/no-project",
    workspaceId: "workspace-1"
  });

  assert.equal((capturedActivation as { cwd?: string }).cwd, undefined);
});
