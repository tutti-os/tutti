import { describe, expect, it } from "vitest";
import {
  buildWorkspaceFileDropTerminalInput,
  hasWorkspaceFileDropData,
  readWorkspaceFileDropEntries,
  quoteWorkspacePathForTerminal,
  readWorkspaceFileDropPaths,
  writeWorkspaceFileDropData
} from "./workspaceFileDrop";

function createDataTransferStub(): DataTransfer {
  const store = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    types: [] as string[],
    setData(format: string, data: string) {
      store.set(format, data);
      dataTransfer.types = [...store.keys()];
    },
    getData(format: string) {
      return store.get(format) ?? "";
    }
  };
  return dataTransfer as unknown as DataTransfer;
}

describe("workspaceFileDrop", () => {
  it("writes and reads normalized structured workspace file drop payloads", () => {
    const dataTransfer = createDataTransferStub();

    writeWorkspaceFileDropData(dataTransfer, [
      {
        path: "/workspace/src/App.tsx",
        name: "App.tsx",
        kind: "file"
      },
      {
        path: " /workspace/src/App.tsx ",
        name: " App.tsx ",
        kind: "file"
      },
      {
        path: "/workspace/src/README.md",
        name: "README.md",
        kind: "file"
      }
    ]);

    expect(hasWorkspaceFileDropData(dataTransfer)).toBe(true);
    expect(readWorkspaceFileDropEntries(dataTransfer)).toEqual([
      {
        path: "/workspace/src/App.tsx",
        name: "App.tsx",
        kind: "file"
      },
      {
        path: "/workspace/src/README.md",
        name: "README.md",
        kind: "file"
      }
    ]);
    expect(readWorkspaceFileDropPaths(dataTransfer)).toEqual([
      "/workspace/src/App.tsx",
      "/workspace/src/README.md"
    ]);
    expect(dataTransfer.getData("text/plain")).toBe(
      "/workspace/src/App.tsx\n/workspace/src/README.md"
    );
  });

  it("shell-quotes paths for terminal insertion", () => {
    expect(quoteWorkspacePathForTerminal("/workspace/it's here.txt")).toBe(
      "'/workspace/it'\"'\"'s here.txt'"
    );
  });

  it("builds terminal input with quoted paths and a trailing space", () => {
    expect(
      buildWorkspaceFileDropTerminalInput([
        "/workspace/src/App.tsx",
        "/workspace/file with spaces.md"
      ])
    ).toBe("'/workspace/src/App.tsx' '/workspace/file with spaces.md' ");
  });

  it("ignores unrelated drag payloads", () => {
    const dataTransfer = createDataTransferStub();
    dataTransfer.setData("text/plain", "/workspace/src/App.tsx");

    expect(hasWorkspaceFileDropData(dataTransfer)).toBe(false);
    expect(readWorkspaceFileDropEntries(dataTransfer)).toEqual([]);
    expect(readWorkspaceFileDropPaths(dataTransfer)).toEqual([]);
    expect(buildWorkspaceFileDropTerminalInput([])).toBe("");
  });

  it("ignores malformed internal payloads", () => {
    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      "application/x-tsh-workspace-file-paths+json",
      JSON.stringify({
        entries: [{ path: "", name: "README.md", kind: "file" }]
      })
    );

    expect(hasWorkspaceFileDropData(dataTransfer)).toBe(true);
    expect(readWorkspaceFileDropEntries(dataTransfer)).toEqual([]);
    expect(readWorkspaceFileDropPaths(dataTransfer)).toEqual([]);
  });
});
