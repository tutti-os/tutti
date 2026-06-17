// Agent GUI controller — small React stability helpers used by the hook.

import { useCallback, useRef } from "react";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import {
  areProviderSkillOptionListsEqual,
  sameComposerSettings
} from "./agentGuiController.composerHelpers";

export function useStableComposerSettings(
  settings: AgentSessionComposerSettings
): AgentSessionComposerSettings;
export function useStableComposerSettings(
  settings: AgentSessionComposerSettings | null
): AgentSessionComposerSettings | null;
export function useStableComposerSettings(
  settings: AgentSessionComposerSettings | null
): AgentSessionComposerSettings | null {
  const settingsRef = useRef<{
    value: AgentSessionComposerSettings | null;
  } | null>(null);
  if (
    settingsRef.current === null ||
    !sameComposerSettings(settingsRef.current.value, settings)
  ) {
    settingsRef.current = { value: settings };
  }
  return settingsRef.current.value;
}

export function useStableProviderSkillOptions(
  skills: AgentGUIProviderSkillOption[]
): AgentGUIProviderSkillOption[] {
  const skillsRef = useRef<AgentGUIProviderSkillOption[] | null>(null);
  if (
    skillsRef.current === null ||
    !areProviderSkillOptionListsEqual(skillsRef.current, skills)
  ) {
    skillsRef.current = skills;
  }
  return skillsRef.current;
}

export function useStableControllerEventCallback<
  Args extends unknown[],
  Result
>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
