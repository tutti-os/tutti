import { useEffect, useRef, useState } from "react";
import type { WorkbenchDockContext } from "../react/types.ts";
import type { ResolvedWorkbenchHostDockEntry } from "./dockEntries.ts";
import { minimizedDockSlotNodes } from "./dockItems.ts";
import { createWorkbenchHostExternalStateLookupInput } from "./externalState.ts";
import type { WorkbenchMinimizedDockSlot } from "./minimizedDockSlots.ts";
import type {
  WorkbenchHostExternalStateSource,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";

export function useWorkbenchHostDockActivity({
  activePopup,
  context,
  externalStateSource,
  minimizedDockSlots,
  nodeDefinitions,
  renderedDockEntries,
  workspaceId
}: {
  activePopup: boolean;
  context: WorkbenchDockContext<WorkbenchHostNodeData>;
  externalStateSource?: WorkbenchHostExternalStateSource;
  minimizedDockSlots: readonly WorkbenchMinimizedDockSlot[];
  nodeDefinitions: ReadonlyMap<string, WorkbenchHostNodeDefinition>;
  renderedDockEntries: readonly ResolvedWorkbenchHostDockEntry["entry"][];
  workspaceId: string;
}) {
  const previousAttentionTokenByEntryId = useRef(new Map<string, unknown>());
  const attentionTimeouts = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const [activeAttentionEntryIds, setActiveAttentionEntryIds] = useState<
    Set<string>
  >(new Set());
  const [externalStateRevision, setExternalStateRevision] = useState(0);
  const hasMinimizedPreviewCapture = minimizedDockSlots.some((slot) =>
    minimizedDockSlotNodes(slot).some((node) => {
      if (context.genie.isPendingMinimizedDockNode(node.id)) {
        return false;
      }
      const minimizedDock = nodeDefinitions.get(node.data.typeId)?.window
        ?.minimizedDock;
      return (
        minimizedDock?.kind === "snapshot" &&
        Boolean(minimizedDock.capturePreview)
      );
    })
  );

  useEffect(() => {
    const shouldSubscribe = activePopup || hasMinimizedPreviewCapture;
    if (!shouldSubscribe || !externalStateSource?.subscribeNodeState) {
      return undefined;
    }
    const nodes = activePopup ? context.nodes : context.minimizedNodes;
    const disposers = nodes.map((node) =>
      externalStateSource.subscribeNodeState?.(
        createWorkbenchHostExternalStateLookupInput({ node, workspaceId }),
        () => setExternalStateRevision((revision) => revision + 1)
      )
    );
    return () => {
      for (const dispose of disposers) {
        dispose?.();
      }
    };
  }, [
    activePopup,
    context.minimizedNodes,
    context.nodes,
    externalStateSource,
    hasMinimizedPreviewCapture,
    workspaceId
  ]);

  useEffect(() => {
    const nextAttentionIds = new Set<string>();

    for (const entry of renderedDockEntries) {
      const nextToken = entry.attentionToken ?? null;
      const previousToken =
        previousAttentionTokenByEntryId.current.get(entry.id) ?? null;
      if (nextToken !== null && nextToken !== previousToken) {
        nextAttentionIds.add(entry.id);
      }
      previousAttentionTokenByEntryId.current.set(entry.id, nextToken);
    }

    if (nextAttentionIds.size === 0) {
      return;
    }

    setActiveAttentionEntryIds((current) => {
      const next = new Set(current);
      for (const entryId of nextAttentionIds) {
        next.add(entryId);
      }
      return next;
    });

    for (const entryId of nextAttentionIds) {
      const existingTimeout = attentionTimeouts.current.get(entryId);
      if (existingTimeout) {
        globalThis.clearTimeout(existingTimeout);
      }
      attentionTimeouts.current.set(
        entryId,
        globalThis.setTimeout(() => {
          attentionTimeouts.current.delete(entryId);
          setActiveAttentionEntryIds((current) => {
            if (!current.has(entryId)) {
              return current;
            }
            const next = new Set(current);
            next.delete(entryId);
            return next;
          });
        }, 900)
      );
    }
  }, [renderedDockEntries]);

  useEffect(
    () => () => {
      for (const timeout of attentionTimeouts.current.values()) {
        globalThis.clearTimeout(timeout);
      }
      attentionTimeouts.current.clear();
    },
    []
  );

  return { activeAttentionEntryIds, externalStateRevision };
}
