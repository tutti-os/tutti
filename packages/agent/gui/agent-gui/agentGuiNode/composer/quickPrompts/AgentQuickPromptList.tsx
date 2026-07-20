import { useMemo, useRef } from "react";
import { Sortable, SortableContent, SortableItem } from "@tutti-os/ui-system";
import type { AgentHostQuickPrompt } from "../../../../host/agentHostApi";
import { AgentQuickPromptRow } from "./AgentQuickPromptRow";
import type { AgentQuickPromptLibraryController } from "./useAgentQuickPromptLibrary";

export function AgentQuickPromptList({
  controller,
  isSorting,
  onDelete,
  onEdit,
  onFocusRow,
  onSelect,
  rowRefs
}: {
  controller: AgentQuickPromptLibraryController;
  isSorting: boolean;
  onDelete: (prompt: AgentHostQuickPrompt) => void;
  onEdit: (prompt: AgentHostQuickPrompt) => void;
  onFocusRow: (index: number) => void;
  onSelect: (prompt: AgentHostQuickPrompt) => void;
  rowRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}): React.JSX.Element {
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const { filteredPrompts, labels, snapshot } = controller;
  const promptsById = useMemo(
    () => new Map(filteredPrompts.map((prompt) => [prompt.id, prompt])),
    [filteredPrompts]
  );
  const accessibility = useMemo(
    () => ({
      announcements: {
        onDragStart({ active }: { active: { id: string | number } }) {
          const index = filteredPrompts.findIndex(
            (prompt) => prompt.id === active.id
          );
          return labels.dragStart(
            promptsById.get(String(active.id))?.title ?? String(active.id),
            index + 1,
            filteredPrompts.length
          );
        },
        onDragMove({ active, over }: DragAnnouncementInput) {
          const index = over
            ? filteredPrompts.findIndex((prompt) => prompt.id === over.id)
            : filteredPrompts.findIndex((prompt) => prompt.id === active.id);
          return labels.dragMove(
            promptsById.get(String(active.id))?.title ?? String(active.id),
            index + 1,
            filteredPrompts.length
          );
        },
        onDragOver({ active, over }: DragAnnouncementInput) {
          const index = over
            ? filteredPrompts.findIndex((prompt) => prompt.id === over.id)
            : filteredPrompts.findIndex((prompt) => prompt.id === active.id);
          return labels.dragMove(
            promptsById.get(String(active.id))?.title ?? String(active.id),
            index + 1,
            filteredPrompts.length
          );
        },
        onDragEnd({ active, over }: DragAnnouncementInput) {
          if (!over) {
            return labels.dragCancel(
              promptsById.get(String(active.id))?.title ?? String(active.id),
              filteredPrompts.findIndex((prompt) => prompt.id === active.id) +
                1,
              filteredPrompts.length
            );
          }
          const index = filteredPrompts.findIndex(
            (prompt) => prompt.id === over.id
          );
          return labels.dragDrop(
            promptsById.get(String(active.id))?.title ?? String(active.id),
            index + 1,
            filteredPrompts.length
          );
        },
        onDragCancel({ active }: DragAnnouncementInput) {
          const index = filteredPrompts.findIndex(
            (prompt) => prompt.id === active.id
          );
          return labels.dragCancel(
            promptsById.get(String(active.id))?.title ?? String(active.id),
            index + 1,
            filteredPrompts.length
          );
        }
      },
      screenReaderInstructions: { draggable: labels.dragInstructions }
    }),
    [filteredPrompts, labels, promptsById]
  );

  return (
    <Sortable
      accessibility={accessibility}
      value={[...filteredPrompts]}
      getItemValue={(prompt) => prompt.id}
      onMove={({ activeIndex, overIndex }) => {
        const next = [...filteredPrompts];
        const [moving] = next.splice(activeIndex, 1);
        if (!moving) return;
        next.splice(overIndex, 0, moving);
        const beforePromptId = next[overIndex + 1]?.id ?? null;
        void controller.reorderPrompts(moving.id, beforePromptId).then(() => {
          window.requestAnimationFrame(() =>
            handleRefs.current.get(moving.id)?.focus()
          );
        });
      }}
    >
      <SortableContent className="flex flex-col gap-0.5">
        {filteredPrompts.map((prompt, index) => (
          <SortableItem key={prompt.id} value={prompt.id}>
            <AgentQuickPromptRow
              handleRef={(node) => {
                if (node) handleRefs.current.set(prompt.id, node);
                else handleRefs.current.delete(prompt.id);
              }}
              labels={labels}
              isSorting={isSorting}
              pending={
                controller.isInteractionLocked ||
                snapshot.pendingMutationIds.includes(prompt.id)
              }
              prompt={prompt}
              reorderDisabled={!controller.canReorder}
              selectionRef={(node) => {
                if (node) rowRefs.current.set(prompt.id, node);
                else rowRefs.current.delete(prompt.id);
              }}
              showReorderHandle={isSorting && controller.showReorderHandles}
              onDelete={() => onDelete(prompt)}
              onEdit={() => onEdit(prompt)}
              onFocusNext={(offset) =>
                onFocusRow(
                  (index + offset + filteredPrompts.length) %
                    filteredPrompts.length
                )
              }
              onSelect={() => onSelect(prompt)}
            />
          </SortableItem>
        ))}
      </SortableContent>
    </Sortable>
  );
}

type DragAnnouncementInput = {
  active: { id: string | number };
  over: { id: string | number } | null;
};
