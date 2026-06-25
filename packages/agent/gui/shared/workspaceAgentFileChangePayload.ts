export interface WorkspaceAgentFileChangePayloadEntry {
  path: string;
  change: Record<string, unknown>;
  index: number;
}

export function fileChangeEntriesFromChanges(
  value: unknown
): WorkspaceAgentFileChangePayloadEntry[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const change = recordValue(item);
      const path = firstString(
        stringValue(change?.path),
        stringValue(change?.filePath),
        stringValue(change?.file_path)
      );
      if (!change || !path) {
        return [];
      }
      return [{ path, change, index }];
    });
  }

  const changes = recordValue(value);
  if (!changes) {
    return [];
  }
  return Object.entries(changes).flatMap(([path, rawChange], index) => {
    const change = recordValue(rawChange);
    const normalizedPath = path.trim();
    if (!change || !normalizedPath) {
      return [];
    }
    return [{ path: normalizedPath, change, index }];
  });
}

export function fileChangePathsFromChanges(value: unknown): string[] {
  if (Array.isArray(value)) {
    return fileChangeEntriesFromChanges(value).map((entry) => entry.path);
  }

  const changes = recordValue(value);
  if (!changes) {
    return [];
  }
  return Object.keys(changes)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

export function fileChangeCountFromChanges(value: unknown): number {
  return new Set(fileChangePathsFromChanges(value)).size;
}

export function fileChangeTypeValue(
  change: Record<string, unknown>
): string | null {
  const kind = recordValue(change.kind);
  return firstString(
    stringValue(change.type),
    stringValue(change.change),
    stringValue(change.kind),
    stringValue(kind?.type)
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
