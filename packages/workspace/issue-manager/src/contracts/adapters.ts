import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReferenceDirectoryListing,
  WorkspaceFileReferencePrefetchReason,
  WorkspaceFileReferencePrefetchState,
  WorkspaceFileReferencePreview,
  WorkspaceFileReferencePreviewKind,
  WorkspaceFileReferenceTreeDirectory,
  WorkspaceFileReferenceTreeEntry,
  WorkspaceFileReferenceTreeSnapshot
} from "@tutti-os/workspace-file-reference/contracts";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectApi,
  WorkspaceUserProjectService
} from "@tutti-os/workspace-user-project/contracts";
import type {
  IssueManagerCompleteRunOutputInput,
  IssueManagerContextRef,
  IssueManagerIssueSummary,
  IssueManagerScope,
  IssueManagerTaskSummary
} from "./domain.ts";

export interface IssueManagerIdentityProfile {
  avatarUrl?: string | null;
  displayName?: string | null;
  userId: string;
}

export interface IssueManagerIdentityAdapter {
  currentUser():
    | IssueManagerIdentityProfile
    | null
    | Promise<IssueManagerIdentityProfile | null>;
  getProfiles?(
    userIds: readonly string[]
  ): Promise<Record<string, IssueManagerIdentityProfile>>;
}

export type IssueManagerFileReference = WorkspaceFileReference;
export type IssueManagerFileDirectoryListing =
  WorkspaceFileReferenceDirectoryListing;
export type IssueManagerReferencePrefetchState =
  WorkspaceFileReferencePrefetchState;
export type IssueManagerReferencePrefetchReason =
  WorkspaceFileReferencePrefetchReason;
export type IssueManagerReferenceTreeDirectory =
  WorkspaceFileReferenceTreeDirectory;
export type IssueManagerReferenceTreeEntry = WorkspaceFileReferenceTreeEntry;
export type IssueManagerReferenceTreeSnapshot =
  WorkspaceFileReferenceTreeSnapshot;
export type IssueManagerReferencePreviewKind =
  WorkspaceFileReferencePreviewKind;
export type IssueManagerReferencePreview = WorkspaceFileReferencePreview;

export interface IssueManagerFileAdapter extends WorkspaceFileReferenceAdapter {
  requestUpload?(
    input: IssueManagerScope & {
      mode: "files" | "folder";
      targetDirectoryPath: string;
    }
  ): Promise<IssueManagerFileReference[]>;
}

export interface IssueManagerAgentRunRequest extends IssueManagerScope {
  agentSessionId: string;
  executionDirectory?: string | null;
  issue: IssueManagerIssueSummary;
  provider: string;
  task?: IssueManagerTaskSummary;
}

export interface IssueManagerAgentProviderOption {
  disabled?: boolean;
  disabledReason?: string;
  iconUrl?: string | null;
  label: string;
  provider: string;
}

export interface IssueManagerAgentProviderOptionsAdapter {
  getOptions(): readonly IssueManagerAgentProviderOption[];
  subscribe?(listener: () => void): () => void;
}

export type IssueManagerOpenSource =
  | "agent_command"
  | "command"
  | "dock"
  | "keyboard"
  | "launchpad"
  | "restore";
export type IssueManagerOpenTrigger = "automatic" | "manual";

export type IssueManagerAnalyticsEvent =
  | {
      name: "issue_manager.opened";
      params: {
        source: IssueManagerOpenSource;
        trigger: IssueManagerOpenTrigger;
      };
    }
  | { name: "issue_manager.issue_created"; params: { issueId: string } }
  | {
      name: "issue_manager.issue_saved";
      params: {
        contextRefCount: number;
        hasDescription: boolean;
        issueId: string;
        taskCount: number;
      };
    }
  | { name: "issue_manager.issue_deleted"; params: { issueId: string } }
  | {
      name: "issue_manager.task_created";
      params: { issueId: string; taskId: string };
    }
  | {
      name: "issue_manager.task_saved";
      params: {
        contextRefCount: number;
        hasDescription: boolean;
        issueId: string;
        taskId: string;
      };
    }
  | {
      name: "issue_manager.task_deleted";
      params: { issueId: string; taskId: string };
    }
  | {
      name: "issue_manager.task_run_initiated";
      params: {
        hasExecutionDirectory: boolean;
        issueId: string;
        provider: string;
        taskId: string | null;
      };
    }
  | {
      name: "issue_manager.issue_breakdown_initiated";
      params: { issueId: string; provider: string };
    }
  | {
      name: "issue_manager.context_ref_added";
      params: {
        refType: "directory" | "file" | "upload";
        targetType: "issue" | "task";
      };
    }
  | {
      name: "issue_manager.context_ref_removed";
      params: { targetType: "issue" | "task" };
    }
  | { name: "issue_manager.topic_changed"; params: Record<string, never> }
  | {
      name: "issue_manager.task_searched";
      params: { queryLength: number; resultCount: number };
    };

export interface IssueManagerAnalyticsAdapter {
  track(event: IssueManagerAnalyticsEvent): Promise<void> | void;
}

export interface IssueManagerAgentRunResult {
  errorMessage?: string;
  outputs?: IssueManagerCompleteRunOutputInput[];
  sessionId?: string;
  status: "opened" | "completed" | "failed" | "canceled";
  summary?: string;
}

export interface IssueManagerAgentRunner {
  runTask(
    input: IssueManagerAgentRunRequest
  ): Promise<IssueManagerAgentRunResult>;
}

export interface IssueManagerAgentSessionOpenInput extends IssueManagerScope {
  agentSessionId: string;
  provider?: string | null;
}

export interface IssueManagerAgentSessionOpener {
  openSession(input: IssueManagerAgentSessionOpenInput): Promise<void> | void;
}

export type IssueManagerExecutionDirectoryProject = WorkspaceUserProject;

export type IssueManagerExecutionDirectoryPicker = Pick<
  WorkspaceUserProjectApi,
  "selectDirectory" | "use"
> & {
  service?: WorkspaceUserProjectService | null;
};

export interface IssueManagerAgentBreakdownRequest extends IssueManagerScope {
  executionDirectory?: string | null;
  issueDetail: {
    contextRefs: readonly IssueManagerContextRef[];
    issue: IssueManagerIssueSummary;
    tasks: readonly IssueManagerTaskSummary[];
  };
  provider: string;
}

export interface IssueManagerAgentBreakdownResult {
  errorMessage?: string;
  status: "opened" | "failed";
}

export interface IssueManagerAgentBreakdownLauncher {
  startBreakdown(
    input: IssueManagerAgentBreakdownRequest
  ): Promise<IssueManagerAgentBreakdownResult>;
}

export type IssueManagerIssueChangeKind =
  | "issue_created"
  | "issue_updated"
  | "issue_deleted"
  | "issue_context_refs_updated"
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "task_context_refs_updated"
  | "run_created"
  | "run_completed";

export interface IssueManagerIssueUpdatedEvent extends IssueManagerScope {
  changeKind: IssueManagerIssueChangeKind;
  issueId: string;
  runId?: string;
  taskId?: string;
}

export interface IssueManagerEventSource {
  connect?(): Promise<void> | void;
  subscribeToIssueUpdates(
    workspaceId: string,
    listener: (event: IssueManagerIssueUpdatedEvent) => void
  ): () => void;
}

export interface IssueManagerShareAdapter {
  createIssueLink?(
    input: IssueManagerScope & { issueId: string; taskId?: string }
  ): Promise<string>;
}
