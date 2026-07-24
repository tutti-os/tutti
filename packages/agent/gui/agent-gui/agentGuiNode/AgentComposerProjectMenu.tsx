import { useMemo } from "react";
import {
  WorkspaceUserProjectSelect,
  type WorkspaceUserProjectSelectChangeAction,
  type WorkspaceUserProjectSelectLabelOverrides
} from "@tutti-os/workspace-user-project/ui";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project/contracts";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { useAgentHostApi } from "../../agentActivityHost";
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

export function AgentProjectDropdown({
  composerSettings,
  labels,
  i18n,
  selectProjectDirectory,
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
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onDismissAutoFocus?: (event: Event) => void;
  onProjectMissingChange?: (isMissing: boolean) => void;
  onProjectPathChange: (
    path: string | null,
    metadata?: AgentProjectPathChangeMetadata
  ) => void;
}): React.JSX.Element {
  "use memo";
  const agentHostApi = useAgentHostApi();
  const userProjectApi = useMemo(
    () =>
      createAgentGUIUserProjectSelectionApi({
        selectProjectDirectory,
        userProjects: agentHostApi.userProjects
      }),
    [agentHostApi.userProjects, selectProjectDirectory]
  );

  return (
    <WorkspaceUserProjectSelect
      api={userProjectApi}
      classNames={{
        content: cn(
          styles.composerMenuContent,
          "w-[240px] min-w-[240px] data-[side=top]:!translate-y-0"
        ),
        item: styles.composerMenuItem,
        trigger: cn(
          "w-auto max-w-full",
          styles.composerMenuTrigger,
          "text-[var(--agent-gui-text-tertiary)]",
          "disabled:cursor-not-allowed disabled:text-[var(--agent-gui-text-tertiary)] disabled:opacity-60 disabled:hover:text-[var(--agent-gui-text-tertiary)]"
        )
      }}
      i18n={i18n}
      labels={labels}
      projectLocked={Boolean(composerSettings.projectLocked)}
      renderAddProjectIcon={() => (
        <NewWorkspaceLinedIcon
          aria-hidden
          data-workspace-user-project-add-icon="true"
          size={15}
        />
      )}
      selectedProjectPath={composerSettings.selectedProjectPath}
      service={agentHostApi.userProjects?.service ?? null}
      shouldApplyPreparedSelection={
        composerSettings.shouldApplyPreparedProjectSelection === true
      }
      onDismissAutoFocus={onDismissAutoFocus}
      onProjectMissingChange={onProjectMissingChange}
      onProjectPathChange={onProjectPathChange}
    />
  );
}
