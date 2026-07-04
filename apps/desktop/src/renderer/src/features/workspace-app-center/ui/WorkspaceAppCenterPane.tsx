import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterViewState,
  WorkspaceAppManifest,
  WorkspaceAppRecord,
  WorkspaceAppRuntimeState
} from "@tutti-os/workspace-app-center";
import {
  createAppCenterViewModel,
  workspaceAppManifestSchemaVersion
} from "@tutti-os/workspace-app-center";
import { resolveDefaultAppFactoryProvider } from "@tutti-os/workspace-app-center/core";
import { createAppCenterI18nRuntime } from "@tutti-os/workspace-app-center/i18n";
import type {
  AppCenterAppTab,
  AppCenterFactoryProviderConfiguration,
  AppCenterFactoryProviderOption,
  AppCenterHostActions
} from "@tutti-os/workspace-app-center/ui";
import { AppCenterPanel } from "@tutti-os/workspace-app-center/ui";
import { agentGuiDockIconUrls } from "@tutti-os/agent-gui";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import { useService } from "@tutti-os/infra/di";
import {
  IAgentProviderStatusService,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import {
  isWorkspaceAgentGuiComingSoonProvider,
  resolveWorkspaceAgentGuiLabel,
  workspaceAgentGuiProviders
} from "@renderer/features/workspace-workbench/services/workspaceAgentProviderCatalog";
import { shouldShowWorkspaceApp } from "../services/workspaceAppVisibility.ts";
import { useWorkspaceAppCenterService } from "./useWorkspaceAppCenterService.ts";

const aiPptAppIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/PPT.png",
  import.meta.url
).href;
const aiDocumentAppIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/document.png",
  import.meta.url
).href;
const aiSheetAppIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/sheet.png",
  import.meta.url
).href;
const openCutAppIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/opencut.png",
  import.meta.url
).href;
const productCompetitionAppIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/product-competition.png",
  import.meta.url
).href;
const designReviewAppIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/design-review.png",
  import.meta.url
).href;
const tuttiDeveloperIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/tutti.png",
  import.meta.url
).href;

const communityAppDeveloperOverrides: Record<
  string,
  NonNullable<WorkspaceAppManifest["authors"]>[number]
> = {
  "group-chat": {
    name: "svenzeng",
    url: "https://github.com/tutti-os/tutti"
  }
};

const comingSoonWorkspaceAppDefinitions = [
  {
    appId: "ai-slide",
    descriptionKey: "appCenter.comingSoonApps.aiPpt.description",
    iconUrl: aiPptAppIconUrl,
    nameKey: "appCenter.comingSoonApps.aiPpt.name",
    tags: ["coming-soon", "office", "presentation"]
  },
  {
    appId: "ai-doc",
    descriptionKey: "appCenter.comingSoonApps.aiDocument.description",
    iconUrl: aiDocumentAppIconUrl,
    nameKey: "appCenter.comingSoonApps.aiDocument.name",
    tags: ["coming-soon", "office", "document"]
  },
  {
    appId: "ai-sheet",
    descriptionKey: "appCenter.comingSoonApps.aiSheet.description",
    iconUrl: aiSheetAppIconUrl,
    nameKey: "appCenter.comingSoonApps.aiSheet.name",
    tags: ["coming-soon", "office", "spreadsheet"]
  },
  {
    appId: "open-cut",
    descriptionKey: "appCenter.comingSoonApps.openCut.description",
    iconUrl: openCutAppIconUrl,
    nameKey: "appCenter.comingSoonApps.openCut.name",
    tags: ["coming-soon", "content", "creation", "video", "timeline", "editor"]
  },
  {
    appId: "product-competition",
    descriptionKey: "appCenter.comingSoonApps.productCompetition.description",
    iconUrl: productCompetitionAppIconUrl,
    nameKey: "appCenter.comingSoonApps.productCompetition.name",
    tags: ["coming-soon", "product", "design"]
  },
  {
    appId: "design-review",
    descriptionKey: "appCenter.comingSoonApps.designReview.description",
    iconUrl: designReviewAppIconUrl,
    nameKey: "appCenter.comingSoonApps.designReview.name",
    tags: ["coming-soon", "product", "design"]
  }
] as const;

