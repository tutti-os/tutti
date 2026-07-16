import type {
  WorkspaceAgentCapabilityOption,
  WorkspaceAgentDraft
} from "../services/workspaceSettingsTypes.ts";

export function workspaceAgentSelectableCapabilityOptions(
  catalog: readonly WorkspaceAgentCapabilityOption[]
): WorkspaceAgentCapabilityOption[] {
  const serverNames = new Set(
    catalog
      .filter((option) => option.kind === "mcpServer")
      .map((option) => option.serverName || option.name)
      .filter(Boolean)
  );
  return catalog.filter(
    (option) =>
      option.kind !== "mcpTool" ||
      !option.serverName ||
      !serverNames.has(option.serverName)
  );
}

export function workspaceAgentCapabilityIsSelected(
  draft: Readonly<WorkspaceAgentDraft>,
  option: WorkspaceAgentCapabilityOption
): boolean {
  if (!draft.capabilitiesExplicit) {
    return option.status !== "unsupported";
  }
  const selected = new Set(
    parseCapabilityLines(
      option.kind === "skill" ? draft.skills : draft.tools
    ).map((value) => value.toLowerCase())
  );
  return workspaceAgentCapabilityCandidates(option).some((candidate) =>
    selected.has(candidate.toLowerCase())
  );
}

export function createWorkspaceAgentCapabilitySelectionPatch(
  draft: Readonly<WorkspaceAgentDraft>,
  catalog: readonly WorkspaceAgentCapabilityOption[],
  optionID: string,
  enabled: boolean
): Pick<WorkspaceAgentDraft, "capabilitiesExplicit" | "skills" | "tools"> {
  const options = workspaceAgentSelectableCapabilityOptions(catalog);
  const selectedSkills = new Set(parseCapabilityLines(draft.skills));
  const selectedTools = new Set(parseCapabilityLines(draft.tools));
  if (!draft.capabilitiesExplicit) {
    for (const option of options) {
      if (option.status === "unsupported") {
        continue;
      }
      const value = workspaceAgentCapabilityStorageValue(option);
      (option.kind === "skill" ? selectedSkills : selectedTools).add(value);
    }
  }
  const option = options.find((candidate) => candidate.id === optionID);
  if (option) {
    const selected = option.kind === "skill" ? selectedSkills : selectedTools;
    for (const candidate of workspaceAgentCapabilityCandidates(option)) {
      for (const value of selected) {
        if (value.toLowerCase() === candidate.toLowerCase()) {
          selected.delete(value);
        }
      }
    }
    if (enabled) {
      selected.add(workspaceAgentCapabilityStorageValue(option));
    }
  }
  return {
    capabilitiesExplicit: true,
    skills: [...selectedSkills].join("\n"),
    tools: [...selectedTools].join("\n")
  };
}

function workspaceAgentCapabilityStorageValue(
  option: WorkspaceAgentCapabilityOption
): string {
  return option.kind === "skill" ? option.name : option.id;
}

function workspaceAgentCapabilityCandidates(
  option: WorkspaceAgentCapabilityOption
): string[] {
  return [
    option.id,
    option.name,
    option.pluginName,
    option.serverName,
    option.toolName,
    option.trigger,
    option.path
  ].filter((value): value is string => Boolean(value?.trim()));
}

function parseCapabilityLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
