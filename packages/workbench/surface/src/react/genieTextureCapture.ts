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

function collectReadableStylesheetText(document: Document): string {
  const rules: string[] = [];
  for (const stylesheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(stylesheet.cssRules)) {
        rules.push(rule.cssText);
      }
    } catch {
      // Browsers do not expose rules from cross-origin stylesheets.
    }
  }
  return rules.join("\n");
}

function collectImageClones(
  element: HTMLElement
): WorkbenchGenieMeaningfulImageClone[] {
  return Array.from(element.querySelectorAll("img")).map((image) => {
    const rect = image.getBoundingClientRect();
    return {
      displayHeight: rect.height,
      displayWidth: rect.width,
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

function preserveVisibleCloneOpacity({
  clone,
  source,
  window
}: {
  clone: HTMLElement;
  source: HTMLElement;
  window: Window;
}): void {
  const sourceElements = [source, ...Array.from(source.querySelectorAll("*"))];
  const cloneElements = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (let index = 0; index < sourceElements.length; index += 1) {
    const sourceElement = sourceElements[index];
    const cloneElement = cloneElements[index];
    if (!sourceElement || !cloneElement || !("style" in cloneElement)) {
      continue;
    }
    const opacity = Number.parseFloat(
      window.getComputedStyle(sourceElement).opacity || "1"
    );
    if (opacity > 0) {
      (cloneElement as HTMLElement | SVGElement).style.opacity = "1";
    }
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
  preserveVisibleCloneOpacity({
    clone: contentClone,
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
