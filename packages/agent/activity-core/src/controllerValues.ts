export function cloneJSONRecord<T extends Record<string, unknown> | undefined>(
  value: T
): T {
  if (value === undefined) return value;
  return cloneJSONValue(value) as T;
}

export function cloneJSONValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJSONValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        cloneJSONValue(entry)
      ])
    );
  }
  return value;
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function nullableStringValue(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function messageVersionValue(source: Record<string, unknown>): number {
  return numberValue(source.version) ?? numberValue(source.seq) ?? 0;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
