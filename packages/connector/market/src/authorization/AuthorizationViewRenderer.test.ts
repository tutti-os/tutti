import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DefaultAuthorizationViewRenderer } from "./AuthorizationViewRenderer.tsx";

const labels = {
  activate: "Continue",
  cancel: "Cancel",
  openExternal: "Open in browser",
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
        protocol: "tutti.connector.authorization.view.v2",
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
        protocol: "tutti.connector.authorization.view.v2",
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

test("renders an embedded page through the host slot", () => {
  const markup = renderToStaticMarkup(
    createElement(DefaultAuthorizationViewRenderer, {
      busy: true,
      embeddedPageRenderer: ({ url }) =>
        createElement("div", { "data-embedded-url": url }),
      labels,
      view: {
        protocol: "tutti.connector.authorization.view.v2",
        viewId: "embedded-1",
        view: {
          type: "embedded_page",
          flowId: "authorization-flow-1",
          url: "https://accounts.example.com/device"
        }
      },
      onEvent: () => undefined
    })
  );

  assert.match(
    markup,
    /data-embedded-url="https:\/\/accounts.example.com\/device"/
  );
  assert.match(markup, />Open in browser</);
});
