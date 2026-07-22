import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import {
  WorkspaceUserProjectSelect,
  resolveWorkspaceUserProjectSelectLabels,
  type WorkspaceUserProjectSelectChangeAction,
  type WorkspaceUserProjectSelectLabelOverrides
} from "@tutti-os/workspace-user-project/ui";
import type { WorkspaceUserProject } from "@tutti-os/workspace-user-project/contracts";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { useAgentHostApi } from "../../agentActivityHost";
import {
  FolderIcon,
  NewWorkspaceLinedIcon,
  NoWorkspaceLinedIcon,
  cn
} from "@tutti-os/ui-system";
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

function basenameProjectPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

export function AgentProjectDropdown({
  composerSettings,
  labels,
  i18n,
  previewMode = false,
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
  previewMode?: boolean;
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
  const resolvedLabels = useMemo(
    () => resolveWorkspaceUserProjectSelectLabels(i18n, labels),
    [i18n, labels]
  );
  const userProjectApi = useMemo(
    () =>
      createAgentGUIUserProjectSelectionApi({
        selectProjectDirectory,
        userProjects: previewMode ? null : agentHostApi.userProjects
      }),
    [agentHostApi.userProjects, previewMode, selectProjectDirectory]
  );

  if (previewMode) {
    const selectedPath = composerSettings.selectedProjectPath?.trim() ?? "";
    const triggerLabel = selectedPath
      ? basenameProjectPath(selectedPath)
      : resolvedLabels.noProject;
    return (
      <button
        type="button"
        aria-label={
          composerSettings.projectLocked
            ? resolvedLabels.projectLocked
            : resolvedLabels.projectLabel
        }
        className={cn(
          "w-auto max-w-full",
          styles.composerMenuTrigger,
          "text-[var(--agent-gui-text-tertiary)]"
        )}
      >
        <span
          className="workspace-user-project-trigger-label"
          data-workspace-user-project-trigger-label="true"
        >
          {selectedPath ? (
            <FolderIcon aria-hidden className="shrink-0" size={15} />
          ) : (
            <NoWorkspaceLinedIcon
              aria-hidden
              className="shrink-0"
              data-agent-project-trigger-no-workspace-icon="true"
              size={15}
            />
          )}
          <span className="min-w-0 truncate">{triggerLabel}</span>
        </span>
        <ChevronDown aria-hidden="true" className="shrink-0" size={16} />
      </button>
    );
  }

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
