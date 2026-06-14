import type * as React from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import {
  AddIcon,
  Button,
  CloseIcon,
  DeleteIcon,
  EyeIcon,
  LinkIcon,
  LoadingIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  UploadIcon
} from "@tutti-os/ui-system";
import { useAnalyticsDebugPreferenceService } from "@renderer/features/analytics-debug";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { formatWorkspaceSettingsBytes } from "../services/workspaceSettingsFormat";
import type { WorkspaceSettingsDeveloperLogsSnapshotState } from "../services/workspaceSettingsTypes";
import type {
  WorkspaceManagedModel,
  WorkspaceManagedModelProviderDraft,
  WorkspaceManagedModelProviderID,
  WorkspaceSettingsManagedModelsSnapshotState
} from "../services/workspaceSettingsTypes";
import {
  desktopLocales,
  type DesktopI18nKey,
  type DesktopLocale
} from "../../../../../shared/i18n/index.ts";
import {
  type DesktopAgentProvider,
  desktopDockPlacements,
  desktopSleepPreventionModes,
  type DesktopDockPlacement,
  type DesktopSleepPreventionMode
} from "../../../../../shared/preferences/index.ts";
import {
  resolveWorkspaceAgentGuiLabel,
  workspaceAgentGuiProviders
} from "../services/workspaceAgentProviderCatalog";
import {
  desktopThemeSources,
  type DesktopThemeAppearance,
  type DesktopThemeSource
} from "../../../../../shared/theme/index.ts";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { WorkspaceAgentSkillsSettings } from "./WorkspaceAgentSkillsSettings";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { CustomWallpaperImageError } from "../services/customWallpaper";
import {
  customWorkspaceWallpaperId,
  getWorkspaceWallpaperOption,
  workspaceWallpaperDisplayModeTitleKey,
  type WorkspaceWallpaperDisplayMode,
  type WorkspaceWallpaperId,
  workspaceWallpaperDisplayModes,
  workspaceWallpaperOptions
} from "../services/workspaceWallpaper";

const workspaceSettingsSelectTriggerClass =
  "w-full h-8 rounded-[6px] border-0 bg-[var(--transparency-block)] px-3 text-[13px] font-normal text-[var(--text-primary)] !shadow-none !outline-none !ring-0 transition-colors duration-200 hover:bg-[var(--transparency-hover)] focus-visible:border-0 focus-visible:!ring-0";
const workspaceSettingsSelectContentClass =
  "w-[var(--radix-select-trigger-width)] rounded-[8px] border border-[var(--border-1)] bg-[var(--background-fronted)] px-1 text-[var(--text-primary)] shadow-[0_16px_40px_var(--shadow-elevated)] [--tutti-select-content-min-width:100%] !outline-none !ring-0";
const workspaceSettingsInputClass =
  "h-8 w-full rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] focus-visible:border-[var(--border-focus)]";

