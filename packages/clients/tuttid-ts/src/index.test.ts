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
  type ListWorkspacesResponse,
  type WorkspaceFilePreviewResponse,
  type WorkspaceGitPatchSupportResponse,
  type WorkspaceGitPatchResponse
} from "./index.ts";

test("create workspace agent session request supports target-only authority", () => {
  const request = {
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    agentTargetId: "local:codex",
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
                type: "local_cli",
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
          type: "local_cli",
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
      initialContent: [{ type: "text", text: "hello" }],
      planMode: true,
      provider: "codex"
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
    initialContent: [{ type: "text", text: "hello" }],
    planMode: true,
    provider: "codex"
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
          capabilityCatalog: []
        } satisfies AgentProviderComposerOptionsResponse),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });

  const result = await client.getWorkspaceAppFactoryProviderComposerOptions(
    "workspace-1",
    "claude-code",
    {
      settings: {
        reasoningEffort: "high"
      }
    }
  );

  assert.equal(requestMethod, "POST");
  assert.equal(
    requestPath,
    "/v1/workspaces/workspace-1/app-factory/providers/claude-code/composer-options"
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

test("shared tuttid client keeps cancel session compatibility", async () => {
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
          cancel: {
            canceled: false,
            reason: "no_active_turn"
          },
          session: {
            id: "agent-session-1",
            provider: "codex",
            cwd: "/repo",
            status: "ready",
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

  const result = await client.cancelWorkspaceAgentSession(
    "ws-1",
    "agent-session-1"
  );

  assert.equal(requestMethod, "POST");
  assert.equal(
    requestPath,
    "/v1/workspaces/ws-1/agent-sessions/agent-session-1/cancel"
  );
  assert.equal(result.id, "agent-session-1");
  assert.equal(result.status, "ready");
});

test("shared tuttid client exposes cancel session result metadata", async () => {
  const client = createTuttidClient({
    fetch: async () =>
      new Response(
        JSON.stringify({
          cancel: {
            canceled: false,
            reason: "no_active_turn"
          },
          session: {
            id: "agent-session-1",
            provider: "codex",
            cwd: "/repo",
            status: "ready",
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
  });

  const result = await client.cancelWorkspaceAgentSessionWithResult(
    "ws-1",
    "agent-session-1"
  );

  assert.equal(result.session.id, "agent-session-1");
  assert.deepEqual(result.cancel, {
    canceled: false,
    reason: "no_active_turn"
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
