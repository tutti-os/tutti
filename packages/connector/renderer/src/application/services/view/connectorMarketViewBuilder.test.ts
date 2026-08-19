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

test("keeps a failed catalog section visible without failing the whole view", () => {
  const market = createConnectorMarketStoreState();
  market.loadState = "ready";
  market.catalogSections = [
    {
      categoryId: "other",
      kind: "category",
      sortOrder: 40,
      itemCount: 1,
      connectorKeys: [],
      loadState: "error"
    }
  ];

  const view = buildConnectorMarketView(market, uiState);

  assert.equal(view.status, "ready");
  assert.equal(view.sections[0]?.id, "other");
  assert.equal(view.sections[0]?.error, true);
  assert.equal(view.catalogError, null);
});

test("projects server-owned category names into the renderer view", () => {
  const market = createConnectorMarketStoreState();
  market.loadState = "ready";
  market.catalogSections = [
    {
      categoryId: "business-operations",
      kind: "category",
      sortOrder: 60,
      itemCount: 1,
      displayNameZh: "商业与运营",
      displayNameEn: "Business & Operations",
      connectorKeys: [],
      loadState: "loading"
    }
  ];

  const view = buildConnectorMarketView(market, uiState);

  assert.equal(view.sections[0]?.id, "business-operations");
  assert.equal(view.sections[0]?.displayNameZh, "商业与运营");
  assert.equal(view.sections[0]?.displayNameEn, "Business & Operations");
});

test("keeps connector details open through installation and advances to authorization", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;
  const dialogState: ConnectorMarketUiState = {
    ...uiState,
    dialog: { connectorKey: connector.key, kind: "connector" }
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

  connector.authorization = { state: "disconnected" };
  market.connectorsByKey[connector.key] = connector;
  market.pendingAuthorizationsByConnectorKey[connector.key] = true;
  const pendingSession = buildConnectorMarketView(market, dialogState).dialog;
  assert.equal(
    pendingSession?.kind === "authorization" && pendingSession.pending,
    true
  );
  market.authorizationViewsByConnectorKey[connector.key] = {
    protocol: "tutti.connector.authorization.view.v1",
    viewId: "wecom-authorization-1",
    view: {
      type: "qr_code",
      source: {
        type: "payload",
        value: "https://work.weixin.qq.com/ai/qc/c?s=opaque"
      }
    }
  };
  const qrDialog = buildConnectorMarketView(market, dialogState).dialog;
  assert.equal(
    qrDialog?.kind === "authorization" &&
      qrDialog.authorizationView?.view.type === "qr_code"
      ? qrDialog.authorizationView.view.source.value
      : undefined,
    "https://work.weixin.qq.com/ai/qc/c?s=opaque"
  );
});

test("preserves the connector authorization interaction for the dialog", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  const interaction = {
    protocol: "tutti.connector.authorization.declarative.v1",
    initialView: {
      defaultLocale: "en-US",
      locales: {
        "en-US": {
          type: "form",
          fields: [
            {
              type: "secret",
              name: "personal_token",
              label: "Personal token",
              required: true
            }
          ]
        }
      }
    },
    submission: { kind: "native_secret", secretField: "personal_token" }
  };
  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    state: "installed"
  };
  connector.release.manifest.authorizationKind = "api_key";
  connector.release.manifest.authorizationInteraction = interaction;
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;

  const dialog = buildConnectorMarketView(market, {
    ...uiState,
    dialog: { connectorKey: connector.key, kind: "connector" }
  }).dialog;

  assert.equal(dialog?.kind, "authorization");
  assert.deepEqual(
    dialog?.kind === "authorization"
      ? dialog.authorizationInteraction
      : undefined,
    interaction
  );
});

test("marks managed credential brokers for managed authorization handling", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    state: "installed"
  };
  connector.release.manifest.authorizationKind = "api_key";
  connector.release.manifest.authorizationInteractionMode = "managed";
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;

  const dialog = buildConnectorMarketView(market, {
    ...uiState,
    dialog: { connectorKey: connector.key, kind: "connector" }
  }).dialog;

  assert.equal(
    dialog?.kind === "authorization" && dialog.brokeredAuthorization,
    true
  );
});

