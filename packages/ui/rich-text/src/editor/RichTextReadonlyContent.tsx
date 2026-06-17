import type { JSX } from "react";
import {
  MentionPill,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system/components";
import { cn } from "@tutti-os/ui-system/utils";
import {
  isRichTextMentionHref,
  normalizeRichTextContent,
  normalizeRichTextLinkHref,
  parseRichTextMentionHref
} from "../core/richTextDocument.ts";
import { getWorkspaceReferencePresentation } from "../extensions/workspaceReferencePresentation.ts";
import { RichTextMentionReadonly } from "./RichTextMentionReadonly.tsx";
import { buildRichTextReadonlyInlineSegments } from "./richTextReadonlyContentModel.ts";
import type { RichTextMentionAttrs } from "../types/mention.ts";

export interface RichTextReadonlyWorkspaceReference {
  kind: "file" | "folder";
  label: string;
  path: string;
}

export interface RichTextReadonlyContentProps {
  value: string;
  className?: string;
  paragraphClassName?: string;
  onMentionAction?: (mention: RichTextMentionAttrs) => void | Promise<void>;
  onOpenWorkspaceReference?: (
    reference: RichTextReadonlyWorkspaceReference
  ) => void | Promise<void>;
}

const externalHrefPattern = /^(?:[a-z]+:)?\/\//i;
const richTextWorkspaceReferencePillClassName = "max-w-[18rem]";

export function RichTextReadonlyContent({
  value,
  className,
  paragraphClassName,
  onMentionAction,
  onOpenWorkspaceReference
}: RichTextReadonlyContentProps): JSX.Element | null {
  const normalizedValue = normalizeRichTextContent(value).trim();

  if (!normalizedValue) {
    return null;
  }

  const paragraphs = normalizedValue
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return (
    <div className={cn("space-y-4", className)}>
      {paragraphs.map((paragraph, paragraphIndex) => (
        <p
          className={cn("whitespace-pre-wrap", paragraphClassName)}
          key={`${paragraphIndex}:${paragraph}`}
        >
          {renderReadonlyInlineMarkdown(
            paragraph,
            onOpenWorkspaceReference,
            onMentionAction
          )}
        </p>
      ))}
    </div>
  );
}

function renderReadonlyInlineMarkdown(
  content: string,
  onOpenWorkspaceReference?: (
    reference: RichTextReadonlyWorkspaceReference
  ) => void | Promise<void>,
  onMentionAction?: (mention: RichTextMentionAttrs) => void | Promise<void>
): JSX.Element[] {
  const parts: JSX.Element[] = [];
  const segments = buildRichTextReadonlyInlineSegments(content);

  segments.forEach((segment, index) => {
    if (segment.type === "text") {
      parts.push(<span key={`text:${index}`}>{segment.text}</span>);
      return;
    }

    parts.push(
      <RichTextReadonlyInlineLink
        href={segment.href}
        key={`link:${index}:${segment.href}`}
        label={segment.label}
        onMentionAction={onMentionAction}
        onOpenWorkspaceReference={onOpenWorkspaceReference}
      />
    );
  });

  return parts;
}

function RichTextReadonlyInlineLink({
  href,
  label,
  onMentionAction,
  onOpenWorkspaceReference
}: {
  href: string;
  label: string;
  onMentionAction?: (mention: RichTextMentionAttrs) => void | Promise<void>;
  onOpenWorkspaceReference?: (
    reference: RichTextReadonlyWorkspaceReference
  ) => void | Promise<void>;
}): JSX.Element {
  const trimmedHref = href.trim();
  const mention = parseRichTextMentionHref(trimmedHref, label);

  if (mention) {
    return (
      <RichTextMentionReadonly
        mention={mention}
        onClick={
          onMentionAction
            ? ({ mention }) => {
                void onMentionAction(mention);
              }
            : undefined
        }
      />
    );
  }

  if (!trimmedHref) {
    return <span>{label}</span>;
  }

  if (
    externalHrefPattern.test(trimmedHref) &&
    !isRichTextMentionHref(trimmedHref)
  ) {
    return (
      <a
        className="font-medium text-[var(--text-primary)] underline decoration-[var(--border-1)] underline-offset-4 hover:text-[var(--text-primary-hover)]"
        href={trimmedHref}
        rel="noreferrer"
        target="_blank"
      >
        {label}
      </a>
    );
  }

  const kind = trimmedHref.endsWith("/") ? "folder" : "file";
  const path = normalizeRichTextLinkHref(trimmedHref, kind);

  return (
    <WorkspaceReferenceReadonly
      reference={{
        kind,
        label,
        path
      }}
      onOpenWorkspaceReference={onOpenWorkspaceReference}
    />
  );
}

function WorkspaceReferenceReadonly({
  reference,
  onOpenWorkspaceReference
}: {
  reference: RichTextReadonlyWorkspaceReference;
  onOpenWorkspaceReference?: (
    reference: RichTextReadonlyWorkspaceReference
  ) => void | Promise<void>;
}): JSX.Element {
  const presentation = getWorkspaceReferencePresentation(
    reference.label,
    reference.path
  );
  const content = (
    <MentionPill
      className={richTextWorkspaceReferencePillClassName}
      fileKind={reference.kind}
      kind="file"
      label={presentation.displayLabel}
      removable={false}
    />
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onOpenWorkspaceReference ? (
          <button
            className="inline-flex max-w-full appearance-none items-baseline bg-transparent p-0 text-inherit"
            type="button"
            onClick={() => {
              void onOpenWorkspaceReference(reference);
            }}
          >
            {content}
          </button>
        ) : (
          <span className="inline-flex max-w-full align-baseline">
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent
        className="max-w-md whitespace-normal break-all"
        sideOffset={8}
      >
        {presentation.fullPath}
      </TooltipContent>
    </Tooltip>
  );
}
