import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeFeature } from "../core/feature.ts";
import {
  formatBrowserNodeErrorMessage,
  formatBrowserNodeErrorStatus,
  resolveBrowserNodeLoadErrorView
} from "./browserNodeError.ts";

const feature = {
  i18n: {
    t(
      key: string,
      params?: Record<string, string | number | boolean | null | undefined>
    ) {
      if (key === "errors.navigationFailedWithStatus") {
        return `The page could not be loaded. HTTP ${String(params?.statusCode)}.`;
      }
      if (key === "errors.navigationFailed") {
        return "The page could not be loaded.";
      }
      if (key === "errors.statusCode") {
        return `HTTP ${String(params?.statusCode)}`;
      }
      if (key === "errors.errorCode") {
        return `Error ${String(params?.errorCode)}`;
      }
      return key;
    }
  }
} as Pick<BrowserNodeFeature, "i18n">;

test("formats HTTP navigation failures with the status code", () => {
  const error = {
    code: "navigation-failed" as const,
    params: { statusCode: 502 }
  };

  assert.equal(
    formatBrowserNodeErrorMessage(feature, error),
    "The page could not be loaded. HTTP 502."
  );
  assert.equal(formatBrowserNodeErrorStatus(feature, error), "HTTP 502");
});

test("formats Chromium navigation failures with the error code", () => {
  const error = {
    code: "navigation-failed" as const,
    params: { errorCode: -105 }
  };

  assert.equal(
    formatBrowserNodeErrorMessage(feature, error),
    "The page could not be loaded."
  );
  assert.equal(formatBrowserNodeErrorStatus(feature, error), "Error -105");
});

test("keeps the built-in overlay when the host omits renderError", () => {
  assert.equal(
    resolveBrowserNodeLoadErrorView({
      customContent: undefined,
      hasError: true
    }),
    "default"
  );
  assert.equal(
    resolveBrowserNodeLoadErrorView({
      customContent: null,
      hasError: true
    }),
    "default"
  );
});

test("uses a host overlay only when renderError returns content", () => {
  assert.equal(
    resolveBrowserNodeLoadErrorView({
      customContent: "sandbox unavailable",
      hasError: true
    }),
    "custom"
  );
  assert.equal(
    resolveBrowserNodeLoadErrorView({
      customContent: "sandbox unavailable",
      hasError: false
    }),
    "none"
  );
});
