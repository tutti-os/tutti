import { useCallback, useRef } from "react";

/**
 * Equalizer-bar music visualizer drawn on the intensity slider track,
 * behind the mascot thumb. No off-the-shelf visualizer library fits here:
 * the maintained ones (audioMotion, wavesurfer, ...) all require a real
 * audio source through the Web Audio API, while this strip is purely
 * decorative. The bars sample a smooth travelling noise field (three
 * incommensurate sine components), so neighbouring bars stay coherent and
 * heights never jump mechanically; a subtle beat envelope keeps the motion
 * musical.
 *
 * Intensity lerps the exposed parameters: even the lowest value renders a
 * lively mid-energy strip, and the highest pushes tall, fully-spiky bars
 * dancing fast enough to clip against the track edge. Parameter targets are
 * assigned during render and the draw loop eases toward them, so drag
 * updates morph smoothly and repeated assignments from discarded or double
 * renders are harmless.
 *
 * The agent-gui degradation ratchet forbids new effects, so the canvas
 * lifecycle hangs off the DOM node through a React 19 ref callback with a
 * cleanup.
 */

const TRACK_HEIGHT_PX = 20;
const BAR_WIDTH_PX = 3;
const BAR_GAP_PX = 2;
/** Horizontal scale of the noise field per bar; neighbours stay coherent. */
const BAR_SPATIAL_SCALE = 0.35;
/** Exponential easing factor (per frame) toward parameter targets. */
const PARAM_EASE = 0.08;
/** Subtle loudness pulse, in radians per second at speed 1. */
const BEAT_RATE = 2.2;

interface WaveParams {
  /** Peak bar height as a fraction of the track half-height. */
  amplitude: number;
  /** Bar-to-bar height variability: low reads flat, high reads spiky. */
  contrast: number;
  /** Time multiplier for the noise field and the beat. */
  speed: number;
}

function clampIntensity(intensity: number): number {
  return Number.isFinite(intensity) ? Math.min(100, Math.max(0, intensity)) : 0;
}

function waveParams(intensity: number): WaveParams {
  const t = clampIntensity(intensity) / 100;
  return {
    // The floor already reads as energetic (roughly the old ~75 intensity);
    // the top end peaks slightly past the track half-height so the strongest
    // setting visibly maxes out against the clip.
    amplitude: 0.8 + t * 0.3,
    contrast: 0.7 + t * 0.3, // lively variation -> fully spiky heights
    speed: 2 + t * 1.3 // brisk sway -> fast dance
  };
}

/** Deterministic per-bar jitter so heights decorrelate without jumping. */
function barJitter(index: number): number {
  const value = Math.sin(index * 127.1) * 43758.5453;
  return value - Math.floor(value);
}

/** Smooth 1D noise field in [-1, 1]: three incommensurate travelling sines. */
function noiseField(x: number, t: number): number {
  return (
    0.55 * Math.sin(x * 0.9 + t * 1.1) +
    0.3 * Math.sin(x * 2.3 - t * 1.7 + 1.3) +
    0.15 * Math.sin(x * 4.1 + t * 2.9 + 4.2)
  );
}

