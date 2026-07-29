import type {
  AgentHostAgentTargetSetupSnapshot,
  AgentHostAgentTargetSetupState,
  AgentHostAgentTargetSetupWatch
} from "@tutti-os/agent-gui";

interface DesktopAgentTargetSetupWatchInput {
  agentTargetId: string;
  get: () => Promise<AgentHostAgentTargetSetupSnapshot>;
  install: (input: {
    planDigest: string;
    clientActionId: string;
  }) => Promise<AgentHostAgentTargetSetupSnapshot>;
  authenticate: (input: {
    methodId: string;
    clientActionId: string;
  }) => Promise<AgentHostAgentTargetSetupSnapshot>;
  pollIntervalMs?: number;
}

type Listener = (state: AgentHostAgentTargetSetupState) => void;

const EMPTY_STATE: AgentHostAgentTargetSetupState = {
  snapshot: null,
  loading: false,
  failed: false
};

function isPendingSetupStatus(
  status: AgentHostAgentTargetSetupSnapshot["status"] | undefined
): boolean {
  return status === "installing" || status === "authenticating";
}

export function createDesktopAgentTargetSetupWatch(
  input: DesktopAgentTargetSetupWatchInput
): AgentHostAgentTargetSetupWatch {
  let state = EMPTY_STATE;
  let requestId = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<Listener>();
  const pollIntervalMs = input.pollIntervalMs ?? 750;

  const publish = (next: AgentHostAgentTargetSetupState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const cancelPoll = () => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };
  const schedulePoll = () => {
    cancelPoll();
    if (listeners.size === 0 || !isPendingSetupStatus(state.snapshot?.status))
      return;
    // timing: daemon install is asynchronous; snapshot is its durable progress source.
    pollTimer = setTimeout(() => void requestSnapshot(false), pollIntervalMs);
  };
  const commitSnapshot = (snapshot: AgentHostAgentTargetSetupSnapshot) => {
    publish({ snapshot, loading: false, failed: false });
    schedulePoll();
  };
  const requestSnapshot = async (showLoading: boolean) => {
    const currentRequestId = ++requestId;
    if (showLoading) {
      publish({ ...state, loading: true, failed: false });
    }
    try {
      const snapshot = await input.get();
      if (currentRequestId === requestId) commitSnapshot(snapshot);
    } catch {
      if (currentRequestId === requestId) {
        publish({ ...state, loading: false, failed: true });
        if (isPendingSetupStatus(state.snapshot?.status)) schedulePoll();
      }
    }
  };
  const refresh = () => requestSnapshot(true);

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          requestId += 1;
          cancelPoll();
        }
      };
    },
    install: async ({ planDigest, clientActionId }) => {
      const currentRequestId = ++requestId;
      publish({ ...state, loading: true, failed: false });
      try {
        const snapshot = await input.install({ planDigest, clientActionId });
        if (currentRequestId === requestId) commitSnapshot(snapshot);
      } catch (error) {
        if (currentRequestId === requestId) {
          publish({ ...state, loading: false, failed: true });
        }
        throw error;
      }
    },
    authenticate: async ({ methodId, clientActionId }) => {
      const currentRequestId = ++requestId;
      publish({ ...state, loading: true, failed: false });
      try {
        const snapshot = await input.authenticate({ methodId, clientActionId });
        if (currentRequestId === requestId) commitSnapshot(snapshot);
      } catch (error) {
        if (currentRequestId === requestId) {
          publish({ ...state, loading: false, failed: true });
        }
        throw error;
      }
    },
    refresh
  };
}
