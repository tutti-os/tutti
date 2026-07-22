import {
  createContext,
  useContext,
  useSyncExternalStore,
  type JSX,
  type PropsWithChildren
} from "react";
import type {
  AgentActivityActivateSessionResult,
  AgentActivityCollaborationRun,
  AgentActivityGoalControlInput,
  AgentActivityGoalControlResult,
  AgentActivityCreateSessionInput,
  AgentActivityDeleteSessionInput,
  AgentActivityDeleteSessionResult,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivityRenameSessionInput,
  AgentActivitySendInput,
  AgentActivitySendInputResult,
  AgentActivitySession,
  AgentActivitySessionSettings,
  AgentActivitySetCollaborationAdoptionInput,
  AgentActivitySnapshot,
  AgentActivitySnapshotListener,
  AgentActivitySubmitInteractiveInput,
  AgentActivitySubmitInteractiveResult,
  AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type {
  AgentHostAgentSessionComposerSettings,
  AgentHostUnactivateAgentSessionResult
} from "./shared/contracts/dto";
import type { WorkspaceQueryCache } from "./shared/query/workspaceQueryCache";

export interface AgentActivityRuntimeUpdateSessionSettingsResult {
  agentSessionId: string;
  settings: AgentHostAgentSessionComposerSettings;
  session: AgentActivitySession;
}

export interface AgentActivityRuntimeListSessionMessagesInput {
  afterVersion?: number;
  beforeVersion?: number;
  cache?: boolean;
  agentSessionId: string;
  limit?: number;
  order?: AgentActivityMessageOrder;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeListGeneratedFilesInput {
  agentTargetIds?: readonly string[];
  cursor?: string;
  limit?: number;
  query?: string;
  sectionKey: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeListSessionsPageInput {
  agentTargetId?: string | null;
  cursor?: string;
  limit?: number;
  searchQuery?: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeSessionPageResult {
  hasMore: boolean;
  nextCursor?: string;
  sessions: AgentActivitySession[];
  workspaceId: string;
}

export interface AgentActivityRuntimeListSessionSectionsInput {
  agentTargetId?: string | null;
  limitPerSection?: number;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeListSessionSectionPageInput {
  agentTargetId?: string | null;
  cursor?: string;
  limit?: number;
  sectionKey: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeListPinnedSessionsPageInput {
  agentTargetId?: string | null;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeUserProject {
  createdAtUnixMs: number;
  id: string;
  label: string;
  lastUsedAtUnixMs?: number;
  path: string;
  pinnedAtUnixMs: number;
  sectionKey: string;
  updatedAtUnixMs: number;
}

export interface AgentActivityRuntimeSessionSection {
  kind: "conversations" | "project";
  sectionKey: string;
  userProject?: AgentActivityRuntimeUserProject;
  sessions: AgentActivitySession[];
  hasMore: boolean;
  totalCount: number;
  nextCursor?: string;
}

export interface AgentActivityRuntimeSessionPage {
  sessions: AgentActivitySession[];
  hasMore: boolean;
  totalCount: number;
  nextCursor?: string;
}

export interface AgentActivityRuntimeSessionSectionsResult {
  pinned?: AgentActivityRuntimeSessionPage;
  sections: AgentActivityRuntimeSessionSection[];
  workspaceId: string;
}

export interface AgentActivityRuntimeGeneratedFile {
  label: string;
  path: string;
}

export interface AgentActivityRuntimeGeneratedFileList {
  entries: AgentActivityRuntimeGeneratedFile[];
  hasMore?: boolean;
  nextCursor?: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeEnsureSessionSynchronizedInput {
  afterVersion?: number;
  agentSessionId: string;
  onError?: (error: unknown) => void;
  workspaceId: string;
}

export interface AgentActivityRuntimeSetSessionPinnedInput {
  agentSessionId: string;
  pinned: boolean;
  workspaceId: string;
}

export interface AgentActivityRuntimeTrackSettingsProjectChangeInput {
  action: "clear" | "create_new" | "select_existing";
  agentSessionId: string;
  provider?: string | null;
  workspaceId: string;
}

export interface AgentActivityRuntimeGetComposerOptionsInput {
  agentTargetId: string;
  cwd?: string | null;
  force?: boolean;
  provider?: string;
  settings?: AgentHostAgentSessionComposerSettings | null;
  workspaceId: string;
}

export interface AgentActivityRuntimeUpdateSessionSettingsInput {
  agentSessionId: string;
  settings: AgentHostAgentSessionComposerSettings;
  workspaceId: string;
}

export interface AgentActivityRuntimeTrackDraftComposerSettingsChangeInput {
  nextSettings: AgentHostAgentSessionComposerSettings;
  previousSettings: AgentHostAgentSessionComposerSettings;
  provider: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeDiagnosticInput {
  details?: Record<string, unknown>;
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  source?: string;
  workspaceId?: string | null;
}

interface AgentActivityRuntimeActivateSessionInputBase {
  agentSessionId: string;
  cwd?: string;
  initialContent?: AgentActivitySendInput["content"];
  /** 仅展示用首轮文本(bundle 折叠成一个 chip);initialContent 仍带展开后的文件。 */
  initialDisplayPrompt?: string | null;
  submitDiagnostics?: AgentActivitySendInput["submitDiagnostics"];
  settings?: AgentActivitySessionSettings;
  title?: string;
  visible?: boolean;
  workspaceId: string;
  signal?: AbortSignal;
}

export type AgentActivityRuntimeActivateSessionInput =
  | (AgentActivityRuntimeActivateSessionInputBase & {
      agentTargetId: string;
      clientSubmitId: string;
      mode: "new";
    })
  | (AgentActivityRuntimeActivateSessionInputBase & {
      agentTargetId?: string | null;
      clientSubmitId?: never;
      mode: "existing";
    });

export interface AgentActivityRuntimeUnactivateSessionInput {
  agentSessionId: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeReadSessionAttachmentInput {
  agentSessionId: string;
  attachmentId: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeReadPromptAssetInput {
  agentSessionId?: string | null;
  assetId?: string | null;
  hostPath?: string | null;
  kind?: string | null;
  mimeType: string;
  name?: string | null;
  path?: string | null;
  sha256?: string | null;
  uploadStatus?: string | null;
  uri?: string | null;
  workspaceId: string;
}

export type AgentActivityRuntimePromptContentBlock =
  AgentActivitySendInput["content"][number] & {
    assetId?: string;
    hostPath?: string;
    kind?: string;
    path?: string;
    sizeBytes?: number;
    uploadStatus?: string;
    uri?: string;
  };

export interface AgentActivityRuntimeUploadPromptContentInput {
  content: AgentActivityRuntimePromptContentBlock[];
  workspaceId: string;
}

export interface AgentActivityRuntimeUploadPromptContentResult {
  content: AgentActivityRuntimePromptContentBlock[];
}

/**
 * Dedicated host boundary for turning an in-memory text paste into a local
 * prompt asset. The runtime owns persistence and returns a sendable host path;
 * AgentGUI must not infer this capability from generic file-upload support.
 */
export interface AgentActivityRuntimeStagePastedTextInput {
  name: string;
  text: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeStagePastedTextResult {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface AgentActivityRuntimeSessionSectionScopeInput {
  agentTargetId?: string | null;
  excludePinned?: boolean;
  sectionKey: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeSessionSectionDeletionCandidates {
  agentTargetId?: string | null;
  excludePinned: boolean;
  sectionKey: string;
  sessionIds: string[];
  workspaceId: string;
}

export interface AgentActivityRuntimeDeleteSessionsBatchInput {
  sessionIds: string[];
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeDeleteSessionsBatchResult {
  removedMessages: number;
  removedSessionIds: string[];
  removedSessions: number;
}

export interface AgentActivityRuntimeSessionAttachment {
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

export interface AgentActivityRuntimePromptAsset {
  assetId?: string;
  hostPath?: string;
  kind?: string;
  mimeType: string;
  name?: string;
  path: string;
  uploadStatus?: string;
  uri?: string;
  data: string;
}

export interface AgentActivityRuntime {
  /**
   * Stable identity of this runtime instance (e.g. a local origin vs a
   * shared/room origin). The runtime owns one session engine per workspace and
   * that engine verifies this origin as part of its injected identity. Runtime
   * consumers resolve only through the nearest React provider; module-global
   * runtime lookup and last-mounted fallback are forbidden. An absent origin
   * means the canonical local origin.
   */
  origin?: string;
  /**
   * The session cwd is not resolvable on the local filesystem (e.g. a
   * shared/cloud sandbox not mounted locally), so AgentGUI must not run its
   * local stat-based "working directory missing" existence check — it would
   * always false-positive. Absent/false (default) => local, legacy behaviour.
   * Only that one guard is gated; project selection/listing is unaffected.
   */
  projectPathIsRemote?: boolean;
  promptContentUploadSupport?: {
    file?: boolean;
    image?: boolean;
  };
  /** Set false to suppress AgentGUI diagnostics in development consoles. */
  devDiagnosticConsoleSink?: boolean;
  goalControl(
    input: AgentActivityGoalControlInput
  ): Promise<AgentActivityGoalControlResult>;
  createSession(
    input: AgentActivityCreateSessionInput
  ): Promise<AgentActivitySession>;
  deleteSession(
    input: AgentActivityDeleteSessionInput
  ): Promise<AgentActivityDeleteSessionResult>;
  activateSession(
    input: AgentActivityRuntimeActivateSessionInput
  ): Promise<AgentActivityActivateSessionResult>;
  getSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<AgentActivitySession>;
  getComposerOptions(
    input: AgentActivityRuntimeGetComposerOptionsInput
  ): Promise<unknown>;
  updateSessionSettings(
    input: AgentActivityRuntimeUpdateSessionSettingsInput
  ): Promise<AgentActivityRuntimeUpdateSessionSettingsResult>;
  getSnapshot(workspaceId: string): AgentActivitySnapshot;
  getSessionEngine(workspaceId: string): AgentSessionEngine;
  getSessionSectionsQueryCache?(
    workspaceId: string
  ): WorkspaceQueryCache<unknown>;
  listSessionMessages(
    input: AgentActivityRuntimeListSessionMessagesInput
  ): Promise<AgentActivityMessagePage>;
  listAgentGeneratedFiles?(
    input: AgentActivityRuntimeListGeneratedFilesInput
  ): Promise<AgentActivityRuntimeGeneratedFileList>;
  listSessionsPage?(
    input: AgentActivityRuntimeListSessionsPageInput
  ): Promise<AgentActivityRuntimeSessionPageResult>;
  listSessionSections?(
    input: AgentActivityRuntimeListSessionSectionsInput
  ): Promise<AgentActivityRuntimeSessionSectionsResult>;
  listSessionSectionPage?(
    input: AgentActivityRuntimeListSessionSectionPageInput
  ): Promise<AgentActivityRuntimeSessionSection>;
  listSessionSectionDeletionCandidates?(
    input: AgentActivityRuntimeSessionSectionScopeInput
  ): Promise<AgentActivityRuntimeSessionSectionDeletionCandidates>;
  deleteSessionsBatch?(
    input: AgentActivityRuntimeDeleteSessionsBatchInput
  ): Promise<AgentActivityRuntimeDeleteSessionsBatchResult>;
  listPinnedSessionsPage?(
    input: AgentActivityRuntimeListPinnedSessionsPageInput
  ): Promise<AgentActivityRuntimeSessionPage>;
  load(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<AgentActivitySnapshot>;
  ensureSessionSynchronized?(
    input: AgentActivityRuntimeEnsureSessionSynchronizedInput
  ): () => void;
  sendInput(
    input: AgentActivitySendInput
  ): Promise<AgentActivitySendInputResult>;
  uploadPromptContent?(
    input: AgentActivityRuntimeUploadPromptContentInput
  ): Promise<AgentActivityRuntimeUploadPromptContentResult>;
  stagePastedText?(
    input: AgentActivityRuntimeStagePastedTextInput
  ): Promise<AgentActivityRuntimeStagePastedTextResult>;
  readSessionAttachment?(
    input: AgentActivityRuntimeReadSessionAttachmentInput
  ): Promise<AgentActivityRuntimeSessionAttachment>;
  readPromptAsset?(
    input: AgentActivityRuntimeReadPromptAssetInput
  ): Promise<AgentActivityRuntimePromptAsset>;
  renameSession(
    input: AgentActivityRenameSessionInput
  ): Promise<AgentActivitySession>;
  /**
   * Record whether a collaboration outcome was adopted.
   * Optional; hosts without support omit it and adoption controls stay hidden.
   */
  setCollaborationAdoption?(
    input: AgentActivitySetCollaborationAdoptionInput
  ): Promise<AgentActivityCollaborationRun>;
  setSessionPinned(
    input: AgentActivityRuntimeSetSessionPinnedInput
  ): Promise<AgentActivitySession>;
  trackSettingsProjectChange?(
    input: AgentActivityRuntimeTrackSettingsProjectChangeInput
  ): Promise<void>;
  trackDraftComposerSettingsChange?(
    input: AgentActivityRuntimeTrackDraftComposerSettingsChangeInput
  ): Promise<void>;
  reportDiagnostic?(
    input: AgentActivityRuntimeDiagnosticInput
  ): Promise<void> | void;
  unactivateSession(
    input: AgentActivityRuntimeUnactivateSessionInput
  ): Promise<AgentHostUnactivateAgentSessionResult>;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<AgentActivitySubmitInteractiveResult>;
  subscribeSessionEvents(
    workspaceId: string,
    listener: (event: unknown) => void
  ): () => void;
  subscribe(
    workspaceId: string,
    listener: AgentActivitySnapshotListener
  ): () => void;
}

const AgentActivityRuntimeContext = createContext<AgentActivityRuntime | null>(
  null
);

function createTestAgentActivityRuntimeHolder(): {
  get: () => AgentActivityRuntime | null;
  set: (runtime: AgentActivityRuntime | null) => void;
} {
  let runtime: AgentActivityRuntime | null = null;
  return {
    get: () => runtime,
    set: (nextRuntime) => {
      runtime = nextRuntime;
    }
  };
}

const testAgentActivityRuntimeHolder = createTestAgentActivityRuntimeHolder();

export interface AgentActivityRuntimeProviderProps extends PropsWithChildren {
  runtime?: AgentActivityRuntime | null;
}

export function AgentActivityRuntimeProvider({
  children,
  runtime
}: AgentActivityRuntimeProviderProps): JSX.Element {
  return (
    <AgentActivityRuntimeContext.Provider value={runtime ?? null}>
      {children}
    </AgentActivityRuntimeContext.Provider>
  );
}

export function useAgentActivityRuntime(): AgentActivityRuntime {
  const runtime =
    useContext(AgentActivityRuntimeContext) ?? getTestAgentActivityRuntime();
  if (!runtime) {
    throw new Error(
      "AgentActivityRuntimeProvider is missing an AgentActivityRuntime instance."
    );
  }
  return runtime;
}

export function useOptionalAgentActivityRuntime(): AgentActivityRuntime | null {
  return (
    useContext(AgentActivityRuntimeContext) ?? getTestAgentActivityRuntime()
  );
}

export function useAgentActivitySnapshot(
  workspaceId: string
): AgentActivitySnapshot {
  const runtime = useAgentActivityRuntime();
  const normalizedWorkspaceId = workspaceId.trim();
  return useSyncExternalStore(
    (listener) => runtime.subscribe(normalizedWorkspaceId, listener),
    () => runtime.getSnapshot(normalizedWorkspaceId),
    () => runtime.getSnapshot(normalizedWorkspaceId)
  );
}

export function resetAgentActivityRuntimeForTests(): void {
  if (process.env.NODE_ENV === "test") {
    testAgentActivityRuntimeHolder.set(null);
  }
}

export function setAgentActivityRuntimeForTests(
  runtime: AgentActivityRuntime | null
): void {
  if (process.env.NODE_ENV === "test") {
    testAgentActivityRuntimeHolder.set(runtime);
  }
}

function getTestAgentActivityRuntime(): AgentActivityRuntime | null {
  if (process.env.NODE_ENV !== "test") {
    return null;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const explicitRuntime = getExplicitWindowTestAgentActivityRuntime();
  if (explicitRuntime) {
    return explicitRuntime;
  }
  const testRuntimeOverride = testAgentActivityRuntimeHolder.get();
  if (testRuntimeOverride) {
    return testRuntimeOverride;
  }
  const testRuntime = (
    window as unknown as Window & {
      agentActivityRuntime?: AgentActivityRuntime;
    }
  ).agentActivityRuntime;
  return testRuntime ?? null;
}

function getExplicitWindowTestAgentActivityRuntime(): AgentActivityRuntime | null {
  if (process.env.NODE_ENV !== "test" || typeof window === "undefined") {
    return null;
  }
  const testDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "agentActivityRuntime"
  );
  if (!testDescriptor || !("value" in testDescriptor)) {
    return null;
  }
  return (testDescriptor.value as AgentActivityRuntime | undefined) ?? null;
}
