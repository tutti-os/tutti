import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  createDesktopWorkspaceWorkbenchRepository,
  type DesktopWorkspaceWorkbenchRepository
} from "./internal/adapters/desktopWorkspaceWorkbenchRepository.ts";
import { resolveWorkspaceWorkbenchSnapshotPersistence } from "./workspaceWorkbenchSnapshotPersistence.ts";

export function createWorkspaceWorkbenchSnapshotRepository(input: {
  tuttidClient: TuttidClient;
  windowSearch: string;
}): DesktopWorkspaceWorkbenchRepository {
  return createDesktopWorkspaceWorkbenchRepository(input.tuttidClient, {
    persistence: resolveWorkspaceWorkbenchSnapshotPersistence(
      input.windowSearch
    )
  });
}
