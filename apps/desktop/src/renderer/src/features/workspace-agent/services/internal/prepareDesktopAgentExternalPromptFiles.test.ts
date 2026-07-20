import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import { DESKTOP_AGENT_PROMPT_FILE_MAX_BYTES } from "../../../../../../shared/agentPromptAssets.ts";
import { createDesktopAgentExternalPromptFilePreparer } from "./prepareDesktopAgentExternalPromptFiles.ts";

test("external prompt preparation isolates per-file upload failures", async () => {
  const uploadNames: string[] = [];
  const prepare = createDesktopAgentExternalPromptFilePreparer({
    agentActivityRuntime: {
      async uploadPromptContent(
        input: Parameters<
          NonNullable<AgentActivityRuntime["uploadPromptContent"]>
        >[0]
      ) {
        const file = input.content[0]!;
        uploadNames.push(file.name ?? "");
        if (file.name === "bad.txt") throw new Error("archive failed");
        return {
          content: [{ ...file, path: `/prompt-assets/${file.name}` }]
        };
      }
    } as unknown as AgentActivityRuntime,
    platformApi: {
      resolveDroppedEntries: () => [
        { kind: "file", path: "" },
        { kind: "file", path: "" }
      ]
    },
    workspaceId: "workspace-1"
  });

  const result = await prepare([
    new File(["good"], "good.txt", { type: "text/plain" }),
    new File(["bad"], "bad.txt", { type: "text/plain" })
  ]);

  assert.deepEqual(result, [
    {
      sourceIndex: 0,
      status: "prepared",
      file: {
        mimeType: "text/plain",
        name: "good.txt",
        path: "/prompt-assets/good.txt",
        sizeBytes: 4
      }
    },
    { sourceIndex: 1, status: "error", errorCode: "preparation_failed" }
  ]);
  assert.deepEqual(uploadNames, ["good.txt", "bad.txt"]);
});

test("external prompt preparation rejects path-backed files", async () => {
  let uploadCalled = false;
  const prepare = createDesktopAgentExternalPromptFilePreparer({
    agentActivityRuntime: {
      async uploadPromptContent() {
        uploadCalled = true;
        return { content: [] };
      }
    } as unknown as AgentActivityRuntime,
    platformApi: {
      resolveDroppedEntries: () => [{ kind: "file", path: "/tmp/local.txt" }]
    },
    workspaceId: "workspace-1"
  });

  assert.deepEqual(await prepare([new File(["local"], "local.txt")]), [
    { sourceIndex: 0, status: "error", errorCode: "preparation_failed" }
  ]);
  assert.equal(uploadCalled, false);
});

test("external prompt preparation rejects oversized files before reading", async () => {
  let readCalled = false;
  let uploadCalled = false;
  const oversizedFile = {
    async arrayBuffer() {
      readCalled = true;
      return new ArrayBuffer(0);
    },
    name: "large.bin",
    size: DESKTOP_AGENT_PROMPT_FILE_MAX_BYTES + 1,
    type: "application/octet-stream"
  } as File;
  const prepare = createDesktopAgentExternalPromptFilePreparer({
    agentActivityRuntime: {
      async uploadPromptContent() {
        uploadCalled = true;
        return { content: [] };
      }
    } as unknown as AgentActivityRuntime,
    platformApi: {
      resolveDroppedEntries: () => [{ kind: "file", path: "" }]
    },
    workspaceId: "workspace-1"
  });

  assert.deepEqual(await prepare([oversizedFile]), [
    { sourceIndex: 0, status: "error", errorCode: "file_too_large" }
  ]);
  assert.equal(readCalled, false);
  assert.equal(uploadCalled, false);
});
