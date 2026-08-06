import assert from "node:assert/strict";
import test from "node:test";

import type { Connector } from "../../contracts/index.ts";
import { createConnectorMarketStoreState } from "../connectorMarketState.ts";
import type { ConnectorMarketUiState } from "../ui-state/connectorMarketUiStateService.interface.ts";
import { buildConnectorMarketView } from "./connectorMarketViewBuilder.ts";

const uiState: ConnectorMarketUiState = {
  dialog: null,
  query: "",
  scope: {},
  segment: "available",
  started: true
};

test("maps manifest failures to a non-technical catalog error", () => {
  const market = createConnectorMarketStoreState();
  market.loadState = "error";
  market.lastError = {
    code: "connector_manifest_invalid",
    message: "permission must be a lowercase stable identifier",
    retryable: false
  };

  const view = buildConnectorMarketView(market, uiState);

  assert.deepEqual(view.catalogError, {
    kind: "invalid_data",
    retryable: false
  });
  assert.equal("lastErrorCode" in view, false);
});

test("maps retryable upstream failures to an unavailable catalog error", () => {
  const market = createConnectorMarketStoreState();
  market.loadState = "error";
  market.lastError = {
    code: "connector_market_upstream_unavailable",
    message: "catalog request failed",
    retryable: true
  };

  const view = buildConnectorMarketView(market, uiState);

  assert.deepEqual(view.catalogError, {
    kind: "unavailable",
    retryable: true
  });
});

test("keeps connector details open through installation and advances to authorization", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;
  const dialogState: ConnectorMarketUiState = {
    ...uiState,
    dialog: { connectorKey: connector.key }
  };

  const beforeInstall = buildConnectorMarketView(market, dialogState).dialog;
  assert.equal(beforeInstall?.kind, "installation");
  assert.equal(
    beforeInstall?.description,
    "Manage repositories and pull requests"
  );

  connector.installation = { state: "installing" };
  market.connectorsByKey[connector.key] = connector;
  const installing = buildConnectorMarketView(market, dialogState).dialog;
  assert.equal(installing?.kind, "installation");
  assert.equal(
    installing?.kind === "installation" && installing.installing,
    true
  );

  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    state: "installed"
  };
  market.connectorsByKey[connector.key] = connector;
  const installed = buildConnectorMarketView(market, dialogState).dialog;
  assert.equal(installed?.kind, "authorization");
});

function connectorFixture(): Connector {
  return {
    authorization: { state: "disconnected" },
    compatibility: { state: "supported" },
    installation: { state: "not_installed" },
    key: "github",
    release: {
      artifact: {
        key: "connectors/github.tgz",
        mediaType: "application/vnd.tutti.connector+tar+gzip",
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 1
      },
      connectorKey: "github",
      manifest: {
        authorizationKind: "oauth2",
        description: "Manage repositories and pull requests",
        displayName: "GitHub",
        iconUrl: "data:image/png;base64,iVBORw0KGgo=",
        implementation: {
          builtin: { cli: true, mcp: true, providerId: "github" },
          kind: "builtin"
        },
        permissions: ["repositories"],
        schemaVersion: "1"
      },
      manifestDigest:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      publishedAt: "2026-08-04T00:00:00Z",
      releaseDigest:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      releaseId: "github@1.0.0",
      schemaVersion: "1",
      status: "available",
      version: "1.0.0"
    },
    revision: 1
  };
}
