import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRuntimeApi } from "@preload/types";
import { createDesktopTuttidClient } from "./createDesktopTuttidClient.ts";

test("createDesktopTuttidClient uses the latest daemon origin and token for every request", async () => {
  const requests: Request[] = [];
  const originalFetch = globalThis.fetch;
  const configs = [
    {
      accessToken: "first-token",
      baseUrl: "http://127.0.0.1:18080"
    },
    {
      accessToken: "second-token",
      baseUrl: "http://127.0.0.1:19090"
    }
  ];
  let configIndex = 0;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return Response.json({ service: "tuttid", status: "ok" });
  };

  try {
    const client = createDesktopTuttidClient({
      getBackendConfig: async () => configs[configIndex++]!
    } as DesktopRuntimeApi);

    await client.getHealth();
    await client.getHealth();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map((request) => ({
      authorization: request.headers.get("authorization"),
      origin: new URL(request.url).origin,
      pathname: new URL(request.url).pathname
    })),
    [
      {
        authorization: "Bearer first-token",
        origin: "http://127.0.0.1:18080",
        pathname: "/v1/health"
      },
      {
        authorization: "Bearer second-token",
        origin: "http://127.0.0.1:19090",
        pathname: "/v1/health"
      }
    ]
  );
});

test("createDesktopTuttidClient preserves query params and abort propagation", async () => {
  const requests: Request[] = [];
  const abortController = new AbortController();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    requests.push(input instanceof Request ? input : new Request(input, init));
    return Response.json({
      hasMore: false,
      sessions: [],
      workspaceId: "ws-1"
    });
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

  const request = requests[0];
  assert.ok(request);
  assert.equal(request.method, "GET");
  assert.deepEqual(Object.fromEntries(new URL(request.url).searchParams), {
    agentTargetId: "claude-target",
    cursor: "1000|session-1",
    limit: "30",
    sectionKey: "project:/workspace/project"
  });
  abortController.abort();
  assert.equal(request.signal.aborted, true);
});
