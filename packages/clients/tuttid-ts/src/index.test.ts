import assert from "node:assert/strict";
import test from "node:test";
import {
  createTuttidClient,
  createClient,
  getTuttidErrorI18nCandidates,
  getTuttidProtocolErrorCode,
  getHealth,
  listWorkspaces,
  TuttidProtocolError,
  normalizeTuttidError,
  workspaceProtocolErrorCodes,
  type ApiErrorResponse,
  type AgentProviderComposerOptionsResponse,
  type AppReferenceListResponse,
  type CliCapabilitiesResponse,
  type CreateWorkspaceAgentSessionRequest,
  type IssueManagerReferenceSearchResponse,
  type ListAgentTargetsResponse,
  type ListAutomationRulesResponse,
  type ListWorkspacesResponse,
  type PutAutomationRuleRequest,
  type WorkspaceFilePreviewResponse,
  type WorkspaceGitPatchSupportResponse,
  type WorkspaceGitPatchResponse
} from "./index.ts";

test("create workspace agent session request supports target-only authority", () => {
  const request = {
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    initialContent: [{ type: "text", text: "hello" }]
  } satisfies CreateWorkspaceAgentSessionRequest;

  assert.equal(request.agentTargetId, "local:codex");
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

test("generated tuttid client returns typed workspace lists", async () => {
  const client = createClient({
    baseUrl: "http://localhost:4545/",
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

  const response = await listWorkspaces({ client });
  assert.deepEqual(response.data, {
    totalCount: 1,
    workspaces: [{ id: "ws-1", name: "One", lastOpenedAt: null }]
  } satisfies ListWorkspacesResponse);
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

test("shared tuttid client unwraps agent target responses", async () => {
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      assert.equal(new URL(request.url).pathname, "/v1/agent-targets");

      return new Response(
        JSON.stringify({
          targets: [
            {
              id: "local:codex",
              provider: "codex",
              launchRef: {
                type: "builtin_local",
                provider: "codex"
              },
              name: "Codex",
              iconKey: "codex",
              enabled: true,
              source: "system",
              sortOrder: 10,
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1
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

  assert.deepEqual(await client.listAgentTargets(), {
    targets: [
      {
        id: "local:codex",
        provider: "codex",
        launchRef: {
          type: "builtin_local",
          provider: "codex"
        },
        name: "Codex",
        iconKey: "codex",
        enabled: true,
        source: "system",
        sortOrder: 10,
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1
      }
    ]
  } satisfies ListAgentTargetsResponse);
});

test("shared tuttid client unwraps workspace Agent directory responses", async () => {
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      assert.equal(
        new URL(request.url).pathname,
        "/v1/workspaces/workspace-1/agents"
      );
      return Response.json({
        agents: [
          {
            agentTargetId: "workspace-agent:reviewer",
            createdAt: "2026-07-12T00:00:00Z",
            enabled: true,
            harness: {
              agentTargetId: "local:codex",
              available: true,
              enabled: true,
              name: "Codex",
              provider: "codex"
            },
            id: "workspace-agent:reviewer",
            instructions: "Review carefully",
            name: "Reviewer",
            permissions: ["workspace.read"],
            purpose: "Review changes",
            revision: 1,
            skills: ["react"],
            source: "user",
            tools: ["terminal"],
            updatedAt: "2026-07-12T00:00:00Z",
            workspaceId: "workspace-1"
          }
        ]
      });
    }
  });

  const response = await client.listWorkspaceAgents("workspace-1");

  assert.equal(response.agents[0]?.id, "workspace-agent:reviewer");
  assert.equal(response.agents[0]?.harness.agentTargetId, "local:codex");
});

test("shared tuttid client unwraps workspace automation rule responses", async () => {
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      assert.equal(
        new URL(request.url).pathname,
        "/v1/workspaces/workspace-1/automation-rules"
      );
      return Response.json({
        rules: [
          {
            budget: {
              maxRunsPerSession: 2,
              maxTotalTokensPerSession: 40000
            },
            createdAt: "2026-07-12T00:00:00Z",
            enabled: true,
            id: "automation-rule:one",
            name: "Review completion",
            permissions: { allowedTools: [] },
            prompt: "Check correctness",
            target: {
              kind: "agent",
              requiredCapabilities: [],
              workspaceAgentId: "workspace-agent:reviewer"
            },
            trigger: "on_task_complete",
            updatedAt: "2026-07-12T00:00:00Z",
            workspaceId: "workspace-1"
          }
        ]
      });
    }
  });

  const response = await client.listAutomationRules("workspace-1");
  assert.equal(response.rules[0]?.id, "automation-rule:one");
  assert.equal(response.rules[0]?.target.kind, "agent");
  assert.equal(response.rules[0]?.budget.maxRunsPerSession, 2);
  assert.deepEqual(response, response satisfies ListAutomationRulesResponse);
});

test("shared tuttid client mutates automation rules and session overrides", async () => {
  const automationRuleID = "automation-rule:one";
  const request = {
    budget: {
      maxRunsPerSession: 1,
      maxTotalTokensPerSession: 50000
    },
    enabled: false,
    name: "Delegate follow-up",
    permissions: {
      allowedTools: ["terminal"],
      permissionModeId: "workspace-write"
    },
    prompt: "Handle the bounded follow-up.",
    sourceWorkspaceAgentId: "workspace-agent:source",
    target: {
      kind: "agent",
      requiredCapabilities: [],
      workspaceAgentId: "workspace-agent:target"
    },
    trigger: "on_task_complete"
  } satisfies PutAutomationRuleRequest;
  const seen: Array<{ body: unknown; method: string; pathname: string }> = [];
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const httpRequest =
        input instanceof Request ? input : new Request(input, init);
      const pathname = new URL(httpRequest.url).pathname;
      const body =
        httpRequest.method === "GET" || httpRequest.method === "DELETE"
          ? null
          : await httpRequest.json();
      seen.push({ body, method: httpRequest.method, pathname });

      if (pathname.endsWith("/automation-rule-override")) {
        return Response.json({
          agentSessionId: "session-1",
          disabled:
            httpRequest.method === "PUT" &&
            (body as { disabled: boolean }).disabled,
          ruleIds:
            httpRequest.method === "PUT"
              ? (body as { ruleIds: string[] }).ruleIds
              : [],
          updatedAt: "2026-07-12T00:00:00Z",
          workspaceId: "workspace-1"
        });
      }
      if (httpRequest.method === "DELETE") {
        return Response.json({ automationRuleId: automationRuleID });
      }
      return Response.json({
        ...request,
        createdAt: "2026-07-12T00:00:00Z",
        id: automationRuleID,
        updatedAt: "2026-07-12T00:00:00Z",
        workspaceId: "workspace-1"
      });
    }
  });

  const created = await client.createAutomationRule("workspace-1", request);
  const updated = await client.updateAutomationRule(
    "workspace-1",
    automationRuleID,
    request
  );
  const deleted = await client.deleteAutomationRule(
    "workspace-1",
    automationRuleID
  );
  const defaultOverride = await client.getAgentSessionAutomationRuleOverride(
    "workspace-1",
    "session-1"
  );
  const savedOverride = await client.setAgentSessionAutomationRuleOverride(
    "workspace-1",
    "session-1",
    { disabled: true, ruleIds: [automationRuleID] }
  );

  assert.equal(created.id, automationRuleID);
  assert.equal(updated.target.workspaceAgentId, "workspace-agent:target");
  assert.equal(deleted.automationRuleId, automationRuleID);
  assert.equal(defaultOverride.disabled, false);
  assert.deepEqual(savedOverride.ruleIds, [automationRuleID]);
  assert.deepEqual(
    seen.map(({ method, pathname }) => ({ method, pathname })),
    [
      {
        method: "POST",
        pathname: "/v1/workspaces/workspace-1/automation-rules"
      },
      {
        method: "PUT",
        pathname:
          "/v1/workspaces/workspace-1/automation-rules/automation-rule%3Aone"
      },
      {
        method: "DELETE",
        pathname:
          "/v1/workspaces/workspace-1/automation-rules/automation-rule%3Aone"
      },
      {
        method: "GET",
        pathname:
          "/v1/workspaces/workspace-1/agent-sessions/session-1/automation-rule-override"
      },
      {
        method: "PUT",
        pathname:
          "/v1/workspaces/workspace-1/agent-sessions/session-1/automation-rule-override"
      }
    ]
  );
});

test("shared tuttid client creates, updates, and deletes workspace Agents", async () => {
  const methods: string[] = [];
  const request = {
    callConditions: ["Before release"],
    defaultModel: "gpt-5",
    enabled: true,
    harnessAgentTargetId: "local:codex",
    instructions: "Review carefully",
    modelPlanId: "plan-1",
    name: "Reviewer",
    permissions: ["workspace.read"],
    purpose: "Review changes",
    skills: ["react"],
    tools: ["terminal"]
  };
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const httpRequest =
        input instanceof Request ? input : new Request(input, init);
      methods.push(httpRequest.method);
      const pathname = new URL(httpRequest.url).pathname;
      if (httpRequest.method === "DELETE") {
        assert.equal(
          pathname,
          "/v1/workspaces/workspace-1/agents/workspace-agent%3Areviewer"
        );
        return Response.json({
          workspaceAgentId: "workspace-agent:reviewer"
        });
      }
      assert.equal(
        pathname,
        httpRequest.method === "POST"
          ? "/v1/workspaces/workspace-1/agents"
          : "/v1/workspaces/workspace-1/agents/workspace-agent%3Areviewer"
      );
      assert.deepEqual(await httpRequest.json(), request);
      return Response.json({
        agentTargetId: "workspace-agent:reviewer",
        callConditions: request.callConditions,
        createdAt: "2026-07-12T00:00:00Z",
        defaultModel: request.defaultModel,
        enabled: request.enabled,
        harness: {
          agentTargetId: request.harnessAgentTargetId,
          available: true,
          enabled: true,
          name: "Codex",
          provider: "codex"
        },
        id: "workspace-agent:reviewer",
        instructions: request.instructions,
        modelPlanId: request.modelPlanId,
        name: request.name,
        permissions: request.permissions,
        purpose: request.purpose,
        revision: httpRequest.method === "POST" ? 1 : 2,
        skills: request.skills,
        source: "user",
        tools: request.tools,
        updatedAt: "2026-07-12T00:00:00Z",
        workspaceId: "workspace-1"
      });
    }
  });

  const created = await client.createWorkspaceAgent("workspace-1", request);
  const updated = await client.updateWorkspaceAgent(
    "workspace-1",
    created.id,
    request
  );
  const deleted = await client.deleteWorkspaceAgent("workspace-1", created.id);

  assert.equal(updated.revision, 2);
  assert.equal(deleted.workspaceAgentId, created.id);
  assert.deepEqual(methods, ["POST", "PUT", "DELETE"]);
});

