import { ThinkingIcon } from "@tutti-os/ui-system/icons";
import { registerAgentCustomMentionKind } from "@tutti-os/agent-gui";

/**
 * Registers the `workspace-model` custom mention kind so an @-mentioned model
 * from a workspace model access plan renders as a chip (model name + plan
 * name) instead of a raw link. The mention href
 * (`mention://workspace-model/<modelId>?modelPlanId=...&workspaceId=...`)
 * carries the exact plan/model pair; the daemon runtime policy routes it to
 * `tutti agent consult`, so the chip itself is not clickable. Registered once
 * at renderer bootstrap, before the first composer/transcript mounts.
 */
export function registerDesktopModelMention(): void {
  registerAgentCustomMentionKind({
    kind: "workspace-model",
    present: (mention) => {
      const modelPlanId = mention.scope?.modelPlanId?.trim();
      if (!modelPlanId) {
        return null;
      }
      return {
        name: mention.label,
        ...(mention.scope?.workspaceId?.trim()
          ? { workspaceId: mention.scope.workspaceId.trim() }
          : {})
      };
    },
    renderChip: ({ name, isEditable, removeAction }) => (
      <span
        className="tsh-agent-object-token tsh-agent-object-token--entity"
        data-agent-workspace-model-chip="true"
      >
        <span
          className="grid h-4 w-4 shrink-0 place-items-center text-[var(--text-tertiary)]"
          aria-hidden="true"
        >
          <ThinkingIcon className="size-3.5" />
        </span>
        <span className="tsh-agent-object-token__main">{name}</span>
        {isEditable ? removeAction : null}
      </span>
    )
  });
}