export function WorkspaceSettingsPanel({
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  workspace
}: {
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const {
    service: analyticsDebugPreferenceService,
    state: analyticsDebugPreferenceState
  } = useAnalyticsDebugPreferenceService();
  const { state: desktopPreferencesState } = useDesktopPreferencesService();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();

  useEffect(() => {
    if (settingsState.open) {
      settingsService.syncWorkspace({ id: workspace.id });
    }
  }, [settingsService, settingsState.open, workspace.id]);

  if (!settingsState.open) {
    return null;
  }

  return (
    <WorkspaceSettingsPanelPortal
      dialogOpen={false}
      onClose={() => {
        settingsService.closePanel();
      }}
    >
      <section
        aria-labelledby="workspace-settings-title"
        aria-modal="true"
        className="grid h-[min(500px,calc(100vh-40px))] w-[min(760px,calc(100vw-40px))] origin-center grid-cols-[160px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-[var(--border-1)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-panel transition-[background,backdrop-filter,opacity] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.96] motion-safe:duration-[250ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none max-[760px]:h-[min(100vh-24px,520px)] max-[760px]:w-[min(calc(100vw-24px),640px)] max-[760px]:grid-cols-1 max-[760px]:grid-rows-[auto_auto_minmax(0,1fr)]"
        data-workspace-settings-panel="true"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="col-[1/-1] row-start-1 flex h-[54px] min-h-[54px] items-center justify-between border-b border-[var(--border-1)] px-[22px] py-[13px] max-[760px]:px-5">
          <h2
            id="workspace-settings-title"
            className="m-0 text-[15px] font-semibold leading-[1.3] text-[var(--text-primary)]"
          >
            {t("workspace.settings.title")}
          </h2>
          <Button
            aria-label={t("workspace.settings.close")}
            size="icon-sm"
            title={t("workspace.settings.close")}
            type="button"
            variant="ghost"
            onClick={() => {
              settingsService.closePanel();
            }}
          >
            <CloseIcon className="size-4" />
          </Button>
        </div>

        <aside
          aria-label={t("workspace.settings.nav.sectionsLabel")}
          className="col-start-1 row-start-2 flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-[var(--border-1)] bg-[var(--background-fronted)] px-3 pb-4 pt-3 max-[760px]:row-start-2 max-[760px]:overflow-x-auto max-[760px]:border-b max-[760px]:border-r-0 max-[760px]:px-3 max-[760px]:pb-3.5 max-[760px]:pt-5"
        >
          {[
            {
              id: "general" as const,
              label: t("workspace.settings.nav.general")
            },
            {
              id: "appearance" as const,
              label: t("workspace.settings.nav.appearance")
            },
            {
              id: "apps" as const,
              label: t("workspace.settings.nav.apps")
            },
            {
              id: "agent" as const,
              label: t("workspace.settings.nav.agent")
            },
            {
              id: "developer" as const,
              label: t("workspace.settings.nav.developer")
            }
          ].map((section) => {
            const selected = settingsState.activeSection === section.id;
            return (
              <button
                key={section.id}
                aria-pressed={selected}
                className={cn(
                  "block w-full min-w-0 truncate whitespace-nowrap rounded-md border-0 px-2.5 py-1.5 text-left text-[13px] font-semibold leading-[1.35] outline-none transition-colors duration-150 hover:bg-[var(--transparency-block)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]",
                  selected
                    ? "bg-[var(--transparency-block)] text-[var(--text-primary)]"
                    : "bg-transparent text-[var(--text-secondary)]"
                )}
                type="button"
                onClick={() => settingsService.selectSection(section.id)}
              >
                {section.label}
              </button>
            );
          })}
        </aside>

        <div className="col-start-2 row-start-2 flex min-h-0 flex-col max-[760px]:col-start-1 max-[760px]:row-start-3">
          <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto px-[22px] pb-[22px] pt-0 max-[760px]:px-5 max-[760px]:pb-6">
            {settingsState.activeSection === "general" ? (
              <WorkspaceGeneralSettingsSection
                changingDefaultAgentProvider={
                  desktopPreferencesState.changingDefaultAgentProvider
                }
                changingLocale={desktopPreferencesState.changingLocale}
                changingSleepPreventionMode={
                  desktopPreferencesState.changingSleepPreventionMode
                }
                defaultAgentProvider={
                  desktopPreferencesState.defaultAgentProvider
                }
                locale={desktopPreferencesState.locale}
                onDefaultAgentProviderChange={(provider) => {
                  void settingsService.changeDefaultAgentProvider(provider);
                }}
                onLocaleChange={(nextLocale) => {
                  void settingsService.changeLocale(nextLocale);
                }}
                onSleepPreventionModeChange={(mode) => {
                  void settingsService.changeSleepPreventionMode(mode);
                }}
                sleepPreventionMode={
                  desktopPreferencesState.sleepPreventionMode
                }
              />
            ) : settingsState.activeSection === "appearance" ? (
              <WorkspaceAppearanceSettingsSection
                changingDockPlacement={
                  desktopPreferencesState.changingDockPlacement
                }
                changingThemeSource={
                  desktopPreferencesState.changingThemeSource
                }
                dockPlacement={desktopPreferencesState.dockPlacement}
                onDockPlacementChange={(placement) => {
                  void settingsService.changeDockPlacement(placement);
                }}
                onSelectWallpaper={onSelectWallpaper}
                onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
                onThemeChange={(nextThemeSource) => {
                  void settingsService.changeThemeSource(nextThemeSource);
                }}
                selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
                selectedWallpaperID={selectedWallpaperID}
                themeAppearance={desktopPreferencesState.theme.appearance}
                themeSource={desktopPreferencesState.theme.source}
              />
            ) : settingsState.activeSection === "apps" ? (
              <WorkspaceAppsSettingsSection
                managedModels={settingsState.managedModels}
                onDeleteProvider={(providerID) => {
                  void settingsService.removeManagedModelProvider(providerID);
                }}
                onDetectProviderModels={(providerID) => {
                  void settingsService.detectManagedModelProviderModels(
                    providerID
                  );
                }}
                onSaveProvider={(provider) => {
                  void settingsService.saveManagedModelProvider(provider);
                }}
                onUpdateProvider={(providerID, patch) => {
                  settingsService.updateManagedModelProviderDraft(
                    providerID,
                    patch
                  );
                }}
              />
            ) : settingsState.activeSection === "agent" ? (
              <WorkspaceAgentSkillsSettings workspaceId={workspace.id} />
            ) : (
              <WorkspaceDeveloperSettingsSection
                analyticsDebugAvailable={
                  analyticsDebugPreferenceState.available
                }
                analyticsDebugEnabled={analyticsDebugPreferenceState.enabled}
                developerLogs={settingsState.developerLogs}
                onAnalyticsDebugEnabledChange={(enabled) => {
                  analyticsDebugPreferenceService.setEnabled(enabled);
                }}
                onClearLogs={() => {
                  void settingsService.clearDeveloperLogs();
                }}
                onExportLogs={() => {
                  void settingsService.exportDeveloperLogs();
                }}
              />
            )}
          </div>
        </div>
      </section>
    </WorkspaceSettingsPanelPortal>
  );
}

const managedModelProviderLabels: Record<
  WorkspaceManagedModelProviderID,
  string
> = {
  agnes: "Agnes",
  anthropic: "Anthropic",
  openai: "OpenAI"
};

type ManagedModelProviderPreset = {
  provider: WorkspaceManagedModelProviderID;
  labelKey: DesktopI18nKey;
  baseUrl: string;
  apiKeyUrl: string;
  models: readonly string[];
};

const CUSTOM_MANAGED_MODEL_PROVIDER_PRESET = "__custom_provider__";
const AGNES_API_KEYS_URL = "https://platform.agnes-ai.com/settings/apiKeys";
const ANTHROPIC_API_KEYS_URL = "https://console.anthropic.com/settings/keys";
const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys";
const MINIMAX_API_KEYS_URL = "https://platform.minimax.io/console/access";
const MIMO_API_KEYS_URL = "https://platform.xiaomimimo.com/console/api-keys";
const OPENAI_API_KEYS_URL = "https://platform.openai.com/api-keys";

const managedModelProviderPresets: readonly ManagedModelProviderPreset[] = [
  {
    provider: "agnes",
    labelKey: "workspace.settings.apps.managedModels.presetLabels.agnes",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    apiKeyUrl: AGNES_API_KEYS_URL,
    models: ["agnes-2.0-flash", "agnes-1.5-flash"]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.anthropicClaude",
    baseUrl: "https://api.anthropic.com",
    apiKeyUrl: ANTHROPIC_API_KEYS_URL,
    models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.deepseekAnthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKeyUrl: DEEPSEEK_API_KEYS_URL,
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner"
    ]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.minimaxAnthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiKeyUrl: MINIMAX_API_KEYS_URL,
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2"
    ]
  },
  {
    provider: "openai",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.openaiOfficial",
    baseUrl: "https://api.openai.com/v1",
    apiKeyUrl: OPENAI_API_KEYS_URL,
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
  },
  {
    provider: "openai",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.deepseekOpenai",
    baseUrl: "https://api.deepseek.com",
    apiKeyUrl: DEEPSEEK_API_KEYS_URL,
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner"
    ]
  },
  {
    provider: "openai",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.minimaxOpenai",
    baseUrl: "https://api.minimaxi.com/v1",
    apiKeyUrl: MINIMAX_API_KEYS_URL,
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2"
    ]
  },
  {
    provider: "openai",
    labelKey: "workspace.settings.apps.managedModels.presetLabels.mimoOpenai",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    apiKeyUrl: MIMO_API_KEYS_URL,
    models: ["mimo-v2.5-pro"]
  },
  {
    provider: "anthropic",
    labelKey:
      "workspace.settings.apps.managedModels.presetLabels.mimoAnthropic",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    apiKeyUrl: MIMO_API_KEYS_URL,
    models: ["mimo-v2.5-pro"]
  }
];

