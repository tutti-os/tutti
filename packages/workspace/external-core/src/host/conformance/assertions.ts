export function assertConformance(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(`tuttiExternal conformance: ${message}`);
  }
}

export function assertConformanceEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  if (!isEqual(actual, expected)) {
    throw new Error(
      `tuttiExternal conformance: ${message}; expected ${format(expected)}, received ${format(actual)}.`
    );
  }
}

function isEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) {
    return true;
  }
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    );
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) => isEqual(value, expected[index]))
    );
  }
  if (!isRecord(actual) || !isRecord(expected)) {
    return false;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    isEqual(actualKeys, expectedKeys) &&
    actualKeys.every((key) => isEqual(actual[key], expected[key]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function format(value: unknown): string {
  if (value instanceof Uint8Array) {
    return `Uint8Array[${[...value].join(",")}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
