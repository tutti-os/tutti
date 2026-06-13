import { useEffect, useRef, useState, type JSX } from "react";
import { RichTextReadonlyContent } from "@tutti-os/ui-rich-text/editor";
import { cn } from "@tutti-os/ui-system";
import { normalizeIssueManagerContent } from "../../../core/index.ts";
import type { IssueManagerFileReference } from "../../../contracts/index.ts";
import { stripIssueManagerDescriptionTerminalPunctuation } from "../panel/IssueManagerPanelText.ts";

export function IssueManagerDescriptionSection({
  content,
  emptyLabel,
  label,
  minHeightClass = "min-h-[14rem]",
  onOpen,
  variant = "card"
}: {
  content: string;
  emptyLabel: string;
  label: string;
  minHeightClass?: string;
  onOpen?: (reference: IssueManagerFileReference) => Promise<void>;
  variant?: "card" | "plain";
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const normalizedContent = normalizeIssueManagerContent(content).trim();
  const displayContent =
    stripIssueManagerDescriptionTerminalPunctuation(normalizedContent);

  useEffect(() => {
    if (variant === "plain") {
      setIsOverflowing(false);
      return;
    }
    if (!displayContent) {
      setIsOverflowing(false);
      return;
    }

    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    const measure = () => {
      setIsOverflowing(
        contentElement.scrollHeight > contentElement.clientHeight + 1
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(contentElement);
    return () => {
      observer.disconnect();
    };
  }, [displayContent, variant]);

  if (variant === "plain") {
    return (
      <section className="grid gap-2">
        <span className="text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
          {label}
        </span>
        {displayContent ? (
          <div className="min-w-0 max-w-full text-[13px] font-normal leading-5 text-[var(--text-secondary)] sm:max-w-3xl">
            <IssueManagerDescriptionContent
              content={displayContent}
              onOpen={onOpen}
            />
          </div>
        ) : (
          <p className="text-[13px] font-normal leading-5 text-[var(--text-secondary)]">
            {emptyLabel}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="grid gap-2">
      <span className="text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
        {label}
      </span>
      <div
        className={cn(
          "relative min-w-0 rounded-lg border border-border-1 bg-transparent px-4 py-3",
          minHeightClass
        )}
      >
        <div
          className={cn(
            "min-w-0 max-w-full overflow-x-hidden max-h-[18rem] overflow-y-auto pr-2 text-[13px] font-normal leading-5 text-[var(--text-secondary)]",
            isOverflowing && "pb-8"
          )}
          ref={contentRef}
        >
          {displayContent ? (
            <IssueManagerDescriptionContent
              content={displayContent}
              onOpen={onOpen}
            />
          ) : (
            <p className="font-normal text-[var(--text-secondary)]">
              {emptyLabel}
            </p>
          )}
        </div>
        {isOverflowing ? (
          <div
            className="pointer-events-none absolute right-0 bottom-1 left-0 h-10"
            style={{
              background:
                "linear-gradient(to top, var(--background-panel), color-mix(in srgb, var(--background-panel) 80%, transparent), transparent)"
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function IssueManagerDescriptionContent({
  content,
  onOpen
}: {
  content: string;
  onOpen?: (reference: IssueManagerFileReference) => Promise<void>;
}): JSX.Element {
  return (
    <RichTextReadonlyContent
      className="min-w-0 max-w-full [overflow-wrap:anywhere]"
      paragraphClassName="break-words [overflow-wrap:anywhere]"
      value={content}
      onOpenWorkspaceReference={
        onOpen
          ? (reference) =>
              onOpen({
                displayName: reference.label,
                kind: reference.kind,
                path: reference.path
              })
          : undefined
      }
    />
  );
}
