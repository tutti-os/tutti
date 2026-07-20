const cliManifestSchemaVersion = "tutti.app.cli.v1";

export function validateCLIManifest(manifest, sourceLabel = "cli manifest") {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`${sourceLabel} must be an object`);
  }
  if (manifest.schemaVersion !== cliManifestSchemaVersion) {
    throw new Error(
      `${sourceLabel} schemaVersion must be ${cliManifestSchemaVersion}`
    );
  }
  requireCLISegment(manifest.scope, `${sourceLabel}.scope`);
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    throw new Error(`${sourceLabel}.commands must be a non-empty array`);
  }
  const seenPaths = new Set();
  for (const [index, command] of manifest.commands.entries()) {
    const label = `${sourceLabel}.commands[${index}]`;
    validateCLICommand(command, label, manifest.scope, seenPaths);
  }
}

function validateCLICommand(command, label, scope, seenPaths) {
  if (!command || typeof command !== "object") {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(command.path) || command.path.length === 0) {
    throw new Error(`${label}.path must be a non-empty array`);
  }
  if (command.path[0] === scope) {
    throw new Error(`${label}.path must not repeat scope`);
  }
  for (const [index, segment] of command.path.entries()) {
    requireCLISegment(segment, `${label}.path[${index}]`);
  }
  const pathKey = command.path.join(".");
  if (seenPaths.has(pathKey)) {
    throw new Error(`${label}.path must be unique`);
  }
  seenPaths.add(pathKey);
  requireNonEmpty(command.summary, `${label}.summary`);
  validateCLIVisibility(command.visibility, `${label}.visibility`);
  validateCLIInputSchema(command.inputSchema, `${label}.inputSchema`);
  validateCLIOutput(command.output, `${label}.output`);
  validateCLIExecution(
    command.execution,
    command.inputSchema,
    command.output,
    `${label}.execution`
  );
  validateCLIHandler(command.handler, `${label}.handler`);
}

function validateCLIVisibility(visibility, label) {
  if (visibility === undefined) {
    return;
  }
  if (!["public", "integration"].includes(visibility)) {
    throw new Error(`${label} must be public or integration`);
  }
}

function validateCLIExecution(execution, inputSchema, output, label) {
  if (execution === undefined) {
    return;
  }
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error(`${label} must be an object`);
  }
  if (execution.mode !== "wait") {
    throw new Error(`${label}.mode must be wait`);
  }
  if (output?.defaultMode !== "json" || output?.json !== true) {
    throw new Error(`${label} mode wait requires json default output`);
  }
  if (inputSchema?.properties?.["timeout-ms"] !== undefined) {
    throw new Error(
      `${label} mode wait reserves --timeout-ms for the total CLI wait timeout`
    );
  }
}

function validateCLIInputSchema(schema, label) {
  if (schema === undefined) {
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${label} must be an object`);
  }
  if (schema.type !== "object") {
    throw new Error(`${label}.type must be object`);
  }
  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    throw new Error(`${label}.properties must be an object`);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    requireCLISegment(name, `${label}.properties key`);
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      throw new Error(`${label}.properties.${name} must be an object`);
    }
    if (!["string", "boolean", "integer"].includes(property.type)) {
      throw new Error(
        `${label}.properties.${name}.type must be string, boolean, or integer`
      );
    }
    validateCLIInputEnum(
      property.enum,
      property.type,
      `${label}.properties.${name}.enum`
    );
    validateCLIInputDefault(
      property.default,
      property.type,
      property.enum,
      `${label}.properties.${name}.default`
    );
    for (const key of Object.keys(property)) {
      if (!["type", "description", "enum", "default"].includes(key)) {
        throw new Error(`${label}.properties.${name}.${key} is not supported`);
      }
    }
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required)) {
    throw new Error(`${label}.required must be an array`);
  }
  for (const name of required) {
    if (typeof name !== "string" || !Object.hasOwn(schema.properties, name)) {
      throw new Error(
        `${label}.required contains unknown property ${String(name)}`
      );
    }
  }
  for (const key of Object.keys(schema)) {
    if (!["type", "properties", "required"].includes(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
}

function validateCLIInputDefault(value, type, enumValues, label) {
  if (value === undefined) {
    return;
  }
  validateCLIInputValue(value, type, label);
  if (enumValues !== undefined && !enumValues.includes(value)) {
    throw new Error(`${label} must be one of the declared enum values`);
  }
}

function validateCLIInputEnum(values, type, label) {
  if (values === undefined) {
    return;
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const [index, value] of values.entries()) {
    validateCLIInputValue(value, type, `${label}[${index}]`);
  }
}

function validateCLIInputValue(value, type, label) {
  if (type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be an integer`);
    }
    return;
  }
  if (typeof value !== type) {
    throw new Error(`${label} must be ${type}`);
  }
}

function validateCLIOutput(output, label) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error(`${label} must be an object`);
  }
  if (!["json", "table"].includes(output.defaultMode)) {
    throw new Error(`${label}.defaultMode must be json or table`);
  }
  if (output.defaultMode === "json" && output.json !== true) {
    throw new Error(`${label}.json must be true when defaultMode is json`);
  }
  if (output.defaultMode === "table") {
    if (
      !output.table ||
      !Array.isArray(output.table.columns) ||
      output.table.columns.length === 0
    ) {
      throw new Error(
        `${label}.table.columns must be a non-empty array when defaultMode is table`
      );
    }
    for (const [index, column] of output.table.columns.entries()) {
      requireCLISegment(column?.key, `${label}.table.columns[${index}].key`);
      requireNonEmpty(column?.label, `${label}.table.columns[${index}].label`);
    }
  }
}

function validateCLIHandler(handler, label) {
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) {
    throw new Error(`${label} must be an object`);
  }
  if (handler.kind !== "http") {
    throw new Error(`${label}.kind must be http`);
  }
  if (handler.method !== "POST") {
    throw new Error(`${label}.method must be POST`);
  }
  if (
    typeof handler.path !== "string" ||
    !handler.path.startsWith("/tutti/cli/")
  ) {
    throw new Error(`${label}.path must start with /tutti/cli/`);
  }
  const timeoutMs = handler.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error(`${label}.timeoutMs must be between 1000 and 600000`);
  }
}

function requireCLISegment(value, label) {
  const text = requireNonEmpty(value, label);
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(text) ||
    text.startsWith("--")
  ) {
    throw new Error(
      `${label} must contain lowercase letters, numbers, and hyphen only`
    );
  }
  return text;
}

function requireNonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return text;
}
