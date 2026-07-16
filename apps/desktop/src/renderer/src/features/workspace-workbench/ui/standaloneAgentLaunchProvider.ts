import type { DesktopWindowIntent } from "@shared/contracts/windowIntent.ts";
import {
  isDesktopAgentGUIProvider,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider
} from "../../workspace-agent/desktopAgentGUINodeState.ts";

export function resolveStandaloneAgentLaunchProvider(input: {
  defaultProvider: DesktopAgentGUIProvider;
  intent: DesktopWindowIntent;
}): DesktopAgentGUIProvider {
  if (input.intent.kind !== "agent") {
    return normalizeDesktopAgentGUIProvider(input.defaultProvider);
  }

  if (isDesktopAgentGUIProvider(input.intent.provider)) {
    return normalizeDesktopAgentGUIProvider(input.intent.provider);
  }

  const agentTargetId = input.intent.agentTargetID?.trim() || null;
  const targetProvider = agentTargetId
    ? (input.intent.agentDirectorySnapshot?.agents.find(
        (agent) => agent.agentTargetId === agentTargetId
      )?.provider ??
      input.intent.agentDirectorySnapshot?.agentTargets.find(
        (target) => target.agentTargetId === agentTargetId
      )?.provider)
    : null;

  return isDesktopAgentGUIProvider(targetProvider)
    ? normalizeDesktopAgentGUIProvider(targetProvider)
    : normalizeDesktopAgentGUIProvider(input.defaultProvider);
}

export function resolveStandaloneAgentLaunchConfiguration(input: {
  defaultProvider: DesktopAgentGUIProvider;
  intent: DesktopWindowIntent;
}) {
  const provider = resolveStandaloneAgentLaunchProvider(input);
  if (input.intent.kind !== "agent") {
    return {
      agentSessionId: null,
      agentTargetId: null,
      autoSubmit: false,
      draftPrompt: null,
      model: null,
      modelPlanId: null,
      provider,
      userProjectPath: null
    };
  }
  return {
    agentSessionId: input.intent.agentSessionID ?? null,
    agentTargetId: input.intent.agentTargetID ?? null,
    autoSubmit: input.intent.autoSubmit === true,
    draftPrompt: input.intent.draftPrompt ?? null,
    model: input.intent.model ?? null,
    modelPlanId: input.intent.modelPlanId ?? null,
    provider,
    userProjectPath: input.intent.userProjectPath ?? null
  };
}