function defaultManagedProviderBaseUrl(
  provider: WorkspaceManagedModelProviderID
): string {
  switch (provider) {
    case "agnes":
      return "https://apihub.agnes-ai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "openai":
      return "https://api.openai.com/v1";
  }
}

function defaultManagedProviderModel(
  provider: WorkspaceManagedModelProviderID
): string {
  switch (provider) {
    case "agnes":
      return "agnes-2.0-flash";
    case "anthropic":
      return "claude-sonnet-4-6";
    case "openai":
      return "gpt-5.5";
  }
}

function getManagedModelProviderPresets(
  provider: WorkspaceManagedModelProviderID
): ManagedModelProviderPreset[] {
  return managedModelProviderPresets.filter(
    (preset) => preset.provider === provider
  );
}

function getSelectedManagedModelProviderPreset(
  provider: WorkspaceManagedModelProviderID,
  baseUrl: string | undefined
): ManagedModelProviderPreset | null {
  const currentBaseUrl = baseUrl?.trim() ?? "";
  if (!currentBaseUrl) {
    return null;
  }
  return (
    managedModelProviderPresets.find(
      (preset) =>
        preset.provider === provider && preset.baseUrl === currentBaseUrl
    ) ?? null
  );
}

function toManagedModelPresetRows(
  preset: ManagedModelProviderPreset
): WorkspaceManagedModel[] {
  return preset.models.map((id) => ({
    id,
    name: id,
    provider: preset.provider
  }));
}

function hasDeletableManagedModelProvider(
  provider: WorkspaceManagedModelProviderDraft
): boolean {
  return (
    provider.hasApiKey ||
    provider.apiKey.trim().length > 0 ||
    (provider.baseUrl?.trim().length ?? 0) > 0 ||
    provider.models.length > 0 ||
    Boolean(provider.updatedAt || provider.workspaceId)
  );
}

function normalizeWorkspaceManagedModelRows(
  provider: WorkspaceManagedModelProviderID,
  models: readonly WorkspaceManagedModel[]
): WorkspaceManagedModel[] {
  const seen = new Set<string>();
  const normalized: WorkspaceManagedModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      id,
      name: model.name.trim() || id,
      provider
    });
  }
  return normalized;
}

