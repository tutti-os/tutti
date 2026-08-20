import type { ReactNode } from "react";
import type { AgentGUIProvider } from "@tutti-os/agent-gui";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createWorkbenchLaunchpadDockEntry } from "@tutti-os/workbench-launchpad";
import {
  resolveWorkbenchCapabilityRegistry,
  type WorkbenchHostSessionResolution
} from "@tutti-os/workbench-host";
import {
  createWorkbenchNodePreviewCaptureAdapter,
  resolveWorkbenchHostPrepareClose,
  type WorkbenchDebugDiagnostics,
  type WorkbenchHostCloseDialogRequest
} from "@tutti-os/workbench-surface";
import type {
  DesktopBrowserApi,
  DesktopComputerUseApi,
  DesktopDockPreviewCacheApi,
  DesktopHostFilesApi,
  DesktopHostWindowApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type DesktopLocale,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "@shared/i18n";
import type { DesktopDockIconStyle } from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import {
  createWorkspaceAppCenterDockEntries,
  reportWorkspaceAppOpenedFromDockEntry
} from "@renderer/features/workspace-app-center/services/workspaceAppCenterContribution.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center/services/workspaceAppCenterService.interface.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { IDesktopRichTextAtService } from "../../../rich-text-at/services/richTextAtService.interface.ts";
import type { IWorkspaceFileManagerService } from "../../../workspace-file-manager/services/workspaceFileManagerService.interface.ts";
import type { IWorkspaceFilePreviewSurfaceHost } from "../../../workspace-file-preview/services/workspaceFilePreviewSurfaceHost.interface.ts";
import type { IWorkspaceUserProjectService } from "../../../workspace-user-project/services/workspaceUserProjectService.interface.ts";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "../../../workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IAgentQuickPromptService as AgentQuickPromptService } from "../../../workspace-agent/services/agentQuickPromptService.interface.ts";
import type { AgentSessionReplayDesktopComposition } from "../../../agent-session-replay/services/agentSessionReplayDesktopComposition.ts";
import type { IAgentsService as AgentsService } from "../../../workspace-agent/services/agentsService.interface.ts";
import type { IWorkspaceAgentActivityService as WorkspaceAgentActivityService } from "../../../workspace-agent/services/workspaceAgentActivityService.interface.ts";
import type { IWorkspaceAgentPromptSessionService as WorkspaceAgentPromptSessionService } from "../../../workspace-agent/services/workspaceAgentPromptSessionService.interface.ts";
import type {
  WorkspaceWorkbenchBodyRendererContext,
  WorkspaceWorkbenchCapabilitySettingsTarget,
  WorkspaceWorkbenchHostInput,
  WorkspaceWorkbenchHostSessionUpdate
} from "../workspaceWorkbenchHostService.interface.ts";
import {
  createWorkspaceDockImageIcon,
  resolveWorkspaceDockIconSet,
  type WorkspaceDockIconSet
} from "../workspaceDockIconStyle.ts";
import { assignWorkspaceTaskDockSection } from "./workspaceDockSections.ts";
import { createWorkspaceDynamicDockSignature } from "./workspaceDynamicDockSignature.ts";
import { createDesktopWorkspaceDockPreviewCache } from "./desktopWorkspaceDockPreviewCache.ts";
import { createTuttiWorkbenchProductProfile } from "./tuttiWorkbenchProductProfile.ts";
import { createWorkspaceWorkbenchHostInputWithDockEntries } from "./workspaceWorkbenchHostInput.ts";
import { createWindowCloseDialogRequest } from "./workspaceCloseDialogRequests.ts";
import type { DesktopWorkspaceWorkbenchRepository } from "./adapters/desktopWorkspaceWorkbenchRepository.ts";
import type { WorkspaceBrowserService } from "./workspaceBrowserService.ts";

const workspaceDockNativePreviewMaxWidthPx = 260;
const workspaceDockNativePreviewMaxHeightPx = 170;
const workspaceDockNativePreviewTimeoutMs = 2_500;

export interface WorkspaceWorkbenchHostInputResolverDependencies {
  agentQuickPromptService?: AgentQuickPromptService;
  agentSessionReplayComposition?: AgentSessionReplayDesktopComposition | null;
  agentProviderStatusService: AgentProviderStatusService;
  agentsService: AgentsService;
  appCenterService: IWorkspaceAppCenterService;
  browserApi?: DesktopBrowserApi;
  browserService: WorkspaceBrowserService;
  computerUseApi: DesktopComputerUseApi;
  dockPreviewCacheApi: DesktopDockPreviewCacheApi;
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi: DesktopHostFilesApi;
  hostWindowApi: DesktopHostWindowApi;
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceFilePreviewSurfaceHost: IWorkspaceFilePreviewSurfaceHost;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceAgentPromptSessionService: WorkspaceAgentPromptSessionService;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedEntries" | "resolveDroppedPaths"
  >;
  repository: DesktopWorkspaceWorkbenchRepository;
  reporterService?: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  runtimeApi: DesktopRuntimeApi;
}

export class WorkspaceWorkbenchHostInputResolver {
  constructor(
    private readonly dependencies: WorkspaceWorkbenchHostInputResolverDependencies
  ) {}

  resolve(
    input: WorkspaceWorkbenchHostSessionUpdate,
    current: WorkbenchHostSessionResolution<
      WorkspaceWorkbenchHostInput,
      CachedWorkspaceWorkbenchHostInput
    > | null
  ): WorkbenchHostSessionResolution<
    WorkspaceWorkbenchHostInput,
    CachedWorkspaceWorkbenchHostInput
  > {
    const cached = current?.state;
    if (
      cached &&
      cached.appI18n === input.appI18n &&
      cached.appLocale === input.appLocale &&
      cached.defaultAgentProvider === input.defaultAgentProvider &&
      cached.dockIconStyle === input.dockIconStyle &&
      cached.i18n === input.i18n &&
      cached.comingSoonAgentProviders === input.comingSoonAgentProviders &&
      cached.themeAppearance === input.themeAppearance
    ) {
      cached.capabilitySettingsRequestRef.current =
        input.onCapabilitySettingsRequest;
      cached.confirmCloseGuardRef.current = input.confirmCloseGuard;
      cached.renderFilesNodeBodyRef.current = input.renderFilesNodeBody;
      return {
        hostInput: this.createHostInputWithDynamicDockEntries(
          cached,
          cached.baseHostInput,
          {
            appI18n: input.appI18n,
            desktopI18n: cached.i18n
          }
        ),
        state: cached
      };
    }

    const renderFilesNodeBodyRef = { current: input.renderFilesNodeBody };
    const capabilitySettingsRequestRef = {
      current: input.onCapabilitySettingsRequest
    };
    const confirmCloseGuardRef = { current: input.confirmCloseGuard };
    const dockPreviewCache = createDesktopWorkspaceDockPreviewCache(
      this.dependencies.dockPreviewCacheApi
    );
    const dockIcons = resolveWorkspaceDockIconSet({
      appearance: input.themeAppearance,
      style: input.dockIconStyle
    });
    const contributionRegistry = resolveWorkbenchCapabilityRegistry(
      createTuttiWorkbenchProductProfile({
        agentQuickPromptService: this.dependencies.agentQuickPromptService,
        agentSessionReplayComposition:
          this.dependencies.agentSessionReplayComposition,
        appI18n: input.appI18n,
        appLocale: input.appLocale,
        appCenterService: this.dependencies.appCenterService,
        browserApi: this.dependencies.browserApi,
        browserService: this.dependencies.browserService,
        computerUseApi: this.dependencies.computerUseApi,
        confirmCloseGuard: (request) => confirmCloseGuardRef.current(request),
        dockPreviewCache,
        defaultAgentProvider: input.defaultAgentProvider,
        dockIcons: {
          agentUnified: dockIcons.agentUnified,
          agents: dockIcons.agents,
          applications: dockIcons.applications,
          browser: dockIcons.browser,
          files: createWorkspaceDockImageIcon(dockIcons.files),
          issue: dockIcons.issue,
          terminal: createWorkspaceDockImageIcon(dockIcons.terminal)
        },
        hostFilesApi: this.dependencies.hostFilesApi,
        hostWindowApi: this.dependencies.hostWindowApi,
        i18n: input.i18n,
        onCapabilitySettingsRequest: (target) => {
          return capabilitySettingsRequestRef.current?.(target);
        },
        agentsService: this.dependencies.agentsService,
        comingSoonAgentProviders: input.comingSoonAgentProviders,
        agentProviderStatusService:
          this.dependencies.agentProviderStatusService,
        eventStreamClient: this.dependencies.eventStreamClient,
        workspaceFileManagerService:
          this.dependencies.workspaceFileManagerService,
        workspaceFilePreviewSurfaceHost:
          this.dependencies.workspaceFilePreviewSurfaceHost,
        workspaceUserProjectService:
          this.dependencies.workspaceUserProjectService,
        workspaceAgentActivityService:
          this.dependencies.workspaceAgentActivityService,
        workspaceAgentPromptSessionService:
          this.dependencies.workspaceAgentPromptSessionService,
        tuttidClient: this.dependencies.tuttidClient,
        platformApi: this.dependencies.platformApi,
        reporterService: this.dependencies.reporterService,
        renderFilesNodeBody: (context) =>
          renderFilesNodeBodyRef.current(context),
        richTextAtService: this.dependencies.richTextAtService,
        runtimeApi: this.dependencies.runtimeApi,
        workspaceId: input.workspaceId
      })
    );

    const captureNodePreviewImages = createDesktopWorkspaceNodePreviewCapture(
      this.dependencies.hostWindowApi,
      this.dependencies.runtimeApi,
      input.workspaceId
    );
    const baseHostInput: WorkspaceWorkbenchHostInput = {
      captureNodePreviewImages,
      contributions: contributionRegistry.contributions,
      debugDiagnostics: createWorkspaceWorkbenchDebugDiagnostics(
        this.dependencies.runtimeApi,
        input.workspaceId
      ),
      dockPreviewCache,
      prepareHostClose: resolveWorkbenchHostPrepareClose(
        contributionRegistry.contributions
      ),
      createWindowCloseDialogRequest: (effects) =>
        createWindowCloseDialogRequest({ effects, i18n: input.i18n }),
      onDockEntryClick: ({ entryId }) =>
        reportWorkspaceAppOpenedFromDockEntry({
          appCenterService: this.dependencies.appCenterService,
          entryId,
          reporterService: this.dependencies.reporterService
        }),
      snapshotRepository: this.dependencies.repository,
      workspaceId: input.workspaceId
    };
    const cachedHostInput: CachedWorkspaceWorkbenchHostInput = {
      appI18n: input.appI18n,
      appLocale: input.appLocale,
      baseHostInput,
      capabilitySettingsRequestRef,
      confirmCloseGuardRef,
      defaultAgentProvider: input.defaultAgentProvider,
      dockIconStyle: input.dockIconStyle,
      dockIcons,
      i18n: input.i18n,
      comingSoonAgentProviders: input.comingSoonAgentProviders,
      renderFilesNodeBodyRef,
      themeAppearance: input.themeAppearance
    };
    return {
      hostInput: this.createHostInputWithDynamicDockEntries(
        cachedHostInput,
        baseHostInput,
        {
          appI18n: input.appI18n,
          desktopI18n: input.i18n
        }
      ),
      state: cachedHostInput
    };
  }

  private createHostInputWithDynamicDockEntries(
    cached: CachedWorkspaceWorkbenchHostInput,
    baseHostInput: WorkspaceWorkbenchHostInput,
    input: {
      appI18n: I18nRuntime<string>;
      desktopI18n: WorkspaceWorkbenchDesktopI18nRuntime;
    }
  ): WorkspaceWorkbenchHostInput {
    const dockSignature = createWorkspaceDynamicDockSignature({
      agentProviderRevision:
        this.dependencies.agentProviderStatusService.getRevision(),
      apps: this.dependencies.appCenterService.store.apps
    });
    if (
      cached.dynamicHostInput &&
      cached.dynamicAppI18n === input.appI18n &&
      cached.dynamicDockSignature === dockSignature
    ) {
      return cached.dynamicHostInput;
    }

    const captureBrowserPreview = this.dependencies.browserApi?.capturePreview;
    const dynamicHostInput = createWorkspaceWorkbenchHostInputWithDockEntries(
      baseHostInput,
      [
        ...assignWorkspaceTaskDockSection(
          createWorkspaceAppCenterDockEntries({
            appCenterIconUrl: cached.dockIcons.applications,
            appCenterService: this.dependencies.appCenterService,
            captureWebviewPreview: captureBrowserPreview
              ? (nodeId) => captureBrowserPreview({ nodeId })
              : undefined,
            i18n: input.appI18n
          })
        ),
        createWorkbenchLaunchpadDockEntry({
          label: input.desktopI18n.t(
            workspaceWorkbenchDesktopI18nKeys.launchpad.dockLabel
          ),
          tileIconUrls: cached.dockIcons.launchpadTiles
        })
      ]
    );
    cached.dynamicAppI18n = input.appI18n;
    cached.dynamicDockSignature = dockSignature;
    cached.dynamicHostInput = dynamicHostInput;
    return dynamicHostInput;
  }
}

export interface CachedWorkspaceWorkbenchHostInput {
  appI18n: I18nRuntime<string>;
  appLocale: DesktopLocale;
  baseHostInput: WorkspaceWorkbenchHostInput;
  capabilitySettingsRequestRef: {
    current:
      | ((target: WorkspaceWorkbenchCapabilitySettingsTarget) => void)
      | undefined;
  };
  confirmCloseGuardRef: {
    current: (
      request: WorkbenchHostCloseDialogRequest
    ) => Promise<boolean> | boolean;
  };
  defaultAgentProvider?: string | null;
  dockIconStyle: DesktopDockIconStyle;
  dockIcons: WorkspaceDockIconSet;
  dynamicAppI18n?: I18nRuntime<string>;
  dynamicDockSignature?: string;
  dynamicHostInput?: WorkspaceWorkbenchHostInput;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  comingSoonAgentProviders?: readonly AgentGUIProvider[];
  renderFilesNodeBodyRef: {
    current: (context: WorkspaceWorkbenchBodyRendererContext) => ReactNode;
  };
  themeAppearance: DesktopThemeAppearance;
}

function createDesktopWorkspaceNodePreviewCapture(
  hostWindowApi: DesktopHostWindowApi,
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">,
  workspaceId: string
): NonNullable<WorkspaceWorkbenchHostInput["captureNodePreviewImages"]> {
  return createWorkbenchNodePreviewCaptureAdapter({
    captureRect: ({ maxHeight, maxWidth, rect }) =>
      hostWindowApi.capturePreviewImages({ maxHeight, maxWidth, rect }),
    diagnostics: (diagnostic) => {
      void runtimeApi
        .logRendererDiagnostic({
          details: diagnostic.details,
          event: `dock_preview_${diagnostic.event}`,
          level: diagnostic.level,
          source: "workspace-workbench",
          workspaceId
        })
        .catch(() => undefined);
    },
    maxHeight: workspaceDockNativePreviewMaxHeightPx,
    maxWidth: workspaceDockNativePreviewMaxWidthPx,
    resolveDiagnosticContext: (node) => ({ typeId: node.data.typeId }),
    timeoutMs: workspaceDockNativePreviewTimeoutMs
  });
}

function createWorkspaceWorkbenchDebugDiagnostics(
  runtimeApi: DesktopRuntimeApi,
  workspaceId: string
): WorkbenchDebugDiagnostics {
  return {
    isEnabled() {
      try {
        return (
          globalThis.localStorage?.getItem("tuttiWorkbenchDebugFrames") === "1"
        );
      } catch {
        return false;
      }
    },
    log(input) {
      return runtimeApi.logRendererDiagnostic({
        details: input.details,
        event: input.event,
        level: input.level,
        source: input.source,
        workspaceId
      });
    }
  };
}
