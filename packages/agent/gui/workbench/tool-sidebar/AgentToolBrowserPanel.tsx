import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import {
  createBrowserNodeFeature,
  isBrowserNodeSurfaceEvent,
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
  browserApi: BrowserNodeHostApi;
  defaultUrl?: string;
  hidden: boolean;
  i18n: I18nRuntime<string>;
  loadingFallback?: ReactNode;
  navigationActions?: ReactNode;
  nodeIdPrefix?: string;
  profileId?: string | null;
  sessionMode?: BrowserNodeSessionMode;
  sessionPartition?: string | null;
}

export function AgentToolBrowserPanel({
  browserApi,
  defaultUrl = agentToolBrowserDefaultUrl,
  hidden,
  i18n,
  loadingFallback = null,
  navigationActions,
  nodeIdPrefix = "browser:agent-tool",
  profileId = null,
  sessionMode = "shared",
  sessionPartition = null
}: AgentToolBrowserPanelProps): ReactNode {
  const [nodeId] = useState(() => createAgentToolBrowserNodeId(nodeIdPrefix));
  const feature = useMemo(
    () => createAgentToolBrowserFeature({ browserApi, i18n, nodeId }),
    [browserApi, i18n, nodeId]
  );

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      data-agent-tool-browser-surface="true"
      data-agent-tool-browser-surface-id={nodeId}
    >
      <Suspense fallback={loadingFallback}>
        <LazyBrowserNode
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
  i18n: I18nRuntime<string>;
  nodeId: string;
}): BrowserNodeFeature {
  return createBrowserNodeFeature({
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
