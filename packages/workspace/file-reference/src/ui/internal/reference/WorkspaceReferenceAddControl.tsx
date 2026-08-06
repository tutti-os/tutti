import {
  AddLinedIcon,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FolderOpenLinedIcon,
  UploadIcon
} from "@tutti-os/ui-system";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

export interface WorkspaceReferenceAddControlLabels {
  addContent: string;
  browseReferences: string;
  uploadFile?: string;
}

export interface WorkspaceReferenceAddControlProps {
  className?: string;
  disabled?: boolean;
  labels: WorkspaceReferenceAddControlLabels;
  onBrowseReferences: () => void;
  onUploadFile?: () => void;
}

const AddButton = forwardRef<
  HTMLButtonElement,
  Omit<
    ComponentPropsWithoutRef<typeof Button>,
    "aria-label" | "children" | "size" | "title" | "type" | "variant"
  > & {
    label: string;
  }
>(function AddButton({ label, ...props }, ref) {
  return (
    <Button
      {...props}
      ref={ref}
      aria-label={label}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      <AddLinedIcon aria-hidden="true" className="size-4" />
    </Button>
  );
});

/**
 * Standard workspace-app composer entry for adding referenced content.
 * Upload-capable apps get a two-action menu; other apps open the reference
 * picker directly.
 */
export function WorkspaceReferenceAddControl({
  className,
  disabled,
  labels,
  onBrowseReferences,
  onUploadFile
}: WorkspaceReferenceAddControlProps) {
  if (!onUploadFile) {
    return (
      <AddButton
        className={className}
        disabled={disabled}
        label={labels.addContent}
        onClick={onBrowseReferences}
      />
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <AddButton
          className={className}
          disabled={disabled}
          label={labels.addContent}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="nodrag w-max min-w-40 whitespace-nowrap"
      >
        <DropdownMenuItem onSelect={onUploadFile}>
          <UploadIcon aria-hidden="true" className="size-4" />
          {labels.uploadFile ?? labels.addContent}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onBrowseReferences}>
          <FolderOpenLinedIcon aria-hidden="true" className="size-4" />
          {labels.browseReferences}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
