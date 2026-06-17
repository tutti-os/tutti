import type { JSX } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

function readMentionPresentationUrl(presentation: unknown): string | null {
  if (!presentation || typeof presentation !== "object") {
    return null;
  }
  const value =
    (presentation as { iconUrl?: unknown; thumbnailUrl?: unknown }).iconUrl ??
    (presentation as { thumbnailUrl?: unknown }).thumbnailUrl;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function MentionReferenceNodeView({
  node,
  selected
}: NodeViewProps): JSX.Element {
  const label =
    typeof node.attrs.label === "string"
      ? node.attrs.label.trim().replace(/^@+/, "").trim()
      : "";
  const iconUrl = readMentionPresentationUrl(node.attrs.presentation);

  return (
    <NodeViewWrapper
      as="span"
      className={selected ? "is-selected" : undefined}
      contentEditable={false}
      data-rich-text-mention-reference="true"
    >
      <span
        className={[
          "inline-flex max-w-full items-center gap-1 overflow-hidden rounded-md px-[7px] py-0.5 text-[13px] leading-[18px] font-semibold align-baseline text-[var(--text-primary)]",
          selected
            ? "bg-[var(--background-fronted)] shadow-[var(--shadow-soft,0_1px_2px_rgb(0_0_0/8%))]"
            : "bg-[var(--transparency-block)]"
        ].join(" ")}
        data-rich-text-mention-chip="true"
      >
        {iconUrl ? (
          <span
            aria-hidden="true"
            className="inline-grid size-4 flex-none place-items-center overflow-hidden rounded"
            data-rich-text-mention-icon="true"
          >
            <img
              alt=""
              className="block size-full object-cover object-center"
              decoding="async"
              draggable={false}
              loading="lazy"
              src={iconUrl}
            />
          </span>
        ) : null}
        {label ? (iconUrl ? label : `@${label}`) : ""}
      </span>
    </NodeViewWrapper>
  );
}
