function runTuttiBrowserElementSelector(): Promise<unknown> {
  type SelectorGlobal = typeof globalThis & {
    __tuttiBrowserElementSelector?: { cancel(): void };
  };
  const selectorGlobal = globalThis as SelectorGlobal;
  selectorGlobal.__tuttiBrowserElementSelector?.cancel();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-tutti-browser-element-highlight", "true");
    Object.assign(overlay.style, {
      background: "rgba(86, 156, 214, 0.12)",
      border: "2px solid rgb(86, 156, 214)",
      borderRadius: "3px",
      boxSizing: "border-box",
      display: "none",
      left: "0",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      zIndex: "2147483647"
    });
    document.documentElement.append(overlay);
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";

    const finish = (value: unknown): void => {
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.documentElement.style.cursor = previousCursor;
      overlay.remove();
      delete selectorGlobal.__tuttiBrowserElementSelector;
      resolve(value);
    };
    const cancel = (): void => finish({ status: "cancelled" });
    selectorGlobal.__tuttiBrowserElementSelector = { cancel };

    function handleMouseMove(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || target === overlay) return;
      const rect = target.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: "block",
        height: `${Math.max(0, rect.height)}px`,
        transform: `translate(${rect.left}px, ${rect.top}px)`,
        width: `${Math.max(0, rect.width)}px`
      });
    }

    function handleClick(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || target === overlay) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish({ snapshot: captureSnapshot(target), status: "selected" });
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    }

    function captureSnapshot(target: Element): Record<string, unknown> {
      const rect = target.getBoundingClientRect();
      const rawText = isFormControl(target)
        ? ""
        : (target.textContent ?? "").replace(/\s+/gu, " ").trim();
      const clone = target.cloneNode(true) as Element;
      clone
        .querySelectorAll("script,style,noscript,template")
        .forEach((item) => item.remove());
      sanitizeElement(clone);
      clone.querySelectorAll("*").forEach(sanitizeElement);
      const rawHtml = clone.outerHTML;
      const computed = getComputedStyle(target);
      const styleNames = [
        "display",
        "position",
        "color",
        "background-color",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "margin",
        "padding",
        "border",
        "border-radius",
        "width",
        "height",
        "flex",
        "grid-template-columns",
        "align-items",
        "justify-content",
        "overflow",
        "opacity",
        "visibility"
      ];
      return {
        format: "tutti.browser-element.v1",
        capturedAt: new Date().toISOString(),
        page: {
          title: document.title,
          url: sanitizeUrl(location.href)
        },
        element: {
          ariaLabel: target.getAttribute("aria-label"),
          attributes: readAttributes(target),
          bounds: {
            height: rect.height,
            width: rect.width,
            x: rect.x,
            y: rect.y
          },
          classes: [...target.classList].slice(0, 24),
          domPath: domPathFor(target),
          html: rawHtml.slice(0, 32_000),
          htmlTruncated: rawHtml.length > 32_000,
          id: target.id || null,
          role: target.getAttribute("role"),
          selector: selectorFor(target),
          styles: Object.fromEntries(
            styleNames.map((name) => [name, computed.getPropertyValue(name)])
          ),
          tagName: target.tagName.toLowerCase(),
          text: rawText.slice(0, 4_000),
          textTruncated: rawText.length > 4_000
        },
        ancestors: readAncestors(target),
        viewport: {
          devicePixelRatio: globalThis.devicePixelRatio,
          height: globalThis.innerHeight,
          scrollX: globalThis.scrollX,
          scrollY: globalThis.scrollY,
          width: globalThis.innerWidth
        }
      };
    }

    function sanitizeElement(element: Element): void {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLOptionElement
      ) {
        element.removeAttribute("value");
        if ("value" in element) element.value = "";
        if (element instanceof HTMLTextAreaElement) element.textContent = "";
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (
          name.startsWith("on") ||
          name === "nonce" ||
          name === "integrity" ||
          name === "srcdoc" ||
          /(?:token|auth|password|secret|session|cookie|api[-_]?key)/iu.test(
            name
          )
        ) {
          element.setAttribute(attribute.name, "[redacted]");
          continue;
        }
        if (name === "href" || name === "src" || name === "action") {
          element.setAttribute(attribute.name, sanitizeUrl(attribute.value));
        }
      }
    }

    function isFormControl(element: Element): boolean {
      return (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      );
    }

    function readAttributes(element: Element): Record<string, string> {
      const result: Record<string, string> = {};
      for (const attribute of [...element.attributes].slice(0, 40)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || name === "value" || name === "srcdoc") {
          continue;
        }
        result[attribute.name] =
          /(?:token|auth|password|secret|session|cookie|api[-_]?key)/iu.test(
            name
          )
            ? "[redacted]"
            : name === "href" || name === "src" || name === "action"
              ? sanitizeUrl(attribute.value)
              : attribute.value.slice(0, 2_000);
      }
      return result;
    }

    function sanitizeUrl(value: string): string {
      try {
        const url = new URL(value, location.href);
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
        return value.slice(0, 4_000);
      }
    }

    function selectorFor(element: Element): string {
      if (element.id) return `#${escapeCss(element.id)}`;
      const segments: string[] = [];
      let current: Element | null = element;
      while (current && segments.length < 8) {
        let segment = current.tagName.toLowerCase();
        const parentElement: Element | null = current.parentElement;
        if (parentElement) {
          const currentTagName = current.tagName;
          const siblings = [...parentElement.children].filter(
            (item) => item.tagName === currentTagName
          );
          if (siblings.length > 1) {
            segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          }
        }
        segments.unshift(segment);
        current = parentElement;
      }
      return segments.join(" > ");
    }

    function domPathFor(element: Element): string {
      const appRoot = document.querySelector("#app");
      const root =
        appRoot?.contains(element) === true
          ? appRoot
          : (document.body ?? document.documentElement);
      const segments: string[] = [];
      let current: Element | null = element;
      while (current) {
        segments.unshift(domPathSegment(current, current === root));
        if (current === root) break;
        current = current.parentElement;
      }
      return segments.join(" > ").slice(0, 4_000);
    }

    function domPathSegment(element: Element, isRoot: boolean): string {
      if (isRoot && element.id === "app") return "#app";
      const tagName = element.tagName.toLowerCase();
      const classNames = [...element.classList]
        .filter(Boolean)
        .slice(0, 6)
        .map((name) => `.${name}`)
        .join("");
      if (classNames) return `${tagName}${classNames}`;
      if (element.id) return `${tagName}#${element.id}`;
      return tagName;
    }

    function escapeCss(value: string): string {
      return globalThis.CSS?.escape
        ? globalThis.CSS.escape(value)
        : value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
    }

    function readAncestors(element: Element): Array<Record<string, unknown>> {
      const result: Array<Record<string, unknown>> = [];
      let current = element.parentElement;
      while (current && result.length < 8) {
        result.push({
          id: current.id || null,
          role: current.getAttribute("role"),
          selector: selectorFor(current),
          tagName: current.tagName.toLowerCase()
        });
        current = current.parentElement;
      }
      return result;
    }

    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
  });
}

export const browserElementSelectorScript = `(${runTuttiBrowserElementSelector.toString()})()`;
export const cancelBrowserElementSelectorScript =
  "globalThis.__tuttiBrowserElementSelector?.cancel();";
