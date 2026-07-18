import { describe, expect, it } from "vitest";
import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import type { AgentHostUserProjectsApi } from "../../../host/agentHostApi";
import { projectConversationRailSectionsByExactKey } from "../model/agentGuiConversationRail";
import {
  areAgentGUIUserProjectsEqual,
  interactiveApprovalFromInteraction,
  readAgentGUIUserProjectSnapshot,
  upsertAgentGUIUserProject
} from "./agentGuiController.interactiveHelpers";

describe("interactiveApprovalFromInteraction", () => {
  it("projects the normalized file-edit approval purpose", () => {
    const interaction: AgentActivityInteraction = {
      agentSessionId: "session-1",
      createdAtUnixMs: 1,
      input: {
        callId: "call-1",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
      },
      kind: "approval",
      metadata: { approvalPurpose: "edit-files" },
      requestId: "request-1",
      status: "pending",
      toolName: "Approval",
      turnId: "turn-1",
      updatedAtUnixMs: 1
    };

    expect(interactiveApprovalFromInteraction(interaction)).toMatchObject({
      approvalPurpose: "edit-files",
      requestId: "request-1"
    });
  });
});

describe("AgentGUI user-project snapshot projection", () => {
  it("preserves the ordered section templates from an already-loaded shared service", () => {
    const api = {
      service: {
        getSnapshot: () => ({
          error: null,
          initialized: true,
          isLoading: false,
          projects: [
            {
              id: "beta",
              label: "Beta",
              path: "/workspace/beta",
              pinnedAtUnixMs: 20,
              sectionKey: "project:/workspace/beta"
            },
            {
              id: "alpha",
              label: "Alpha",
              path: "/workspace/alpha",
              pinnedAtUnixMs: 0,
              sectionKey: "project:/workspace/alpha"
            }
          ],
          revision: 1
        })
      }
    } as AgentHostUserProjectsApi;

    const projects = readAgentGUIUserProjectSnapshot(api);
    const sections = projectConversationRailSectionsByExactKey({
      conversations: [],
      labels: {
        sectionConversations: "Conversations",
        sectionPinned: "Pinned"
      },
      userProjects: projects
    });

    expect(projects.map((project) => project.sectionKey)).toEqual([
      "project:/workspace/beta",
      "project:/workspace/alpha"
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      "project:/workspace/beta",
      "project:/workspace/alpha",
      "conversations"
    ]);
  });

  it("treats a section-key-only change as a new AgentGUI snapshot", () => {
    expect(
      areAgentGUIUserProjectsEqual(
        [
          {
            id: "alpha",
            label: "Alpha",
            path: "/alpha",
            pinnedAtUnixMs: 0
          }
        ],
        [
          {
            id: "alpha",
            label: "Alpha",
            path: "/alpha",
            pinnedAtUnixMs: 0,
            sectionKey: "project:/alpha"
          }
        ]
      )
    ).toBe(false);
  });

  it("treats a pin-state-only change as a new AgentGUI snapshot", () => {
    expect(
      areAgentGUIUserProjectsEqual(
        [
          {
            id: "alpha",
            label: "Alpha",
            path: "/alpha",
            pinnedAtUnixMs: 0
          }
        ],
        [
          {
            id: "alpha",
            label: "Alpha",
            path: "/alpha",
            pinnedAtUnixMs: 10
          }
        ]
      )
    ).toBe(false);
  });

  it("keeps sectionKey when a use result is upserted", () => {
    expect(
      upsertAgentGUIUserProject([], {
        id: "alpha",
        label: "Alpha",
        path: "/alpha",
        pinnedAtUnixMs: 0,
        sectionKey: "project:/alpha"
      })
    ).toEqual([
      {
        id: "alpha",
        label: "Alpha",
        path: "/alpha",
        pinnedAtUnixMs: 0,
        sectionKey: "project:/alpha"
      }
    ]);
  });
});
