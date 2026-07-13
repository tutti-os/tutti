import assert from "node:assert/strict";
import test from "node:test";
import { createRestartAwareFetch } from "./createRestartAwareFetch.ts";

test("restart-aware fetch preserves JSON and binary request details while replacing auth", async () => {
  const requests: Request[] = [];
  const abortController = new AbortController();
  const jsonRequest = new Request("http://tuttid.local/v1/json?include=all", {
    body: JSON.stringify({ hello: "world" }),
    headers: {
      Authorization: "Bearer stale-token",
      "Content-Type": "application/json",
      "X-Request-ID": "json-request"
    },
    method: "POST",
    signal: abortController.signal
  });
  const binaryRequest = new Request("http://tuttid.local/v1/binary", {
    body: new Uint8Array([0, 1, 2, 255]),
    headers: {
      Authorization: "Bearer stale-token",
      "Content-Type": "application/octet-stream",
      "X-Request-ID": "binary-request"
    },
    method: "PUT"
  });
  const restartAwareFetch = createRestartAwareFetch(
    {
      getBackendConfig: async () => ({
        accessToken: "current-token",
        baseUrl: "http://127.0.0.1:18080"
      })
    },
    async (input, init) => {
      requests.push(
        input instanceof Request ? input : new Request(input, init)
      );
      return new Response(null, { status: 204 });
    }
  );

  await restartAwareFetch(jsonRequest);
  await restartAwareFetch(binaryRequest);

  assert.equal(requests[0]?.url, "http://127.0.0.1:18080/v1/json?include=all");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer current-token"
  );
  assert.equal(requests[0]?.headers.get("content-type"), "application/json");
  assert.equal(requests[0]?.headers.get("x-request-id"), "json-request");
  assert.notEqual(requests[0]?.body, jsonRequest.body);
  assert.deepEqual(await requests[0]?.json(), { hello: "world" });
  abortController.abort();
  assert.equal(requests[0]?.signal.aborted, true);

  assert.equal(requests[1]?.url, "http://127.0.0.1:18080/v1/binary");
  assert.equal(requests[1]?.method, "PUT");
  assert.equal(
    requests[1]?.headers.get("authorization"),
    "Bearer current-token"
  );
  assert.equal(
    requests[1]?.headers.get("content-type"),
    "application/octet-stream"
  );
  assert.equal(requests[1]?.headers.get("x-request-id"), "binary-request");
  assert.notEqual(requests[1]?.body, binaryRequest.body);
  assert.deepEqual(
    [
      ...new Uint8Array(
        (await requests[1]?.arrayBuffer()) ?? new ArrayBuffer(0)
      )
    ],
    [0, 1, 2, 255]
  );
});

test("restart-aware fetch propagates config failures without using stale config", async () => {
  const configError = new Error("backend config unavailable");
  let configCallCount = 0;
  let fetchCallCount = 0;
  const restartAwareFetch = createRestartAwareFetch(
    {
      getBackendConfig: async () => {
        configCallCount += 1;
        if (configCallCount === 1) {
          return {
            accessToken: "first-token",
            baseUrl: "http://127.0.0.1:18080"
          };
        }
        throw configError;
      }
    },
    async () => {
      fetchCallCount += 1;
      return new Response(null, { status: 204 });
    }
  );

  await restartAwareFetch("http://tuttid.local/v1/health");
  await assert.rejects(
    restartAwareFetch("http://tuttid.local/v1/health"),
    (error) => error === configError
  );

  assert.equal(fetchCallCount, 1);
});

test("restart-aware fetch propagates native fetch failures unchanged", async () => {
  const fetchError = new TypeError("network failed");
  const restartAwareFetch = createRestartAwareFetch(
    {
      getBackendConfig: async () => ({
        accessToken: "current-token",
        baseUrl: "http://127.0.0.1:18080"
      })
    },
    async () => {
      throw fetchError;
    }
  );

  await assert.rejects(
    restartAwareFetch("http://tuttid.local/v1/health"),
    (error) => error === fetchError
  );
});
