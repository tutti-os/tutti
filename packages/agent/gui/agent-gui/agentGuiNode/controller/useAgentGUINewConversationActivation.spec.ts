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
          tuttiMode: { active: true, orchestrationIntensity: 81 }
        },
        draftActive: false,
        draftOrchestrationIntensity: 50
      })
    ).toEqual({
      activation: {
        source: "slash_command",
        status: "active",
        orchestrationIntensity: 81
      },
      source: "composer_submit"
    });
  });

  it("treats an explicit inactive submit snapshot as authoritative", () => {
    expect(
      resolveInitialTuttiModeActivation({
        submitOptions: { tuttiMode: { active: false } },
        draftActive: true,
        draftOrchestrationIntensity: 50
      })
    ).toBeNull();
  });

  it("keeps the engine draft fallback for non-composer callers", () => {
    expect(
      resolveInitialTuttiModeActivation({
        draftActive: true,
        draftOrchestrationIntensity: 64
      })
    ).toEqual({
      activation: {
        source: "slash_command",
        status: "active",
        orchestrationIntensity: 64
      },
      source: "engine_draft"
    });
  });
});
