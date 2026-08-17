import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  ChevronDownIcon,
  SegmentBar
} from "@tutti-os/ui-system";
import type {
  ReferenceProvenanceDimension,
  ReferenceProvenanceFilter,
  ReferenceProvenanceOption
} from "../../../contracts/referenceProvenance.ts";
import {
  referenceProvenanceFilterIds,
  referenceProvenanceFilterIsActive,
  resolveReferenceProvenanceAgentLabelParts
} from "../../../core/referenceProvenance.ts";

export interface ReferenceProvenanceFilterLabels {
  allAgents: string;
  allMembers: string;
  allSources: string;
  agents: string;
  filteredSources: string;
  members: string;
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
  onToggle: (dimension: ReferenceProvenanceDimension, id: string) => void;
  onToggleAll: (dimension: ReferenceProvenanceDimension) => void;
}

function ReferenceProvenanceOptionLabel({
  dimension,
  memberOptionsById,
  option
}: {
  dimension: ReferenceProvenanceDimension;
  memberOptionsById: ReadonlyMap<string, ReferenceProvenanceOption>;
  option: ReferenceProvenanceOption;
}) {
  const structuredAgentLabel =
    dimension === "agent"
      ? resolveReferenceProvenanceAgentLabelParts(option, memberOptionsById)
      : null;

  return (
    <span
      className="flex min-w-0 flex-1 items-baseline"
      data-slot="reference-provenance-option-label"
      title={option.label}
    >
      {structuredAgentLabel ? (
        <>
          <span
            className="min-w-0 shrink truncate"
            data-slot="reference-provenance-option-owner"
          >
            {structuredAgentLabel.ownerLabel}
          </span>
          <span
            className="shrink-0 whitespace-pre"
            data-slot="reference-provenance-option-agent"
          >
            {` · ${structuredAgentLabel.agentLabel}`}
          </span>
        </>
      ) : (
        <span
          className="block min-w-0 flex-1 truncate"
          data-slot="reference-provenance-option-text"
        >
          {option.label}
        </span>
      )}
    </span>
  );
}

function ReferenceProvenanceFilterMenuItem({
  checked,
  children,
  disabled = false,
  onToggle
}: {
  checked: boolean | "indeterminate";
  children: React.ReactNode;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const handleToggle = () => {
    if (!disabled) onToggle();
  };

  return (
    <div
      aria-checked={checked === "indeterminate" ? "mixed" : checked}
      aria-disabled={disabled || undefined}
      className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md py-1 pr-2 text-left text-xs text-[var(--text-primary)] outline-none hover:bg-[var(--transparency-hover)] focus-visible:bg-[var(--transparency-hover)] data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50"
      data-disabled={disabled || undefined}
      role="menuitemcheckbox"
      tabIndex={disabled ? -1 : 0}
      onClick={handleToggle}
      onKeyDown={(event) => {
        if (disabled || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        event.preventDefault();
        handleToggle();
      }}
    >
      {children}
    </div>
  );
}

export function ReferenceProvenanceFilterControl({
  agentOptions,
  enabledDimensions,
  labels,
  memberOptions,
  popoverElevation = "default",
  showDisabledOptions = false,
  value,
  onToggle,
  onToggleAll
}: ReferenceProvenanceFilterControlProps) {
  const [open, setOpen] = useState(false);
  const [dimension, setDimension] = useState<ReferenceProvenanceDimension>(
    enabledDimensions[0] ?? "agent"
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const memberOptionsById = useMemo(
    () => new Map(memberOptions.map((option) => [option.id, option])),
    [memberOptions]
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

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        !containerRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (enabledDimensions.length === 0) return null;

  return (
    <div ref={containerRef} className="relative flex shrink-0 items-center">
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={active ? labels.filteredSources : labels.allSources}
        className="h-7 gap-1.5 border-0 px-2 text-xs hover:bg-transparent aria-expanded:bg-transparent"
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => setOpen((current) => !current)}
        onPointerDown={(event) => event.preventDefault()}
      >
        {active ? labels.filteredSources : labels.allSources}
        <ChevronDownIcon
          aria-hidden="true"
          className={`size-3 text-[var(--text-tertiary)] transition-transform${open ? " rotate-180" : ""}`}
        />
      </Button>
      {open ? (
        <div
          aria-label={labels.allSources}
          className="nodrag absolute top-[calc(100%+4px)] right-0 z-50 w-60 overflow-hidden rounded-[8px] border border-[var(--line-1)] bg-[var(--background-fronted)] p-0 shadow-soft"
          role="menu"
          style={{
            zIndex:
              popoverElevation === "panel"
                ? "var(--z-panel-popover)"
                : "var(--z-popover)"
          }}
          onPointerDown={(event) => event.preventDefault()}
        >
          {enabledDimensions.length > 1 ? (
            <div className="px-1 pt-1">
              <SegmentBar
                ariaLabel={labels.allSources}
                className="w-full rounded-[6px] [&_[data-slot='segment-bar-indicator']]:rounded-[4px] [&_[data-slot='segment-bar-segment']]:flex-1 [&_[data-slot='segment-bar-segment']]:rounded-[6px]"
                segments={enabledDimensions.map((item) => ({
                  label: item === "agent" ? labels.agents : labels.members,
                  value: item
                }))}
                value={activeDimension}
                onValueChange={setDimension}
              />
            </div>
          ) : null}
          <div className="max-h-72 overflow-y-auto p-1">
            <ReferenceProvenanceFilterMenuItem
              checked={
                allSelected
                  ? true
                  : selected.length > 0
                    ? "indeterminate"
                    : false
              }
              onToggle={() => onToggleAll(activeDimension)}
            >
              <span className="min-w-0 flex-1 truncate">{allLabel}</span>
              <Checkbox
                aria-hidden="true"
                checked={
                  allSelected
                    ? true
                    : selected.length > 0
                      ? "indeterminate"
                      : false
                }
                className="pointer-events-none size-4 data-[state=checked]:border-[var(--tutti-purple)] data-[state=checked]:bg-[var(--tutti-purple)] data-[state=indeterminate]:border-[var(--tutti-purple)] data-[state=indeterminate]:bg-[var(--tutti-purple)] [&_[data-slot='checkbox-indicator']>svg]:size-2.5"
                tabIndex={-1}
              />
            </ReferenceProvenanceFilterMenuItem>
            {visibleOptions.map((option) => (
              <ReferenceProvenanceFilterMenuItem
                key={option.id}
                checked={allSelected || selected.includes(option.id)}
                disabled={option.disabled}
                onToggle={() => onToggle(activeDimension, option.id)}
              >
                {option.iconUrl ? (
                  <img
                    alt=""
                    className="size-5 rounded-md object-cover"
                    src={option.iconUrl}
                  />
                ) : null}
                <ReferenceProvenanceOptionLabel
                  dimension={activeDimension}
                  memberOptionsById={memberOptionsById}
                  option={option}
                />
                <Checkbox
                  aria-hidden="true"
                  checked={allSelected || selected.includes(option.id)}
                  className="pointer-events-none size-4 data-[state=checked]:border-[var(--tutti-purple)] data-[state=checked]:bg-[var(--tutti-purple)] [&_[data-slot='checkbox-indicator']>svg]:size-2.5"
                  disabled={option.disabled}
                  tabIndex={-1}
                />
              </ReferenceProvenanceFilterMenuItem>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
