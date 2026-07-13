import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostDockEntry } from "@tutti-os/workbench-surface";
import type { WorkspaceWorkbenchHostInput } from "../workspaceWorkbenchHostService.interface";
import {
  assignWorkspaceTaskDockSection,
  workspaceTaskDockSectionId
} from "./workspaceDockSections.ts";
import { createWorkspaceDynamicDockSignature } from "./workspaceDynamicDockSignature.ts";
import { createWorkspaceWorkbenchHostInputWithDockEntries } from "./workspaceWorkbenchHostInput.ts";

test("createWorkspaceWorkbenchHostInputWithDockEntries updates dock entries without replacing host config references", () => {
  const contributions = [{ id: "workspace-app-center" }];
  const externalStateSource = {} as NonNullable<
    WorkspaceWorkbenchHostInput["externalStateSource"]
  >;
  const onLaunchRequest = async () => null;
  const onNodeCloseRequest = async () => undefined;
  const prepareHostClose = async () => true;
  const snapshotRepository =
    {} as WorkspaceWorkbenchHostInput["snapshotRepository"];
  const baseHostInput: WorkspaceWorkbenchHostInput = {
    contributions,
    externalStateSource,
    onLaunchRequest,
    onNodeCloseRequest,
    prepareHostClose,
    snapshotRepository,
    workspaceId: "workspace-1"
  };
  const loadingDockEntries = [createDockEntry("hello", "loading")];
  const runningDockEntries = [createDockEntry("hello", "enabled")];

  const firstHostInput = createWorkspaceWorkbenchHostInputWithDockEntries(
    baseHostInput,
    loadingDockEntries
  );
  const secondHostInput = createWorkspaceWorkbenchHostInputWithDockEntries(
    baseHostInput,
    runningDockEntries
  );

  assert.notEqual(firstHostInput, secondHostInput);
  assert.equal(firstHostInput.contributions, contributions);
  assert.equal(secondHostInput.contributions, contributions);
  assert.equal(firstHostInput.externalStateSource, externalStateSource);
  assert.equal(secondHostInput.externalStateSource, externalStateSource);
  assert.equal(firstHostInput.onLaunchRequest, onLaunchRequest);
  assert.equal(secondHostInput.onLaunchRequest, onLaunchRequest);
  assert.equal(firstHostInput.onNodeCloseRequest, onNodeCloseRequest);
  assert.equal(secondHostInput.onNodeCloseRequest, onNodeCloseRequest);
  assert.equal(firstHostInput.prepareHostClose, prepareHostClose);
  assert.equal(secondHostInput.prepareHostClose, prepareHostClose);
  assert.equal(firstHostInput.snapshotRepository, snapshotRepository);
  assert.equal(secondHostInput.snapshotRepository, snapshotRepository);
  assert.equal(firstHostInput.dockEntries, loadingDockEntries);
  assert.equal(secondHostInput.dockEntries, runningDockEntries);
});

test("assignWorkspaceTaskDockSection moves dynamic app entries into the task dock group", () => {
  const appCenterEntry = createDockEntry("workspace-app-center", "enabled");
  const workspaceAppEntry = createDockEntry("workspace-app:notes", "enabled");
  const groupedEntries = assignWorkspaceTaskDockSection([
    appCenterEntry,
    workspaceAppEntry
  ]);

  assert.notEqual(groupedEntries[0], appCenterEntry);
  assert.notEqual(groupedEntries[1], workspaceAppEntry);
  assert.equal(appCenterEntry.sectionId, undefined);
  assert.equal(workspaceAppEntry.sectionId, undefined);
  assert.deepEqual(
    groupedEntries.map((entry) => ({
      id: entry.id,
      sectionId: entry.sectionId
    })),
    [
      {
        id: "workspace-app-center",
        sectionId: workspaceTaskDockSectionId
      },
      {
        id: "workspace-app:notes",
        sectionId: workspaceTaskDockSectionId
      }
    ]
  );
});

test("workspace dynamic dock signature tracks only dock-affecting app fields", () => {
  const firstApps = [
    {
      appId: "notes",
      description: "first description",
      enabled: true,
      iconUrl: "notes.png",
      installed: true,
      name: "Notes",
      runtimeStatus: "running",
      stateRevision: 1,
      launchUrl: "https://notes.local"
    }
  ];
  const metadataOnlyApps = [
    {
      ...firstApps[0]!,
      description: "updated description",
      stateRevision: 2
    }
  ];
  const statusChangedApps = [
    {
      ...firstApps[0]!,
      runtimeStatus: "starting"
    }
  ];

  assert.equal(
    createWorkspaceDynamicDockSignature({
      agentProviderRevision: 1,
      apps: firstApps
    }),
    createWorkspaceDynamicDockSignature({
      agentProviderRevision: 1,
      apps: metadataOnlyApps
    })
  );
  assert.notEqual(
    createWorkspaceDynamicDockSignature({
      agentProviderRevision: 1,
      apps: firstApps
    }),
    createWorkspaceDynamicDockSignature({
      agentProviderRevision: 1,
      apps: statusChangedApps
    })
  );
  assert.notEqual(
    createWorkspaceDynamicDockSignature({
      agentProviderRevision: 1,
      apps: firstApps
    }),
    createWorkspaceDynamicDockSignature({
      agentProviderRevision: 2,
      apps: firstApps
    })
  );
});

function createDockEntry(
  id: string,
  state: NonNullable<WorkbenchHostDockEntry["state"]>["kind"]
): WorkbenchHostDockEntry {
  return {
    icon: null,
    id,
    label: id,
    launchBehavior: "enabled",
    state: { kind: state },
    typeId: id
  };
}
