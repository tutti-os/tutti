import {
  tuttiExternalManagedAiModelProviderIds,
  tuttiExternalAtProviderIds,
  type TuttiExternalAtProviderId,
  type TuttiExternalAtQueryInput,
  type TuttiExternalFileOpenInput,
  type TuttiExternalFileSelectInput,
  type TuttiExternalLogInput,
  type TuttiExternalLogLevel,
  type TuttiExternalManagedAiModelProviderId,
  type TuttiExternalPermissionRequestInput,
  type TuttiExternalSettingsOpenInput,
  type TuttiExternalWorkspaceFeature,
  type TuttiExternalWorkspaceOpenFeatureInput
} from "../contracts/index.ts";

export {
  tuttiExternalAtProviderIds,
  tuttiExternalManagedAiModelProviderIds
} from "../contracts/index.ts";

export const tuttiExternalAtMaxResultsLimit = 50;
export const tuttiExternalAtDefaultMaxResults = 20;
export const tuttiExternalLogDiagnosticTextLimit = 8_000;
export const tuttiExternalWorkspaceFeatures = [
  "app-center",
  "issue-manager",
  "message-center",
  "agent-connect",
  "agent-chat"
] as const satisfies readonly TuttiExternalWorkspaceFeature[];

export function limitDiagnosticText(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > tuttiExternalLogDiagnosticTextLimit
    ? `${trimmed.slice(0, tuttiExternalLogDiagnosticTextLimit)}...`
    : trimmed;
}

export function normalizeTuttiExternalLogInput(
  input: unknown
): TuttiExternalLogInput {
  if (!isRecord(input)) {
    throw new Error("logs.write input must be an object.");
  }

  const event = limitDiagnosticText(
    normalizeRequiredString(input.event, "logs.write event")
  );
  if (!event) {
    throw new Error("logs.write event is required.");
  }

  return {
    event,
    ...(input.level !== undefined && input.level !== null
      ? { level: normalizeTuttiExternalLogLevel(input.level) }
      : {}),
    ...(input.details !== undefined && input.details !== null
      ? { details: normalizeTuttiExternalLogDetails(input.details) }
      : {})
  };
}

export function normalizeTuttiExternalAtQueryInput(
  input: unknown
): TuttiExternalAtQueryInput {
  if (!isRecord(input)) {
    throw new Error("at.query input must be an object.");
  }

  const keywordValue = input.keyword;
  if (typeof keywordValue !== "string") {
    throw new Error("at.query keyword is required.");
  }

  return {
    keyword: keywordValue,
    maxResults: normalizeMaxResults(input.maxResults),
    providers: normalizeProviders(input.providers)
  };
}

export function normalizeTuttiExternalFileSelectInput(
  input: unknown
): TuttiExternalFileSelectInput {
  if (input === undefined || input === null) {
    return {};
  }
  if (!isRecord(input)) {
    throw new Error("files.select input must be an object.");
  }
  return {
    multiple: input.multiple === true
  };
}

export function normalizeTuttiExternalFileOpenInput(
  input: unknown
): TuttiExternalFileOpenInput {
  if (!isRecord(input)) {
    throw new Error("files.open input must be an object.");
  }
  if (typeof input.path !== "string" || input.path.trim() === "") {
    throw new Error("files.open path is required.");
  }
  const mode = normalizeFileOpenMode(input.mode);
  return {
    ...(mode ? { mode } : {}),
    ...(typeof input.mtimeMs === "number" || input.mtimeMs === null
      ? { mtimeMs: input.mtimeMs }
      : {}),
    ...(typeof input.name === "string" && input.name.trim() !== ""
      ? { name: input.name.trim() }
      : {}),
    path: input.path.trim(),
    ...(typeof input.sizeBytes === "number" || input.sizeBytes === null
      ? { sizeBytes: input.sizeBytes }
      : {})
  };
}

export function normalizeTuttiExternalPermissionRequestInput(
  input: unknown
): TuttiExternalPermissionRequestInput {
  if (!isRecord(input)) {
    throw new Error("permissions.request input must be an object.");
  }
  if (input.permission !== "managed-ai-models") {
    throw new Error("permissions.request permission is unsupported.");
  }
  const nonce = normalizeRequiredString(
    input.nonce,
    "permissions.request nonce"
  );
  const state = normalizeRequiredString(
    input.state,
    "permissions.request state"
  );
  const scopes = normalizeRequiredStringList(
    input.scopes,
    "permissions.request scopes"
  );
  if (scopes.length === 0) {
    throw new Error("permissions.request scopes must not be empty.");
  }

  return {
    nonce,
    permission: "managed-ai-models",
    providers: normalizeManagedAiModelProviders(input.providers),
    scopes,
    state
  };
}

