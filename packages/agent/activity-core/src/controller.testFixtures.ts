import type { AgentActivityAdapter } from "./adapter.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivityMessage,
  AgentActivitySession
} from "./types.ts";
import { normalizeAgentActivitySession } from "./sessionNormalization.ts";

export function testAdapter(
  overrides: Partial<AgentActivityAdapter> = {}
): AgentActivityAdapter {
  const unsupported = async (): Promise<never> => {
    throw new Error("unsupported test adapter operation");
  };
  return {
    createSession: unsupported,
    deleteSession: unsupported,
    goalControl: unsupported,
    listSessionMessages: async () => ({
      hasMore: false,
      latestVersion: 0,
      messages: []
    }),
    listSessions: async () => ({ sessions: [] }),
    loadComposerOptions: unsupported,
    renameSession: unsupported,
    sendInput: unsupported,
    submitInteractive: unsupported,
    subscribeSessionEvents: async () => () => {},
    ...overrides
  };
}

export function testSession(
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    provider: "codex",
    title: "Session",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1",
    ...overrides
  });
}

export function testMessage(
  messageId: string,
  version: number,
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId,
    occurredAtUnixMs: version,
    payload: { text: `message ${version}` },
    role: "assistant",
    turnId: "turn-1",
    version,
    workspaceId: "workspace-1",
    ...overrides
  };
}

export function testComposerOptions(
  provider: string,
  loadedAtUnixMs: number
): AgentActivityComposerOptions {
  return {
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: true,
      planModeExclusiveWithPermissionMode: false,
      prewarmDraftSession: false,
      refreshModelOptionsAfterSettings: false
    },
    capabilities: null,
    capabilityCatalog: [],
    loadedAtUnixMs,
    modelConfigurable: true,
    modelOptionsLoading: false,
    models: [{ label: "Model", value: `model-${loadedAtUnixMs}` }],
    provider,
    reasoningConfigurable: false,
    reasoningEfforts: [],
    skills: [],
    speedConfigurable: false,
    speeds: []
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
