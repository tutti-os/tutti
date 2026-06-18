import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";

export const TUTTI_EXTERNAL_AT_PROVIDER_IDS = {
  agentGeneratedFile: "agent-generated-file",
  agentSession: "agent-session",
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
  expiresAt?: string;
  models?: readonly TuttiExternalManagedAiModel[];
  providers?: readonly TuttiExternalManagedAiModelProviderId[];
}

export interface TuttiExternalSettingsOpenInput {
  provider?: TuttiExternalManagedAiModelProviderId;
  tab?: "models";
}

export type TuttiExternalWorkspaceFeature =
  | "app-center"
  | "issue-manager"
  | "message-center"
  | "agent-connect"
  | "agent-chat";

export interface TuttiExternalWorkspaceOpenFeatureInput {
  feature: TuttiExternalWorkspaceFeature;
  provider?: string;
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

export interface TuttiExternalBridge {
  app: {
    getContext(): Promise<unknown>;
    subscribe(listener: (context: unknown) => void): () => void;
  };
  at: {
    query(
      input: TuttiExternalAtQueryInput
    ): Promise<TuttiExternalAtQueryResult[]>;
  };
  files: {
    select(
      input?: TuttiExternalFileSelectInput
    ): Promise<TuttiExternalFileSelectResult>;
    open(input: TuttiExternalFileOpenInput): Promise<void>;
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
    openFeature(input: TuttiExternalWorkspaceOpenFeatureInput): Promise<void>;
  };
  logs: {
    write(input: TuttiExternalLogInput): void;
  };
}

export type TuttiExternalRendererRequest =
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
    };
