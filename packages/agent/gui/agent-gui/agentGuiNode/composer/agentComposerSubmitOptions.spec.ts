import { describe, expect, it } from "vitest";
import { withAgentComposerTuttiModeSnapshot } from "./agentComposerSubmitOptions";

describe("withAgentComposerTuttiModeSnapshot", () => {
  it("captures active Tutti state and intensity with its audit reference", () => {
    expect(
      withAgentComposerTuttiModeSnapshot({
        active: true,
        orchestrationIntensity: 73
      })
    ).toEqual({
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      tuttiMode: { active: true, orchestrationIntensity: 73 }
    });
  });

  it("captures an explicit inactive state without adding an audit reference", () => {
    expect(
      withAgentComposerTuttiModeSnapshot({
        active: false,
        orchestrationIntensity: 50
      })
    ).toEqual({ tuttiMode: { active: false } });
  });
});
