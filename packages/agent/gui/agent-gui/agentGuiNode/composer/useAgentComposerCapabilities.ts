import { useCallback, useMemo } from "react";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import { skillPresentationEntries } from "./skillPresentationEntries";
import {
  createAgentComposerCapabilitiesController,
  selectAgentComposerCapabilitiesSnapshot,
  type AgentComposerCapabilitiesScope
} from "./AgentComposerCapabilitiesController";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";

export function useAgentComposerCapabilities(input: {
  agentTargetId: string | null | undefined;
  authoritativeSkills: readonly AgentGUIProviderSkillOption[];
  cwd: string | null | undefined;
  provider: string;
}): {
  snapshot: ReturnType<typeof selectAgentComposerCapabilitiesSnapshot>;
  supported: boolean;
  sync: (active: boolean) => void;
} {
  const hostApi = useOptionalAgentHostApi();
  const source = hostApi?.composerCapabilities;
  const agentTargetId = input.agentTargetId?.trim() ?? "";
  const provider = input.provider.trim();
  const cwd = input.cwd?.trim() || undefined;
  const supported = Boolean(source?.isSupported({ agentTargetId, provider }));
  const currentAuthoritativeSkills = skillPresentationEntries(
    input.authoritativeSkills
  ).flatMap((entry) =>
    entry.skill.kind === "connector" || entry.skill.sourceKind === "connector"
      ? []
      : [
          {
            entryId: entry.entryId,
            kind: "skill" as const,
            name: entry.name,
            path: entry.path
          }
        ]
  );
  const authoritativeSkillsKey = JSON.stringify(
    currentAuthoritativeSkills.map((entry) => [
      entry.entryId,
      entry.name,
      entry.path
    ])
  );
  const authoritativeSkills = useMemo(
    () => currentAuthoritativeSkills,
    [authoritativeSkillsKey]
  );
  const scope = useMemo<AgentComposerCapabilitiesScope>(
    () => ({
      agentTargetId,
      authoritativeSkills,
      cwd,
      key: JSON.stringify([
        agentTargetId,
        provider,
        cwd ?? "",
        authoritativeSkillsKey
      ]),
      provider,
      supported
    }),
    [
      agentTargetId,
      authoritativeSkills,
      authoritativeSkillsKey,
      cwd,
      provider,
      supported
    ]
  );
  const controller = useMemo(
    () => createAgentComposerCapabilitiesController({ source }),
    [source]
  );
  const snapshot = useEngineSelector(controller, (state) =>
    selectAgentComposerCapabilitiesSnapshot(state, scope.key, supported)
  );
  const sync = useCallback(
    (active: boolean) => controller.sync({ active, scope }),
    [controller, scope]
  );

  return { snapshot, supported, sync };
}
