import type { CSSProperties, JSX, MouseEvent, ReactNode } from "react";
import { MentionPill } from "@tutti-os/ui-system/components";
import { resolveRichTextMentionView } from "../plugins/mention.ts";
import {
  resolveMentionPillIconUrl,
  resolveMentionPillKind
} from "../extensions/mentionPillPresentation.ts";
import type {
  RichTextMentionAttrs,
  RichTextResolvedMention,
  RichTextResolvedMentionView
} from "../types/mention.ts";

export interface RichTextMentionReadonlyClickPayload<TResolved = unknown> {
  mention: RichTextMentionAttrs;
  resolved: RichTextResolvedMentionView<TResolved>;
}

export interface RichTextMentionReadonlyProps<TResolved = unknown> {
  mention: RichTextMentionAttrs;
  resolved?: RichTextResolvedMention<TResolved> | null;
  className?: string;
  title?: string;
  onClick?: (payload: RichTextMentionReadonlyClickPayload<TResolved>) => void;
  renderLabel?: (
    payload: RichTextMentionReadonlyClickPayload<TResolved>
  ) => ReactNode;
}

const baseStyle: CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  maxWidth: "100%",
  textDecoration: "none",
  verticalAlign: "baseline",
  whiteSpace: "nowrap"
};

const stateStyles: Record<RichTextResolvedMentionView["state"], CSSProperties> =
  {
    active: {
      color: "var(--tutti-rich-text-mention-active-fg, inherit)",
      cursor: "pointer"
    },
    missing: {
      color:
        "var(--tutti-rich-text-mention-missing-fg, color-mix(in srgb, currentColor 48%, transparent))",
      cursor: "default",
      textDecoration: "line-through"
    },
    disabled: {
      color:
        "var(--tutti-rich-text-mention-disabled-fg, color-mix(in srgb, currentColor 58%, transparent))",
      cursor: "not-allowed",
      opacity: 0.88
    },
    loading: {
      color:
        "var(--tutti-rich-text-mention-loading-fg, color-mix(in srgb, currentColor 82%, transparent))",
      cursor: "progress",
      opacity: 0.92
    }
  };

function joinClassNames(
  ...parts: Array<string | null | undefined | false>
): string | undefined {
  const value = parts.filter(Boolean).join(" ").trim();
  return value || undefined;
}

export function RichTextMentionReadonly<TResolved = unknown>({
  mention,
  resolved,
  className,
  title,
  onClick,
  renderLabel
}: RichTextMentionReadonlyProps<TResolved>): JSX.Element {
  const view = resolveRichTextMentionView(mention, resolved);
  const payload: RichTextMentionReadonlyClickPayload<TResolved> = {
    mention,
    resolved: view as RichTextResolvedMentionView<TResolved>
  };
  const label = renderLabel?.(payload) ?? view.label;
  const content = (
    <MentionPill
      className="top-0"
      iconUrl={
        resolveMentionPillIconUrl({
          presentation: view.presentation,
          scope: mention.scope
        }) ?? undefined
      }
      kind={resolveMentionPillKind(mention.providerId, mention.scope)}
      label={label}
      removable={false}
    />
  );
  const elementTitle = title ?? view.tooltip;
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (!view.interactive) {
      event.preventDefault();
      return;
    }
    onClick?.(payload);
  };

  const sharedProps = {
    "aria-busy": view.state === "loading" || undefined,
    "aria-disabled": !view.interactive || undefined,
    className: joinClassNames(
      "tutti-rich-text-mention",
      `tutti-rich-text-mention--${view.state}`,
      className
    ),
    "data-provider-id": mention.providerId,
    "data-state": view.state,
    style: {
      ...baseStyle,
      ...stateStyles[view.state]
    },
    title: elementTitle
  } as const;

  if (view.interactive && onClick) {
    return (
      <button
        {...sharedProps}
        onClick={(event) => {
          handleClick(event);
        }}
        style={{
          ...sharedProps.style,
          appearance: "none",
          background: "transparent",
          border: 0,
          font: "inherit",
          padding: 0
        }}
        type="button"
      >
        {content}
      </button>
    );
  }

  return <span {...sharedProps}>{content}</span>;
}
