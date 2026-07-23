export const workbenchSnapshotSchemaVersion = 1 as const;

export type WorkbenchSnapshotSchemaVersion =
  typeof workbenchSnapshotSchemaVersion;

export interface WorkbenchSnapshotV1 {
  schemaVersion: WorkbenchSnapshotSchemaVersion;
  nodes: WorkbenchSnapshotNodeV1[];
  nodeStack?: string[];
  activeNodeId?: string | null;
  spaces?: WorkbenchSnapshotSpaceV1[];
  activeSpaceId?: string | null;
  layoutBasis?: WorkbenchSnapshotLayoutBasisV1;
  metadata?: Record<string, unknown>;
}

export interface WorkbenchFrameV1 {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkbenchSnapshotSizeV1 {
  width: number;
  height: number;
}

export interface WorkbenchSnapshotSafeAreaV1 {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface WorkbenchSnapshotLayoutConstraintsV1 {
  minWidth: number;
  minHeight: number;
  surfacePadding: number;
  safeArea: WorkbenchSnapshotSafeAreaV1;
}

export interface WorkbenchSnapshotLayoutBasisV1 {
  surfaceSize: WorkbenchSnapshotSizeV1;
  layoutConstraints: WorkbenchSnapshotLayoutConstraintsV1;
}

export interface WorkbenchSnapshotNodeV1 {
  id: string;
  kind: string;
  title: string;
  frame: WorkbenchFrameV1;
  displayMode?: WorkbenchSnapshotDisplayModeV1;
  restoreFrame?: WorkbenchFrameV1 | null;
  isMinimized?: boolean;
  minimizedAtUnixMs?: number | null;
  data?: unknown;
  adapterState?: WorkbenchSnapshotNodeAdapterStateV1;
}

export type WorkbenchSnapshotDisplayModeV1 = "floating" | "fullscreen";

export interface WorkbenchSnapshotNodeAdapterStateV1 {
  [key: string]: unknown;
}

export interface WorkbenchSnapshotSpaceV1 {
  id: string;
  name: string;
  nodeIds: string[];
  frame?: WorkbenchFrameV1 | null;
  data?: unknown;
}

export type WorkbenchSnapshot = WorkbenchSnapshotV1;
export type WorkbenchSnapshotNode = WorkbenchSnapshotNodeV1;
export type WorkbenchFrame = WorkbenchFrameV1;
