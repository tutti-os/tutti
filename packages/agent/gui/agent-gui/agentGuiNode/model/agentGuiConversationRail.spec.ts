import { describe, expect, it } from "vitest";
import type { AgentGUIConversationSummary } from "./agentGuiConversationModel";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import {
  insertConversationRailSectionOverlay,
  conversationSummariesRenderEqual,
  isConversationRailInitialLoadPending,
  projectConversationRailMemberships,
  projectConversationRailSearchSections,
  projectConversationRailSectionsByExactKey,
  projectConversationRailSectionsWithActiveConversation,
  planRuntimeRailMembershipRefresh,
  projectRuntimeSectionsToConversationRailMemberships,
  projectConversationRailSectionsWithTransientConversations,
  resolveConversationRailActiveConversation
} from "./agentGuiConversationRail";
import type { ConversationRailSectionMembership } from "./agentGuiConversationRail";
import { preserveConversationRailSectionTemplates } from "./agentGuiConversationRailSectionTemplates";

const railLabels = {
  sectionConversations: "Conversations",
  sectionPinned: "Pinned"
};

function conversation(
  id: string,
  pinnedAtUnixMs: number | null = null
): AgentGUIConversationSummary {
  return {
    agentTargetId: "local:codex",
    cwd: "/workspace",
    id,
    pinnedAtUnixMs,
    provider: "codex",
    railSectionKey: "project:/workspace",
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
    ).toEqual({
      kind: "refresh_pages",
      pageIds: ["project:/workspace"],
      reconcilingSessionIds: [],
      refreshSearch: false
    });
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
    ).toEqual({
      kind: "refresh_pages",
      pageIds: ["project:/workspace"],
      reconcilingSessionIds: [],
      refreshSearch: false
    });
    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([first]),
        next: [conversation("first", 100)],
        previous: [first]
      })
    ).toEqual({
      kind: "refresh_pages",
      pageIds: ["project:/workspace", "pinned"],
      reconcilingSessionIds: [],
      refreshSearch: false
    });
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
      kind: "refresh_pages",
      pageIds: ["project:/workspace"],
      reconcilingSessionIds: ["new-session"],
      refreshSearch: false
    });
  });

  it("refreshes search only when a title changes under an active query", () => {
    const previous = conversation("session-1");

    expect(
      planRuntimeRailMembershipRefresh({
        loadedSections: membership([previous]),
        next: [{ ...previous, title: "Renamed" }],
        previous: [previous],
        searchActive: true
      })
    ).toEqual({
      kind: "refresh_pages",
      pageIds: [],
      reconcilingSessionIds: [],
      refreshSearch: true
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

describe("projectConversationRailMemberships", () => {
  it("requires exact agreement between the session key and section key", () => {
    const exact = conversation("exact");
    const conflicting = {
      ...conversation("conflicting"),
      railSectionKey: "conversations"
    };

    const projected = projectConversationRailMemberships({
      conversations: [exact, conflicting],
      labels: {
        sectionConversations: "Conversations",
        sectionPinned: "Pinned"
      },
      sections: membership([exact, conflicting])
    });

    expect(projected[0]?.items.map((item) => item.id)).toEqual(["exact"]);
  });
});

describe("projectConversationRailSectionsWithTransientConversations", () => {
  const labels = {
    sectionConversations: "Conversations",
    sectionPinned: "Pinned"
  };

  it("keeps pending rows out of project sections until exact membership arrives", () => {
    const canonical = section([conversation("canonical")]);
    const project = canonical[0]?.project ?? null;
    const first = {
      ...conversation("session-1"),
      project,
      projectionSource: "pending_activation" as const,
      railSectionKey: undefined,
      sortTimeUnixMs: 10,
      updatedAtUnixMs: 10
    };
    const second = {
      ...conversation("session-2"),
      project,
      projectionSource: "pending_activation" as const,
      railSectionKey: undefined,
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

    expect(projected[0]?.items.map((item) => item.id)).toEqual(["canonical"]);
    expect(projected).toHaveLength(1);
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
      railSectionKey: undefined,
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

    expect(projected).toHaveLength(1);
    expect(projected[0]?.items.map((item) => item.id)).toEqual([
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
      labels: railLabels,
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
      labels: railLabels,
      sections: section([active])
    });

    expect(projected.activeOverlay?.conversation).toBe(active);
  });

  it("uses the active row's exact key instead of its resolved project", () => {
    const active = {
      ...conversation("active"),
      project: {
        id: "workspace",
        label: "Workspace",
        path: "/workspace",
        sectionKey: "project:/workspace"
      },
      railSectionKey: "conversations"
    };
    const sections = section([conversation("recent")]);

    const projected = projectConversationRailSectionsWithActiveConversation({
      activeConversation: active,
      labels,
      sections
    });

    expect(projected.activeOverlay?.conversation.id).toBe("active");
    expect(projected.activeOverlay?.sectionId).toBe("conversations");
    expect(projected.activeOverlay?.conversation.project).toBeNull();
    expect(projected.sections.map((item) => item.id)).toEqual([
      "project:/workspace",
      "conversations"
    ]);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["recent"]);
  });

  it("creates an exact project overlay when its keyed section is not loaded", () => {
    const active = {
      ...conversation("active"),
      project: {
        id: "other",
        label: "Other",
        path: "/other",
        sectionKey: "project:/other"
      },
      railSectionKey: "project:/other"
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

  it("does not project an active row whose backend key is absent", () => {
    const active = {
      ...conversation("active"),
      railSectionKey: undefined
    };
    const sections = section([conversation("recent")]);

    const projected = projectConversationRailSectionsWithActiveConversation({
      activeConversation: active,
      labels,
      sections
    });

    expect(projected).toEqual({ activeOverlay: null, sections });
  });
});

describe("projectConversationRailSearchSections", () => {
  it("uses exact loaded membership and never infers missing membership from cwd", () => {
    const loaded = conversation("loaded");
    const resolvedProject = section([])[0]?.project ?? null;
    const missing = {
      ...conversation("missing"),
      cwd: "/workspace/packages/app",
      project: resolvedProject,
      railSectionKey: "conversations"
    };

    const groups = projectConversationRailSearchSections({
      conversations: [loaded, missing],
      labels: {
        sectionConversations: "Conversations",
        sectionPinned: "Pinned"
      },
      sections: section([loaded])
    });

    expect(
      groups.map((group) => [group.id, group.items.map((item) => item.id)])
    ).toEqual([
      ["project:/workspace", ["loaded"]],
      ["conversations", ["missing"]]
    ]);
  });

  it("preserves pinned and authoritative section order", () => {
    const projectA = conversation("project-a");
    const projectB = {
      ...conversation("project-b"),
      railSectionKey: "project:/b",
      project: {
        id: "b",
        label: "B",
        path: "/b",
        sectionKey: "project:/b"
      }
    };
    const pinned = {
      ...conversation("pinned"),
      pinnedAtUnixMs: 1,
      updatedAtUnixMs: 0
    };

    const groups = projectConversationRailSearchSections({
      conversations: [projectA, projectB, pinned],
      labels: railLabels,
      sections: [
        {
          id: "project:/b",
          kind: "project",
          label: "B",
          project: projectB.project,
          items: []
        },
        ...section([])
      ]
    });

    expect(groups.map((group) => group.id)).toEqual([
      "pinned",
      "project:/b",
      "project:/workspace"
    ]);
  });
});

describe("projectConversationRailSectionsByExactKey", () => {
  it("uses only exact backend keys and keeps empty authoritative sections", () => {
    const projectSummary = {
      id: "workspace",
      label: "Workspace",
      path: "/workspace",
      sectionKey: "project:/workspace"
    };
    const exactProject = {
      ...conversation("exact-project"),
      project: projectSummary
    };
    const conversations = {
      ...conversation("general"),
      cwd: "/workspace/nested",
      project: projectSummary,
      railSectionKey: "conversations"
    };
    const missingKey = {
      ...conversation("missing-key"),
      project: projectSummary,
      railSectionKey: undefined
    };

    const groups = projectConversationRailSectionsByExactKey({
      conversations: [conversations, missingKey, exactProject],
      labels: railLabels,
      userProjects: [
        {
          ...projectSummary,
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
          lastUsedAtUnixMs: 1
        },
        {
          id: "empty",
          label: "Empty",
          path: "/empty",
          sectionKey: "project:/empty",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
          lastUsedAtUnixMs: 1
        }
      ],
      includeEmptySections: true
    });

    expect(
      groups.map((group) => [group.id, group.items.map((item) => item.id)])
    ).toEqual([
      ["project:/workspace", ["exact-project"]],
      ["project:/empty", []],
      ["conversations", ["general"]]
    ]);
  });
});

describe("preserveConversationRailSectionTemplates", () => {
  it("keeps project and conversations sections visible when membership is empty", () => {
    const groups = preserveConversationRailSectionTemplates({
      labels: railLabels,
      sections: [],
      userProjects: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/workspace",
          sectionKey: "project:/workspace",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
          lastUsedAtUnixMs: 1
        }
      ]
    });

    expect(
      groups.map((group) => [group.id, group.items.map((item) => item.id)])
    ).toEqual([
      ["project:/workspace", []],
      ["conversations", []]
    ]);
  });

  it("preserves exact projected items without inferring missing membership", () => {
    const exact = conversation("exact");
    const groups = preserveConversationRailSectionTemplates({
      labels: railLabels,
      sections: section([exact]),
      userProjects: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/workspace",
          sectionKey: "project:/workspace",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
          lastUsedAtUnixMs: 1
        },
        {
          id: "empty",
          label: "Empty",
          path: "/empty",
          sectionKey: "project:/empty",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
          lastUsedAtUnixMs: 1
        }
      ]
    });

    expect(
      groups.map((group) => [group.id, group.items.map((item) => item.id)])
    ).toEqual([
      ["project:/workspace", ["exact"]],
      ["project:/empty", []],
      ["conversations", []]
    ]);
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
