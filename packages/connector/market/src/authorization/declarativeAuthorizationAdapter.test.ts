import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthorizationSubmitEvent,
  resolveAuthorizationInteraction,
  resolveDeclarativeAuthorizationSubmission
} from "./declarativeAuthorizationAdapter.ts";

const legacyLabels = {
  description: "Stored securely",
  fieldLabel: "Access token",
  placeholder: "Paste token"
};

test("creates a legacy secret form only when interaction is absent", () => {
  const resolved = resolveAuthorizationInteraction({
    authorizationKind: "api_key",
    interaction: undefined,
    legacyLabels,
    locale: "en-US"
  });
  assert.equal(resolved.kind, "form");
  if (resolved.kind === "form") {
    assert.equal(resolved.interaction.submission.secretField, "secret");
  }
});

test("does not synthesize a secret form for brokered API-key authorization", () => {
  const resolved = resolveAuthorizationInteraction({
    authorizationKind: "api_key",
    enableLegacySecretFallback: false,
    interaction: undefined,
    legacyLabels,
    locale: "en-US"
  });
  assert.deepEqual(resolved, { kind: "none" });
});

test("fails closed for an explicitly invalid interaction", () => {
  const resolved = resolveAuthorizationInteraction({
    authorizationKind: "api_key",
    interaction: { protocol: "unknown" },
    legacyLabels,
    locale: "en-US"
  });
  assert.deepEqual(resolved, { kind: "invalid" });
});

test("maps a declared field to the existing native-secret input", () => {
  const resolved = resolveAuthorizationInteraction({
    authorizationKind: "api_key",
    interaction: {
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
      submission: {
        kind: "native_secret",
        secretField: "personal_token"
      }
    },
    legacyLabels,
    locale: "en-US"
  });
  assert.equal(resolved.kind, "form");
  if (resolved.kind !== "form") return;

  const event = createAuthorizationSubmitEvent(resolved.view.viewId, {
    personal_token: " token-with-spaces "
  });
  assert.deepEqual(resolveDeclarativeAuthorizationSubmission(resolved, event), {
    ok: true,
    secret: " token-with-spaces "
  });
});

test("selects the localized presentation without changing submission binding", () => {
  const resolved = resolveAuthorizationInteraction({
    authorizationKind: "api_key",
    interaction: {
      protocol: "tutti.connector.authorization.declarative.v1",
      initialView: {
        defaultLocale: "en-US",
        locales: {
          "en-US": {
            type: "form",
            title: "Connect",
            fields: [
              {
                type: "secret",
                name: "personal_token",
                label: "Personal token",
                required: true
              }
            ]
          },
          "zh-CN": {
            type: "form",
            title: "连接",
            fields: [
              {
                type: "secret",
                name: "personal_token",
                label: "个人令牌",
                required: true
              }
            ]
          }
        }
      },
      submission: {
        kind: "native_secret",
        secretField: "personal_token"
      }
    },
    legacyLabels,
    locale: "zh-CN"
  });
  assert.equal(resolved.kind, "form");
  if (resolved.kind === "form") {
    assert.equal(resolved.view.view.title, "连接");
    assert.equal(resolved.interaction.submission.secretField, "personal_token");
  }
});
