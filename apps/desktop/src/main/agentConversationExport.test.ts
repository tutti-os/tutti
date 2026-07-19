import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  saveAgentConversationExport,
  type AgentConversationExportDependencies
} from "./agentConversationExport.ts";

describe("saveAgentConversationExport", () => {
  it("writes markdown to the selected path", async () => {
    const writes: Array<{ path: string; content: string | Uint8Array }> = [];
    const result = await saveAgentConversationExport(
      {
        format: "markdown",
        suggestedFileName: "conversation.md",
        content: "# Conversation\n"
      },
      dependencies({
        selectSavePath: async () => "/tmp/conversation.md",
        writeFile: async (path, content) => {
          writes.push({ path, content });
        }
      })
    );

    assert.deepEqual(result, {
      status: "saved",
      path: "/tmp/conversation.md"
    });
    assert.deepEqual(writes, [
      { path: "/tmp/conversation.md", content: "# Conversation\n" }
    ]);
  });

  it("prints the prepared renderer surface for PDF and treats a closed save dialog as cancellation", async () => {
    let printCount = 0;
    const canceled = await saveAgentConversationExport(
      {
        format: "pdf",
        renderSource: "current-renderer",
        suggestedFileName: "conversation.pdf"
      },
      dependencies({ selectSavePath: async () => null })
    );
    assert.deepEqual(canceled, { status: "canceled" });

    const saved = await saveAgentConversationExport(
      {
        format: "pdf",
        renderSource: "current-renderer",
        suggestedFileName: "conversation.pdf"
      },
      dependencies({
        selectSavePath: async () => "/tmp/conversation.pdf",
        renderPdf: async (...args) => {
          assert.equal(args.length, 0);
          printCount += 1;
          return new Uint8Array([37, 80, 68, 70]);
        }
      })
    );

    assert.equal(printCount, 1);
    assert.deepEqual(saved, {
      status: "saved",
      path: "/tmp/conversation.pdf"
    });
  });
});

function dependencies(
  overrides: Partial<AgentConversationExportDependencies> = {}
): AgentConversationExportDependencies {
  return {
    renderPdf: async () => new Uint8Array(),
    selectSavePath: async () => "/tmp/export",
    writeFile: async () => {},
    ...overrides
  };
}
