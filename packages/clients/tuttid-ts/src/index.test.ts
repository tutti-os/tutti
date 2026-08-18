import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorMarketClientError,
  createTuttidClient,
  createClient,
  getTuttidErrorI18nCandidates,
  getTuttidProtocolErrorCode,
  getHealth,
  listWorkspaces,
  TuttidProtocolError,
  normalizeTuttidError,
  type ApiErrorResponse,
  type AgentProviderComposerOptionsResponse,
  type AppReferenceListResponse,
  type CliCapabilitiesResponse,
  type IssueManagerReferenceSearchResponse,
  type ListAgentTargetsResponse,
  type ListWorkspacesResponse,
  type WorkspaceFilePreviewResponse,
  type WorkspaceAgentSessionWorktreeSupportResponse,
  type WorkspaceManagedWorktreeListResponse,
  type DeleteWorkspaceManagedWorktreeResponse,
  type WorkspaceGitPatchSupportResponse,
  type WorkspaceGitPatchResponse
} from "./index.ts";

type CapturedRequest = {
  authorization: string | null;
  body: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
  signal: AbortSignal;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function captureClient(
  response:
    | Response
    | ((request: CapturedRequest) => Response | Promise<Response>),
  options: Omit<Parameters<typeof createTuttidClient>[0], "fetch"> = {}
) {
  const requests: CapturedRequest[] = [];
  return {
    client: createTuttidClient({
      ...options,
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        const captured: CapturedRequest = {
          authorization: request.headers.get("authorization"),
          body: request.body ? JSON.parse(await request.text()) : null,
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          signal: request.signal
        };
        requests.push(captured);
        return typeof response === "function"
          ? response(captured)
          : response.clone();
      }
    }),
    requests
  };
}

function assertRequest(
  request: CapturedRequest,
  expected: Omit<CapturedRequest, "signal"> & { signal?: AbortSignal }
): void {
  assert.equal(request.method, expected.method);
  assert.equal(request.path, expected.path);
  assert.deepEqual(request.query, expected.query);
  assert.deepEqual(request.body, expected.body);
  assert.equal(request.authorization, expected.authorization);
  if (expected.signal) assert.equal(request.signal, expected.signal);
}

test("shared tuttid client purges deleted Agent conversations", async () => {
  const response = {
    removedSessions: 2,
    removedMessages: 5,
    payloadBytes: 128
  };
  const { client, requests } = captureClient(jsonResponse(response));

  assert.deepEqual(await client.purgeDeletedAgentConversations(), response);
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "POST",
    path: "/v1/agent-maintenance/deleted-conversations/purge",
    query: {}
  });
});

test("shared tuttid client manages workspace deleted Agent sessions", async () => {
  const listResponse = {
    workspaceId: "workspace-1",
    sessions: [
      {
        agentSessionId: "session-1",
        title: "Deleted session",
        railSectionKey: "project:/projects/tutti",
        projectPath: "/projects/tutti",
        updatedAtUnixMs: 20,
        deletedAtUnixMs: 30,
        restorable: true,
        unavailableReason: null
      }
    ],
    projectOptions: [
      {
        railSectionKey: "project:/projects/tutti",
        projectPath: "/projects/tutti",
        projectLabel: "tutti",
        projectAvailable: true
      }
    ],
    hasMore: false,
    totalCount: 1,
    workspaceTotalCount: 2
  };
  const purgeResponse = {
    removedSessions: 2,
    removedMessages: 5,
    payloadBytes: 128
  };
  const { client, requests } = captureClient((request) => {
    if (request.method === "GET") return jsonResponse(listResponse);
    if (request.path.endsWith("/restore")) {
      return jsonResponse({ agentSessionId: "session-1", restored: true });
    }
    return jsonResponse(purgeResponse);
  });
  const controller = new AbortController();

  assert.deepEqual(
    await client.listWorkspaceDeletedAgentSessions(
      "workspace-1",
      {
        cursor: "opaque-cursor",
        limit: 25,
        railSectionKey: "project:/projects/tutti",
        searchQuery: "deleted"
      },
      { signal: controller.signal }
    ),
    listResponse
  );
  assert.deepEqual(
    await client.restoreWorkspaceDeletedAgentSession(
      "workspace-1",
      "session-1"
    ),
    { agentSessionId: "session-1", restored: true }
  );
  assert.deepEqual(
    await client.purgeWorkspaceDeletedAgentSession("workspace-1", "session-1"),
    purgeResponse
  );
  assert.deepEqual(
    await client.purgeWorkspaceDeletedAgentSessions("workspace-1"),
    purgeResponse
  );

  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/workspaces/workspace-1/deleted-agent-sessions",
    query: {
      cursor: "opaque-cursor",
      limit: "25",
      railSectionKey: "project:/projects/tutti",
      searchQuery: "deleted"
    }
  });
  assertRequest(requests[1]!, {
    authorization: null,
    body: null,
    method: "POST",
    path: "/v1/workspaces/workspace-1/deleted-agent-sessions/session-1/restore",
    query: {}
  });
  assertRequest(requests[2]!, {
    authorization: null,
    body: null,
    method: "DELETE",
    path: "/v1/workspaces/workspace-1/deleted-agent-sessions/session-1",
    query: {}
  });
  assertRequest(requests[3]!, {
    authorization: null,
    body: null,
    method: "DELETE",
    path: "/v1/workspaces/workspace-1/deleted-agent-sessions",
    query: {}
  });
});

test("shared tuttid client reads and refreshes daemon-owned desktop admission", async () => {
  const snapshot = {
    featureAvailability: {
      fetchedAt: null,
      keys: ["workspace.example"],
      policyRevision: "v1",
      source: "remote"
    },
    identity: {
      architecture: "arm64",
      currentVersion: "1.0.0",
      platform: "macos",
      product: "tutti-desktop"
    },
    lastAttemptAt: "2026-08-02T09:00:00Z",
    nextForegroundCheckAt: "2026-08-02T09:30:00Z",
    policy: {
      response: {
        channel: "stable",
        decision: "allowed",
        minimumVersion: "1.0.0",
        policyRevision: "v1",
        reason: "meetsMinimum"
      },
      status: "resolved"
    }
  } as const;
  const { client, requests } = captureClient((request) =>
    jsonResponse(
      request.path.endsWith("/refresh")
        ? { performed: true, snapshot }
        : snapshot
    )
  );
  const controller = new AbortController();

  assert.deepEqual(
    await client.getDesktopUpdateAdmissionStartup({
      signal: controller.signal
    }),
    snapshot
  );
  assert.deepEqual(
    await client.refreshDesktopUpdateAdmission("foreground", {
      signal: controller.signal
    }),
    { performed: true, snapshot }
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/desktop-update-admission/startup",
    query: {}
  });
  assertRequest(requests[1]!, {
    authorization: null,
    body: { trigger: "foreground" },
    method: "POST",
    path: "/v1/desktop-update-admission/refresh",
    query: {}
  });
  controller.abort();
  assert.equal(requests[0]!.signal.aborted, true);
  assert.equal(requests[1]!.signal.aborted, true);
});

test("shared tuttid client reads and updates cassette-scoped replay playback", async () => {
  const playback = {
    drained: false,
    paused: true,
    playbackElapsedMs: 42,
    speed: 2 as const,
    timingMode: "fast-forward" as const
  };
  const { client, requests } = captureClient(() => jsonResponse(playback));

  assert.deepEqual(
    await client.getAgentSessionReplayTransportPlayback(
      "277377ed-af34-454f-a8b9-1047b4064e74"
    ),
    playback
  );
  assert.deepEqual(
    await client.updateAgentSessionReplayTransportPlayback(
      "277377ed-af34-454f-a8b9-1047b4064e74",
      { command: "set-speed", speed: 2 }
    ),
    playback
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/agent-session-replay/cassettes/277377ed-af34-454f-a8b9-1047b4064e74/transport/playback",
    query: {}
  });
  assertRequest(requests[1]!, {
    authorization: null,
    body: { command: "set-speed", speed: 2 },
    method: "POST",
    path: "/v1/agent-session-replay/cassettes/277377ed-af34-454f-a8b9-1047b4064e74/transport/playback",
    query: {}
  });
});

