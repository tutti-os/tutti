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

test("keeps AgentTargetProvider open while checking closed provider registries", () => {
  const openapi = providerOpenAPI(["example"]);
  validateRegistryCatalogAgainstOpenAPI(catalog, openapi);

  openapi.components.schemas.AgentTargetProvider.enum = ["example"];
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /must remain an open/u
  );
});

test("rejects an AgentTargetProvider pattern that excludes extensions", () => {
  const openapi = providerOpenAPI(["example"]);
  openapi.components.schemas.AgentTargetProvider.pattern = "^[a-z]+$";
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /AgentTargetProvider must remain an open/u
  );
});

test("rejects a WorkspaceAgentProvider pattern outside canonical grammar", () => {
  const openapi = providerOpenAPI(["example"]);
  openapi.components.schemas.WorkspaceAgentProvider.pattern =
    "^[a-z][a-z0-9._:/-]*$";
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /WorkspaceAgentProvider must remain an open/u
  );
});

test("requires provider-keyed preference schemas to remain closed", () => {
  const openapi = providerOpenAPI(["example"]);
  openapi.components.schemas.DesktopAgentComposerDefaultsByProvider.additionalProperties = true;
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /must remain a closed object/u
  );
});

test("rejects provider-keyed preference schema key drift", () => {
  const openapi = providerOpenAPI(["example"]);
  openapi.components.schemas.DesktopAgentGuiConversationRailCollapsedByProvider.properties.ghost =
    { type: "boolean" };
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /provider schema drift/u
  );
});

test("keeps WorkspaceAgentProvider open", () => {
  const openapi = providerOpenAPI(["example"]);
  openapi.components.schemas.WorkspaceAgentProvider.enum = ["example"];
  assert.throws(
    () => validateRegistryCatalogAgainstOpenAPI(catalog, openapi),
    /WorkspaceAgentProvider must remain an open/u
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
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-z][a-z0-9._:-]*$"
        },
        DesktopAgentComposerDefaultsByProvider: {
          type: "object",
          additionalProperties: false,
          properties: preferenceProperties
        },
        DesktopAgentGuiConversationRailCollapsedByProvider: {
          type: "object",
          additionalProperties: false,
          properties: preferenceProperties
        },
        DesktopDefaultAgentProvider: {
          enum: [migratedProviderIds[0]]
        },
        WorkspaceAgentProvider: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-z][a-z0-9._:-]*$"
        }
      }
    }
  };
}
