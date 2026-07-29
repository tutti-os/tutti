import type { ReactElement } from "react";

import { Button, cn } from "@tutti-os/ui-system";

import type { WorkspaceFileManagerPreviewAction } from "./workspaceFileManagerPreviewActionTypes.ts";

export function WorkspaceFileManagerPreviewActionBar({
  actions,
  className,
  label
}: {
  actions: readonly WorkspaceFileManagerPreviewAction[];
  className?: string;
  label: string;
}): ReactElement | null {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={label}
      className={cn("flex flex-none items-center gap-1", className)}
      role="group"
    >
      {actions.map((action) => (
        <Button
          aria-label={action.label}
          className="size-7 min-w-7 rounded-sm p-0 text-[var(--text-primary)]"
          data-testid={`workspace-file-manager-preview-action-${action.id}`}
          disabled={action.disabled}
          key={action.id}
          size="icon-sm"
          title={action.label}
          type="button"
          variant="ghost"
          onClick={action.onSelect}
        >
          {action.icon}
        </Button>
      ))}
    </div>
  );
}
