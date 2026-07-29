import * as React from "react";

import { CheckIcon, ChevronDownIcon } from "#icons/system-icons";
import { cn } from "#lib/utils";
import { Input } from "../input";
import { menuItemIndicatorClassName } from "../menu-surface";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

interface ComboboxOption {
  description?: string;
  disabled?: boolean;
  /** Extra strings the search filter matches beyond value and label. */
  keywords?: readonly string[];
  label: string;
  value: string;
}

interface ComboboxProps {
  align?: "center" | "end" | "start";
  /**
   * Offer the typed query as a selectable value when it matches no option.
   * The caller localizes the row through customValueLabel.
   */
  allowCustomValue?: boolean;
  "aria-label"?: string;
  className?: string;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  customValueLabel?: (query: string) => React.ReactNode;
  disabled?: boolean;
  emptyMessage?: React.ReactNode;
  onValueChange: (value: string) => void;
  options: readonly ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  value: string;
}

const comboboxItemClassName =
  "relative flex w-full cursor-pointer scroll-my-1 flex-col items-start gap-0.5 rounded-sm px-2 py-1 pr-8 text-left text-[13px] text-[var(--text-primary)] outline-hidden transition-colors duration-200 select-none data-[active=true]:bg-[var(--transparency-hover)] data-disabled:pointer-events-none data-disabled:text-[var(--text-disabled)]";

function comboboxOptionMatches(option: ComboboxOption, query: string): boolean {
  if (!query) {
    return true;
  }
  return [option.label, option.value, ...(option.keywords ?? [])].some(
    (candidate) => candidate.toLocaleLowerCase().includes(query)
  );
}

/**
 * Searchable single-value picker composed from Popover and Input. Unlike
 * Select, the open surface is query-driven with a fixed-height option list,
 * and it can accept a typed value that is not in the option catalog.
 */
function Combobox({
  align = "start",
  allowCustomValue = false,
  "aria-label": ariaLabel,
  className,
  contentClassName,
  contentStyle,
  customValueLabel,
  disabled = false,
  emptyMessage,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  value
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listboxID = React.useId();

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = options.filter((option) =>
    comboboxOptionMatches(option, normalizedQuery)
  );
  const customValue =
    allowCustomValue &&
    query.trim() &&
    !options.some((option) => option.value === query.trim())
      ? query.trim()
      : null;
  const rows: ComboboxOption[] = customValue
    ? [...visibleOptions, { label: customValue, value: customValue }]
    : visibleOptions;
  const clampedActiveIndex = Math.min(
    activeIndex,
    Math.max(rows.length - 1, 0)
  );
  const selectedOption = options.find((option) => option.value === value);
  const triggerLabel = selectedOption?.label ?? value;

  const commit = (row: ComboboxOption) => {
    if (row.disabled) {
      return;
    }
    onValueChange(row.value);
    setOpen(false);
  };

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setQuery("");
    setActiveIndex(0);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) {
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((rows.length + clampedActiveIndex + delta) % rows.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : Math.max(rows.length - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[clampedActiveIndex];
      if (row) {
        commit(row);
      }
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          aria-label={ariaLabel}
          className={cn(
            "flex h-8 w-full min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded-lg border border-transparent bg-[var(--transparency-block)] py-2 pr-2 pl-2.5 text-[13px] text-[var(--text-primary)] transition-colors outline-none select-none hover:bg-[var(--transparency-hover)] focus:bg-[var(--transparency-hover)] focus-visible:bg-[var(--transparency-hover)] disabled:cursor-not-allowed disabled:bg-[var(--transparency-block)] disabled:text-[var(--text-disabled)]",
            "[&[data-state=open]>svg]:rotate-180 [&>svg]:transition-transform [&>svg]:duration-200",
            className
          )}
          data-slot="combobox-trigger"
          disabled={disabled}
          type="button"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              !triggerLabel && "text-[var(--text-placeholder)]"
            )}
          >
            {triggerLabel || placeholder}
          </span>
          <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-current" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn(
          "w-[var(--radix-popover-trigger-width)] min-w-44 gap-0 p-1",
          contentClassName
        )}
        data-slot="combobox-content"
        style={contentStyle}
        onOpenAutoFocus={(event) => {
          // Focus lands on the search input instead of the surface.
          event.preventDefault();
        }}
      >
        <Input
          aria-activedescendant={
            rows[clampedActiveIndex]
              ? `${listboxID}-${clampedActiveIndex}`
              : undefined
          }
          aria-autocomplete="list"
          aria-controls={listboxID}
          aria-expanded
          autoFocus
          className="shrink-0"
          data-slot="combobox-search"
          placeholder={searchPlaceholder}
          // The search input is the ARIA combobox: it owns the listbox,
          // autocomplete, and active-descendant wiring. The closed trigger
          // stays a plain popover button so the role is never duplicated.
          role="combobox"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveIndex(0);
          }}
          onKeyDown={onSearchKeyDown}
        />
        <div
          className="mt-1 flex max-h-56 flex-col gap-0.5 overflow-y-auto overscroll-contain"
          data-slot="combobox-listbox"
          id={listboxID}
          role="listbox"
        >
          {rows.length === 0 ? (
            <span className="px-2 py-1.5 text-[12px] text-[var(--text-tertiary)]">
              {emptyMessage}
            </span>
          ) : (
            rows.map((row, index) => {
              const isCustomRow =
                customValue !== null && index === rows.length - 1;
              return (
                <button
                  key={`${row.value}:${isCustomRow ? "custom" : "option"}`}
                  aria-selected={row.value === value}
                  className={comboboxItemClassName}
                  data-active={index === clampedActiveIndex}
                  data-disabled={row.disabled ? "" : undefined}
                  data-slot="combobox-item"
                  id={`${listboxID}-${index}`}
                  role="option"
                  tabIndex={-1}
                  type="button"
                  onClick={() => commit(row)}
                  onPointerMove={() => setActiveIndex(index)}
                >
                  <span className="w-full truncate pr-2">
                    {isCustomRow
                      ? (customValueLabel?.(row.value) ?? row.label)
                      : row.label}
                  </span>
                  {row.description ? (
                    <span className="w-full truncate pr-2 text-[11px] text-[var(--text-tertiary)]">
                      {row.description}
                    </span>
                  ) : null}
                  {row.value === value ? (
                    <span className={menuItemIndicatorClassName}>
                      <CheckIcon className="pointer-events-none" />
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox, type ComboboxOption };
