import type { ReactNode } from "react";
import { AgentToolBrowserPanel } from "@tutti-os/agent-gui/workbench/tool-sidebar";
import { BrowserElementContextAction } from "@tutti-os/agent-gui/workbench/browser-element-context";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopBrowserApi } from "@preload/types";
import { getDesktopChromeCookieImportPromptAdapter } from "../services/chromeCookieImportPrompt.ts";
import { StandaloneAgentToolLoadingState } from "./StandaloneAgentToolLoadingState.tsx";

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
  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      data-standalone-agent-browser-surface="true"
    >
      <AgentToolBrowserPanel
        browserApi={browserApi}
        chromeCookieImportPrompt={getDesktopChromeCookieImportPromptAdapter()}
        hidden={hidden}
        i18n={appI18n}
        loadingFallback={
          <StandaloneAgentToolLoadingState label={loadingLabel} />
        }
        nodeIdPrefix="browser:standalone-agent-tool"
        navigationActions={
          <BrowserElementContextAction
            copy={elementContextCopy}
            workspaceId={workspaceId}
            onAppendMention={onAppendBrowserElementMention}
            onError={onBrowserElementError}
          />
        }
      />
    </div>
  );
}
