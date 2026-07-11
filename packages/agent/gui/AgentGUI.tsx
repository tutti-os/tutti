import { memo, type JSX } from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { TooltipProvider } from "@tutti-os/ui-system";
import type { AgentActivityRuntime } from "./agentActivityRuntime";
import type { AgentHostInputApi } from "./host/agentHostApi";
import {
  AgentGUINode,
  type AgentGUINodeProps
} from "./agent-gui/agentGuiNode/AgentGUINode";
import { AgentActivityHostProvider } from "./agentActivityHost";
import { AgentGuiI18nProvider, type AgentGuiI18nLocale } from "./i18n/index";

export interface AgentGUIProps extends AgentGUINodeProps {
  agentActivityRuntime: AgentActivityRuntime;
  agentHostApi?: AgentHostInputApi | null;
  embedded?: boolean;
  i18n?: I18nRuntime<string> | null;
  locale?: AgentGuiI18nLocale;
}

export const AgentGUI = memo(function AgentGUI({
  agentActivityRuntime,
  agentHostApi,
  i18n,
  locale,
  ...props
}: AgentGUIProps): JSX.Element {
  const content = (
    <AgentGuiI18nProvider runtime={i18n} locale={locale}>
      <AgentActivityHostProvider
        agentActivityRuntime={agentActivityRuntime}
        agentHostApi={agentHostApi}
      >
        <AgentGUINode {...props} />
      </AgentActivityHostProvider>
    </AgentGuiI18nProvider>
  );
  return props.previewMode ? (
    content
  ) : (
    <TooltipProvider delayDuration={120} skipDelayDuration={0}>
      {content}
    </TooltipProvider>
  );
});
