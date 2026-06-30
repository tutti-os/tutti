import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { workspaceReferenceNodeName } from "./names.ts";
import { WorkspaceReferenceNodeView } from "./WorkspaceReferenceNodeView.tsx";
import { getWorkspaceReferencePresentation } from "./workspaceReferencePresentation.ts";
import { defaultRichTextTriggerText } from "../editor/richTextTriggerText.ts";

export interface WorkspaceReferenceAttrs {
  kind: "file" | "folder";
  label: string;
  path: string;
}

export const WorkspaceReference = Node.create({
  name: workspaceReferenceNodeName,
  addOptions() {
    return {
      removeActionAriaLabel:
        defaultRichTextTriggerText.removeReferenceActionLabel
    };
  },
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: {
        default: "file"
      },
      label: {
        default: ""
      },
      path: {
        default: ""
      }
    } satisfies Record<keyof WorkspaceReferenceAttrs, { default: string }>;
  },

  parseHTML() {
    return [{ tag: "span[data-rich-text-workspace-reference]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const kind = HTMLAttributes.kind === "folder" ? "folder" : "file";
    const label =
      typeof HTMLAttributes.label === "string" ? HTMLAttributes.label : "";
    const path =
      typeof HTMLAttributes.path === "string" ? HTMLAttributes.path : "";
    const presentation = getWorkspaceReferencePresentation(label, path);
    const referenceColorClassName =
      kind === "folder"
        ? "text-[var(--rich-text-folder)]"
        : "text-[var(--rich-text-mention-file)]";

    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-rich-text-workspace-reference": "true",
        "data-rich-text-workspace-kind": kind,
        "data-agent-file-mention": "true",
        "data-agent-mention-kind": "file",
        "data-slot": "mention-pill",
        title: presentation.fullPath,
        class: [
          "group relative inline-flex max-w-full cursor-default items-center gap-1.5 overflow-hidden rounded-[4px] border border-transparent bg-transparent px-1.5 py-0.5 align-baseline text-[13px] font-medium leading-5 no-underline transition-colors hover:border-transparent hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
          referenceColorClassName
        ].join(" ")
      }),
      [
        "span",
        {
          "aria-hidden": "true",
          class: "grid size-4 shrink-0 place-items-center text-current"
        },
        kind === "folder" ? "D" : "F"
      ],
      [
        "span",
        {
          class: "min-w-0 max-w-[20rem] truncate text-[13px] font-medium"
        },
        presentation.displayLabel
      ]
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WorkspaceReferenceNodeView);
  }
});
