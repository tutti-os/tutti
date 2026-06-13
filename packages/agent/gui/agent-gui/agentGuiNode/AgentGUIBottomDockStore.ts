import { proxy } from "valtio/vanilla";
import type { AgentComposerProps } from "./AgentComposer";
import type {
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "./model/agentGuiNodeTypes";

export interface AgentGUIBottomDockStoreSnapshot {
  bottomDockActivePrompt:
    | AgentGUINodeViewModel["pendingApproval"]
    | AgentGUINodeViewModel["pendingInteractivePrompt"];
  composerProps: AgentComposerProps;
  inlineNoticeChrome: AgentGUISessionChrome | null;
  isRespondingApproval: boolean;
  sessionChrome: AgentGUISessionChrome;
}

export type AgentGUIBottomDockStore = AgentGUIBottomDockStoreSnapshot;

export function createAgentGUIBottomDockStore(
  initialState: AgentGUIBottomDockStoreSnapshot
): AgentGUIBottomDockStore {
  return proxy<AgentGUIBottomDockStoreSnapshot>(initialState);
}

export function syncAgentGUIBottomDockStore(
  store: AgentGUIBottomDockStore,
  next: AgentGUIBottomDockStoreSnapshot
): void {
  if (agentGUIBottomDockStoreSnapshotsEqual(store, next)) {
    return;
  }
  Object.assign(store, next);
}

function agentGUIBottomDockStoreSnapshotsEqual(
  current: AgentGUIBottomDockStoreSnapshot,
  next: AgentGUIBottomDockStoreSnapshot
): boolean {
  return (
    current.bottomDockActivePrompt === next.bottomDockActivePrompt &&
    current.composerProps === next.composerProps &&
    current.inlineNoticeChrome === next.inlineNoticeChrome &&
    current.isRespondingApproval === next.isRespondingApproval &&
    current.sessionChrome === next.sessionChrome
  );
}