test("shared tuttid client generates a reviewable workspace Agent draft", async () => {
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      assert.equal(
        new URL(request.url).pathname,
        "/v1/workspaces/workspace-1/agents/generate-draft"
      );
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), {
        harnessAgentTargetId: "local:codex",
        modelPlanId: "plan-1",
        model: "gpt-5",
        requirements: "Review releases"
      });
      return Response.json({
        automationRules: [
          {
            action: "consult",
            maxRunsPerSession: 1,
            maxTotalTokensPerSession: 50000,
            model: "gpt-5",
            modelPlanId: "plan-1",
            name: "Completion review",
            prompt: "Return VERDICT: PASS or VERDICT: FAIL.",
            trigger: "on_task_complete"
          }
        ],
        callConditions: ["Before release"],
        instructions: "Review evidence.",
        name: "Release Reviewer",
        purpose: "Review release readiness",
        skills: ["code-review"],
        usage: { inputTokens: 20, outputTokens: 10 },
        usedModel: "gpt-5",
        usedModelPlanId: "plan-1"
      });
    }
  });

  const generated = await client.generateWorkspaceAgentDraft("workspace-1", {
    harnessAgentTargetId: "local:codex",
    modelPlanId: "plan-1",
    model: "gpt-5",
    requirements: "Review releases"
  });

  assert.equal(generated.name, "Release Reviewer");
  assert.equal(generated.automationRules[0]?.action, "consult");
});