function WorkspaceAppsSettingsSection({
  managedModels,
  onDeleteProvider,
  onDetectProviderModels,
  onSaveProvider,
  onUpdateProvider
}: {
  managedModels: WorkspaceSettingsManagedModelsSnapshotState;
  onDeleteProvider: (providerID: WorkspaceManagedModelProviderID) => void;
  onDetectProviderModels: (providerID: WorkspaceManagedModelProviderID) => void;
  onSaveProvider: (provider: WorkspaceManagedModelProviderDraft) => void;
  onUpdateProvider: (
    providerID: WorkspaceManagedModelProviderID,
    patch: Partial<WorkspaceManagedModelProviderDraft>
  ) => void;
}) {
  const { t } = useTranslation();
  const [selectedProviderID, setSelectedProviderID] =
    useState<WorkspaceManagedModelProviderID | null>(
      managedModels.focusedProvider ??
        managedModels.providers[0]?.provider ??
        null
    );
  const [visibleAPIKeyProviderID, setVisibleAPIKeyProviderID] =
    useState<WorkspaceManagedModelProviderID | null>(null);
  const [newModelID, setNewModelID] = useState("");

  useEffect(() => {
    const providerID = managedModels.focusedProvider;
    if (
      !providerID ||
      !managedModels.providers.some(
        (provider) => provider.provider === providerID
      )
    ) {
      return;
    }
    setSelectedProviderID(providerID);
  }, [
    managedModels.focusedProvider,
    managedModels.focusRequestID,
    managedModels.providers
  ]);

  useEffect(() => {
    if (managedModels.providers.length === 0) {
      setSelectedProviderID(null);
      return;
    }
    if (
      selectedProviderID &&
      managedModels.providers.some(
        (provider) => provider.provider === selectedProviderID
      )
    ) {
      return;
    }
    setSelectedProviderID(managedModels.providers[0]?.provider ?? null);
  }, [managedModels.providers, selectedProviderID]);

  const selectedProvider =
    managedModels.providers.find(
      (provider) => provider.provider === selectedProviderID
    ) ??
    managedModels.providers[0] ??
    null;
  const selectedProviderPresets = selectedProvider
    ? getManagedModelProviderPresets(selectedProvider.provider)
    : [];
  const selectedProviderPreset = selectedProvider
    ? getSelectedManagedModelProviderPreset(
        selectedProvider.provider,
        selectedProvider.baseUrl
      )
    : null;
  const selectedPresetValue =
    selectedProviderPreset?.baseUrl ?? CUSTOM_MANAGED_MODEL_PROVIDER_PRESET;
  const selectedApiKeyPreset =
    selectedProviderPresets.length === 1
      ? selectedProviderPresets[0]
      : selectedProviderPreset;
  const apiKeyUrl = selectedApiKeyPreset?.apiKeyUrl ?? "";
  const apiKeyVisible =
    selectedProvider !== null &&
    visibleAPIKeyProviderID === selectedProvider.provider;
  const canDeleteSelectedProvider =
    selectedProvider !== null &&
    hasDeletableManagedModelProvider(selectedProvider);

  useEffect(() => {
    setNewModelID("");
  }, [selectedProvider?.provider]);

  const updateModels = (models: readonly WorkspaceManagedModel[]) => {
    if (!selectedProvider) {
      return;
    }
    onUpdateProvider(selectedProvider.provider, {
      models: normalizeWorkspaceManagedModelRows(
        selectedProvider.provider,
        models
      )
    });
  };
  const updateModelAt = (index: number, id: string) => {
    if (!selectedProvider) {
      return;
    }
    updateModels(
      selectedProvider.models.map((model, modelIndex) =>
        modelIndex === index
          ? {
              ...model,
              id,
              name: id.trim() || model.name
            }
          : model
      )
    );
  };
  const removeModelAt = (index: number) => {
    if (!selectedProvider) {
      return;
    }
    updateModels(
      selectedProvider.models.filter((_, modelIndex) => modelIndex !== index)
    );
  };
  const addModel = () => {
    if (!selectedProvider) {
      return;
    }
    const id = newModelID.trim();
    if (!id) {
      return;
    }
    updateModels([
      ...selectedProvider.models,
      {
        id,
        name: id,
        provider: selectedProvider.provider
      }
    ]);
    setNewModelID("");
  };

  return (
    <SettingsRows>
      <div className="flex w-full flex-col gap-2">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.apps.managedModels.title")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.35] text-[var(--text-secondary)]">
          {t("workspace.settings.apps.managedModels.description")}
        </p>
      </div>

      <div
        aria-label={t("workspace.settings.apps.managedModels.title")}
        className="flex flex-wrap gap-2"
        role="tablist"
      >
        {managedModels.providers.map((provider) => {
          const selected = selectedProvider?.provider === provider.provider;
          return (
            <button
              key={provider.provider}
              aria-selected={selected}
              className={cn(
                "inline-flex h-9 min-w-[96px] items-center justify-center rounded-full border px-4 text-[13px] font-medium outline-none transition-[background,border-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
                selected
                  ? "border-[var(--border-1)] bg-[var(--transparency-block)] text-[var(--text-primary)] shadow-none"
                  : "border-[var(--border-1)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
              )}
              role="tab"
              type="button"
              onClick={() => setSelectedProviderID(provider.provider)}
            >
              {managedModelProviderLabels[provider.provider]}
            </button>
          );
        })}
      </div>

      {selectedProvider ? (
        <section className="flex w-full flex-col gap-4 rounded-[10px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
                {managedModelProviderLabels[selectedProvider.provider]}
              </strong>
              <p className="m-0 mt-1 text-[11px] leading-[1.3] text-[var(--text-secondary)]">
                {selectedProvider.hasApiKey
                  ? t("workspace.settings.apps.managedModels.keyConfigured")
                  : t("workspace.settings.apps.managedModels.keyMissing")}
              </p>
            </div>
            <Switch
              aria-label={t("workspace.settings.apps.managedModels.enabled", {
                provider: managedModelProviderLabels[selectedProvider.provider]
              })}
              checked={selectedProvider.enabled}
              onCheckedChange={(enabled) =>
                onUpdateProvider(selectedProvider.provider, { enabled })
              }
            />
          </div>

          {selectedProviderPresets.length > 1 ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                {t("workspace.settings.apps.managedModels.quickFillProvider")}
              </span>
              <Select
                value={selectedPresetValue}
                onValueChange={(value) => {
                  if (value === CUSTOM_MANAGED_MODEL_PROVIDER_PRESET) {
                    onUpdateProvider(selectedProvider.provider, {
                      baseUrl: "",
                      models: []
                    });
                    return;
                  }
                  const preset = selectedProviderPresets.find(
                    (candidate) => candidate.baseUrl === value
                  );
                  if (!preset) {
                    return;
                  }
                  onUpdateProvider(selectedProvider.provider, {
                    baseUrl: preset.baseUrl,
                    models: normalizeWorkspaceManagedModelRows(
                      selectedProvider.provider,
                      toManagedModelPresetRows(preset)
                    )
                  });
                }}
              >
                <SelectTrigger
                  aria-label={t(
                    "workspace.settings.apps.managedModels.quickFillProvider"
                  )}
                  className={workspaceSettingsSelectTriggerClass}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  className={workspaceSettingsSelectContentClass}
                  style={{ zIndex: "var(--z-panel-popover)" }}
                >
                  <SelectItem value={CUSTOM_MANAGED_MODEL_PROVIDER_PRESET}>
                    {t("workspace.settings.apps.managedModels.customProvider")}
                  </SelectItem>
                  {selectedProviderPresets.map((preset) => (
                    <SelectItem key={preset.baseUrl} value={preset.baseUrl}>
                      {t(preset.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}

          <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                {t("workspace.settings.apps.managedModels.apiKey")}
              </span>
              <div className="relative">
                <input
                  className={`${workspaceSettingsInputClass} pr-9`}
                  placeholder={
                    selectedProvider.hasApiKey
                      ? t(
                          "workspace.settings.apps.managedModels.keepExistingKey"
                        )
                      : "sk-..."
                  }
                  spellCheck={false}
                  type={apiKeyVisible ? "text" : "password"}
                  value={selectedProvider.apiKey}
                  onChange={(event) =>
                    onUpdateProvider(selectedProvider.provider, {
                      apiKey: event.currentTarget.value
                    })
                  }
                />
                <button
                  aria-label={t(
                    apiKeyVisible
                      ? "workspace.settings.apps.managedModels.hideApiKey"
                      : "workspace.settings.apps.managedModels.showApiKey"
                  )}
                  aria-pressed={apiKeyVisible}
                  className={cn(
                    "absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[5px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
                    apiKeyVisible && "text-[var(--text-primary)]"
                  )}
                  type="button"
                  onClick={() =>
                    setVisibleAPIKeyProviderID((currentProviderID) =>
                      currentProviderID === selectedProvider.provider
                        ? null
                        : selectedProvider.provider
                    )
                  }
                >
                  <EyeIcon aria-hidden="true" size={16} />
                </button>
              </div>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                {t("workspace.settings.apps.managedModels.baseUrl")}
              </span>
              <input
                className={workspaceSettingsInputClass}
                placeholder={defaultManagedProviderBaseUrl(
                  selectedProvider.provider
                )}
                type="url"
                value={selectedProvider.baseUrl ?? ""}
                onChange={(event) =>
                  onUpdateProvider(selectedProvider.provider, {
                    baseUrl: event.currentTarget.value
                  })
                }
              />
            </label>
          </div>

          {apiKeyUrl ? (
            <button
              className="inline-flex w-fit items-center gap-1.5 rounded-[5px] text-left text-[12px] font-medium text-[var(--text-primary)] underline underline-offset-4 transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
              type="button"
              onClick={() => {
                window.open(apiKeyUrl, "_blank", "noopener,noreferrer");
              }}
            >
              {t("workspace.settings.apps.managedModels.getApiKey", {
                provider:
                  (selectedApiKeyPreset
                    ? t(selectedApiKeyPreset.labelKey)
                    : null) ??
                  managedModelProviderLabels[selectedProvider.provider]
              })}
              <LinkIcon aria-hidden="true" size={13} />
            </button>
          ) : null}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                {t("workspace.settings.apps.managedModels.models")}
              </span>
              <Button
                disabled={
                  managedModels.detectingProvider === selectedProvider.provider
                }
                size="sm"
                type="button"
                variant="secondary"
                onClick={() =>
                  onDetectProviderModels(selectedProvider.provider)
                }
              >
                {managedModels.detectingProvider === selectedProvider.provider
                  ? t("workspace.settings.apps.managedModels.detectingModels")
                  : t("workspace.settings.apps.managedModels.detectModels")}
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              {selectedProvider.models.map((model, index) => (
                <div
                  key={`${model.provider}:${model.id}:${index}`}
                  className="grid grid-cols-[72px_minmax(0,1fr)_32px] items-center gap-1.5"
                >
                  <span className="flex h-8 items-center justify-center rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-2 text-[11px] text-[var(--text-secondary)]">
                    {selectedProvider.provider}:
                  </span>
                  <input
                    aria-label={t(
                      "workspace.settings.apps.managedModels.modelId"
                    )}
                    className={workspaceSettingsInputClass}
                    placeholder={defaultManagedProviderModel(
                      selectedProvider.provider
                    )}
                    value={model.id}
                    onChange={(event) =>
                      updateModelAt(index, event.currentTarget.value)
                    }
                  />
                  <button
                    aria-label={t(
                      "workspace.settings.apps.managedModels.removeModel"
                    )}
                    className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                    type="button"
                    onClick={() => removeModelAt(index)}
                  >
                    <DeleteIcon aria-hidden="true" size={15} />
                  </button>
                </div>
              ))}
              <div className="grid grid-cols-[72px_minmax(0,1fr)_72px] items-center gap-1.5">
                <span className="flex h-8 items-center justify-center rounded-[6px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-2 text-[11px] text-[var(--text-secondary)]">
                  {selectedProvider.provider}:
                </span>
                <input
                  aria-label={t(
                    "workspace.settings.apps.managedModels.modelId"
                  )}
                  className={workspaceSettingsInputClass}
                  placeholder={t(
                    "workspace.settings.apps.managedModels.modelIdPlaceholder"
                  )}
                  value={newModelID}
                  onChange={(event) => setNewModelID(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addModel();
                    }
                  }}
                />
                <Button
                  disabled={!newModelID.trim()}
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={addModel}
                >
                  <AddIcon className="size-3.5" />
                  {t("workspace.settings.apps.managedModels.addModel")}
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            {canDeleteSelectedProvider ? (
              <Button
                disabled={
                  managedModels.deletingProvider === selectedProvider.provider
                }
                type="button"
                variant="secondary"
                onClick={() => onDeleteProvider(selectedProvider.provider)}
              >
                {managedModels.deletingProvider === selectedProvider.provider
                  ? t("workspace.settings.apps.managedModels.deleting")
                  : t("workspace.settings.apps.managedModels.delete")}
              </Button>
            ) : null}
            <Button
              disabled={
                managedModels.savingProvider === selectedProvider.provider
              }
              type="button"
              onClick={() => onSaveProvider(selectedProvider)}
            >
              {managedModels.savingProvider === selectedProvider.provider
                ? t("workspace.settings.apps.managedModels.saving")
                : t("workspace.settings.apps.managedModels.save")}
            </Button>
          </div>
        </section>
      ) : null}
    </SettingsRows>
  );
}

function WorkspaceDeveloperSettingsSection({
  analyticsDebugAvailable,
  analyticsDebugEnabled,
  developerLogs,
  onAnalyticsDebugEnabledChange,
  onClearLogs,
  onExportLogs
}: {
  analyticsDebugAvailable: boolean;
  analyticsDebugEnabled: boolean;
  developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  onAnalyticsDebugEnabledChange: (enabled: boolean) => void;
  onClearLogs: () => void;
  onExportLogs: () => void;
}) {
  const { t } = useTranslation();
  const logs = developerLogs.logs;

  return (
    <SettingsRows>
      <SettingsRow label={t("workspace.settings.developer.versionLabel")}>
        <p className="m-0 text-right font-mono text-[13px] text-[var(--text-secondary)] max-[560px]:text-left">
          {developerLogs.loading && logs === null
            ? t("common.loading")
            : (logs?.desktopVersion ?? "0.0.0")}
        </p>
      </SettingsRow>

      {analyticsDebugAvailable ? (
        <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
            <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
              {t("workspace.settings.developer.analyticsDebugLabel")}
            </strong>
            <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
              {t("workspace.settings.developer.analyticsDebugDescription")}
            </p>
          </div>
          <Switch
            aria-label={t("workspace.settings.developer.analyticsDebugLabel")}
            checked={analyticsDebugEnabled}
            onCheckedChange={onAnalyticsDebugEnabledChange}
          />
        </div>
      ) : null}

      <SettingsRow label={t("workspace.settings.developer.logsSizeLabel")}>
        <p className="m-0 text-right text-[13px] leading-5 text-[var(--text-secondary)] max-[560px]:text-left">
          {developerLogs.loading || logs === null
            ? t("common.loading")
            : t("workspace.settings.developer.logsSummary", {
                count: String(logs.totalFiles),
                size: formatWorkspaceSettingsBytes(logs.totalSizeBytes)
              })}
        </p>
      </SettingsRow>

      <SettingsRow label={t("workspace.settings.developer.actionsLabel")}>
        <div className="flex flex-wrap justify-end gap-2 max-[560px]:justify-start">
          <Button
            variant="secondary"
            type="button"
            onClick={onExportLogs}
            disabled={developerLogs.exporting}
          >
            {developerLogs.exporting
              ? t("workspace.settings.developer.exportingLogs")
              : t("workspace.settings.developer.exportLogs")}
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={onClearLogs}
            disabled={developerLogs.clearing || developerLogs.exporting}
          >
            {developerLogs.clearing
              ? t("workspace.settings.developer.clearingLogs")
              : t("workspace.settings.developer.clearLogs")}
          </Button>
        </div>
      </SettingsRow>
    </SettingsRows>
  );
}

function WorkspaceSettingsPanelPortal({
  children,
  dialogOpen,
  onClose
}: {
  children: React.ReactNode;
  dialogOpen: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !dialogOpen) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dialogOpen, onClose]);

  const panel = (
    <div
      className="fixed inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--backdrop)_28%,transparent)] supports-backdrop-filter:backdrop-blur-sm transition-[background,backdrop-filter] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none"
      data-workspace-settings-backdrop="true"
      style={{ zIndex: "var(--z-panel)" }}
      onClick={onClose}
    >
      {children}
    </div>
  );

  if (typeof document === "undefined") {
    return panel;
  }

  return createPortal(panel, document.body);
}

function SettingsRows({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-8 pb-[22px] pt-5">{children}</div>
  );
}

function SettingsRow({
  children,
  label,
  valueClassName
}: {
  children: React.ReactNode;
  label: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="min-w-0">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {label}
        </strong>
      </div>
      <div
        className={cn(
          "flex min-w-0 justify-end max-[560px]:justify-start",
          valueClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}

function WorkspaceGeneralSettingsSection({
  changingDefaultAgentProvider,
  changingLocale,
  changingSleepPreventionMode,
  defaultAgentProvider,
  locale,
  onDefaultAgentProviderChange,
  onLocaleChange,
  onSleepPreventionModeChange,
  sleepPreventionMode
}: {
  changingDefaultAgentProvider: DesktopAgentProvider | null;
  changingLocale: DesktopLocale | null;
  changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  defaultAgentProvider: DesktopAgentProvider;
  locale: DesktopLocale;
  onDefaultAgentProviderChange: (provider: DesktopAgentProvider) => void;
  onLocaleChange: (locale: DesktopLocale) => void;
  onSleepPreventionModeChange: (mode: DesktopSleepPreventionMode) => void;
  sleepPreventionMode: DesktopSleepPreventionMode;
}) {
  const { t } = useTranslation();
  const isUpdatingLocale = changingLocale !== null;
  const pendingLocale = changingLocale ?? locale;
  const isUpdatingDefaultAgentProvider = changingDefaultAgentProvider !== null;
  const pendingDefaultAgentProvider =
    changingDefaultAgentProvider ?? defaultAgentProvider;
  const isUpdatingSleepPrevention = changingSleepPreventionMode !== null;
  const pendingSleepPreventionMode =
    changingSleepPreventionMode ?? sleepPreventionMode;

  return (
    <div className="flex flex-col gap-8 pb-[22px] pt-5">
      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.languageLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.general.languageDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingLocale}
            value={pendingLocale}
            onValueChange={(value) => onLocaleChange(value as DesktopLocale)}
          >
            <SelectTrigger
              aria-label={t("workspace.settings.general.languageLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopLocales.map((optionLocale) => (
                <SelectItem key={optionLocale} value={optionLocale}>
                  {optionLocale === "en"
                    ? t("workspace.settings.general.languageOptions.en")
                    : t("workspace.settings.general.languageOptions.zhCN")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.defaultAgentProviderLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.general.defaultAgentProviderDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingDefaultAgentProvider}
            value={pendingDefaultAgentProvider}
            onValueChange={(value) =>
              onDefaultAgentProviderChange(value as DesktopAgentProvider)
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.general.defaultAgentProviderLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {workspaceAgentGuiProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {resolveWorkspaceAgentGuiLabel(provider)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.preventSleepLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.general.preventSleepDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingSleepPrevention}
            value={pendingSleepPreventionMode}
            onValueChange={(value) =>
              onSleepPreventionModeChange(value as DesktopSleepPreventionMode)
            }
          >
            <SelectTrigger
              aria-label={t("workspace.settings.general.preventSleepLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopSleepPreventionModes.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode === "never"
                    ? t("workspace.settings.general.preventSleepOptions.never")
                    : mode === "whileAgentRunning"
                      ? t(
                          "workspace.settings.general.preventSleepOptions.whileAgentRunning"
                        )
                      : t(
                          "workspace.settings.general.preventSleepOptions.always"
                        )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function WorkspaceAppearanceSettingsSection({
  changingDockPlacement,
  changingThemeSource,
  dockPlacement,
  onDockPlacementChange,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  onThemeChange,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  themeAppearance,
  themeSource
}: {
  changingDockPlacement: DesktopDockPlacement | null;
  changingThemeSource: DesktopThemeSource | null;
  dockPlacement: DesktopDockPlacement;
  onDockPlacementChange: (placement: DesktopDockPlacement) => void;
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  onThemeChange: (source: DesktopThemeSource) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  themeAppearance: DesktopThemeAppearance;
  themeSource: DesktopThemeSource;
}) {
  const { t } = useTranslation();
  const isUpdatingTheme = changingThemeSource !== null;
  const pendingThemeSource = changingThemeSource ?? themeSource;
  const isUpdatingDockPlacement = changingDockPlacement !== null;
  const pendingDockPlacement = changingDockPlacement ?? dockPlacement;

  return (
    <div className="flex flex-col gap-8 pb-[22px] pt-5">
      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.themeLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.appearance.themeDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingTheme}
            value={pendingThemeSource}
            onValueChange={(value) =>
              onThemeChange(value as DesktopThemeSource)
            }
          >
            <SelectTrigger
              aria-label={t("workspace.settings.appearance.themeLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopThemeSources.map((optionThemeSource) => (
                <SelectItem key={optionThemeSource} value={optionThemeSource}>
                  {optionThemeSource === "system"
                    ? t("workspace.settings.appearance.themeOptions.system")
                    : optionThemeSource === "light"
                      ? t("workspace.settings.appearance.themeOptions.light")
                      : t("workspace.settings.appearance.themeOptions.dark")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.dockPlacementLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.appearance.dockPlacementDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingDockPlacement}
            value={pendingDockPlacement}
            onValueChange={(value) =>
              onDockPlacementChange(value as DesktopDockPlacement)
            }
          >
            <SelectTrigger
              aria-label={t("workspace.settings.appearance.dockPlacementLabel")}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopDockPlacements.map((placement) => (
                <SelectItem key={placement} value={placement}>
                  {placement === "bottom"
                    ? t(
                        "workspace.settings.appearance.dockPlacementOptions.bottom"
                      )
                    : t(
                        "workspace.settings.appearance.dockPlacementOptions.left"
                      )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-3">
        <div
          className="flex min-w-0 flex-col gap-1"
          id="workspace-settings-wallpaper-heading"
        >
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.wallpaperLabel")}
          </strong>
        </div>
        <WorkspaceWallpaperPicker
          onSelectWallpaper={onSelectWallpaper}
          onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
          selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
          selectedWallpaperID={selectedWallpaperID}
          themeAppearance={themeAppearance}
        />
      </div>
    </div>
  );
}

const wallpaperTileBaseClass =
  "relative block aspect-[16/10] w-full cursor-pointer overflow-hidden rounded-lg border-0 bg-transparent p-0 text-inherit shadow-none outline-none transition-transform duration-150 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]";
const wallpaperTileSelectedClass =
  "before:pointer-events-none before:absolute before:inset-0 before:z-[1] before:rounded-[inherit] before:border-2 before:border-primary before:opacity-0 before:content-['']";

function WorkspaceWallpaperPicker({
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  themeAppearance
}: {
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  themeAppearance: DesktopThemeAppearance;
}) {
  const { t } = useTranslation();
  const hostService = useWorkspaceWorkbenchHostService();
  const customWallpaper = useSyncExternalStore(
    (listener) => hostService.subscribeWallpaperChanges(listener),
    () => hostService.getCustomWallpaperSnapshot(),
    () => hostService.getCustomWallpaperSnapshot()
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isSaving = customWallpaper.status === "saving";
  const isRemoving = customWallpaper.status === "removing";
  const customSelected = selectedWallpaperID === customWorkspaceWallpaperId;

  const handleFilesSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }
    setUploadError(null);
    try {
      await hostService.uploadCustomWallpaper(file);
      onSelectWallpaper(customWorkspaceWallpaperId);
    } catch (error) {
      setUploadError(resolveWallpaperUploadErrorMessage(t, error));
    }
  };

  const handleRemoveCustom = async () => {
    setUploadError(null);
    try {
      await hostService.removeCustomWallpaper();
      if (selectedWallpaperID === customWorkspaceWallpaperId) {
        onSelectWallpaper("default");
      }
    } catch {
      setUploadError(t("workspace.settings.appearance.wallpaperRemoveFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        aria-labelledby="workspace-settings-wallpaper-heading"
        className="grid grid-cols-4 gap-2.5 max-[760px]:grid-cols-3 max-[560px]:grid-cols-2"
        role="listbox"
      >
        {workspaceWallpaperOptions.map((option) => {
          const resolvedOption = getWorkspaceWallpaperOption(
            option.id,
            themeAppearance
          );
          const selected = option.id === selectedWallpaperID;
          return (
            <button
              key={option.id}
              aria-label={t(option.titleKey)}
              aria-selected={selected}
              className={cn(
                wallpaperTileBaseClass,
                wallpaperTileSelectedClass,
                selected && "before:opacity-100"
              )}
              role="option"
              type="button"
              onClick={() => onSelectWallpaper(option.id)}
            >
              <img
                alt=""
                className="block size-full object-cover"
                draggable={false}
                src={resolvedOption.url}
              />
            </button>
          );
        })}

        {customWallpaper.exists && customWallpaper.thumbnailUrl ? (
          <div className="group relative">
            <button
              aria-label={t("workspace.wallpaper.options.custom")}
              aria-selected={customSelected}
              className={cn(
                wallpaperTileBaseClass,
                wallpaperTileSelectedClass,
                customSelected && "before:opacity-100"
              )}
              role="option"
              type="button"
              onClick={() => onSelectWallpaper(customWorkspaceWallpaperId)}
            >
              <img
                alt=""
                className="block size-full object-cover"
                draggable={false}
                src={customWallpaper.thumbnailUrl}
              />
            </button>
            <button
              aria-label={t("workspace.settings.appearance.wallpaperRemove")}
              className="absolute right-1 top-1 z-[2] inline-flex size-5 items-center justify-center rounded-full border-0 bg-black/55 text-white opacity-0 outline-none backdrop-blur-sm transition-opacity duration-150 hover:bg-black/70 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] group-hover:opacity-100"
              disabled={isRemoving}
              title={t("workspace.settings.appearance.wallpaperRemove")}
              type="button"
              onClick={() => {
                void handleRemoveCustom();
              }}
            >
              {isRemoving ? (
                <LoadingIcon className="size-3 animate-spin" />
              ) : (
                <CloseIcon className="size-3" />
              )}
            </button>
          </div>
        ) : null}

        <button
          aria-label={t("workspace.settings.appearance.wallpaperUpload")}
          className={cn(
            wallpaperTileBaseClass,
            "flex flex-col items-center justify-center gap-2 border border-dashed border-[var(--border-1)] bg-[var(--transparency-block)] px-3 text-center text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] disabled:cursor-default disabled:opacity-60"
          )}
          disabled={isSaving}
          title={t("workspace.settings.appearance.wallpaperUpload")}
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          {isSaving ? (
            <LoadingIcon className="size-4 animate-spin" />
          ) : (
            <UploadIcon className="size-4" />
          )}
          <span className="max-w-full whitespace-normal text-[11px] font-medium leading-tight">
            {isSaving
              ? t("workspace.settings.appearance.wallpaperUploading")
              : t("workspace.settings.appearance.wallpaperUpload")}
          </span>
        </button>
      </div>

      <input
        accept="image/png,image/jpeg,image/webp,image/heic,image/heif,image/*"
        className="hidden"
        ref={fileInputRef}
        type="file"
        onChange={(event) => {
          void handleFilesSelected(event);
        }}
      />

      {customWallpaper.exists && customSelected ? (
        <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
          <div className="min-w-0">
            <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
              {t("workspace.settings.appearance.wallpaperDisplayModeLabel")}
            </strong>
          </div>
          <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
            <Select
              value={selectedWallpaperDisplayMode}
              onValueChange={(value) =>
                onSelectWallpaperDisplayMode(
                  value as WorkspaceWallpaperDisplayMode
                )
              }
            >
              <SelectTrigger
                aria-label={t(
                  "workspace.settings.appearance.wallpaperDisplayModeLabel"
                )}
                className={workspaceSettingsSelectTriggerClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className={workspaceSettingsSelectContentClass}
                style={{ zIndex: "var(--z-panel-popover)" }}
              >
                {workspaceWallpaperDisplayModes.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(workspaceWallpaperDisplayModeTitleKey(mode))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      {uploadError ? (
        <p className="m-0 text-[11px] leading-[1.4] text-[var(--state-danger)]">
          {uploadError}
        </p>
      ) : null}
    </div>
  );
}

function resolveWallpaperUploadErrorMessage(
  t: ReturnType<typeof useTranslation>["t"],
  error: unknown
): string {
  if (error instanceof CustomWallpaperImageError) {
    if (error.code === "unsupported-type") {
      return t("workspace.settings.appearance.wallpaperUploadErrorType");
    }
    if (error.code === "too-large") {
      return t("workspace.settings.appearance.wallpaperUploadErrorTooLarge");
    }
  }
  return t("workspace.settings.appearance.wallpaperUploadError");
}
