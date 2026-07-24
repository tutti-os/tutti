import type { ReactNode } from "react";
import { Button } from "@tutti-os/ui-system";
import type { AgentToolPanelDefinition, AgentToolPanelId } from "./model.ts";
import { AgentToolPanelIcon } from "./Toolbar.tsx";

export function AgentToolSidebarPicker({
  panels,
  onSelect
}: {
  panels: readonly AgentToolPanelDefinition[];
  onSelect: (panel: AgentToolPanelId) => void;
}): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center overflow-auto px-6 py-10"
      data-agent-tool-sidebar-picker="true"
    >
      <div className="flex w-full max-w-[340px] flex-col gap-2">
        {panels.map((panel) => (
          <Button
            className="h-12 w-full justify-start gap-2.5 rounded-lg border border-[var(--line-1)] bg-[var(--background-fronted)] px-2.5 text-left text-[14px] font-medium text-[var(--text-primary)] shadow-none hover:border-[var(--line-2)] hover:bg-[var(--transparency-hover)]"
            key={panel.id}
            type="button"
            variant="ghost"
            onClick={() => onSelect(panel.id)}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-[var(--transparency-block)] text-[var(--text-secondary)] group-hover/button:text-[var(--text-primary)]">
              <AgentToolPanelIcon
                aria-hidden
                className="size-4"
                panel={panel.id}
              />
            </span>
            <span>{panel.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