export function TuttiIntensityWave({ intensity }: { intensity: number }) {
  // The draw loop eases toward these targets every frame, so reassigning
  // them on every render (including discarded or double renders) is safe.
  const targetsRef = useRef<WaveParams | null>(null);
  targetsRef.current = waveParams(intensity);

  // The empty dependency list keeps the attachment stable for the node's
  // lifetime: the canvas is created once per mount and torn down by the
  // returned cleanup on unmount.
  const attachWave = useCallback(
    (container: HTMLDivElement | null): (() => void) | undefined => {
      if (container === null) return undefined;
      // Decorative motion is skipped entirely for reduced-motion users.
      if (
        typeof window.matchMedia !== "function" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        return undefined;
      }
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      // Environments without a 2D canvas (e.g. jsdom) degrade to the plain
      // gradient track.
      if (ctx === null) return undefined;

      const ratio = window.devicePixelRatio || 1;
      const width = container.clientWidth;
      canvas.width = width * ratio;
      canvas.height = TRACK_HEIGHT_PX * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${TRACK_HEIGHT_PX}px`;
      container.appendChild(canvas);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.strokeStyle = window.getComputedStyle(container).color;
      ctx.lineWidth = BAR_WIDTH_PX;
      ctx.lineCap = "round";

      const barCount = Math.max(
        1,
        Math.floor((width + BAR_GAP_PX) / (BAR_WIDTH_PX + BAR_GAP_PX))
      );
      const barsWidth = barCount * (BAR_WIDTH_PX + BAR_GAP_PX) - BAR_GAP_PX;
      const startX = (width - barsWidth) / 2 + BAR_WIDTH_PX / 2;
      const midY = TRACK_HEIGHT_PX / 2;

      const params = { ...(targetsRef.current ?? waveParams(0)) };
      let phase = 0;
      let beatPhase = 0;
      let lastTime = -1;
      let animationFrameId = 0;

      const draw = (time: number): void => {
        animationFrameId = requestAnimationFrame(draw);
        if (lastTime < 0) lastTime = time;
        // Clamp the step so a backgrounded tab does not jump on resume.
        const dt = Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;

        const targets = targetsRef.current ?? params;
        params.amplitude += (targets.amplitude - params.amplitude) * PARAM_EASE;
        params.contrast += (targets.contrast - params.contrast) * PARAM_EASE;
        params.speed += (targets.speed - params.speed) * PARAM_EASE;

        phase += dt * params.speed * 2.4;
        beatPhase += dt * params.speed * BEAT_RATE;
        const beat = 0.85 + 0.15 * Math.pow(0.5 + 0.5 * Math.sin(beatPhase), 2);

        ctx.clearRect(0, 0, width, TRACK_HEIGHT_PX);
        ctx.beginPath();
        for (let i = 0; i < barCount; i += 1) {
          const fieldX = (i + barJitter(i)) * BAR_SPATIAL_SCALE;
          const value = (noiseField(fieldX, phase) + 1) / 2;
          const heightFrac =
            params.amplitude *
            (1 - params.contrast + params.contrast * value) *
            beat;
          const halfHeight = Math.max(
            0.8,
            heightFrac * (TRACK_HEIGHT_PX / 2 - 1)
          );
          const x = startX + i * (BAR_WIDTH_PX + BAR_GAP_PX);
          ctx.moveTo(x, midY - halfHeight);
          ctx.lineTo(x, midY + halfHeight);
        }
        ctx.stroke();
      };
      animationFrameId = requestAnimationFrame(draw);

      return () => {
        cancelAnimationFrame(animationFrameId);
        canvas.remove();
      };
    },
    []
  );

  // The mascot PNGs carry a soft semi-transparent halo (~55% alpha), so the
  // wave would bleed through the thumb. Cut a gap in the wave beneath the
  // thumb instead; the thumb is 40px wide (`size-10`) and its travel is
  // inset by half its width on each side, like any Radix slider thumb.
  const thumbProgress = clampIntensity(intensity) / 100;
  const thumbCenter = `calc(20px + (100% - 40px) * ${thumbProgress})`;
  const maskImage = `radial-gradient(circle at ${thumbCenter} 50%, transparent 0, transparent 22px, black 28px)`;

  return (
    <div
      aria-hidden="true"
      ref={attachWave}
      className="pointer-events-none absolute inset-x-0 top-1/2 z-[1] flex h-5 -translate-y-1/2 items-center justify-center overflow-hidden rounded-full text-[var(--text-primary)] opacity-60"
      data-agent-tutti-budget-intensity-wave="true"
      style={{ WebkitMaskImage: maskImage, maskImage }}
    />
  );
}
