import * as React from "react";

import {
  AgentSessionsIcon,
  AppWindowIcon,
  CloseIcon,
  FileIcon,
  FolderFilledIcon,
  IssueIcon
} from "#icons/system-icons";
import { cn } from "#lib/utils";
import { TruncatingPillLabel } from "./truncating-pill-label";

type MentionPillKind = "app" | "issue" | "session" | "file";
type MentionPillFileKind = "file" | "folder";

const mentionPillTokenByKind: Record<MentionPillKind, string> = {
  app: "var(--rich-text-folder)",
  issue: "var(--rich-text-mention-issue)",
  session: "var(--rich-text-mention-session)",
  file: "var(--folder)"
};

const mentionPillDataKindByKind: Record<MentionPillKind, string> = {
  app: "app",
  issue: "task",
  session: "session",
  file: "file"
};

export interface MentionPillProps extends Omit<
  React.ComponentProps<"span">,
  "children"
> {
  fileKind?: MentionPillFileKind;
  iconUrl?: string | null;
  kind: MentionPillKind;
  label: React.ReactNode;
  removable?: boolean;
  removeButtonProps?: React.ComponentProps<"button">;
  summary?: React.ReactNode;
  withTooltipProvider?: boolean;
}

function MentionPill({
  className,
  fileKind = "file",
  iconUrl,
  kind,
  label,
  removable = kind === "file",
  removeButtonProps,
  style,
  summary,
  withTooltipProvider = true,
  ...props
}: MentionPillProps): React.JSX.Element {
  const isFile = kind === "file";
  const Icon = isFile
    ? fileKind === "folder"
      ? FolderFilledIcon
      : FileIcon
    : kind === "app"
      ? AppWindowIcon
      : kind === "issue"
        ? IssueIcon
        : AgentSessionsIcon;
  const color =
    isFile && fileKind === "folder"
      ? "var(--folder)"
      : mentionPillTokenByKind[kind];
  const dataKind = mentionPillDataKindByKind[kind];
  const normalizedIconUrl = iconUrl?.trim() ?? "";
  const iconSizeClassName = "size-4";
  const iconShellClassName = isFile ? "size-4" : "size-[18px]";

  // 超出最大展示宽度时,标签截断为省略号;溢出时 hover 弹设计系统 Tooltip 看完整文本。
  const tooltipText = [label, summary]
    .filter(
      (part): part is string => typeof part === "string" && part.trim() !== ""
    )
    .join(" ");

  return (
    <span
      className={cn(
        "group relative top-[3px] inline-flex max-w-[min(100%,var(--agent-mention-max-width,16rem))] cursor-default items-center overflow-hidden rounded-[4px] border border-transparent bg-transparent py-0.5 align-baseline text-[13px] font-medium leading-5 no-underline transition-colors hover:border-transparent hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
        isFile ? "gap-1.5 px-1.5" : "gap-1 px-1",
        className
      )}
      data-agent-file-mention="true"
      data-agent-mention-kind={dataKind}
      data-slot="mention-pill"
      style={{
        color,
        ...style
      }}
      {...props}
    >
      <span
        aria-hidden={removable ? undefined : true}
        className={cn(
          "relative grid shrink-0 place-items-center",
          iconShellClassName
        )}
      >
        {normalizedIconUrl ? (
          <img
            src={normalizedIconUrl}
            alt=""
            className={cn(
              "size-full rounded-[3px] object-cover transition-opacity",
              removable && "group-hover:opacity-0 group-focus-within:opacity-0"
            )}
            decoding="async"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <Icon
            className={cn(
              "text-current transition-opacity",
              removable && "group-hover:opacity-0 group-focus-within:opacity-0",
              iconSizeClassName
            )}
          />
        )}
        {removable ? (
          <button
            aria-label={removeButtonProps?.["aria-label"]}
            type="button"
            {...removeButtonProps}
            className={cn(
              "absolute top-1/2 left-1/2 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center text-[var(--text-secondary)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--text-primary)] focus-visible:opacity-100",
              removeButtonProps?.className
            )}
          >
            <CloseIcon className="size-3.5" />
          </button>
        ) : null}
      </span>
      <TruncatingPillLabel
        tooltip={tooltipText}
        withTooltipProvider={withTooltipProvider}
      >
        <span>{label}</span>
        {summary ? <span className="text-current"> {summary}</span> : null}
      </TruncatingPillLabel>
    </span>
  );
}

export { MentionPill };
export type { MentionPillFileKind, MentionPillKind };
