import { Badge } from "@tutti-os/ui-system";
import { InspectIcon } from "@tutti-os/ui-system/icons";
import { registerAgentCustomMentionKind } from "../../custom-mention";
import {
  browserElementMentionKind,
  presentBrowserElementMention
} from "./browserElementMention";

/** Registers browser DOM references before the first AgentGUI surface mounts. */
export function registerBrowserElementMention(): void {
  registerAgentCustomMentionKind({
    kind: browserElementMentionKind,
    materializePromptText: (mention) => {
      const context = mention.scope?.context?.trim();
      return context ? `\n${context}\n` : null;
    },
    present: presentBrowserElementMention,
    renderChip: ({ name }) => (
      <Badge
        className="h-5 max-w-full gap-1.5 rounded-[6px] px-2 py-0 font-[var(--font-mono)] text-[13px] font-semibold leading-5"
        data-agent-browser-element-chip="true"
        variant="accent"
      >
        <InspectIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </Badge>
    )
  });
}
