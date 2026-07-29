import { createDecorator } from "@tutti-os/infra/di";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectDefaultSelection,
  WorkspaceUserProjectMoveInput,
  WorkspaceUserProjectPinInput,
  WorkspaceUserProjectPathCheck,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectServiceSnapshot,
  WorkspaceUserProjectValtioStore
} from "@tutti-os/workspace-user-project/contracts";

export interface IWorkspaceUserProjectService {
  readonly _serviceBrand: undefined;
  readonly store: WorkspaceUserProjectValtioStore;

  checkProjectPath(path: string): Promise<WorkspaceUserProjectPathCheck>;
  createProject(name: string): Promise<WorkspaceUserProject>;
  ensureLoaded(): Promise<void>;
  getDefaultSelection(): Promise<WorkspaceUserProjectDefaultSelection | null>;
  getRevision(): number;
  getSnapshot(): WorkspaceUserProjectServiceSnapshot;
  isNoProjectPath(path: string): boolean;
  moveProject(input: WorkspaceUserProjectMoveInput): Promise<void>;
  pinProject(input: WorkspaceUserProjectPinInput): Promise<void>;
  rememberNoProjectPath(path: string | null | undefined): void;
  prepareSelection(
    input: WorkspaceUserProjectSelectionPreparationInput
  ): Promise<WorkspaceUserProjectSelectionPreparation>;
  refresh(): Promise<void>;
  registerProjectPath(path: string): Promise<WorkspaceUserProject>;
  removeProjectPath(path: string): Promise<void>;
  rememberDefaultSelection(input: { path: string | null }): Promise<void>;
  selectDirectory(): Promise<{ path: string } | null>;
  subscribe(listener: () => void): () => void;
}

export const IWorkspaceUserProjectService =
  createDecorator<IWorkspaceUserProjectService>(
    "workspace-user-project-service"
  );
