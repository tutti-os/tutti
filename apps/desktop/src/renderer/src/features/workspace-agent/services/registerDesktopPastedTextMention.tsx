import { FileTextIcon } from "@tutti-os/ui-system/icons";
import {
  AGENT_PASTED_TEXT_MENTION_KIND,
  registerAgentCustomMentionKind
} from "@tutti-os/agent-gui/custom-mention";

/**
 * Registers the `pasted-text` custom mention kind so a pasted-text reference in
 * the conversation flow renders as a chip (document icon + first-line preview)
 * instead of raw `[pasted-text-1.txt · N KB]` text. The mention href
 * (`mention://pasted-text/<id>?path=...&size=...`) losslessly carries the landed
 * archive path, so clicking the chip resolves to an open-local-asset-preview
 * (wired in desktopAgentGUILinkActions). Registered once at renderer bootstrap,
 * before the first composer/transcript mounts.
 */
export function registerDesktopPastedTextMention(): void {
  registerAgentCustomMentionKind({
    kind: AGENT_PASTED_TEXT_MENTION_KIND,
    clickable: true,
    present: (mention) => {
      const path = mention.scope?.path?.trim();
      if (!path) {
        return null;
      }
      return {
        name: mention.label,
        ...(mention.scope?.workspaceId?.trim()
          ? { workspaceId: mention.scope.workspaceId.trim() }
          : {})
      };
    },
    // Reuse the exact conversation-flow/queue token markup (tsh-agent-object-token)
    // so the pasted-text chip looks identical everywhere it renders.
    renderChip: ({ name, isEditable, removeAction }) => (
      <span
        className="tsh-agent-object-token tsh-agent-object-token--entity"
        data-agent-pasted-text-chip="true"
      >
        <span
          className="grid h-4 w-4 shrink-0 place-items-center text-[var(--text-tertiary)]"
          aria-hidden="true"
        >
          <FileTextIcon className="size-3.5" />
        </span>
        <span className="tsh-agent-object-token__main">{name}</span>
        {isEditable ? removeAction : null}
      </span>
    )
  });
}
