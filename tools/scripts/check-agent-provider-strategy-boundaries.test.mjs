import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderIdentityPatterns,
  findProviderIdentityViolations,
  isExemptPath
} from "./check-agent-provider-strategy-boundaries.mjs";

const providerIds = [
  "claude-code",
  "codex",
  "cursor",
  "hermes",
  "nexight",
  "openclaw",
  "opencode",
  "tutti-agent"
];

test("detects every registered provider through constants and literal branches", () => {
  for (const providerId of providerIds) {
    const stem = providerId
      .split("-")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("");
    const source = [
      `if provider == providerregistry.${stem}ProviderID {}`,
      `if p != "${providerId}" {}`,
      "switch kind {",
      "if nested {",
      `case "${providerId}":`,
      "return true",
      "}",
      "}"
    ].join("\n");
    assert.equal(
      findProviderIdentityViolations(
        "services/tuttid/service/example.go",
        source,
        providerIds
      ).length,
      3,
      providerId
    );
  }
});

test("detects legacy provider identity constant forms", () => {
  const source = [
    "return agentprovider.ClaudeCode",
    "return agentproviderbiz.Nexight",
    "return ProviderOpenClaw",
    "return HermesProviderID"
  ].join("\n");
  assert.equal(
    findProviderIdentityViolations(
      "services/tuttid/service/example.go",
      source,
      providerIds
    ).length,
    4
  );
});

test("detects provider literal branches in desktop TypeScript", () => {
  const source = [
    'if (p === "codex") { return true; }',
    "switch (kind) {",
    'case "opencode":',
    "return false;",
    "}"
  ].join("\n");
  assert.equal(
    findProviderIdentityViolations(
      "apps/desktop/src/renderer/providerPolicy.ts",
      source,
      providerIds
    ).length,
    2
  );
});

test("detects provider identity dispatched through Set membership", () => {
  const source = [
    "const runtimeProbeFallbackProviders = new Set<Provider>([",
    '  "cursor"',
    "]);",
    "return runtimeProbeFallbackProviders.has(provider);"
  ].join("\n");
  assert.deepEqual(
    findProviderIdentityViolations(
      "apps/desktop/src/renderer/providerPolicy.ts",
      source,
      providerIds
    ),
    ['apps/desktop/src/renderer/providerPolicy.ts:2: "cursor"']
  );
});

test("detects provider identity dispatched through array membership", () => {
  const source = [
    'const providersWithFallback = ["codex", "opencode"] as const;',
    "return providersWithFallback.includes(provider);"
  ].join("\n");
  assert.equal(
    findProviderIdentityViolations(
      "apps/desktop/src/renderer/providerPolicy.ts",
      source,
      providerIds
    ).length,
    2
  );
});

test("allows provider identity catalogs that do not dispatch through membership", () => {
  const source = [
    'const providerLabels = ["codex", "opencode"] as const;',
    "return providerLabels.map(renderProviderLabel);"
  ].join("\n");
  assert.deepEqual(
    findProviderIdentityViolations(
      "apps/desktop/src/renderer/providerLabels.ts",
      source,
      providerIds
    ),
    []
  );
});

test("allows provider enum validation without treating it as behavior dispatch", () => {
  const source = [
    'const desktopAgentProviders = ["codex", "opencode"] as const;',
    "return desktopAgentProviders.includes(provider);"
  ].join("\n");
  assert.deepEqual(
    findProviderIdentityViolations(
      "apps/desktop/src/shared/preferences/core.ts",
      source,
      providerIds
    ),
    []
  );
});

test("skips desktop TypeScript tests but scans adjacent production files", () => {
  const source = 'if (p === "codex") {}';
  assert.deepEqual(
    findProviderIdentityViolations(
      "apps/desktop/src/renderer/providerPolicy.test.ts",
      source,
      providerIds
    ),
    []
  );
  assert.equal(
    findProviderIdentityViolations(
      "apps/desktop/src/renderer/providerPolicy.ts",
      source,
      providerIds
    ).length,
    1
  );
});

test("does not treat descriptor lookup or unrelated literals as identity branches", () => {
  const source = [
    "descriptor, ok := providerregistry.Find(provider)",
    'name := "codex"',
    'values := map[string]bool{"opencode": true}'
  ].join("\n");
  assert.deepEqual(
    findProviderIdentityViolations(
      "services/tuttid/service/example.go",
      source,
      providerIds
    ),
    []
  );
});

test("keeps exemptions exact", () => {
  assert.equal(
    isExemptPath("packages/agent/daemon/runtime/codex_appserver_adapter.go"),
    true
  );
  assert.equal(
    isExemptPath("packages/agent/daemon/runtime/codex_appserver_policy.go"),
    false
  );
  assert.equal(
    isExemptPath("services/tuttid/service/agent/external_import_parse.go"),
    true
  );
  assert.equal(
    isExemptPath("services/tuttid/service/agent/external_import_policy.go"),
    false
  );
});

test("rejects an invalid provider catalog", () => {
  assert.throws(() => createProviderIdentityPatterns(["codex", "codex"]), {
    name: "TypeError"
  });
});
