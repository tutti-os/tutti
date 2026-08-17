import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_SESSION_PERMISSION_CAPACITY = 256;
const MAX_CANONICAL_PERMISSION_DEPTH = 32;
const MAX_CANONICAL_PERMISSION_LENGTH = 64 * 1024;

/**
 * Remembers only exact SDK-proposed session permission updates for the life of
 * one SessionRuntime. A fresh Claude Query can then receive the same update
 * again without broadening its scope or writing permission state to disk.
 */
export class SessionPermissionLedger {
  private readonly entries = new Set<string>();
  private readonly capacity: number;

  constructor(capacity = DEFAULT_SESSION_PERMISSION_CAPACITY) {
    this.capacity = capacity;
  }

  remember(suggestions: readonly PermissionUpdate[] | undefined): void {
    if (!isSessionOnlyBatch(suggestions)) {
      return;
    }
    for (const suggestion of suggestions) {
      const key = canonicalPermissionUpdate(suggestion);
      if (key === undefined) {
        continue;
      }
      this.entries.delete(key);
      this.entries.add(key);
      while (this.entries.size > this.capacity) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
  }

  rehydrate(
    suggestions: readonly PermissionUpdate[] | undefined,
  ): PermissionUpdate[] | undefined {
    if (!isSessionOnlyBatch(suggestions)) {
      return undefined;
    }
    const keys = suggestions.map(canonicalPermissionUpdate);
    if (keys.some((key) => key === undefined || !this.entries.has(key))) {
      return undefined;
    }
    for (const key of keys) {
      if (key === undefined) continue;
      this.entries.delete(key);
      this.entries.add(key);
    }
    return suggestions.map(clonePermissionUpdate);
  }
}

function isSessionOnlyBatch(
  suggestions: readonly PermissionUpdate[] | undefined,
): suggestions is readonly PermissionUpdate[] {
  return (
    suggestions !== undefined &&
    suggestions.length > 0 &&
    suggestions.every((suggestion) => suggestion.destination === "session")
  );
}

function clonePermissionUpdate(update: PermissionUpdate): PermissionUpdate {
  return structuredClone(update);
}

function canonicalPermissionUpdate(
  update: PermissionUpdate,
): string | undefined {
  try {
    const canonical = stableStringify(update, new WeakSet(), 0);
    return canonical.length <= MAX_CANONICAL_PERMISSION_LENGTH
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

function stableStringify(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_PERMISSION_DEPTH) {
    throw new Error("permission update exceeds canonical depth");
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("permission update contains a cycle");
    }
    ancestors.add(value);
    try {
      return `[${value
        .map((item) => stableStringify(item, ancestors, depth + 1))
        .join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) {
      throw new Error("permission update contains a cycle");
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    try {
      return `{${Object.keys(record)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${stableStringify(
              record[key],
              ancestors,
              depth + 1,
            )}`,
        )
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  const primitive = JSON.stringify(value);
  if (primitive === undefined) {
    throw new Error("permission update contains a non-JSON value");
  }
  return primitive;
}
