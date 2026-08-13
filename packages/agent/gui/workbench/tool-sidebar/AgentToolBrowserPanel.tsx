import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode
} from "react";
import {
  activateBrowserNodePageByUrl,
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
import { createAgentToolBrowserPage } from "./agentToolBrowserPage.ts";

const LazyBrowserNode = lazy(() =>
  import("@tutti-os/browser-node/react").then(({ BrowserNode }) => ({
    default: BrowserNode
  }))
);
const LazyBrowserNodeWorkbenchHeader = lazy(() =>
  import("@tutti-os/browser-node/react").then(
    ({ BrowserNodeWorkbenchHeader }) => ({
      default: BrowserNodeWorkbenchHeader
    })
  )
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
  defaultActions?: ReactNode;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
  hidden: boolean;
  i18n: I18nRuntime<string>;
  loadingFallback?: ReactNode;
  navigationActions?: ReactNode;
  nodeIdPrefix?: string;
  onCloseRequest?: () => void;
  onControllerReady?: (controller: AgentToolBrowserController | null) => void;
  profileId?: string | null;
  sessionMode?: BrowserNodeSessionMode;
  sessionPartition?: string | null;
}

export interface AgentToolBrowserController {
  activatePageByUrl(url: string): string | null;
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
  defaultActions,
  dragHandleProps,
  hidden,
  i18n,
  loadingFallback = null,
  navigationActions,
  nodeIdPrefix = "browser:agent-tool",
  onCloseRequest,
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
      activatePageByUrl(url) {
        return (
          activateBrowserNodePageByUrl(feature, nodeId, url)?.nodeId ?? null
        );
      },
      closePage(pageNodeId) {
        const page = getPage(pageNodeId);
        if (!page) return "not-found";
        if (page.state.tabs.length === 1) return "last-page";
        closeBrowserNodeTab(feature, nodeId, page.tab.id);
        return "closed";
      },
      createPage(url) {
        return createAgentToolBrowserPage(feature, nodeId, defaultUrl, url);
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
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      data-agent-tool-browser-surface="true"
      data-agent-tool-browser-surface-id={nodeId}
      ref={bindController}
    >
      <Suspense fallback={loadingFallback}>
        <LazyBrowserNodeWorkbenchHeader
          defaultUrl={defaultUrl}
          feature={feature}
          defaultActions={defaultActions}
          dragHandleProps={dragHandleProps}
          navigationActions={navigationActions}
          nodeId={nodeId}
          onCloseRequest={onCloseRequest}
        />
        <div className="min-h-0 flex-1">
          <LazyBrowserNode
            automationTarget={
              automationTarget
                ? { ...automationTarget, focused: !hidden }
                : null
            }
            defaultUrl={defaultUrl}
            feature={feature}
            hidden={hidden}
            nodeId={nodeId}
            onCloseRequest={onCloseRequest}
            profileId={profileId}
            sessionMode={sessionMode}
            sessionPartition={sessionPartition}
            showHeader={false}
            syncDefaultUrl
            tabs
          />
        </div>
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
