export type TuttiIntensityTier = "cost" | "balance" | "powerful";
export type TuttiModelStrengthTendency =
  | "economical"
  | "balanced"
  | "mostCapable";
export type TuttiAgentCountTendency = "single" | "smallGroup" | "maxParallel";

export interface TuttiIntensityPreview {
  /** Clamped, rounded intensity used by the slider and marker. */
  intensity: number;
  /** Qualitative planning tendency shown to the user. */
  tier: TuttiIntensityTier;
  /** Label lookup key for the model-strength tendency. */
  modelStrength: TuttiModelStrengthTendency;
  /** Label lookup key for the expected parallel Agent count. */
  agentCount: TuttiAgentCountTendency;
}

/**
 * Projects the continuous Tutti intensity into three equal qualitative bands.
 *
 * This is presentation guidance, not execution authority. The planning Agent
 * still derives the exact model, task graph, and parallelism from the request,
 * selected Skills, available model catalog, and the workspace-wide limit.
 */
export function projectTuttiIntensityPreview(
  intensity: number
): TuttiIntensityPreview {
  const normalized = Number.isFinite(intensity)
    ? Math.min(100, Math.max(0, Math.round(intensity)))
    : 50;
  const tier: TuttiIntensityTier =
    normalized <= 33 ? "cost" : normalized <= 66 ? "balance" : "powerful";

  return {
    intensity: normalized,
    tier,
    modelStrength:
      tier === "cost"
        ? "economical"
        : tier === "balance"
          ? "balanced"
          : "mostCapable",
    agentCount:
      tier === "cost"
        ? "single"
        : tier === "balance"
          ? "smallGroup"
          : "maxParallel"
  };
}