test("keeps a physical repair in the available segment until installation completes", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    installedReleaseId: connector.release.releaseId,
    installedVersion: connector.release.version,
    state: "installing"
  };
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;
  market.catalogSections = [
    {
      categoryId: "productivity",
      connectorKeys: [connector.key],
      itemCount: 1,
      kind: "category",
      loadState: "ready",
      sortOrder: 10
    }
  ];
  market.operationsByConnectorKey[connector.key] = {
    attempt: 1,
    clientRequestId: "repair-github",
    connectorKey: connector.key,
    createdAt: "2026-08-11T00:00:00Z",
    kind: "install",
    operationId: "repair-operation",
    stage: "installing",
    state: "running",
    updatedAt: "2026-08-11T00:00:01Z"
  };

  const installingView = buildConnectorMarketView(market, uiState);
  assert.equal(installingView.installedCount, 0);
  assert.equal(installingView.availableCount, 1);
  assert.deepEqual(installingView.sections[0]?.connectorKeys, [connector.key]);
  assert.equal(installingView.cardsByKey[connector.key]?.status, "installing");

  connector.installation.state = "installed";
  market.operationsByConnectorKey[connector.key] = {
    ...market.operationsByConnectorKey[connector.key]!,
    stage: "completed",
    state: "completed",
    updatedAt: "2026-08-11T00:00:02Z"
  };
  const installedView = buildConnectorMarketView(market, {
    ...uiState,
    segment: "installed"
  });
  assert.equal(installedView.installedCount, 1);
  assert.deepEqual(installedView.sections[0]?.connectorKeys, [connector.key]);
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
    dialog: { connectorKey: connector.key, kind: "connector" },
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

  market.pendingInstallationsByConnectorKey[connector.key] = true;
  const pendingUpdate = buildConnectorMarketView(market, dialogState);
  assert.equal(pendingUpdate.cardsByKey[connector.key]?.action, "busy");
  assert.equal(pendingUpdate.cardsByKey[connector.key]?.status, "updating");

  delete market.pendingInstallationsByConnectorKey[connector.key];
  connector.installation.state = "updating";
  const updating = buildConnectorMarketView(market, dialogState);
  assert.equal(updating.cardsByKey[connector.key]?.action, "busy");
  assert.equal(updating.cardsByKey[connector.key]?.status, "updating");
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
  assert.equal(view.cardsByKey[connector.key]?.canUninstall, true);
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

test("projects an uninstall confirmation independently from authorization state", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    state: "installed"
  };
  connector.authorization = { state: "disconnected" };
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;

  const dialog = buildConnectorMarketView(market, {
    ...uiState,
    dialog: {
      connectorKey: connector.key,
      kind: "uninstall_confirmation"
    },
    segment: "installed"
  }).dialog;

  assert.equal(dialog?.kind, "uninstall_confirmation");
  assert.equal(dialog?.displayName, "GitHub");
});

test("disables uninstall controls while one connector mutation is active", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    installedReleaseDigest: connector.release.releaseDigest,
    state: "updating"
  };
  connector.authorization = { state: "connected" };
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;
  market.operationsByConnectorKey[connector.key] = {
    attempt: 1,
    clientRequestId: "update-github",
    connectorKey: connector.key,
    createdAt: "2026-08-11T00:00:00Z",
    kind: "install",
    operationId: "update-operation",
    stage: "installing",
    state: "running",
    updatedAt: "2026-08-11T00:00:01Z"
  };

  const view = buildConnectorMarketView(market, {
    ...uiState,
    dialog: {
      connectorKey: connector.key,
      kind: "uninstall_confirmation"
    },
    segment: "installed"
  });

  assert.equal(view.cardsByKey[connector.key]?.canUninstall, false);
  assert.equal(view.dialog, null);

  connector.installation.state = "installed";
  const management = buildConnectorMarketView(market, {
    ...uiState,
    dialog: { connectorKey: connector.key, kind: "connector" },
    segment: "installed"
  }).dialog;
  assert.equal(management?.kind, "management");
  assert.equal(
    management?.kind === "management" && management.canUninstall,
    false
  );
});

test("offers repair when calibration finds the installed implementation absent", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    failureCode: "connector_installation_absent",
    installedReleaseDigest: connector.release.releaseDigest,
    installedReleaseId: connector.release.releaseId,
    installedVersion: connector.release.version,
    state: "failed"
  };
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;

  const view = buildConnectorMarketView(market, {
    ...uiState,
    dialog: { connectorKey: connector.key, kind: "connector" },
    segment: "installed"
  });

  assert.equal(view.cardsByKey[connector.key]?.action, "install");
  assert.equal(view.cardsByKey[connector.key]?.canUninstall, true);
  assert.equal(view.cardsByKey[connector.key]?.status, "not_installed");
  assert.equal(view.dialog?.kind, "installation");
  assert.equal(
    view.dialog?.kind === "installation" && view.dialog.updating,
    false
  );
});

test("offers repair when the installed implementation is invalid", () => {
  const market = createConnectorMarketStoreState();
  const connector = connectorFixture();
  connector.installation = {
    failureCode: "connector_installation_invalid",
    installedReleaseDigest: connector.release.releaseDigest,
    installedReleaseId: connector.release.releaseId,
    installedVersion: connector.release.version,
    state: "failed"
  };
  market.connectorKeys = [connector.key];
  market.connectorsByKey[connector.key] = connector;

  const view = buildConnectorMarketView(market, {
    ...uiState,
    dialog: { connectorKey: connector.key, kind: "connector" },
    segment: "installed"
  });

  assert.equal(view.cardsByKey[connector.key]?.action, "install");
  assert.equal(view.cardsByKey[connector.key]?.status, "not_installed");
  assert.equal(view.dialog?.kind, "installation");
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
        iconUrl:
          "https://cdn.example.test/tutti/connector-market/github/1.0.0/github-1.0.0-icon.svg",
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
