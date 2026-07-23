import type * as React from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { createPortal } from "react-dom";
import { useService } from "@tutti-os/infra/di";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import { INotificationService } from "@tutti-os/ui-notifications";
import type {
  DesktopComputerUsePermissionPane,
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseStatus
} from "@shared/contracts/ipc";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  AskLinedIcon,
  Button,
  CheckIcon,
  CloseIcon,
  DeleteIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  GitHubBrandIcon,
  ImportLinedIcon,
  Input,
  LoadingIcon,
  RadioIndicator,
  SectionTabs,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusDot,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UploadIcon,
  WebIcon
} from "@tutti-os/ui-system";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import {
  setAgentDiagnosticsConsent,
  useAgentDiagnosticsConsent
} from "@renderer/lib/agentDiagnosticsConsent";
import type { WorkspaceSettingsDeveloperLogsSnapshotState } from "../services/workspaceSettingsTypes";
import type { WorkspaceSettingsGeneralFocusAnchor } from "../services/workspaceSettingsTypes";
import {
  desktopLocales,
  type DesktopI18nKey,
  type DesktopLocale
} from "../../../../../shared/i18n/index.ts";
import {
  type DesktopDefaultAgentProvider,
  desktopAgentConversationDetailModes,
  deletedAgentConversationRetentionDaysOptions,
  desktopBrowserUseConnectionModes,
  desktopDockPlacements,
  desktopMinimizeAnimations,
  desktopSleepPreventionModes,
  desktopWorkspaceUiModes,
  desktopWorkbenchWindowSnappingShortcutPresets,
  formatDesktopShortcutBinding,
  type DesktopAgentConversationDetailMode,
  type DesktopBrowserUseConnectionMode,
  type DesktopDockPlacement,
  type DeletedAgentConversationRetentionDays,
  type DesktopFeatureFlags,
  type DesktopWorkspaceUiMode,
  type DesktopMinimizeAnimation,
  type DesktopSleepPreventionMode,
  type DesktopWorkbenchShortcuts,
  type DesktopWorkbenchWindowSnapping,
  type DesktopWorkbenchWindowSnappingShortcutPreset
} from "../../../../../shared/preferences/index.ts";
import {
  EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG,
  isFeatureEnabled,
  LAB_ENABLED_FLAG,
  LAB_MODEL_PLANS_FLAG,
  LAB_WORKBENCH_SHORTCUTS_FLAG,
  LAB_AUTOMATION_RULES_FLAG,
  LAB_WORKSPACE_AGENTS_FLAG,
  resolveDesktopWorkspaceUiMode
} from "../../../../../shared/featureFlags/catalog.ts";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog";
import { IAgentEnvService } from "../../workspace-agent/services/agentEnvService.interface.ts";
import { IAgentsService } from "../../workspace-agent/services/agentsService.interface.ts";
import { IAgentProviderStatusService } from "../../workspace-agent/services/agentProviderStatusService.interface.ts";
import { WorkspaceAgentsSettingsTab } from "./WorkspaceAgentsSettingsTab.tsx";
import {
  desktopThemeSources,
  type DesktopThemeAppearance,
  type DesktopThemeSource
} from "../../../../../shared/theme/index.ts";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { useAccountService } from "./useAccountService";
import { WorkspaceDeveloperSettingsSection } from "./WorkspaceDeveloperSettingsSection";
import { WorkspaceLabFeatureGateRows } from "./WorkspaceLabFeatureGateRows";
import { WorkspaceAgentsSection } from "./WorkspaceAgentsSection";
import { WorkspaceAutomationRulesSection } from "./WorkspaceAutomationRulesSection";
import { SettingsRows } from "./WorkspaceSettingsRows";
import {
  normalizeWorkspaceSettingsDefaultAgentProvider,
  workspaceSettingsDefaultAgentProviders
} from "./workspaceSettingsDefaultAgentProviders";
import {
  WorkspaceSettingsActionButton,
  workspaceSettingsControlColumnClass
} from "./WorkspaceSettingsActionButton";
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
import { WorkspaceModelPlansSection } from "./WorkspaceModelPlansSection";
import {
  workspaceSettingsInputClass,
  workspaceSettingsSelectContentClass,
  workspaceSettingsSelectTriggerClass
} from "./workspaceSettingsFieldStyles";

