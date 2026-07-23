import { describe, expect, it } from "vitest";
import { projectTuttiIntensityPreview } from "./tuttiIntensityPreview";

describe("projectTuttiIntensityPreview", () => {
  it.each([
    [0, "cost"],
    [33, "cost"],
    [34, "balance"],
    [66, "balance"],
    [67, "powerful"],
    [100, "powerful"]
  ] as const)("maps intensity %s to the %s tendency", (intensity, tier) => {
    expect(projectTuttiIntensityPreview(intensity)).toMatchObject({
      intensity,
      tier
    });
  });

  it("projects semantic model and Agent-count tendencies", () => {
    expect(projectTuttiIntensityPreview(20)).toMatchObject({
      modelStrength: "economical",
      agentCount: "single"
    });
    expect(projectTuttiIntensityPreview(50)).toMatchObject({
      modelStrength: "balanced",
      agentCount: "smallGroup"
    });
    expect(projectTuttiIntensityPreview(80)).toMatchObject({
      modelStrength: "mostCapable",
      agentCount: "maxParallel"
    });
  });

  it("normalizes values before projecting the preview", () => {
    expect(projectTuttiIntensityPreview(-20)).toMatchObject({
      intensity: 0,
      tier: "cost"
    });
    expect(projectTuttiIntensityPreview(120)).toMatchObject({
      intensity: 100,
      tier: "powerful"
    });
    expect(projectTuttiIntensityPreview(Number.NaN)).toMatchObject({
      intensity: 50,
      tier: "balance"
    });
  });
});
