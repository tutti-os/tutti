import assert from "node:assert/strict";
import test from "node:test";
import { presentDesktopWorkspaceFileMentionEntries } from "./desktopWorkspaceFileMentionPresentation.ts";

test("file mentions put current-workspace entries first and preserve source rank within each tier", () => {
  const entries = presentDesktopWorkspaceFileMentionEntries({
    currentWorkspacePath: "/Users/test/project/tutti/apps/desktop",
    entries: [
      {
        displayName: "README.md",
        kind: "file",
        path: "/Users/test/project/other/docs/README.md"
      },
      {
        displayName: "README.md",
        kind: "file",
        path: "/Users/test/project/tutti/packages/gui/README.md"
      },
      {
        displayName: "README.md",
        kind: "file",
        path: "/Users/test/project/tutti/apps/desktop/README.md"
      }
    ],
    projects: [
      project("current", "Tutti", "/Users/test/project/tutti"),
      project("other", "Other", "/Users/test/project/other")
    ],
    searchRoot: "/Users/test"
  });

  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.contextLabel]),
    [
      [
        "/Users/test/project/tutti/packages/gui/README.md",
        "project/tutti/packages/gui · Tutti"
      ],
      [
        "/Users/test/project/tutti/apps/desktop/README.md",
        "project/tutti/apps/desktop · Tutti"
      ],
      ["/Users/test/project/other/docs/README.md", "project/other/docs · Other"]
    ]
  );
});

test("file mention context falls back to the search root workspace", () => {
  const [entry] = presentDesktopWorkspaceFileMentionEntries({
    entries: [
      {
        displayName: "notes.md",
        kind: "file",
        path: "/Users/test/Documents/notes.md"
      }
    ],
    projects: [],
    searchRoot: "/Users/test"
  });

  assert.equal(entry?.contextLabel, "Documents · test");
});

function project(id: string, label: string, path: string) {
  return {
    id,
    label,
    path,
    pinnedAtUnixMs: 0
  };
}
