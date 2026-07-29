import { describe, expect, it } from "vitest";
import { withAgentComposerTuttiModeSnapshot } from "./agentComposerSubmitOptions";

describe("withAgentComposerTuttiModeSnapshot", () => {
  it("captures active Tutti preferences with their audit reference", () => {
    expect(
      withAgentComposerTuttiModeSnapshot({
        active: true,
        effect: 73,
        speed: 61
      })
    ).toEqual({
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      tuttiMode: { active: true, effect: 73, speed: 61 }
    });
  });

  it("captures an explicit inactive state without adding an audit reference", () => {
    expect(
      withAgentComposerTuttiModeSnapshot({
        active: false,
        effect: 50,
        speed: 50
      })
    ).toEqual({ tuttiMode: { active: false } });
  });
});
