import { describe, expect, it } from "vitest";
import {
  resolveInitialRailPlacement,
  resolveInitialTuttiModeActivation
} from "./useAgentGUINewConversationActivation";

describe("resolveInitialRailPlacement", () => {
  it("uses the selected caller project section", () => {
    expect(
      resolveInitialRailPlacement({
        selectedProjectPath: "/workspace",
        userProjects: [
          {
            id: "project-1",
            label: "Workspace",
            path: "/workspace",
            pinnedAtUnixMs: 0,
            sectionKey: "project:/workspace"
          }
        ]
      })
    ).toEqual({
      version: 1,
      kind: "project",
      projectPath: "/workspace",
      sectionKey: "project:/workspace"
    });
  });

  it("uses conversations only when no project is selected", () => {
    expect(
      resolveInitialRailPlacement({
        selectedProjectPath: null,
        userProjects: []
      })
    ).toEqual({
      version: 1,
      kind: "conversations",
      sectionKey: "conversations"
    });
  });

  it("writes the canonical project root when the selected path is nested", () => {
    expect(
      resolveInitialRailPlacement({
        selectedProjectPath: "/workspace/packages/agent",
        userProjects: [
          {
            id: "project-1",
            label: "Workspace",
            path: "/workspace",
            pinnedAtUnixMs: 0,
            sectionKey: "project:/workspace"
          }
        ]
      })
    ).toEqual({
      version: 1,
      kind: "project",
      projectPath: "/workspace",
      sectionKey: "project:/workspace"
    });
  });

  it("fails closed when the selected project has no canonical section", () => {
    expect(
      resolveInitialRailPlacement({
        selectedProjectPath: "/workspace",
        userProjects: []
      })
    ).toBeNull();
  });
});

describe("resolveInitialTuttiModeActivation", () => {
  it("prefers the composer submit snapshot over a stale inactive draft", () => {
    expect(
      resolveInitialTuttiModeActivation({
        submitOptions: {
          tuttiMode: { active: true, effect: 81, speed: 72 }
        },
        draftActive: false,
        draftEffect: 50,
        draftSpeed: 50
      })
    ).toEqual({
      activation: {
        source: "slash_command",
        status: "active",
        effect: 81,
        speed: 72
      },
      source: "composer_submit"
    });
  });

  it("treats an explicit inactive submit snapshot as authoritative", () => {
    expect(
      resolveInitialTuttiModeActivation({
        submitOptions: { tuttiMode: { active: false } },
        draftActive: true,
        draftEffect: 50,
        draftSpeed: 50
      })
    ).toBeNull();
  });

  it("keeps the engine draft fallback for non-composer callers", () => {
    expect(
      resolveInitialTuttiModeActivation({
        draftActive: true,
        draftEffect: 64,
        draftSpeed: 75
      })
    ).toEqual({
      activation: {
        source: "slash_command",
        status: "active",
        effect: 64,
        speed: 75
      },
      source: "engine_draft"
    });
  });
});
