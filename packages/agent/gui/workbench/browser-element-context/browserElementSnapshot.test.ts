import { describe, expect, it } from "vitest";
import {
  browserElementSnapshotFormat,
  browserElementSnapshotMaxHtmlChars,
  normalizeBrowserElementSelectionResult,
  serializeBrowserElementSnapshot
} from "./browserElementSnapshot.ts";

describe("browser element snapshots", () => {
  it("bound content and redact secret-looking URL parameters", () => {
    const result = normalizeBrowserElementSelectionResult({
      status: "selected",
      snapshot: {
        capturedAt: "2026-07-15T00:00:00.000Z",
        page: {
          title: "Example",
          url: "https://example.com/page?token=secret&tab=main#private"
        },
        element: {
          attributes: {},
          bounds: { height: 10, width: 20, x: 1, y: 2 },
          classes: ["primary"],
          domPath: "#app > main.page > button.primary",
          html: "x".repeat(browserElementSnapshotMaxHtmlChars + 100),
          selector: "#submit",
          styles: {},
          tagName: "BUTTON",
          text: "Submit"
        },
        viewport: { height: 800, width: 1200 }
      }
    });

    expect(result?.status).toBe("selected");
    if (result?.status !== "selected") return;
    expect(result.snapshot.format).toBe(browserElementSnapshotFormat);
    expect(result.snapshot.element.html.length).toBe(
      browserElementSnapshotMaxHtmlChars
    );
    expect(result.snapshot.element.tagName).toBe("button");
    expect(result.snapshot.page.url).toBe(
      "https://example.com/page?token=%5Bredacted%5D&tab=main"
    );
  });

  it("serialize to Cursor's three-field text format", () => {
    const result = normalizeBrowserElementSelectionResult({
      status: "selected",
      snapshot: {
        page: { title: "Example", url: "https://example.com" },
        element: {
          bounds: { height: 40.125, width: 120.5, x: 8, y: -0 },
          domPath: "#app > div.page-wrapper-n1Pp9 > a.nav-link",
          html: '<a href="https://example.com">\n  Example home\n</a>',
          tagName: "a"
        }
      }
    });

    expect(result?.status).toBe("selected");
    if (result?.status !== "selected") return;
    expect(serializeBrowserElementSnapshot(result.snapshot)).toBe(
      [
        "DOM Path: #app > div.page-wrapper-n1Pp9 > a.nav-link",
        "Position: top=0px, left=8px, width=120.5px, height=40.13px",
        'HTML Element: <a href="https://example.com"> Example home </a>'
      ].join("\n")
    );
  });

  it("reject selected results without identity", () => {
    expect(
      normalizeBrowserElementSelectionResult({
        status: "selected",
        snapshot: { element: {}, page: {}, viewport: {} }
      })
    ).toBeNull();
  });
});