export function normalizeTuttiExternalSettingsOpenInput(
  input: unknown
): TuttiExternalSettingsOpenInput {
  if (input === undefined || input === null) {
    return {};
  }
  if (!isRecord(input)) {
    throw new Error("settings.open input must be an object.");
  }
  if (
    input.tab !== undefined &&
    input.tab !== null &&
    input.tab !== "" &&
    input.tab !== "models"
  ) {
    throw new Error("settings.open tab is unsupported.");
  }
  return {
    ...(input.provider !== undefined && input.provider !== null
      ? { provider: normalizeManagedAiModelProvider(input.provider) }
      : {}),
    ...(input.tab === "models" ? { tab: "models" as const } : {})
  };
}

export function normalizeTuttiExternalWorkspaceOpenFeatureInput(
  input: unknown
): TuttiExternalWorkspaceOpenFeatureInput {
  if (!isRecord(input)) {
    throw new Error("workspace.openFeature input must be an object.");
  }
  const feature = input.feature;
  if (!isTuttiExternalWorkspaceFeature(feature)) {
    throw new Error("workspace.openFeature feature is unsupported.");
  }
  return {
    feature,
    ...(typeof input.provider === "string" && input.provider.trim() !== ""
      ? { provider: input.provider.trim() }
      : {})
  };
}

export function isTuttiExternalAtProviderId(
  value: unknown
): value is TuttiExternalAtProviderId {
  return (
    typeof value === "string" &&
    tuttiExternalAtProviderIds.includes(value as TuttiExternalAtProviderId)
  );
}

export function isTuttiExternalManagedAiModelProviderId(
  value: unknown
): value is TuttiExternalManagedAiModelProviderId {
  return (
    typeof value === "string" &&
    tuttiExternalManagedAiModelProviderIds.includes(
      value as TuttiExternalManagedAiModelProviderId
    )
  );
}

export function isTuttiExternalWorkspaceFeature(
  value: unknown
): value is TuttiExternalWorkspaceFeature {
  return (
    typeof value === "string" &&
    tuttiExternalWorkspaceFeatures.includes(
      value as TuttiExternalWorkspaceFeature
    )
  );
}

function normalizeTuttiExternalLogLevel(value: unknown): TuttiExternalLogLevel {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }
  throw new Error("logs.write level is unsupported.");
}

function normalizeTuttiExternalLogDetails(
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("logs.write details must be an object.");
  }

  const details: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    details[key] = normalizeTuttiExternalLogDetailValue(entry);
  }
  return details;
}

function normalizeTuttiExternalLogDetailValue(value: unknown): unknown {
  if (typeof value === "string") {
    return limitDiagnosticText(value) ?? "";
  }
  if (value instanceof Error) {
    return {
      message: limitDiagnosticText(value.message) ?? "",
      name: value.name,
      stack: limitDiagnosticText(value.stack)
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeTuttiExternalLogDetailValue(entry));
  }
  if (isRecord(value)) {
    return normalizeTuttiExternalLogDetails(value);
  }
  return value;
}

function normalizeMaxResults(value: unknown): number {
  if (value === undefined || value === null) {
    return tuttiExternalAtDefaultMaxResults;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("at.query maxResults must be a finite number.");
  }
  const integer = Math.floor(value);
  if (integer < 0) {
    throw new Error("at.query maxResults must be greater than or equal to 0.");
  }
  return Math.min(integer, tuttiExternalAtMaxResultsLimit);
}

function normalizeProviders(
  value: unknown
): readonly TuttiExternalAtProviderId[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("at.query providers must be an array.");
  }
  const providers: TuttiExternalAtProviderId[] = [];
  for (const provider of value) {
    if (!isTuttiExternalAtProviderId(provider)) {
      throw new Error("at.query providers contains an unsupported provider.");
    }
    if (!providers.includes(provider)) {
      providers.push(provider);
    }
  }
  return providers;
}

function normalizeManagedAiModelProviders(
  value: unknown
): readonly TuttiExternalManagedAiModelProviderId[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("permissions.request providers must be an array.");
  }
  const providers: TuttiExternalManagedAiModelProviderId[] = [];
  for (const provider of value) {
    const normalizedProvider = normalizeManagedAiModelProvider(provider);
    if (!providers.includes(normalizedProvider)) {
      providers.push(normalizedProvider);
    }
  }
  return providers;
}

function normalizeManagedAiModelProvider(
  value: unknown
): TuttiExternalManagedAiModelProviderId {
  if (!isTuttiExternalManagedAiModelProviderId(value)) {
    throw new Error("managed AI model provider is unsupported.");
  }
  return value;
}

function normalizeFileOpenMode(
  value: unknown
): TuttiExternalFileOpenInput["mode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "auto" || value === "preview" || value === "reveal") {
    return value;
  }
  throw new Error("files.open mode is unsupported.");
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function normalizeRequiredStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  const normalizedValues: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${field} contains an invalid value.`);
    }
    const normalizedItem = item.trim();
    if (!normalizedValues.includes(normalizedItem)) {
      normalizedValues.push(normalizedItem);
    }
  }
  return normalizedValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
