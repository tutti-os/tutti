import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopApiError,
  normalizeDesktopApiErrorDetails
} from "./desktopApiError.ts";

test("preserves structured desktop API error metadata", () => {
  const details = normalizeDesktopApiErrorDetails(
    Object.assign(new Error("offline"), {
      code: "COMMON.UNAVAILABLE",
      correlationId: "corr-1",
      developerMessage: "relay offline",
      params: { authorityId: "device-1" },
      reason: "owner_offline",
      retryable: true
    })
  );
  assert.deepEqual(details, {
    code: "COMMON.UNAVAILABLE",
    correlationId: "corr-1",
    developerMessage: "relay offline",
    message: "offline",
    params: { authorityId: "device-1" },
    reason: "owner_offline",
    retryable: true
  });
  const error = new DesktopApiError(details);
  assert.equal(error.code, "COMMON.UNAVAILABLE");
  assert.equal(error.correlationId, "corr-1");
  assert.equal(error.retryable, true);
});

test("falls back to UNKNOWN without accepting malformed metadata", () => {
  assert.deepEqual(
    normalizeDesktopApiErrorDetails({
      code: 42,
      correlationId: 42,
      message: "failed",
      params: [],
      retryable: "yes"
    }),
    { code: "UNKNOWN", message: "failed" }
  );
});

test("always returns a string message for hostile or mutated errors", () => {
  const mutated = new Error("original");
  Object.defineProperty(mutated, "message", {
    configurable: true,
    value: { invalid: true }
  });
  assert.deepEqual(normalizeDesktopApiErrorDetails(mutated), {
    code: "UNKNOWN",
    message: "Unknown desktop API error."
  });

  const hostile = {
    [Symbol.toPrimitive]() {
      throw new Error("cannot stringify");
    }
  };
  assert.deepEqual(normalizeDesktopApiErrorDetails(hostile), {
    code: "UNKNOWN",
    message: "Unknown desktop API error."
  });

  const throwingMessage = new Error("original");
  Object.defineProperty(throwingMessage, "message", {
    configurable: true,
    get() {
      throw new Error("cannot read message");
    }
  });
  assert.deepEqual(normalizeDesktopApiErrorDetails(throwingMessage), {
    code: "UNKNOWN",
    message: "Unknown desktop API error."
  });

  const throwingProxy = new Proxy(
    {},
    {
      get() {
        throw new Error("cannot read property");
      }
    }
  );
  assert.deepEqual(normalizeDesktopApiErrorDetails(throwingProxy), {
    code: "UNKNOWN",
    message: "Unknown desktop API error."
  });
});
