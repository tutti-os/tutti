import { Switch } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import {
  EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG,
  LAB_AUTOMATION_RULES_FLAG,
  LAB_MODEL_PLANS_FLAG,
  LAB_TUTTI_MODE_FLAG,
  LAB_WORKBENCH_SHORTCUTS_FLAG,
  LAB_WORKSPACE_AGENTS_FLAG,
  isFeatureEnabled
} from "../../../../../shared/featureFlags/catalog.ts";
import type { DesktopFeatureFlags } from "../../../../../shared/preferences/index.ts";

const featureGateRows = [
  {
    key: LAB_TUTTI_MODE_FLAG,
    labelKey: "workspace.settings.lab.tuttiModeLabel" as const,
    descriptionKey: "workspace.settings.lab.tuttiModeDescription" as const
  },
  {
    key: LAB_MODEL_PLANS_FLAG,
    labelKey: "workspace.settings.lab.modelPlansLabel" as const,
    descriptionKey: "workspace.settings.lab.modelPlansDescription" as const
  },
  {
    key: LAB_WORKSPACE_AGENTS_FLAG,
    labelKey: "workspace.settings.lab.workspaceAgentsLabel" as const,
    descriptionKey: "workspace.settings.lab.workspaceAgentsDescription" as const
  },
  {
    key: LAB_AUTOMATION_RULES_FLAG,
    labelKey: "workspace.settings.lab.automationRulesLabel" as const,
    descriptionKey: "workspace.settings.lab.automationRulesDescription" as const
  },
  {
    key: LAB_WORKBENCH_SHORTCUTS_FLAG,
    labelKey: "workspace.settings.lab.workbenchShortcutsLabel" as const,
    descriptionKey:
      "workspace.settings.lab.workbenchShortcutsDescription" as const
  },
  {
    key: EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG,
    labelKey: "workspace.settings.lab.previewAgentsLabel" as const,
    descriptionKey: "workspace.settings.lab.previewAgentsDescription" as const
  }
] as const;

export function WorkspaceLabFeatureGateRows({
  changingFeatureFlags,
  featureFlags,
  onFeatureFlagsChange
}: {
  changingFeatureFlags: DesktopFeatureFlags | null;
  featureFlags: DesktopFeatureFlags;
  onFeatureFlagsChange: (flags: DesktopFeatureFlags) => void;
}) {
  const { t } = useTranslation();
  const pendingFeatureFlags = changingFeatureFlags ?? featureFlags;
  const disabled = changingFeatureFlags !== null;

  return featureGateRows.map((row) => (
    <div
      key={row.key}
      className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t(row.labelKey)}
        </strong>
        <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
          {t(row.descriptionKey)}
        </p>
      </div>
      <Switch
        aria-label={t(row.labelKey)}
        checked={isFeatureEnabled(pendingFeatureFlags, row.key)}
        disabled={disabled}
        onCheckedChange={(enabled) => {
          onFeatureFlagsChange({
            ...pendingFeatureFlags,
            [row.key]: enabled
          });
        }}
      />
    </div>
  ));
}
