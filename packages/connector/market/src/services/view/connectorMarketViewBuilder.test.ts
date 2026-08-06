import assert from "node:assert/strict";
import test from "node:test";

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
