import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const snapshotSchemaPath = resolve(
  repoRoot,
  "packages/workbench/snapshot/src/schema.json"
);
const openApiPath = resolve(
  repoRoot,
  "services/tuttid/api/openapi/tuttid.v1.yaml"
);
const checkOnly = process.argv.includes("--check");

const schemaNames = [
  "WorkbenchSize",
  "WorkbenchSafeArea",
  "WorkbenchLayoutConstraints",
  "WorkbenchLayoutBasis",
  "WorkbenchFrame",
  "WorkbenchSnapshotNode",
  "WorkbenchSnapshotSpace",
  "WorkbenchSnapshot"
];

const sourceSchema = JSON.parse(readFileSync(snapshotSchemaPath, "utf8"));
const openApiSource = readExistingText(openApiPath);
const syncedOpenApiSource = replaceWorkbenchSchemas(
  openApiSource,
  buildOpenApiWorkbenchSchemas(sourceSchema)
);

if (checkOnly) {
  if (openApiSource !== syncedOpenApiSource) {
    throw new Error(
      "OpenAPI workbench schemas are out of sync with packages/workbench/snapshot/src/schema.json. Run pnpm sync:workbench-openapi-schema."
    );
  }
} else if (openApiSource !== syncedOpenApiSource) {
  writeFileSync(openApiPath, syncedOpenApiSource, "utf8");
}

function buildOpenApiWorkbenchSchemas(schema) {
  const defs = schema.$defs ?? {};

  return {
    WorkbenchSize: convertJsonSchemaToOpenApi(defs.size),
    WorkbenchSafeArea: convertJsonSchemaToOpenApi(defs.safeArea),
    WorkbenchLayoutConstraints: convertJsonSchemaToOpenApi(
      defs.layoutConstraints
    ),
    WorkbenchLayoutBasis: convertJsonSchemaToOpenApi(defs.layoutBasis),
    WorkbenchFrame: convertJsonSchemaToOpenApi(defs.frame),
    WorkbenchSnapshotNode: convertJsonSchemaToOpenApi(defs.node),
    WorkbenchSnapshotSpace: convertJsonSchemaToOpenApi(defs.space),
    WorkbenchSnapshot: convertJsonSchemaToOpenApi(
      omitKeys(schema, ["$schema", "$id", "title", "$defs"])
    )
  };
}

function convertJsonSchemaToOpenApi(value) {
  if (value === true) {
    return { nullable: true };
  }
  if (Array.isArray(value)) {
    return value.map(convertJsonSchemaToOpenApi);
  }
  if (!isRecord(value)) {
    return value;
  }

  if (isNullableAnyOfRef(value)) {
    return {
      allOf: [convertJsonSchemaToOpenApi(value.anyOf[0])],
      nullable: true
    };
  }

  const output = {};

  for (const [key, entryValue] of Object.entries(value)) {
    if (key === "$ref") {
      output.$ref = rewriteRef(entryValue);
      continue;
    }
    if (key === "$defs" || key === "$schema" || key === "$id") {
      continue;
    }
    if (key === "const") {
      output.type = Number.isInteger(entryValue)
        ? "integer"
        : typeof entryValue;
      output.enum = [entryValue];
      continue;
    }
    if (key === "exclusiveMinimum" && typeof entryValue === "number") {
      output.minimum = entryValue;
      output.exclusiveMinimum = true;
      continue;
    }
    if (key === "type" && Array.isArray(entryValue)) {
      const nonNullTypes = entryValue.filter((item) => item !== "null");
      if (nonNullTypes.length === 1 && entryValue.includes("null")) {
        output.type = nonNullTypes[0];
        output.nullable = true;
        continue;
      }
    }

    output[key] = convertJsonSchemaToOpenApi(entryValue);
  }

  if (
    output.type === "object" &&
    output.additionalProperties === undefined &&
    output.properties === undefined
  ) {
    output.additionalProperties = true;
  }
  if (Array.isArray(output.enum) && output.type === undefined) {
    const enumTypes = new Set(output.enum.map((item) => typeof item));
    if (enumTypes.size === 1) {
      output.type = [...enumTypes][0];
    }
  }

  return output;
}

