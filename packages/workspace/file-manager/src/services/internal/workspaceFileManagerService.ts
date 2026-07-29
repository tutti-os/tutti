import {
  createWorkspaceFileManagerStore,
  normalizeWorkspaceFileManagerPersistedState
} from "./workspaceFileManagerStore.ts";
import { DefaultWorkspaceFileManagerSession } from "./workspaceFileManagerSession.ts";
import type { WorkspaceFileManagerService } from "../workspaceFileManagerService.interface.ts";
import type { CreateWorkspaceFileManagerSessionInput } from "../workspaceFileManagerHost.interface.ts";
import type { WorkspaceFileManagerCapabilities } from "../workspaceFileManagerTypes.ts";

export class DefaultWorkspaceFileManagerService implements WorkspaceFileManagerService {
  createSession(input: CreateWorkspaceFileManagerSessionInput) {
    const capabilities = capabilitiesFromHost(input);
    const store = createWorkspaceFileManagerStore({
      capabilities,
      defaultLocationId: input.defaultLocationId,
      initialDirectoryPath: input.initialDirectoryPath,
      locationSections: input.locationSections,
      persistedState: normalizeWorkspaceFileManagerPersistedState(
        input.persistedState ?? input.persistence?.load?.()
      ),
      workspaceID: input.workspaceID
    });

    return new DefaultWorkspaceFileManagerSession({
      copy: input.i18n,
      host: input.host,
      onMutationErrorMessage: input.onMutationErrorMessage,
      persistence: input.persistence,
      resolveFileDefaultOpener: input.resolveFileDefaultOpener,
      store
    });
  }
}

function capabilitiesFromHost(
  input: CreateWorkspaceFileManagerSessionInput
): WorkspaceFileManagerCapabilities {
  return {
    canCopy: input.host.copyEntriesToClipboard !== undefined,
    canCreateDirectory: input.host.createDirectory !== undefined,
    canCreateFile: input.host.createFile !== undefined,
    canDelete: input.host.deleteEntry !== undefined,
    canMove: input.host.moveEntry !== undefined,
    canOpenInAppBrowser: input.host.openFileInAppBrowser !== undefined,
    canOpenInDefaultBrowser: input.host.openFileInDefaultBrowser !== undefined,
    canOpenWith: input.host.listOpenWithApplications !== undefined,
    canPickOtherOpenWithApplication:
      input.host.openFileWithOtherApplication !== undefined,
    canRevealInFolder: input.host.revealEntry !== undefined,
    canRename: input.host.renameEntry !== undefined,
    canSearch: input.host.search !== undefined
  };
}
