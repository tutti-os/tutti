export const browserElementSnapshotFormat = "tutti.browser-element.v1";
export const browserElementSnapshotMaxHtmlChars = 32_000;
export const browserElementSnapshotMaxTextChars = 4_000;

export interface BrowserElementSnapshot {
  format: typeof browserElementSnapshotFormat;
  capturedAt: string;
  page: {
    title: string;
    url: string;
  };
  element: {
    ariaLabel: string | null;
    attributes: Record<string, string>;
    bounds: { height: number; width: number; x: number; y: number };
    classes: string[];
    domPath: string;
    html: string;
    htmlTruncated: boolean;
    id: string | null;
    role: string | null;
    selector: string;
    styles: Record<string, string>;
    tagName: string;
    text: string;
    textTruncated: boolean;
  };
  ancestors: Array<{
    id: string | null;
    role: string | null;
    selector: string;
    tagName: string;
  }>;
  viewport: {
    devicePixelRatio: number;
    height: number;
    scrollX: number;
    scrollY: number;
    width: number;
  };
}

export type BrowserElementSelectionResult =
  | { status: "cancelled" }
  | { snapshot: BrowserElementSnapshot; status: "selected" };

export function normalizeBrowserElementSelectionResult(
  value: unknown
): BrowserElementSelectionResult | null {
  if (!isRecord(value)) return null;
  if (value.status === "cancelled") return { status: "cancelled" };
  if (value.status !== "selected" || !isRecord(value.snapshot)) return null;
  const snapshot = value.snapshot;
  const page = isRecord(snapshot.page) ? snapshot.page : {};
  const element = isRecord(snapshot.element) ? snapshot.element : {};
  const bounds = isRecord(element.bounds) ? element.bounds : {};
  const viewport = isRecord(snapshot.viewport) ? snapshot.viewport : {};
  const normalized: BrowserElementSnapshot = {
    format: browserElementSnapshotFormat,
    capturedAt:
      boundedString(snapshot.capturedAt, 64) || new Date().toISOString(),
    page: {
      title: boundedString(page.title, 500),
      url: sanitizeSnapshotUrl(boundedString(page.url, 4_000))
    },
    element: {
      ariaLabel: nullableBoundedString(element.ariaLabel, 1_000),
      attributes: boundedStringRecord(element.attributes, 40, 200, 2_000),
      bounds: {
        height: finiteNumber(bounds.height),
        width: finiteNumber(bounds.width),
        x: finiteNumber(bounds.x),
        y: finiteNumber(bounds.y)
      },
      classes: boundedStringArray(element.classes, 24, 200),
      domPath:
        boundedString(element.domPath, 4_000) ||
        boundedString(element.selector, 2_000),
      html: boundedString(element.html, browserElementSnapshotMaxHtmlChars),
      htmlTruncated:
        element.htmlTruncated === true ||
        (typeof element.html === "string" &&
          element.html.length > browserElementSnapshotMaxHtmlChars),
      id: nullableBoundedString(element.id, 500),
      role: nullableBoundedString(element.role, 200),
      selector: boundedString(element.selector, 2_000),
      styles: boundedStringRecord(element.styles, 32, 100, 500),
      tagName: boundedString(element.tagName, 100).toLowerCase(),
      text: boundedString(element.text, browserElementSnapshotMaxTextChars),
      textTruncated:
        element.textTruncated === true ||
        (typeof element.text === "string" &&
          element.text.length > browserElementSnapshotMaxTextChars)
    },
    ancestors: Array.isArray(snapshot.ancestors)
      ? snapshot.ancestors.slice(0, 8).flatMap((item) =>
          isRecord(item)
            ? [
                {
                  id: nullableBoundedString(item.id, 500),
                  role: nullableBoundedString(item.role, 200),
                  selector: boundedString(item.selector, 2_000),
                  tagName: boundedString(item.tagName, 100).toLowerCase()
                }
              ]
            : []
        )
      : [],
    viewport: {
      devicePixelRatio: finiteNumber(viewport.devicePixelRatio, 1),
      height: finiteNumber(viewport.height),
      scrollX: finiteNumber(viewport.scrollX),
      scrollY: finiteNumber(viewport.scrollY),
      width: finiteNumber(viewport.width)
    }
  };
  if (!normalized.element.tagName || !normalized.element.domPath) return null;
  return { snapshot: normalized, status: "selected" };
}

export function serializeBrowserElementSnapshot(
  snapshot: BrowserElementSnapshot
): string {
  const { bounds } = snapshot.element;
  return [
    `DOM Path: ${snapshot.element.domPath}`,
    `Position: top=${formatPixel(bounds.y)}, left=${formatPixel(bounds.x)}, width=${formatPixel(bounds.width)}, height=${formatPixel(bounds.height)}`,
    `HTML Element: ${compactHtmlFragment(snapshot.element.html)}`
  ].join("\n");
}

function formatPixel(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${Object.is(rounded, -0) ? 0 : rounded}px`;
}

function compactHtmlFragment(value: string): string {
  return value
    .replace(/\r?\n/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function sanitizeSnapshotUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /(?:token|auth|password|secret|session|cookie|key|signature)/iu.test(
          key
        )
      ) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return boundedString(value, 4_000);
  }
}

function boundedString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

function nullableBoundedString(
  value: unknown,
  maxChars: number
): string | null {
  const normalized = boundedString(value, maxChars).trim();
  return normalized || null;
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number
): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, maxItems)
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, maxChars))
    : [];
}

function boundedStringRecord(
  value: unknown,
  maxItems: number,
  maxKeyChars: number,
  maxValueChars: number
): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxItems)
      .flatMap(([key, item]) =>
        typeof item === "string"
          ? [[key.slice(0, maxKeyChars), item.slice(0, maxValueChars)]]
          : []
      )
  );
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
