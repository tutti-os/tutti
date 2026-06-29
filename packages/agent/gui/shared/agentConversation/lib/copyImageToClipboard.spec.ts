import { afterEach, describe, expect, it, vi } from "vitest";

import { copyImageToClipboard } from "./copyImageToClipboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("copyImageToClipboard", () => {
  it("returns false when navigator.clipboard.write is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyImageToClipboard("data:image/png;base64,xxx")).toBe(false);
  });

  it("writes a png blob straight through", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const pngBlob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        items: Record<string, Blob>;
        constructor(items: Record<string, Blob>) {
          this.items = items;
        }
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(pngBlob) })
    );

    expect(await copyImageToClipboard("blob:abc")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("prefers the host image clipboard when available", async () => {
    const writeImage = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn().mockResolvedValue(undefined);
    const pngBlob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(pngBlob) })
    );

    expect(await copyImageToClipboard("blob:abc", { writeImage })).toBe(true);
    expect(writeImage).toHaveBeenCalledWith({
      data: "cG5n",
      mimeType: "image/png"
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("falls back to web clipboard when the host write fails", async () => {
    const writeImage = vi.fn().mockRejectedValue(new Error("native denied"));
    const write = vi.fn().mockResolvedValue(undefined);
    const pngBlob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(_: unknown) {}
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(pngBlob) })
    );

    expect(await copyImageToClipboard("blob:abc", { writeImage })).toBe(true);
    expect(writeImage).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("returns false when clipboard write throws", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    const pngBlob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(_: unknown) {}
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(pngBlob) })
    );
    expect(await copyImageToClipboard("blob:abc")).toBe(false);
  });
});
