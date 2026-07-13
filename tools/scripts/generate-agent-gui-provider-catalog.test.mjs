import assert from "node:assert/strict";
import test from "node:test";
import {
  renderProviderIdentityCatalog,
  validateRegistryCatalog,
  validateRegistryCatalogAgainstOpenAPI
} from "./generate-agent-gui-provider-catalog.mjs";

const catalog = [
  {
    providerId: "example",
    displayName: "Example",
    iconKey: "example-icon",
    localeKey: "example",
    aliases: ["example-alias"],
    target: {
      id: "local:example",
      launchRefType: "local_cli",
      enabled: true,
      sortOrder: 20
    },
    desktop: {
      managed: true,
      managedOrder: 1,
      statusProbePriority: 1,
      usageProbeKind: "example",
      visibilityGate: "example",
      runtimeProbeFallback: "direct",
      installBootstrap: true,
      refreshOnAccountChange: true,
      unavailableDockOrderOffset: 0,
      developerLogs: true,
      defaultProviderEligible: true,
      defaultProviderPriority: 1
    }
  }
];

test("renders every registry identity and target field", async () => {
  const source = await renderProviderIdentityCatalog(catalog);

  assert.match(source, /providerId: "example"/u);
  assert.match(source, /iconKey: "example-icon"/u);
  assert.match(source, /localeKey: "example"/u);
  assert.match(source, /id: "local:example"/u);
  assert.match(source, /launchRefType: "local_cli"/u);
  assert.match(source, /usageProbeKind: "example"/u);
  assert.match(source, /runtimeProbeFallback: "direct"/u);
  assert.match(source, /statusProbePriority: 1/u);
  assert.match(source, /installBootstrap: true/u);
  assert.match(source, /defaultProviderPriority: 1/u);
});

test("rejects duplicate target ids before generating", () => {
  assert.throws(
    () =>
      validateRegistryCatalog([
        ...catalog,
        {
          ...catalog[0],
          providerId: "another-example",
          iconKey: "another-example"
        }
      ]),
    /duplicate target id/u
  );
});

test("requires every migrated provider in each OpenAPI provider registry", () => {
  const openapi = providerOpenAPI(["example"]);
  validateRegistryCatalogAgainstOpenAPI(catalog, openapi);

  openapi.components.schemas.AgentTargetProvider.enum = [];
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /AgentTargetProvider/u
  );
});

test("rejects unregistered OpenAPI provider entries", () => {
  const openapi = providerOpenAPI(["example"]);
  openapi.components.schemas.WorkspaceAgentProvider.enum.push("ghost");
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /WorkspaceAgentProvider/u
  );
});

function providerOpenAPI(migratedProviderIds) {
  const preferenceProperties = Object.fromEntries(
    migratedProviderIds.map((providerId) => [providerId, { type: "boolean" }])
  );
  return {
    components: {
      schemas: {
        AgentTargetProvider: {
          enum: [...migratedProviderIds]
        },
        DesktopAgentComposerDefaultsByProvider: {
          properties: preferenceProperties
        },
        DesktopAgentGuiConversationRailCollapsedByProvider: {
          properties: preferenceProperties
        },
        DesktopDefaultAgentProvider: {
          enum: [migratedProviderIds[0]]
        },
        WorkspaceAgentProvider: {
          enum: [...migratedProviderIds]
        }
      }
    }
  };
}
