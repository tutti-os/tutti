import { describe, expect, it, vi } from "vitest";
import { prepareGenieTextureCapture } from "./genieTextureCapture.ts";

describe("prepareGenieTextureCapture", () => {
  it("clones document styles with one root computed-style read", () => {
    const previousTheme = document.documentElement.dataset.theme;
    const previousBodyClassName = document.body.className;
    const stylesheet = document.createElement("style");
    stylesheet.textContent = `
      .preview { color: rgb(255, 0, 0); opacity: 0.75; }
      .preview-child { padding: 4px; }
    `;
    const source = document.createElement("section");
    source.className = "preview";
    source.style.setProperty("--preview-accent", "rgb(0, 128, 255)");
    source.innerHTML = `
      <span class="preview-child">Agent preview</span>
      <img src="/avatar.png" alt="" />
    `;
    document.documentElement.dataset.theme = "dark";
    document.body.className = "app-shell";
    document.head.append(stylesheet);
    document.body.append(source);
    const child = source.querySelector<HTMLElement>(".preview-child");
    const image = source.querySelector<HTMLImageElement>("img");
    expect(child).not.toBeNull();
    expect(image).not.toBeNull();
    if (!child || !image) {
      return;
    }
    const getComputedStyle = vi.spyOn(window, "getComputedStyle");

    let childMeasurementCount = 0;
    let imageMeasurementCount = 0;
    source.getBoundingClientRect = () =>
      ({
        height: 720,
        left: 12,
        top: 24,
        width: 960
      }) as DOMRect;
    child.getBoundingClientRect = () => {
      childMeasurementCount += 1;
      return { height: 20, left: 20, top: 30, width: 100 } as DOMRect;
    };
    image.getBoundingClientRect = () => {
      imageMeasurementCount += 1;
      return { height: 40, left: 20, top: 60, width: 40 } as DOMRect;
    };

    try {
      const prepared = prepareGenieTextureCapture(source);
      expect(prepared).not.toBeNull();
      expect(prepared?.rect).toEqual({
        height: 720,
        left: 12,
        top: 24,
        width: 960
      });
      expect(prepared?.clone.dataset.theme).toBe("dark");
      expect(prepared?.clone.querySelector("body")?.className).toBe(
        "app-shell"
      );
      expect(
        prepared?.clone
          .querySelector("style[data-workbench-genie-stylesheet]")
          ?.textContent?.includes(".preview")
      ).toBe(true);
      expect(prepared?.clone.style.getPropertyValue("--preview-accent")).toBe(
        "rgb(0, 128, 255)"
      );
      expect(
        prepared?.clone.querySelector<HTMLElement>(".preview")?.style.opacity
      ).toBe("1");
      expect(prepared?.clone.querySelector(".preview-child")?.textContent).toBe(
        "Agent preview"
      );
      expect(childMeasurementCount).toBe(0);
      expect(imageMeasurementCount).toBe(1);
      expect(getComputedStyle).toHaveBeenCalledTimes(1);
      expect(getComputedStyle).toHaveBeenCalledWith(source);
      expect(prepared?.images).toEqual([
        {
          displayHeight: 40,
          displayWidth: 40,
          url: new URL("/avatar.png", document.baseURI).href
        }
      ]);
    } finally {
      getComputedStyle.mockRestore();
      source.remove();
      stylesheet.remove();
      document.body.className = previousBodyClassName;
      if (previousTheme === undefined) {
        delete document.documentElement.dataset.theme;
      } else {
        document.documentElement.dataset.theme = previousTheme;
      }
    }
  });
});
