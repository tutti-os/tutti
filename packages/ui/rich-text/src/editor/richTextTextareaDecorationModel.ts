import type { CSSProperties } from "react";
import { isRichTextMentionHref } from "../core/richTextDocument.ts";
import { findRichTextMarkdownLinks } from "../core/richTextMarkdownLinks.ts";

const EXTERNAL_LINK_PREFIX = /^(?:[a-z]+:)?\/\//i;

const TEXTAREA_PRESENTATION_STYLE_PROPERTIES = [
  { styleName: "paddingTop", cssName: "padding-top" },
  { styleName: "paddingRight", cssName: "padding-right" },
  { styleName: "paddingBottom", cssName: "padding-bottom" },
  { styleName: "paddingLeft", cssName: "padding-left" },
  { styleName: "fontFamily", cssName: "font-family" },
  { styleName: "fontFeatureSettings", cssName: "font-feature-settings" },
  { styleName: "fontKerning", cssName: "font-kerning" },
  { styleName: "fontOpticalSizing", cssName: "font-optical-sizing" },
  { styleName: "fontSize", cssName: "font-size" },
  { styleName: "fontStretch", cssName: "font-stretch" },
  { styleName: "fontStyle", cssName: "font-style" },
  { styleName: "fontVariant", cssName: "font-variant" },
  { styleName: "fontVariationSettings", cssName: "font-variation-settings" },
  { styleName: "fontWeight", cssName: "font-weight" },
  { styleName: "letterSpacing", cssName: "letter-spacing" },
  { styleName: "lineHeight", cssName: "line-height" },
  { styleName: "textAlign", cssName: "text-align" },
  { styleName: "textIndent", cssName: "text-indent" },
  { styleName: "textTransform", cssName: "text-transform" },
  { styleName: "tabSize", cssName: "tab-size" },
  { styleName: "MozTabSize", cssName: "-moz-tab-size" }
] as const satisfies readonly {
  styleName: keyof CSSProperties;
  cssName: string;
}[];

type RichTextTextareaTextDecorationSegment = {
  type: "text";
  text: string;
  from: number;
  to: number;
};

type RichTextTextareaLinkDecorationSegment = {
  type: "link";
  text: string;
  from: number;
  to: number;
  label: string;
  href: string;
  kind: "file" | "folder";
};

export type RichTextTextareaDecorationSegment =
  | RichTextTextareaTextDecorationSegment
  | RichTextTextareaLinkDecorationSegment;

function isDecoratableMarkdownHref(href: string): boolean {
  const trimmedHref = href.trim();
  if (!trimmedHref) {
    return false;
  }
  if (
    EXTERNAL_LINK_PREFIX.test(trimmedHref) ||
    isRichTextMentionHref(trimmedHref)
  ) {
    return false;
  }
  return true;
}

export function buildRichTextTextareaDecorationSegments(
  value: string
): RichTextTextareaDecorationSegment[] {
  const segments: RichTextTextareaDecorationSegment[] = [];
  let cursor = 0;

  for (const match of findRichTextMarkdownLinks(value)) {
    const label = match.label.trim();
    const href = match.href.trim();
    const { index, source, to } = match;

    if (index > cursor) {
      segments.push({
        type: "text",
        text: value.slice(cursor, index),
        from: cursor,
        to: index
      });
    }

    if (label && href && isDecoratableMarkdownHref(href)) {
      segments.push({
        type: "link",
        text: source,
        from: index,
        to,
        label,
        href,
        kind: href.endsWith("/") ? "folder" : "file"
      });
    } else {
      segments.push({
        type: "text",
        text: source,
        from: index,
        to
      });
    }

    cursor = to;
  }

  if (cursor < value.length) {
    segments.push({
      type: "text",
      text: value.slice(cursor),
      from: cursor,
      to: value.length
    });
  }

  return segments;
}

export function hasRichTextTextareaDecorations(
  segments: readonly RichTextTextareaDecorationSegment[]
): boolean {
  return segments.some((segment) => segment.type === "link");
}

export function resolveRichTextTextareaSelectionBoundary(
  segments: readonly RichTextTextareaDecorationSegment[],
  selectionStart: number
): number | null {
  for (const segment of segments) {
    if (segment.type !== "link") {
      continue;
    }
    if (selectionStart <= segment.from || selectionStart >= segment.to) {
      continue;
    }
    const midpoint = segment.from + (segment.to - segment.from) / 2;
    return selectionStart < midpoint ? segment.from : segment.to;
  }
  return null;
}

function setTextareaPresentationStyleValue<K extends keyof CSSProperties>(
  styleRecord: CSSProperties,
  styleName: K,
  value: string
): void {
  styleRecord[styleName] = value as CSSProperties[K];
}

export function getTextareaPresentationStyle(
  textarea: HTMLTextAreaElement
): CSSProperties {
  const computedStyle = window.getComputedStyle(textarea);
  const styleRecord: CSSProperties = {
    whiteSpace: "pre-wrap"
  };

  setTextareaPresentationStyleValue(
    styleRecord,
    "wordBreak",
    computedStyle.wordBreak
  );
  setTextareaPresentationStyleValue(
    styleRecord,
    "overflowWrap",
    computedStyle.overflowWrap
  );

  for (const { styleName, cssName } of TEXTAREA_PRESENTATION_STYLE_PROPERTIES) {
    setTextareaPresentationStyleValue(
      styleRecord,
      styleName,
      computedStyle.getPropertyValue(cssName)
    );
  }

  return styleRecord;
}
