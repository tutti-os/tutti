import { fileChangeCountFromChanges } from "./workspaceAgentFileChangePayload";

export function recordValue(
  value: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

export function stringRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" ? nested : undefined;
}

export function stringArrayRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string[] {
  const nested = value?.[key];
  return Array.isArray(nested)
    ? nested.flatMap((item) =>
        typeof item === "string" && item.trim() ? [item.trim()] : []
      )
    : [];
}

export function stringArrayFirstRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  return stringArrayRecordValue(value, key)[0];
}

export function arrayRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): Array<Record<string, unknown>> {
  const nested = value?.[key];
  return Array.isArray(nested)
    ? nested.flatMap((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? [item as Record<string, unknown>]
          : []
      )
    : [];
}

export function collectToolPaths(
  metadata: Record<string, unknown> | undefined,
  metadataInput: Record<string, unknown> | undefined,
  payloadInput: Record<string, unknown> | undefined
): string[] {
  return Array.from(
    new Set([
      ...stringArrayRecordValue(metadata, "paths"),
      ...toolInputPaths(metadataInput),
      ...toolInputPaths(payloadInput)
    ])
  );
}

export function summarizeToolInput(
  value: Record<string, unknown> | undefined
): string {
  if (!value) return "";
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "filepath",
    "fileName",
    "filename",
    "target_path",
    "targetPath",
    "url",
    "uri",
    "query",
    "pattern",
    "prompt",
    "instruction",
    "task",
    "title",
    "message",
    "text",
    "cmd",
    "command"
  ]) {
    const text = summarizeInputField(value, key);
    if (text) return text;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    const text = summarizeInputValue(key, fieldValue);
    if (text) return text;
  }
  return "";
}

export function summarizeFileChangeCount(
  ...values: Array<Record<string, unknown> | undefined>
): string | null {
  for (const value of values) {
    const structuredPatch = arrayRecordValue(value, "structuredPatch");
    if (structuredPatch.length > 1) return `${structuredPatch.length} files`;
    const files = arrayRecordValue(recordValue(value, "fileChanges"), "files");
    if (files.length > 1) return `${files.length} files`;
    const count = fileChangeCountFromChanges(value?.changes);
    if (count > 1) return `${count} files`;
  }
  return null;
}

export function summarizeTodoProgress(
  value: Record<string, unknown> | undefined
): string | null {
  const todos = arrayRecordValue(value, "todos");
  if (todos.length === 0) return null;
  const completed = todos.filter(
    (todo) =>
      normalizeToolToken(stringRecordValue(todo, "status")) === "completed"
  ).length;
  return `${completed}/${todos.length} completed`;
}

export function summarizeWebDomain(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function firstPath(paths: string[]): string {
  return paths[0] ?? "";
}

export function firstPresentString(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return "";
}

function toolInputPaths(value: Record<string, unknown> | undefined): string[] {
  if (!value) return [];
  return [
    ...stringValues(
      value,
      "path",
      "file_path",
      "filePath",
      "filepath",
      "fileName",
      "filename",
      "target_path",
      "targetPath"
    ),
    ...stringArrayRecordValue(value, "paths"),
    ...stringArrayRecordValue(value, "file_paths"),
    ...stringArrayRecordValue(value, "filePaths"),
    ...stringArrayRecordValue(value, "file_names"),
    ...stringArrayRecordValue(value, "fileNames"),
    ...stringArrayRecordValue(value, "filenames")
  ];
}

function summarizeInputField(
  value: Record<string, unknown>,
  key: string
): string {
  const fieldValue = value[key];
  if (typeof fieldValue === "string")
    return formatInputSummary(key, fieldValue);
  if (Array.isArray(fieldValue)) {
    const items = fieldValue
      .flatMap((item) =>
        typeof item === "string" && item.trim() ? [item.trim()] : []
      )
      .slice(0, 3);
    if (items.length > 0) return formatInputSummary(key, items.join(", "));
  }
  if (
    fieldValue &&
    typeof fieldValue === "object" &&
    !Array.isArray(fieldValue)
  ) {
    for (const [nestedKey, nestedValue] of Object.entries(
      fieldValue as Record<string, unknown>
    )) {
      if (isSensitiveKey(nestedKey)) continue;
      const text = summarizeInputValue(`${key}.${nestedKey}`, nestedValue);
      if (text) return text;
    }
  }
  return "";
}

function summarizeInputValue(key: string, value: unknown): string {
  return typeof value === "string" && value.trim()
    ? formatInputSummary(key, value)
    : "";
}

function formatInputSummary(key: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const prefixless = new Set(
    [
      "path",
      "file_path",
      "filePath",
      "filepath",
      "fileName",
      "filename",
      "target_path",
      "targetPath",
      "url",
      "uri",
      "query",
      "pattern",
      "cmd",
      "command"
    ].map(normalizeToolToken)
  );
  const text = trimmed.length > 140 ? `${trimmed.slice(0, 139)}…` : trimmed;
  // i18n-check-ignore: Tool input summaries combine schema keys with user input.
  return prefixless.has(normalizeToolToken(key)) ? text : `${key}: ${text}`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeToolToken(key);
  return [
    "token",
    "password",
    "secret",
    "api_key",
    "apikey",
    "authorization"
  ].some((part) => normalized.includes(part));
}

function stringValues(
  value: Record<string, unknown>,
  ...keys: string[]
): string[] {
  return keys.flatMap((key) => {
    const text = stringRecordValue(value, key)?.trim();
    return text ? [text] : [];
  });
}

function normalizeToolToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, "_") ?? ""
  );
}
