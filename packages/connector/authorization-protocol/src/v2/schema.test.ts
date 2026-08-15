import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZATION_EVENT_PROTOCOL_V2,
  AUTHORIZATION_VIEW_PROTOCOL_V2,
  parseAuthorizationViewV2
} from "./schema.ts";
import { validateAuthorizationEventForViewV2 } from "./validation.ts";

const embeddedPage = {
  protocol: AUTHORIZATION_VIEW_PROTOCOL_V2,
  viewId: "authorization-page-1",
  view: {
    type: "embedded_page",
    flowId: "authorization-flow-1",
    url: "https://accounts.example.com/device"
  }
} as const;

test("parses a bounded HTTPS embedded authorization page", () => {
  assert.equal(parseAuthorizationViewV2(embeddedPage).ok, true);
});

test("rejects embedded authorization pages with credentials or insecure URLs", () => {
  for (const url of [
    "http://accounts.example.com/device",
    "https://user:secret@accounts.example.com/device"
  ]) {
    assert.equal(
      parseAuthorizationViewV2({
        ...embeddedPage,
        view: { ...embeddedPage.view, url }
      }).ok,
      false
    );
  }
});

test("accepts activate and cancel events for an embedded page", () => {
  for (const type of ["activate", "cancel"] as const) {
    const result = validateAuthorizationEventForViewV2(
      embeddedPage,
      {
        protocol: AUTHORIZATION_EVENT_PROTOCOL_V2,
        viewId: embeddedPage.viewId,
        event: { type }
      },
      { isCurrentLocalFileHandle: () => false }
    );
    assert.equal(result.ok, true);
  }
});

test("rejects stale embedded-page events", () => {
  const result = validateAuthorizationEventForViewV2(
    embeddedPage,
    {
      protocol: AUTHORIZATION_EVENT_PROTOCOL_V2,
      viewId: "authorization-page-0",
      event: { type: "activate" }
    },
    { isCurrentLocalFileHandle: () => false }
  );
  assert.deepEqual(result, { ok: false, error: { code: "stale_view" } });
});
