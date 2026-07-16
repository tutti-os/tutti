import { cloneElement, type HTMLAttributes, type ReactElement } from "react";
import { Star } from "lucide-react";
import {
  CheckIcon,
  DropdownMenuItem,
  RoomsHintIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import { translate } from "../../i18n/index";
import type { ComposerMenuOption } from "./model/composerSettingsMenuModel";
import styles from "./AgentGUINode.styles";

export function ComposerOptionInfoTooltip({
  description,
  tooltipsEnabled = true
}: {
  description: string;
  tooltipsEnabled?: boolean;
}): React.JSX.Element {
  const stopSelect = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const trigger = (
    <span
      className="pointer-events-none inline-flex shrink-0 cursor-help text-[var(--agent-gui-text-tertiary)] opacity-0 transition-opacity group-hover/composer-option:pointer-events-auto group-hover/composer-option:opacity-100 group-data-[highlighted]/composer-option:pointer-events-auto group-data-[highlighted]/composer-option:opacity-100"
      data-agent-composer-option-info-trigger="true"
      onClick={stopSelect}
      onPointerDown={stopSelect}
    >
      <RoomsHintIcon aria-hidden className="size-3" />
    </span>
  );

  if (!tooltipsEnabled) {
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[240px] whitespace-normal">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

export function ComposerMenuOptionItems({
  options,
  selectedValue,
  descriptionPresentation = "none",
  tooltipsEnabled = true,
  favoriteValues,
  onToggleFavorite,
  onSelect
}: {
  options: ComposerMenuOption[];
  selectedValue: string;
  descriptionPresentation?: "inline" | "model-tooltip" | "none" | "tooltip";
  tooltipsEnabled?: boolean;
  /** Values currently favorited; enables the per-option star toggle. */
  favoriteValues?: ReadonlySet<string>;
  onToggleFavorite?: (value: string) => void;
  onSelect: (value: string) => void;
}): React.JSX.Element {
  return (
    <>
      {options.map((option) => {
        const hasDescription = Boolean(option.description);
        const showInlineDescription =
          descriptionPresentation === "inline" && hasDescription;
        const showModelTooltip = descriptionPresentation === "model-tooltip";
        const showTooltipDescription =
          descriptionPresentation === "tooltip" && hasDescription;
        const isFavorite = favoriteValues?.has(option.value) ?? false;
        const favoriteToggle = onToggleFavorite ? (
          <button
            type="button"
            data-agent-model-favorite-toggle="true"
            data-favorited={isFavorite ? "true" : "false"}
            aria-label={translate(
              isFavorite
                ? "agentHost.agentGui.composerModelFavoriteRemove"
                : "agentHost.agentGui.composerModelFavoriteAdd"
            )}
            className={cn(
              "ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--agent-gui-text-tertiary)] transition-opacity hover:text-[var(--text-secondary)]",
              isFavorite
                ? "text-[var(--tutti-purple)] opacity-100 hover:text-[var(--tutti-purple)]"
                : "opacity-0 group-hover/composer-option:opacity-100 group-data-[highlighted]/composer-option:opacity-100"
            )}
            // Stop before the DropdownMenuItem's pointerdown-apply handler:
            // starring an option must not also select it or close the menu.
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFavorite(option.value);
            }}
          >
            <Star
              aria-hidden
              className="size-3.5"
              fill={isFavorite ? "currentColor" : "none"}
              strokeWidth={2}
            />
          </button>
        ) : null;
        const item = (
          <DropdownMenuItem
            key={option.value}
            className={cn(
              styles.composerMenuItem,
              "group/composer-option",
              showModelTooltip &&
                "min-h-[40px] max-w-full items-center px-3 py-2",
              showInlineDescription && "items-start"
            )}
            data-agent-model-option={showModelTooltip ? "true" : undefined}
            onPointerDown={(event) => {
              if (event.button === 0 && !event.ctrlKey) {
                event.preventDefault();
                onSelect(option.value);
              }
            }}
            onSelect={() => {
              onSelect(option.value);
            }}
          >
            {showModelTooltip ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                <span className="min-w-0 truncate leading-[1.15]">
                  {option.label}
                </span>
                {option.summary && option.summary.length > 0 ? (
                  <span className="flex min-w-0 shrink-0 items-baseline gap-1.5 overflow-hidden text-[var(--agent-gui-text-tertiary)]">
                    {option.summary.map((summary) => (
                      <span
                        key={summary}
                        className="max-w-[64px] truncate leading-[1.15]"
                      >
                        {summary}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ) : (
              <span
                className={cn(
                  "flex min-w-0 flex-1 flex-col",
                  showInlineDescription ? "gap-0.5" : "gap-0"
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate leading-[1.15]">
                    {option.label}
                  </span>
                  {showTooltipDescription && option.description ? (
                    <ComposerOptionInfoTooltip
                      description={option.description}
                      tooltipsEnabled={tooltipsEnabled}
                    />
                  ) : null}
                </span>
                {showInlineDescription && option.description ? (
                  <span className="whitespace-normal text-[11px] leading-[1.2] text-[var(--text-tertiary)]">
                    {option.description}
                  </span>
                ) : null}
              </span>
            )}
            {favoriteToggle}
            <CheckIcon
              aria-hidden
              className={cn(
                "ml-2 size-3.5 shrink-0 text-[var(--tutti-purple)]",
                option.value !== selectedValue && "invisible"
              )}
            />
          </DropdownMenuItem>
        );
        return showModelTooltip ? (
          <ComposerModelOptionTooltip
            key={option.value}
            option={option}
            tooltipsEnabled={tooltipsEnabled}
          >
            {item}
          </ComposerModelOptionTooltip>
        ) : (
          item
        );
      })}
    </>
  );
}

function ComposerModelOptionTooltip({
  children,
  option,
  tooltipsEnabled = true
}: {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  option: ComposerMenuOption;
  tooltipsEnabled?: boolean;
}): React.JSX.Element {
  if (!tooltipsEnabled || !option.tooltip) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {cloneElement(children, {
          "data-agent-model-option-tooltip-trigger": "true"
        } as Partial<HTMLAttributes<HTMLElement>> &
          Record<"data-agent-model-option-tooltip-trigger", string>)}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={8}
        className="flex w-[320px] max-w-[calc(100vw-32px)] flex-col items-start gap-0 whitespace-normal rounded-lg border border-[var(--line-2)] bg-[var(--background-fronted)] px-4 py-3 text-[13px] leading-[1.3] text-[var(--text-primary)] shadow-lg"
        data-agent-model-option-tooltip="true"
      >
        <span className="block text-[15px] font-semibold leading-[1.2]">
          {option.tooltip.title}
        </span>
        {option.tooltip.description ? (
          <span className="mt-1.5 block text-[13px] leading-[1.35] text-[var(--text-tertiary)]">
            {option.tooltip.description}
          </span>
        ) : null}
        {option.tooltip.contextWindow ? (
          <span className="mt-4 block">{option.tooltip.contextWindow}</span>
        ) : null}
        {option.tooltip.version ? (
          <span className="mt-4 block italic">{option.tooltip.version}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
