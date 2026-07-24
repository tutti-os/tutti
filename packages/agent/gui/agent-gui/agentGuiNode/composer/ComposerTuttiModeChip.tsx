import { useId } from "react";
import { Switch } from "@tutti-os/ui-system";
import { cn } from "../../../app/renderer/lib/utils";
import tuttiModeLinedIconUrl from "../../../app/renderer/assets/icons/tutti-mode-lined.svg";
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
    >
      <span
        aria-hidden
        className="inline-block size-4 shrink-0 bg-current transition-colors"
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
