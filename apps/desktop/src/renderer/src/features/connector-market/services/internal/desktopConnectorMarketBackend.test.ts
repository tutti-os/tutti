import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConnectorMarketClient,
  ConnectorMarketSnapshot
} from "@tutti-os/client-tuttid-ts";
import { ConnectorMarketClientError } from "@tutti-os/client-tuttid-ts";
import { createDesktopConnectorMarketBackend } from "./desktopConnectorMarketBackend.ts";

test("desktop connector market backend delegates snapshot reads to the daemon client", async () => {
  const calls: Array<string | undefined> = [];
  const snapshot: ConnectorMarketSnapshot = {
    catalogState: "ready",
    connectors: [],
    operations: [],
    revision: 7,
    sourceRevision: "sha256:catalog"
  };
  const client = {
    async getConnectorMarket(workspaceId?: string) {
      calls.push(workspaceId);
      return snapshot;
    }
  } as ConnectorMarketClient;

  const backend = createDesktopConnectorMarketBackend(client);

  assert.equal(
    await backend.getSnapshot({ workspaceId: "workspace-1" }),
    snapshot
  );
  assert.deepEqual(calls, ["workspace-1"]);
});

test("desktop connector market backend preserves mutation idempotency fields", async () => {
  const calls: unknown[] = [];
  const client = {
    async installConnectorMarketConnector(
      connectorKey: string,
      request: { clientRequestId: string; expectedRevision: number }
    ) {
      calls.push({ connectorKey, request });
      return {
        operation: {
          operationId: "operation-1",
          clientRequestId: request.clientRequestId,
          connectorKey,
          kind: "install" as const,
          state: "accepted" as const,
          attempt: 0,
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z"
        },
        revision: 9
      };
    }
  } as ConnectorMarketClient;

  const backend = createDesktopConnectorMarketBackend(client);
  await backend.installConnector({
    connectorKey: "notion",
    workspaceId: "workspace-1",
    clientRequestId: "request-1",
    expectedRevision: 8
  });

  assert.deepEqual(calls, [
    {
      connectorKey: "notion",
      request: {
        workspaceId: "workspace-1",
        clientRequestId: "request-1",
        expectedRevision: 8
      }
    }
  ]);
});

test("desktop connector market backend preserves structured daemon errors", async () => {
  const structuredError = new ConnectorMarketClientError(
    {
      code: "connector_market_revision_conflict",
      message: "connector market revision changed",
      retryable: true,
      revision: 12
    },
    409
  );
  const client = {
    async getConnectorMarket() {
      throw structuredError;
    }
  } as unknown as ConnectorMarketClient;
  const backend = createDesktopConnectorMarketBackend(client);

  await assert.rejects(backend.getSnapshot({}), (error: unknown) => {
    assert.equal(error, structuredError);
    assert.equal(
      (error as ConnectorMarketClientError).code,
      structuredError.code
    );
    assert.equal(
      (error as ConnectorMarketClientError).retryable,
      structuredError.retryable
    );
    assert.deepEqual(
      (error as ConnectorMarketClientError).details,
      structuredError.details
    );
    return true;
  });
});
