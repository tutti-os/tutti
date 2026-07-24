import { useId, useState } from "react";
import { Switch } from "@tutti-os/ui-system";
import { cn } from "../../../app/renderer/lib/utils";
import tuttiModeLinedIconUrl from "../../../app/renderer/assets/icons/tutti-mode-lined.svg";
import tuttiSnapStarsLightUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-light.png";
import tuttiSnapStarsLightActiveUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-light-active.png";
import tuttiSnapStarsDarkUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-dark.png";
import tuttiSnapStarsDarkActiveUrl from "../../../app/renderer/assets/animations/tutti-snap-stars-dark-active.png";
import styles from "../AgentGUINode.styles";

/**
 * Compact Tutti Mode activation chip in the composer footer. It sits between
 * the "@" mention trigger and the handoff menu in both composer contexts
 * (home hero and existing-session dock) and drives the same activation path
 * as /tutti. The switch owns arming and disarming; the footer renders no
 * separate active-state Tutti badge.
 */
export function ComposerTuttiModeChip({
  active,
  updating,
  label,
  description,
  tuttiModeSupported,
  onTuttiModeChange
}: {
  active: boolean;
  updating: boolean;
  label: string;
  description?: string;
  tuttiModeSupported: boolean;
  onTuttiModeChange?: (active: boolean) => void;
}): React.JSX.Element | null {
  const switchId = useId();
  const [hovered, setHovered] = useState(false);
  // The snap-stars burst plays once per hover entry; remounting the APNG on
  // each enter restarts it from frame 0, mirroring the handoff clap. It is
  // suppressed while an activation update is pending (cursor-wait) and under
  // prefers-reduced-motion (handled in CSS, which keeps the static icon).
  const shouldPlaySnap = hovered && !updating;
  // Same host gate as /tutti and the composer badge: omit or enabled:false
  // must not show Tutti Mode chrome on Codex/VM or other shared AgentGUI hosts.
  if (!onTuttiModeChange || !tuttiModeSupported) {
    return null;
  }
  return (
    <label
      htmlFor={switchId}
      title={description ?? label}
      data-testid="agent-gui-composer-tutti-mode-toggle"
      data-agent-tutti-mode-active={active ? "true" : undefined}
      className={cn(
        styles.composerMenuTrigger,
        "group w-auto !gap-1.5",
        updating ? "cursor-wait" : "cursor-pointer"
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        aria-hidden
        className={styles.composerTuttiModeIcon}
        data-snap-active={shouldPlaySnap ? "true" : undefined}
      >
        <span
          className={styles.composerTuttiModeIconStatic}
          style={{
            WebkitMaskImage: `url("${tuttiModeLinedIconUrl}")`,
            WebkitMaskPosition: "center",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskSize: "contain",
            maskImage: `url("${tuttiModeLinedIconUrl}")`,
            maskPosition: "center",
            maskRepeat: "no-repeat",
            maskSize: "contain"
          }}
        />
        {shouldPlaySnap ? (
          <ComposerTuttiModeSnapAnimation active={active} />
        ) : null}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      <Switch
        id={switchId}
        size="sm"
        checked={active}
        disabled={updating}
        aria-label={label}
        className="ml-0.5"
        data-testid="agent-gui-composer-tutti-mode-toggle-switch"
        onCheckedChange={(checked) => onTuttiModeChange(checked)}
      />
    </label>
  );
}

/**
 * Per-theme, per-state APNG sources for the hover snap-stars burst. Each is
 * the rendered form of `tutti-snap-stars.json` with its fill swapped to the
 * exact text token color so the animation tracks the Tutti Mode label
 * (gray text-primary at rest, tutti-purple when armed) in both themes.
 */
const SNAP_STARS_URLS = {
  light: { idle: tuttiSnapStarsLightUrl, active: tuttiSnapStarsLightActiveUrl },
  dark: { idle: tuttiSnapStarsDarkUrl, active: tuttiSnapStarsDarkActiveUrl }
} as const;

/**
 * Hover snap-stars overlay. The APNG is the rendered form of the
 * `tutti-snap-stars.json` Lottie source (kept alongside this asset), with its
 * fill swapped to the active text token color. It shares the hand-with-sparkle
 * motif of the static lined icon so the static -> animated cross-fade reads as
 * the same mark snapping to life in the exact label color. It is mounted only
 * while hovered so each hover replays from frame 0, and it is hidden under
 * prefers-reduced-motion via CSS on the parent span.
 */
function ComposerTuttiModeSnapAnimation({
  active
}: {
  active: boolean;
}): React.JSX.Element {
  // Resolve the theme synchronously at mount (hover entry). A theme switch
  // mid-hover is not a real interaction, so reading data-theme here avoids a
  // subscription effect while still picking the palette-correct APNG.
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark";
  const src =
    SNAP_STARS_URLS[isDark ? "dark" : "light"][active ? "active" : "idle"];
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      alt=""
      aria-hidden="true"
      className={styles.composerTuttiModeIconAnimated}
      data-active={isLoaded ? "true" : undefined}
      decoding="async"
      draggable={false}
      src={src}
      key={src}
      onLoad={() => setIsLoaded(true)}
    />
  );
}
