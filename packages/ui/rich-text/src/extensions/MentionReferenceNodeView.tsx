import type { JSX } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { MentionPill } from "@tutti-os/ui-system/components";
import {
  resolveMentionPillIconUrl,
  resolveMentionPillKind
} from "./mentionPillPresentation.ts";

const richTextMentionReferencePillClassName = "max-w-[16rem]";

function readStringAttr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function MentionReferenceNodeView({
  node,
  selected
}: NodeViewProps): JSX.Element {
  const label =
    typeof node.attrs.label === "string"
      ? node.attrs.label.trim().replace(/^@+/, "").trim()
      : "";
  const iconUrl = resolveMentionPillIconUrl({
    presentation: node.attrs.presentation,
    scope: node.attrs.scope
  });
  const kind = resolveMentionPillKind(
    readStringAttr(node.attrs.providerId),
    node.attrs.scope
  );

  return (
    <NodeViewWrapper
      as="span"
      className={`inline-flex max-w-full align-baseline${
        selected ? " is-selected" : ""
      }`}
      contentEditable={false}
      data-rich-text-mention-reference="true"
    >
      <MentionPill
        className={richTextMentionReferencePillClassName}
        iconUrl={iconUrl || undefined}
        kind={kind}
        label={label}
        removable={false}
      />
    </NodeViewWrapper>
  );
}
