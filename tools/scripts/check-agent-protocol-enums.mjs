// Agent protocol v2 enum consistency check (agent-gui refactor plan, P2).
//
// The closed turn/interaction enums are declared twice by design: once in the
// OpenAPI contract (services/tuttid/api/openapi/tuttid.v1.yaml) and once in
// the event protocol schema (packages/events/protocol/definitions/agent/
// activity.updated.event.json). Both sides feed independent generators, so a
// drifted enum would silently produce mismatched Go/TS types. This script
// fails when the two declarations disagree.
//
// Run directly or via `pnpm check:agent-protocol-enums`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const openapiPath = resolve(
  repoRoot,
  "services/tuttid/api/openapi/tuttid.v1.yaml"
);
const eventSchemaPath = resolve(
  repoRoot,
  "packages/events/protocol/definitions/agent/activity.updated.event.json"
);

const openapi = YAML.parse(readFileSync(openapiPath, "utf8"));
const eventSchema = JSON.parse(readFileSync(eventSchemaPath, "utf8"));

function openapiEnum(schemaName) {
  const schema = openapi?.components?.schemas?.[schemaName];
  if (!schema || !Array.isArray(schema.enum)) {
    throw new Error(`openapi schema ${schemaName} has no enum`);
  }
  return schema.enum;
}

function openapiPropertyEnum(schemaName, propertyName) {
  const property =
    openapi?.components?.schemas?.[schemaName]?.properties?.[propertyName];
  if (!property || !Array.isArray(property.enum)) {
    throw new Error(`openapi schema ${schemaName}.${propertyName} has no enum`);
  }
  return property.enum;
}

function eventBranch(eventType) {
  const branches = eventSchema?.payloadSchema?.oneOf;
  if (!Array.isArray(branches)) {
    throw new Error("event schema payloadSchema.oneOf missing");
  }
  const branch = branches.find((candidate) => {
    const type = candidate?.properties?.data?.properties?.eventType;
    return (
      type?.const === eventType ||
      (Array.isArray(type?.enum) && type.enum.includes(eventType))
    );
  });
  if (!branch) {
    throw new Error(`event schema has no ${eventType} branch`);
  }
  return branch.properties.data.properties;
}

function schemaEnum(node, path) {
  const values = node?.enum;
  if (!Array.isArray(values)) {
    throw new Error(`event schema enum missing at ${path}`);
  }
  return values.filter((value) => value !== null);
}

const turnProperties = eventBranch("turn_update").turn.properties;
const interactionProperties =
  eventBranch("interaction_update").interaction.properties;

const pairs = [
  {
    name: "turn phase",
    openapi: openapiEnum("WorkspaceAgentTurnPhase"),
    event: schemaEnum(turnProperties.phase, "turn_update.turn.phase")
  },
  {
    name: "turn outcome",
    openapi: openapiEnum("WorkspaceAgentTurnOutcome"),
    event: schemaEnum(turnProperties.outcome, "turn_update.turn.outcome")
  },
  {
    name: "completed command kind",
    openapi: openapiPropertyEnum("WorkspaceAgentCompletedCommand", "kind"),
    event: schemaEnum(
      turnProperties.completedCommand.properties.kind,
      "turn_update.turn.completedCommand.kind"
    )
  },
  {
    name: "completed command status",
    openapi: openapiPropertyEnum("WorkspaceAgentCompletedCommand", "status"),
    event: schemaEnum(
      turnProperties.completedCommand.properties.status,
      "turn_update.turn.completedCommand.status"
    )
  },
  {
    name: "interaction kind",
    openapi: openapiEnum("WorkspaceAgentInteractionKind"),
    event: schemaEnum(
      interactionProperties.kind,
      "interaction_update.interaction.kind"
    )
  },
  {
    name: "interaction status",
    openapi: openapiEnum("WorkspaceAgentInteractionStatus"),
    event: schemaEnum(
      interactionProperties.status,
      "interaction_update.interaction.status"
    )
  }
];

let failed = false;
for (const pair of pairs) {
  const openapiValues = [...pair.openapi].sort();
  const eventValues = [...pair.event].sort();
  if (JSON.stringify(openapiValues) !== JSON.stringify(eventValues)) {
    failed = true;
    console.error(
      `agent protocol enum drift (${pair.name}): openapi=${JSON.stringify(openapiValues)} event=${JSON.stringify(eventValues)}`
    );
  }
}

if (failed) {
  console.error(
    "Fix: keep the closed enums in tuttid.v1.yaml and activity.updated.event.json identical, then regenerate (pnpm generate:api && pnpm generate:event-protocol)."
  );
  process.exit(1);
}
console.log("agent protocol enums consistent across openapi and event schema");
