import type {
  TuttiExternalAtQueryResult,
  TuttiExternalPdfPrintHtmlResult,
  TuttiExternalPermissionRequestResult,
  TuttiExternalUploadedFile,
  TuttiExternalWorkspaceOpenRouteIntent
} from "../contracts/index.ts";
import {
  isTuttiExternalAtProviderId,
  isTuttiExternalManagedAiModelProviderId
} from "../core/index.ts";
import type {
  TuttiExternalHostEvent,
  TuttiExternalHostEventPayloadMap,
  TuttiExternalRequestOperation,
  TuttiExternalRequestResultMap
} from "./types.ts";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectServiceSnapshot
} from "@tutti-os/workspace-user-project/contracts";

export function normalizeTuttiExternalRequestResult<
  TOperation extends TuttiExternalRequestOperation
>(
  operation: TOperation,
  value: unknown
): TuttiExternalRequestResultMap[TOperation] {
  switch (operation) {
    case "at.query":
      return normalizeAtQueryResults(
        value
      ) as TuttiExternalRequestResultMap[TOperation];
    case "files.select":
      assertFileReferences(value);
      break;
    case "permissions.request":
      normalizePermissionResult(value);
      break;
    case "pdf.printHtmlToPdf":
      normalizePdfResult(value);
      break;
    case "userProjects.checkPath":
      assertUserProjectPathCheck(value);
      break;
    case "userProjects.create":
    case "userProjects.use":
      assertUserProject(value);
      break;
    case "userProjects.getDefaultSelection":
      assertDefaultSelection(value);
      break;
    case "userProjects.getSnapshot":
    case "userProjects.refresh":
      assertUserProjectSnapshot(value);
      break;
    case "userProjects.list":
      assertUserProjectList(value);
      break;
    case "userProjects.prepareSelection":
      assertSelectionPreparation(value);
      break;
    case "userProjects.selectDirectory":
      assertDirectorySelection(value);
      break;
    default:
      break;
  }
  return value as TuttiExternalRequestResultMap[TOperation];
}

export function normalizeTuttiExternalUploadedFileResult(
  value: unknown
): TuttiExternalUploadedFile {
  if (
    !isRecord(value) ||
    !isString(value.path) ||
    !isString(value.name) ||
    !isString(value.mimeType) ||
    !isNonNegativeNumber(value.sizeBytes) ||
    !isString(value.sha256)
  ) {
    throw new Error("files.upload host result is invalid.");
  }
  return value as unknown as TuttiExternalUploadedFile;
}

export function normalizeTuttiExternalHostEventPayload<
  TEvent extends TuttiExternalHostEvent
>(event: TEvent, value: unknown): TuttiExternalHostEventPayloadMap[TEvent] {
  if (event === "workspace.launchIntent") {
    assertLaunchIntent(value);
  } else if (event === "userProjects.changed") {
    assertUserProjectSnapshot(value);
  }
  return value as TuttiExternalHostEventPayloadMap[TEvent];
}

function normalizeAtQueryResults(value: unknown): TuttiExternalAtQueryResult[] {
  if (!Array.isArray(value)) {
    throw new Error("at.query host result must be an array.");
  }
  for (const result of value) {
    if (
      !isRecord(result) ||
      !isTuttiExternalAtProviderId(result.providerId) ||
      !isString(result.itemId) ||
      !isString(result.label) ||
      !isRecord(result.insert)
    ) {
      throw new Error("at.query host result contains an invalid item.");
    }
    assertAtInsertResult(result.insert);
  }
  return value as TuttiExternalAtQueryResult[];
}

function assertAtInsertResult(value: Record<string, unknown>): void {
  if (value.kind === "text" && isString(value.text)) {
    return;
  }
  if (
    value.kind === "markdown-link" &&
    isString(value.label) &&
    isString(value.href)
  ) {
    return;
  }
  if (
    value.kind === "mention" &&
    isRecord(value.mention) &&
    isString(value.mention.entityId) &&
    isString(value.mention.label)
  ) {
    return;
  }
  throw new Error("at.query host result contains an invalid insert payload.");
}

