import { useState, type CSSProperties } from "react";
import {
  Button,
  Checkbox,
  ChevronDownIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn
} from "@tutti-os/ui-system";
import type {
  ReferenceProvenanceDimension,
  ReferenceProvenanceFilter,
  ReferenceProvenanceOption
} from "../../../contracts/referenceProvenance.ts";
import {
  referenceProvenanceFilterIds,
  referenceProvenanceFilterIsActive
} from "../../../core/referenceProvenance.ts";

export interface ReferenceProvenanceFilterLabels {
  allAgents: string;
  allMembers: string;
  allSources: string;
  agents: string;
  filteredSources: string;
  members: string;
  reset: string;
}

export interface ReferenceProvenanceFilterControlProps {
  agentOptions: readonly ReferenceProvenanceOption[];
  enabledDimensions: readonly ReferenceProvenanceDimension[];
  labels: ReferenceProvenanceFilterLabels;
  memberOptions: readonly ReferenceProvenanceOption[];
  popoverElevation?: "default" | "panel";
  /** Disabled options stay in the injected catalog but are hidden by default. */
  showDisabledOptions?: boolean;
  value: ReferenceProvenanceFilter;
  onReset: () => void;
  onToggle: (dimension: ReferenceProvenanceDimension, id: string) => void;
  onToggleAll: (dimension: ReferenceProvenanceDimension) => void;
}

export function ReferenceProvenanceFilterControl({
  agentOptions,
  enabledDimensions,
  labels,
  memberOptions,
  popoverElevation = "default",
  showDisabledOptions = false,
  value,
  onReset,
  onToggle,
  onToggleAll
}: ReferenceProvenanceFilterControlProps) {
  const [dimension, setDimension] = useState<ReferenceProvenanceDimension>(
    enabledDimensions[0] ?? "agent"
  );
  const activeDimension = enabledDimensions.includes(dimension)
    ? dimension
    : (enabledDimensions[0] ?? "agent");
  const active = referenceProvenanceFilterIsActive(value);
  const options = activeDimension === "agent" ? agentOptions : memberOptions;
  const visibleOptions = showDisabledOptions
    ? options
    : options.filter((option) => !option.disabled);
  const selected = referenceProvenanceFilterIds(value, activeDimension);
  const allSelected = selected === null;
  const allLabel =
    activeDimension === "agent" ? labels.allAgents : labels.allMembers;

  if (enabledDimensions.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            aria-label={active ? labels.filteredSources : labels.allSources}
            className={cn(
              "h-7 gap-1.5 px-2 text-xs",
              active &&
                "border-[var(--border-focus)] text-[var(--text-primary)]"
            )}
            size="sm"
            type="button"
            variant="outline"
          >
            {active ? labels.filteredSources : labels.allSources}
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3 text-[var(--text-tertiary)]"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="nodrag w-60 p-0"
          style={
            popoverElevation === "panel"
              ? ({ zIndex: "var(--z-panel-popover)" } as CSSProperties)
              : undefined
          }
        >
          {enabledDimensions.length > 1 ? (
            <div
              className="flex border-b border-[var(--line-1)] px-1"
              role="tablist"
            >
              {enabledDimensions.map((item) => (
                <Button
                  key={item}
                  aria-selected={activeDimension === item}
                  className={cn(
                    "flex-1 border-b-2 border-transparent px-2 py-2 text-xs text-[var(--text-secondary)]",
                    activeDimension === item &&
                      "border-[var(--border-focus)] text-[var(--text-primary)]"
                  )}
                  role="tab"
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setDimension(item)}
                >
                  {item === "agent" ? labels.agents : labels.members}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="max-h-72 overflow-y-auto py-1">
            <OptionRow
              checked={
                allSelected
                  ? true
                  : selected.length > 0
                    ? "indeterminate"
                    : false
              }
              label={allLabel}
              onCheckedChange={() => onToggleAll(activeDimension)}
            />
            {visibleOptions.map((option) => (
              <OptionRow
                key={option.id}
                checked={allSelected || selected.includes(option.id)}
                disabled={option.disabled}
                iconUrl={option.iconUrl}
                label={option.label}
                onCheckedChange={() => onToggle(activeDimension, option.id)}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {active ? (
        <Button
          className="h-7 px-2 text-xs"
          size="sm"
          type="button"
          variant="ghost"
          onClick={onReset}
        >
          {labels.reset}
        </Button>
      ) : null}
    </div>
  );
}

function OptionRow({
  checked,
  disabled,
  iconUrl,
  label,
  onCheckedChange
}: {
  checked: boolean | "indeterminate";
  disabled?: boolean;
  iconUrl?: string | null;
  label: string;
  onCheckedChange: () => void;
}) {
  const toggle = () => {
    if (!disabled) onCheckedChange();
  };

  return (
    <div
      aria-checked={checked === "indeterminate" ? "mixed" : checked}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--transparency-hover)]",
        disabled && "cursor-not-allowed opacity-50"
      )}
      role="checkbox"
      tabIndex={disabled ? -1 : 0}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        toggle();
      }}
    >
      <Checkbox
        aria-hidden="true"
        checked={checked}
        className="pointer-events-none"
        disabled={disabled}
        tabIndex={-1}
      />
      {iconUrl ? (
        <img alt="" className="size-5 rounded-md object-cover" src={iconUrl} />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}