function replaceWorkbenchSchemas(openApiSource, schemas) {
  const document = parseDocument(openApiSource, { keepSourceTokens: true });
  const schemasNode = document.getIn(["components", "schemas"], true);

  if (!schemasNode?.items) {
    throw new Error(`Unable to locate components.schemas in ${openApiPath}`);
  }

  const replacements = schemaNames
    .map((schemaName) =>
      locateSchemaReplacement(openApiSource, schemasNode, schemaName, schemas)
    )
    .filter(Boolean);
  const missingSchemaNames = schemaNames.filter(
    (schemaName) =>
      !schemasNode.items.some((pair) => pair.key?.value === schemaName)
  );
  if (missingSchemaNames.length > 0) {
    const firstWorkbenchSchema = replacements.reduce(
      (first, replacement) =>
        replacement.start < first.start ? replacement : first,
      replacements[0]
    );
    if (!firstWorkbenchSchema) {
      throw new Error(`Unable to locate Workbench schemas in ${openApiPath}`);
    }
    replacements.push({
      start: firstWorkbenchSchema.start,
      end: firstWorkbenchSchema.start,
      content: missingSchemaNames
        .map((schemaName) =>
          renderIndentedSchema(schemaName, schemas[schemaName])
        )
        .join("")
    });
  }

  let output = openApiSource;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start
  )) {
    output =
      output.slice(0, replacement.start) +
      replacement.content +
      output.slice(replacement.end);
  }

  return output;
}

function locateSchemaReplacement(
  openApiSource,
  schemasNode,
  schemaName,
  schemas
) {
  const pairIndex = schemasNode.items.findIndex(
    (pair) => pair.key?.value === schemaName
  );
  const pair = schemasNode.items[pairIndex];
  if (!pair) {
    return null;
  }
  if (!pair.key?.range || !pair.value?.range) {
    throw new Error(`Unable to read ${schemaName} in ${openApiPath}`);
  }

  const nextPair = schemasNode.items[pairIndex + 1];
  const start = lineStartBefore(openApiSource, pair.key.range[0]);
  const end = nextPair?.key?.range
    ? lineStartBefore(openApiSource, nextPair.key.range[0])
    : pair.value.range[2];

  return {
    start,
    end,
    content: renderIndentedSchema(schemaName, schemas[schemaName])
  };
}

function renderIndentedSchema(schemaName, schema) {
  return stringify(
    {
      [schemaName]: schema
    },
    {
      lineWidth: 0,
      singleQuote: false
    }
  )
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
    .concat("\n");
}

function lineStartBefore(source, index) {
  return source.lastIndexOf("\n", index) + 1;
}

function rewriteRef(value) {
  if (typeof value !== "string") {
    throw new Error(`Expected string $ref, got ${typeof value}`);
  }

  return value
    .replace("#/$defs/frame", "#/components/schemas/WorkbenchFrame")
    .replace("#/$defs/size", "#/components/schemas/WorkbenchSize")
    .replace("#/$defs/safeArea", "#/components/schemas/WorkbenchSafeArea")
    .replace(
      "#/$defs/layoutConstraints",
      "#/components/schemas/WorkbenchLayoutConstraints"
    )
    .replace("#/$defs/layoutBasis", "#/components/schemas/WorkbenchLayoutBasis")
    .replace("#/$defs/node", "#/components/schemas/WorkbenchSnapshotNode")
    .replace("#/$defs/space", "#/components/schemas/WorkbenchSnapshotSpace");
}

function isNullableAnyOfRef(value) {
  return (
    Array.isArray(value.anyOf) &&
    value.anyOf.length === 2 &&
    isRecord(value.anyOf[0]) &&
    typeof value.anyOf[0].$ref === "string" &&
    isRecord(value.anyOf[1]) &&
    value.anyOf[1].type === "null"
  );
}

function omitKeys(value, keys) {
  const ignored = new Set(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !ignored.has(key))
  );
}

function readExistingText(path) {
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
