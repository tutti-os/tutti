import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addTuttiDesktopClientToConnectorAuthorizationUrl } from "./connectorAuthorizationClientUrl.ts";

describe("addTuttiDesktopClientToConnectorAuthorizationUrl", () => {
  it("marks the server-owned authorization bridge URL", () => {
    assert.equal(
      addTuttiDesktopClientToConnectorAuthorizationUrl(
        "https://tutti.sh/connector-authorization/start/nonce?existing=value#step",
        true
      ),
      "https://tutti.sh/connector-authorization/start/nonce?existing=value&desktop_client=tutti&openAppUrl=tutti-dev%3A%2F%2Fopen#step"
    );
    assert.equal(
      addTuttiDesktopClientToConnectorAuthorizationUrl(
        "https://tutti.sh/connector-authorization/start/nonce",
        false
      ),
      "https://tutti.sh/connector-authorization/start/nonce?desktop_client=tutti&openAppUrl=tutti%3A%2F%2Fopen"
    );
  });

  it("does not modify provider or invalid URLs", () => {
    assert.equal(
      addTuttiDesktopClientToConnectorAuthorizationUrl(
        "https://accounts.google.com/o/oauth2/auth",
        true
      ),
      "https://accounts.google.com/o/oauth2/auth"
    );
    assert.equal(
      addTuttiDesktopClientToConnectorAuthorizationUrl("not-a-url", true),
      "not-a-url"
    );
  });
});
