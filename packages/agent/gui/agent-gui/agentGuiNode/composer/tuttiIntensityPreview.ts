export type TuttiPreferenceTier = "cost" | "balance" | "powerful";
export type TuttiModelPreference =
  | "economical"
  | "balanced"
  | "mostCapable"
  | "fastestSuitable";
export type TuttiVerificationPreference = "focused" | "relevant" | "thorough";

export interface TuttiPreferencePreview {
  effect: number;
  speed: number;
  effectTier: TuttiPreferenceTier;
  speedTier: TuttiPreferenceTier;
  modelPreference: TuttiModelPreference;
  verificationPreference: TuttiVerificationPreference;
  parallelTarget: number;
}

function normalizePreference(value: number): number {
  return Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : 50;
}

function preferenceTier(value: number): TuttiPreferenceTier {
  return value <= 33 ? "cost" : value <= 66 ? "balance" : "powerful";
}

/**
 * Projects the two continuous Tutti preferences into qualitative guidance.
 *
 * Effect raises the model capability floor and verification breadth. Speed
 * asks the planner to choose the fastest model that still clears that floor
 * and sets a 1-4 parallel Agent target. Actual concurrency remains bounded by
 * dependencies, safe isolation, budget, and workspace capacity.
 */
export function projectTuttiPreferencePreview(
  effect: number,
  speed: number
): TuttiPreferencePreview {
  const normalizedEffect = normalizePreference(effect);
  const normalizedSpeed = normalizePreference(speed);
  const effectTier = preferenceTier(normalizedEffect);
  const speedTier = preferenceTier(normalizedSpeed);

  return {
    effect: normalizedEffect,
    speed: normalizedSpeed,
    effectTier,
    speedTier,
    modelPreference:
      speedTier === "powerful"
        ? "fastestSuitable"
        : effectTier === "powerful"
          ? "mostCapable"
          : effectTier === "cost"
            ? "economical"
            : "balanced",
    verificationPreference:
      effectTier === "powerful"
        ? "thorough"
        : effectTier === "cost"
          ? "focused"
          : "relevant",
    parallelTarget: Math.min(4, Math.floor(normalizedSpeed / 25) + 1)
  };
}
