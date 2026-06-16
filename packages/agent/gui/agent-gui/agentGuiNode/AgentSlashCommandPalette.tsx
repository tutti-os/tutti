import { Fragment, useEffect, useRef } from "react";
import type { AgentSessionCommand } from "../../shared/agentSessionTypes";
import { cn } from "../../app/renderer/lib/utils";
import type { AgentGUIProviderSkillOption } from "./model/agentGuiNodeTypes";

export type AgentSlashPaletteEntry =
  | {
      type: "command";
      key: string;
      label: string;
      description?: string;
      command: AgentSessionCommand;
    }
  | {
      type: "skill";
      key: string;
      label: string;
      description?: string;
      skill: AgentGUIProviderSkillOption;
    };

interface AgentSlashCommandPaletteProps {
  entries: readonly AgentSlashPaletteEntry[];
  highlightedIndex: number;
  label: string;
  commandsGroupLabel: string;
  skillsGroupLabel: string;
  onHighlightChange: (index: number) => void;
  onSelect: (command: AgentSessionCommand) => void;
  onSelectSkill: (skill: AgentGUIProviderSkillOption) => void;
}

const paletteStyles = {
  palette:
    "nodrag agent-gui-node__mention-palette flex h-full min-h-0 flex-col gap-1 overflow-y-auto px-1 pb-1 pt-2 [-webkit-app-region:no-drag]",
  option:
    "nodrag relative flex min-h-9 w-full min-w-0 cursor-pointer select-none items-center gap-1.5 overflow-hidden rounded-[6px] border-0 bg-transparent px-2.5 py-2 text-left text-[13px] text-[var(--text-primary)] outline-hidden transition-colors duration-200 [-webkit-app-region:no-drag] focus-visible:outline-none active:bg-[var(--transparency-active)] data-[highlighted]:bg-[var(--transparency-block)] data-[highlighted]:text-[var(--text-primary)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:min-w-0 *:[span]:last:flex-1 *:[span]:last:items-center *:[span]:last:gap-2",
  copy: "flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden leading-[16px]",
  name: "min-w-0 max-w-[48%] shrink-0 truncate text-[11px] font-semibold text-[var(--text-primary)]",
  descriptionText:
    "min-w-0 flex-1 truncate text-[11px] font-normal text-[var(--text-secondary)]",
  groupHeader:
    "select-none px-2.5 pb-0.5 pt-1.5 text-[11px] font-normal text-[var(--text-secondary)]"
};

export function AgentSlashCommandPalette({
  entries,
  highlightedIndex,
  label,
  commandsGroupLabel,
  skillsGroupLabel,
  onHighlightChange,
  onSelect,
  onSelectSkill
}: AgentSlashCommandPaletteProps): React.JSX.Element | null {
  "use memo";
  const highlightedOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    highlightedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  if (entries.length === 0) {
    return null;
  }
  // Headers render only when both sections are present; they are plain
  // separators outside the option list, so keyboard navigation indices are
  // untouched.
  const showGroupHeaders =
    entries.some((entry) => entry.type === "command") &&
    entries.some((entry) => entry.type === "skill");
  const firstSkillIndex = entries.findIndex((entry) => entry.type === "skill");
  return (
    <div className={paletteStyles.palette} role="listbox" aria-label={label}>
      {entries.map((entry, index) => {
        const isHighlighted = index === highlightedIndex;
        const groupHeader = !showGroupHeaders ? null : index === 0 &&
          entry.type === "command" ? (
          <div aria-hidden="true" className={paletteStyles.groupHeader}>
            {commandsGroupLabel}
          </div>
        ) : index === firstSkillIndex ? (
          <div aria-hidden="true" className={paletteStyles.groupHeader}>
            {skillsGroupLabel}
          </div>
        ) : null;
        return (
          <Fragment key={entry.key}>
            {groupHeader}
            <button
              ref={isHighlighted ? highlightedOptionRef : null}
              type="button"
              className={cn(
                paletteStyles.option,
                isHighlighted && "bg-[var(--transparency-block)]"
              )}
              role="option"
              aria-selected={isHighlighted}
              data-highlighted={isHighlighted ? "" : undefined}
              onMouseEnter={() => onHighlightChange(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                entry.type === "command"
                  ? onSelect(entry.command)
                  : onSelectSkill(entry.skill)
              }
            >
              <span className={paletteStyles.copy}>
                <span className={paletteStyles.name}>{entry.label}</span>
                {entry.description ? (
                  <span className={paletteStyles.descriptionText}>
                    {entry.description}
                  </span>
                ) : null}
              </span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
