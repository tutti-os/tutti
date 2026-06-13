import {
  createContext,
  useContext,
  useSyncExternalStore,
  type JSX,
  type PropsWithChildren
} from "react";
import type {
  AgentActivityCancelSessionInput,
  AgentActivityCancelSessionResult,
  AgentActivityCreateSessionInput,
  AgentActivityDeleteSessionInput,
  AgentActivityDeleteSessionResult,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivitySendInput,
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

export interface AgentActivityRuntimeListSessionMessagesInput {
  afterVersion?: number;
  beforeVersion?: number;
  agentSessionId: string;
  limit?: number;
  order?: AgentActivityMessageOrder;
  signal?: AbortSignal;
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

export interface AgentActivityRuntimeActivateSessionInput {
  agentSessionId: string;
  cwd?: string;
  initialContent?: AgentActivitySendInput["content"];
  mode: "existing" | "new";
  openclawGatewayReady?: boolean;
  provider?: string;
  settings?: AgentHostAgentSessionComposerSettings;
  title?: string;
  visible?: boolean;
  workspaceId: string;
}

export interface AgentActivityRuntimeUnactivateSessionInput {
  agentSessionId: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeReadSessionAttachmentInput {
  agentSessionId: string;
  attachmentId: string;
  workspaceId: string;
}

export interface AgentActivityRuntimeSessionAttachment {
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

export interface AgentActivityRuntime {
  cancelSession(
    input: AgentActivityCancelSessionInput
  ): Promise<AgentActivityCancelSessionResult>;
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
  sendInput(input: AgentActivitySendInput): Promise<AgentActivitySession>;
  readSessionAttachment?(
    input: AgentActivityRuntimeReadSessionAttachmentInput
  ): Promise<AgentActivityRuntimeSessionAttachment>;
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

export interface AgentActivityRuntimeProviderProps extends PropsWithChildren {
  runtime?: AgentActivityRuntime | null;
}

export function AgentActivityRuntimeProvider({
  children,
  runtime
}: AgentActivityRuntimeProviderProps): JSX.Element {
  currentAgentActivityRuntime = runtime ?? null;
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

export function resetAgentActivityRuntimeForTests(): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentActivityRuntime = null;
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