export function WorkspaceAppCenterPane({
  restoredViewState = null,
  workspaceId
}: {
  restoredViewState?: WorkspaceAppCenterViewState | null;
  workspaceId: string;
}) {
  const { service, state } = useWorkspaceAppCenterService();
  const { state: desktopPreferencesState } = useDesktopPreferencesService();
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const agentProviderSnapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    () => agentProviderStatusService.getSnapshot()
  );
  const { i18n, locale } = useTranslation();
  const copy = useMemo(() => createAppCenterI18nRuntime(i18n), [i18n]);
  const normalizedWorkspaceId = workspaceId.trim();
  const storedViewState = normalizedWorkspaceId
    ? state.viewStateByWorkspaceId[normalizedWorkspaceId]
    : undefined;
  const viewState =
    storedViewState ?? service.getViewState(workspaceId, restoredViewState);
  useEffect(() => {
    void service.refreshCatalog(workspaceId);
  }, [service, workspaceId]);
  useEffect(() => {
    void agentProviderStatusService.ensureLoaded({
      providers: [...workspaceAgentGuiProviders]
    });
  }, [agentProviderStatusService]);
  const factoryProviderOptions = useMemo(
    () =>
      resolveAppCenterReadyAgentProviderOptions(agentProviderSnapshot.statuses),
    [agentProviderSnapshot.statuses]
  );
  const catalogPanelStatus =
    state.catalogStatus === "loading" || state.catalogStatus === "failed"
      ? state.catalogStatus
      : undefined;
  const comingSoonApps = useMemo(
    () => createComingSoonWorkspaceApps(i18n, locale),
    [i18n, locale]
  );
  const categoryLabels = useMemo(
    () => createWorkspaceAppCategoryLabels(i18n),
    [i18n]
  );
  const loadFactoryProviderConfiguration = useMemo(
    () =>
      async (
        provider: string
      ): Promise<AppCenterFactoryProviderConfiguration> => {
        return service.getFactoryProviderConfiguration({
          provider,
          workspaceId
        });
      },
    [service, workspaceId]
  );
  const appCenterActions = useMemo<AppCenterHostActions>(
    () => ({
      cancelFactoryJob: (jobId) =>
        service.cancelFactoryJob({ jobId, workspaceId }),
      createFactoryJob: (input) =>
        service.createFactoryJob({ ...input, workspaceId }),
      deleteFactoryJob: (jobId) =>
        service.deleteFactoryJob({ jobId, workspaceId }),
      deleteApp: (appId) => service.deleteApp({ appId, workspaceId }),
      exportApp: (appId) => service.exportApp({ appId, workspaceId }),
      fixFactoryJob: (jobId, prompt) =>
        service.fixFactoryJob({ jobId, prompt, workspaceId }),
      importApp: () => service.importApp({ workspaceId }),
      installApp: (appId) => service.installApp({ appId, workspaceId }),
      loadLocalApp: () => service.loadLocalApp({ workspaceId }),
      openApp: async (appId) => {
        await service.openApp({ appId, workspaceId });
      },
      openAppFolder: (appId) => service.openAppFolder({ appId, workspaceId }),
      openAppPackageFolder: (appId) =>
        service.openAppPackageFolder({ appId, workspaceId }),
      openExternalUrl: (url) => service.openExternalUrl(url),
      openFactoryJobAgentSession: async (agentSessionId, provider) => {
        await requestWorkspaceAgentGuiLaunch({
          agentSessionId,
          provider: normalizeDesktopAgentGUIProvider(provider),
          workspaceId
        });
      },
      modifyAppWithAgent: async (jobId, agentSessionId, provider) => {
        const preparedJob = await service.prepareFactoryJobModification({
          jobId,
          workspaceId
        });
        if (!preparedJob) {
          return;
        }
        await requestWorkspaceAgentGuiLaunch({
          agentSessionId: preparedJob.agentSessionId ?? agentSessionId,
          provider: normalizeDesktopAgentGUIProvider(
            preparedJob.provider ?? provider
          ),
          workspaceId
        });
      },
      publishFactoryJob: (jobId) =>
        service.publishFactoryJob({ jobId, workspaceId }),
      refreshCatalog: () => service.refreshCatalog(workspaceId),
      reloadLocalApp: (appId) => service.reloadLocalApp({ appId, workspaceId }),
      repairLocalApp: async (request) => {
        const draftPrompt = request.prompt.trim();
        if (!draftPrompt) {
          return;
        }
        const provider = resolveDefaultAppFactoryProvider(
          factoryProviderOptions,
          agentProviderSnapshot.defaultProvider
        );
        const userProjectPath = request.projectDir.trim();
        await requestWorkspaceAgentGuiLaunch({
          draftPrompt,
          provider: normalizeDesktopAgentGUIProvider(provider),
          ...(userProjectPath ? { userProjectPath } : {}),
          workspaceId
        });
      },
      retryFactoryValidation: (jobId) =>
        service.retryFactoryValidation({ jobId, workspaceId }),
      retryApp: (appId) => service.retryApp({ appId, workspaceId }),
      replaceAppIcon: (appId) => service.replaceAppIcon({ appId, workspaceId }),
      restartAndOpenApp: (appId) => {
        void service.restartAndOpenApp({ appId, workspaceId });
      },
      shouldConfirmAppUpdate: (appId) =>
        service.isWorkspaceAppViewOpen({ appId, workspaceId }),
      updateApp: (appId, trigger) =>
        service.updateApp({ appId, trigger, workspaceId }),
      uninstallApp: (appId) => service.uninstallApp({ appId, workspaceId })
    }),
    [
      agentProviderSnapshot.defaultProvider,
      factoryProviderOptions,
      service,
      workspaceId
    ]
  );
  const handleActiveAppTabChange = useCallback(
    (activeAppTab: AppCenterAppTab) => {
      service.setViewState({
        state: { activeAppTab },
        workspaceId
      });
    },
    [service, workspaceId]
  );
  const viewModel = useMemo(() => {
    const recommendedApps = withComingSoonWorkspaceApps(
      state.apps,
      comingSoonApps
    ).filter((app) => shouldShowWorkspaceApp(app.appId));

    return createAppCenterViewModel({
      apps: recommendedApps.map((app) =>
        toWorkspaceAppRecord(
          app,
          resolveWorkspaceAppCategory(app.appId, categoryLabels)
        )
      ),
      factoryJobs: state.factoryJobs.map((job) => ({
        agentSessionId: job.agentSessionId,
        appId: job.appId,
        displayName: job.displayName,
        failureReason: job.failureReason,
        jobId: job.jobId,
        prompt: job.prompt,
        provider: job.provider,
        publishedVersion: job.publishedVersion,
        status: job.status,
        updatedAtUnixMs: job.updatedAtUnixMs,
        validationResult: job.validationResult
      })),
      locale,
      replaceableIconAppIds: state.apps
        .filter((app) => app.source === "generated")
        .map((app) => app.appId),
      runtimeStates: recommendedApps.map((app) =>
        toWorkspaceAppRuntimeState(app)
      )
    });
  }, [
    categoryLabels,
    comingSoonApps,
    i18n,
    locale,
    state.apps,
    state.factoryJobs
  ]);

  return (
    <>
      <WorkspaceAppCenterErrorToast />
      <AppCenterPanel
        actions={appCenterActions}
        activeAppTab={viewState.activeAppTab}
        catalogStatus={catalogPanelStatus}
        copy={copy}
        defaultAgentProvider={agentProviderSnapshot.defaultProvider}
        loadProviderConfiguration={loadFactoryProviderConfiguration}
        onActiveAppTabChange={handleActiveAppTabChange}
        officialDeveloperIconUrl={tuttiDeveloperIconUrl}
        providerErrorMessage={agentProviderSnapshot.error}
        providerLoading={agentProviderSnapshot.isLoading}
        providerOptions={factoryProviderOptions}
        showDeveloperSources={desktopPreferencesState.showAppDeveloperSources}
        viewModel={viewModel}
      />
    </>
  );
}

