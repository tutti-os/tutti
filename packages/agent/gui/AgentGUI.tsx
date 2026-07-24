import { memo, useMemo, type JSX } from "react";
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
  projectAgentGUIAgentsToTargets
} from "./agents";
import {
  AgentGUINode,
  type AgentGUINodeProps
} from "./agent-gui/agentGuiNode/AgentGUINode";
import { AgentActivityHostProvider } from "./agentActivityHost";
import { AgentGuiI18nProvider, type AgentGuiI18nLocale } from "./i18n/index";
import {
  TuttiModePlanReviewRuntimeProvider,
  type TuttiModePlanReviewRuntime
} from "./workspaceWorkflow";
import { AgentVisibleErrorPresentationProvider } from "./shared/visibleError/AgentVisibleErrorPresentationContext";

export type { AgentGUIHomeSuggestionId } from "./types";
export type { ReferenceProvenanceCatalog as AgentGUIReferenceProvenanceFilterCatalog } from "@tutti-os/workspace-file-reference/contracts";

type AgentGUIPublicHostCapabilities = Omit<
  AgentGUINodeProps["hostCapabilities"],
  | "agentTargets"
  | "agentTargetsLoading"
  | "handoffAgentTargets"
  | "handoffAgentTargetsLoading"
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
  /**
   * Host-owned launch catalog for conversation handoff. When omitted, handoff
   * uses `agentDirectory`, preserving the single-runtime host contract.
   */
  handoffAgentDirectory?: AgentGUIAgentDirectorySnapshot;
  allAgentsPresentation?: AgentGUIAllAgentsPresentation | null;
  renderAgentsEmpty?: AgentGUIAgentsEmptyRenderer;
  agentActivityRuntime: AgentActivityRuntime;
  agentHostApi?: AgentHostInputApi | null;
  tuttiModePlanReviewRuntime?: TuttiModePlanReviewRuntime | null;
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
  tuttiModePlanReviewRuntime,
  agentDirectory,
  handoffAgentDirectory,
  allAgentsPresentation = null,
  renderAgentsEmpty,
  disabled,
  i18n,
  locale,
  ...props
}: AgentGUIProps): JSX.Element {
  const normalizedAgents = useMemo(
    () => normalizeAgentGUIAgents(agentDirectory.agents),
    [agentDirectory.agents]
  );
  const agentTargets = useMemo(
    () => projectAgentGUIAgentsToTargets(normalizedAgents),
    [normalizedAgents]
  );
  const effectiveHandoffAgentDirectory =
    handoffAgentDirectory ?? agentDirectory;
  const normalizedHandoffAgents = useMemo(
    () =>
      effectiveHandoffAgentDirectory.agents === agentDirectory.agents
        ? normalizedAgents
        : normalizeAgentGUIAgents(effectiveHandoffAgentDirectory.agents),
    [
      agentDirectory.agents,
      effectiveHandoffAgentDirectory.agents,
      normalizedAgents
    ]
  );
  const handoffAgentTargets = useMemo(
    () =>
      normalizedHandoffAgents === normalizedAgents
        ? agentTargets
        : projectAgentGUIAgentsToTargets(normalizedHandoffAgents),
    [agentTargets, normalizedAgents, normalizedHandoffAgents]
  );
  const hostCapabilities = props.hostCapabilities;
  const renderSlots = props.renderSlots;
  const nodeHostCapabilities = useMemo<AgentGUINodeProps["hostCapabilities"]>(
    () => ({
      ...hostCapabilities,
      agentTargets,
      agentTargetsLoading:
        agentDirectory.agents.length === 0 &&
        (agentDirectory.status === "idle" ||
          agentDirectory.status === "loading"),
      handoffAgentTargets,
      handoffAgentTargetsLoading:
        effectiveHandoffAgentDirectory.agents.length === 0 &&
        (effectiveHandoffAgentDirectory.status === "idle" ||
          effectiveHandoffAgentDirectory.status === "loading"),
      disabledHomeSuggestions: disabled,
      providerRailAllPresentation: allAgentsPresentation ?? null,
      providerRailMode: "exact"
    }),
    [
      agentDirectory.agents.length,
      agentDirectory.status,
      agentTargets,
      allAgentsPresentation,
      disabled,
      effectiveHandoffAgentDirectory.agents.length,
      effectiveHandoffAgentDirectory.status,
      handoffAgentTargets,
      hostCapabilities
    ]
  );
  const nodeRenderSlots = useMemo<AgentGUINodeProps["renderSlots"]>(
    () => ({
      ...renderSlots,
      providerRailEmpty: renderAgentsEmpty
    }),
    [renderAgentsEmpty, renderSlots]
  );
  const nodeProps: AgentGUINodeProps = {
    ...props,
    hostCapabilities: nodeHostCapabilities,
    renderSlots: nodeRenderSlots
  };
  const content = (
    <AgentGuiI18nProvider runtime={i18n} locale={locale}>
      <TuttiModePlanReviewRuntimeProvider runtime={tuttiModePlanReviewRuntime}>
        <AgentActivityHostProvider
          agentActivityRuntime={agentActivityRuntime}
          agentHostApi={agentHostApi}
        >
          <AgentVisibleErrorPresentationProvider
            value={props.hostCapabilities?.visibleErrorPresentationOverrides}
          >
            <AgentGUINode {...nodeProps} />
          </AgentVisibleErrorPresentationProvider>
        </AgentActivityHostProvider>
      </TuttiModePlanReviewRuntimeProvider>
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
