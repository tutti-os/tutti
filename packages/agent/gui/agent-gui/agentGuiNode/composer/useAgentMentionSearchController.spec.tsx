import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichTextMentionServiceProvider } from "@tutti-os/ui-rich-text/editor";
import { createRichTextMentionService } from "@tutti-os/ui-rich-text/service";
import type { AgentContextMentionProvider } from "../agentContextMentionProvider";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "../agentContextMentionProvider";
import { resetAgentMentionSearchBrowseCacheForTests } from "../AgentMentionSearchController";
import { useAgentMentionSearchController } from "./useAgentMentionSearchController";

describe("useAgentMentionSearchController", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAgentMentionSearchBrowseCacheForTests();
  });

  it("returns @ candidates from the outer mention service without legacy provider props", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        href: "/workspace/README.md",
        label: "README.md"
      }
    ]);
    const provider: AgentContextMentionProvider<{
      href: string;
      label: string;
    }> = {
      id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.file,
      trigger: "@",
      query,
      getItemKey: (item) => item.href,
      getItemLabel: (item) => item.label,
      toInsertResult: (item) => ({
        kind: "markdown-link",
        href: item.href,
        label: item.label
      })
    };
    const service = createRichTextMentionService({ providers: [provider] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RichTextMentionServiceProvider service={service}>
        {children}
      </RichTextMentionServiceProvider>
    );
    const { result, unmount } = renderHook(
      () => useAgentMentionSearchController(null),
      { wrapper }
    );

    act(() => {
      const controller = result.current.mentionControllerRef.current;
      expect(controller).not.toBeNull();
      controller?.setFilter("file");
      controller?.updateQuery({
        workspaceId: "workspace-1",
        currentUserId: "user-1",
        query: ""
      });
    });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledWith({
      abortSignal: expect.anything(),
      context: {
        metadata: {
          currentUserId: "user-1",
          referenceProvenanceFilter: undefined,
          sectionKey: undefined,
          sessionCwd: undefined,
          target: "agent-gui",
          workspaceId: "workspace-1"
        }
      },
      keyword: "",
      maxResults: 30,
      trigger: "@"
    });
    expect(result.current.mentionSearchState).toMatchObject({
      status: "ready",
      mode: "browse",
      query: "",
      groups: expect.arrayContaining([
        expect.objectContaining({
          id: "opened_files",
          items: [
            expect.objectContaining({
              kind: "file",
              name: "README.md",
              path: "/workspace/README.md"
            })
          ]
        })
      ])
    });

    unmount();
    service.dispose();
  });
});