function WorkspaceAppCenterErrorToast() {
  const { service, state } = useWorkspaceAppCenterService();

  useEffect(() => {
    if (!state.error) {
      return;
    }
    const error = service.consumeError();
    if (error) {
      Toast.Error(error);
    }
  }, [service, state.error]);

  return null;
}

function createComingSoonWorkspaceApps(
  i18n: { readonly t: (key: string) => string },
  locale: string
): readonly WorkspaceAppCenterApp[] {
  return comingSoonWorkspaceAppDefinitions.map((definition) =>
    createComingSoonWorkspaceApp({
      description: i18n.t(definition.descriptionKey),
      definition,
      locale,
      name: i18n.t(definition.nameKey),
      t: i18n.t
    })
  );
}

function createComingSoonWorkspaceApp(input: {
  readonly definition: (typeof comingSoonWorkspaceAppDefinitions)[number];
  readonly description: string;
  readonly locale: string;
  readonly name: string;
  readonly t: (key: string) => string;
}): WorkspaceAppCenterApp {
  return {
    appId: input.definition.appId,
    createdAtUnixMs: 0,
    description: input.description,
    enabled: false,
    exportable: false,
    iconUrl: input.definition.iconUrl,
    installed: false,
    localizations: [
      {
        description: input.description,
        locale: input.locale,
        name: input.name,
        tags: []
      }
    ],
    minimizeBehavior: "keep-mounted",
    name: input.name,
    references: { listSupported: false },
    runtimeStatus: "idle",
    source: "builtin",
    stateRevision: 0,
    tags: input.definition.tags,
    updateAvailable: false
  };
}

