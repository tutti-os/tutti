import { useEffect, useState, type JSX, type MouseEvent } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  MentionPill,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system/components";
import { getWorkspaceReferencePresentation } from "./workspaceReferencePresentation.ts";
import { defaultRichTextTriggerText } from "../editor/richTextTriggerText.ts";

const richTextWorkspaceReferencePillClassName = "max-w-[18rem]";

export function WorkspaceReferenceNodeView({
  deleteNode,
  editor,
  extension,
  node,
  selected
}: NodeViewProps): JSX.Element {
  const [isEditable, setIsEditable] = useState(editor.isEditable);
  const attrs = node.attrs as {
    kind?: string;
    label?: string;
    path?: string;
  };
  const extensionOptions = extension.options as {
    removeActionAriaLabel?: string;
  };
  const kind = attrs.kind === "folder" ? "folder" : "file";
  const label = typeof attrs.label === "string" ? attrs.label : "";
  const path = typeof attrs.path === "string" ? attrs.path : "";
  const presentation = getWorkspaceReferencePresentation(label, path);
  const removeActionAriaLabel =
    typeof extensionOptions.removeActionAriaLabel === "string"
      ? extensionOptions.removeActionAriaLabel
      : defaultRichTextTriggerText.removeReferenceActionLabel;

  useEffect(() => {
    const syncEditable = () => {
      setIsEditable(editor.isEditable);
    };

    syncEditable();
    editor.on("transaction", syncEditable);
    editor.on("update", syncEditable);
    return () => {
      editor.off("transaction", syncEditable);
      editor.off("update", syncEditable);
    };
  }, [editor]);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!editor.isEditable) {
      return;
    }
    deleteNode();
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`inline-flex max-w-full align-baseline ${
        selected ? "is-selected" : ""
      }`}
      contentEditable={false}
      data-rich-text-workspace-reference="true"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <MentionPill
            className={richTextWorkspaceReferencePillClassName}
            fileKind={kind}
            kind="file"
            label={presentation.displayLabel}
            removable={isEditable}
            removeButtonProps={
              isEditable
                ? {
                    "aria-label": removeActionAriaLabel,
                    onMouseDown: handleRemove
                  }
                : undefined
            }
          />
        </TooltipTrigger>
        <TooltipContent
          className="max-w-md whitespace-normal break-all"
          sideOffset={8}
        >
          {presentation.fullPath}
        </TooltipContent>
      </Tooltip>
    </NodeViewWrapper>
  );
}