test("shared tuttid client updates system agent target visibility", async () => {
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      assert.equal(
        new URL(request.url).pathname,
        "/v1/agent-targets/local%3Atutti-agent/enabled"
      );
      assert.equal(request.method, "PATCH");
      assert.deepEqual(await request.json(), { enabled: false });
      return Response.json({
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
      });
    }
  });

  const target = await client.setSystemAgentTargetEnabled(
    "local:tutti-agent",
    false
  );

  assert.equal(target.id, "local:tutti-agent");
  assert.equal(target.enabled, false);
});

test("shared tuttid client cancels one exact workspace agent turn", async () => {
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      assert.equal(request.method, "POST");
      assert.equal(
        new URL(request.url).pathname,
        "/v1/workspaces/ws-1/agent-sessions/session-1/turns/turn-1/cancel"
      );
      return Response.json({
        cancel: { canceled: true, reason: "turn_canceled" }
      });
    }
  });

  assert.deepEqual(
    await client.cancelWorkspaceAgentTurn("ws-1", "session-1", "turn-1"),
    { cancel: { canceled: true, reason: "turn_canceled" } }
  );
});

test("shared tuttid client forwards bearer auth tokens", async () => {
  let authorizationHeader = "";

  const client = createTuttidClient({
    auth: "desktop-session-token",
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizationHeader = request.headers.get("authorization") ?? "";

      return new Response(
        JSON.stringify({
          service: "tuttid",
          status: "ok"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  await client.getHealth();
  assert.equal(authorizationHeader, "Bearer desktop-session-token");
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
    { signal: abortController.signal }
  );

  assert.equal(authorizationHeader, "Bearer desktop-session-token");
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

test("shared tuttid client estimates an Issue auto token budget without persisting", async () => {
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
          tokenLimit: 1032000,
          deterministicTokenLimit: 64000,
          historicalTokenEstimate: 10000000,
          matchedTaskCount: 1
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const result = await client.estimateWorkspaceIssueAutoTokenBudget?.("ws-1", {
    executionProfile: {
      reasoningIntensity: 50,
      orchestrationIntensity: 50
    },
    tasks: [
      { agentTargetId: "local:codex", modelPlanId: "plan-1", model: "model-1" }
    ]
  });

  assert.equal(requestMethod, "POST");
  assert.equal(
    requestPath,
    "/v1/workspaces/ws-1/issues/auto-token-budget-estimate"
  );
  assert.deepEqual(requestBody, {
    executionProfile: {
      reasoningIntensity: 50,
      orchestrationIntensity: 50
    },
    tasks: [
      { agentTargetId: "local:codex", modelPlanId: "plan-1", model: "model-1" }
    ]
  });
  assert.equal(result?.tokenLimit, 1032000);
});

test("shared tuttid client deletes user projects with bearer auth", async () => {
  let authorizationHeader = "";
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;

  const client = createTuttidClient({
    auth: "desktop-session-token",
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizationHeader = request.headers.get("authorization") ?? "";
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();

      return new Response(null, { status: 204 });
    }
  });

  await client.deleteUserProject({ path: "/workspace/app" });

  assert.equal(authorizationHeader, "Bearer desktop-session-token");
  assert.equal(requestMethod, "DELETE");
  assert.equal(requestPath, "/v1/user-projects");
  assert.deepEqual(requestBody, { path: "/workspace/app" });
});

test("shared tuttid client tracks analytics events with bearer auth", async () => {
  let authorizationHeader = "";
  let requestMethod = "";
  let requestPath = "";
  let requestBody: unknown;

  const events = [
    {
      name: "workspace.opened",
      client_ts: 1749124800000,
      params: { source: "dashboard" }
    }
  ];

  const client = createTuttidClient({
    auth: "desktop-session-token",
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizationHeader = request.headers.get("authorization") ?? "";
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;
      requestBody = await request.json();

      return new Response(null, { status: 202 });
    }
  });

  await client.trackEvents(events);

  assert.equal(authorizationHeader, "Bearer desktop-session-token");
  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/track");
  assert.deepEqual(requestBody, { events });
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
          capabilityCatalog: []
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
    capabilityCatalog: []
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
          capabilityCatalog: []
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

test("shared tuttid client probes agent providers", async () => {
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
          checkedAt: "2026-06-02T08:00:00.000Z",
          command: ["/usr/local/bin/codex"],
          provider: "codex",
          status: "ready"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const result = await client.probeAgentProvider("codex");

  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/agent-providers/codex/probe");
  assert.deepEqual(result, {
    checkedAt: "2026-06-02T08:00:00.000Z",
    command: ["/usr/local/bin/codex"],
    provider: "codex",
    status: "ready"
  });
});

test("shared tuttid client runs agent provider actions", async () => {
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
          actionID: "install",
          completedAt: "2026-06-02T08:00:00.000Z",
          provider: "codex",
          status: "completed"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const result = await client.runAgentProviderAction("codex", "install");

  assert.equal(requestMethod, "POST");
  assert.equal(requestPath, "/v1/agent-providers/codex/actions/install/run");
  assert.deepEqual(result, {
    actionID: "install",
    completedAt: "2026-06-02T08:00:00.000Z",
    provider: "codex",
    status: "completed"
  });
});

test("shared tuttid client lists recoverable workspace workflows by session", async () => {
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      assert.equal(request.method, "GET");
      assert.equal(url.pathname, "/v1/workspaces/workspace-1/workflows");
      assert.equal(url.searchParams.get("sourceSessionId"), "session-1");
      assert.equal(url.searchParams.get("checkpointStatus"), "pending");
      return new Response(JSON.stringify({ workflows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(
    await client.listPendingWorkspaceWorkflows("workspace-1", "session-1"),
    []
  );
});

test("shared tuttid client reads and revision-updates Tutti mode activation", async () => {
  const activation = {
    agentSessionId: "session-1",
    createdAtUnixMs: 10,
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 20,
      revision: 2,
      source: "badge_remove" as const,
      status: "inactive" as const
    },
    id: "activation-1",
    status: "inactive" as const,
    updatedAtUnixMs: 20,
    workspaceId: "workspace-1"
  };
  const requests: Request[] = [];
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request.clone());
      return new Response(
        JSON.stringify(
          request.method === "GET"
            ? { activation: null }
            : { activation, changed: true }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  assert.equal(
    await client.getWorkspaceAgentSessionTuttiModeActivation(
      "workspace-1",
      "session-1"
    ),
    null
  );
  assert.deepEqual(
    await client.updateWorkspaceAgentSessionTuttiModeActivation(
      "workspace-1",
      "session-1",
      {
        expectedRevision: 1,
        source: "badge_remove",
        status: "inactive"
      }
    ),
    { activation, changed: true }
  );
  assert.deepEqual(
    requests.map((request) => ({
      method: request.method,
      path: new URL(request.url).pathname
    })),
    [
      {
        method: "GET",
        path: "/v1/workspaces/workspace-1/agent-sessions/session-1/tutti-mode-activation"
      },
      {
        method: "PUT",
        path: "/v1/workspaces/workspace-1/agent-sessions/session-1/tutti-mode-activation"
      }
    ]
  );
  assert.deepEqual(await requests[1]?.json(), {
    expectedRevision: 1,
    source: "badge_remove",
    status: "inactive"
  });
});

test("shared tuttid client submits a user checkpoint decision", async () => {
  const snapshot = { workflow: { id: "workflow-1" } };
  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      assert.equal(request.method, "POST");
      assert.equal(
        new URL(request.url).pathname,
        "/v1/workspaces/workspace-1/workflows/workflow-1/checkpoints/checkpoint-1/decision"
      );
      assert.deepEqual(await request.json(), {
        decision: "rejected",
        decidedBy: "user-1",
        reason: "Split the verification step"
      });
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await client.decideWorkspaceWorkflowCheckpoint(
    "workspace-1",
    "workflow-1",
    "checkpoint-1",
    {
      decision: "rejected",
      decidedBy: "user-1",
      reason: "Split the verification step"
    }
  );

  assert.equal(result.workflow.id, "workflow-1");
});

test("shared tuttid client deletes workspace agent sessions", async () => {
  let requestMethod = "";
  let requestPath = "";

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;

      return new Response(JSON.stringify({ removed: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await client.deleteWorkspaceAgentSession(
    "ws-1",
    "agent-session-1"
  );

  assert.equal(requestMethod, "DELETE");
  assert.equal(
    requestPath,
    "/v1/workspaces/ws-1/agent-sessions/agent-session-1"
  );
  assert.deepEqual(result, { removed: true });
});

test("shared tuttid client clears workspace agent sessions", async () => {
  let requestMethod = "";
  let requestPath = "";

  const client = createTuttidClient({
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestMethod = request.method;
      requestPath = new URL(request.url).pathname;

      return new Response(
        JSON.stringify({ removedMessages: 5, removedSessions: 2 }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const result = await client.clearWorkspaceAgentSessions("ws-1");

  assert.equal(requestMethod, "DELETE");
  assert.equal(requestPath, "/v1/workspaces/ws-1/agent-sessions");
  assert.deepEqual(result, { removedMessages: 5, removedSessions: 2 });
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

test("workspaceProtocolErrorCodes exports issue manager protocol codes", () => {
  assert.equal(
    workspaceProtocolErrorCodes.workspaceIssueResourceExists,
    "workspace_issue_resource_exists"
  );
  assert.equal(
    workspaceProtocolErrorCodes.workspaceIssueResourceNotFound,
    "workspace_issue_resource_not_found"
  );
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
