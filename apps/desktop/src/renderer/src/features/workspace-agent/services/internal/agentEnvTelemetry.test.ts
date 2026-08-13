import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import {
  buildEnvDetectedParams,
  buildEnvIssueParams,
  envDetectedSignature
} from "./agentEnvTelemetry.ts";

function status(
  overrides: Partial<AgentProviderStatus> = {}
): AgentProviderStatus {
  return {
    provider: "codex",
    availability: { status: "ready", reasonCode: null, checkedAt: null },
    cli: {
      installed: true,
      binaryPath: "/Users/asdf/.local/bin/codex",
      version: "0.142.1"
    },
    adapter: {
      installed: true,
      binaryPath: "/opt/acp",
      command: ["node", "acp.js"]
    },
    auth: { status: "authenticated", accountLabel: "user@example.com" },
    actions: [],
    network: {
      registry: { reachable: true, endpoint: "https://registry.npmjs.org" },
      providerApi: { reachable: true, endpoint: "https://api.openai.com" },
      proxy: { configured: true, url: "127.0.0.1:7890", reachable: true }
    },
    ...overrides
  } as AgentProviderStatus;
}

test("env_detected params are privacy-safe (no paths, email, proxy address)", () => {
  const params = buildEnvDetectedParams(status());
  const serialized = JSON.stringify(params);
  assert.ok(!serialized.includes("/Users/asdf"), "must not leak file paths");
  assert.ok(!serialized.includes("user@example.com"), "must not leak email");
  assert.ok(!serialized.includes("127.0.0.1"), "must not leak proxy address");
  assert.equal(params.cliInstalled, true);
  assert.equal(params.authenticated, true);
  assert.equal(params.networkRegistryReachable, true);
  assert.equal(params.networkApiStatus, "reachable");
  assert.equal(params.networkProxyConfigured, true);
});

test("networkApiStatus reflects skipped (custom key) and unknown (no data)", () => {
  assert.equal(
    buildEnvDetectedParams(
      status({
        network: {
          registry: { reachable: true, endpoint: "" },
          providerApi: null
        } as AgentProviderStatus["network"]
      })
    ).networkApiStatus,
    "skipped"
  );
  assert.equal(
    buildEnvDetectedParams(
      status({ network: null } as Partial<AgentProviderStatus>)
    ).networkApiStatus,
    "unknown"
  );
});

test("signature changes when the detection outcome changes", () => {
  const a = envDetectedSignature(status());
  const b = envDetectedSignature(
    status({ auth: { status: "required", accountLabel: "" } })
  );
  assert.notEqual(a, b);
  assert.equal(a, envDetectedSignature(status()), "stable for identical input");
});

test("configured credentials are present but not remotely authenticated", () => {
  const configured = status({
    auth: { status: "configured", accountLabel: null }
  });

  assert.equal(buildEnvDetectedParams(configured).authenticated, false);
  assert.equal(buildEnvIssueParams(configured).accountPresent, true);
  assert.notEqual(
    envDetectedSignature(configured),
    envDetectedSignature(status())
  );
});

test("issue params add diagnostic detail under consent (paths, proxy) but not email", () => {
  const params = buildEnvIssueParams(status());
  assert.equal(params.consentGiven, true);
  assert.equal(params.cliPath, "/Users/asdf/.local/bin/codex");
  assert.equal(params.proxyUrl, "127.0.0.1:7890");
  assert.equal(params.apiEndpoint, "https://api.openai.com");
  assert.equal(params.accountPresent, true);
  assert.ok(
    !JSON.stringify(params).includes("user@example.com"),
    "even under consent, the account email is not sent"
  );
});
