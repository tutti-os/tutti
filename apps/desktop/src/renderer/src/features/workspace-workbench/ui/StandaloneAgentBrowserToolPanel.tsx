import { lazy, Suspense, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopBrowserApi } from "@preload/types";
import {
  createStandaloneAgentBrowserToolFeature,
  standaloneAgentBrowserDefaultUrl
} from "./standaloneAgentToolWorkbench.ts";
import { StandaloneAgentToolLoadingState } from "./StandaloneAgentToolLoadingState.tsx";
import { BrowserElementContextAction } from "../browser-element-context/BrowserElementContextAction.tsx";

const LazyBrowserNode = lazy(() =>
  import("@tutti-os/browser-node/react").then(({ BrowserNode }) => ({
    default: BrowserNode
  }))
);
export function StandaloneAgentBrowserToolPanel({
  appI18n,
  browserApi,
  elementContextCopy,
  hidden,
  loadingLabel,
  onAppendBrowserElementMention,
  onBrowserElementError,
  workspaceId
}: {
  appI18n: I18nRuntime<string>;
  browserApi: DesktopBrowserApi;
  elementContextCopy: {
    cancel: string;
    failed: string;
    select: string;
  };
  hidden: boolean;
  loadingLabel: string;
  onAppendBrowserElementMention: (mention: string) => void;
  onBrowserElementError: (message: string) => void;
  workspaceId: string;
}): ReactNode {
  const [nodeId] = useState(createStandaloneAgentBrowserNodeId);
  const feature = useMemo(
    () =>
      createStandaloneAgentBrowserToolFeature({
        browserApi,
        i18n: appI18n,
        nodeId
      }),
    [appI18n, browserApi, nodeId]
  );
  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      data-standalone-agent-browser-surface="true"
      data-standalone-agent-browser-surface-id={nodeId}
    >
      <Suspense
        fallback={<StandaloneAgentToolLoadingState label={loadingLabel} />}
      >
        <LazyBrowserNode
          defaultUrl={standaloneAgentBrowserDefaultUrl}
          feature={feature}
          hidden={hidden}
          navigationActions={
            <BrowserElementContextAction
              copy={elementContextCopy}
              workspaceId={workspaceId}
              onAppendMention={onAppendBrowserElementMention}
              onError={onBrowserElementError}
            />
          }
          nodeId={nodeId}
          syncDefaultUrl
          tabs
        />
      </Suspense>
    </div>
  );
}

function createStandaloneAgentBrowserNodeId(): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `browser:standalone-agent-tool:${instanceId}`;
}
