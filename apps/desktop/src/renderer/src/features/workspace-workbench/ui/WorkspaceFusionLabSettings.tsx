import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from "@tutti-os/ui-system";
import {
  fusionDockVisibilities,
  isFusionDockVisibility,
  isFusionModeEnabled,
  LAB_FUSION_MODE_FLAG,
  resolveFusionDockVisibility,
  withFusionDockVisibility,
  type FusionDockVisibility
} from "../../../../../shared/featureFlags/catalog.ts";
import type {
  DesktopFeatureFlags,
  DesktopWorkbenchShortcuts
} from "@shared/preferences/index.ts";
import type { DesktopI18nKey } from "@shared/i18n/index.ts";
import { useTranslation } from "@renderer/i18n";
import { WorkspaceLabShortcutRow } from "./WorkspaceLabShortcutRow.tsx";
import {
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsStyles.ts";

export function WorkspaceFusionLabSettings({
  changingFeatureFlags,
  featureFlags,
  onFeatureFlagsChange,
  onWorkbenchShortcutsChange,
  workbenchShortcuts
}: {
  changingFeatureFlags: DesktopFeatureFlags | null;
  featureFlags: DesktopFeatureFlags;
  onFeatureFlagsChange: (flags: DesktopFeatureFlags) => void;
  onWorkbenchShortcutsChange: (shortcuts: DesktopWorkbenchShortcuts) => void;
  workbenchShortcuts: DesktopWorkbenchShortcuts;
}) {
  const { t } = useTranslation();
  const pendingFeatureFlags = changingFeatureFlags ?? featureFlags;
  const isUpdatingFlags = changingFeatureFlags !== null;
  const fusionModeEnabled = isFusionModeEnabled(pendingFeatureFlags);
  const fusionDockVisibility = resolveFusionDockVisibility(pendingFeatureFlags);
  const fusionControlsDisabled = isUpdatingFlags || !fusionModeEnabled;

  return (
    <>
      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.lab.fusionModeLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.lab.fusionModeDescription")}
          </p>
          <p className="m-0 text-[12px] leading-[1.3] text-[var(--text-tertiary)]">
            {t("workspace.settings.lab.fusionModeRestartRequired")}
          </p>
        </div>
        <Switch
          aria-label={t("workspace.settings.lab.fusionModeLabel")}
          checked={fusionModeEnabled}
          disabled={isUpdatingFlags}
          onCheckedChange={(enabled) => {
            onFeatureFlagsChange({
              ...featureFlags,
              [LAB_FUSION_MODE_FLAG]: enabled
            });
          }}
        />
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.lab.fusionDockVisibilityLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.lab.fusionDockVisibilityDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={fusionControlsDisabled}
            value={fusionDockVisibility}
            onValueChange={(value) => {
              if (isFusionDockVisibility(value)) {
                onFeatureFlagsChange(
                  withFusionDockVisibility(featureFlags, value)
                );
              }
            }}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.lab.fusionDockVisibilityLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={workspaceSettingsSelectContentClass}>
              {fusionDockVisibilities.map((visibility) => (
                <SelectItem key={visibility} value={visibility}>
                  {t(fusionDockVisibilityLabelKey(visibility))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <WorkspaceLabShortcutRow
        description={t(
          "workspace.settings.lab.toggleFusionDockShortcutDescription"
        )}
        disabled={fusionControlsDisabled}
        label={t("workspace.settings.lab.toggleFusionDockShortcutLabel")}
        value={workbenchShortcuts.toggleFusionDock}
        onChange={(binding) => {
          onWorkbenchShortcutsChange({
            ...workbenchShortcuts,
            toggleFusionDock: binding
          });
        }}
      />
    </>
  );
}

function fusionDockVisibilityLabelKey(
  visibility: FusionDockVisibility
): DesktopI18nKey {
  switch (visibility) {
    case "always":
      return "workspace.settings.lab.fusionDockVisibilityOptions.always";
    case "autoHide":
      return "workspace.settings.lab.fusionDockVisibilityOptions.autoHide";
    case "shortcutOnly":
      return "workspace.settings.lab.fusionDockVisibilityOptions.shortcutOnly";
  }
}
