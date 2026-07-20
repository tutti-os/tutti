import { Switch } from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import type { DesktopI18nKey } from "@shared/i18n";
import type { DesktopFeatureFlags } from "@shared/preferences";
import {
  AGENT_EXTENSION_ACTIVATION_FLAGS,
  AGENT_EXTENSION_CODEBUDDY_FLAG,
  AGENT_EXTENSION_COPILOT_FLAG,
  AGENT_EXTENSION_GEMINI_FLAG,
  AGENT_EXTENSION_GROK_FLAG,
  AGENT_EXTENSION_KILO_FLAG,
  AGENT_EXTENSION_QWEN_FLAG,
  type AgentExtensionActivationFlag,
  isFeatureEnabled
} from "../../../../../shared/featureFlags/catalog.ts";

const settingByFlag = {
  [AGENT_EXTENSION_GEMINI_FLAG]: {
    descriptionKey: "workspace.settings.developer.geminiAgentDescription",
    labelKey: "workspace.settings.developer.geminiAgentLabel"
  },
  [AGENT_EXTENSION_CODEBUDDY_FLAG]: {
    descriptionKey: "workspace.settings.developer.codebuddyAgentDescription",
    labelKey: "workspace.settings.developer.codebuddyAgentLabel"
  },
  [AGENT_EXTENSION_COPILOT_FLAG]: {
    descriptionKey: "workspace.settings.developer.copilotAgentDescription",
    labelKey: "workspace.settings.developer.copilotAgentLabel"
  },
  [AGENT_EXTENSION_KILO_FLAG]: {
    descriptionKey: "workspace.settings.developer.kiloAgentDescription",
    labelKey: "workspace.settings.developer.kiloAgentLabel"
  },
  [AGENT_EXTENSION_QWEN_FLAG]: {
    descriptionKey: "workspace.settings.developer.qwenAgentDescription",
    labelKey: "workspace.settings.developer.qwenAgentLabel"
  },
  [AGENT_EXTENSION_GROK_FLAG]: {
    descriptionKey: "workspace.settings.developer.grokAgentDescription",
    labelKey: "workspace.settings.developer.grokAgentLabel"
  }
} satisfies Record<
  AgentExtensionActivationFlag,
  { descriptionKey: DesktopI18nKey; labelKey: DesktopI18nKey }
>;

export function WorkspaceAgentExtensionDeveloperSettings({
  disabled,
  featureFlags,
  onFeatureFlagsChange
}: {
  disabled: boolean;
  featureFlags: DesktopFeatureFlags;
  onFeatureFlagsChange: (flags: DesktopFeatureFlags) => void;
}) {
  const { t } = useTranslation();

  return AGENT_EXTENSION_ACTIVATION_FLAGS.map((flag) => {
    const setting = settingByFlag[flag];
    return (
      <div
        key={flag}
        className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t(setting.labelKey)}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(setting.descriptionKey)}
          </p>
        </div>
        <Switch
          aria-label={t(setting.labelKey)}
          checked={isFeatureEnabled(featureFlags, flag)}
          disabled={disabled}
          onCheckedChange={(enabled) => {
            onFeatureFlagsChange({ ...featureFlags, [flag]: enabled });
          }}
        />
      </div>
    );
  });
}
