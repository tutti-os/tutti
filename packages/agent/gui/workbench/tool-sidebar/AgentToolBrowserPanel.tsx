import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type ReactNode
} from "react";
import {
  closeBrowserNodeTab,
  createBrowserNodeFeature,
  isBrowserNodeSurfaceEvent,
  type BrowserNodeChromeImportPromptAdapter,
  type BrowserNodeAutomationTargetMetadata,
  type BrowserNodeFeature,
  type BrowserNodeHostApi,
  type BrowserNodeSessionMode
} from "@tutti-os/browser-node";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";

const LazyBrowserNode = lazy(() =>
  import("@tutti-os/browser-node/react").then(({ BrowserNode }) => ({
    default: BrowserNode
  }))
);

export const agentToolBrowserDefaultUrl = "https://www.google.com/";

export interface AgentToolBrowserPanelProps {
  automationTarget?: Omit<
    BrowserNodeAutomationTargetMetadata,
    "focused" | "selected" | "surfaceId" | "tabId"
  > | null;
  browserApi: BrowserNodeHostApi;
  chromeCookieImportPrompt?: BrowserNodeChromeImportPromptAdapter;
  defaultUrl?: string;
  hidden: boolean;
  i18n: I18nRuntime<string>;
  loadingFallback?: ReactNode;
  navigationActions?: ReactNode;
  nodeIdPrefix?: string;
  onControllerReady?: (controller: AgentToolBrowserController | null) => void;
  profileId?: string | null;
  sessionMode?: BrowserNodeSessionMode;
  sessionPartition?: string | null;
}

export interface AgentToolBrowserController {
  closePage(nodeId: string): "closed" | "last-page" | "not-found";
  createPage(url?: string | null): string;
  ownsPage(nodeId: string): boolean;
  selectPage(nodeId: string): boolean;
  surfaceNodeId: string;
}

export function AgentToolBrowserPanel({
  automationTarget = null,
  browserApi,
  chromeCookieImportPrompt,
  defaultUrl = agentToolBrowserDefaultUrl,
  hidden,
  i18n,
  loadingFallback = null,
  navigationActions,
  nodeIdPrefix = "browser:agent-tool",
  onControllerReady,
  profileId = null,
  sessionMode = "shared",
  sessionPartition = null
}: AgentToolBrowserPanelProps): ReactNode {
  const [nodeId] = useState(() => createAgentToolBrowserNodeId(nodeIdPrefix));
  const feature = useMemo(
    () =>
      createAgentToolBrowserFeature({
        browserApi,
        ...(chromeCookieImportPrompt ? { chromeCookieImportPrompt } : {}),
        i18n,
        nodeId
      }),
    [browserApi, chromeCookieImportPrompt, i18n, nodeId]
  );
  const controller = useMemo<AgentToolBrowserController>(() => {
    const getPage = (pageNodeId: string) => {
      const state = feature.tabsStore.getSurfaceState(nodeId);
      const tab = state?.tabs.find(
        (candidate) => candidate.nodeId === pageNodeId
      );
      return state && tab ? { state, tab } : null;
    };
    return {
      closePage(pageNodeId) {
        const page = getPage(pageNodeId);
        if (!page) return "not-found";
        if (page.state.tabs.length === 1) return "last-page";
        closeBrowserNodeTab(feature, nodeId, page.tab.id);
        return "closed";
      },
      createPage(url) {
        const resolvedUrl = url?.trim() || "about:blank";
        const state = feature.tabsStore.ensureSurface(nodeId, defaultUrl);
        const activeTab = state.tabs.find(
          (tab) => tab.id === state.activeTabId
        );
        const activeRuntime = activeTab
          ? feature.runtimeStore.getNodeState(activeTab.nodeId)
          : null;
        if (
          state.tabs.length === 1 &&
          activeTab?.defaultUrl === "about:blank" &&
          !activeRuntime?.url
        ) {
          feature.tabsStore.syncDefaultUrl(nodeId, resolvedUrl);
          return activeTab.nodeId;
        }
        return feature.tabsStore.addTab(nodeId, resolvedUrl).nodeId;
      },
      ownsPage: (pageNodeId) => getPage(pageNodeId) !== null,
      selectPage(pageNodeId) {
        const page = getPage(pageNodeId);
        if (!page) return false;
        feature.tabsStore.selectTab(nodeId, page.tab.id);
        return true;
      },
      surfaceNodeId: nodeId
    };
  }, [defaultUrl, feature, nodeId]);

  const bindController = useCallback(
    (node: HTMLDivElement | null) =>
      onControllerReady?.(node ? controller : null),
    [controller, onControllerReady]
  );

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      data-agent-tool-browser-surface="true"
      data-agent-tool-browser-surface-id={nodeId}
      ref={bindController}
    >
      <Suspense fallback={loadingFallback}>
        <LazyBrowserNode
          automationTarget={
            automationTarget ? { ...automationTarget, focused: !hidden } : null
          }
          defaultUrl={defaultUrl}
          feature={feature}
          hidden={hidden}
          navigationActions={navigationActions}
          nodeId={nodeId}
          profileId={profileId}
          sessionMode={sessionMode}
          sessionPartition={sessionPartition}
          syncDefaultUrl
          tabs
        />
      </Suspense>
    </div>
  );
}

export function createAgentToolBrowserFeature(input: {
  browserApi: BrowserNodeHostApi;
  chromeCookieImportPrompt?: BrowserNodeChromeImportPromptAdapter;
  i18n: I18nRuntime<string>;
  nodeId: string;
}): BrowserNodeFeature {
  return createBrowserNodeFeature({
    ...(input.chromeCookieImportPrompt
      ? { chromeCookieImportPrompt: input.chromeCookieImportPrompt }
      : {}),
    hostApi: createScopedAgentToolBrowserHostApi(
      input.browserApi,
      input.nodeId
    ),
    i18n: input.i18n,
    resolveSearchUrl: resolveAgentToolBrowserSearchUrl
  });
}

function createScopedAgentToolBrowserHostApi(
  browserApi: BrowserNodeHostApi,
  nodeId: string
): BrowserNodeHostApi {
  return {
    ...browserApi,
    onEvent(listener) {
      return browserApi.onEvent((event) => {
        if (isBrowserNodeSurfaceEvent(nodeId, event)) {
          listener(event);
        }
      });
    }
  };
}

function resolveAgentToolBrowserSearchUrl(query: string): string {
  const searchUrl = new URL("https://www.google.com/search");
  searchUrl.searchParams.set("q", query);
  return searchUrl.toString();
}

function createAgentToolBrowserNodeId(prefix: string): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${instanceId}`;
}
