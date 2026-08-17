import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DefaultAuthorizationViewRenderer } from "./AuthorizationViewRenderer.tsx";

const labels = {
  activate: "Continue",
  cancel: "Cancel",
  qrCodeAlt: "Authorization QR code",
  refresh: "Refresh",
  retry: "Retry",
  submit: "Authorize",
  unsupportedField: "Unsupported"
};

test("renders a QR payload locally without exposing it as text", () => {
  const payload = "https://example.com/authorize?opaque=secret-value";
  const markup = renderToStaticMarkup(
    createElement(DefaultAuthorizationViewRenderer, {
      busy: false,
      labels,
      view: {
        protocol: "tutti.connector.authorization.view.v1",
        viewId: "qr-1",
        view: {
          type: "qr_code",
          source: { type: "payload", value: payload },
          refreshable: true
        }
      },
      onEvent: () => undefined
    })
  );

  assert.match(markup, /data:image\/gif;base64,/);
  assert.match(markup, /Authorization QR code/);
  assert.match(markup, />Refresh</);
  assert.doesNotMatch(markup, /secret-value/);
});

test("renders an activation action for external-link views", () => {
  const markup = renderToStaticMarkup(
    createElement(DefaultAuthorizationViewRenderer, {
      busy: false,
      labels,
      view: {
        protocol: "tutti.connector.authorization.view.v1",
        viewId: "external-1",
        view: {
          type: "external_link",
          title: "Continue in browser",
          url: "https://example.com/authorize"
        }
      },
      onEvent: () => undefined
    })
  );

  assert.match(markup, /Continue in browser/);
  assert.match(markup, />Continue</);
  assert.doesNotMatch(markup, /https:\/\/example.com/);
});
