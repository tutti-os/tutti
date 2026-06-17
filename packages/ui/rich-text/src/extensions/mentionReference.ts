import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { mentionReferenceNodeName } from "./names.ts";
import { MentionReferenceNodeView } from "./MentionReferenceNodeView.tsx";

export interface MentionReferenceAttrs {
  entityId: string;
  label: string;
  presentation?: Readonly<Record<string, string>>;
  providerId: string;
  scope?: Readonly<Record<string, string>>;
  trigger: "@";
}

export const MentionReference = Node.create({
  name: mentionReferenceNodeName,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      entityId: {
        default: ""
      },
      label: {
        default: ""
      },
      presentation: {
        default: null
      },
      providerId: {
        default: ""
      },
      scope: {
        default: null
      },
      trigger: {
        default: "@"
      }
    };
  },

  parseHTML() {
    return [{ tag: "span[data-rich-text-mention-reference]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const label =
      typeof HTMLAttributes.label === "string" ? HTMLAttributes.label : "";
    const displayLabel = label.trim().replace(/^@+/, "").trim();

    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-rich-text-mention-reference": "true",
        class:
          "inline-flex max-w-full items-center overflow-hidden rounded-md bg-transparency-block px-1.5 py-0.5 align-baseline text-[13px] font-medium text-[var(--text-primary)]"
      }),
      displayLabel ? `@${displayLabel}` : ""
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionReferenceNodeView);
  }
});
