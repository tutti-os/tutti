import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectDefaultSelection,
  WorkspaceUserProjectMoveInput,
  WorkspaceUserProjectPathCheck,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectServiceSnapshot
} from "@tutti-os/workspace-user-project/contracts";

export const TUTTI_EXTERNAL_AT_PROVIDER_IDS = {
  agentGeneratedFile: "agent-generated-file",
  agentSession: "agent-session",
  agentTarget: "agent-target",
  file: "file",
  workspaceApp: "workspace-app",
  workspaceIssue: "workspace-issue"
} as const;

export type TuttiExternalAtProviderId =
  (typeof TUTTI_EXTERNAL_AT_PROVIDER_IDS)[keyof typeof TUTTI_EXTERNAL_AT_PROVIDER_IDS];

export const tuttiExternalAtProviderIds = [
  TUTTI_EXTERNAL_AT_PROVIDER_IDS.file,
  TUTTI_EXTERNAL_AT_PROVIDER_IDS.workspaceIssue,
  TUTTI_EXTERNAL_AT_PROVIDER_IDS.workspaceApp,
  TUTTI_EXTERNAL_AT_PROVIDER_IDS.agentTarget,
  TUTTI_EXTERNAL_AT_PROVIDER_IDS.agentSession,
  TUTTI_EXTERNAL_AT_PROVIDER_IDS.agentGeneratedFile
] as const satisfies readonly TuttiExternalAtProviderId[];

export interface TuttiExternalAtQueryInput {
  keyword: string;
  maxResults?: number;
  providers?: readonly TuttiExternalAtProviderId[];
}

export interface TuttiExternalAtQueryResult {
  providerId: TuttiExternalAtProviderId;
  itemId: string;
  label: string;
  subtitle?: string;
  thumbnailUrl?: string | null;
  insert: TuttiExternalAtInsertResult;
}

export interface TuttiExternalAtResolveInput {
  providerId: TuttiExternalAtProviderId;
  entityId: string;
  scope?: Readonly<Record<string, string>>;
}

export interface TuttiExternalAtResolveResult {
  label?: string;
  presentation?: TuttiExternalAtMentionPresentation;
}

export interface TuttiExternalAtInvalidation {
  providerIds?: readonly TuttiExternalAtProviderId[];
  entityIds?: readonly string[];
  revision?: number;
}

export interface TuttiExternalAtMentionPresentation {
  agentProviderId?: string;
  agentIconUrl?: string;
  iconUrl?: string;
  thumbnailUrl?: string;
  subtitle?: string;
  description?: string;
  participant?: string;
  status?: string;
  statusDataStatus?: string;
  statusLabel?: string;
  statusPulse?: string;
  userAvatarPlaceholderUrl?: string;
}

export type TuttiExternalAtInsertResult =
  | {
      kind: "mention";
      mention: {
        entityId: string;
        label: string;
        scope?: Record<string, string>;
        presentation?: TuttiExternalAtMentionPresentation;
      };
    }
  | {
      kind: "markdown-link";
      label: string;
      href: string;
    }
  | {
      kind: "text";
      text: string;
    };

export interface TuttiExternalFileSelectInput {
  multiple?: boolean;
}

export type TuttiExternalFileSelectResult = WorkspaceFileReference[];

export interface TuttiExternalFileOpenInput {
  mode?: "auto" | "preview" | "reveal";
  mtimeMs?: number | null;
  name?: string;
  path: string;
  sizeBytes?: number | null;
}

export interface TuttiExternalFileUploadInput {
  purpose?: "app-asset";
  name?: string;
  mimeType?: string;
  onProgress?: (progress: TuttiExternalFileUploadProgress) => void;
  signal?: AbortSignal;
}