const developerPanelUnlockTaps = 7;
const computerUseOperationSettleMs = 280;
const computerUseAutoCheckIntervalMs = 1_500;
const computerUseAutoCheckMaxMs = 120_000;
const computerUseFocusRefreshMinIntervalMs = 5_000;
const tuttiWebsiteUrl = "https://tutti.sh/";
const tuttiGitHubUrl = "https://github.com/tutti-os/tutti";
const tuttiDesktopIconUrl = new URL(
  "../../../../../../build/icon.png",
  import.meta.url
).href;
// Screen recording of the System Settings permission row (icon © Cua AI,
// Inc., MIT) showing the CuaDriver toggle being switched on — the exact
// action users must perform after "Open Settings".
const cuaDriverToggleDemoUrl = new URL(
  "../../../assets/cua-driver-toggle-demo.gif",
  import.meta.url
).href;
export function WorkspaceSettingsPanel({
  onOpenExternalAgentImport,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  workspace
}: {
  onOpenExternalAgentImport: () => void;
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const notifications = useService(INotificationService);
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();
  const versionTapCountRef = useRef(0);
  const pendingFeatureFlags =
    desktopPreferencesState.changingFeatureFlags ??
    desktopPreferencesState.featureFlags;
  const labSectionVisible =
    settingsState.developerPanelVisible &&
    isFeatureEnabled(pendingFeatureFlags, LAB_ENABLED_FLAG);
  const earlyAccessIntegrationsEnabled = isFeatureEnabled(
    pendingFeatureFlags,
    EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG
  );
  const agentsService = useService(IAgentsService);
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const agentEnvService = useService(IAgentEnvService);
  const modelPlansEnabled = isFeatureEnabled(
    pendingFeatureFlags,
    LAB_MODEL_PLANS_FLAG
  );
  const workspaceAgentsEnabled = isFeatureEnabled(
    pendingFeatureFlags,
    LAB_WORKSPACE_AGENTS_FLAG
  );
  const automationRulesEnabled = isFeatureEnabled(
    pendingFeatureFlags,
    LAB_AUTOMATION_RULES_FLAG
  );

  useEffect(() => {
    if (settingsState.open) {
      settingsService.syncWorkspace({ id: workspace.id });
    }
  }, [settingsService, settingsState.open, workspace.id]);

  useEffect(() => {
    if (!labSectionVisible && settingsState.activeSection === "lab") {
      settingsService.selectSection("general");
    }
  }, [labSectionVisible, settingsService, settingsState.activeSection]);

  useEffect(() => {
    if (!modelPlansEnabled && settingsState.activeSection === "model") {
      settingsService.selectSection("general");
    }
  }, [modelPlansEnabled, settingsService, settingsState.activeSection]);

  useEffect(() => {
    if (
      (!workspaceAgentsEnabled && settingsState.agentTab === "customAgents") ||
      (!automationRulesEnabled && settingsState.agentTab === "automation")
    ) {
      settingsService.selectAgentTab("general");
    }
  }, [
    automationRulesEnabled,
    settingsService,
    settingsState.agentTab,
    workspaceAgentsEnabled
  ]);

  const handleVersionTap = () => {
    if (settingsState.developerPanelVisible) {
      return;
    }

    versionTapCountRef.current += 1;
    if (versionTapCountRef.current >= developerPanelUnlockTaps) {
      versionTapCountRef.current = 0;
      settingsService.setDeveloperPanelVisible(true);
      notifications.success({
        title: t("workspace.settings.about.developerModeEnabled")
      });
    }
  };

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
        className="relative z-[1] grid h-[min(640px,calc(100vh-40px))] w-[min(960px,calc(100vw-40px))] origin-center grid-cols-[160px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-[var(--border-1)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-panel transition-[background,opacity] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.96] motion-safe:duration-[250ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none max-[1279px]:h-[min(500px,calc(100vh-40px))] max-[1279px]:w-[min(760px,calc(100vw-40px))] max-[959px]:h-[min(480px,calc(100vh-40px))] max-[959px]:w-[min(640px,calc(100vw-40px))] max-[760px]:h-[min(100vh-24px,480px)] max-[760px]:w-[min(calc(100vw-24px),640px)] min-[420px]:max-[640px]:!w-[480px]"
        data-workspace-settings-panel="true"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="col-[1/-1] row-start-1 flex h-[54px] min-h-[54px] items-center justify-between border-b border-[var(--border-1)] px-[22px] py-[13px]">
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
          className="col-start-1 row-start-2 flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-[var(--border-1)] bg-[var(--background-fronted)] px-3 pb-4 pt-3"
        >
          {[
            {
              id: "general" as const,
              label: t("workspace.settings.nav.general")
            },
            {
              id: "agent" as const,
              label: t("workspace.settings.nav.agent")
            },
            ...(modelPlansEnabled
              ? [
                  {
                    id: "model" as const,
                    label: t("workspace.settings.nav.model")
                  }
                ]
              : []),
            {
              id: "appearance" as const,
              label: t("workspace.settings.nav.appearance")
            },
            ...(settingsState.tuttiAgentSwitchEnabled
              ? [
                  {
                    id: "account" as const,
                    label: t("workspace.settings.nav.account")
                  }
                ]
              : []),
            {
              id: "about" as const,
              label: t("workspace.settings.nav.about")
            },
            ...(settingsState.developerPanelVisible
              ? [
                  {
                    id: "developer" as const,
                    label: t("workspace.settings.nav.developer")
                  }
                ]
              : []),
            ...(labSectionVisible
              ? [
                  {
                    id: "lab" as const,
                    label: t("workspace.settings.nav.lab")
                  }
                ]
              : [])
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

        <div className="col-start-2 row-start-2 flex min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto px-[22px] pb-[22px] pt-0">
            {settingsState.activeSection === "general" ? (
              <WorkspaceGeneralSettingsSection
                changingFeatureFlags={
                  desktopPreferencesState.changingFeatureFlags
                }
                changingLocale={desktopPreferencesState.changingLocale}
                changingSleepPreventionMode={
                  desktopPreferencesState.changingSleepPreventionMode
                }
                changingDeletedAgentConversationRetentionDays={
                  desktopPreferencesState.changingDeletedAgentConversationRetentionDays
                }
                deletedAgentConversationRetentionDays={
                  desktopPreferencesState.deletedAgentConversationRetentionDays
                }
                featureFlags={desktopPreferencesState.featureFlags}
                locale={desktopPreferencesState.locale}
                onLocaleChange={(nextLocale) => {
                  void settingsService.changeLocale(nextLocale);
                }}
                onSleepPreventionModeChange={(mode) => {
                  void settingsService.changeSleepPreventionMode(mode);
                }}
                onDeletedAgentConversationRetentionDaysChange={(days) => {
                  void settingsService.changeDeletedAgentConversationRetentionDays(
                    days
                  );
                }}
                onPurgeDeletedConversations={() =>
                  settingsService.purgeDeletedConversations()
                }
                purgingDeletedConversations={
                  settingsState.purgingDeletedConversations
                }
                onWorkspaceUiModeChange={(mode) => {
                  void settingsService.changeWorkspaceUiMode(mode);
                }}
                sleepPreventionMode={
                  desktopPreferencesState.sleepPreventionMode
                }
              />
            ) : settingsState.activeSection === "agent" ? (
              <div className="flex min-h-0 flex-col gap-5 pt-5">
                <SectionTabs
                  ariaLabel={t("workspace.settings.nav.agent")}
                  className="h-8 shrink-0"
                  tabs={[
                    {
                      value: "general" as const,
                      label: t("workspace.settings.agent.tabs.general")
                    },
                    {
                      value: "agents" as const,
                      label: t("workspace.settings.agent.tabs.agents")
                    },
                    ...(workspaceAgentsEnabled
                      ? [
                          {
                            value: "customAgents" as const,
                            label: t(
                              "workspace.settings.agent.tabs.customAgents"
                            )
                          }
                        ]
                      : []),
                    ...(automationRulesEnabled
                      ? [
                          {
                            value: "automation" as const,
                            label: t("workspace.settings.agent.tabs.automation")
                          }
                        ]
                      : [])
                  ]}
                  value={settingsState.agentTab}
                  onValueChange={(tab) => settingsService.selectAgentTab(tab)}
                />
                {settingsState.agentTab === "agents" ? (
                  <WorkspaceAgentsSettingsTab
                    autoCheckEnabled={
                      desktopPreferencesState.agentCliUpdateCheckEnabled
                    }
                    autoCheckPending={
                      desktopPreferencesState.changingAgentCliUpdateCheckEnabled !==
                      null
                    }
                    agentProviderStatusService={agentProviderStatusService}
                    agentsService={agentsService}
                    focusProvider={settingsState.agentFocusProvider}
                    focusRequestID={settingsState.agentFocusRequestID}
                    tuttiAgentSwitchEnabled={
                      settingsState.tuttiAgentSwitchEnabled
                    }
                    earlyAccessEnabled={earlyAccessIntegrationsEnabled}
                    featureFlags={pendingFeatureFlags}
                    featureFlagsPending={
                      desktopPreferencesState.changingFeatureFlags !== null
                    }
                    onAgentEnabledChange={(agentTargetID, enabled) =>
                      settingsService.setAgentTargetEnabled(
                        agentTargetID,
                        enabled
                      )
                    }
                    onAutoCheckEnabledChange={(enabled) => {
                      void desktopPreferencesService
                        .setAgentCliUpdateCheckEnabled(enabled)
                        .catch((error) => {
                          notifications.error({
                            description:
                              error instanceof Error && error.message.trim()
                                ? error.message
                                : undefined,
                            title: t(
                              "workspace.settings.agent.agents.autoCheckUpdatesFailed"
                            )
                          });
                        });
                    }}
                    onExtensionEnabledChange={(flag, enabled) => {
                      return settingsService.changeFeatureFlags({
                        ...pendingFeatureFlags,
                        [flag]: enabled
                      });
                    }}
                    onOpenEnvironment={(provider) =>
                      agentEnvService.open({ focus: "detect", provider })
                    }
                  />
                ) : settingsState.agentTab === "customAgents" &&
                  workspaceAgentsEnabled ? (
                  <SettingsRows>
                    <WorkspaceAgentsSection />
                  </SettingsRows>
                ) : settingsState.agentTab === "automation" &&
                  automationRulesEnabled ? (
                  <SettingsRows>
                    <WorkspaceAutomationRulesSection />
                  </SettingsRows>
                ) : (
                  <WorkspaceAgentSettingsSection
                    agentConversationDetailMode={
                      desktopPreferencesState.agentConversationDetailMode
                    }
                    browserUseConnectionMode={
                      desktopPreferencesState.browserUseConnectionMode
                    }
                    changingAgentConversationDetailMode={
                      desktopPreferencesState.changingAgentConversationDetailMode
                    }
                    changingDefaultAgentProvider={
                      desktopPreferencesState.changingDefaultAgentProvider
                    }
                    changingBrowserUseConnectionMode={
                      desktopPreferencesState.changingBrowserUseConnectionMode
                    }
                    defaultAgentProvider={
                      desktopPreferencesState.defaultAgentProvider
                    }
                    focusedAnchor={settingsState.generalFocusAnchor}
                    focusRequestID={settingsState.generalFocusRequestID}
                    onBrowserUseConnectionModeChange={(mode) => {
                      void settingsService.changeBrowserUseConnectionMode(mode);
                    }}
                    onAgentConversationDetailModeChange={(mode) => {
                      void settingsService.changeAgentConversationDetailMode(
                        mode
                      );
                    }}
                    onDefaultAgentProviderChange={(provider) => {
                      void settingsService.changeDefaultAgentProvider(provider);
                    }}
                    onOpenExternalAgentImport={onOpenExternalAgentImport}
                  />
                )}
              </div>
            ) : settingsState.activeSection === "appearance" ? (
              <WorkspaceAppearanceSettingsSection
                changingDockPlacement={
                  desktopPreferencesState.changingDockPlacement
                }
                changingThemeSource={
                  desktopPreferencesState.changingThemeSource
                }
                changingMinimizeAnimation={
                  desktopPreferencesState.changingMinimizeAnimation
                }
                changingWorkbenchWindowSnapping={
                  desktopPreferencesState.changingWorkbenchWindowSnapping
                }
                dockPlacement={desktopPreferencesState.dockPlacement}
                minimizeAnimation={desktopPreferencesState.minimizeAnimation}
                onDockPlacementChange={(placement) => {
                  void settingsService.changeDockPlacement(placement);
                }}
                onMinimizeAnimationChange={(animation) => {
                  void settingsService.changeMinimizeAnimation(animation);
                }}
                onWorkbenchWindowSnappingChange={(value) => {
                  void settingsService.changeWorkbenchWindowSnapping(value);
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
                workbenchWindowSnapping={
                  desktopPreferencesState.workbenchWindowSnapping
                }
              />
            ) : settingsState.activeSection === "model" && modelPlansEnabled ? (
              <WorkspaceModelSettingsSection />
            ) : settingsState.activeSection === "lab" ? (
              <WorkspaceLabSettingsSection
                changingFeatureFlags={
                  desktopPreferencesState.changingFeatureFlags
                }
                featureFlags={desktopPreferencesState.featureFlags}
                workbenchShortcuts={desktopPreferencesState.workbenchShortcuts}
                onFeatureFlagsChange={(flags) => {
                  void settingsService.changeFeatureFlags(flags);
                }}
                onWorkbenchShortcutsChange={(shortcuts) => {
                  void settingsService.changeWorkbenchShortcuts(shortcuts);
                }}
              />
            ) : settingsState.activeSection === "account" ? (
              <WorkspaceAccountSettingsSection />
            ) : settingsState.activeSection === "about" ? (
              <WorkspaceAboutSettingsSection
                developerLogs={settingsState.developerLogs}
                onVersionTap={handleVersionTap}
              />
            ) : (
              <WorkspaceDeveloperSettingsSection />
            )}
          </div>
        </div>
      </section>
    </WorkspaceSettingsPanelPortal>
  );
}

function WorkspaceModelSettingsSection() {
  return (
    <SettingsRows>
      <WorkspaceModelPlansSection />
    </SettingsRows>
  );
}

function WorkspaceLabSettingsSection({
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
  const workbenchShortcutsEnabled = isFeatureEnabled(
    pendingFeatureFlags,
    LAB_WORKBENCH_SHORTCUTS_FLAG
  );

  // The two shortcut bindings live on a secondary page reached from the Labs
  // list; the toggle itself stays in the list. `labView` is a single-level
  // secondary view (no navigation stack), mirroring the panel's other in-place
  // view swaps. When the feature is turned off the secondary page becomes
  // unreachable, so fall back to the list.
  const [labView, setLabView] = useState<"root" | "workbenchShortcuts">("root");
  useEffect(() => {
    if (!workbenchShortcutsEnabled && labView === "workbenchShortcuts") {
      setLabView("root");
    }
  }, [workbenchShortcutsEnabled, labView]);

  if (labView === "workbenchShortcuts" && workbenchShortcutsEnabled) {
    return (
      <SettingsRows>
        <div className="flex w-full items-center gap-2">
          <Button
            aria-label={t("workspace.settings.lab.backLabel")}
            size="icon-sm"
            title={t("workspace.settings.lab.backLabel")}
            type="button"
            variant="ghost"
            onClick={() => setLabView("root")}
          >
            <ArrowLeftIcon aria-hidden="true" size={16} />
          </Button>
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.lab.workbenchShortcutsLabel")}
          </strong>
        </div>

        <WorkspaceLabShortcutRow
          disabled={isUpdatingFlags}
          label={t("workspace.settings.lab.newAgentConversationShortcutLabel")}
          value={workbenchShortcuts.newAgentConversation}
          onChange={(binding) => {
            onWorkbenchShortcutsChange({
              ...workbenchShortcuts,
              newAgentConversation: binding
            });
          }}
        />

        <WorkspaceLabShortcutRow
          disabled={isUpdatingFlags}
          label={t("workspace.settings.lab.newSameTypeWindowShortcutLabel")}
          value={workbenchShortcuts.newSameTypeWindow}
          onChange={(binding) => {
            onWorkbenchShortcutsChange({
              ...workbenchShortcuts,
              newSameTypeWindow: binding
            });
          }}
        />
      </SettingsRows>
    );
  }

  return (
    <SettingsRows>
      <WorkspaceLabFeatureGateRows
        changingFeatureFlags={changingFeatureFlags}
        featureFlags={featureFlags}
        onFeatureFlagsChange={onFeatureFlagsChange}
      />

      {workbenchShortcutsEnabled ? (
        <button
          className="flex w-full items-center justify-between gap-4 rounded-md border-0 bg-transparent px-0 py-1 text-left outline-none transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)] disabled:opacity-70"
          data-testid="workspace-settings-lab-configure-shortcuts"
          disabled={isUpdatingFlags}
          type="button"
          onClick={() => setLabView("workbenchShortcuts")}
        >
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.lab.workbenchShortcutsManageLabel")}
          </span>
          <ArrowRightIcon
            aria-hidden="true"
            className="text-[var(--text-secondary)]"
            size={16}
          />
        </button>
      ) : null}
    </SettingsRows>
  );
}

function WorkspaceLabShortcutRow({
  disabled,
  label,
  value,
  onChange
}: {
  disabled: boolean;
  label: string;
  value: string | null;
  onChange: (binding: string | null) => void;
}) {
  const { t } = useTranslation();
  const clearLabel = t("workspace.settings.lab.clearShortcutLabel", { label });
  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {label}
        </strong>
      </div>
      <div className="flex w-[220px] min-w-[220px] items-center gap-2 max-[560px]:w-full max-[560px]:min-w-0">
        <Input
          aria-label={label}
          className={cn(
            workspaceSettingsInputClass,
            "font-mono text-[12px]",
            disabled && "opacity-70"
          )}
          disabled={disabled}
          placeholder={t("workspace.settings.lab.shortcutUnbound")}
          readOnly
          value={value ?? ""}
          onKeyDown={(event) => {
            if (disabled) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (
              event.key === "Backspace" ||
              event.key === "Delete" ||
              event.key === "Escape"
            ) {
              onChange(null);
              return;
            }
            const binding = formatDesktopShortcutBinding({
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              key: event.key,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey
            });
            if (binding) {
              onChange(binding);
            }
          }}
        />
        <Button
          aria-label={clearLabel}
          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          disabled={disabled || value === null}
          size="icon-sm"
          title={clearLabel}
          type="button"
          variant="ghost"
          onClick={() => onChange(null)}
        >
          <DeleteIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function workspaceSettingsMinimizeAnimationOptionLabelKey(
  animation: DesktopMinimizeAnimation
): DesktopI18nKey {
  switch (animation) {
    case "scale":
      return "workspace.settings.appearance.minimizeAnimationOptions.scale";
    case "genie":
      return "workspace.settings.appearance.minimizeAnimationOptions.genie";
    case "off":
      return "workspace.settings.appearance.minimizeAnimationOptions.off";
  }
}

function workspaceSettingsWindowSnappingShortcutLabelKey(
  preset: DesktopWorkbenchWindowSnappingShortcutPreset
): DesktopI18nKey {
  switch (preset) {
    case "commandArrows":
      return "workspace.settings.appearance.workbenchWindowSnappingShortcutOptions.commandArrows";
    case "commandShiftArrows":
      return "workspace.settings.appearance.workbenchWindowSnappingShortcutOptions.commandShiftArrows";
  }
}

type WorkspaceSettingsWindowSnappingSelectValue =
  | "off"
  | DesktopWorkbenchWindowSnappingShortcutPreset;

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
      className="fixed inset-0 grid place-items-center bg-[var(--backdrop)] supports-backdrop-filter:backdrop-blur-sm transition-[background] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none"
      data-workspace-settings-backdrop="true"
      style={{ zIndex: "var(--z-panel-popover)" }}
      onClick={onClose}
    >
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute inset-x-0 top-0 z-0 h-[52px] [-webkit-app-region:drag]"
        data-workspace-settings-window-drag-region="true"
      />
      {children}
    </div>
  );

  if (typeof document === "undefined") {
    return panel;
  }

  return createPortal(panel, document.body);
}

function ComputerUseSetupRow({
  anchorRef,
  attentionRequestID
}: {
  anchorRef?: React.Ref<HTMLDivElement>;
  attentionRequestID: number;
}) {
  const { t } = useTranslation();
  const { service: settingsService } = useWorkspaceSettingsService();
  const [status, setStatus] = useState<
    "idle" | "checking" | "installed" | "not-installed" | "check-failed"
  >("idle");
  const [computerUseStatus, setComputerUseStatus] =
    useState<DesktopComputerUseStatus | null>(null);
  const [operation, setOperation] = useState<"install" | "uninstall" | null>(
    null
  );
  const [operationProgress, setOperationProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [attentionActive, setAttentionActive] = useState(false);
  const [autoCheckActive, setAutoCheckActive] = useState(false);
  const [openingSettingsPane, setOpeningSettingsPane] =
    useState<DesktopComputerUsePermissionPane | null>(null);
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [wizardStep, setWizardStep] =
    useState<ComputerUseWizardStep>("install");
  const [wizardVerifyMessage, setWizardVerifyMessage] = useState<string | null>(
    null
  );
  const [checkingPermissionStatus, setCheckingPermissionStatus] =
    useState(false);
  const [lastCheckedAtUnixMs, setLastCheckedAtUnixMs] = useState<number | null>(
    null
  );
  const handledAttentionRequestRef = useRef(0);
  const autoCheckStartedAtRef = useRef<number | null>(null);
  const diagnosticContextRef = useRef<Record<string, unknown>>({});
  const lastKnownStatusRef = useRef<DesktopComputerUseStatus | null>(null);
  const focusRefreshLastRunRef = useRef(0);
  const restartInFlightRef = useRef(false);
  const wizardGrantFiredRef = useRef<
    Partial<Record<DesktopComputerUsePermissionPane, boolean>>
  >({});

  const operationRunning = operation !== null;
  const grantStep = resolveComputerUseGrantStep(computerUseStatus);
  // The row hint only carries transient operation feedback; persistent
  // status guidance lives on the manage button (pulse + tooltip) instead of
  // a standing paragraph.
  const computerUseHint =
    message ??
    (status === "check-failed"
      ? t("workspace.settings.general.computerUseStatusCheckFailed")
      : null);
  const computerUseNeedsAttention =
    status === "installed" && !isComputerUseFullyAuthorized(computerUseStatus);
  diagnosticContextRef.current = {
    autoCheckActive,
    checkingPermissionStatus,
    dialogOpen: permissionDialogOpen,
    grantStep,
    operation,
    operationProgress,
    panelStatus: status,
    status: summarizeComputerUseStatusForDiagnostic(computerUseStatus),
    wizardStep
  };

  const logPermissionDiagnostic = useCallback(
    (
      event: string,
      details?: Record<string, unknown>,
      level?: "debug" | "error" | "info" | "warn"
    ) => {
      settingsService.logComputerUsePermissionDiagnostic({
        details: {
          ...diagnosticContextRef.current,
          ...details
        },
        event,
        level
      });
    },
    [settingsService]
  );

  useEffect(() => {
    if (!operationRunning) {
      return;
    }
    const timer = window.setInterval(() => {
      setOperationProgress((current) =>
        nextComputerUseOperationProgress(current)
      );
    }, 180);
    return () => {
      window.clearInterval(timer);
    };
  }, [operationRunning]);

  const checkStatus = useCallback(
    async (options?: {
      clearMessage?: boolean;
      diagnosticTrigger?: string;
      silent?: boolean;
    }): Promise<DesktopComputerUseStatus | null> => {
      if (!options?.silent) {
        setStatus("checking");
      }
      if (options?.clearMessage !== false) {
        setMessage(null);
      }
      try {
        const result = await settingsService.checkComputerUseStatus();
        const nextStatus = result.installed ? "installed" : "not-installed";
        lastKnownStatusRef.current = result;
        setComputerUseStatus(result);
        setStatus(nextStatus);
        logPermissionDiagnostic("computer_use.permission_status_checked", {
          nextPanelStatus: nextStatus,
          result: summarizeComputerUseStatusForDiagnostic(result),
          trigger: options?.diagnosticTrigger ?? "unknown"
        });
        return result;
      } catch {
        // Keep the last known status on transient failures; only surface the
        // dedicated failed state when we have never read a status at all.
        if (lastKnownStatusRef.current === null) {
          setStatus("check-failed");
        } else if (!options?.silent) {
          setStatus(
            lastKnownStatusRef.current.installed ? "installed" : "not-installed"
          );
        }
        logPermissionDiagnostic(
          "computer_use.permission_status_check_failed",
          {
            trigger: options?.diagnosticTrigger ?? "unknown"
          },
          "warn"
        );
        return null;
      }
    },
    [logPermissionDiagnostic, settingsService]
  );

  useEffect(() => {
    void checkStatus({ diagnosticTrigger: "initial" });
  }, [checkStatus]);

  const startAutoCheck = useCallback(() => {
    autoCheckStartedAtRef.current = Date.now();
    setAutoCheckActive(true);
  }, []);

  // Wizard verify: one deterministic reconciliation, never gated on any
  // prior status read. Restarting the daemon clears every macOS staleness at
  // once (cached AXIsProcessTrusted, frozen capture availability, a daemon
  // macOS killed) and only then is the status read trustworthy.
  const handleWizardVerify = async () => {
    if (restartInFlightRef.current || checkingPermissionStatus) {
      return;
    }
    restartInFlightRef.current = true;
    setCheckingPermissionStatus(true);
    setWizardVerifyMessage(null);
    logPermissionDiagnostic("computer_use.wizard_verify_clicked");
    try {
      const { status: nextStatus } =
        await settingsService.restartComputerUseDriver({ force: true });
      lastKnownStatusRef.current = nextStatus;
      setComputerUseStatus(nextStatus);
      setStatus(nextStatus.installed ? "installed" : "not-installed");
      setLastCheckedAtUnixMs(Date.now());
      logPermissionDiagnostic("computer_use.wizard_verify_resolved", {
        nextStatus: summarizeComputerUseStatusForDiagnostic(nextStatus)
      });
      if (isComputerUseFullyAuthorized(nextStatus)) {
        setWizardStep("done");
      }
    } catch {
      logPermissionDiagnostic("computer_use.wizard_verify_failed", {}, "warn");
      setWizardVerifyMessage(
        t("workspace.settings.general.computerUseStatusCheckFailed")
      );
    } finally {
      restartInFlightRef.current = false;
      setCheckingPermissionStatus(false);
    }
  };

  useEffect(() => {
    if (!autoCheckActive) {
      return;
    }
    if (
      status === "not-installed" ||
      isComputerUseFullyAuthorized(computerUseStatus)
    ) {
      setAutoCheckActive(false);
      return;
    }
    if (status !== "installed") {
      return;
    }

    // Status is auxiliary in the wizard: this poll only keeps the per-step
    // chips honest. Nothing gates on it.
    const timer = window.setInterval(() => {
      const startedAt = autoCheckStartedAtRef.current;
      if (
        startedAt !== null &&
        Date.now() - startedAt > computerUseAutoCheckMaxMs
      ) {
        setAutoCheckActive(false);
        return;
      }
      void checkStatus({
        clearMessage: false,
        diagnosticTrigger: "auto-poll",
        silent: true
      });
    }, computerUseAutoCheckIntervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [autoCheckActive, checkStatus, computerUseStatus, status]);

  useEffect(() => {
    if (
      status !== "installed" ||
      isComputerUseFullyAuthorized(computerUseStatus)
    ) {
      return;
    }
    // Grants usually happen in System Settings; re-check as soon as the user
    // comes back instead of waiting for a manual click.
    const refreshOnVisibility = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const now = Date.now();
      if (
        now - focusRefreshLastRunRef.current <
        computerUseFocusRefreshMinIntervalMs
      ) {
        return;
      }
      focusRefreshLastRunRef.current = now;
      void checkStatus({
        clearMessage: false,
        diagnosticTrigger: "window-focus",
        silent: true
      });
    };
    window.addEventListener("focus", refreshOnVisibility);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      window.removeEventListener("focus", refreshOnVisibility);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [checkStatus, computerUseStatus, status]);

  const handleInstall = async () => {
    logPermissionDiagnostic("computer_use.permission_install_clicked");
    setOperation("install");
    setOperationProgress(8);
    setMessage(null);
    try {
      const currentStatus = await checkStatus({
        clearMessage: false,
        diagnosticTrigger: "install-preflight",
        silent: true
      });
      if (currentStatus === null) {
        setMessage(
          t("workspace.settings.general.computerUseStatusCheckFailed")
        );
        return;
      }
      if (currentStatus.installed) {
        setOperationProgress(100);
        await delay(computerUseOperationSettleMs);
        setMessage(null);
        if (permissionDialogOpen && wizardStep === "install") {
          setWizardStep("accessibility");
        }
        return;
      }
      const result = await settingsService.installComputerUse();
      setOperationProgress(100);
      await delay(computerUseOperationSettleMs);
      if (result.success) {
        const nextStatus = await checkStatus({
          clearMessage: false,
          diagnosticTrigger: "install-completed"
        });
        setMessage(null);
        // A fresh install has no grants yet — continue straight into the
        // wizard's first grant step.
        if (nextStatus?.installed === true) {
          if (isComputerUseFullyAuthorized(nextStatus)) {
            setWizardStep("done");
          } else {
            logPermissionDiagnostic(
              "computer_use.permission_dialog_open_changed",
              { open: true, trigger: "install-completed" }
            );
            setWizardStep("accessibility");
            setPermissionDialogOpen(true);
            startAutoCheck();
          }
        }
      } else {
        setMessage(t("workspace.settings.general.computerUseInstallFailed"));
      }
    } catch {
      setMessage(t("workspace.settings.general.computerUseInstallFailed"));
    } finally {
      setOperation(null);
      setOperationProgress(0);
    }
  };

  const handleUninstall = async () => {
    logPermissionDiagnostic("computer_use.permission_uninstall_clicked");
    setOperation("uninstall");
    setOperationProgress(8);
    setMessage(null);
    try {
      const currentStatus = await checkStatus({
        clearMessage: false,
        diagnosticTrigger: "uninstall-preflight",
        silent: true
      });
      if (currentStatus === null) {
        setMessage(
          t("workspace.settings.general.computerUseStatusCheckFailed")
        );
        return;
      }
      if (!currentStatus.installed) {
        setOperationProgress(100);
        await delay(computerUseOperationSettleMs);
        setMessage(null);
        setAutoCheckActive(false);
        return;
      }
      const result = await settingsService.uninstallComputerUse();
      setOperationProgress(100);
      await delay(computerUseOperationSettleMs);
      if (result.success) {
        await checkStatus({
          clearMessage: false,
          diagnosticTrigger: "uninstall-completed"
        });
        setMessage(null);
        setAutoCheckActive(false);
      } else {
        setMessage(t("workspace.settings.general.computerUseUninstallFailed"));
      }
    } catch {
      setMessage(t("workspace.settings.general.computerUseUninstallFailed"));
    } finally {
      setOperation(null);
      setOperationProgress(0);
    }
  };

  const handleOpenPermissionSettings = async (
    pane: DesktopComputerUsePermissionPane
  ) => {
    logPermissionDiagnostic("computer_use.permission_settings_open_clicked", {
      pane
    });
    setOpeningSettingsPane(pane);
    // Fire-and-forget the grant on this user-initiated click: it registers
    // CuaDriver in the privacy panes and raises the TCC prompt when macOS
    // still shows one. The CLI may open windows of its own, so it must only
    // ever run behind an explicit user action — never on step entry. Progress
    // is observed through status polling, never by awaiting it.
    if (!wizardGrantFiredRef.current[pane]) {
      wizardGrantFiredRef.current[pane] = true;
      logPermissionDiagnostic("computer_use.wizard_grant_fired", { pane });
      void settingsService
        .startComputerUsePermissionGrant()
        .catch(() => undefined);
    }
    try {
      await settingsService.openComputerUsePermissionSettings(pane);
      startAutoCheck();
    } catch {
      setMessage(t("workspace.settings.general.computerUseOpenSettingsFailed"));
    } finally {
      setOpeningSettingsPane(null);
    }
  };

  const handlePermissionDialogOpenChange = (open: boolean) => {
    logPermissionDiagnostic("computer_use.permission_dialog_open_changed", {
      open
    });
    setPermissionDialogOpen(open);
    if (open) {
      // Status only assists here: it picks a starting step, and the user can
      // navigate freely regardless of what it says.
      setWizardStep(resolveComputerUseWizardInitialStep(computerUseStatus));
      setWizardVerifyMessage(null);
      wizardGrantFiredRef.current = {};
      if (
        status === "installed" &&
        !isComputerUseFullyAuthorized(computerUseStatus)
      ) {
        startAutoCheck();
        void checkStatus({
          clearMessage: false,
          diagnosticTrigger: "dialog-opened",
          silent: true
        });
      }
    } else {
      setAutoCheckActive(false);
    }
  };

  useEffect(() => {
    if (
      attentionRequestID === 0 ||
      handledAttentionRequestRef.current === attentionRequestID ||
      status === "idle" ||
      status === "checking"
    ) {
      return;
    }

    handledAttentionRequestRef.current = attentionRequestID;
    if (
      status !== "not-installed" &&
      (status !== "installed" ||
        isComputerUseFullyAuthorized(computerUseStatus))
    ) {
      return;
    }

    const timers = [
      window.setTimeout(() => setAttentionActive(true), 80),
      window.setTimeout(() => setAttentionActive(false), 440),
      window.setTimeout(() => setAttentionActive(true), 680),
      window.setTimeout(() => setAttentionActive(false), 1040)
    ];
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      setAttentionActive(false);
    };
  }, [attentionRequestID, status, computerUseStatus]);

  const grantTooltip = resolveComputerUseGrantTooltip(computerUseStatus, t);
  const manageLabel = isComputerUseFullyAuthorized(computerUseStatus)
    ? t("workspace.settings.general.computerUseAuthorizedButton")
    : t("workspace.settings.general.computerUseManageButton");

  return (
    <>
      <div
        ref={anchorRef}
        className="relative isolate flex w-full items-center justify-between gap-4 outline-none max-[560px]:flex-col max-[560px]:items-stretch"
        data-workspace-settings-anchor="computer-use"
        tabIndex={-1}
      >
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -inset-x-3 -inset-y-2 z-0 rounded-[8px] transition-colors duration-200",
            attentionActive
              ? "bg-[color-mix(in_srgb,var(--state-warning)_16%,transparent)]"
              : "bg-transparent"
          )}
        />
        <div className="relative z-[1] flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.computerUseLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.general.computerUseDescription")}
          </p>
          {computerUseHint && (
            <p className="m-0 mt-1 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
              {computerUseHint}
            </p>
          )}
        </div>
        <div
          className={cn(
            "relative z-[1] flex flex-col items-stretch justify-end gap-2",
            workspaceSettingsControlColumnClass
          )}
        >
          {(status === "checking" || status === "idle") && (
            <WorkspaceSettingsActionButton
              disabled
              label={t("common.loading")}
            />
          )}
          {status === "check-failed" && (
            <WorkspaceSettingsActionButton
              label={t(
                "workspace.settings.general.computerUseStatusRetryButton"
              )}
              onClick={() => {
                void checkStatus({ diagnosticTrigger: "retry" });
              }}
            />
          )}
          {status === "not-installed" && (
            <WorkspaceSettingsActionButton
              disabled={operationRunning}
              label={
                operation === "install"
                  ? t("workspace.settings.general.computerUseInstalling")
                  : t("workspace.settings.general.computerUseInstallButton")
              }
              progress={operation === "install" ? operationProgress : null}
              progressAriaLabel={t(
                "workspace.settings.general.computerUseProgressAria"
              )}
              onClick={() => {
                void handleInstall();
              }}
            />
          )}
          {status === "installed" && (
            <div className="flex w-full items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="relative min-w-0 flex-1">
                    <WorkspaceSettingsActionButton
                      disabled={
                        operationRunning || openingSettingsPane !== null
                      }
                      label={manageLabel}
                      progressAriaLabel={t(
                        "workspace.settings.general.computerUseProgressAria"
                      )}
                      onClick={() => {
                        logPermissionDiagnostic(
                          "computer_use.permission_manage_clicked"
                        );
                        handlePermissionDialogOpenChange(true);
                      }}
                    />
                    {computerUseNeedsAttention && (
                      <StatusDot
                        className="absolute -right-0.5 -top-0.5 z-[1]"
                        pulse
                        size="xs"
                        tone="amber"
                      />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[260px]">
                  {grantTooltip}
                </TooltipContent>
              </Tooltip>
              <WorkspaceSettingsActionButton
                className="flex-1"
                disabled={operationRunning || openingSettingsPane !== null}
                label={
                  operation === "uninstall"
                    ? t("workspace.settings.general.computerUseUninstalling")
                    : t("workspace.settings.general.computerUseUninstallButton")
                }
                progress={operation === "uninstall" ? operationProgress : null}
                progressAriaLabel={t(
                  "workspace.settings.general.computerUseProgressAria"
                )}
                variant="destructive-secondary"
                onClick={() => {
                  void handleUninstall();
                }}
              />
            </div>
          )}
        </div>
      </div>
      <ComputerUseSetupWizardDialog
        checkingPermissionStatus={checkingPermissionStatus}
        computerUseStatus={computerUseStatus}
        installRunning={operation === "install"}
        installed={status === "installed"}
        lastCheckedAtUnixMs={lastCheckedAtUnixMs}
        open={permissionDialogOpen}
        openingSettingsPane={openingSettingsPane}
        operationProgress={operationProgress}
        step={wizardStep}
        verifyMessage={wizardVerifyMessage}
        onInstall={handleInstall}
        onOpenChange={handlePermissionDialogOpenChange}
        onOpenSettings={handleOpenPermissionSettings}
        onStepChange={setWizardStep}
        onVerify={handleWizardVerify}
      />
    </>
  );
}

type ComputerUseWizardStep =
  | "install"
  | "accessibility"
  | "screen-recording"
  | "verify"
  | "done";

const computerUseWizardStepOrder: readonly ComputerUseWizardStep[] = [
  "install",
  "accessibility",
  "screen-recording",
  "verify",
  "done"
];

// Status only assists here: it picks a plausible starting step. The user can
// navigate freely, so a wrong guess costs nothing.
function resolveComputerUseWizardInitialStep(
  status: DesktopComputerUseStatus | null
): ComputerUseWizardStep {
  if (status?.installed !== true) {
    return "install";
  }
  if (isComputerUseFullyAuthorized(status)) {
    return "done";
  }
  if (status.permissions?.accessibility === true) {
    return "screen-recording";
  }
  return "accessibility";
}

function computerUseWizardStepLabel(
  step: ComputerUseWizardStep,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (step) {
    case "install":
      return t("workspace.settings.general.computerUseInstallButton");
    case "accessibility":
      return t("workspace.settings.general.computerUsePermissionAccessibility");
    case "screen-recording":
      return t(
        "workspace.settings.general.computerUsePermissionScreenRecording"
      );
    case "verify":
      return t("workspace.settings.general.computerUseStatusCheckAgain");
    case "done":
      return t("workspace.settings.general.computerUseDoneButton");
  }
}

function ComputerUseSetupWizardDialog({
  checkingPermissionStatus,
  computerUseStatus,
  installRunning,
  installed,
  lastCheckedAtUnixMs,
  open,
  openingSettingsPane,
  operationProgress,
  step,
  verifyMessage,
  onInstall,
  onOpenChange,
  onOpenSettings,
  onStepChange,
  onVerify
}: {
  checkingPermissionStatus: boolean;
  computerUseStatus: DesktopComputerUseStatus | null;
  installRunning: boolean;
  installed: boolean;
  lastCheckedAtUnixMs: number | null;
  open: boolean;
  openingSettingsPane: DesktopComputerUsePermissionPane | null;
  operationProgress: number;
  step: ComputerUseWizardStep;
  verifyMessage: string | null;
  onInstall: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: (pane: DesktopComputerUsePermissionPane) => Promise<void>;
  onStepChange: (step: ComputerUseWizardStep) => void;
  onVerify: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const permissions = computerUseStatus?.permissions ?? null;
  const driverState: "running" | "not-running" | "unknown" =
    permissions?.source === "driver-daemon"
      ? "running"
      : computerUseStatus?.reason === "driver-daemon-not-running"
        ? "not-running"
        : "unknown";
  const accessibilityState: ComputerUsePermissionState =
    driverState === "not-running"
      ? "unknown"
      : resolveComputerUsePermissionState(permissions?.accessibility ?? null);
  const screenRecordingState: ComputerUsePermissionState =
    driverState === "not-running"
      ? "unknown"
      : resolveComputerUseScreenRecordingState(permissions);
  const stepIndex = computerUseWizardStepOrder.indexOf(step);
  const grantPane: DesktopComputerUsePermissionPane | null =
    step === "accessibility"
      ? "accessibility"
      : step === "screen-recording"
        ? "screen-recording"
        : null;
  const grantChipState =
    step === "accessibility" ? accessibilityState : screenRecordingState;
  const goBack = () => {
    const target = computerUseWizardStepOrder[stepIndex - 1];
    if (target !== undefined) {
      onStepChange(target);
    }
  };
  const goNext = () => {
    const target = computerUseWizardStepOrder[stepIndex + 1];
    if (target !== undefined) {
      onStepChange(target);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(720px,calc(100vh-32px))] flex-col gap-0 overflow-hidden bg-[var(--background-fronted)] p-0 sm:max-w-[620px]"
        onOpenAutoFocus={(event) => {
          // Default auto-focus lands on the "?" help trigger and pops its
          // tooltip the moment the dialog opens.
          event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <div className="flex items-center gap-1.5">
            <DialogTitle>
              {t("workspace.settings.general.computerUsePermissionDialogTitle")}
            </DialogTitle>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t(
                    "workspace.settings.general.computerUsePermissionDialogRelationshipTitle"
                  )}
                  className="inline-flex shrink-0 cursor-default text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
                  type="button"
                >
                  <AskLinedIcon aria-hidden="true" className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[320px]" side="bottom">
                {t(
                  "workspace.settings.general.computerUsePermissionDialogRelationshipBody"
                )}
              </TooltipContent>
            </Tooltip>
          </div>
          <DialogDescription className="sr-only">
            {t(
              "workspace.settings.general.computerUsePermissionDialogDescription"
            )}
          </DialogDescription>
        </DialogHeader>
        <ol className="m-0 flex shrink-0 list-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-1)] px-5 py-3">
          {computerUseWizardStepOrder.map((wizardStep, index) => {
            const state =
              index === stepIndex
                ? "current"
                : index < stepIndex
                  ? "done"
                  : "upcoming";
            return (
              <li key={wizardStep} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                    state === "current"
                      ? "bg-[var(--text-primary)] text-[var(--background-fronted)]"
                      : state === "done"
                        ? "bg-[color-mix(in_srgb,var(--state-success)_16%,transparent)] text-[var(--state-success)]"
                        : "bg-[var(--transparency-block)] text-[var(--text-tertiary)]"
                  )}
                >
                  {state === "done" ? (
                    <CheckIcon aria-hidden="true" className="size-3" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span
                  className={cn(
                    "text-[12px] font-medium",
                    state === "current"
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-tertiary)]"
                  )}
                >
                  {computerUseWizardStepLabel(wizardStep, t)}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {step === "install" && (
            <>
              <p className="m-0 text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                {t("workspace.settings.general.computerUseWizardInstallBody")}
              </p>
              <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                <StatusDot tone={installed ? "green" : "neutral"} />
                {t(
                  installed
                    ? "workspace.settings.general.computerUseStatusInstalled"
                    : "workspace.settings.general.computerUseStatusNotInstalled"
                )}
              </div>
            </>
          )}
          {grantPane !== null && (
            <>
              <p className="m-0 text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                {t(
                  "workspace.settings.general.computerUseWizardGrantInstruction",
                  { permission: computerUseWizardStepLabel(step, t) }
                )}
              </p>
              {step === "screen-recording" && (
                <p className="m-0 text-[12px] leading-[1.4] text-[var(--text-tertiary)]">
                  {t(
                    "workspace.settings.general.computerUseWizardScreenRecordingKillNote"
                  )}
                </p>
              )}
              <img
                alt=""
                className="w-full rounded-[8px] border border-[var(--border-1)]"
                draggable={false}
                src={cuaDriverToggleDemoUrl}
              />
              <ComputerUsePermissionStatusRow
                label={computerUseWizardStepLabel(step, t)}
                stateLabel={resolveComputerUsePermissionStateLabel(
                  grantChipState,
                  t
                )}
                tone={computerUsePermissionStateTone(grantChipState)}
                action={{
                  label: t(
                    "workspace.settings.general.computerUseOpenPaneButton"
                  ),
                  loading: openingSettingsPane === grantPane,
                  onClick: () => {
                    void onOpenSettings(grantPane);
                  }
                }}
              />
            </>
          )}
          {(step === "verify" || step === "done") && (
            <>
              <p className="m-0 text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                {t(
                  step === "verify"
                    ? "workspace.settings.general.computerUseWizardVerifyBody"
                    : "workspace.settings.general.computerUseWizardDoneBody"
                )}
              </p>
              <ComputerUsePermissionStatusRow
                label={t(
                  "workspace.settings.general.computerUseDriverRowLabel"
                )}
                stateLabel={t(
                  driverState === "running"
                    ? "workspace.settings.general.computerUseDriverStatusRunning"
                    : driverState === "not-running"
                      ? "workspace.settings.general.computerUseDriverStatusNotRunning"
                      : "workspace.settings.general.computerUsePermissionStatusUnknown"
                )}
                tone={
                  driverState === "running"
                    ? "success"
                    : driverState === "not-running"
                      ? "warning"
                      : "neutral"
                }
              />
              <ComputerUsePermissionStatusRow
                label={t(
                  "workspace.settings.general.computerUsePermissionAccessibility"
                )}
                stateLabel={resolveComputerUsePermissionStateLabel(
                  accessibilityState,
                  t
                )}
                tone={computerUsePermissionStateTone(accessibilityState)}
                action={
                  step === "verify" &&
                  computerUsePermissionStateTone(accessibilityState) ===
                    "warning"
                    ? {
                        label: t(
                          "workspace.settings.general.computerUseWizardGrantStepReturn"
                        ),
                        onClick: () => {
                          onStepChange("accessibility");
                        }
                      }
                    : null
                }
              />
              <ComputerUsePermissionStatusRow
                label={t(
                  "workspace.settings.general.computerUsePermissionScreenRecording"
                )}
                stateLabel={resolveComputerUsePermissionStateLabel(
                  screenRecordingState,
                  t
                )}
                tone={computerUsePermissionStateTone(screenRecordingState)}
                action={
                  step === "verify" &&
                  computerUsePermissionStateTone(screenRecordingState) ===
                    "warning"
                    ? {
                        label: t(
                          "workspace.settings.general.computerUseWizardGrantStepReturn"
                        ),
                        onClick: () => {
                          onStepChange("screen-recording");
                        }
                      }
                    : null
                }
              />
              {step === "verify" && verifyMessage !== null && (
                <p className="m-0 text-[13px] leading-[1.4] text-[var(--state-warning)]">
                  {verifyMessage}
                </p>
              )}
              {step === "verify" && lastCheckedAtUnixMs !== null && (
                <p className="m-0 text-[12px] leading-[1.35] text-[var(--text-tertiary)]">
                  {t("workspace.settings.general.computerUseLastCheckedAt", {
                    time: new Date(lastCheckedAtUnixMs).toLocaleTimeString()
                  })}
                </p>
              )}
            </>
          )}
        </div>
        <DialogFooter className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-1)] px-5 py-4">
          {stepIndex > 0 && step !== "done" && (
            <Button
              size="default"
              type="button"
              variant="ghost"
              onClick={goBack}
            >
              {t("workspace.settings.general.computerUseWizardBack")}
            </Button>
          )}
          {step === "install" &&
            (installed ? (
              <Button size="default" type="button" onClick={goNext}>
                {t("workspace.settings.general.computerUseWizardNext")}
              </Button>
            ) : (
              <Button
                aria-valuemax={installRunning ? 100 : undefined}
                aria-valuemin={installRunning ? 0 : undefined}
                aria-valuenow={
                  installRunning ? Math.round(operationProgress) : undefined
                }
                disabled={installRunning}
                role={installRunning ? "progressbar" : undefined}
                size="default"
                type="button"
                onClick={() => {
                  void onInstall();
                }}
              >
                {installRunning && (
                  <LoadingIcon className="size-4 animate-spin" />
                )}
                {t(
                  installRunning
                    ? "workspace.settings.general.computerUseInstalling"
                    : "workspace.settings.general.computerUseInstallButton"
                )}
              </Button>
            ))}
          {grantPane !== null && (
            <Button size="default" type="button" onClick={goNext}>
              {t("workspace.settings.general.computerUseWizardNext")}
            </Button>
          )}
          {step === "verify" && (
            <Button
              disabled={checkingPermissionStatus}
              size="default"
              type="button"
              onClick={() => {
                void onVerify();
              }}
            >
              {checkingPermissionStatus && (
                <LoadingIcon className="size-4 animate-spin" />
              )}
              {t(
                checkingPermissionStatus
                  ? "workspace.settings.general.computerUseWizardVerifyChecking"
                  : "workspace.settings.general.computerUseStatusCheckAgain"
              )}
            </Button>
          )}
          {step === "done" && (
            <Button
              size="default"
              type="button"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t("workspace.settings.general.computerUseDoneButton")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ComputerUsePermissionState =
  | "granted"
  | "missing"
  | "unknown"
  | "capture-unavailable";

function computerUsePermissionStateTone(
  state: ComputerUsePermissionState
): "success" | "warning" | "neutral" {
  switch (state) {
    case "granted":
      return "success";
    case "missing":
    case "capture-unavailable":
      return "warning";
    case "unknown":
      return "neutral";
  }
}

function ComputerUsePermissionStatusRow({
  action,
  label,
  stateLabel,
  tone
}: {
  action?: {
    disabled?: boolean;
    label: string;
    loading?: boolean;
    onClick: () => void;
  } | null;
  label: string;
  stateLabel: string;
  tone: "success" | "warning" | "neutral";
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-[8px] bg-[var(--transparency-block)] px-3 py-2">
      <span className="min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">
        {label}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-2">
          <StatusDot
            tone={
              tone === "success"
                ? "green"
                : tone === "warning"
                  ? "amber"
                  : "neutral"
            }
          />
          <span className="text-[13px] font-medium text-[var(--text-primary)]">
            {stateLabel}
          </span>
        </span>
        {action && (
          <Button
            className="min-w-[88px]"
            disabled={action.disabled || action.loading}
            size="dialog"
            type="button"
            onClick={action.onClick}
          >
            {action.loading && <LoadingIcon className="size-4 animate-spin" />}
            {action.label}
          </Button>
        )}
      </span>
    </div>
  );
}

function nextComputerUseOperationProgress(current: number): number {
  if (current >= 94) {
    return current;
  }
  if (current < 45) {
    return Math.min(45, current + 8);
  }
  if (current < 76) {
    return Math.min(76, current + 4);
  }
  return Math.min(94, current + 2);
}

function summarizeComputerUseStatusForDiagnostic(
  status: DesktopComputerUseStatus | null
): Record<string, unknown> | null {
  if (!status) {
    return null;
  }
  return {
    authorization: status.authorization,
    installed: status.installed,
    permissionAccessibility: status.permissions?.accessibility ?? null,
    permissionScreenRecording: status.permissions?.screenRecording ?? null,
    permissionScreenRecordingCapturable:
      status.permissions?.screenRecordingCapturable ?? null,
    permissionSource: status.permissions?.source ?? null,
    reason: status.reason ?? null
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isComputerUseFullyAuthorized(
  status: DesktopComputerUseStatus | null
): boolean {
  const permissions = status?.permissions;
  return (
    status?.installed === true &&
    permissions != null &&
    permissions.accessibility === true &&
    permissions.screenRecording === true &&
    permissions.screenRecordingCapturable === true
  );
}

type ComputerUseGrantStep =
  | "authorized"
  | "accessibility"
  | "screen-recording"
  | "screen-recording-capture-unavailable"
  | "driver-daemon-not-running"
  | "unknown";

function resolveComputerUseGrantStep(
  status: DesktopComputerUseStatus | null
): ComputerUseGrantStep {
  if (isComputerUseFullyAuthorized(status)) {
    return "authorized";
  }
  if (status?.reason === "driver-daemon-not-running") {
    return "driver-daemon-not-running";
  }
  const permissions = status?.permissions;
  if (!permissions) {
    return "unknown";
  }
  if (permissions.accessibility !== true) {
    return "accessibility";
  }
  if (permissions.screenRecording !== true) {
    return "screen-recording";
  }
  if (permissions.screenRecordingCapturable !== true) {
    return "screen-recording-capture-unavailable";
  }
  return "unknown";
}

function resolveComputerUseGrantTooltip(
  status: DesktopComputerUseStatus | null,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (isComputerUseFullyAuthorized(status)) {
    return t("workspace.settings.general.computerUseAuthorizedTooltip");
  }
  const permissions = status?.permissions;
  if (!permissions) {
    return t("workspace.settings.general.computerUsePermissionUnknownTooltip");
  }

  const missingPermissions: string[] = [];
  if (permissions.accessibility !== true) {
    missingPermissions.push(
      t("workspace.settings.general.computerUsePermissionAccessibility")
    );
  }
  if (
    permissions.screenRecording !== true ||
    permissions.screenRecordingCapturable !== true
  ) {
    missingPermissions.push(
      t("workspace.settings.general.computerUsePermissionScreenRecording")
    );
  }
  return t("workspace.settings.general.computerUsePermissionMissingTooltip", {
    permissions: missingPermissions.join(
      t("workspace.settings.general.computerUsePermissionListSeparator")
    )
  });
}

function resolveComputerUsePermissionState(
  value: boolean | null
): ComputerUsePermissionState {
  if (value === true) {
    return "granted";
  }
  if (value === false) {
    return "missing";
  }
  return "unknown";
}

function resolveComputerUseScreenRecordingState(
  permissions: DesktopComputerUsePermissionsStatus | null
): ComputerUsePermissionState {
  if (!permissions || permissions.screenRecording === null) {
    return "unknown";
  }
  if (permissions.screenRecording !== true) {
    return "missing";
  }
  if (permissions.screenRecordingCapturable !== true) {
    return "capture-unavailable";
  }
  return "granted";
}

function resolveComputerUsePermissionStateLabel(
  state: ComputerUsePermissionState,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (state) {
    case "granted":
      return t("workspace.settings.general.computerUsePermissionStatusGranted");
    case "missing":
      return t("workspace.settings.general.computerUsePermissionStatusMissing");
    case "unknown":
      return t("workspace.settings.general.computerUsePermissionStatusUnknown");
    case "capture-unavailable":
      return t(
        "workspace.settings.general.computerUsePermissionStatusCaptureUnavailable"
      );
  }
}

function WorkspaceAgentSettingsSection({
  agentConversationDetailMode,
  browserUseConnectionMode,
  changingAgentConversationDetailMode,
  changingDefaultAgentProvider,
  changingBrowserUseConnectionMode,
  defaultAgentProvider,
  focusedAnchor,
  focusRequestID,
  onAgentConversationDetailModeChange,
  onDefaultAgentProviderChange,
  onBrowserUseConnectionModeChange,
  onOpenExternalAgentImport
}: {
  agentConversationDetailMode: DesktopAgentConversationDetailMode;
  browserUseConnectionMode: DesktopBrowserUseConnectionMode;
  changingAgentConversationDetailMode: DesktopAgentConversationDetailMode | null;
  changingDefaultAgentProvider: DesktopDefaultAgentProvider | null;
  changingBrowserUseConnectionMode: DesktopBrowserUseConnectionMode | null;
  defaultAgentProvider: DesktopDefaultAgentProvider;
  focusedAnchor: WorkspaceSettingsGeneralFocusAnchor | null;
  focusRequestID: number;
  onAgentConversationDetailModeChange: (
    mode: DesktopAgentConversationDetailMode
  ) => void;
  onBrowserUseConnectionModeChange: (
    mode: DesktopBrowserUseConnectionMode
  ) => void;
  onDefaultAgentProviderChange: (provider: DesktopDefaultAgentProvider) => void;
  onOpenExternalAgentImport: () => void;
}) {
  const { t } = useTranslation();
  const browserUseRowRef = useRef<HTMLDivElement | null>(null);
  const computerUseRowRef = useRef<HTMLDivElement | null>(null);
  const isUpdatingDefaultAgentProvider = changingDefaultAgentProvider !== null;
  const rawPendingDefaultAgentProvider =
    changingDefaultAgentProvider ?? defaultAgentProvider;
  const pendingDefaultAgentProvider =
    normalizeWorkspaceSettingsDefaultAgentProvider(
      rawPendingDefaultAgentProvider
    );
  const isUpdatingBrowserUseConnectionMode =
    changingBrowserUseConnectionMode !== null;
  const pendingBrowserUseConnectionMode =
    changingBrowserUseConnectionMode ?? browserUseConnectionMode;
  const isUpdatingAgentConversationDetailMode =
    changingAgentConversationDetailMode !== null;
  const pendingAgentConversationDetailMode =
    changingAgentConversationDetailMode ?? agentConversationDetailMode;

  useEffect(() => {
    if (!focusedAnchor || focusRequestID === 0) {
      return;
    }
    const target =
      focusedAnchor === "computer-use"
        ? computerUseRowRef.current
        : browserUseRowRef.current;
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [focusedAnchor, focusRequestID]);

  return (
    <div className="flex flex-col gap-6 pb-[22px]">
      <div className="flex w-full flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.agentConversationDetailModeLabel")}
          </strong>
        </div>
        <div
          aria-label={t(
            "workspace.settings.general.agentConversationDetailModeLabel"
          )}
          className="grid w-full grid-cols-2 gap-2 max-[430px]:grid-cols-1"
          role="radiogroup"
        >
          {desktopAgentConversationDetailModes.map((mode) => {
            const selected = pendingAgentConversationDetailMode === mode;
            return (
              <button
                key={mode}
                aria-checked={selected}
                className={cn(
                  "flex min-h-[72px] min-w-0 items-center justify-between gap-3 rounded-[8px] border-solid px-3 py-2.5 text-left transition-colors duration-150 disabled:cursor-default disabled:opacity-70",
                  selected
                    ? "border border-[var(--tutti-purple)] bg-[color-mix(in_srgb,var(--tutti-purple)_8%,transparent)] text-[var(--text-primary)]"
                    : "border border-transparent bg-[var(--transparency-block)] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)]"
                )}
                disabled={isUpdatingAgentConversationDetailMode}
                role="radio"
                type="button"
                onClick={() => onAgentConversationDetailModeChange(mode)}
              >
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <span className="text-[13px] font-semibold leading-4">
                    {mode === "coding"
                      ? t(
                          "workspace.settings.general.agentConversationDetailModeOptions.codingTitle"
                        )
                      : t(
                          "workspace.settings.general.agentConversationDetailModeOptions.generalTitle"
                        )}
                  </span>
                  <span className="text-[12px] leading-[1.3] text-[var(--text-secondary)]">
                    {mode === "coding"
                      ? t(
                          "workspace.settings.general.agentConversationDetailModeOptions.codingDescription"
                        )
                      : t(
                          "workspace.settings.general.agentConversationDetailModeOptions.generalDescription"
                        )}
                  </span>
                </span>
                <RadioIndicator
                  checked={selected}
                  className="shrink-0"
                  disabled={isUpdatingAgentConversationDetailMode}
                />
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.externalImport.settingsLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.externalImport.settingsDescription")}
          </p>
        </div>
        <div
          className={cn(
            "flex justify-end max-[560px]:justify-start",
            workspaceSettingsControlColumnClass
          )}
        >
          <WorkspaceSettingsActionButton
            icon={<ImportLinedIcon className="size-3.5" />}
            label={t("workspace.externalImport.settingsAction")}
            type="button"
            onClick={onOpenExternalAgentImport}
          />
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
              onDefaultAgentProviderChange(value as DesktopDefaultAgentProvider)
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
              {workspaceSettingsDefaultAgentProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {resolveWorkspaceAgentGuiLabel(provider)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div
        ref={browserUseRowRef}
        className="flex w-full items-center justify-between gap-4 outline-none max-[560px]:flex-col max-[560px]:items-stretch"
        data-workspace-settings-anchor="browser-use"
        tabIndex={-1}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.browserUseConnectionModeLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.general.browserUseConnectionModeDescription"
            )}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingBrowserUseConnectionMode}
            value={pendingBrowserUseConnectionMode}
            onValueChange={(value) =>
              onBrowserUseConnectionModeChange(
                value as DesktopBrowserUseConnectionMode
              )
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.general.browserUseConnectionModeLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopBrowserUseConnectionModes.map((mode) => (
                <Tooltip key={mode}>
                  <TooltipTrigger asChild>
                    <SelectItem value={mode}>
                      {mode === "autoConnect"
                        ? t(
                            "workspace.settings.general.browserUseConnectionModeOptions.autoConnect"
                          )
                        : t(
                            "workspace.settings.general.browserUseConnectionModeOptions.isolated"
                          )}
                    </SelectItem>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-[260px]">
                    {mode === "autoConnect"
                      ? t(
                          "workspace.settings.general.browserUseConnectionModeOptionHints.autoConnect"
                        )
                      : t(
                          "workspace.settings.general.browserUseConnectionModeOptionHints.isolated"
                        )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ComputerUseSetupRow
        anchorRef={computerUseRowRef}
        attentionRequestID={
          focusedAnchor === "computer-use" ? focusRequestID : 0
        }
      />
    </div>
  );
}

function WorkspaceGeneralSettingsSection({
  changingDeletedAgentConversationRetentionDays,
  changingFeatureFlags,
  changingLocale,
  changingSleepPreventionMode,
  deletedAgentConversationRetentionDays,
  featureFlags,
  locale,
  onDeletedAgentConversationRetentionDaysChange,
  onLocaleChange,
  onPurgeDeletedConversations,
  onSleepPreventionModeChange,
  onWorkspaceUiModeChange,
  purgingDeletedConversations,
  sleepPreventionMode
}: {
  changingDeletedAgentConversationRetentionDays: DeletedAgentConversationRetentionDays | null;
  changingFeatureFlags: DesktopFeatureFlags | null;
  changingLocale: DesktopLocale | null;
  changingSleepPreventionMode: DesktopSleepPreventionMode | null;
  deletedAgentConversationRetentionDays: DeletedAgentConversationRetentionDays;
  featureFlags: DesktopFeatureFlags;
  locale: DesktopLocale;
  onDeletedAgentConversationRetentionDaysChange: (
    days: DeletedAgentConversationRetentionDays
  ) => void;
  onLocaleChange: (locale: DesktopLocale) => void;
  onPurgeDeletedConversations: () => Promise<void>;
  onSleepPreventionModeChange: (mode: DesktopSleepPreventionMode) => void;
  onWorkspaceUiModeChange: (mode: DesktopWorkspaceUiMode) => void;
  purgingDeletedConversations: boolean;
  sleepPreventionMode: DesktopSleepPreventionMode;
}) {
  const { t } = useTranslation();
  const agentDiagnosticsReporting = useAgentDiagnosticsConsent();
  const isUpdatingLocale = changingLocale !== null;
  const pendingLocale = changingLocale ?? locale;
  const isUpdatingSleepPrevention = changingSleepPreventionMode !== null;
  const pendingSleepPreventionMode =
    changingSleepPreventionMode ?? sleepPreventionMode;
  const pendingRetentionDays =
    changingDeletedAgentConversationRetentionDays ??
    deletedAgentConversationRetentionDays;
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const purgeConfirmationPhrase = t(
    "workspace.settings.general.deletedConversationPurgeConfirmationPhrase"
  );
  const isUpdatingWorkspaceUiMode = changingFeatureFlags !== null;
  const pendingWorkspaceUiMode = resolveDesktopWorkspaceUiMode(
    changingFeatureFlags ?? featureFlags
  );

  return (
    <div className="flex flex-col gap-6 pb-[22px] pt-5">
      <div className="flex w-full flex-col gap-3">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.general.workspaceUiModeLabel")}
        </strong>
        <div
          aria-label={t("workspace.settings.general.workspaceUiModeLabel")}
          className="grid w-full grid-cols-2 gap-2 max-[430px]:grid-cols-1"
          role="radiogroup"
        >
          {desktopWorkspaceUiModes.map((mode) => {
            const selected = pendingWorkspaceUiMode === mode;
            return (
              <button
                key={mode}
                aria-checked={selected}
                className={cn(
                  "flex min-h-[72px] min-w-0 items-center justify-between gap-3 rounded-[8px] border-solid px-3 py-2.5 text-left transition-colors duration-150 disabled:cursor-default disabled:opacity-70",
                  selected
                    ? "border border-[var(--tutti-purple)] bg-[color-mix(in_srgb,var(--tutti-purple)_8%,transparent)] text-[var(--text-primary)]"
                    : "border border-transparent bg-[var(--transparency-block)] text-[var(--text-primary)] hover:bg-[var(--transparency-hover)]"
                )}
                disabled={isUpdatingWorkspaceUiMode}
                role="radio"
                type="button"
                onClick={() => onWorkspaceUiModeChange(mode)}
              >
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="text-[13px] font-semibold leading-4">
                      {mode === "agent"
                        ? t(
                            "workspace.settings.general.workspaceUiModeOptions.agentTitle"
                          )
                        : t(
                            "workspace.settings.general.workspaceUiModeOptions.osTitle"
                          )}
                    </span>
                    {mode === "agent" ? (
                      <span className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-[color-mix(in_srgb,var(--tutti-purple)_12%,transparent)] px-1.5 text-[10px] font-semibold leading-none text-[var(--tutti-purple)]">
                        {t(
                          "workspace.settings.general.workspaceUiModeOptions.agentBadge"
                        )}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[12px] leading-[1.3] text-[var(--text-secondary)]">
                    {mode === "agent"
                      ? t(
                          "workspace.settings.general.workspaceUiModeOptions.agentDescription"
                        )
                      : t(
                          "workspace.settings.general.workspaceUiModeOptions.osDescription"
                        )}
                  </span>
                </span>
                <RadioIndicator
                  checked={selected}
                  className="shrink-0"
                  disabled={isUpdatingWorkspaceUiMode}
                />
              </button>
            );
          })}
        </div>
      </div>

      <div className="order-3 flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
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

      <div className="order-2 flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
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

      <div className="order-4 flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.agentDiagnosticsReportingLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.general.agentDiagnosticsReportingDescription"
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            "workspace.settings.general.agentDiagnosticsReportingLabel"
          )}
          checked={agentDiagnosticsReporting}
          onCheckedChange={setAgentDiagnosticsConsent}
        />
      </div>

      <div className="order-5 flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.general.deletedConversationRetentionLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.general.deletedConversationRetentionDescription"
            )}
          </p>
        </div>
        <div className="flex w-[220px] min-w-[220px] items-center gap-2 max-[560px]:w-full max-[560px]:min-w-0">
          <div className="min-w-0 flex-1">
            <Select
              disabled={
                changingDeletedAgentConversationRetentionDays !== null ||
                purgingDeletedConversations
              }
              value={String(pendingRetentionDays)}
              onValueChange={(value) =>
                onDeletedAgentConversationRetentionDaysChange(
                  Number(value) as DeletedAgentConversationRetentionDays
                )
              }
            >
              <SelectTrigger
                aria-label={t(
                  "workspace.settings.general.deletedConversationRetentionLabel"
                )}
                className={workspaceSettingsSelectTriggerClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                className={workspaceSettingsSelectContentClass}
                style={{ zIndex: "var(--z-panel-popover)" }}
              >
                {deletedAgentConversationRetentionDaysOptions.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t(
                      "workspace.settings.general.deletedConversationRetentionDays",
                      { count: String(days) }
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t(
                  purgingDeletedConversations
                    ? "workspace.settings.general.deletedConversationPurging"
                    : "workspace.settings.general.deletedConversationPurgeAction"
                )}
                className="size-8 rounded-[6px]"
                disabled={purgingDeletedConversations}
                size="icon"
                variant="destructive-secondary"
                onClick={() => {
                  setPurgeConfirmation("");
                  setPurgeDialogOpen(true);
                }}
              >
                {purgingDeletedConversations ? (
                  <LoadingIcon className="size-3.5" />
                ) : (
                  <DeleteIcon className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t(
                purgingDeletedConversations
                  ? "workspace.settings.general.deletedConversationPurging"
                  : "workspace.settings.general.deletedConversationPurgeAction"
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Dialog open={purgeDialogOpen} onOpenChange={setPurgeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("workspace.settings.general.deletedConversationPurgeTitle")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "workspace.settings.general.deletedConversationPurgeDescription",
                { phrase: purgeConfirmationPhrase }
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={t(
              "workspace.settings.general.deletedConversationPurgeConfirmationLabel"
            )}
            autoComplete="off"
            value={purgeConfirmation}
            onChange={(event) => setPurgeConfirmation(event.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPurgeDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={
                purgeConfirmation !== purgeConfirmationPhrase ||
                purgingDeletedConversations
              }
              variant="destructive"
              onClick={() => {
                void onPurgeDeletedConversations().finally(() => {
                  setPurgeDialogOpen(false);
                  setPurgeConfirmation("");
                });
              }}
            >
              {t("workspace.settings.general.deletedConversationPurgeConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkspaceAccountSettingsSection() {
  const { t } = useTranslation();
  const { service: accountService, state: accountState } = useAccountService();

  useEffect(() => {
    void accountService.refreshUserInfo();
  }, [accountService]);

  const handleLogin = async () => {
    if (accountState.signingOut) {
      return;
    }
    await accountService.startLogin();
  };

  const handleLogout = async () => {
    if (accountState.signingIn || accountState.signingOut) {
      return;
    }
    await accountService.logout();
  };

  const user = accountState.user;
  const displayName = user?.name || user?.email || user?.user_id || "Tutti";

  return (
    <div className="flex flex-col gap-6 pb-[22px] pt-5">
      <div className="flex min-w-0 items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {user?.avatar ? (
            <img
              alt=""
              className="size-12 shrink-0 rounded-full object-cover"
              draggable={false}
              src={user.avatar}
            />
          ) : (
            <div className="grid size-12 shrink-0 place-items-center rounded-full bg-[var(--transparency-block)] text-[18px] font-semibold text-[var(--text-primary)]">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <strong className="block truncate text-[16px] font-semibold leading-6 text-[var(--text-primary)]">
              {accountState.loading
                ? t("common.loading")
                : user
                  ? displayName
                  : t("workspace.settings.account.signedOutTitle")}
            </strong>
            <p className="m-0 truncate text-[13px] text-[var(--text-secondary)]">
              {user?.email || t("workspace.settings.account.description")}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2 max-[560px]:w-full max-[560px]:justify-start">
          {user ? (
            <>
              <WorkspaceSettingsActionButton
                className="w-auto min-w-[96px]"
                disabled={accountState.signingIn || accountState.signingOut}
                label={
                  accountState.signingOut
                    ? t("workspace.settings.account.signingOut")
                    : t("workspace.settings.account.logout")
                }
                onClick={handleLogout}
              />
              <WorkspaceSettingsActionButton
                className="w-auto min-w-[96px]"
                disabled={accountState.signingIn || accountState.signingOut}
                label={t("workspace.settings.account.refresh")}
                onClick={() => void accountService.refreshUserInfo()}
              />
            </>
          ) : (
            <WorkspaceSettingsActionButton
              className="w-auto min-w-[104px] max-[560px]:w-full"
              disabled={accountState.loading || accountState.signingOut}
              icon={
                accountState.signingIn ? (
                  <LoadingIcon className="size-3.5" />
                ) : null
              }
              label={
                accountState.signingIn
                  ? t("workspace.settings.account.signingIn")
                  : accountState.loginStatus === "pending"
                    ? t("workspace.settings.account.reopenLogin")
                    : t("workspace.settings.account.login")
              }
              onClick={handleLogin}
              variant="default"
            />
          )}
        </div>
      </div>

      {accountState.error ? (
        <p className="m-0 rounded-[6px] bg-[color-mix(in_srgb,var(--state-warning)_16%,transparent)] px-3 py-2 text-[13px] text-[var(--text-primary)]">
          {accountState.error}
        </p>
      ) : null}
    </div>
  );
}

function WorkspaceAboutSettingsSection({
  developerLogs,
  onVersionTap
}: {
  developerLogs: WorkspaceSettingsDeveloperLogsSnapshotState;
  onVersionTap: () => void;
}) {
  const { t } = useTranslation();
  const hostService = useWorkspaceWorkbenchHostService();
  const logs = developerLogs.logs;
  const desktopVersion =
    developerLogs.loading && logs === null
      ? t("common.loading")
      : (logs?.desktopVersion ?? "0.0.0");

  const openExternal = useCallback(
    (url: string) => {
      void hostService.openExternal(url);
    },
    [hostService]
  );

  return (
    <div className="flex w-full flex-col gap-4 px-5 pb-5 pt-7">
      <div className="flex min-w-0 items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-start">
        <div className="flex min-w-0 items-center gap-1">
          <img
            alt=""
            className="size-14 shrink-0 object-contain"
            draggable={false}
            src={tuttiDesktopIconUrl}
          />
          <div className="min-w-0">
            <strong className="block truncate text-[18px] font-semibold leading-7 text-[var(--text-primary)]">
              {t("workspace.settings.about.appName")}
            </strong>
          </div>
        </div>
        <button
          className="inline-flex h-7 shrink-0 cursor-default select-none items-center gap-1 rounded-full border-0 bg-[var(--background-fronted)] px-3 text-[12px] leading-5 text-[var(--text-secondary)] outline-none focus-visible:border-0 max-[560px]:ml-[70px]"
          type="button"
          onClick={onVersionTap}
        >
          <span>{t("workspace.settings.about.versionLabel")}</span>
          <span className="font-mono text-[13px] leading-5 text-[var(--text-primary)]">
            {desktopVersion}
          </span>
        </button>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[var(--border-1)] pt-4">
        <AboutActionButton
          icon={<WebIcon className="size-3.5" />}
          label={t("workspace.settings.about.websiteAction")}
          onClick={() => openExternal(tuttiWebsiteUrl)}
        />
        <AboutActionButton
          icon={<GitHubBrandIcon className="size-3.5" />}
          label={t("workspace.settings.about.githubAction")}
          onClick={() => openExternal(tuttiGitHubUrl)}
        />
      </div>
    </div>
  );
}

function AboutActionButton({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border-1)] bg-[var(--background-fronted)] px-3 text-[13px] font-semibold text-[var(--text-secondary)] outline-none transition-colors duration-150 hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:border-[var(--border-focus)]"
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function WorkspaceAppearanceSettingsSection({
  changingDockPlacement,
  changingMinimizeAnimation,
  changingThemeSource,
  changingWorkbenchWindowSnapping,
  dockPlacement,
  minimizeAnimation,
  onDockPlacementChange,
  onMinimizeAnimationChange,
  onWorkbenchWindowSnappingChange,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  onThemeChange,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  themeAppearance,
  themeSource,
  workbenchWindowSnapping
}: {
  changingDockPlacement: DesktopDockPlacement | null;
  changingMinimizeAnimation: DesktopMinimizeAnimation | null;
  changingThemeSource: DesktopThemeSource | null;
  changingWorkbenchWindowSnapping: DesktopWorkbenchWindowSnapping | null;
  dockPlacement: DesktopDockPlacement;
  minimizeAnimation: DesktopMinimizeAnimation;
  onDockPlacementChange: (placement: DesktopDockPlacement) => void;
  onMinimizeAnimationChange: (animation: DesktopMinimizeAnimation) => void;
  onWorkbenchWindowSnappingChange: (
    value: DesktopWorkbenchWindowSnapping
  ) => void;
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  onThemeChange: (source: DesktopThemeSource) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  themeAppearance: DesktopThemeAppearance;
  themeSource: DesktopThemeSource;
  workbenchWindowSnapping: DesktopWorkbenchWindowSnapping;
}) {
  const { t } = useTranslation();
  const isUpdatingTheme = changingThemeSource !== null;
  const pendingThemeSource = changingThemeSource ?? themeSource;
  const isUpdatingDockPlacement = changingDockPlacement !== null;
  const pendingDockPlacement = changingDockPlacement ?? dockPlacement;
  const isUpdatingMinimizeAnimation = changingMinimizeAnimation !== null;
  const pendingMinimizeAnimation =
    changingMinimizeAnimation ?? minimizeAnimation;
  const isUpdatingWorkbenchWindowSnapping =
    changingWorkbenchWindowSnapping !== null;
  const pendingWorkbenchWindowSnapping =
    changingWorkbenchWindowSnapping ?? workbenchWindowSnapping;

  return (
    <div className="flex flex-col gap-6 pb-[22px] pt-5">
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

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.minimizeAnimationLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.appearance.minimizeAnimationDescription")}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingMinimizeAnimation}
            value={pendingMinimizeAnimation}
            onValueChange={(value) =>
              onMinimizeAnimationChange(value as DesktopMinimizeAnimation)
            }
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.appearance.minimizeAnimationLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              {desktopMinimizeAnimations.map((animation) => (
                <SelectItem key={animation} value={animation}>
                  {t(
                    workspaceSettingsMinimizeAnimationOptionLabelKey(animation)
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.appearance.workbenchWindowSnappingLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.appearance.workbenchWindowSnappingDescription"
            )}
          </p>
        </div>
        <div className="w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0">
          <Select
            disabled={isUpdatingWorkbenchWindowSnapping}
            value={
              pendingWorkbenchWindowSnapping.enabled
                ? pendingWorkbenchWindowSnapping.shortcutPreset
                : "off"
            }
            onValueChange={(value) => {
              const nextValue =
                value as WorkspaceSettingsWindowSnappingSelectValue;
              onWorkbenchWindowSnappingChange({
                ...pendingWorkbenchWindowSnapping,
                enabled: nextValue !== "off",
                shortcutPreset:
                  nextValue === "off"
                    ? pendingWorkbenchWindowSnapping.shortcutPreset
                    : nextValue
              });
            }}
          >
            <SelectTrigger
              aria-label={t(
                "workspace.settings.appearance.workbenchWindowSnappingLabel"
              )}
              className={workspaceSettingsSelectTriggerClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              className={workspaceSettingsSelectContentClass}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <SelectItem value="off">
                {t(
                  "workspace.settings.appearance.workbenchWindowSnappingShortcutOptions.off"
                )}
              </SelectItem>
              {desktopWorkbenchWindowSnappingShortcutPresets.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {t(workspaceSettingsWindowSnappingShortcutLabelKey(preset))}
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