function withComingSoonWorkspaceApps(
  apps: readonly WorkspaceAppCenterApp[],
  comingSoonApps: readonly WorkspaceAppCenterApp[]
): readonly WorkspaceAppCenterApp[] {
  const comingSoonByAppId = new Map(
    comingSoonApps.map((app) => [app.appId, app] as const)
  );
  const mergedApps = apps.map((app) => {
    const comingSoonApp = comingSoonByAppId.get(app.appId);
    if (!comingSoonApp) {
      return app;
    }
    comingSoonByAppId.delete(app.appId);
    return app;
  });
  const remainingComingSoonApps = [...comingSoonByAppId.values()];
  return remainingComingSoonApps.length > 0
    ? [...mergedApps, ...remainingComingSoonApps]
    : mergedApps;
}

function createWorkspaceAppCategoryLabels(i18n: {
  readonly t: (key: string) => string;
}): Record<WorkspaceAppCategoryID, string> {
  return {
    contentCreation: i18n.t("appCenter.categories.contentCreation"),
    office: i18n.t("appCenter.categories.office"),
    productDesign: i18n.t("appCenter.categories.productDesign"),
    tools: i18n.t("appCenter.categories.tools")
  };
}

type WorkspaceAppCategoryID =
  | "contentCreation"
  | "office"
  | "productDesign"
  | "tools";

function resolveWorkspaceAppCategory(
  appId: string,
  labels: Record<WorkspaceAppCategoryID, string>
): string | null {
  switch (appId.trim().toLowerCase()) {
    case "product-competition":
    case "daily-product-radar":
    case "daily-tech-radar":
    case "radar":
    case "design-review":
    case "vibe-design":
      return labels.productDesign;
    case "ai-slide":
    case "ai-doc":
    case "ai-sheet":
      return labels.office;
    case "ai-media-canvas":
    case "media-canvas":
    case "open-cut":
      return labels.contentCreation;
    case "automation":
    case "group-chat":
    case "issue":
    case "issues":
    case "issue-manager":
    case "workspace-issue":
    case "workspace-issue-manager":
    case "draw-topic-app":
    case "answer-book":
    case "app_answer_book":
    case "idea-draw":
      return labels.tools;
    default:
      return null;
  }
}

