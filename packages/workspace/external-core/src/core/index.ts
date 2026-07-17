import {
  tuttiExternalManagedAiModelProviderIds,
  tuttiExternalAtProviderIds,
  tuttiExternalWorkspaceAgentProviders,
  type TuttiExternalAtProviderId,
  type TuttiExternalAtQueryInput,
  type TuttiExternalAtResolveInput,
  type TuttiExternalAtInvalidation,
  type TuttiExternalBrowserOpenUrlInput,
  type TuttiExternalFileOpenInput,
  type TuttiExternalFileSelectInput,
  type TuttiExternalFileUploadInput,
  type TuttiExternalLogInput,
  type TuttiExternalLogLevel,
  type TuttiExternalManagedAiModelProviderId,
  type TuttiExternalPermissionRequestInput,
  type TuttiExternalPdfMargin,
  type TuttiExternalPdfPrintHtmlInput,
  type TuttiExternalReferenceOpenInput,
  type TuttiExternalSettingsOpenInput,
  type TuttiExternalUserProjectCreateInput,
  type TuttiExternalUserProjectPathInput,
  type TuttiExternalUserProjectRememberDefaultSelectionInput,
  type TuttiExternalWorkspaceAgentProvider,
  type TuttiExternalWorkspaceFeature,
  type TuttiExternalWorkspaceOpenFeatureInput
} from "../contracts/index.ts";
import type {
  WorkspaceUserProjectMoveInput,
  WorkspaceUserProjectSelectionPreparationInput
} from "@tutti-os/workspace-user-project/contracts";

export {
  tuttiExternalAtProviderIds,
  tuttiExternalManagedAiModelProviderIds,
  tuttiExternalWorkspaceAgentProviders
} from "../contracts/index.ts";

export const tuttiExternalAtMaxResultsLimit = 50;
export const tuttiExternalAtDefaultMaxResults = 20;
export const tuttiExternalLogDiagnosticTextLimit = 8_000;
export const tuttiExternalWorkspaceFeatures = [
  "app-center",
  "issue-manager",
  "message-center",
  "agent-connect",
  "agent-chat",
  "agent-manage"
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

export function normalizeTuttiExternalAtResolveInput(
  input: unknown
): TuttiExternalAtResolveInput {
  if (!isRecord(input)) {
    throw new Error("at.resolve input must be an object.");
  }
  if (!isTuttiExternalAtProviderId(input.providerId)) {
    throw new Error("at.resolve providerId is unsupported.");
  }
  const entityId = normalizeRequiredString(
    input.entityId,
    "at.resolve entityId"
  );
  return {
    providerId: input.providerId,
    entityId,
    ...(input.scope === undefined || input.scope === null
      ? {}
      : { scope: normalizeTuttiExternalAtScope(input.scope) })
  };
}

export function normalizeTuttiExternalAtInvalidation(
  input: unknown
): TuttiExternalAtInvalidation {
  if (!isRecord(input)) {
    throw new Error("at invalidation must be an object.");
  }
  const providerIds =
    input.providerIds === undefined
      ? undefined
      : normalizeProviders(input.providerIds);
  const entityIds =
    input.entityIds === undefined
      ? undefined
      : normalizeRequiredStringList(
          input.entityIds,
          "at invalidation entityIds"
        );
  if (
    input.revision !== undefined &&
    (typeof input.revision !== "number" || !Number.isFinite(input.revision))
  ) {
    throw new Error("at invalidation revision must be finite.");
  }
  return {
    ...(providerIds ? { providerIds } : {}),
    ...(entityIds ? { entityIds } : {}),
    ...(typeof input.revision === "number" ? { revision: input.revision } : {})
  };
}

export function normalizeTuttiExternalBrowserOpenUrlInput(
  input: unknown
): TuttiExternalBrowserOpenUrlInput {
  if (!isRecord(input)) {
    throw new Error("browser.openUrl input must be an object.");
  }
  const url = normalizeRequiredString(input.url, "browser.openUrl url");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("browser.openUrl protocol is unsupported.");
    }
    return { url: parsed.toString() };
  } catch (error) {
    if (error instanceof Error && error.message.includes("unsupported")) {
      throw error;
    }
    throw new Error("browser.openUrl url is invalid.");
  }
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

