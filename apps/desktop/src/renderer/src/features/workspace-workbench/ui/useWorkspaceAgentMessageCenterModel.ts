import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";
import {
  buildWorkspaceAgentMessageCenterModel,
  stabilizeWorkspaceAgentMessageCenterModel,
  type WorkspaceAgentMessageCenterModel
} from "@tutti-os/agent-gui/agent-message-center";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { useTranslation } from "@renderer/i18n";

const messageCenterVisibleHistoryMs = 7 * 24 * 60 * 60 * 1000;
const activityListenerMaxDelayMs = 50;

export function useWorkspaceAgentMessageCenterModel(input: {
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceId: string;
}): {
  model: WorkspaceAgentMessageCenterModel;
  snapshot: AgentActivitySnapshot;
} {
  const { t } = useTranslation();
  const snapshotRef = useRef<{
    snapshot: AgentActivitySnapshot;
    workspaceId: string;
  } | null>(null);
  const modelRef = useRef<WorkspaceAgentMessageCenterModel | null>(null);
  const modelWorkspaceIdRef = useRef<string | null>(null);
  const subscribeSnapshot = useCallback(
    (listener: () => void) => {
      const coalescedListener = createCoalescedActivityListener(listener);
      const unsubscribe = input.workspaceAgentActivityService.subscribe(
        input.workspaceId,
        (nextSnapshot) => {
          snapshotRef.current = {
            snapshot: nextSnapshot,
            workspaceId: input.workspaceId
          };
          coalescedListener.schedule();
        }
      );
      return () => {
        coalescedListener.cancel();
        unsubscribe();
      };
    },
    [input.workspaceAgentActivityService, input.workspaceId]
  );
  const readSnapshot = useCallback(() => {
    if (snapshotRef.current?.workspaceId === input.workspaceId) {
      return snapshotRef.current.snapshot;
    }
    const nextSnapshot = input.workspaceAgentActivityService.getSnapshot(
      input.workspaceId
    );
    snapshotRef.current = {
      snapshot: nextSnapshot,
      workspaceId: input.workspaceId
    };
    return nextSnapshot;
  }, [input.workspaceAgentActivityService, input.workspaceId]);
  const snapshot = useSyncExternalStore(
    subscribeSnapshot,
    readSnapshot,
    readSnapshot
  );
  const itemCutoffUnixMs = useMemo(
    () => Date.now() - messageCenterVisibleHistoryMs,
    [input.workspaceId]
  );
  const model = useMemo(() => {
    if (modelWorkspaceIdRef.current !== input.workspaceId) {
      modelWorkspaceIdRef.current = input.workspaceId;
      modelRef.current = null;
    }
    const nextModel = buildWorkspaceAgentMessageCenterModel(snapshot, {
      promptFallbackLabels: {
        constraintHeader: t(
          "workspace.agentMessageCenter.promptConstraintHeader"
        ),
        inputHeader: t("workspace.agentMessageCenter.promptInputHeader"),
        question: t("workspace.agentMessageCenter.promptQuestion"),
        title: t("workspace.agentMessageCenter.promptTitle")
      },
      itemCutoffUnixMs,
      workspaceRoot: null
    });
    const stableModel = stabilizeWorkspaceAgentMessageCenterModel(
      modelRef.current,
      nextModel
    );
    modelRef.current = stableModel;
    return stableModel;
  }, [input.workspaceId, itemCutoffUnixMs, snapshot, t]);

  useEffect(() => {
    void input.workspaceAgentActivityService.load(input.workspaceId);
  }, [input.workspaceAgentActivityService, input.workspaceId]);

  return { model, snapshot };
}

function createCoalescedActivityListener(listener: () => void): {
  cancel(): void;
  schedule(): void;
} {
  let frameId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let canceled = false;
  const clearScheduled = (): void => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const flush = (): void => {
    if (canceled) {
      return;
    }
    clearScheduled();
    listener();
  };
  return {
    cancel() {
      canceled = true;
      clearScheduled();
    },
    schedule() {
      if (frameId !== null || timeoutId !== null) {
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        frameId = requestAnimationFrame(flush);
        timeoutId = setTimeout(flush, activityListenerMaxDelayMs);
        return;
      }
      timeoutId = setTimeout(flush, 0);
    }
  };
}
