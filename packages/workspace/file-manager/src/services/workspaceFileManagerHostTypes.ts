import type {
  WorkspaceFileActivationTarget,
  WorkspaceFileEntry
} from "./workspaceFileManagerTypes.ts";

export interface WorkspaceFileManagerFileActivationRequest {
  entry: WorkspaceFileEntry;
  target: WorkspaceFileActivationTarget | null;
}

export type WorkspaceFileManagerHostFallbackActionKind =
  | "download"
  | "none"
  | "open";

export type WorkspaceFileManagerHostFallbackAction =
  | {
      kind: "download" | "open";
      label?: string | null;
      onSelect: () => Promise<WorkspaceFileManagerHostFileActivationResult | void>;
    }
  | {
      kind: "none";
      label?: string | null;
    };

export type WorkspaceFileManagerHostFileActivationResult =
  | {
      disposition: "handled";
    }
  | {
      actions?: WorkspaceFileManagerHostFallbackAction[] | null;
      disposition: "fallback" | "unsupported";
      message?: string | null;
      title?: string | null;
    };
