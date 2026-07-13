export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function envObject(value: unknown): Record<string, string | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string | undefined> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}