test("shared tuttid client prepares cassette-only replay workspace launches", async () => {
  const response = {
    launches: [
      {
        cassetteId: "277377ed-af34-454f-a8b9-1047b4064e74",
        cassetteDirectory: "/cassette/a",
        rootAgentSessionId: "session-1"
      }
    ]
  };
  const { client, requests } = captureClient(jsonResponse(response, 201));

  assert.deepEqual(
    await client.prepareAgentSessionReplayWorkspace("workspace-1", {
      cassetteIds: ["277377ed-af34-454f-a8b9-1047b4064e74"]
    }),
    response
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: {
      cassetteIds: ["277377ed-af34-454f-a8b9-1047b4064e74"]
    },
    method: "POST",
    path: "/v1/workspaces/workspace-1/agent-session-replay-workspaces",
    query: {}
  });
});

test("shared tuttid client preserves replay workspace conflict details", async () => {
  const { client } = captureClient(
    jsonResponse(
      {
        error: {
          code: "agent_session_replay_workspace_conflict",
          reason: "agent_session_replay_workspace_conflict",
          developerMessage: "cassette file inventory mismatch"
        }
      },
      409
    )
  );

  await assert.rejects(
    () =>
      client.prepareAgentSessionReplayWorkspace("workspace-1", {
        cassetteIds: ["277377ed-af34-454f-a8b9-1047b4064e74"]
      }),
    (error: unknown) => {
      assert.ok(error instanceof TuttidProtocolError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, "cassette file inventory mismatch");
      return true;
    }
  );
});

test("shared tuttid client reports unavailable replay playback as null", async () => {
  const { client } = captureClient(
    jsonResponse(
      {
        error: {
          code: "service_unavailable",
          developerMessage: "Replay transport is unavailable"
        }
      },
      503
    )
  );

  assert.equal(
    await client.getAgentSessionReplayTransportPlayback(
      "277377ed-af34-454f-a8b9-1047b4064e74"
    ),
    null
  );
});

test("shared tuttid client performs Agent quick prompt CRUD", async () => {
  const prompt = {
    id: "prompt-1",
    title: "Review",
    content: "Review this change",
    version: 1,
    createdAtUnixMs: 10,
    updatedAtUnixMs: 10
  };
  const { client, requests } = captureClient((request) => {
    if (request.method === "GET") return jsonResponse({ prompts: [prompt] });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.path.endsWith("/move"))
      return jsonResponse({ prompts: [prompt] });
    return jsonResponse(
      { prompt: { ...prompt, version: request.method === "PUT" ? 2 : 1 } },
      request.method === "POST" ? 201 : 200
    );
  });

  assert.deepEqual(await client.listAgentQuickPrompts(), { prompts: [prompt] });
  assert.deepEqual(
    await client.createAgentQuickPrompt({
      title: prompt.title,
      content: prompt.content
    }),
    prompt
  );
  assert.equal(
    (
      await client.updateAgentQuickPrompt(prompt.id, {
        title: prompt.title,
        content: prompt.content,
        expectedVersion: 1
      })
    ).version,
    2
  );
  await client.deleteAgentQuickPrompt(prompt.id, { expectedVersion: 2 });
  assert.deepEqual(
    await client.moveAgentQuickPrompt({
      promptId: prompt.id,
      beforePromptId: null,
      expectedVersion: 2
    }),
    { prompts: [prompt] }
  );

  assert.deepEqual(
    requests.map(({ method, path, body }) => ({ method, path, body })),
    [
      { method: "GET", path: "/v1/agent-quick-prompts", body: null },
      {
        method: "POST",
        path: "/v1/agent-quick-prompts",
        body: { title: prompt.title, content: prompt.content }
      },
      {
        method: "PUT",
        path: "/v1/agent-quick-prompts/prompt-1",
        body: {
          title: prompt.title,
          content: prompt.content,
          expectedVersion: 1
        }
      },
      {
        method: "DELETE",
        path: "/v1/agent-quick-prompts/prompt-1",
        body: { expectedVersion: 2 }
      },
      {
        method: "POST",
        path: "/v1/agent-quick-prompts/move",
        body: {
          promptId: prompt.id,
          beforePromptId: null,
          expectedVersion: 2
        }
      }
    ]
  );
});

test("shared tuttid client records Collaboration Run adoption", async () => {
  const abortController = new AbortController();
  const run = {
    id: "run-1",
    workspaceId: "ws-1",
    mode: "consult",
    triggerSource: "user",
    sourceSessionId: "session-1",
    modelPlanId: "plan-1",
    model: "kimi-k2",
    status: "completed",
    adoption: "adopted",
    usage: { inputTokens: 812, outputTokens: 96 },
    durationMs: 5200,
    startedAt: "2026-07-12T00:00:00.000Z",
    completedAt: "2026-07-12T00:00:05.200Z",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:05.200Z"
  } as const;
  const { client, requests } = captureClient(jsonResponse(run));

  assert.deepEqual(
    await client.setCollaborationRunAdoption(
      "ws-1",
      "run-1",
      { adoption: "adopted" },
      { signal: abortController.signal }
    ),
    run
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: { adoption: "adopted" },
    method: "POST",
    path: "/v1/workspaces/ws-1/collaboration-runs/run-1/adoption",
    query: {}
  });
  abortController.abort();
  assert.equal(requests[0]!.signal.aborted, true);
});

test("generated tuttid client returns parsed health response", async () => {
  const client = createClient({
    baseUrl: "http://localhost:4545/",
    fetch: async () =>
      new Response(JSON.stringify({ service: "tuttid", status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });

  const response = await getHealth({ client });
  assert.deepEqual(response.data, { service: "tuttid", status: "ok" });
  assert.equal(response.error, undefined);
});

test("generated tuttid client surfaces structured protocol errors", async () => {
  const client = createClient({
    baseUrl: "http://localhost:4545",
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "workspace_operation_failed",
            reason: "workspace_operation_failed",
            developerMessage: "catalog unavailable",
            retryable: true
          }
        }),
        {
          status: 502,
          headers: { "content-type": "application/json" }
        }
      )
  });

  const response = await listWorkspaces({ client });
  assert.equal(response.data, undefined);
  assert.equal(response.response?.status, 502);
  assert.deepEqual(response.error, {
    error: {
      code: "workspace_operation_failed",
      reason: "workspace_operation_failed",
      developerMessage: "catalog unavailable",
      retryable: true
    }
  } satisfies ApiErrorResponse);
});

