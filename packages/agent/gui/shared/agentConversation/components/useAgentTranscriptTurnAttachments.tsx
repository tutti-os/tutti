import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
  type Ref
} from "react";
import { highlightTranscriptLocatorTarget } from "./agentMessageLocatorNavigation";
import type { AgentTranscriptTurnGroup } from "./agentTranscriptModel";
import type { AgentTranscriptLocateOperation } from "./useAgentTranscriptLocateOperation";

export interface AgentTranscriptTurnAttachment {
  id: string;
  anchorTurnId: string;
  content: ReactNode;
  missingAnchorBehavior?: "hide";
}

export type AgentTranscriptAttachmentLocator = (attachmentId: string) => void;

interface TurnAttachmentVirtualizer {
  scrollToKey(
    turnKey: string,
    findTarget?: () => HTMLElement | null,
    options?: { align?: "center" | "top"; signal?: AbortSignal }
  ): Promise<HTMLElement | null>;
}

export function useAgentTranscriptTurnAttachments(input: {
  attachments: readonly AgentTranscriptTurnAttachment[];
  isVisible: boolean;
  locateOperation: AgentTranscriptLocateOperation;
  locatorRef?: Ref<AgentTranscriptAttachmentLocator>;
  onVisibilityChange?: (attachmentId: string, visible: boolean) => void;
  rowVirtualizer: TurnAttachmentVirtualizer;
  turnGroups: readonly AgentTranscriptTurnGroup[];
}): {
  byGroupIndex: ReadonlyMap<number, readonly AgentTranscriptTurnAttachment[]>;
  onElementChange: (attachmentId: string, element: HTMLElement | null) => void;
} {
  const projection = useMemo(() => {
    const lastGroupIndexByTurnId = new Map<string, number>();
    input.turnGroups.forEach((group, groupIndex) => {
      if (group.turnId) lastGroupIndexByTurnId.set(group.turnId, groupIndex);
    });
    const byGroupIndex = new Map<number, AgentTranscriptTurnAttachment[]>();
    for (const attachment of input.attachments) {
      const groupIndex = lastGroupIndexByTurnId.get(attachment.anchorTurnId);
      if (groupIndex === undefined) {
        if (attachment.missingAnchorBehavior === "hide") continue;
        throw new Error(
          `Transcript attachment "${attachment.id}" references unavailable Turn "${attachment.anchorTurnId}"`
        );
      }
      const groupAttachments = byGroupIndex.get(groupIndex) ?? [];
      groupAttachments.push(attachment);
      byGroupIndex.set(groupIndex, groupAttachments);
    }
    const groupIndexByAttachmentId = new Map<string, number>();
    byGroupIndex.forEach((attachments, groupIndex) => {
      attachments.forEach((attachment) =>
        groupIndexByAttachmentId.set(attachment.id, groupIndex)
      );
    });
    return { byGroupIndex, groupIndexByAttachmentId };
  }, [input.attachments, input.turnGroups]);
  const attachmentElementsRef = useRef(new Map<string, HTMLElement>());
  const attachmentObserverRef = useRef<IntersectionObserver | null>(null);

  const onElementChange = useCallback(
    (attachmentId: string, element: HTMLElement | null): void => {
      const previous = attachmentElementsRef.current.get(attachmentId);
      if (previous && previous !== element) {
        attachmentObserverRef.current?.unobserve(previous);
      }
      if (!element) {
        attachmentElementsRef.current.delete(attachmentId);
        input.onVisibilityChange?.(attachmentId, false);
        if (attachmentElementsRef.current.size === 0) {
          attachmentObserverRef.current?.disconnect();
          attachmentObserverRef.current = null;
        }
        return;
      }
      attachmentElementsRef.current.set(attachmentId, element);
      if (
        !attachmentObserverRef.current &&
        input.onVisibilityChange &&
        typeof IntersectionObserver === "function"
      ) {
        attachmentObserverRef.current = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset
              .agentTranscriptAttachment;
            if (id) input.onVisibilityChange?.(id, entry.isIntersecting);
          }
        });
      }
      attachmentObserverRef.current?.observe(element);
    },
    [input.onVisibilityChange]
  );

  const locateAttachment = useCallback(
    (attachmentId: string): void => {
      const signal = input.locateOperation.begin();
      if (!input.isVisible || signal.aborted) return;
      const groupIndex = projection.groupIndexByAttachmentId.get(attachmentId);
      if (groupIndex === undefined) return;
      const turnKey = input.turnGroups[groupIndex]?.key;
      if (!turnKey) return;
      void input.rowVirtualizer
        .scrollToKey(
          turnKey,
          () => attachmentElementsRef.current.get(attachmentId) ?? null,
          { align: "center", signal }
        )
        .then((target) => {
          if (!signal.aborted && target) {
            highlightTranscriptLocatorTarget(target);
          }
        });
    },
    [
      input.isVisible,
      input.locateOperation,
      input.rowVirtualizer,
      input.turnGroups,
      projection.groupIndexByAttachmentId
    ]
  );
  useImperativeHandle(input.locatorRef ?? null, () => locateAttachment, [
    locateAttachment
  ]);

  return {
    byGroupIndex: projection.byGroupIndex,
    onElementChange
  };
}

export function AgentTranscriptAttachmentView({
  attachment,
  onElementChange
}: {
  attachment: AgentTranscriptTurnAttachment;
  onElementChange: (attachmentId: string, element: HTMLElement | null) => void;
}): JSX.Element {
  const handleRef = useCallback(
    (element: HTMLDivElement | null) => onElementChange(attachment.id, element),
    [attachment.id, onElementChange]
  );
  return (
    <div
      ref={handleRef}
      className="agent-gui-transcript-attachment"
      data-agent-transcript-attachment={attachment.id}
    >
      {attachment.content}
    </div>
  );
}
