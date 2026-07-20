import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserNodeAutomationServer } from "./automationServer.ts";
import type { BrowserNodeAutomationRegistry } from "./automationTypes.ts";

test("automation server publishes a private authenticated loopback endpoint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-node-server-"));
  const listenerInfoPath = join(directory, "listener.json");
  let callCount = 0;
  const registry: BrowserNodeAutomationRegistry = {
    async call(input) {
      callCount += 1;
      return { text: `${input.workspaceId}:${input.tool}` };
    },
    list: () => [],
    register() {},
    releaseAgent() {},
    unregister() {},
    update() {}
  };
  const server = await createBrowserNodeAutomationServer({
    listenerInfoPath,
    registry
  });
  t.after(() => server.dispose());

  const published = JSON.parse(await readFile(listenerInfoPath, "utf8")) as {
    address: string;
    token: string;
  };
  assert.equal((await stat(listenerInfoPath)).mode & 0o777, 0o600);
  assert.match(published.address, /^127\.0\.0\.1:\d+$/u);

  const unauthorized = await fetch(`http://${published.address}/v1/call`, {
    body: JSON.stringify({
      tool: "list_pages",
      workspaceId: "workspace-1"
    }),
    method: "POST"
  });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`http://${published.address}/v1/call`, {
    body: JSON.stringify({
      tool: "list_pages",
      workspaceId: "workspace-1"
    }),
    headers: { authorization: `Bearer ${published.token}` },
    method: "POST"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    result: { text: "workspace-1:list_pages" }
  });
  assert.equal(callCount, 1);
});
