import type { WorkbenchHostCloseDialogRequest } from "@tutti-os/workbench-surface";
import { ConfirmationDialog } from "@tutti-os/ui-system";

export function WorkspaceCloseGuardDialog({
  request,
  onCancel,
  onConfirm
}: {
  request: WorkbenchHostCloseDialogRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (request === null) {
    return null;
  }

  return (
    <ConfirmationDialog
      cancelLabel={request.cancelLabel}
      confirmLabel={request.confirmLabel}
      description={request.description}
      open={true}
      title={request.title}
      tone={request.variant === "destructive" ? "destructive" : "default"}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
      onConfirm={onConfirm}
    >
      {request.details ? (
        <div className="whitespace-pre-wrap">{request.details}</div>
      ) : null}
    </ConfirmationDialog>
  );
}
