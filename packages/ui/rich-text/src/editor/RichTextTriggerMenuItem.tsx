import type { JSX, MouseEvent } from "react";

type RichTextTriggerMenuItemProps = {
  label: string;
  selected: boolean;
  subtitle?: string;
  thumbnailUrl?: string;
  onSelect: () => void;
};

export function RichTextTriggerMenuItem({
  label,
  selected,
  subtitle,
  thumbnailUrl,
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
      <RichTextTriggerMenuThumbnail thumbnailUrl={thumbnailUrl} />
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

function RichTextTriggerMenuThumbnail({
  thumbnailUrl
}: {
  thumbnailUrl?: string;
}): JSX.Element {
  const normalizedThumbnailUrl = thumbnailUrl?.trim() ?? "";

  return (
    <span
      aria-hidden="true"
      className="inline-grid size-4 flex-none place-items-center overflow-hidden rounded bg-[var(--bg-block,var(--transparency-block))]"
      data-rich-text-trigger-thumbnail="true"
    >
      {normalizedThumbnailUrl ? (
        <img
          alt=""
          className="block size-full object-cover object-center"
          decoding="async"
          draggable={false}
          loading="lazy"
          src={normalizedThumbnailUrl}
        />
      ) : (
        <span className="block size-3 rounded-[3px] bg-[var(--transparency-block)]" />
      )}
    </span>
  );
}
