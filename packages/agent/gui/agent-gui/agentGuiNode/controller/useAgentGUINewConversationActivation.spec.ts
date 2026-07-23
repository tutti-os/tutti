import { describe, expect, it } from "vitest";
import { resolveInitialTuttiModeActivation } from "./useAgentGUINewConversationActivation";

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
