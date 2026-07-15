import { memo, type JSX } from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { TooltipProvider } from "@tutti-os/ui-system";
import type { AgentActivityRuntime } from "./agentActivityRuntime";
import type { AgentHostInputApi } from "./host/agentHostApi";
import type {
  AgentGUIAgentDirectorySnapshot,
  AgentGUIAllAgentsPresentation,
  AgentGUIHomeSuggestionId
} from "./types";
import type { AgentGUIAgentsEmptyRenderer } from "./agent-gui/agentGuiNode/AgentGUINodeView";
import {
  normalizeAgentGUIAgents,
  projectAgentGUIAgentsToInternalTargets
} from "./agents";
import {
  AgentGUINode,
  type AgentGUINodeProps
} from "./agent-gui/agentGuiNode/AgentGUINode";
import { AgentActivityHostProvider } from "./agentActivityHost";
import { AgentGuiI18nProvider, type AgentGuiI18nLocale } from "./i18n/index";

export type { AgentGUIHomeSuggestionId } from "./types";
export type { ReferenceProvenanceCatalog as AgentGUIReferenceProvenanceFilterCatalog } from "@tutti-os/workspace-file-reference/contracts";

type AgentGUIPublicHostCapabilities = Omit<
  AgentGUINodeProps["hostCapabilities"],
  | "agentTargets"
  | "agentTargetsLoading"
  | "providerRailAllPresentation"
  | "providerRailMode"
  | "disabledHomeSuggestions"
>;

type AgentGUIPublicRenderSlots = Omit<
  AgentGUINodeProps["renderSlots"],
  "providerRailEmpty"
>;

export interface AgentGUIProps extends Omit<
  AgentGUINodeProps,
  "hostCapabilities" | "renderSlots"
> {
  agentDirectory: AgentGUIAgentDirectorySnapshot;
  allAgentsPresentation?: AgentGUIAllAgentsPresentation | null;
  renderAgentsEmpty?: AgentGUIAgentsEmptyRenderer;
  agentActivityRuntime: AgentActivityRuntime;
  agentHostApi?: AgentHostInputApi | null;
  /** Starter entries to hide below the empty new-session composer. */
  disabled?: readonly AgentGUIHomeSuggestionId[];
  i18n?: I18nRuntime<string> | null;
  locale?: AgentGuiI18nLocale;
  hostCapabilities: AgentGUIPublicHostCapabilities;
  renderSlots: AgentGUIPublicRenderSlots;
}

export const AgentGUI = memo(function AgentGUI({
  agentActivityRuntime,
  agentHostApi,
  agentDirectory,
  allAgentsPresentation = null,
  renderAgentsEmpty,
  disabled,
  i18n,
  locale,
  ...props
}: AgentGUIProps): JSX.Element {
  const normalizedAgents = normalizeAgentGUIAgents(agentDirectory.agents);
  const hostCapabilities = props.hostCapabilities;
  const renderSlots = props.renderSlots;
  const nodeProps: AgentGUINodeProps = {
    ...props,
    hostCapabilities: {
      ...hostCapabilities,
      agentTargets: projectAgentGUIAgentsToInternalTargets(normalizedAgents),
      agentTargetsLoading:
        agentDirectory.agents.length === 0 &&
        (agentDirectory.status === "idle" ||
          agentDirectory.status === "loading"),
      disabledHomeSuggestions: disabled,
      providerRailAllPresentation: allAgentsPresentation ?? null,
      providerRailMode: "exact"
    },
    renderSlots: {
      ...renderSlots,
      providerRailEmpty: renderAgentsEmpty
    }
  };
  const content = (
    <AgentGuiI18nProvider runtime={i18n} locale={locale}>
      <AgentActivityHostProvider
        agentActivityRuntime={agentActivityRuntime}
        agentHostApi={agentHostApi}
      >
        <AgentGUINode {...nodeProps} />
      </AgentActivityHostProvider>
    </AgentGuiI18nProvider>
  );
  return props.frame.previewMode ? (
    content
  ) : (
    <TooltipProvider delayDuration={120} skipDelayDuration={0}>
      {content}
    </TooltipProvider>
  );
});