function resolveAppCenterReadyAgentProviderOptions(
  statuses: readonly AgentProviderStatus[]
): readonly AppCenterFactoryProviderOption[] {
  const readyProviders = new Set(
    statuses
      .filter((status) => status.availability.status === "ready")
      .map((status) => status.provider)
  );

  return workspaceAgentGuiProviders
    .filter(
      (provider) =>
        readyProviders.has(provider) &&
        !isWorkspaceAgentGuiComingSoonProvider(provider)
    )
    .map((provider) => ({
      iconUrl: agentGuiDockIconUrls[provider],
      label: resolveWorkspaceAgentGuiLabel(provider),
      provider
    }));
}

function toWorkspaceAppRecord(
  app: WorkspaceAppCenterApp,
  category: string | null
): WorkspaceAppRecord {
  const manifest = toWorkspaceAppManifest(app);
  return {
    availableIconUrl: app.availableIconUrl,
    availableVersion: app.availableVersion,
    catalog: {
      localizations: (app.localizations ?? []).map((localization) => ({
        description: localization.description,
        locale: localization.locale,
        name: localization.name,
        tags: localization.tags
      })),
      manifest,
      source: {
        kind:
          app.source === "builtin"
            ? "bundled"
            : app.source === "local-dev"
              ? "local-dev"
              : "local"
      }
    },
    category,
    createdAtUnixMs: app.createdAtUnixMs,
    install: app.installed
      ? {
          ...(app.installationId?.trim()
            ? { installationId: app.installationId.trim() }
            : {}),
          appId: app.appId,
          version: app.version ?? null
        }
      : null,
    manifest,
    updateAvailable: app.updateAvailable
  };
}

function toWorkspaceAppManifest(
  app: WorkspaceAppCenterApp
): WorkspaceAppManifest {
  const authors = normalizeWorkspaceAppManifestAuthors(app);
  return {
    appId: app.appId,
    description: app.description ?? "",
    runtime: {
      bootstrap: "bootstrap.sh",
      healthcheckPath: "/"
    },
    ...(app.iconUrl
      ? {
          icon: {
            type: "asset" as const,
            src: app.iconUrl
          }
        }
      : {}),
    name: app.name,
    ...(authors.length > 0 ? { authors } : {}),
    ...(app.repository ? { source: app.repository } : {}),
    schemaVersion: workspaceAppManifestSchemaVersion,
    tags: app.tags ?? [],
    version: app.version ?? "0.1.0",
    window: {
      minimizeBehavior: app.minimizeBehavior
    }
  };
}

function normalizeWorkspaceAppManifestAuthors(
  app: WorkspaceAppCenterApp
): NonNullable<WorkspaceAppManifest["authors"]> {
  const developerOverride =
    communityAppDeveloperOverrides[app.appId.trim().toLowerCase()];
  const authors = developerOverride
    ? [
        developerOverride,
        ...(app.authors ?? []).filter(
          (author) =>
            author.name.trim().toLowerCase() !==
            developerOverride.name.toLowerCase()
        )
      ]
    : (app.authors ?? []);

  return authors
    .map((author) => {
      const name = author.name.trim();
      const avatarUrl = author.avatarUrl?.trim();
      const url = author.url?.trim();
      if (!name) {
        return null;
      }
      return {
        name,
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(url ? { url } : {})
      };
    })
    .filter((author): author is NonNullable<typeof author> => author !== null);
}

function toWorkspaceAppRuntimeState(
  app: WorkspaceAppCenterApp
): WorkspaceAppRuntimeState {
  const cliIssue =
    app.cli?.status === "warning" || app.cli?.status === "error"
      ? app.cli.issues[0]
      : null;
  return {
    ...(app.runtimeId?.trim() ? { runtimeId: app.runtimeId.trim() } : {}),
    ...(app.installationId?.trim()
      ? { installationId: app.installationId.trim() }
      : {}),
    appId: app.appId,
    launchUrl: app.launchUrl ?? null,
    ...(app.installProgress ? { installProgress: app.installProgress } : {}),
    ...(cliIssue
      ? {
          error: {
            code: cliIssue.code,
            message: cliIssue.message
          }
        }
      : {}),
    status:
      app.installProgress != null || app.runtimeStatus === "installing"
        ? "installing"
        : app.runtimeStatus
  };
}
