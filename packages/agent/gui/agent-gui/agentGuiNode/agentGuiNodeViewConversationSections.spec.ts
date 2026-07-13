import { describe, expect, it } from "vitest";
import type { AgentGUIConversationSummary } from "./model/agentGuiConversationModel";
import type { ConversationSection } from "./agentGuiNodeViewConversation";
import { updateConversationSectionsFromSummaries } from "./AgentGUINodeView";

function conversation(
  id: string,
  updatedAtUnixMs: number,
  overrides: Partial<AgentGUIConversationSummary> = {}
): AgentGUIConversationSummary {
  return {
    id,
    provider: "codex",
    title: id,
    status: "ready",
    cwd: "/workspace",
    updatedAtUnixMs,
    ...overrides
  };
}

function project(
  path: string,
  label: string,
  overrides: Partial<NonNullable<AgentGUIConversationSummary["project"]>> = {}
) {
  return {
    id: path,
    path,
    label,
    sectionKey: `project:${path}`,
    ...overrides
  };
}

describe("updateConversationSectionsFromSummaries", () => {
  const sectionConversationsLabel = "Chats";

  it("inserts a brand-new, no-project conversation into the existing empty conversations section", () => {
    // Mirrors the optimistic-first-message flow: the sidebar's runtime
    // sections are fetched once (before the new conversation existed on the
    // backend), producing an empty "conversations" bucket. The conversation
    // then appears in the client-side conversations list without the
    // section id ever having changed, so this reconciliation pass is the
    // only thing that can surface it in the sidebar.
    const previous: ConversationSection[] = [
      {
        id: "conversations",
        kind: "conversations",
        label: sectionConversationsLabel,
        project: null,
        items: []
      }
    ];
    const newConversation = conversation("new-convo", 1000);

    const result = updateConversationSectionsFromSummaries(
      previous,
      [newConversation],
      { sectionConversationsLabel }
    );

    expect(result?.[0]?.items.map((item) => item.id)).toEqual(["new-convo"]);
  });

  it("creates the conversations section from scratch when the runtime fetch returned no sections at all", () => {
    const previous: ConversationSection[] = [];
    const newConversation = conversation("first-convo", 1000);

    const result = updateConversationSectionsFromSummaries(
      previous,
      [newConversation],
      { sectionConversationsLabel }
    );

    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      id: "conversations",
      kind: "conversations",
      label: sectionConversationsLabel
    });
    expect(result?.[0]?.items.map((item) => item.id)).toEqual(["first-convo"]);
  });

  it("does not insert a brand-new project conversation from local project resolution", () => {
    const appProject = project("/workspace/app", "App");
    const previous: ConversationSection[] = [
      {
        id: "project:/workspace/app",
        kind: "project",
        label: "App",
        project: appProject,
        items: []
      }
    ];
    const newConversation = conversation("new-project-convo", 1000, {
      project: appProject
    });

    const result = updateConversationSectionsFromSummaries(
      previous,
      [newConversation],
      { sectionConversationsLabel }
    );

    expect(result).toBe(previous);
  });

  it("still patches fields of conversations that already exist in a section", () => {
    const existing = conversation("existing", 1000, { status: "ready" });
    const previous: ConversationSection[] = [
      {
        id: "conversations",
        kind: "conversations",
        label: sectionConversationsLabel,
        project: null,
        items: [existing]
      }
    ];
    const updated = conversation("existing", 2000, { status: "working" });

    const result = updateConversationSectionsFromSummaries(
      previous,
      [updated],
      { sectionConversationsLabel }
    );

    expect(result?.[0]?.items).toEqual([updated]);
  });

  it("does not duplicate an item that is already present", () => {
    const existing = conversation("existing", 1000);
    const previous: ConversationSection[] = [
      {
        id: "conversations",
        kind: "conversations",
        label: sectionConversationsLabel,
        project: null,
        items: [existing]
      }
    ];

    const result = updateConversationSectionsFromSummaries(
      previous,
      [existing],
      { sectionConversationsLabel }
    );

    expect(result?.[0]?.items).toHaveLength(1);
  });

  it("keeps an existing item in its persisted section when local project resolution changes", () => {
    const appProject = project("/workspace/app", "App");
    const staleConversation = conversation("moving-convo", 1000);
    const resolvedConversation = conversation("moving-convo", 2000, {
      project: appProject
    });
    const previous: ConversationSection[] = [
      {
        id: "project:/workspace/app",
        kind: "project",
        label: "App",
        project: appProject,
        items: []
      },
      {
        id: "conversations",
        kind: "conversations",
        label: sectionConversationsLabel,
        project: null,
        items: [staleConversation]
      }
    ];

    const result = updateConversationSectionsFromSummaries(
      previous,
      [resolvedConversation],
      { sectionConversationsLabel }
    );

    expect(result?.[0]?.items).toEqual([]);
    expect(result?.[1]?.items).toEqual([
      {
        ...resolvedConversation,
        project: null
      }
    ]);
  });

  it("returns the same reference when there is nothing new and nothing changed", () => {
    const existing = conversation("existing", 1000);
    const previous: ConversationSection[] = [
      {
        id: "conversations",
        kind: "conversations",
        label: sectionConversationsLabel,
        project: null,
        items: [existing]
      }
    ];

    const result = updateConversationSectionsFromSummaries(
      previous,
      [existing],
      { sectionConversationsLabel }
    );

    expect(result).toBe(previous);
  });

  it("does not insert a pinned conversation that has no matching section (pinned sections are built elsewhere)", () => {
    const previous: ConversationSection[] = [];
    const pinnedConversation = conversation("pinned-convo", 1000, {
      pinnedAtUnixMs: 500
    });

    const result = updateConversationSectionsFromSummaries(
      previous,
      [pinnedConversation],
      { sectionConversationsLabel }
    );

    expect(result).toEqual([]);
  });

  it("creates a pinned section from summaries when the caller supplies a pinned label", () => {
    const previous: ConversationSection[] = [
      {
        id: "conversations",
        kind: "conversations",
        label: sectionConversationsLabel,
        project: null,
        items: []
      }
    ];
    const pinnedConversation = conversation("pinned-convo", 1000, {
      pinnedAtUnixMs: 500
    });

    const result = updateConversationSectionsFromSummaries(
      previous,
      [pinnedConversation],
      {
        sectionConversationsLabel,
        sectionPinnedLabel: "Pinned"
      }
    );

    expect(result?.[0]).toMatchObject({
      id: "pinned",
      kind: "pinned",
      label: "Pinned"
    });
    expect(result?.[0]?.items.map((item) => item.id)).toEqual(["pinned-convo"]);
  });

  it("keeps and patches conversations already present in the pinned section", () => {
    const previousPinned = conversation("pinned-convo", 1000, {
      pinnedAtUnixMs: 500,
      status: "ready"
    });
    const previous: ConversationSection[] = [
      {
        id: "pinned",
        kind: "pinned",
        label: "Pinned",
        project: null,
        items: [previousPinned]
      }
    ];
    const updatedPinned = conversation("pinned-convo", 2000, {
      pinnedAtUnixMs: 600,
      status: "working"
    });

    const result = updateConversationSectionsFromSummaries(
      previous,
      [updatedPinned],
      { sectionConversationsLabel }
    );

    expect(result?.[0]?.items).toEqual([updatedPinned]);
  });

  it("removes a pinned section item when summaries report it as unpinned", () => {
    const previousPinned = conversation("pinned-convo", 1000, {
      pinnedAtUnixMs: 500
    });
    const previous: ConversationSection[] = [
      {
        id: "pinned",
        kind: "pinned",
        label: "Pinned",
        project: null,
        items: [previousPinned]
      }
    ];
    const unpinned = conversation("pinned-convo", 2000, {
      pinnedAtUnixMs: null
    });

    const result = updateConversationSectionsFromSummaries(
      previous,
      [unpinned],
      { sectionConversationsLabel }
    );

    expect(result?.[0]?.items).toEqual([]);
  });
});
