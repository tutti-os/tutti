import assert from "node:assert/strict";
import test from "node:test";
import { tuttiFolderAssetUrls } from "../../../../../../shared/tuttiAssetProtocol.ts";
import { createDesktopAgentGeneratedFileMentionProvider } from "./createDesktopAgentGeneratedFileMentionProvider.ts";

test("generated-file mention provider recognizes native Windows folders", async () => {
  const provider = createDesktopAgentGeneratedFileMentionProvider({
    agentActivityRuntime: {},
    workspaceId: "workspace-1"
  });

  assert.equal(
    await provider.getItemIconUrl?.({
      displayName: "generated",
      path: "C:\\Users\\demo\\workspace\\generated\\"
    }),
    tuttiFolderAssetUrls.default
  );
});
