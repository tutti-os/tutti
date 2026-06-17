import type { JSX, MouseEvent } from "react";
import { FileIcon, FolderFilledIcon } from "@tutti-os/ui-system/icons";

type RichTextTriggerMenuItemProps = {
  iconUrl?: string;
  label: string;
  selected: boolean;
  subtitle?: string;
  workspaceReferenceFileKind?: "file" | "folder";
  onSelect: () => void;
};

export function RichTextTriggerMenuItem({
  iconUrl,
  label,
  selected,
  subtitle,
  workspaceReferenceFileKind,
  onSelect
}: RichTextTriggerMenuItemProps): JSX.Element {
  return (
    <button
      aria-selected={selected}
      className={[
        "flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[var(--text-primary)] outline-0 transition-colors duration-100",
        selected ? "bg-[var(--transparency-block)]" : "",
        "hover:bg-[var(--transparency-block)]"
      ].join(" ")}
      type="button"
      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <RichTextTriggerMenuIcon
        iconUrl={iconUrl}
        workspaceReferenceFileKind={workspaceReferenceFileKind}
      />
      <span className="flex min-w-0 flex-auto flex-col items-start gap-0.5">
        <span className="w-full overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-5 font-semibold">
          {label}
        </span>
        {subtitle ? (
          <span className="w-full overflow-hidden text-ellipsis whitespace-nowrap text-[11px] leading-4 text-[var(--text-secondary)]">
            {subtitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function RichTextTriggerMenuIcon({
  iconUrl,
  workspaceReferenceFileKind
}: {
  iconUrl?: string;
  workspaceReferenceFileKind?: "file" | "folder";
}): JSX.Element {
  const normalizedIconUrl = iconUrl?.trim() ?? "";

  if (workspaceReferenceFileKind) {
    const Icon =
      workspaceReferenceFileKind === "folder" ? FolderFilledIcon : FileIcon;
    return (
      <span
        aria-hidden="true"
        className="inline-grid size-4 flex-none place-items-center text-[var(--folder)]"
        data-rich-text-trigger-icon="true"
      >
        <Icon className="size-4" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="inline-grid size-4 flex-none place-items-center overflow-hidden rounded bg-[var(--bg-block,var(--transparency-block))]"
      data-rich-text-trigger-icon="true"
    >
      {normalizedIconUrl ? (
        <img
          alt=""
          className="block size-full object-cover object-center"
          decoding="async"
          draggable={false}
          loading="lazy"
          src={normalizedIconUrl}
        />
      ) : (
        <span className="block size-3 rounded-[3px] bg-[var(--transparency-block)]" />
      )}
    </span>
  );
}
