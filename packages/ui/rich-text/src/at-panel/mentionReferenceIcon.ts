import React, { type CSSProperties } from "react";
import type { MentionFileVisualKind } from "./mentionFileVisualKind.ts";

export type MentionReferenceProviderKind =
  | "agent-generated-file"
  | "agent-session"
  | "file"
  | "workspace-app"
  | "workspace-issue"
  | "generic";

export interface MentionReferenceLeadingInput {
  className?: string;
  fileVisualKind?: MentionFileVisualKind;
  iconUrl?: string | null;
  imageClassName?: string;
  kind: MentionReferenceProviderKind;
  label?: string | null;
  thumbnailUrl?: string | null;
}

const REFERENCE_LEADING_STYLE = {
  alignItems: "center",
  background: "var(--bg-block, var(--block, #0000000a))",
  borderRadius: "8px",
  color: "var(--rich-text-at-mention-text-secondary, currentColor)",
  display: "inline-grid",
  flex: "0 0 32px",
  height: "32px",
  justifyItems: "center",
  overflow: "hidden",
  width: "32px"
} as const satisfies CSSProperties;

const REFERENCE_IMAGE_STYLE = {
  display: "block",
  height: "100%",
  objectFit: "cover",
  width: "100%"
} as const satisfies CSSProperties;

const REFERENCE_ICON_STYLE = {
  display: "block",
  height: "18px",
  width: "18px"
} as const satisfies CSSProperties;

export function resolveMentionReferenceImageUrl(input: {
  iconUrl?: string | null;
  thumbnailUrl?: string | null;
}): string | undefined {
  return input.thumbnailUrl?.trim() || input.iconUrl?.trim() || undefined;
}

export function renderMentionReferenceLeading(
  input: MentionReferenceLeadingInput
): React.JSX.Element {
  const imageUrl = resolveMentionReferenceImageUrl(input);
  return React.createElement(
    "span",
    {
      "aria-hidden": "true",
      className: input.className,
      "data-rich-text-at-mention-reference-kind": input.kind,
      "data-rich-text-at-mention-reference-leading": "true",
      style: REFERENCE_LEADING_STYLE
    },
    imageUrl
      ? React.createElement("img", {
          alt: "",
          className: input.imageClassName,
          decoding: "async",
          draggable: false,
          loading: "lazy",
          src: imageUrl,
          style: REFERENCE_IMAGE_STYLE
        })
      : renderMentionReferenceFallbackIcon(input)
  );
}

function renderMentionReferenceFallbackIcon(
  input: Pick<MentionReferenceLeadingInput, "fileVisualKind" | "kind">
): React.JSX.Element {
  return React.createElement(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.8,
      style: REFERENCE_ICON_STYLE,
      viewBox: "0 0 24 24"
    },
    ...referenceIconPaths(input)
  );
}

function referenceIconPaths(
  input: Pick<MentionReferenceLeadingInput, "fileVisualKind" | "kind">
): React.ReactNode[] {
  if (input.kind === "workspace-app") {
    return [
      React.createElement("rect", {
        height: 7,
        key: "a",
        rx: 1.5,
        width: 7,
        x: 4,
        y: 4
      }),
      React.createElement("rect", {
        height: 7,
        key: "b",
        rx: 1.5,
        width: 7,
        x: 13,
        y: 4
      }),
      React.createElement("rect", {
        height: 7,
        key: "c",
        rx: 1.5,
        width: 7,
        x: 4,
        y: 13
      }),
      React.createElement("rect", {
        height: 7,
        key: "d",
        rx: 1.5,
        width: 7,
        x: 13,
        y: 13
      })
    ];
  }
  if (input.kind === "workspace-issue") {
    return [
      React.createElement("circle", { cx: 12, cy: 12, key: "a", r: 8 }),
      React.createElement("path", { d: "M8.5 12.5 11 15l4.5-5", key: "b" })
    ];
  }
  if (input.kind === "agent-session") {
    return [
      React.createElement("path", {
        d: "M6 9.5a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2.5a5 5 0 0 1-5 5h-1.5L8 19v-2.4A5 5 0 0 1 6 12z",
        key: "a"
      })
    ];
  }
  if (
    input.kind === "file" ||
    input.kind === "agent-generated-file" ||
    input.fileVisualKind != null
  ) {
    if (input.fileVisualKind === "folder" || input.fileVisualKind === "back") {
      return [
        React.createElement("path", {
          d: "M3.5 7.5h6l2 2h9v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
          key: "a"
        })
      ];
    }
    if (input.fileVisualKind === "image") {
      return [
        React.createElement("rect", {
          height: 14,
          key: "a",
          rx: 2,
          width: 16,
          x: 4,
          y: 5
        }),
        React.createElement("path", {
          d: "m7 16 3.5-3.5 2.5 2.5 2-2 2 3",
          key: "b"
        }),
        React.createElement("circle", { cx: 9, cy: 9, key: "c", r: 1 })
      ];
    }
    if (input.fileVisualKind === "video") {
      return [
        React.createElement("rect", {
          height: 14,
          key: "a",
          rx: 2,
          width: 16,
          x: 4,
          y: 5
        }),
        React.createElement("path", {
          d: "m10 9 5 3-5 3z",
          key: "b"
        })
      ];
    }
    return [
      React.createElement("path", {
        d: "M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z",
        key: "a"
      }),
      React.createElement("path", { d: "M14 3.5v4h4", key: "b" })
    ];
  }
  return [
    React.createElement("path", {
      d: "M9.5 14.5 14.5 9.5",
      key: "a"
    }),
    React.createElement("path", {
      d: "M8.5 10.5 7 12a3.5 3.5 0 0 0 5 5l1.5-1.5",
      key: "b"
    }),
    React.createElement("path", {
      d: "M15.5 13.5 17 12a3.5 3.5 0 0 0-5-5l-1.5 1.5",
      key: "c"
    })
  ];
}
