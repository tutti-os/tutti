import {
  isUsableGenieRect,
  viewportRectFromElement,
  type WorkbenchGenieMeaningfulImageClone,
  type WorkbenchGenieViewportRect
} from "./genieAnimation.ts";

export interface PreparedGenieTextureCapture {
  clone: HTMLElement;
  images: WorkbenchGenieMeaningfulImageClone[];
  rect: WorkbenchGenieViewportRect;
}

type GenieCloneMaskImageProperty = "-webkit-mask-image" | "mask-image";

interface GenieCloneMaskImageReference {
  element: HTMLElement;
  property: GenieCloneMaskImageProperty;
}

const genieCloneMaskImageProperties = [
  "-webkit-mask-image",
  "mask-image"
] as const satisfies readonly GenieCloneMaskImageProperty[];

interface ReadableStylesheetFingerprint {
  disabled: boolean;
  ownerText: string | null;
  ruleCount: number;
  stylesheet: CSSStyleSheet;
}

interface CachedReadableStylesheetText {
  fingerprints: ReadableStylesheetFingerprint[];
  text: string;
}

const readableStylesheetTextByDocument = new WeakMap<
  Document,
  CachedReadableStylesheetText
>();

function readSingleCssUrl(value: string): string | null {
  const normalized = value.trim();
  if (!normalized.startsWith("url(") || !normalized.endsWith(")")) {
    return null;
  }
  const inner = normalized.slice(4, -1).trim();
  if (!inner) {
    return null;
  }
  const quote = inner[0];
  if (quote === '"' || quote === "'") {
    return inner.endsWith(quote) ? inner.slice(1, -1) : null;
  }
  return inner.includes('"') || inner.includes("'") ? null : inner;
}

export async function inlineGenieCloneMaskImageResources({
  cloneRoot,
  readResource
}: {
  cloneRoot: HTMLElement;
  readResource: (url: string) => Promise<string | null>;
}): Promise<void> {
  const referencesByUrl = new Map<string, GenieCloneMaskImageReference[]>();
  const elements = [
    cloneRoot,
    ...Array.from(cloneRoot.querySelectorAll<HTMLElement>("[style]"))
  ];

  for (const element of elements) {
    for (const property of genieCloneMaskImageProperties) {
      const url = readSingleCssUrl(element.style.getPropertyValue(property));
      if (!url) {
        continue;
      }
      const references = referencesByUrl.get(url) ?? [];
      references.push({ element, property });
      referencesByUrl.set(url, references);
    }
  }

  await Promise.all(
    Array.from(referencesByUrl.entries(), async ([url, references], index) => {
      const inlineUrl = await readResource(url);
      if (!inlineUrl) {
        return;
      }
      const variableName = `--workbench-genie-capture-mask-${index}`;
      cloneRoot.style.setProperty(
        variableName,
        `url(${JSON.stringify(inlineUrl)})`
      );
      for (const { element, property } of references) {
        element.style.setProperty(property, `var(${variableName})`);
      }
    })
  );
}

function hasSameStylesheetFingerprints(
  left: ReadableStylesheetFingerprint[],
  right: ReadableStylesheetFingerprint[]
): boolean {
  return (
    left.length === right.length &&
    left.every((fingerprint, index) => {
      const candidate = right[index];
      return (
        candidate?.stylesheet === fingerprint.stylesheet &&
        candidate.disabled === fingerprint.disabled &&
        candidate.ruleCount === fingerprint.ruleCount &&
        candidate.ownerText === fingerprint.ownerText
      );
    })
  );
}

