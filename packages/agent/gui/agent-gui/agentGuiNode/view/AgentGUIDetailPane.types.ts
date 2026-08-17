import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type {
  AgentComposerGitBranchLoader,
  AgentComposerProps,
  AgentComposerSlashStatusLimit,
  WorkspaceReferencePickResult
} from "../AgentComposer";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import type { AgentGUIComposerEngagement } from "../engagement/agentGUIEngagement.types";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIManagedHomeTargetProjection } from "../model/agentGuiProviderRailOrder";
import type { AgentGUISessionLaunchMode } from "../model/agentSessionLaunchMode";
import type {
  AgentGUINodeViewProps,
  AgentGUIViewLabels
} from "./AgentGUINodeView.types";
import type { AgentGUIComposerFooterAccessoryRenderer } from "./AgentGUIComposerFooterAccessory.types";

type AgentGUIDetailExternalPromptProps = Pick<
  AgentComposerProps,
  | "resolveExternalPromptEntries"
  | "prepareExternalPromptFiles"
  | "resolvePastedPath"
  | "promptAssetLimit"
>;

export interface AgentGUIDetailPaneProps extends AgentGUIDetailExternalPromptProps {
  shell: AgentGUINodeViewModel["shell"];
  rail: AgentGUINodeViewModel["rail"];
  detail: AgentGUINodeViewModel["detail"];
  composer: AgentGUINodeViewModel["composer"];
  interaction: AgentGUINodeViewModel["interaction"];
  readiness: AgentGUINodeViewModel["readiness"];
  operations: AgentGUINodeViewModel["operations"];
  homeTargetProjection: AgentGUIManagedHomeTargetProjection;
  referenceProvenanceFilters?: AgentComposerProps["referenceProvenanceFilters"];
  sessionInputHistoryEnabled?: boolean;
  sessionForkEnabled?: boolean;
  sessionWorktreeEnabled?: boolean;
  sessionLaunchModesByProjectSectionKey?: Readonly<
    Record<string, AgentGUISessionLaunchMode>
  >;
  onSessionLaunchModePreferenceChange?: (input: {
    mode: AgentGUISessionLaunchMode;
    projectSectionKey: string;
  }) => void | Promise<void>;
  composerEngagement?: AgentGUIComposerEngagement;
  actions: AgentGUINodeViewProps["actions"];
  labels: AgentGUIViewLabels;
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  uiLanguage: UiLanguage;
  isActive: boolean;
  isVisible: boolean;
  workspaceReferencePickerOpen: boolean;
  composerFocusRequestSequence: number | null;
  slashStatusLimits: readonly AgentComposerSlashStatusLimit[];
  slashStatusLimitsLoading: boolean;
  slashStatusLimitsUnavailable: boolean;
  slashStatusOverride?: AgentComposerProps["slashStatus"];
  onSlashStatusOpen?: AgentComposerProps["onSlashStatusOpen"];
  onSlashStatusClose?: AgentComposerProps["onSlashStatusClose"];
  onSlashStatusRefresh?: AgentComposerProps["onSlashStatusRefresh"];
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onHandoffConversation?: AgentGUINodeViewProps["onHandoffConversation"];
  showHandoffTargetOwnershipLabels?: boolean;
  capabilityMenuState?: AgentComposerProps["capabilityMenuState"];
  capabilityControlsReadOnly?: AgentComposerProps["capabilityControlsReadOnly"];
  onCapabilitySettingsRequest?: AgentComposerProps["onCapabilitySettingsRequest"];
  onAgentProviderLogin?: (provider?: string | null) => void;
  onRequestWorkspaceReferences?:
    | ((
        entity?: AgentContextMentionItem | null
      ) => Promise<WorkspaceReferencePickResult>)
    | null;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  projectSelectOptions?: AgentComposerProps["projectSelectOptions"];
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  onRequestComposerFocus: () => void;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  renderComposerFooterAccessory?: AgentGUIComposerFooterAccessoryRenderer;
}