export interface TuttiExternalUploadedFile {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface TuttiExternalFileUploadProgress {
  loadedBytes: number;
  ratio: number;
  totalBytes: number;
}

export const tuttiExternalManagedAiModelProviderIds = [
  "agnes",
  "openai",
  "anthropic"
] as const;

export type TuttiExternalManagedAiModelProviderId =
  (typeof tuttiExternalManagedAiModelProviderIds)[number];

export interface TuttiExternalManagedAiModel {
  id: string;
  name?: string;
  provider: TuttiExternalManagedAiModelProviderId;
}

export interface TuttiExternalPermissionRequestInput {
  permission: "managed-ai-models";
  nonce: string;
  providers?: readonly TuttiExternalManagedAiModelProviderId[];
  scopes: readonly string[];
  state: string;
}

export interface TuttiExternalPermissionRequestResult {
  code: string;
  contextToken?: string;
  expiresAt?: string;
  models?: readonly TuttiExternalManagedAiModel[];
  providers?: readonly TuttiExternalManagedAiModelProviderId[];
}

export interface TuttiExternalSettingsOpenInput {
  provider?: TuttiExternalManagedAiModelProviderId;
  tab?: "models";
}

export interface TuttiExternalBrowserOpenUrlInput {
  url: string;
}

export type TuttiExternalWorkspaceFeature =
  | "app-center"
  | "issue-manager"
  | "message-center"
  | "agent-connect"
  | "agent-chat"
  | "agent-manage";

export const tuttiExternalWorkspaceAgentProviders = [
  "claude-code",
  "codex",
  "cursor",
  "nexight",
  "hermes",
  "openclaw"
] as const;

export type TuttiExternalWorkspaceAgentProvider =
  (typeof tuttiExternalWorkspaceAgentProviders)[number];

export interface TuttiExternalWorkspaceOpenFeatureInput {
  autoSubmit?: boolean;
  draftPrompt?: string;
  feature: TuttiExternalWorkspaceFeature;
  provider?: TuttiExternalWorkspaceAgentProvider;
}

export interface TuttiExternalWorkspaceOpenRouteIntent {
  kind: "open-route";
  params?: Record<string, string>;
  /**
   * Origin-root path for the app launch origin. It must start with "/".
   */
  route: string;
  state?: Record<string, unknown>;
}

export interface TuttiExternalReferenceOpenInput {
  href: string;
}

export interface TuttiExternalUserProjectCreateInput {
  name: string;
}

export interface TuttiExternalUserProjectPathInput {
  path: string;
}

export interface TuttiExternalUserProjectRememberDefaultSelectionInput {
  path: string | null;
}

export const tuttiExternalLogLevels = [
  "debug",
  "info",
  "warn",
  "error"
] as const;

export type TuttiExternalLogLevel = (typeof tuttiExternalLogLevels)[number];

export interface TuttiExternalLogInput {
  details?: Record<string, unknown>;
  event: string;
  level?: TuttiExternalLogLevel;
}

export interface TuttiExternalPdfMargin {
  bottom?: string;
  left?: string;
  right?: string;
  top?: string;
}

export type TuttiExternalPdfPageSize =
  | "A4"
  | "Letter"
  | {
      height: number;
      width: number;
    };

export interface TuttiExternalPdfPrintHtmlInput {
  baseUrl?: string;
  html: string;
  margin?: TuttiExternalPdfMargin;
  pageSize?: TuttiExternalPdfPageSize;
  preferCSSPageSize?: boolean;
  printBackground?: boolean;
  title?: string;
}

export interface TuttiExternalPdfPrintHtmlResult {
  bytes: Uint8Array;
}

export interface TuttiExternalBridge {
  app: {
    getContext(): Promise<unknown>;
    subscribe(listener: (context: unknown) => void): () => void;
  };
  activity: {
    reportActive(): Promise<void>;
  };
  browser: {
    openUrl(input: TuttiExternalBrowserOpenUrlInput): Promise<void>;
  };
  at: {
    query(
      input: TuttiExternalAtQueryInput
    ): Promise<TuttiExternalAtQueryResult[]>;
    resolve?(
      input: TuttiExternalAtResolveInput
    ): Promise<TuttiExternalAtResolveResult | null>;
    subscribe?(
      listener: (event: TuttiExternalAtInvalidation) => void
    ): () => void;
  };
  files: {
    select(
      input?: TuttiExternalFileSelectInput
    ): Promise<TuttiExternalFileSelectResult>;
    open(input: TuttiExternalFileOpenInput): Promise<void>;
    upload(
      file: Blob | File,
      input?: TuttiExternalFileUploadInput
    ): Promise<TuttiExternalUploadedFile>;
  };
  permissions: {
    request(
      input: TuttiExternalPermissionRequestInput
    ): Promise<TuttiExternalPermissionRequestResult>;
  };
  settings: {
    open(input?: TuttiExternalSettingsOpenInput): Promise<void>;
  };
  workspace: {
    onLaunchIntent(
      listener: (intent: TuttiExternalWorkspaceOpenRouteIntent) => void
    ): () => void;
    openFeature(input: TuttiExternalWorkspaceOpenFeatureInput): Promise<void>;
  };
  references: {
    open(input: TuttiExternalReferenceOpenInput): Promise<void>;
  };
  pdf: {
    printHtmlToPdf(
      input: TuttiExternalPdfPrintHtmlInput
    ): Promise<TuttiExternalPdfPrintHtmlResult>;
  };
  userProjects: {
    checkPath(
      input: TuttiExternalUserProjectPathInput
    ): Promise<WorkspaceUserProjectPathCheck>;
    create(
      input: TuttiExternalUserProjectCreateInput
    ): Promise<WorkspaceUserProject>;
    getDefaultSelection(): Promise<WorkspaceUserProjectDefaultSelection | null>;
    getSnapshot(): Promise<WorkspaceUserProjectServiceSnapshot>;
    list(): Promise<{ projects: WorkspaceUserProject[] }>;
    move(input: WorkspaceUserProjectMoveInput): Promise<void>;
    prepareSelection(
      input: WorkspaceUserProjectSelectionPreparationInput
    ): Promise<WorkspaceUserProjectSelectionPreparation>;
    refresh(): Promise<WorkspaceUserProjectServiceSnapshot>;
    rememberDefaultSelection(
      input: TuttiExternalUserProjectRememberDefaultSelectionInput
    ): Promise<void>;
    selectDirectory(): Promise<{ path: string } | null>;
    /**
     * Subscribes to user-project snapshots. Implementations replay the latest
     * known snapshot after registration, then emit future snapshots.
     */
    subscribe(
      listener: (snapshot: WorkspaceUserProjectServiceSnapshot) => void
    ): () => void;
    use(
      input: TuttiExternalUserProjectPathInput
    ): Promise<WorkspaceUserProject>;
  };
  logs: {
    write(input: TuttiExternalLogInput): void;
  };
}

export type TuttiExternalRendererRequest =
  | {
      appId: string;
      input: TuttiExternalAtResolveInput;
      operation: "at.resolve";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalAtQueryInput;
      operation: "at.query";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalFileSelectInput;
      operation: "files.select";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalFileOpenInput;
      operation: "files.open";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalSettingsOpenInput;
      operation: "settings.open";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalReferenceOpenInput;
      operation: "references.open";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalUserProjectPathInput;
      operation: "userProjects.checkPath";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalUserProjectCreateInput;
      operation: "userProjects.create";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      operation: "userProjects.getDefaultSelection";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      operation: "userProjects.getSnapshot";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      operation: "userProjects.list";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: WorkspaceUserProjectMoveInput;
      operation: "userProjects.move";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: WorkspaceUserProjectSelectionPreparationInput;
      operation: "userProjects.prepareSelection";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      operation: "userProjects.refresh";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalUserProjectRememberDefaultSelectionInput;
      operation: "userProjects.rememberDefaultSelection";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      operation: "userProjects.selectDirectory";
      requestId: string;
      workspaceId: string;
    }
  | {
      appId: string;
      input: TuttiExternalUserProjectPathInput;
      operation: "userProjects.use";
      requestId: string;
      workspaceId: string;
    };
