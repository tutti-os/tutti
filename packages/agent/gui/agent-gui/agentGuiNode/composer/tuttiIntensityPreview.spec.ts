import { describe, expect, it } from "vitest";
import { projectTuttiPreferencePreview } from "./tuttiIntensityPreview";

describe("projectTuttiPreferencePreview", () => {
  it("projects effect into model capability and internal verification", () => {
    expect(projectTuttiPreferencePreview(20, 50)).toMatchObject({
      effectTier: "cost",
      modelPreference: "economical",
      verificationPreference: "focused",
      parallelTarget: 3
    });
    expect(projectTuttiPreferencePreview(80, 50)).toMatchObject({
      effectTier: "powerful",
      modelPreference: "mostCapable",
      verificationPreference: "thorough",
      parallelTarget: 3
    });
  });

  it("keeps the model strategy effect-driven as speed rises", () => {
    expect(projectTuttiPreferencePreview(80, 80)).toMatchObject({
      effectTier: "powerful",
      speedTier: "powerful",
      modelPreference: "mostCapable",
      verificationPreference: "thorough",
      parallelTarget: 4
    });
  });

  it.each([
    [0, 1],
    [24, 1],
    [25, 2],
    [49, 2],
    [50, 3],
    [74, 3],
    [75, 4],
    [100, 4]
  ])("maps speed %d to parallel target %d", (speed, parallelTarget) => {
    expect(projectTuttiPreferencePreview(50, speed).parallelTarget).toBe(
      parallelTarget
    );
  });

  it("normalizes each preference independently", () => {
    expect(projectTuttiPreferencePreview(-20, 120)).toMatchObject({
      effect: 0,
      speed: 100,
      effectTier: "cost",
      speedTier: "powerful",
      parallelTarget: 4
    });
    expect(projectTuttiPreferencePreview(Number.NaN, Number.NaN)).toMatchObject(
      {
        effect: 50,
        speed: 50
      }
    );
  });
});