test("shared tuttid client calls the managed Tutti execution cancel route", async () => {
  let requestMethod = "";
  let requestPath = "";
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      return new Response(JSON.stringify({ canceledRunCount: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const response = await client.cancelTuttiModeExecution(
    "workspace-1",
    "issue-1"
  );

  assert.equal(requestMethod, "POST");
  assert.equal(
    requestPath,
    "/v1/workspaces/workspace-1/tutti-executions/issue-1/cancel-execution"
  );
  assert.deepEqual(response, { canceledRunCount: 2 });
});

test("shared tuttid client unwraps workspace list responses", async () => {
  const client = createTuttidClient({
    fetch: async () =>
      new Response(
        JSON.stringify({
          workspaces: [{ id: "ws-1", name: "One", lastOpenedAt: null }],
          totalCount: 1
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
  });

  assert.deepEqual(await client.listWorkspaces(), {
    totalCount: 1,
    workspaces: [{ id: "ws-1", name: "One", lastOpenedAt: null }]
  } satisfies ListWorkspacesResponse);
});

test("shared tuttid client preserves target, turn, goal, and auth route contracts", async (t) => {
  const codexTarget = {
    id: "local:codex",
    provider: "codex",
    launchRef: { type: "builtin_local", provider: "codex" },
    name: "Codex",
    iconKey: "codex",
    enabled: true,
    source: "system",
    sortOrder: 10,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1
  } as const;
  const tuttiTarget = {
    id: "local:tutti-agent",
    provider: "tutti-agent",
    launchRef: { type: "builtin_local", provider: "tutti-agent" },
    name: "Tutti Agent",
    iconKey: "tutti-agent",
    enabled: false,
    source: "system",
    sortOrder: 30,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2
  } as const;
  const goal = {
    session: { id: "session-1" },
    state: {
      revision: 2,
      tombstoned: true,
      syncStatus: "synced",
      lastEvidence: {},
      updatedAtUnixMs: 10
    }
  };
  const { client, requests } = captureClient(
    (request) => {
      if (request.path === "/v1/agent-targets")
        return jsonResponse({ targets: [codexTarget] });
      if (request.path.endsWith("/enabled")) return jsonResponse(tuttiTarget);
      if (request.path.endsWith("/cancel"))
        return jsonResponse({
          cancel: { canceled: true, reason: "turn_canceled" }
        });
      if (request.path.includes("/goal")) return jsonResponse(goal);
      return jsonResponse({ service: "tuttid", status: "ok" });
    },
    { auth: "desktop-session-token" }
  );
  const expected = (method: string, path: string, body: unknown = null) => ({
    authorization: "Bearer desktop-session-token",
    body,
    method,
    path,
    query: {}
  });

  await t.test("list targets", async () => {
    assert.deepEqual(await client.listAgentTargets(), {
      targets: [codexTarget]
    } satisfies ListAgentTargetsResponse);
    assertRequest(requests[0]!, expected("GET", "/v1/agent-targets"));
  });
  await t.test("update target", async () => {
    assert.equal(
      (await client.setSystemAgentTargetEnabled("local:tutti-agent", false))
        .enabled,
      false
    );
    assertRequest(
      requests[1]!,
      expected("PATCH", "/v1/agent-targets/local%3Atutti-agent/enabled", {
        enabled: false
      })
    );
  });
  await t.test("cancel turn", async () => {
    assert.deepEqual(
      await client.cancelWorkspaceAgentTurn("ws-1", "session-1", "turn-1"),
      { cancel: { canceled: true, reason: "turn_canceled" } }
    );
    assertRequest(
      requests[2]!,
      expected(
        "POST",
        "/v1/workspaces/ws-1/agent-sessions/session-1/turns/turn-1/cancel"
      )
    );
  });
  await t.test("get and reconcile goal", async () => {
    await client.getWorkspaceAgentSessionGoal("ws-1", "session-1");
    await client.reconcileWorkspaceAgentSessionGoal("ws-1", "session-1");
    assertRequest(
      requests[3]!,
      expected("GET", "/v1/workspaces/ws-1/agent-sessions/session-1/goal")
    );
    assertRequest(
      requests[4]!,
      expected(
        "POST",
        "/v1/workspaces/ws-1/agent-sessions/session-1/goal/reconcile"
      )
    );
  });
  await t.test("health auth", async () => {
    await client.getHealth();
    assertRequest(requests[5]!, expected("GET", "/v1/health"));
  });
});

test("shared tuttid client lists CLI capabilities with discovery options", async () => {
  let requestPath = "";
  let requestQueryEntries: Record<string, string> = {};

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requestPath = url.pathname;
      requestQueryEntries = Object.fromEntries(url.searchParams.entries());

      return new Response(
        JSON.stringify({
          commands: [
            {
              id: "workspace-apps.app.open",
              path: ["app", "open"],
              summary: "Open app",
              visibility: "integration",
              output: { defaultMode: "json", json: true },
              source: { kind: "builtin" }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const response = await client.listCliCapabilities("ws-1", {
    includeHidden: true,
    includeIntegration: true
  });

  assert.equal(requestPath, "/v1/cli/capabilities");
  assert.deepEqual(requestQueryEntries, {
    includeHidden: "true",
    includeIntegration: "true",
    workspaceID: "ws-1"
  });
  assert.deepEqual(response, {
    commands: [
      {
        id: "workspace-apps.app.open",
        path: ["app", "open"],
        summary: "Open app",
        visibility: "integration",
        output: { defaultMode: "json", json: true },
        source: { kind: "builtin" }
      }
    ]
  } satisfies CliCapabilitiesResponse);
});

test("shared tuttid client creates workspace agent sessions with bearer auth", async () => {
  let authorizationHeader = "";
  let agentCommandOriginHeader = "";
  let requestPath = "";
  let requestBody: unknown;
  const capturedRequest: { signal: AbortSignal | null } = { signal: null };
  const abortController = new AbortController();

  const client = createTuttidClient({
    auth: "desktop-session-token",
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizationHeader = request.headers.get("authorization") ?? "";
      agentCommandOriginHeader =
        request.headers.get("x-tutti-agent-command-origin") ?? "";
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();
      capturedRequest.signal = request.signal;

      return new Response(
        JSON.stringify({
          session: {
            id: "agent-session-1",
            provider: "codex",
            cwd: "/workspace",
            status: "running",
            title: "Investigate renderer bridge",
            createdAt: "2026-05-30T12:00:00Z",
            updatedAt: "2026-05-30T12:00:01Z"
          }
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const session = await client.createWorkspaceAgentSession(
    "ws-1",
    {
      agentSessionId: "11111111-1111-4111-8111-111111111111",
      agentTargetId: "local:codex",
      clientSubmitId: "submit-1",
      initialContent: [{ type: "text", text: "hello" }],
      planMode: true,
      submitDiagnostics: {
        blockCount: 1,
        submittedAtUnixMs: 1234,
        source: "agent-gui"
      }
    },
    {
      agentCommandOrigin: "renderer-engine",
      signal: abortController.signal
    }
  );

  assert.equal(authorizationHeader, "Bearer desktop-session-token");
  assert.equal(agentCommandOriginHeader, "renderer-engine");
  assert.equal(requestPath, "/v1/workspaces/ws-1/agent-sessions");
  assert.notEqual(capturedRequest.signal, null);
  abortController.abort();
  assert.equal(capturedRequest.signal?.aborted, true);
  assert.deepEqual(requestBody, {
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    initialContent: [{ type: "text", text: "hello" }],
    planMode: true,
    submitDiagnostics: {
      blockCount: 1,
      submittedAtUnixMs: 1234,
      source: "agent-gui"
    }
  });
  assert.deepEqual(session, {
    id: "agent-session-1",
    provider: "codex",
    cwd: "/workspace",
    status: "running",
    title: "Investigate renderer bridge",
    createdAt: "2026-05-30T12:00:00Z",
    updatedAt: "2026-05-30T12:00:01Z"
  });
});

test("shared tuttid client returns and reads durable agent session fork operations", async () => {
  const operation = {
    operationId: "operation-1",
    requestId: "request-1",
    sourceAgentSessionId: "source-1",
    targetAgentSessionId: "11111111-1111-4111-8111-111111111111",
    point: { type: "throughTurn" as const, turnId: "turn-7" },
    status: "accepted" as const,
    session: null,
    lineage: null,
    error: null
  };
  const { client, requests } = captureClient(jsonResponse({ operation }, 202));

  assert.deepEqual(
    await client.forkWorkspaceAgentSession("ws-1", "source-1", {
      targetAgentSessionId: "11111111-1111-4111-8111-111111111111",
      requestId: "request-1",
      point: { type: "throughTurn", turnId: "turn-7" }
    }),
    operation
  );
  assert.deepEqual(
    await client.getWorkspaceAgentSessionForkOperation("ws-1", "operation-1"),
    operation
  );
  assert.deepEqual(
    await client.acknowledgeWorkspaceAgentSessionForkOperation(
      "ws-1",
      "operation-1"
    ),
    operation
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: {
      targetAgentSessionId: "11111111-1111-4111-8111-111111111111",
      requestId: "request-1",
      point: { type: "throughTurn", turnId: "turn-7" }
    },
    method: "POST",
    path: "/v1/workspaces/ws-1/agent-sessions/source-1/fork",
    query: {}
  });
  assertRequest(requests[1]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/workspaces/ws-1/agent-session-fork-operations/operation-1",
    query: {}
  });
  assertRequest(requests[2]!, {
    authorization: null,
    body: null,
    method: "POST",
    path: "/v1/workspaces/ws-1/agent-session-fork-operations/operation-1/acknowledge",
    query: {}
  });
});

test("shared tuttid client sends workspace agent input diagnostics in the HTTP body", async () => {
  let requestPath = "";
  let requestBody: unknown;
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();
      return new Response(
        JSON.stringify({
          session: {
            id: "agent-session-1",
            provider: "codex",
            cwd: "/workspace",
            status: "running",
            title: "Investigate renderer bridge",
            createdAt: "2026-05-30T12:00:00Z",
            updatedAt: "2026-05-30T12:00:01Z"
          },
          turnId: "turn-1"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  await client.sendWorkspaceAgentSessionInput("ws-1", "agent-session-1", {
    clientSubmitId: "submit-2",
    content: [{ type: "text", text: "continue" }],
    submitDiagnostics: {
      blockCount: 1,
      hasImage: false,
      promptLength: 8,
      queued: false,
      source: "agent-gui",
      submittedAtUnixMs: 2345
    }
  });

  assert.equal(
    requestPath,
    "/v1/workspaces/ws-1/agent-sessions/agent-session-1/input"
  );
  assert.deepEqual(requestBody, {
    clientSubmitId: "submit-2",
    content: [{ type: "text", text: "continue" }],
    submitDiagnostics: {
      blockCount: 1,
      hasImage: false,
      promptLength: 8,
      queued: false,
      source: "agent-gui",
      submittedAtUnixMs: 2345
    }
  });
});

test("shared tuttid client lists workspace agent sessions with query params", async () => {
  let requestPath = "";
  let requestQueryEntries: Record<string, string> = {};
  const capturedRequest: { signal: AbortSignal | null } = { signal: null };
  const abortController = new AbortController();

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requestPath = url.pathname;
      requestQueryEntries = Object.fromEntries(url.searchParams.entries());
      capturedRequest.signal = request.signal;

      return new Response(
        JSON.stringify({
          hasMore: false,
          sessions: [],
          workspaceId: "ws-1"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  await client.listWorkspaceAgentSessionSectionPage(
    "ws-1",
    {
      agentTargetId: "claude-target",
      cursor: "1000|session-1",
      limit: 30,
      sectionKey: "project:/workspace/project"
    },
    { signal: abortController.signal }
  );

  assert.equal(requestPath, "/v1/workspaces/ws-1/agent-session-sections/page");
  assert.notEqual(capturedRequest.signal, null);
  abortController.abort();
  assert.equal(capturedRequest.signal?.aborted, true);
  assert.deepEqual(requestQueryEntries, {
    agentTargetId: "claude-target",
    cursor: "1000|session-1",
    limit: "30",
    sectionKey: "project:/workspace/project"
  });
});

test("shared tuttid client requests the message hydration session projection", async () => {
  const response = {
    childSessions: [],
    lifecycleCapabilitiesProjected: false,
    projection: "messageHydration",
    session: {},
    turns: []
  };
  const { client, requests } = captureClient(jsonResponse(response));
  const controller = new AbortController();

  assert.deepEqual(
    await client.getWorkspaceAgentSession(
      "workspace-1",
      "session-1",
      "messageHydration",
      { signal: controller.signal }
    ),
    response
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/workspaces/workspace-1/agent-sessions/session-1",
    query: { projection: "messageHydration" }
  });
  assert.equal(requests[0]!.signal?.aborted, false);
  controller.abort();
  assert.equal(requests[0]!.signal?.aborted, true);
});

test("shared tuttid client rejects a mismatched session detail projection", async () => {
  const { client } = captureClient(
    jsonResponse({
      childSessions: [],
      lifecycleCapabilitiesProjected: true,
      projection: "full",
      session: {},
      turns: []
    })
  );

  await assert.rejects(
    client.getWorkspaceAgentSession(
      "workspace-1",
      "session-1",
      "messageHydration"
    ),
    /projection mismatch/
  );
});

test("shared tuttid client forwards AbortSignal for issue topic and issue list requests", async () => {
  const requests: Request[] = [];
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      return new Response(
        JSON.stringify(
          path.endsWith("/issue-topics")
            ? { topics: [] }
            : { issues: [], statusCounts: {}, totalCount: 0 }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });
  const abortController = new AbortController();

  await client.listWorkspaceIssueTopics("ws-1", {
    signal: abortController.signal
  });
  await client.listWorkspaceIssues(
    "ws-1",
    { pageSize: 10, searchQuery: "task", topicId: "topic-1" },
    { signal: abortController.signal }
  );

  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/v1/workspaces/ws-1/issue-topics", "/v1/workspaces/ws-1/issues"]
  );
  abortController.abort();
  assert.equal(
    requests.every((request) => request.signal.aborted),
    true
  );
});

test("shared tuttid client forwards AbortSignal for Agent effect writes", async () => {
  const { client, requests } = captureClient((request) => {
    if (request.path.endsWith("/cancel")) {
      return jsonResponse({
        cancel: { canceled: true, reason: "turn_canceled" }
      });
    }
    if (request.path.endsWith("/input")) {
      return jsonResponse({
        session: {},
        turn: {},
        turnId: "turn-1"
      });
    }
    return jsonResponse({ session: {} });
  });
  const abortController = new AbortController();
  const options = { signal: abortController.signal };

  await client.cancelWorkspaceAgentTurn("ws-1", "session-1", "turn-1", options);
  await client.sendWorkspaceAgentSessionInput(
    "ws-1",
    "session-1",
    { clientSubmitId: "submit-1", content: [] },
    options
  );
  await client.updateWorkspaceAgentSessionSettings(
    "ws-1",
    "session-1",
    { model: "model-1" },
    options
  );
  await client.submitWorkspaceAgentInteractive(
    "ws-1",
    "session-1",
    "request-1",
    { turnId: "turn-1" },
    options
  );
  await client.updateWorkspaceAgentSessionPin(
    "ws-1",
    "session-1",
    { pinned: true },
    options
  );
  await client.updateWorkspaceAgentSessionTitle(
    "ws-1",
    "session-1",
    { title: "Renamed session" },
    options
  );

  abortController.abort();
  assert.equal(requests.length, 6);
  assert.equal(
    requests.every((request) => request.signal.aborted),
    true
  );
});

test("shared tuttid client lists section deletion candidates with pinned exclusion", async () => {
  let requestPath = "";
  let requestQueryEntries: Record<string, string> = {};
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requestPath = url.pathname;
      requestQueryEntries = Object.fromEntries(url.searchParams.entries());
      return new Response(
        JSON.stringify({
          excludePinned: true,
          sectionKey: "conversations",
          sessionIds: ["session-1"],
          workspaceId: "ws-1"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const result =
    await client.listWorkspaceAgentSessionSectionDeletionCandidates("ws-1", {
      agentTargetId: "codex-target",
      excludePinned: true,
      sectionKey: "conversations"
    });

  assert.equal(
    requestPath,
    "/v1/workspaces/ws-1/agent-session-sections/deletion-candidates"
  );
  assert.deepEqual(requestQueryEntries, {
    agentTargetId: "codex-target",
    excludePinned: "true",
    sectionKey: "conversations"
  });
  assert.deepEqual(result.sessionIds, ["session-1"]);
});

test("shared tuttid client deletes an exact session ID batch in one request", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();
      return new Response(
        JSON.stringify({
          removedMessages: 2,
          removedSessionIds: ["session-1", "session-2"],
          removedSessions: 2
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  await client.deleteWorkspaceAgentSessionsBatch("ws-1", {
    sessionIds: ["session-1", "session-2"]
  });

  assert.equal(requestMethod, "DELETE");
  assert.equal(requestPath, "/v1/workspaces/ws-1/agent-sessions/batch");
  assert.deepEqual(requestBody, {
    sessionIds: ["session-1", "session-2"]
  });
});

test("shared tuttid client launches workspace apps", async () => {
  let requestMethod = "";
  let requestPath = "";

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;

      return new Response(
        JSON.stringify({
          workspaceId: "ws-1",
          app: {
            appId: "app-1",
            displayName: "App",
            version: "0.1.0",
            description: "Test app",
            createdAtUnixMs: 1,
            iconUrl: null,
            availableVersion: null,
            availableIconUrl: null,
            updateAvailable: false,
            installed: true,
            enabled: true,
            status: "running",
            stateRevision: 2,
            launchUrl: "http://127.0.0.1:3000",
            port: 3000,
            failureReason: null,
            lastError: null,
            startedAtUnixMs: 1,
            updatedAtUnixMs: 2,
            source: "imported",
            exportable: true,
            tags: [],
            localizations: [],
            minimizeBehavior: "keep-mounted",
            windowMinWidth: null,
            windowMinHeight: null,
            cli: {
              active: false,
              issues: [],
              scope: null,
              status: "none"
            }
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const app = await client.launchWorkspaceApp("ws-1", "app-1");

  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/workspaces/ws-1/apps/app-1/launch");
  assert.equal(app.appId, "app-1");
  assert.equal(app.status, "running");
});

test("shared tuttid client lists workspace app references with exact body", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();

      return new Response(
        JSON.stringify({
          workspaceId: "ws-1",
          appId: "docs",
          items: [
            {
              type: "group",
              id: "reports",
              displayName: "Reports",
              description: null,
              referenceCount: 12
            }
          ],
          nextCursor: null
        } satisfies AppReferenceListResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const response = await client.listWorkspaceAppReferences("ws-1", "docs", {
    parentGroupId: "root",
    filterText: "guide",
    limit: 10,
    cursor: "cursor-1",
    kinds: ["file"],
    timeRange: {
      fromMs: 1000,
      toMs: 2000
    }
  });

  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/workspaces/ws-1/apps/docs/references/list");
  assert.deepEqual(requestBody, {
    parentGroupId: "root",
    filterText: "guide",
    limit: 10,
    cursor: "cursor-1",
    kinds: ["file"],
    timeRange: {
      fromMs: 1000,
      toMs: 2000
    }
  });
  assert.deepEqual(response, {
    workspaceId: "ws-1",
    appId: "docs",
    items: [
      {
        type: "group",
        id: "reports",
        displayName: "Reports",
        description: null,
        referenceCount: 12
      }
    ],
    nextCursor: null
  } satisfies AppReferenceListResponse);
});

test("shared tuttid client prepares completes and cancels workspace app uploads", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.body ? await request.json() : null;
      requests.push({ method: request.method, path, body });

      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/complete")) {
        return new Response(
          JSON.stringify({
            file: {
              path: "/state/apps/installations/canvas/data/uploads/2c/hash.png",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
              sha256: "hash"
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(
        JSON.stringify({
          uploadId: "upload-1",
          expiresAt: "2026-06-24T12:15:00Z"
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const session = await client.prepareWorkspaceAppUpload("ws-1", "canvas", {
    purpose: "app-asset",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 5
  });
  const file = await client.completeWorkspaceAppUpload(
    "ws-1",
    "canvas",
    "upload-1"
  );
  await client.cancelWorkspaceAppUpload("ws-1", "canvas", "upload-1");

  assert.deepEqual(session, {
    uploadId: "upload-1",
    expiresAt: "2026-06-24T12:15:00Z"
  });
  assert.deepEqual(file, {
    path: "/state/apps/installations/canvas/data/uploads/2c/hash.png",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 5,
    sha256: "hash"
  });
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/v1/workspaces/ws-1/apps/canvas/uploads",
      body: {
        purpose: "app-asset",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 5
      }
    },
    {
      method: "POST",
      path: "/v1/workspaces/ws-1/apps/canvas/uploads/upload-1/complete",
      body: null
    },
    {
      method: "DELETE",
      path: "/v1/workspaces/ws-1/apps/canvas/uploads/upload-1",
      body: null
    }
  ]);
});

test("shared tuttid client searches workspace issue references with exact body", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();

      return new Response(
        JSON.stringify({
          workspaceId: "ws-1",
          items: [
            {
              issueTitle: "Ship landing page",
              output: {
                outputId: "out-1",
                runId: "run-1",
                taskId: "task-1",
                issueId: "issue-1",
                workspaceId: "ws-1",
                path: "/ws/out/login.html",
                displayName: "login.html",
                mediaType: "text/html",
                sizeBytes: 1024,
                createdAtUnix: 1700
              }
            }
          ]
        } satisfies IssueManagerReferenceSearchResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const response = await client.searchWorkspaceIssueReferences("ws-1", {
    query: "login",
    limit: 20,
    issueId: "issue-1"
  });

  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/workspaces/ws-1/issue-references/search");
  assert.deepEqual(requestBody, {
    query: "login",
    limit: 20,
    issueId: "issue-1"
  });
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.issueTitle, "Ship landing page");
  assert.equal(response.items[0]?.output.displayName, "login.html");
});

test("shared tuttid client sends authenticated project mutations and analytics", async (t) => {
  const project = (id: string, pinnedAtUnixMs: number) => ({
    createdAtUnixMs: 1,
    id,
    label: id,
    lastUsedAtUnixMs: 1,
    path: `/workspace/${id}`,
    pinnedAtUnixMs,
    sectionKey: `project:/workspace/${id}`,
    updatedAtUnixMs: pinnedAtUnixMs || 1
  });
  const { client, requests } = captureClient(
    (request) => {
      if (request.path === "/v1/user-projects")
        return new Response(null, { status: 204 });
      if (request.path === "/v1/track")
        return new Response(null, { status: 202 });
      if (request.path.endsWith("/move"))
        return jsonResponse({
          projects: [project("project-2", 0), project("project-1", 0)]
        });
      return jsonResponse({ projects: [project("project-1", 2)] });
    },
    { auth: "desktop-session-token" }
  );
  const events = [
    {
      name: "workspace.opened",
      client_ts: 1749124800000,
      params: { source: "dashboard" }
    }
  ];

  await t.test("delete", async () => {
    await client.deleteUserProject({ path: "/workspace/app" });
    assertRequest(requests[0]!, {
      authorization: "Bearer desktop-session-token",
      body: { path: "/workspace/app" },
      method: "DELETE",
      path: "/v1/user-projects",
      query: {}
    });
  });
  await t.test("move", async () => {
    const response = await client.moveUserProject({
      beforeProjectId: "project-1",
      projectId: "project-2"
    });
    assertRequest(requests[1]!, {
      authorization: "Bearer desktop-session-token",
      body: { beforeProjectId: "project-1", projectId: "project-2" },
      method: "POST",
      path: "/v1/user-projects/move",
      query: {}
    });
    assert.deepEqual(
      response.projects.map((item) => item.id),
      ["project-2", "project-1"]
    );
  });
  await t.test("pin", async () => {
    const response = await client.pinUserProject({
      pinned: true,
      projectId: "project-1"
    });
    assertRequest(requests[2]!, {
      authorization: "Bearer desktop-session-token",
      body: { pinned: true, projectId: "project-1" },
      method: "POST",
      path: "/v1/user-projects/pin",
      query: {}
    });
    assert.equal(response.projects[0]?.pinnedAtUnixMs, 2);
  });
  await t.test("analytics", async () => {
    await client.trackEvents(events);
    assertRequest(requests[3]!, {
      authorization: "Bearer desktop-session-token",
      body: { events },
      method: "POST",
      path: "/v1/track",
      query: {}
    });
  });
});

test("shared tuttid client reads workspace file preview bytes", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestQuery = "";

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requestMethod = request.method;
      requestPath = url.pathname;
      requestQuery = url.searchParams.get("path") ?? "";

      return new Response(
        JSON.stringify({
          bytesBase64: "aGVsbG8=",
          name: "todo.md",
          path: "/workspace/docs/todo.md",
          root: "/workspace",
          sizeBytes: 5,
          workspaceId: "ws-1"
        } satisfies WorkspaceFilePreviewResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const preview = await client.readWorkspaceFilePreview(
    "ws-1",
    "/workspace/docs/todo.md"
  );

  assert.equal(requestMethod, "GET");
  assert.equal(requestPath, "/v1/workspaces/ws-1/files/file/preview");
  assert.equal(requestQuery, "/workspace/docs/todo.md");
  assert.equal(preview.bytesBase64, "aGVsbG8=");
  assert.equal(preview.sizeBytes, 5);
});

test("shared tuttid client applies a workspace git patch", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();

      return new Response(
        JSON.stringify({
          appliedPaths: ["src/app.ts"],
          conflictedPaths: [],
          skippedPaths: [],
          status: "success"
        } satisfies WorkspaceGitPatchResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const response = await client.applyWorkspaceGitPatch("ws-1", {
    cwd: "/workspace",
    diff: "diff --git a/src/app.ts b/src/app.ts\n",
    revert: true
  });

  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/workspaces/ws-1/git-patch");
  assert.deepEqual(requestBody, {
    cwd: "/workspace",
    diff: "diff --git a/src/app.ts b/src/app.ts\n",
    revert: true
  });
  assert.deepEqual(response, {
    appliedPaths: ["src/app.ts"],
    conflictedPaths: [],
    skippedPaths: [],
    status: "success"
  });
});

test("shared tuttid client resolves workspace git patch support", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestQueryEntries: Record<string, string> = {};

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requestMethod = request.method;
      requestPath = url.pathname;
      requestQueryEntries = Object.fromEntries(url.searchParams.entries());

      return new Response(
        JSON.stringify({
          root: "/workspace",
          supported: true
        } satisfies WorkspaceGitPatchSupportResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const response = await client.resolveWorkspaceGitPatchSupport(
    "ws-1",
    "/workspace"
  );

  assert.equal(requestMethod, "GET");
  assert.equal(requestPath, "/v1/workspaces/ws-1/git-patch-support");
  assert.deepEqual(requestQueryEntries, { cwd: "/workspace" });
  assert.deepEqual(response, {
    root: "/workspace",
    supported: true
  });
});

test("shared tuttid client carries the exact Agent target into worktree support", async () => {
  const response = {
    root: "/workspace",
    supported: true
  } satisfies WorkspaceAgentSessionWorktreeSupportResponse;
  const { client, requests } = captureClient(jsonResponse(response));

  assert.deepEqual(
    await client.resolveWorkspaceAgentSessionWorktreeSupport(
      "ws-1",
      "local:codex",
      "/workspace"
    ),
    response
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/workspaces/ws-1/agent-session-worktree-support",
    query: { agentTargetId: "local:codex", cwd: "/workspace" }
  });
});

test("shared tuttid client lists independent managed worktrees", async () => {
  const response = {
    worktrees: [
      {
        baseCommit: "abc",
        branch: "tutti/worktree/worktree-1",
        repoRoot: "/repo",
        workspaceId: "ws-1",
        worktreeId: "worktree-1",
        worktreePath: "/state/worktrees/worktree-1"
      }
    ]
  } satisfies WorkspaceManagedWorktreeListResponse;
  const { client, requests } = captureClient(jsonResponse(response));

  assert.deepEqual(
    await client.listWorkspaceManagedWorktrees("ws-1"),
    response
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/workspaces/ws-1/managed-worktrees",
    query: {}
  });
});

test("shared tuttid client explicitly deletes a managed worktree", async () => {
  const response = {
    deleted: true
  } satisfies DeleteWorkspaceManagedWorktreeResponse;
  const { client, requests } = captureClient(jsonResponse(response));

  assert.deepEqual(
    await client.deleteWorkspaceManagedWorktree("ws-1", "worktree-1"),
    response
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "DELETE",
    path: "/v1/workspaces/ws-1/managed-worktrees/worktree-1",
    query: {}
  });
});

test("shared tuttid client loads agent provider composer options", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;
  const capturedRequest: { signal: AbortSignal | null } = { signal: null };
  const abortController = new AbortController();

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();
      capturedRequest.signal = request.signal;

      return new Response(
        JSON.stringify({
          effectiveSettings: {
            model: "gpt-5",
            permissionModeId: "auto",
            planMode: false,
            reasoningEffort: "high"
          },
          modelConfig: {
            configurable: true,
            currentValue: "gpt-5",
            defaultValue: "gpt-5",
            options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
          },
          permissionConfig: {
            configurable: true,
            defaultValue: "auto",
            modes: [
              {
                id: "auto",
                label: "Approve for me",
                semantic: "auto"
              }
            ]
          },
          provider: "codex",
          reasoningConfig: {
            configurable: true,
            currentValue: "high",
            defaultValue: "high",
            options: [{ id: "high", label: "High", value: "high" }]
          },
          runtimeContext: {
            configOptions: [
              {
                currentValue: "gpt-5",
                id: "model",
                options: [{ name: "GPT-5", value: "gpt-5" }]
              }
            ]
          },
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
        } satisfies AgentProviderComposerOptionsResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const result = await client.getAgentProviderComposerOptions(
    "codex",
    {
      settings: {
        model: "gpt-5",
        reasoningEffort: "high"
      }
    },
    {
      signal: abortController.signal
    }
  );

  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/agent-providers/codex/composer-options");
  assert.notEqual(capturedRequest.signal, null);
  abortController.abort();
  assert.equal(capturedRequest.signal?.aborted, true);
  assert.deepEqual(requestBody, {
    settings: {
      model: "gpt-5",
      reasoningEffort: "high"
    }
  });
  assert.deepEqual(result, {
    effectiveSettings: {
      model: "gpt-5",
      permissionModeId: "auto",
      planMode: false,
      reasoningEffort: "high"
    },
    modelConfig: {
      configurable: true,
      currentValue: "gpt-5",
      defaultValue: "gpt-5",
      options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
    },
    permissionConfig: {
      configurable: true,
      defaultValue: "auto",
      modes: [
        {
          id: "auto",
          label: "Approve for me",
          semantic: "auto"
        }
      ]
    },
    provider: "codex",
    reasoningConfig: {
      configurable: true,
      currentValue: "high",
      defaultValue: "high",
      options: [{ id: "high", label: "High", value: "high" }]
    },
    runtimeContext: {
      configOptions: [
        {
          currentValue: "gpt-5",
          id: "model",
          options: [{ name: "GPT-5", value: "gpt-5" }]
        }
      ]
    },
    skills: [],
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: false,
      refreshModelOptionsAfterSettings: false,
      prewarmDraftSession: false,
      planModeExclusiveWithPermissionMode: false
    },
    capabilityCatalog: [],
    reasoningOptionsByModel: {},
    commands: []
  } satisfies AgentProviderComposerOptionsResponse);
});

test("shared tuttid client loads app factory provider composer options", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();

      return new Response(
        JSON.stringify({
          effectiveSettings: {
            model: "sonnet",
            permissionModeId: "default",
            planMode: false,
            reasoningEffort: "high"
          },
          modelConfig: {
            configurable: true,
            currentValue: "sonnet",
            defaultValue: "sonnet",
            options: [{ id: "sonnet", label: "Sonnet", value: "sonnet" }]
          },
          permissionConfig: {
            configurable: true,
            defaultValue: "default",
            modes: [
              {
                id: "default",
                label: "Ask for approval",
                semantic: "ask-before-write"
              }
            ]
          },
          provider: "claude-code",
          reasoningConfig: {
            configurable: true,
            currentValue: "high",
            defaultValue: "high",
            options: [{ id: "high", label: "High", value: "high" }]
          },
          runtimeContext: {},
          skills: [],
          behavior: {
            collapseModelOptionsToLatest: false,
            modelOptionsAuthoritative: false,
            refreshModelOptionsAfterSettings: false,
            prewarmDraftSession: false,
            planModeExclusiveWithPermissionMode: false
          },
          capabilityCatalog: [],
          reasoningOptionsByModel: {},
          commands: []
        } satisfies AgentProviderComposerOptionsResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const result = await client.getWorkspaceAppFactoryAgentTargetComposerOptions(
    "workspace-1",
    "local:claude-code",
    {
      settings: {
        reasoningEffort: "high"
      }
    }
  );

  assert.equal(requestMethod, "POST");
  assert.equal(
    requestPath,
    "/v1/workspaces/workspace-1/app-factory/agent-targets/local%3Aclaude-code/composer-options"
  );
  assert.deepEqual(requestBody, {
    settings: {
      reasoningEffort: "high"
    }
  });
  assert.equal(result.provider, "claude-code");
  assert.equal(result.effectiveSettings.model, "sonnet");
});

test("shared tuttid client sends route-only provider and session commands", async (t) => {
  const { client, requests } = captureClient((request) => {
    if (request.path.endsWith("/probe"))
      return jsonResponse({
        checkedAt: "2026-06-02T08:00:00.000Z",
        command: ["/usr/local/bin/codex"],
        provider: "codex",
        status: "ready"
      });
    if (request.path.endsWith("/run"))
      return jsonResponse({
        actionID: "install",
        completedAt: "2026-06-02T08:00:00.000Z",
        provider: "codex",
        status: "completed"
      });
    return jsonResponse(
      request.path.endsWith("agent-sessions")
        ? { removedMessages: 5, removedSessions: 2 }
        : { removed: true }
    );
  });
  await t.test("probe", async () => {
    assert.deepEqual(await client.probeAgentProvider("codex"), {
      checkedAt: "2026-06-02T08:00:00.000Z",
      command: ["/usr/local/bin/codex"],
      provider: "codex",
      status: "ready"
    });
    assertRequest(requests[0]!, {
      authorization: null,
      body: null,
      method: "POST",
      path: "/v1/agent-providers/codex/probe",
      query: {}
    });
  });
  await t.test("action", async () => {
    assert.deepEqual(await client.runAgentProviderAction("codex", "install"), {
      actionID: "install",
      completedAt: "2026-06-02T08:00:00.000Z",
      provider: "codex",
      status: "completed"
    });
    assertRequest(requests[1]!, {
      authorization: null,
      body: null,
      method: "POST",
      path: "/v1/agent-providers/codex/actions/install/run",
      query: {}
    });
  });
  await t.test("delete session", async () => {
    assert.deepEqual(
      await client.deleteWorkspaceAgentSession("ws-1", "agent-session-1"),
      { removed: true }
    );
    assertRequest(requests[2]!, {
      authorization: null,
      body: null,
      method: "DELETE",
      path: "/v1/workspaces/ws-1/agent-sessions/agent-session-1",
      query: {}
    });
  });
  await t.test("clear sessions", async () => {
    assert.deepEqual(await client.clearWorkspaceAgentSessions("ws-1"), {
      removedMessages: 5,
      removedSessions: 2
    });
    assertRequest(requests[3]!, {
      authorization: null,
      body: null,
      method: "DELETE",
      path: "/v1/workspaces/ws-1/agent-sessions",
      query: {}
    });
  });
});

test("shared tuttid client opts into cached provider update discovery", async () => {
  const { client, requests } = captureClient(() =>
    jsonResponse({
      capturedAt: "2026-06-02T08:00:00.000Z",
      defaultProvider: "codex",
      providers: []
    })
  );

  await client.getAgentProviderStatuses({
    providers: ["codex"],
    includeUpdates: true,
    refreshUpdates: true
  });

  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/agent-providers/status",
    query: {
      includeUpdates: "true",
      providers: "codex",
      refreshUpdates: "true"
    }
  });
});

test("shared tuttid client submits one scoped workspace agent plan decision", async () => {
  let requestBody: unknown;
  let requestMethod = "";
  let requestPath = "";
  const response = {
    operation: {
      agentSessionId: "session-1",
      idempotencyKey: "decision-1",
      operationId: "operation-1",
      requestId: "request-1",
      status: "prepared",
      turnId: "turn-1",
      workspaceId: "ws-1"
    }
  } as const;
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestBody = await request.json();
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await client.submitWorkspaceAgentPlanDecision(
    "ws-1",
    "session-1",
    "turn-1",
    "request-1",
    {
      action: "implement",
      idempotencyKey: "decision-1",
      promptKind: "plan-implementation"
    }
  );

  assert.equal(requestMethod, "POST");
  assert.equal(
    requestPath,
    "/v1/workspaces/ws-1/agent-sessions/session-1/turns/turn-1/plan-decisions/request-1"
  );
  assert.deepEqual(requestBody, {
    action: "implement",
    idempotencyKey: "decision-1",
    promptKind: "plan-implementation"
  });
  assert.deepEqual(result, response);
});

test("shared tuttid client edits and recovers one workspace agent turn", async () => {
  const completed = {
    historyRevision: 8,
    operationId: "operation-1",
    replacementTurnId: "turn-2",
    retractedTurnId: "turn-1",
    state: "completed"
  } as const;
  const { client, requests } = captureClient(jsonResponse(completed));

  assert.deepEqual(
    await client.editRetry("ws-1", "session-1", "turn-1", {
      clientOperationId: "client-operation-1",
      editedText: "edited prompt",
      expectedHistoryRevision: 7
    }),
    completed
  );
  assert.deepEqual(
    await client.recoverEditRetry("ws-1", "session-1", "operation-1", {
      action: "reconcile"
    }),
    completed
  );

  assertRequest(requests[0]!, {
    authorization: null,
    body: {
      clientOperationId: "client-operation-1",
      editedText: "edited prompt",
      expectedHistoryRevision: 7
    },
    method: "POST",
    path: "/v1/workspaces/ws-1/agent-sessions/session-1/turns/turn-1/edit-retry",
    query: {}
  });
  assertRequest(requests[1]!, {
    authorization: null,
    body: { action: "reconcile" },
    method: "POST",
    path: "/v1/workspaces/ws-1/agent-sessions/session-1/edit-retry-operations/operation-1/recover",
    query: {}
  });
});

test("shared tuttid client submits workspace agent interactive responses", async () => {
  let requestBody: unknown = null;
  let requestMethod = "";
  let requestPath = "";

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();

      return new Response(
        JSON.stringify({
          session: {
            id: "agent-session-1",
            provider: "codex",
            cwd: "/repo",
            status: "waiting",
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const result = await client.submitWorkspaceAgentInteractive(
    "ws-1",
    "agent-session-1",
    "interactive-1",
    {
      optionId: "acceptEdits",
      turnId: "turn-1",
      payload: { path: "/Users/example/demo/src/styles.css" }
    }
  );

  assert.equal(requestMethod, "POST");
  assert.equal(
    requestPath,
    "/v1/workspaces/ws-1/agent-sessions/agent-session-1/interactives/interactive-1/response"
  );
  assert.deepEqual(requestBody, {
    optionId: "acceptEdits",
    turnId: "turn-1",
    payload: { path: "/Users/example/demo/src/styles.css" }
  });
  assert.equal(result.id, "agent-session-1");
});

test("shared tuttid client normalizes structured protocol errors", async () => {
  const client = createTuttidClient({
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "workspace_not_found",
            reason: "workspace_not_found",
            developerMessage: "missing workspace",
            params: {
              workspaceId: "ws-missing"
            }
          }
        }),
        {
          status: 404,
          headers: { "content-type": "application/json" }
        }
      )
  });

  await assert.rejects(
    () => client.getWorkspace("ws-missing"),
    (error: unknown) => {
      assert.ok(error instanceof TuttidProtocolError);
      assert.equal(getTuttidProtocolErrorCode(error), "workspace_not_found");
      assert.equal(error.statusCode, 404);
      assert.equal(error.reason, "workspace_not_found");
      assert.equal(error.developerMessage, "missing workspace");
      assert.equal(error.message, "missing workspace");
      assert.deepEqual(error.params, { workspaceId: "ws-missing" });
      return true;
    }
  );
});

test("normalizeTuttidError extracts structured error details", () => {
  const normalized = normalizeTuttidError({
    error: {
      code: "invalid_request",
      reason: "missing_workspace_id",
      developerMessage: "workspace id is required",
      params: { field: "workspaceId" }
    }
  });

  assert.ok(normalized instanceof TuttidProtocolError);
  assert.equal(normalized.code, "invalid_request");
  assert.equal(normalized.reason, "missing_workspace_id");
  assert.deepEqual(normalized.params, { field: "workspaceId" });
});

test("normalizeTuttidError recognizes issue manager protocol codes", () => {
  const normalized = normalizeTuttidError(
    {
      error: {
        code: "workspace_issue_resource_exists",
        reason: "workspace_issue_topic_not_empty",
        developerMessage: "issue topic is not empty"
      }
    },
    409
  );

  assert.ok(normalized instanceof TuttidProtocolError);
  assert.equal(normalized.code, "workspace_issue_resource_exists");
  assert.equal(normalized.reason, "workspace_issue_topic_not_empty");
  assert.equal(normalized.statusCode, 409);
});

test("normalizeTuttidError recognizes Agent quick prompt conflicts", () => {
  const normalized = normalizeTuttidError(
    {
      error: {
        code: "agent_quick_prompt_conflict",
        reason: "agent_quick_prompt_version_conflict",
        developerMessage: "quick prompt version is stale",
        params: { promptId: "prompt-1" }
      }
    },
    409
  );

  assert.ok(normalized instanceof TuttidProtocolError);
  assert.equal(normalized.code, "agent_quick_prompt_conflict");
  assert.equal(normalized.reason, "agent_quick_prompt_version_conflict");
  assert.equal(normalized.statusCode, 409);
  assert.deepEqual(normalized.params, { promptId: "prompt-1" });
});

test("getTuttidErrorI18nCandidates prefers reason-specific keys", () => {
  const candidates = getTuttidErrorI18nCandidates(
    new TuttidProtocolError({
      code: "workspace_not_found",
      reason: "workspace_not_found",
      statusCode: 404
    })
  );

  assert.deepEqual(candidates, [
    "errors.workspace_not_found.workspace_not_found",
    "errors.workspace_not_found.default",
    "errors.workspace_not_found"
  ]);
});

test("shared tuttid client preserves connector market read and install routes", async () => {
  const snapshot = {
    catalogState: "ready" as const,
    connectors: [],
    operations: [],
    revision: 7,
    sourceRevision: "sha256:catalog"
  };
  const mutation = {
    operation: {
      operationId: "operation-1",
      clientRequestId: "request-1",
      connectorKey: "notion",
      kind: "install" as const,
      state: "accepted" as const,
      attempt: 0,
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z"
    },
    revision: 8
  };
  const { client, requests } = captureClient((request) =>
    jsonResponse(
      request.method === "GET" ? snapshot : mutation,
      request.method === "GET" ? 200 : 202
    )
  );

  assert.deepEqual(await client.getConnectorMarket(), snapshot);
  assert.deepEqual(
    await client.installConnectorMarketConnector("notion", {
      clientRequestId: "request-1",
      expectedRevision: 7
    }),
    mutation
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/connector-market",
    query: {}
  });
  assertRequest(requests[1]!, {
    authorization: null,
    body: {
      clientRequestId: "request-1",
      expectedRevision: 7
    },
    method: "POST",
    path: "/v1/connector-market/connectors/notion:install",
    query: {}
  });
});

test("shared tuttid connector client cancels a pending authorization without a request body", async () => {
  const { client, requests } = captureClient(
    () => new Response(null, { status: 204 })
  );

  await client.cancelConnectorMarketAuthorization("supabase");

  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "POST",
    path: "/v1/connector-market/connectors/supabase/authorization:cancel",
    query: {}
  });
});

test("shared tuttid connector client preserves structured market errors", async () => {
  const details = {
    code: "connector_market_revision_conflict" as const,
    message: "connector market revision changed",
    retryable: true,
    revision: 12
  };
  const { client } = captureClient(jsonResponse(details, 409));

  await assert.rejects(
    client.installConnectorMarketConnector("notion", {
      clientRequestId: "request-1",
      expectedRevision: 11
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorMarketClientError);
      assert.equal(error.code, details.code);
      assert.equal(error.retryable, true);
      assert.equal(error.revision, 12);
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, details);
      return true;
    }
  );
});

test("shared tuttid connector client preserves category and cursor pagination", async () => {
  const categories = {
    categories: [
      {
        categoryId: "business-operations",
        kind: "category" as const,
        sortOrder: 60,
        itemCount: 1,
        displayNameZh: "商业与运营",
        displayNameEn: "Business & Operations"
      }
    ]
  };
  const page = {
    sectionId: "business-operations",
    items: [],
    nextPageToken: "next-page",
    revision: 8
  };
  const { client, requests } = captureClient((request) =>
    jsonResponse(request.path.endsWith("/categories") ? categories : page)
  );

  assert.deepEqual(await client.listConnectorMarketCategories(), categories);
  assert.deepEqual(
    await client.listConnectorMarketCatalog({
      installation: "not_installed",
      sectionId: "business-operations",
      pageSize: 20,
      pageToken: "cursor-1"
    }),
    page
  );
  assertRequest(requests[0]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/connector-market/categories",
    query: {}
  });
  assertRequest(requests[1]!, {
    authorization: null,
    body: null,
    method: "GET",
    path: "/v1/connector-market/catalog",
    query: {
      installation: "not_installed",
      pageSize: "20",
      pageToken: "cursor-1",
      sectionId: "business-operations"
    }
  });
});
