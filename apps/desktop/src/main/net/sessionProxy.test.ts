import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveShellProxyRules } from "./sessionProxy.ts";

test("resolveShellProxyRules prefers HTTPS proxy and carries NO_PROXY", () => {
  assert.deepEqual(
    resolveShellProxyRules({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:1080",
      NO_PROXY: "localhost,.internal"
    }),
    {
      proxyRules: "http://127.0.0.1:7890",
      proxyBypassRules: "localhost,.internal"
    }
  );
});

test("resolveShellProxyRules reads lowercase keys and defaults bypass", () => {
  assert.deepEqual(resolveShellProxyRules({ https_proxy: "http://p:1" }), {
    proxyRules: "http://p:1",
    proxyBypassRules: "<local>"
  });
});

test("resolveShellProxyRules returns null without proxy vars", () => {
  assert.equal(resolveShellProxyRules({}), null);
  assert.equal(resolveShellProxyRules({ HTTPS_PROXY: "   " }), null);
  assert.equal(resolveShellProxyRules({ NO_PROXY: "localhost" }), null);
});
