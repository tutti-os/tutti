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
  assert.equal(
    beforeInstall?.kind === "installation" && beforeInstall.installing,
    false
  );

  market.pendingInstallationsByConnectorKey[connector.key] = true;
  const pendingInstall = buildConnectorMarketView(market, dialogState);
  assert.equal(pendingInstall.cardsByKey[connector.key]?.action, "busy");
  assert.equal(pendingInstall.cardsByKey[connector.key]?.status, "installing");
  assert.equal(
    pendingInstall.dialog?.kind === "installation" &&
      pendingInstall.dialog.installing,
    true
  );
  delete market.pendingInstallationsByConnectorKey[connector.key];

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
  assert.equal(
    installed?.kind === "authorization" && installed.authorizing,
    false
  );

  market.authorizingConnectorKeys[connector.key] = true;
  connector.authorization = { state: "pending" };
  market.connectorsByKey[connector.key] = connector;
  const authorizing = buildConnectorMarketView(market, dialogState).dialog;
  assert.equal(
    authorizing?.kind === "authorization" && authorizing.authorizing,
    true
  );
  assert.equal(
    authorizing?.kind === "authorization" && authorizing.pending,
    true
  );
});

test("requires an installed connector to update before authorization when the active release changes", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    installedReleaseDigest:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    installedReleaseId: "github@0.9.0",
    installedVersion: "0.9.0",
    state: "installed"
  };
  connector.authorization = { state: "failed" };
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;
  const dialogState: ConnectorMarketUiState = {
    ...uiState,
    dialog: { connectorKey: connector.key },
    segment: "installed"
  };

  const view = buildConnectorMarketView(market, dialogState);

  assert.equal(view.cardsByKey[connector.key]?.action, "update");
  assert.equal(view.cardsByKey[connector.key]?.status, "update_available");
  assert.deepEqual(view.sections[0]?.connectorKeys, [connector.key]);
  assert.equal(view.dialog?.kind, "installation");
  assert.equal(
    view.dialog?.kind === "installation" && view.dialog.updating,
    true
  );
});

test("exposes disconnect directly for an authorized connector", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    state: "installed"
  };
  connector.authorization = { state: "connected" };
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;
  market.operationsByConnectorKey[connector.key] = {
    attempt: 1,
    clientRequestId: "authorize",
    connectorKey: connector.key,
    createdAt: "2026-08-06T00:00:00Z",
    kind: "start_authorization",
    operationId: "authorize-operation",
    stage: "completed",
    state: "completed",
    updatedAt: "2026-08-06T00:00:01Z"
  };

  const view = buildConnectorMarketView(market, {
    ...uiState,
    segment: "installed"
  });

  assert.equal(view.cardsByKey[connector.key]?.action, "disconnect");
  assert.equal(view.cardsByKey[connector.key]?.status, "connected");
  assert.equal(view.cardsByKey[connector.key]?.operationStage, "completed");
});

test("keeps authorization-free connectors on the management action", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    state: "installed"
  };
  connector.authorization = { state: "not_required" };
  connector.release.manifest.authorizationKind = "none";
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;

  const view = buildConnectorMarketView(market, {
    ...uiState,
    segment: "installed"
  });

  assert.equal(view.cardsByKey[connector.key]?.action, "manage");
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