export function normalizeTuttiExternalFileUploadInput(
  input: unknown
): TuttiExternalFileUploadInput & { purpose: "app-asset" } {
  if (input === undefined || input === null) {
    return { purpose: "app-asset" };
  }
  if (!isRecord(input)) {
    throw new Error("files.upload input must be an object.");
  }
  return {
    purpose: normalizeFileUploadPurpose(input.purpose),
    ...normalizeOptionalTrimmedString(input.name, "name", "files.upload name"),
    ...normalizeOptionalTrimmedString(
      input.mimeType,
      "mimeType",
      "files.upload mimeType"
    ),
    ...normalizeFileUploadProgressListener(input.onProgress),
    ...normalizeFileUploadSignal(input.signal)
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
  const draftPrompt =
    typeof input.draftPrompt === "string" ? input.draftPrompt.trim() : "";
  return {
    feature,
    ...(draftPrompt ? { draftPrompt } : {}),
    ...(input.autoSubmit === true ? { autoSubmit: true } : {}),
    ...(typeof input.provider === "string" && input.provider.trim() !== ""
      ? {
          provider: normalizeTuttiExternalWorkspaceAgentProvider(input.provider)
        }
      : {})
  };
}

export function normalizeTuttiExternalReferenceOpenInput(
  input: unknown
): TuttiExternalReferenceOpenInput {
  if (!isRecord(input)) {
    throw new Error("references.open input must be an object.");
  }
  const href = normalizeRequiredString(input.href, "references.open href");
  if (!href.toLowerCase().startsWith("mention://")) {
    throw new Error("references.open href must be a mention URL.");
  }
  return { href };
}

export function normalizeTuttiExternalPdfPrintHtmlInput(
  input: unknown
): TuttiExternalPdfPrintHtmlInput {
  if (!isRecord(input)) {
    throw new Error("pdf.printHtmlToPdf input must be an object.");
  }
  const html = normalizeRequiredString(input.html, "pdf.printHtmlToPdf html");
  const title =
    typeof input.title === "string" && input.title.trim() !== ""
      ? input.title.trim().slice(0, 200)
      : undefined;
  const baseUrl =
    typeof input.baseUrl === "string" && input.baseUrl.trim() !== ""
      ? normalizePdfBaseUrl(input.baseUrl)
      : undefined;
  return {
    html,
    ...(baseUrl ? { baseUrl } : {}),
    ...(title ? { title } : {}),
    ...(input.printBackground === false ? { printBackground: false } : {}),
    ...(input.pageSize !== undefined && input.pageSize !== null
      ? { pageSize: normalizePdfPageSize(input.pageSize) }
      : {}),
    ...(input.preferCSSPageSize === true ? { preferCSSPageSize: true } : {}),
    ...(input.margin !== undefined && input.margin !== null
      ? { margin: normalizePdfMargin(input.margin) }
      : {})
  };
}

export function normalizeTuttiExternalUserProjectCreateInput(
  input: unknown
): TuttiExternalUserProjectCreateInput {
  if (!isRecord(input)) {
    throw new Error("userProjects.create input must be an object.");
  }
  return {
    name: normalizeRequiredString(input.name, "userProjects.create name")
  };
}

export function normalizeTuttiExternalUserProjectPathInput(
  input: unknown,
  operation: "checkPath" | "use"
): TuttiExternalUserProjectPathInput {
  if (!isRecord(input)) {
    throw new Error(`userProjects.${operation} input must be an object.`);
  }
  return {
    path: normalizeRequiredString(input.path, `userProjects.${operation} path`)
  };
}

export function normalizeTuttiExternalUserProjectMoveInput(
  input: unknown
): WorkspaceUserProjectMoveInput {
  if (!isRecord(input)) {
    throw new Error("userProjects.move input must be an object.");
  }
  if (!("beforeProjectId" in input)) {
    throw new Error("userProjects.move beforeProjectId is required.");
  }
  const projectId = normalizeRequiredString(
    input.projectId,
    "userProjects.move projectId"
  );
  if (input.beforeProjectId === null) {
    return { beforeProjectId: null, projectId };
  }
  return {
    beforeProjectId: normalizeRequiredString(
      input.beforeProjectId,
      "userProjects.move beforeProjectId"
    ),
    projectId
  };
}

export function normalizeTuttiExternalUserProjectRememberDefaultSelectionInput(
  input: unknown
): TuttiExternalUserProjectRememberDefaultSelectionInput {
  if (!isRecord(input)) {
    throw new Error(
      "userProjects.rememberDefaultSelection input must be an object."
    );
  }
  if (input.path === null || input.path === undefined) {
    return { path: null };
  }
  const path = typeof input.path === "string" ? input.path.trim() : "";
  return { path: path || null };
}

export function normalizeTuttiExternalUserProjectSelectionPreparationInput(
  input: unknown
): WorkspaceUserProjectSelectionPreparationInput {
  if (!isRecord(input)) {
    throw new Error("userProjects.prepareSelection input must be an object.");
  }
  const selectedPath =
    typeof input.selectedPath === "string" ? input.selectedPath.trim() : "";
  return {
    projectLocked: input.projectLocked === true,
    selectedPath: selectedPath || null
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

export function isTuttiExternalWorkspaceAgentProvider(
  value: unknown
): value is TuttiExternalWorkspaceAgentProvider {
  return (
    typeof value === "string" &&
    tuttiExternalWorkspaceAgentProviders.includes(
      value as TuttiExternalWorkspaceAgentProvider
    )
  );
}

function normalizeTuttiExternalWorkspaceAgentProvider(
  value: unknown
): TuttiExternalWorkspaceAgentProvider {
  const provider = typeof value === "string" ? value.trim() : value;
  if (!isTuttiExternalWorkspaceAgentProvider(provider)) {
    throw new Error("workspace.openFeature provider is unsupported.");
  }
  return provider;
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

function normalizePdfBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("pdf.printHtmlToPdf baseUrl must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("pdf.printHtmlToPdf baseUrl protocol is unsupported.");
  }
  return url.toString();
}

function normalizePdfPageSize(
  value: unknown
): TuttiExternalPdfPrintHtmlInput["pageSize"] {
  if (value === "A4" || value === "Letter") {
    return value;
  }
  if (isRecord(value)) {
    const width = normalizePdfPageSizeSide(value.width, "width");
    const height = normalizePdfPageSizeSide(value.height, "height");
    return { width, height };
  }
  throw new Error("pdf.printHtmlToPdf pageSize is unsupported.");
}

function normalizePdfPageSizeSide(
  value: unknown,
  side: "height" | "width"
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `pdf.printHtmlToPdf pageSize ${side} must be a positive number.`
    );
  }
  return value;
}

function normalizePdfMargin(value: unknown): TuttiExternalPdfMargin {
  if (!isRecord(value)) {
    throw new Error("pdf.printHtmlToPdf margin must be an object.");
  }
  return {
    ...normalizePdfMarginSide(value.top, "top"),
    ...normalizePdfMarginSide(value.right, "right"),
    ...normalizePdfMarginSide(value.bottom, "bottom"),
    ...normalizePdfMarginSide(value.left, "left")
  };
}

function normalizePdfMarginSide(
  value: unknown,
  side: keyof TuttiExternalPdfMargin
): TuttiExternalPdfMargin {
  if (value === undefined || value === null || value === "") {
    return {};
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`pdf.printHtmlToPdf margin ${side} must be a string.`);
  }
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?(?:px|in|cm|mm)$/u.test(normalized)) {
    throw new Error(`pdf.printHtmlToPdf margin ${side} unit is unsupported.`);
  }
  return { [side]: normalized };
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

