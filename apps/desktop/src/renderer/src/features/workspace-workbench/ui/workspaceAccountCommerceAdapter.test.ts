import assert from "node:assert/strict";
import test from "node:test";
import type { AccountProductSummaryResponse } from "@tutti-os/client-tuttid-ts";
import {
  projectWorkspaceAccountCommerce,
  projectWorkspaceAccountMenuComposition
} from "./workspaceAccountCommerceAdapter.ts";

const summary = {
  user: null,
  membership: null,
  membership_access: "unknown",
  credits: null,
  links: {
    plan_url: "https://example.test/plans",
    usage_url: "https://example.test/usage",
    settings_url: "https://example.test/settings"
  }
} satisfies AccountProductSummaryResponse;

test("workspace Account does not expose or refresh Commerce when the Tutti Agent gate is off", () => {
  assert.deepEqual(
    projectWorkspaceAccountCommerce({
      enabled: false,
      summary,
      loading: true,
      error: "failed"
    }),
    {
      summary: null,
      loading: false,
      dataUnavailable: false,
      commerceVisible: false,
      shouldRefresh: false
    }
  );
});

test("workspace Account projects a full Commerce failure as a sanitized state", () => {
  assert.deepEqual(
    projectWorkspaceAccountCommerce({
      enabled: true,
      summary: null,
      loading: false,
      error: "Commerce unavailable"
    }),
    {
      summary: null,
      loading: false,
      dataUnavailable: true,
      commerceVisible: true,
      shouldRefresh: true
    }
  );
});

test("workspace Account projects partial failure independently", () => {
  const projection = projectWorkspaceAccountCommerce({
    enabled: true,
    summary: {
      ...summary,
      partial_error: {
        scope: "credits",
        code: "credits_unavailable"
      }
    },
    loading: false,
    error: null
  });
  assert.equal(projection.dataUnavailable, true);
  assert.equal(projection.commerceVisible, true);
});

test("workspace Account never projects the raw Commerce error message", () => {
  const projection = projectWorkspaceAccountCommerce({
    enabled: true,
    summary: null,
    loading: false,
    error: "https://internal.example/secret upstream token"
  });
  assert.deepEqual(Object.values(projection), [null, false, true, true, true]);
  assert.equal(JSON.stringify(projection).includes("upstream token"), false);
});

test("workspace Account keeps settings and logout when Commerce is disabled", () => {
  assert.deepEqual(
    projectWorkspaceAccountMenuComposition({
      commerceEnabled: false,
      signedIn: true
    }),
    {
      showCommerce: false,
      showSettings: true,
      showLogout: true
    }
  );
});

test("workspace Account keeps signed-out state limited to login", () => {
  assert.deepEqual(
    projectWorkspaceAccountMenuComposition({
      commerceEnabled: true,
      signedIn: false
    }),
    {
      showCommerce: false,
      showSettings: false,
      showLogout: false
    }
  );
});