function assertFileReferences(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.some(
      (reference) =>
        !isRecord(reference) ||
        !isString(reference.path) ||
        !isString(reference.kind)
    )
  ) {
    throw new Error("files.select host result is invalid.");
  }
}

function normalizePermissionResult(
  value: unknown
): TuttiExternalPermissionRequestResult {
  if (!isRecord(value) || !isString(value.code)) {
    throw new Error("permissions.request host result is invalid.");
  }
  if (
    value.providers !== undefined &&
    (!Array.isArray(value.providers) ||
      value.providers.some(
        (provider) => !isTuttiExternalManagedAiModelProviderId(provider)
      ))
  ) {
    throw new Error("permissions.request host providers are invalid.");
  }
  if (
    value.models !== undefined &&
    (!Array.isArray(value.models) ||
      value.models.some(
        (model) =>
          !isRecord(model) ||
          !isString(model.id) ||
          !isTuttiExternalManagedAiModelProviderId(model.provider)
      ))
  ) {
    throw new Error("permissions.request host models are invalid.");
  }
  return value as unknown as TuttiExternalPermissionRequestResult;
}

function normalizePdfResult(value: unknown): TuttiExternalPdfPrintHtmlResult {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) {
    throw new Error("pdf.printHtmlToPdf host result is invalid.");
  }
  return value as unknown as TuttiExternalPdfPrintHtmlResult;
}

function assertUserProjectPathCheck(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.exists !== "boolean" ||
    typeof value.isDirectory !== "boolean" ||
    !isString(value.path)
  ) {
    throw new Error("userProjects.checkPath host result is invalid.");
  }
}

function assertUserProject(
  value: unknown
): asserts value is WorkspaceUserProject {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.label) ||
    !isString(value.path)
  ) {
    throw new Error("userProjects host project is invalid.");
  }
}

function assertDefaultSelection(value: unknown): void {
  if (
    value !== null &&
    (!isRecord(value) ||
      (value.path !== null && typeof value.path !== "string"))
  ) {
    throw new Error("userProjects default selection is invalid.");
  }
}

function assertUserProjectSnapshot(
  value: unknown
): asserts value is WorkspaceUserProjectServiceSnapshot {
  if (
    !isRecord(value) ||
    typeof value.initialized !== "boolean" ||
    typeof value.isLoading !== "boolean" ||
    (value.error !== null && typeof value.error !== "string") ||
    !Number.isSafeInteger(value.revision) ||
    !Array.isArray(value.projects)
  ) {
    throw new Error("userProjects snapshot is invalid.");
  }
  for (const project of value.projects) {
    assertUserProject(project);
  }
}

function assertUserProjectList(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.projects)) {
    throw new Error("userProjects.list host result is invalid.");
  }
  for (const project of value.projects) {
    assertUserProject(project);
  }
}

function assertSelectionPreparation(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.isSelectedPathMissing !== "boolean" ||
    !Array.isArray(value.projects) ||
    !isRecord(value.selection)
  ) {
    throw new Error("userProjects.prepareSelection host result is invalid.");
  }
  for (const project of value.projects) {
    assertUserProject(project);
  }
  const selection = value.selection;
  if (
    selection.kind === "none" ||
    (selection.kind === "clear" && isString(selection.suppressedPath)) ||
    (selection.kind === "select" && isString(selection.path))
  ) {
    return;
  }
  throw new Error("userProjects.prepareSelection host result is invalid.");
}

function assertDirectorySelection(value: unknown): void {
  if (value !== null && (!isRecord(value) || !isString(value.path))) {
    throw new Error("userProjects.selectDirectory host result is invalid.");
  }
}

function assertLaunchIntent(
  value: unknown
): asserts value is TuttiExternalWorkspaceOpenRouteIntent {
  if (
    !isRecord(value) ||
    value.kind !== "open-route" ||
    !isString(value.route) ||
    !value.route.startsWith("/") ||
    (value.params !== undefined && !isStringRecord(value.params)) ||
    (value.state !== undefined && !isRecord(value.state))
  ) {
    throw new Error("workspace launch intent is invalid.");
  }
}

function isStringRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
