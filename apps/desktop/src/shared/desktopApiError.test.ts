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

test("reads structured params and retryable accessors only once", () => {
  let paramsReads = 0;
  let retryableReads = 0;
  const error = {
    code: "COMMON.UNAVAILABLE",
    message: "offline",
    get params() {
      paramsReads += 1;
      return paramsReads === 1 ? { authorityId: "device-1" } : [];
    },
    get retryable() {
      retryableReads += 1;
      return retryableReads === 1 ? true : "yes";
    }
  };

  assert.deepEqual(normalizeDesktopApiErrorDetails(error), {
    code: "COMMON.UNAVAILABLE",
    message: "offline",
    params: { authorityId: "device-1" },
    retryable: true
  });
  assert.equal(paramsReads, 1);
  assert.equal(retryableReads, 1);
});

test("omits throwing optional metadata without losing structured details", () => {
  const error = {
    code: "COMMON.UNAVAILABLE",
    message: "offline",
    params: { authorityId: "device-1" },
    get reason() {
      throw new Error("reason unavailable");
    },
    retryable: true
  };

  assert.deepEqual(normalizeDesktopApiErrorDetails(error), {
    code: "COMMON.UNAVAILABLE",
    message: "offline",
    params: { authorityId: "device-1" },
    retryable: true
  });
});

test("uses the caller-localized unknown error fallback", () => {
  assert.deepEqual(
    normalizeDesktopApiErrorDetails(
      {
        get message() {
          throw new Error("message unavailable");
        }
      },
      "未知错误"
    ),
    { code: "UNKNOWN", message: "未知错误" }
  );
});

test("omits hostile params without downgrading required error details", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(
    normalizeDesktopApiErrorDetails({
      code: "COMMON.UNAVAILABLE",
      message: "offline",
      params: revoked.proxy,
      retryable: true
    }),
    {
      code: "COMMON.UNAVAILABLE",
      message: "offline",
      retryable: true
    }
  );
});

test("reuses one required message snapshot for UNKNOWN fallback", () => {
  let reads = 0;
  const error = {
    get message() {
      reads += 1;
      return reads === 1 ? "first message" : "second message";
    }
  };
  assert.deepEqual(normalizeDesktopApiErrorDetails(error), {
    code: "UNKNOWN",
    message: "first message"
  });
  assert.equal(reads, 1);
});
