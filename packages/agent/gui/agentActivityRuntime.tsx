import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type JSX,
  type PropsWithChildren
} from "react";
import type {
  AgentActivityCancelSessionInput,
  AgentActivityCancelSessionResult,
  AgentActivityGoalControlInput,
  AgentActivityGoalControlResult,
  AgentActivityCreateSessionInput,
  AgentActivityDeleteSessionInput,
  AgentActivityDeleteSessionResult,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivitySendInput,
  AgentActivitySendInputResult,
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivitySnapshotListener,
  AgentActivitySubmitInteractiveInput
} from "@tutti-os/agent-activity-core";
import type {
  AgentHostAgentSessionComposerSettings,
  AgentHostActivateAgentSessionResult,
  AgentHostRuntimeOpenclawGatewayWarmupResult,
  AgentHostUpdateAgentSessionSettingsResult,
  AgentHostUnactivateAgentSessionResult,
  AgentHostAgentSessionState
} from "./shared/contracts/dto";
import { WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN } from "./shared/workspaceAgentActivityTypes";

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
  limit?: number;
  query?: string;
  sessionCwd?: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentActivityRuntimeListSessionsPageInput {
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

export interface AgentActivityRuntimeUserProject {
  createdAtUnixMs: number;
  id: string;
  label: string;
  lastUsedAtUnixMs?: number;
  path: string;
  sectionKey: string;
  updatedAtUnixMs: number;
}

export interface AgentActivityRuntimeSessionSection {
  kind: "conversations" | "project";
  sectionKey: string;
  userProject?: AgentActivityRuntimeUserProject;
  sessions: AgentActivitySession[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface AgentActivityRuntimeSessionSectionsResult {
  sections: AgentActivityRuntimeSessionSection[];
  workspaceId: string;
}

export interface AgentActivityRuntimeGeneratedFile {
  label: string;
  path: string;
}

export interface AgentActivityRuntimeGeneratedFileList {
  entries: AgentActivityRuntimeGeneratedFile[];
  workspaceId: string;
}

export interface AgentActivityRuntimeEnsureSessionSynchronizedInput {
  afterVersion?: number;
  agentSessionId: string;
  onError?: (error: unknown) => void;
  workspaceId: string;
}

export type AgentActivityRuntimeRetainSessionEventsInput =
  AgentActivityRuntimeEnsureSessionSynchronizedInput;

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

export interface AgentActivityRuntimeGetSessionControlStateInput {
  agentSessionId: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeGetComposerOptionsInput {
  agentTargetId?: string | null;
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

export interface AgentActivityRuntimeWarmupOpenclawGatewayInput {
  workspaceId?: string | null;
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
  metadata?: Record<string, unknown>;
  openclawGatewayReady?: boolean;
  settings?: AgentHostAgentSessionComposerSettings;
  title?: string;
  visible?: boolean;
  workspaceId: string;
}

export type AgentActivityRuntimeActivateSessionInput =
  | (AgentActivityRuntimeActivateSessionInputBase & {
      agentTargetId: string;
      mode: "new";
    })
  | (AgentActivityRuntimeActivateSessionInputBase & {
      agentTargetId?: string | null;
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
   * shared/room origin). When present, the conversation-list and session-view
   * stores key their query state, runtime resolution, and subscriptions by this
   * value, so multiple runtimes can coexist for the same workspace without
   * fighting over a single module-global slot. Absent => legacy single-runtime
   * behaviour resolved via the module-global.
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
  cancelSession(
    input: AgentActivityCancelSessionInput
  ): Promise<AgentActivityCancelSessionResult>;
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
  ): Promise<AgentHostActivateAgentSessionResult>;
  getSession(
    workspaceId: string,
    agentSessionId: string
  ): Promise<AgentActivitySession>;
  getComposerOptions(
    input: AgentActivityRuntimeGetComposerOptionsInput
  ): Promise<unknown>;
  updateSessionSettings(
    input: AgentActivityRuntimeUpdateSessionSettingsInput
  ): Promise<AgentHostUpdateAgentSessionSettingsResult>;
  warmupOpenclawGateway?(
    input?: AgentActivityRuntimeWarmupOpenclawGatewayInput
  ): Promise<AgentHostRuntimeOpenclawGatewayWarmupResult>;
  getSessionControlState(
    input: AgentActivityRuntimeGetSessionControlStateInput
  ): Promise<AgentHostAgentSessionState>;
  getSnapshot(workspaceId: string): AgentActivitySnapshot;
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
  load(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<AgentActivitySnapshot>;
  ensureSessionSynchronized?(
    input: AgentActivityRuntimeEnsureSessionSynchronizedInput
  ): () => void;
  /** @deprecated Use ensureSessionSynchronized. */
  retainSessionEvents(
    input: AgentActivityRuntimeRetainSessionEventsInput
  ): () => void;
  sendInput(
    input: AgentActivitySendInput
  ): Promise<AgentActivitySendInputResult>;
  uploadPromptContent?(
    input: AgentActivityRuntimeUploadPromptContentInput
  ): Promise<AgentActivityRuntimeUploadPromptContentResult>;
  readSessionAttachment?(
    input: AgentActivityRuntimeReadSessionAttachmentInput
  ): Promise<AgentActivityRuntimeSessionAttachment>;
  readPromptAsset?(
    input: AgentActivityRuntimeReadPromptAssetInput
  ): Promise<AgentActivityRuntimePromptAsset>;
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
  ): Promise<unknown>;
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

let currentAgentActivityRuntime: AgentActivityRuntime | null = null;

// Registry of runtimes indexed by their stable `origin`. Non-React module
// singletons (the conversation-list and session-view stores) resolve the
// correct runtime for a query's origin from here instead of reading the
// last-mounted module-global — the single slot two runtimes used to fight over.
const runtimesByOrigin = new Map<string, AgentActivityRuntime>();

// A runtime without an explicit origin is the default (local) runtime. It
// registers under this canonical origin — the same value the conversation-list
// query and session-view refs fall back to — so the local window resolves to it
// by origin instead of depending on the last-mounted module-global. A shared/
// room runtime opts in by setting a distinct `origin`; no host wiring needed for
// the local case.
function normalizeRuntimeOrigin(origin: string | null | undefined): string {
  return origin?.trim() || WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN;
}

export interface AgentActivityRuntimeProviderProps extends PropsWithChildren {
  runtime?: AgentActivityRuntime | null;
}

export function AgentActivityRuntimeProvider({
  children,
  runtime
}: AgentActivityRuntimeProviderProps): JSX.Element {
  currentAgentActivityRuntime = runtime ?? null;
  const origin = normalizeRuntimeOrigin(runtime?.origin);
  // Register during render to close the gap before the effect runs (parity with
  // the module-global write above); the effect owns cleanup on unmount.
  if (origin && runtime) {
    runtimesByOrigin.set(origin, runtime);
  }
  useEffect(() => {
    if (!origin || !runtime) {
      return;
    }
    runtimesByOrigin.set(origin, runtime);
    return () => {
      // Only clear if a newer provider hasn't already re-registered this origin.
      if (runtimesByOrigin.get(origin) === runtime) {
        runtimesByOrigin.delete(origin);
      }
    };
  }, [origin, runtime]);
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

export function getAgentActivityRuntime(): AgentActivityRuntime {
  const runtime =
    getExplicitWindowTestAgentActivityRuntime() ??
    currentAgentActivityRuntime ??
    getTestAgentActivityRuntime();
  if (!runtime) {
    throw new Error(
      "AgentActivityRuntimeProvider is missing an AgentActivityRuntime instance."
    );
  }
  return runtime;
}

export function getOptionalAgentActivityRuntime(): AgentActivityRuntime | null {
  return (
    getExplicitWindowTestAgentActivityRuntime() ??
    currentAgentActivityRuntime ??
    getTestAgentActivityRuntime()
  );
}

/**
 * Resolve the runtime for a given origin. When the origin is registered (two
 * runtimes coexisting for one workspace), returns that exact instance.
 *
 * Only the default (local) origin falls back to legacy single-runtime
 * resolution. An explicit non-default origin that is not registered returns null
 * rather than cross-routing to a different runtime via the module-global slot —
 * e.g. a shared query must never silently load from the local runtime.
 */
export function getAgentActivityRuntimeByOrigin(
  origin: string | null | undefined
): AgentActivityRuntime | null {
  const normalizedOrigin = normalizeRuntimeOrigin(origin);
  const runtime = runtimesByOrigin.get(normalizedOrigin);
  if (runtime) {
    return runtime;
  }
  if (normalizedOrigin === WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN) {
    return getOptionalAgentActivityRuntime();
  }
  return null;
}

export function resetAgentActivityRuntimeForTests(): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentActivityRuntime = null;
    runtimesByOrigin.clear();
  }
}

export function setAgentActivityRuntimeForTests(
  runtime: AgentActivityRuntime | null
): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentActivityRuntime = runtime;
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
  if (currentAgentActivityRuntime) {
    return currentAgentActivityRuntime;
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