function normalizeFileUploadPurpose(value: unknown): "app-asset" {
  if (value === undefined || value === null || value === "") {
    return "app-asset";
  }
  if (value === "app-asset") {
    return value;
  }
  throw new Error("files.upload purpose is unsupported.");
}

function normalizeFileUploadProgressListener(
  value: unknown
): Pick<TuttiExternalFileUploadInput, "onProgress"> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "function") {
    throw new Error("files.upload onProgress must be a function.");
  }
  return {
    onProgress: value as NonNullable<TuttiExternalFileUploadInput["onProgress"]>
  };
}

function normalizeFileUploadSignal(
  value: unknown
): Pick<TuttiExternalFileUploadInput, "signal"> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isFileUploadAbortSignal(value)) {
    throw new Error("files.upload signal must be an AbortSignal.");
  }
  return { signal: value };
}

function isFileUploadAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function normalizeOptionalTrimmedString(
  value: unknown,
  key: "mimeType" | "name",
  field: string
): Partial<Record<"mimeType" | "name", string>> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  return { [key]: trimmed };
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function normalizeTuttiExternalAtScope(
  value: unknown
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new Error("at.resolve scope must be an object.");
  }
  const scope: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof entry !== "string") {
      throw new Error("at.resolve scope must contain string values.");
    }
    scope[normalizedKey] = entry;
  }
  return scope;
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
