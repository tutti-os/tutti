import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAgentExternalPromptEntryResolver } from "./resolveDesktopAgentExternalPromptEntries.ts";

test("external prompt entry resolution references paths and prepares pathless files", () => {
  const files = [
    new File(["report"], "report.pdf"),
    new File([], "assets"),
    new File(["notes"], "notes.txt")
  ];
  const resolve = createDesktopAgentExternalPromptEntryResolver({
    platformApi: {
      resolveDroppedEntries: () => [
        { kind: "file", path: "/Users/local/report.pdf" },
        { kind: "folder", path: "/Users/local/assets" },
        { kind: "file", path: "" }
      ]
    }
  });

  assert.deepEqual(resolve(files), [
    {
      disposition: "reference",
      sourceIndex: 0,
      reference: {
        displayName: "report.pdf",
        hostPath: "/Users/local/report.pdf",
        kind: "file",
        path: "/Users/local/report.pdf"
      }
    },
    {
      disposition: "reference",
      sourceIndex: 1,
      reference: {
        displayName: "assets",
        hostPath: "/Users/local/assets",
        kind: "folder",
        path: "/Users/local/assets"
      }
    },
    { disposition: "prepare", sourceIndex: 2 }
  ]);
});
