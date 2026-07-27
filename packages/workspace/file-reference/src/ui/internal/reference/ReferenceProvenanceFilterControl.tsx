import { useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
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
  const [dimension, setDimension] = useState<ReferenceProvenanceDimension>(
    enabledDimensions[0] ?? "agent"
  );
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

  if (enabledDimensions.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={active ? labels.filteredSources : labels.allSources}
            className="h-7 gap-1.5 border-0 px-2 text-xs hover:bg-transparent aria-expanded:bg-transparent"
            size="sm"
            type="button"
            variant="ghost"
          >
            {active ? labels.filteredSources : labels.allSources}
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3 text-[var(--text-tertiary)] transition-transform in-data-[state=open]:rotate-180"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="nodrag w-60 overflow-hidden p-0"
          style={
            popoverElevation === "panel"
              ? { zIndex: "var(--z-panel-popover)" }
              : undefined
          }
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
          <DropdownMenuGroup className="max-h-72 gap-0.5 overflow-y-auto p-1">
            <DropdownMenuCheckboxItem
              checked={
                allSelected
                  ? true
                  : selected.length > 0
                    ? "indeterminate"
                    : false
              }
              className="min-h-7 rounded-md py-1 pr-2 text-xs [&_[data-slot='dropdown-menu-checkbox-item-indicator']]:hidden"
              onCheckedChange={() => onToggleAll(activeDimension)}
              onSelect={(event) => event.preventDefault()}
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
            </DropdownMenuCheckboxItem>
            {visibleOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={allSelected || selected.includes(option.id)}
                className="min-h-7 rounded-md py-1 pr-2 text-xs [&_[data-slot='dropdown-menu-checkbox-item-indicator']]:hidden"
                disabled={option.disabled}
                onCheckedChange={() => onToggle(activeDimension, option.id)}
                onSelect={(event) => event.preventDefault()}
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
                  tabIndex={-1}
                />
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
