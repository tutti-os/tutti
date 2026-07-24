import type { CSSProperties } from "react";
import type { TuttiIntensityTier } from "./tuttiIntensityPreview";

/**
 * Decorative star stream for the Tutti intensity slider: stars pour out of
 * the handle towards the left end of the track. Higher intensity spawns more
 * stars and pushes them faster. Purely presentational -- it renders no
 * user-visible copy and is hidden from assistive technology.
 */

/** Fixed pool size; only the first `activeCount` stars are visible so a
 * growing stream reuses already-running animations instead of remounting. */
const STAR_POOL_SIZE = 14;

interface StarSpec {
  /** Star box size in px. */
  size: number;
  /** Vertical offset from the track center in px. */
  topOffset: number;
  /** 0..1 phase offset applied as a negative animation delay. */
  delayRatio: number;
  /** Per-star duration multiplier so the flow does not move in lockstep. */
  durationJitter: number;
  /** Mid-flight vertical drift in px for a gentle bob. */
  drift: number;
}

/** Deterministic PRNG (mulberry32) so star specs stay stable across renders. */
function buildStarSpecs(): StarSpec[] {
  let seed = 0x2f6e2b1;
  const next = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: STAR_POOL_SIZE }, (_, index) => ({
    size: 6 + Math.round(next() * 5),
    topOffset: Math.round((next() - 0.5) * 12),
    // Spread spawn phases evenly across the pool, then add jitter.
    delayRatio: (index + next() * 0.8) / STAR_POOL_SIZE,
    durationJitter: 0.8 + next() * 0.45,
    drift: Math.round((next() - 0.5) * 6)
  }));
}

const STAR_SPECS = buildStarSpecs();

/** How many stars are active at a given intensity (0-100). */
function activeStarCount(intensity: number): number {
  if (intensity <= 0) {
    return 0;
  }
  return Math.min(
    STAR_POOL_SIZE,
    Math.max(1, Math.round(1 + (intensity / 100) * (STAR_POOL_SIZE - 1)))
  );
}

/** Base traverse duration in seconds; quantize intensity to steps of 10 so
 * mid-drag ticks do not constantly restart running animations. The top end
 * bottoms out at 1.2s so max intensity stays energetic without feeling
 * frantic. */
function baseDurationSeconds(intensity: number): number {
  const quantized = Math.round(intensity / 10) * 10;
  return 2.8 - (quantized / 100) * 1.6;
}

export function TuttiIntensityStarStream({
  intensity,
  tier
}: {
  /** Current draft intensity (0-100). */
  intensity: number;
  tier: TuttiIntensityTier;
}) {
  const activeCount = activeStarCount(intensity);
  const baseDuration = baseDurationSeconds(intensity);
  return (
    <div
      aria-hidden="true"
      className="agent-gui-intensity-star-stream"
      data-agent-tutti-budget-star-stream={tier}
      style={
        {
          // The overlay matches the slider track box; the stream fills from
          // the track start up to just before the handle's left edge.
          "--agent-gui-star-stream-width": `calc(${intensity}% - 24px)`,
          // Stars and their glow are always white, regardless of tier.
          color: "var(--white-stationary)"
        } as CSSProperties
      }
    >
      {STAR_SPECS.map((spec, index) => {
        const duration = baseDuration * spec.durationJitter;
        return (
          <svg
            key={index}
            className="agent-gui-intensity-star-stream__star"
            style={
              {
                width: spec.size,
                height: spec.size,
                top: `calc(50% - ${spec.size / 2}px + ${spec.topOffset}px)`,
                visibility: index < activeCount ? "visible" : "hidden",
                "--agent-gui-star-duration": `${duration}s`,
                "--agent-gui-star-delay": `${-duration * spec.delayRatio}s`,
                "--agent-gui-star-drift": `${spec.drift}px`
              } as CSSProperties
            }
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M11.2696 1.50911C11.5206 0.830794 12.4805 0.830794 12.7315 1.50911L13.876 4.60189C14.8231 7.16058 16.8406 9.17847 19.3994 10.1253L22.4922 11.2699C23.1693 11.5213 23.1695 12.4795 22.4922 12.7308L19.3994 13.8753C16.8403 14.8223 14.823 16.8406 13.876 19.3997L12.7315 22.4915C12.4804 23.1694 11.5209 23.1692 11.2696 22.4915L10.126 19.3997C9.17911 16.8408 7.16046 14.8224 4.60159 13.8753L1.50882 12.7308C0.831157 12.4796 0.831096 11.521 1.50882 11.2699L4.60159 10.1253C7.1605 9.17836 9.17903 7.16078 10.126 4.60189L11.2696 1.50911Z"
              fill="currentColor"
            />
          </svg>
        );
      })}
    </div>
  );
}
