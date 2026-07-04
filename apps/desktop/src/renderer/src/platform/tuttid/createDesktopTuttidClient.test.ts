import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRuntimeApi } from "@preload/types";
import { createDesktopTuttidClient } from "./createDesktopTuttidClient.ts";

test("createDesktopTuttidClient forwards workspace agent session query params", async () => {
  let requestMethod = "";
  let requestPath = "";
  let requestQueryEntries: Record<string, string> = {};
  const capturedRequest: { signal: AbortSignal | null } = { signal: null };
  const abortController = new AbortController();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requestMethod = request.method;
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
        headers: {
          "content-type": "application/json"
        },
        status: 200
      }
    );
  };

  try {
    const client = createDesktopTuttidClient({
      getBackendConfig: async () => ({
        accessToken: "test-token",
        baseUrl: "http://127.0.0.1:18080"
      })
    } as DesktopRuntimeApi);

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
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestMethod, "GET");
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
