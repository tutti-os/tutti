import { describe, expect, it } from "vitest";
import type { AgentGUIConversationSummary } from "./agentGuiConversationModel";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import {
  insertConversationRailSectionOverlay,
  conversationSummariesRenderEqual,
  isConversationRailInitialLoadPending,
  projectConversationRailSectionsWithActiveConversation,
  planRuntimeRailMembershipRefresh,
  projectRuntimeSectionsToConversationRailMemberships,
  projectConversationRailSectionsWithTransientConversations,
  resolveConversationRailActiveConversation
} from "./agentGuiConversationRail";
import type { ConversationRailSectionMembership } from "./agentGuiConversationRail";

function conversation(
  id: string,
  pinnedAtUnixMs: number | null = null
): AgentGUIConversationSummary {
  return {
    cwd: "/workspace",
    id,
    pinnedAtUnixMs,
    provider: "codex",
    status: "ready",
    title: id,
    updatedAtUnixMs: 1
  };
}

function section(
  items: readonly AgentGUIConversationSummary[]
): ConversationSection[] {
  return [
    {
      id: "project:/workspace",
      items: [...items],
      kind: "project",
      label: "Workspace",
      project: {
        id: "workspace",
        label: "Workspace",
        path: "/workspace",
        sectionKey: "project:/workspace"
      }
    }
  ];
}

describe("isConversationRailInitialLoadPending", () => {
  it("blocks only while the first runtime membership page is unresolved", () => {
    expect(
      isConversationRailInitialLoadPending({
        pending: true,
        runtimeSectionsEnabled: true,
        sections: null
      })
    ).toBe(true);
    expect(
      isConversationRailInitialLoadPending({
        pending: true,
        runtimeSectionsEnabled: true,
        sections: []
      })
    ).toBe(false);
    expect(
      isConversationRailInitialLoadPending({
        pending: false,
        runtimeSectionsEnabled: true,
        sections: null
      })
    ).toBe(false);
  });
});

function membership(
  items: readonly AgentGUIConversationSummary[]
): ConversationRailSectionMembership[] {
  return [
    {
      id: "project:/workspace",
      kind: "project",
      project: section([])[0]?.project ?? null,
      sessionIds: items.map((item) => item.id)
    }
  ];
}

describe("planRuntimeRailMembershipRefresh", () => {
  it("re-renders a row when its leading mention kind becomes available", () => {
    const plain = conversation("session-1");

    expect(
      conversationSummariesRenderEqual(plain, {
        ...plain,
        titleLeadingMentionKind: "task"
      })
    ).toBe(false);
  });

  it("treats hydration of an already-loaded historical row as entity detail", () => {
    const recent = conversation("recent");
    const historical = conversation("historical");

    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([recent, historical]),
        next: [recent, historical],
        previous: [recent]
      })
    ).toEqual({ kind: "none" });
  });

  it("ignores summary ordering changes", () => {
    const first = conversation("first");
    const second = conversation("second");

    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([first, second]),
        next: [second, first],
        previous: [first, second]
      })
    ).toEqual({ kind: "none" });
  });

  it("refreshes for a newly discovered session outside loaded pages", () => {
    const recent = conversation("recent");

    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([recent]),
        next: [conversation("brand-new"), recent],
        previous: [recent]
      })
    ).toEqual({ kind: "refresh_first_pages", reconcilingSessionIds: [] });
  });

  it("refreshes for removal and pin membership changes", () => {
    const first = conversation("first");
    const second = conversation("second");

    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([first, second]),
        next: [first],
        previous: [first, second]
      })
    ).toEqual({ kind: "refresh_first_pages", reconcilingSessionIds: [] });
    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([first]),
        next: [conversation("first", 100)],
        previous: [first]
      })
    ).toEqual({ kind: "refresh_first_pages", reconcilingSessionIds: [] });
  });

  it("ignores pending activation add and removal", () => {
    const recent = conversation("recent");
    const pending = {
      ...conversation("pending"),
      projectionSource: "pending_activation" as const
    };

    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([recent]),
        next: [pending, recent],
        previous: [recent]
      })
    ).toEqual({ kind: "none" });
    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([recent]),
        next: [recent],
        previous: [pending, recent]
      })
    ).toEqual({ kind: "none" });
  });

  it("does not treat selected detail hydration as rail membership", () => {
    const recent = conversation("recent");

    expect(
      planRuntimeRailMembershipRefresh({
        activeConversationId: "selected-historical",
        loadedSections: membership([recent]),
        next: [conversation("selected-historical"), recent],
        previous: [recent]
      })
    ).toEqual({ kind: "none" });
  });

  it("refreshes and preserves display membership when pending activation becomes canonical", () => {
    const recent = conversation("recent");
    const pending = {
      ...conversation("new-session"),
      projectionSource: "pending_activation" as const
    };

    expect(
      planRuntimeRailMembershipRefresh({
        activeConversationId: "new-session",
        loadedSections: membership([recent]),
        next: [conversation("new-session"), recent],
        previous: [pending, recent]
      })
    ).toEqual({
      kind: "refresh_first_pages",
      reconcilingSessionIds: ["new-session"]
    });
  });
});