function collectReadableStylesheetText(document: Document): string {
  const readableStylesheets: {
    fingerprint: ReadableStylesheetFingerprint;
    rules: CSSRuleList;
  }[] = [];
  for (const stylesheet of Array.from(document.styleSheets)) {
    try {
      const rules = stylesheet.cssRules;
      readableStylesheets.push({
        fingerprint: {
          disabled: stylesheet.disabled,
          ownerText:
            stylesheet.ownerNode instanceof HTMLStyleElement
              ? stylesheet.ownerNode.textContent
              : null,
          ruleCount: rules.length,
          stylesheet
        },
        rules
      });
    } catch {
      // Browsers do not expose rules from cross-origin stylesheets.
    }
  }

  const fingerprints = readableStylesheets.map(
    ({ fingerprint }) => fingerprint
  );
  const cached = readableStylesheetTextByDocument.get(document);
  if (
    cached &&
    hasSameStylesheetFingerprints(cached.fingerprints, fingerprints)
  ) {
    return cached.text;
  }

  const text = readableStylesheets
    .flatMap(({ rules }) => Array.from(rules, (rule) => rule.cssText))
    .join("\n");
  readableStylesheetTextByDocument.set(document, { fingerprints, text });
  return text;
}

function collectImageClones(
  element: HTMLElement
): WorkbenchGenieMeaningfulImageClone[] {
  return Array.from(element.querySelectorAll("img")).map((image) => {
    const rect = image.getBoundingClientRect();
    return {
      displayHeight: rect.height,
      displayWidth: rect.width,
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth,
      url: image.currentSrc || image.src || image.getAttribute("src") || null
    };
  });
}

function copyResolvedThemeVariables({
  clone,
  source,
  window
}: {
  clone: HTMLElement;
  source: HTMLElement;
  window: Window;
}): void {
  const sourceStyle = window.getComputedStyle(source);
  for (let index = 0; index < sourceStyle.length; index += 1) {
    const propertyName = sourceStyle.item(index);
    if (!propertyName.startsWith("--")) {
      continue;
    }
    clone.style.setProperty(
      propertyName,
      sourceStyle.getPropertyValue(propertyName),
      sourceStyle.getPropertyPriority(propertyName)
    );
  }
}

export function prepareGenieTextureCapture(
  element: HTMLElement
): PreparedGenieTextureCapture | null {
  const rect = viewportRectFromElement(element);
  const document = element.ownerDocument;
  const window = document.defaultView;
  if (!window || !isUsableGenieRect(rect)) {
    return null;
  }

  const contentClone = element.cloneNode(true) as HTMLElement;
  const documentClone = document.documentElement.cloneNode(
    false
  ) as HTMLElement;
  const headClone = document.head.cloneNode(false) as HTMLHeadElement;
  const bodyClone = document.body.cloneNode(false) as HTMLBodyElement;
  const stylesheet = document.createElement("style");
  stylesheet.dataset.workbenchGenieStylesheet = "true";
  stylesheet.textContent = `${collectReadableStylesheetText(document)}
*, *::before, *::after {
  animation: none !important;
  caret-color: transparent !important;
  transition: none !important;
}`;

  headClone.append(stylesheet);
  bodyClone.append(contentClone);
  documentClone.append(headClone, bodyClone);
  copyResolvedThemeVariables({
    clone: documentClone,
    source: element,
    window
  });

  documentClone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  documentClone.style.position = "relative";
  documentClone.style.left = "0";
  documentClone.style.top = "0";
  documentClone.style.width = `${rect.width}px`;
  documentClone.style.height = `${rect.height}px`;
  documentClone.style.transform = "none";
  documentClone.style.opacity = "1";
  documentClone.style.visibility = "visible";
  documentClone.style.pointerEvents = "none";

  bodyClone.style.position = "relative";
  bodyClone.style.inset = "0";
  bodyClone.style.margin = "0";
  bodyClone.style.width = `${rect.width}px`;
  bodyClone.style.height = `${rect.height}px`;
  bodyClone.style.overflow = "hidden";

  contentClone.style.position = "relative";
  contentClone.style.left = "0";
  contentClone.style.top = "0";
  contentClone.style.width = `${rect.width}px`;
  contentClone.style.height = `${rect.height}px`;
  contentClone.style.transform = "none";
  contentClone.style.opacity = "1";
  contentClone.style.visibility = "visible";
  contentClone.style.pointerEvents = "none";
  contentClone.style.zIndex = "auto";

  return {
    clone: documentClone,
    images: collectImageClones(element),
    rect
  };
}
