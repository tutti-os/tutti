import { useCallback, useEffect, useRef, useState } from "react";
import {
  AddLinedIcon,
  Button,
  ChevronDownIcon,
  DeleteIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from "@tutti-os/ui-system";
import { useAnalyticsDebugPreferenceService } from "@renderer/features/analytics-debug";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import type { ExportDeveloperLogsInput } from "@shared/contracts/ipc";
import type { DesktopI18nKey } from "@shared/i18n";
import {
  desktopAppCatalogChannels,
  desktopFileDefaultOpeners,
  desktopUpdateChannels,
  normalizeDesktopFileExtension,
  type DesktopAppCatalogChannel,
  type DesktopFileDefaultOpener,
  type DesktopFileDefaultOpenersByExtension,
  type DesktopUpdateChannel
} from "@shared/preferences";
import {
  AGENT_QUICK_PROMPT_LIBRARY_FLAG,
  AGENT_REFERENCE_PROVENANCE_FILTER_FLAG,
  isFeatureEnabled,
  LAB_ENABLED_FLAG
} from "../../../../../shared/featureFlags/catalog.ts";
import { formatWorkspaceSettingsBytes } from "../services/workspaceSettingsFormat";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { SettingsRow, SettingsRows } from "./WorkspaceSettingsRows";

const workspaceSettingsSelectTriggerClass =
  "w-full h-8 min-w-0 overflow-hidden rounded-[6px] border-0 bg-[var(--transparency-block)] px-3 text-left text-[13px] font-normal text-[var(--text-primary)] !shadow-none !outline-none !ring-0 transition-colors duration-200 hover:bg-[var(--transparency-hover)] focus-visible:border-0 focus-visible:!ring-0 [&>svg]:text-[var(--text-tertiary)] *:data-[slot=select-value]:!block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1 *:data-[slot=select-value]:overflow-hidden *:data-[slot=select-value]:text-left *:data-[slot=select-value]:text-ellipsis *:data-[slot=select-value]:whitespace-nowrap";
const workspaceSettingsSelectContentClass =
  "w-[var(--radix-select-trigger-width)] rounded-[8px] border border-[var(--border-1)] bg-[var(--background-fronted)] px-1 text-[var(--text-primary)] shadow-[0_16px_40px_var(--shadow-elevated)] [--tutti-select-content-min-width:100%] !outline-none !ring-0";
const workspaceSettingsInputClass =
  "h-8 w-full rounded-[6px] border-0 bg-[var(--transparency-block)] px-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] focus-visible:border-0";

type FileDefaultOpenerDraft = {
  committedExtension: string | null;
  extension: string;
  id: number;
  opener: DesktopFileDefaultOpener;
};

export function WorkspaceDeveloperSettingsSection() {
  const { t } = useTranslation();
  const {
    service: analyticsDebugPreferenceService,
    state: analyticsDebugPreferenceState
  } = useAnalyticsDebugPreferenceService();
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();
  const pendingFeatureFlags =
    desktopPreferencesState.changingFeatureFlags ??
    desktopPreferencesState.featureFlags;
  const analyticsDebugAvailable = analyticsDebugPreferenceState.available;
  const analyticsDebugEnabled = analyticsDebugPreferenceState.enabled;
  const appCatalogChannel = desktopPreferencesState.appCatalogChannel;
  const changingAppCatalogChannel =
    desktopPreferencesState.changingAppCatalogChannel;
  const changingUpdateChannel = desktopPreferencesState.changingUpdateChannel;
  const developerLogs = settingsState.developerLogs;
  const developerPanelVisible = settingsState.developerPanelVisible;
  const fileDefaultOpenersByExtension =
    desktopPreferencesState.fileDefaultOpenersByExtension;
  const labEnabled = isFeatureEnabled(pendingFeatureFlags, LAB_ENABLED_FLAG);
  const referenceProvenanceFilterEnabled = isFeatureEnabled(
    pendingFeatureFlags,
    AGENT_REFERENCE_PROVENANCE_FILTER_FLAG
  );
  const quickPromptLibraryEnabled = isFeatureEnabled(
    pendingFeatureFlags,
    AGENT_QUICK_PROMPT_LIBRARY_FLAG
  );
  const featureFlagsUpdating =
    desktopPreferencesState.changingFeatureFlags !== null;
  const showAppDeveloperSources =
    desktopPreferencesState.showAppDeveloperSources;
  const tuttiAgentSwitchEnabled = settingsState.tuttiAgentSwitchEnabled;
  const updateChannel = desktopPreferencesState.updateChannel;
  const onAnalyticsDebugEnabledChange = (enabled: boolean) => {
    analyticsDebugPreferenceService.setEnabled(enabled);
  };
  const onAppCatalogChannelChange = (channel: DesktopAppCatalogChannel) => {
    void settingsService.changeAppCatalogChannel(channel);
  };
  const onClearConversationHistory = () => {
    if (
      window.confirm(
        t("workspace.settings.developer.clearConversationHistoryConfirm")
      )
    ) {
      void settingsService.clearConversationHistory();
    }
  };
  const onClearLogs = () => {
    void settingsService.clearDeveloperLogs();
  };
  const onDeveloperPanelVisibleChange = (visible: boolean) => {
    settingsService.setDeveloperPanelVisible(visible);
  };
  const onExportLogs = (input: ExportDeveloperLogsInput) => {
    void settingsService.exportDeveloperLogs(input);
  };
  const onFileDefaultOpenersChange = (
    openersByExtension: DesktopFileDefaultOpenersByExtension
  ) => {
    void desktopPreferencesService.setFileDefaultOpenersByExtension(
      openersByExtension
    );
  };
  const onLabEnabledChange = (enabled: boolean) => {
    void settingsService.changeFeatureFlags({
      ...pendingFeatureFlags,
      [LAB_ENABLED_FLAG]: enabled
    });
  };
  const onReferenceProvenanceFilterEnabledChange = (enabled: boolean) => {
    void settingsService.changeFeatureFlags({
      ...pendingFeatureFlags,
      [AGENT_REFERENCE_PROVENANCE_FILTER_FLAG]: enabled
    });
  };
  const onQuickPromptLibraryEnabledChange = (enabled: boolean) => {
    void settingsService.changeFeatureFlags({
      ...pendingFeatureFlags,
      [AGENT_QUICK_PROMPT_LIBRARY_FLAG]: enabled
    });
  };
  const onShowAppDeveloperSourcesChange = (show: boolean) => {
    void settingsService.changeShowAppDeveloperSources(show);
  };
  const onTuttiAgentSwitchEnabledChange = (enabled: boolean) => {
    void settingsService.setTuttiAgentSwitchEnabled(enabled);
  };
  const onUpdateChannelChange = (channel: DesktopUpdateChannel) => {
    void settingsService.changeUpdateChannel(channel);
  };
  const logs = developerLogs.logs;
  const [fileDefaultOpenerDrafts, setFileDefaultOpenerDrafts] = useState<
    FileDefaultOpenerDraft[]
  >([]);
  const fileDefaultOpenerDraftIDRef = useRef(0);
  const fileDefaultOpenerInputRefs = useRef(
    new Map<number, HTMLInputElement>()
  );
  const [pendingFileDefaultOpenerDraftID, setPendingFileDefaultOpenerDraftID] =
    useState<number | null>(null);
  const draftCommittedExtensions = new Set(
    fileDefaultOpenerDrafts.flatMap((draft) =>
      draft.committedExtension ? [draft.committedExtension] : []
    )
  );
  const fileDefaultOpeners = Object.entries(fileDefaultOpenersByExtension)
    .filter(([extension]) => !draftCommittedExtensions.has(extension))
    .sort(([left], [right]) => left.localeCompare(right));

  const addFileDefaultOpener = useCallback(() => {
    const id = fileDefaultOpenerDraftIDRef.current++;
    setFileDefaultOpenerDrafts((drafts) => [
      ...drafts,
      { committedExtension: null, extension: "", id, opener: "fileViewer" }
    ]);
    setPendingFileDefaultOpenerDraftID(id);
  }, []);

  useEffect(() => {
    if (pendingFileDefaultOpenerDraftID === null) {
      return;
    }
    const input = fileDefaultOpenerInputRefs.current.get(
      pendingFileDefaultOpenerDraftID
    );
    if (!input) {
      return;
    }
    input.focus();
    setPendingFileDefaultOpenerDraftID(null);
  }, [fileDefaultOpenerDrafts.length, pendingFileDefaultOpenerDraftID]);

  const updateFileDefaultOpenerDraft = useCallback(
    (id: number, patch: Partial<Omit<FileDefaultOpenerDraft, "id">>) => {
      setFileDefaultOpenerDrafts((drafts) =>
        drafts.map((draft) => {
          if (draft.id !== id) {
            return draft;
          }
          const nextDraft = { ...draft, ...patch };
          const normalizedExtension = normalizeDesktopFileExtension(
            nextDraft.extension
          );
          const nextOpeners = { ...fileDefaultOpenersByExtension };
          if (draft.committedExtension) {
            delete nextOpeners[draft.committedExtension];
          }
          const canCommitExtension =
            normalizedExtension &&
            (fileDefaultOpenersByExtension[normalizedExtension] === undefined ||
              normalizedExtension === draft.committedExtension);
          if (canCommitExtension) {
            nextOpeners[normalizedExtension] = nextDraft.opener;
            nextDraft.committedExtension = normalizedExtension;
          } else if (normalizedExtension && draft.committedExtension) {
            nextOpeners[draft.committedExtension] = draft.opener;
            nextDraft.committedExtension = draft.committedExtension;
          } else {
            nextDraft.committedExtension = null;
          }
          onFileDefaultOpenersChange(nextOpeners);
          return nextDraft;
        })
      );
    },
    [fileDefaultOpenersByExtension, onFileDefaultOpenersChange]
  );

  const removeFileDefaultOpenerDraft = useCallback(
    (id: number) => {
      const draft = fileDefaultOpenerDrafts.find(
        (candidate) => candidate.id === id
      );
      if (!draft) {
        return;
      }
      if (draft.committedExtension) {
        const { [draft.committedExtension]: _removed, ...remaining } =
          fileDefaultOpenersByExtension;
        onFileDefaultOpenersChange(remaining);
      }
      setFileDefaultOpenerDrafts((drafts) =>
        drafts.filter((candidate) => candidate.id !== id)
      );
    },
    [
      fileDefaultOpenerDrafts,
      fileDefaultOpenersByExtension,
      onFileDefaultOpenersChange
    ]
  );

  return (
    <SettingsRows>
      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.visibilityLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.developer.visibilityDescription")}
          </p>
        </div>
        <Switch
          aria-label={t("workspace.settings.developer.visibilityLabel")}
          checked={developerPanelVisible}
          onCheckedChange={onDeveloperPanelVisibleChange}
        />
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.quickPromptLibraryLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.developer.quickPromptLibraryDescription")}
          </p>
        </div>
        <Switch
          aria-label={t("workspace.settings.developer.quickPromptLibraryLabel")}
          checked={quickPromptLibraryEnabled}
          disabled={featureFlagsUpdating}
          onCheckedChange={onQuickPromptLibraryEnabledChange}
        />
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.referenceProvenanceFilterLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.developer.referenceProvenanceFilterDescription"
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            "workspace.settings.developer.referenceProvenanceFilterLabel"
          )}
          checked={referenceProvenanceFilterEnabled}
          disabled={featureFlagsUpdating}
          onCheckedChange={onReferenceProvenanceFilterEnabledChange}
        />
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.labVisibilityLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.developer.labVisibilityDescription")}
          </p>
        </div>
        <Switch
          aria-label={t("workspace.settings.developer.labVisibilityLabel")}
          checked={labEnabled}
          disabled={featureFlagsUpdating}
          onCheckedChange={onLabEnabledChange}
        />
      </div>

      <AppCatalogChannelControl
        appCatalogChannel={appCatalogChannel}
        changingAppCatalogChannel={changingAppCatalogChannel}
        onAppCatalogChannelChange={onAppCatalogChannelChange}
      />

      <ReleaseChannelControl
        changingUpdateChannel={changingUpdateChannel}
        updateChannel={updateChannel}
        onUpdateChannelChange={onUpdateChannelChange}
      />

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.tuttiAgentSwitchLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.developer.tuttiAgentSwitchDescription")}
          </p>
        </div>
        <Switch
          aria-label={t("workspace.settings.developer.tuttiAgentSwitchLabel")}
          checked={tuttiAgentSwitchEnabled}
          onCheckedChange={onTuttiAgentSwitchEnabledChange}
        />
      </div>

      <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.showAppDeveloperSourcesLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t(
              "workspace.settings.developer.showAppDeveloperSourcesDescription"
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            "workspace.settings.developer.showAppDeveloperSourcesLabel"
          )}
          checked={showAppDeveloperSources}
          onCheckedChange={onShowAppDeveloperSourcesChange}
        />
      </div>

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

      <div className="flex w-full flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.developer.fileDefaultOpenersLabel")}
          </strong>
          <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
            {t("workspace.settings.developer.fileDefaultOpenersDescription")}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 rounded-[10px] bg-[var(--transparency-block)] p-4">
          <div className="grid gap-2">
            {fileDefaultOpeners.map(([extension, opener]) => (
              <div
                key={extension}
                className="grid grid-cols-[minmax(70px,0.7fr)_minmax(130px,1fr)_auto] items-center gap-2"
              >
                <span className="min-w-0 truncate text-[13px] text-[var(--text-primary)]">
                  .{extension}
                </span>
                <Select
                  value={opener}
                  onValueChange={(value) => {
                    onFileDefaultOpenersChange({
                      ...fileDefaultOpenersByExtension,
                      [extension]: value as DesktopFileDefaultOpener
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label={t(
                      "workspace.settings.developer.fileDefaultOpenerActionLabel",
                      { extension }
                    )}
                    className={workspaceSettingsSelectTriggerClass}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    className={workspaceSettingsSelectContentClass}
                    style={{ zIndex: "var(--z-panel-popover)" }}
                  >
                    {desktopFileDefaultOpeners.map((candidate) => (
                      <SelectItem key={candidate} value={candidate}>
                        {t(
                          workspaceSettingsFileDefaultOpenerLabelKey(candidate)
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  aria-label={t(
                    "workspace.settings.developer.removeFileDefaultOpener",
                    { extension }
                  )}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    const { [extension]: _removed, ...remaining } =
                      fileDefaultOpenersByExtension;
                    onFileDefaultOpenersChange(remaining);
                  }}
                >
                  <DeleteIcon className="size-3.5" />
                </Button>
              </div>
            ))}
            {fileDefaultOpenerDrafts.map((draft) => (
              <div
                key={draft.id}
                className="grid grid-cols-[minmax(70px,0.7fr)_minmax(130px,1fr)_auto] items-center gap-2"
              >
                <Input
                  aria-label={t(
                    "workspace.settings.developer.fileDefaultOpenerExtensionLabel"
                  )}
                  className={workspaceSettingsInputClass}
                  placeholder={t(
                    "workspace.settings.developer.fileDefaultOpenerExtensionPlaceholder"
                  )}
                  ref={(input) => {
                    if (input) {
                      fileDefaultOpenerInputRefs.current.set(draft.id, input);
                      return;
                    }
                    fileDefaultOpenerInputRefs.current.delete(draft.id);
                  }}
                  value={draft.extension}
                  onChange={(event) =>
                    updateFileDefaultOpenerDraft(draft.id, {
                      extension: event.currentTarget.value
                    })
                  }
                />
                <Select
                  value={draft.opener}
                  onValueChange={(value) =>
                    updateFileDefaultOpenerDraft(draft.id, {
                      opener: value as DesktopFileDefaultOpener
                    })
                  }
                >
                  <SelectTrigger
                    aria-label={t(
                      "workspace.settings.developer.fileDefaultOpenerNewActionLabel"
                    )}
                    className={workspaceSettingsSelectTriggerClass}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    className={workspaceSettingsSelectContentClass}
                    style={{ zIndex: "var(--z-panel-popover)" }}
                  >
                    {desktopFileDefaultOpeners.map((candidate) => (
                      <SelectItem key={candidate} value={candidate}>
                        {t(
                          workspaceSettingsFileDefaultOpenerLabelKey(candidate)
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  aria-label={t(
                    "workspace.settings.developer.removeFileDefaultOpener",
                    { extension: draft.extension }
                  )}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  variant="ghost"
                  type="button"
                  onClick={() => removeFileDefaultOpenerDraft(draft.id)}
                >
                  <DeleteIcon className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              className="w-fit px-0 text-[var(--tutti-purple)] hover:no-underline"
              variant="link"
              type="button"
              onClick={addFileDefaultOpener}
            >
              <AddLinedIcon className="size-3.5" />
              {t("workspace.settings.developer.addFileDefaultOpener")}
            </Button>
          </div>
        </div>
      </div>

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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                type="button"
                disabled={developerLogs.exporting}
              >
                {developerLogs.exporting
                  ? t("workspace.settings.developer.exportingLogs")
                  : t("workspace.settings.developer.exportLogs")}
                <ChevronDownIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem
                onSelect={() =>
                  onExportLogs({
                    includeAgentSessions: false,
                    scope: "recent-10-minutes"
                  })
                }
              >
                {t(
                  "workspace.settings.developer.exportRecentTenMinutesLogsOnly"
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  onExportLogs({
                    includeAgentSessions: true,
                    scope: "recent-10-minutes"
                  })
                }
              >
                {t(
                  "workspace.settings.developer.exportRecentTenMinutesLogsWithSessions"
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  onExportLogs({
                    includeAgentSessions: false,
                    scope: "recent-3-days"
                  })
                }
              >
                {t(
                  "workspace.settings.developer.exportRecentThreeDaysLogsOnly"
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  onExportLogs({
                    includeAgentSessions: true,
                    scope: "recent-3-days"
                  })
                }
              >
                {t(
                  "workspace.settings.developer.exportRecentThreeDaysLogsWithSessions"
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
          <Button
            variant="secondary"
            type="button"
            onClick={onClearConversationHistory}
            disabled={developerLogs.clearingConversationHistory}
          >
            <DeleteIcon className="size-3.5" />
            {developerLogs.clearingConversationHistory
              ? t("workspace.settings.developer.clearingConversationHistory")
              : t("workspace.settings.developer.clearConversationHistory")}
          </Button>
        </div>
      </SettingsRow>
    </SettingsRows>
  );
}

function AppCatalogChannelControl({
  appCatalogChannel,
  changingAppCatalogChannel,
  onAppCatalogChannelChange
}: {
  appCatalogChannel: DesktopAppCatalogChannel;
  changingAppCatalogChannel: DesktopAppCatalogChannel | null;
  onAppCatalogChannelChange: (channel: DesktopAppCatalogChannel) => void;
}) {
  const { t } = useTranslation();
  const effectiveAppCatalogChannel =
    changingAppCatalogChannel ?? appCatalogChannel;

  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.apps.appCatalogChannelLabel")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
          {t("workspace.settings.apps.appCatalogChannelDescription")}
        </p>
      </div>
      <div
        aria-label={t("workspace.settings.apps.appCatalogChannelLabel")}
        className="grid h-8 shrink-0 grid-cols-2 overflow-hidden rounded-[6px] bg-[var(--transparency-block)] p-0.5"
        role="group"
      >
        {desktopAppCatalogChannels.map((channel) => {
          const selected = effectiveAppCatalogChannel === channel;
          return (
            <button
              key={channel}
              aria-pressed={selected}
              className={cn(
                "min-w-[92px] rounded-[5px] border-0 px-3 text-[13px] font-semibold leading-none outline-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--border-focus)]",
                selected
                  ? "bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-none"
                  : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
              disabled={changingAppCatalogChannel !== null}
              type="button"
              onClick={() => onAppCatalogChannelChange(channel)}
            >
              {t(workspaceSettingsAppCatalogChannelOptionLabelKey(channel))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function workspaceSettingsAppCatalogChannelOptionLabelKey(
  channel: DesktopAppCatalogChannel
): DesktopI18nKey {
  switch (channel) {
    case "production":
      return "workspace.settings.apps.appCatalogChannelOptions.production";
    case "staging":
      return "workspace.settings.apps.appCatalogChannelOptions.staging";
  }
}

function ReleaseChannelControl({
  changingUpdateChannel,
  updateChannel,
  onUpdateChannelChange
}: {
  changingUpdateChannel: DesktopUpdateChannel | null;
  updateChannel: DesktopUpdateChannel;
  onUpdateChannelChange: (channel: DesktopUpdateChannel) => void;
}) {
  const { t } = useTranslation();
  const effectiveUpdateChannel = changingUpdateChannel ?? updateChannel;

  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-1 max-[560px]:w-full">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {t("workspace.settings.developer.releaseChannelLabel")}
        </strong>
        <p className="m-0 text-[13px] leading-[1.3] text-[var(--text-secondary)]">
          {t("workspace.settings.developer.releaseChannelDescription")}
        </p>
      </div>
      <div
        aria-label={t("workspace.settings.developer.releaseChannelLabel")}
        className="grid h-8 shrink-0 grid-cols-2 overflow-hidden rounded-[6px] bg-[var(--transparency-block)] p-0.5"
        role="group"
      >
        {desktopUpdateChannels.map((channel) => {
          const selected = effectiveUpdateChannel === channel;
          return (
            <button
              key={channel}
              aria-pressed={selected}
              className={cn(
                "min-w-[92px] rounded-[5px] border-0 px-3 text-[13px] font-semibold leading-none outline-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--border-focus)]",
                selected
                  ? "bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-none"
                  : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
              disabled={changingUpdateChannel !== null}
              type="button"
              onClick={() => onUpdateChannelChange(channel)}
            >
              {t(workspaceSettingsUpdateChannelOptionLabelKey(channel))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function workspaceSettingsUpdateChannelOptionLabelKey(
  channel: DesktopUpdateChannel
): DesktopI18nKey {
  switch (channel) {
    case "stable":
      return "workspace.settings.developer.releaseChannelOptions.stable";
    case "rc":
      return "workspace.settings.developer.releaseChannelOptions.rc";
  }
}

function workspaceSettingsFileDefaultOpenerLabelKey(
  opener: DesktopFileDefaultOpener
): DesktopI18nKey {
  return `workspace.settings.developer.fileDefaultOpenerOptions.${opener}`;
}