describe("projectRuntimeSectionsToConversationRailMemberships", () => {
  it("preserves the daemon-owned project section key", () => {
    const memberships = projectRuntimeSectionsToConversationRailMemberships({
      sections: [
        {
          hasMore: false,
          kind: "project",
          sectionKey: "project:authoritative",
          sessions: [],
          totalCount: 0,
          userProject: {
            createdAtUnixMs: 1,
            id: "project-1",
            label: "Workspace",
            path: "/workspace",
            sectionKey: "project:authoritative",
            updatedAtUnixMs: 2
          }
        }
      ]
    });

    expect(memberships[0]?.project?.sectionKey).toBe("project:authoritative");
  });
});

describe("projectConversationRailSectionsWithTransientConversations", () => {
  const labels = {
    sectionConversations: "Conversations",
    sectionPinned: "Pinned"
  };

  it("overlays every pending row newest-first without mutating canonical sections", () => {
    const canonical = section([conversation("canonical")]);
    const project = canonical[0]?.project ?? null;
    const first = {
      ...conversation("session-1"),
      project,
      projectionSource: "pending_activation" as const,
      sortTimeUnixMs: 10,
      updatedAtUnixMs: 10
    };
    const second = {
      ...conversation("session-2"),
      project,
      projectionSource: "pending_activation" as const,
      sortTimeUnixMs: 20,
      updatedAtUnixMs: 20
    };

    const projected = projectConversationRailSectionsWithTransientConversations(
      {
        conversations: [second, first],
        labels,
        reconcilingSessionIds: [],
        sections: canonical
      }
    );

    expect(projected[0]?.items.map((item) => item.id)).toEqual([
      "session-2",
      "session-1",
      "canonical"
    ]);
    expect(canonical[0]?.items.map((item) => item.id)).toEqual(["canonical"]);
  });

  it("keeps a canonicalized pending row visible until daemon membership reconciles", () => {
    const canonical = section([conversation("older")]);
    const project = canonical[0]?.project ?? null;
    const confirmed = {
      ...conversation("session-1"),
      project,
      sortTimeUnixMs: 20,
      updatedAtUnixMs: 20
    };
    const nextPending = {
      ...conversation("session-2"),
      project,
      projectionSource: "pending_activation" as const,
      sortTimeUnixMs: 30,
      updatedAtUnixMs: 30
    };

    const projected = projectConversationRailSectionsWithTransientConversations(
      {
        conversations: [nextPending, confirmed],
        labels,
        reconcilingSessionIds: [confirmed.id],
        sections: canonical
      }
    );

    expect(projected[0]?.items.map((item) => item.id)).toEqual([
      "session-2",
      "session-1",
      "older"
    ]);
  });
});

