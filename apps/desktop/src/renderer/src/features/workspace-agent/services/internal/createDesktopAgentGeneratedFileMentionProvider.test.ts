import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import { createDesktopAgentGeneratedFileMentionProvider } from "./createDesktopAgentGeneratedFileMentionProvider.ts";

test("generated file mentions expose project-relative subtitles", async () => {
  const provider = createProvider([
    {
      label: "README.md",
      path: "/Users/local/project/packages/a/README.md"
    },
    {
      label: "README.md",
      path: "/Users/local/project/packages/b/README.md"
    }
  ]);

  const items = await queryProvider(provider, {
    sectionKey: "project:/Users/local/project",
    sessionCwd: "/Users/local/project"
  });

  assert.deepEqual(
    items.map((item) => provider.getItemSubtitle?.(item)),
    ["packages/a/README.md", "packages/b/README.md"]
  );
});

test("generated file mentions hide host paths without a trusted project root", async () => {
  const provider = createProvider([
    { label: "README.md", path: "/Users/private/project/docs/README.md" }
  ]);

  const items = await queryProvider(provider, {
    sectionKey: "conversations"
  });

  assert.deepEqual(
    items.map((item) => provider.getItemSubtitle?.(item)),
    ["README.md"]
  );
  assert.equal(
    items.some((item) =>
      (provider.getItemSubtitle?.(item) ?? "").startsWith("/Users/")
    ),
    false
  );
});

function createProvider(entries: readonly { label: string; path: string }[]) {
  return createDesktopAgentGeneratedFileMentionProvider({
    agentActivityRuntime: {
      async listAgentGeneratedFiles() {
        return {
          entries: [...entries],
          workspaceId: "workspace-1"
        };
      }
    } satisfies Pick<AgentActivityRuntime, "listAgentGeneratedFiles">,
    workspaceId: "workspace-1"
  });
}

async function queryProvider(
  provider: ReturnType<typeof createProvider>,
  metadata: { sectionKey: string; sessionCwd?: string }
) {
  return provider.query({
    context: { metadata },
    keyword: "readme",
    maxResults: 20,
    trigger: "@"
  });
}
