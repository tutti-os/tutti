import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZATION_DECLARATIVE_PROTOCOL_V1,
  AUTHORIZATION_EVENT_PROTOCOL_V1,
  AUTHORIZATION_VIEW_PROTOCOL_V1,
  parseAuthorizationViewV1,
  parseDeclarativeAuthorizationInteractionV1,
  resolveDeclarativeAuthorizationInitialViewV1
} from "./schema.ts";
import { validateAuthorizationEventForViewV1 } from "./validation.ts";

const figmaInteraction = {
  protocol: AUTHORIZATION_DECLARATIVE_PROTOCOL_V1,
  initialView: {
    defaultLocale: "en-US",
    locales: {
      "en-US": {
        type: "form",
        title: "Configure Figma",
        fields: [
          {
            type: "secret",
            name: "personal_access_token",
            label: "Personal access token",
            required: true
          }
        ]
      }
    }
  },
  submission: {
    kind: "native_secret",
    secretField: "personal_access_token"
  }
} as const;

test("parses a declarative native-secret interaction", () => {
  const result = parseDeclarativeAuthorizationInteractionV1(figmaInteraction);
  assert.equal(result.ok, true);
});

test("rejects a native-secret mapping to an undeclared field", () => {
  const result = parseDeclarativeAuthorizationInteractionV1({
    ...figmaInteraction,
    submission: {
      kind: "native_secret",
      secretField: "other_token"
    }
  });
  assert.deepEqual(result, {
    ok: false,
    error: { code: "invalid_declarative_interaction" }
  });
});

test("resolves an exact localized view and falls back to the default", () => {
  const parsed = parseDeclarativeAuthorizationInteractionV1({
    ...figmaInteraction,
    initialView: {
      ...figmaInteraction.initialView,
      locales: {
        ...figmaInteraction.initialView.locales,
        "zh-CN": {
          ...figmaInteraction.initialView.locales["en-US"],
          title: "配置 Figma"
        }
      }
    }
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(
    resolveDeclarativeAuthorizationInitialViewV1(parsed.value, "zh-CN").title,
    "配置 Figma"
  );
  assert.equal(
    resolveDeclarativeAuthorizationInitialViewV1(parsed.value, "fr-FR").title,
    "Configure Figma"
  );
});

test("rejects a missing default locale", () => {
  const result = parseDeclarativeAuthorizationInteractionV1({
    ...figmaInteraction,
    initialView: {
      ...figmaInteraction.initialView,
      defaultLocale: "fr-FR"
    }
  });
  assert.deepEqual(result, {
    ok: false,
    error: { code: "invalid_declarative_interaction" }
  });
});

test("rejects unknown view properties", () => {
  const result = parseAuthorizationViewV1({
    protocol: AUTHORIZATION_VIEW_PROTOCOL_V1,
    viewId: "figma-token-1",
    view: {
      ...figmaInteraction.initialView.locales["en-US"],
      headerName: "X-Figma-Token"
    }
  });
  assert.deepEqual(result, {
    ok: false,
    error: { code: "invalid_view" }
  });
});

test("validates a submit event against the current form without trimming secrets", () => {
  const view = {
    protocol: AUTHORIZATION_VIEW_PROTOCOL_V1,
    viewId: "figma-token-1",
    view: figmaInteraction.initialView.locales["en-US"]
  };
  const event = {
    protocol: AUTHORIZATION_EVENT_PROTOCOL_V1,
    viewId: "figma-token-1",
    event: {
      type: "submit",
      values: { personal_access_token: "  figd_secret  " }
    }
  };
  const result = validateAuthorizationEventForViewV1(view, event, {
    isCurrentLocalFileHandle: () => false
  });
  assert.equal(result.ok, true);
  if (result.ok && result.value.event.type === "submit") {
    assert.equal(
      result.value.event.values.personal_access_token,
      "  figd_secret  "
    );
  }
});

test("rejects stale and unknown-field events", () => {
  const view = {
    protocol: AUTHORIZATION_VIEW_PROTOCOL_V1,
    viewId: "figma-token-1",
    view: figmaInteraction.initialView.locales["en-US"]
  };
  const stale = validateAuthorizationEventForViewV1(
    view,
    {
      protocol: AUTHORIZATION_EVENT_PROTOCOL_V1,
      viewId: "figma-token-0",
      event: {
        type: "submit",
        values: { personal_access_token: "figd_secret" }
      }
    },
    { isCurrentLocalFileHandle: () => false }
  );
  assert.deepEqual(stale, { ok: false, error: { code: "stale_view" } });

  const unknownField = validateAuthorizationEventForViewV1(
    view,
    {
      protocol: AUTHORIZATION_EVENT_PROTOCOL_V1,
      viewId: "figma-token-1",
      event: {
        type: "submit",
        values: {
          personal_access_token: "figd_secret",
          header_name: "X-Figma-Token"
        }
      }
    },
    { isCurrentLocalFileHandle: () => false }
  );
  assert.deepEqual(unknownField, {
    ok: false,
    error: { code: "invalid_field", fieldName: "header_name" }
  });
});