describe("insertConversationRailSectionOverlay", () => {
  it("inserts an active overlay without reordering server rows", () => {
    expect(
      insertConversationRailSectionOverlay(
        "project",
        [
          { ...conversation("server-first"), updatedAtUnixMs: 10 },
          { ...conversation("server-second"), updatedAtUnixMs: 30 }
        ],
        { ...conversation("new-active"), updatedAtUnixMs: 20 }
      ).map((item) => item.id)
    ).toEqual(["new-active", "server-first", "server-second"]);
  });
});

describe("projectConversationRailSectionsWithActiveConversation", () => {
  const labels = {
    sectionConversations: "Conversations",
    sectionPinned: "Pinned"
  };

  it("keeps canonical sections unchanged when the active row is loaded", () => {
    const active = conversation("active");
    const sections = section([active]);

    const projected = projectConversationRailSectionsWithActiveConversation({
      activeConversation: active,
      labels,
      sections
    });

    expect(projected.sections).toBe(sections);
    expect(projected.activeOverlay).toEqual({
      conversation: {
        ...active,
        project: sections[0]?.project
      },
      sectionId: "project:/workspace"
    });
  });

  it("reuses the active row when its project is render-equal to the section project", () => {
    const active = {
      ...conversation("active"),
      project: {
        id: "workspace",
        label: "Workspace",
        path: "/workspace",
        sectionKey: "project:/workspace"
      }
    };

    const projected = projectConversationRailSectionsWithActiveConversation({
      activeConversation: active,
      labels,
      sections: section([active])
    });

    expect(projected.activeOverlay?.conversation).toBe(active);
  });

  it("overlays only the missing active row into its matching server section", () => {
    const active = {
      ...conversation("active"),
      project: {
        id: "workspace",
        label: "Workspace",
        path: "/workspace",
        sectionKey: "project:/workspace"
      }
    };
    const sections = section([conversation("recent")]);

    const projected = projectConversationRailSectionsWithActiveConversation({
      activeConversation: active,
      labels,
      sections
    });

    expect(projected.sections).toBe(sections);
    expect(projected.activeOverlay?.conversation.id).toBe("active");
    expect(projected.activeOverlay?.sectionId).toBe("project:/workspace");
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["recent"]);
  });

  it("creates a transient project section when the server page omits it", () => {
    const active = {
      ...conversation("active"),
      project: {
        id: "other",
        label: "Other",
        path: "/other",
        sectionKey: "project:/other"
      }
    };

    const projected = projectConversationRailSectionsWithActiveConversation({
      activeConversation: active,
      labels,
      sections: section([conversation("recent")])
    });

    expect(projected.sections.map((item) => item.id)).toEqual([
      "project:/workspace",
      "project:/other"
    ]);
    expect(projected.sections[1]?.items).toEqual([]);
    expect(projected.activeOverlay).toEqual({
      conversation: active,
      sectionId: "project:/other"
    });
  });
});

describe("resolveConversationRailActiveConversation", () => {
  it("prefers the rail-projected selected entity over the controller copy", () => {
    const controllerActive = conversation("active");
    const projectedActive = {
      ...controllerActive,
      project: {
        id: "workspace",
        label: "Workspace",
        path: "/workspace",
        sectionKey: "project:/workspace"
      }
    };

    expect(
      resolveConversationRailActiveConversation({
        activeConversation: controllerActive,
        activeConversationId: controllerActive.id,
        conversations: [projectedActive]
      })
    ).toBe(projectedActive);
  });

  it("keeps the controller entity when the selected row is outside the filter", () => {
    const controllerActive = conversation("active");

    expect(
      resolveConversationRailActiveConversation({
        activeConversation: controllerActive,
        activeConversationId: controllerActive.id,
        conversations: [conversation("other")]
      })
    ).toBe(controllerActive);
  });
});
