import { useMemo } from "react";
import {
  WorkspaceUserProjectSelect,
  type WorkspaceUserProjectSelectChangeAction,
  type WorkspaceUserProjectSelectLabelOverrides,
  type WorkspaceUserProjectSelectProps
} from "@tutti-os/workspace-user-project/ui";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectApi
} from "@tutti-os/workspace-user-project/contracts";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { useOptionalAgentHostApi } from "../../agentActivityHost";
import { NewWorkspaceLinedIcon, cn } from "@tutti-os/ui-system";
import type { AgentGUIComposerSettingsVM } from "./model/agentGuiNodeTypes";
import styles from "./AgentGUINode.styles";
import { createAgentGUIUserProjectSelectionApi } from "./agentGuiUserProjectSelectionApi";

export type AgentProjectDropdownLabels = Pick<
  WorkspaceUserProjectSelectLabelOverrides,
  "projectLocked"
> & {
  projectMissingDescription: string;
};

export interface AgentProjectPathChangeMetadata {
  action: WorkspaceUserProjectSelectChangeAction;
  project?: WorkspaceUserProject;
}

export type AgentProjectDropdownOptions = Pick<
  WorkspaceUserProjectSelectProps,
  "labels" | "menuActions" | "showKnownProjectOptions"
> & {
  /** Optional Host-owned import flow. Absent by default, so existing Hosts are unchanged. */
  importDirectory?: WorkspaceUserProjectApi["importDirectory"];
};

export function AgentProjectDropdown({
  composerSettings,
  labels,
  options,
  i18n,
  selectProjectDirectory,
  userProjectApi,
  onDismissAutoFocus,
  onProjectMissingChange,
  onProjectPathChange
}: {
  composerSettings: Pick<
    AgentGUIComposerSettingsVM,
    | "selectedProjectPath"
    | "projectLocked"
    | "shouldApplyPreparedProjectSelection"
  >;
  i18n: WorkspaceUserProjectI18nRuntime;
  labels: AgentProjectDropdownLabels;
  options?: AgentProjectDropdownOptions;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  userProjectApi?: WorkspaceUserProjectApi | null;
  onDismissAutoFocus?: (event: Event) => void;
  onProjectMissingChange?: (isMissing: boolean) => void;
  onProjectPathChange: (
    path: string | null,
    metadata?: AgentProjectPathChangeMetadata
  ) => void;
}): React.JSX.Element {
  "use memo";
  const agentHostApi = useOptionalAgentHostApi();
  const projectSource =
    userProjectApi === undefined ? agentHostApi?.userProjects : userProjectApi;
  const resolvedUserProjectApi = useMemo(
    () =>
      createAgentGUIUserProjectSelectionApi({
        importDirectory: options?.importDirectory,
        selectProjectDirectory,
        userProjects: projectSource
      }),
    [options?.importDirectory, projectSource, selectProjectDirectory]
  );

  return (
    <WorkspaceUserProjectSelect
      api={resolvedUserProjectApi}
      classNames={{
        content: cn(
          styles.composerMenuContent,
          "w-[240px] min-w-[240px] data-[side=top]:!translate-y-0"
        ),
        item: styles.composerMenuItem,
        trigger: cn(
          "w-auto max-w-full",
          styles.composerMenuTrigger,
          styles.composerProjectTrigger,
          "text-[var(--agent-gui-text-tertiary)]",
          "disabled:cursor-not-allowed disabled:text-[var(--agent-gui-text-tertiary)] disabled:opacity-60 disabled:hover:text-[var(--agent-gui-text-tertiary)]"
        )
      }}
      i18n={i18n}
      labels={{ ...options?.labels, ...labels }}
      menuActions={options?.menuActions}
      projectLocked={Boolean(composerSettings.projectLocked)}
      renderAddProjectIcon={() => (
        <NewWorkspaceLinedIcon
          aria-hidden
          data-workspace-user-project-add-icon="true"
          size={15}
        />
      )}
      selectedProjectPath={composerSettings.selectedProjectPath}
      service={
        userProjectApi === undefined
          ? (agentHostApi?.userProjects?.service ?? null)
          : null
      }
      shouldApplyPreparedSelection={
        composerSettings.shouldApplyPreparedProjectSelection === true
      }
      showKnownProjectOptions={options?.showKnownProjectOptions}
      onDismissAutoFocus={onDismissAutoFocus}
      onProjectMissingChange={onProjectMissingChange}
      onProjectPathChange={onProjectPathChange}
    />
  );
}
