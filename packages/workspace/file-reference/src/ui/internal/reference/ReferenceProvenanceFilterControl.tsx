import { useMemo, useState } from "react";
import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
  UnderlineTabs
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

interface StructuredAgentOptionLabel {
  agentLabel: string;
  ownerLabel: string;
}

function resolveStructuredAgentOptionLabel(
  option: ReferenceProvenanceOption,
  memberLabelsById: ReadonlyMap<string, string>
): StructuredAgentOptionLabel | null {
  if (!option.parentMemberId) return null;

  const ownerLabel = memberLabelsById.get(option.parentMemberId);
  if (!ownerLabel) return null;

  const prefix = `${ownerLabel} · `;
  if (!option.label.startsWith(prefix)) return null;

  const agentLabel = option.label.slice(prefix.length);
  return agentLabel ? { agentLabel, ownerLabel } : null;
}

function ReferenceProvenanceOptionLabel({
  dimension,
  memberLabelsById,
  option
}: {
  dimension: ReferenceProvenanceDimension;
  memberLabelsById: ReadonlyMap<string, string>;
  option: ReferenceProvenanceOption;
}) {
  const structuredAgentLabel =
    dimension === "agent"
      ? resolveStructuredAgentOptionLabel(option, memberLabelsById)
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
  onReset,
  onToggle,
  onToggleAll
}: ReferenceProvenanceFilterControlProps) {
  const [dimension, setDimension] = useState<ReferenceProvenanceDimension>(
    enabledDimensions[0] ?? "agent"
  );
  const memberLabelsById = useMemo(
    () => new Map(memberOptions.map((option) => [option.id, option.label])),
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
    <div className="flex shrink-0 items-center gap-1.5">
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
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={active ? labels.filteredSources : labels.allSources}
            className="h-7 gap-1.5 border-0 px-2 text-xs"
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
            <div className="pt-2">
              <UnderlineTabs
                ariaLabel={labels.allSources}
                className="px-3"
                preventMouseDownDefault
                tabs={enabledDimensions.map((item) => ({
                  label: item === "agent" ? labels.agents : labels.members,
                  value: item
                }))}
                value={activeDimension}
                onValueChange={setDimension}
              />
            </div>
          ) : null}
          <DropdownMenuGroup className="max-h-72 gap-0 overflow-y-auto p-1">
            <DropdownMenuCheckboxItem
              checked={
                allSelected
                  ? true
                  : selected.length > 0
                    ? "indeterminate"
                    : false
              }
              className="min-h-9 py-2 text-xs"
              onCheckedChange={() => onToggleAll(activeDimension)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="min-w-0 flex-1 truncate">{allLabel}</span>
            </DropdownMenuCheckboxItem>
            {visibleOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={allSelected || selected.includes(option.id)}
                className="min-h-9 py-2 text-xs"
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
                  memberLabelsById={memberLabelsById}
                  option={option}
                />
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
