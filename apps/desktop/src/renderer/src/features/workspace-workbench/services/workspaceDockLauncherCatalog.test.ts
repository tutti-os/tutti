import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchContribution,
  WorkbenchHostDockEntry
} from "@tutti-os/workbench-surface/dock-catalog";
import { workspaceFilesNodeID } from "./workspaceWorkbenchNodeIds.ts";
import {
  createWorkspaceDockRetentionActionId,
  findWorkspaceDockLauncherCatalogEntry,
  readWorkspaceAppIdFromDockEntryId,
  readWorkspaceDockRetentionActionEntryId,
  resolveWorkspaceDockLauncherCatalog
} from "./workspaceDockLauncherCatalog.ts";

const workspaceLaunchpadDockEntryId = "workspace-launchpad";

test("launcher catalog merges explicit entries over contributions and applies canonical order", () => {
  const contributions: WorkbenchContribution[] = [
    {
      dockEntries: [
        createEntry("apps-later", { order: 30, sectionId: "apps" }),
        createEntry("browser", {
          label: "Contribution browser",
          order: 20,
          sectionId: "tools"
        })
      ],
      id: "base"
    }
  ];
  const explicitBrowser = createEntry("browser", {
    label: "Explicit browser",
    order: 10,
    sectionId: "tools"
  });

  const catalog = resolveWorkspaceDockLauncherCatalog({
    contributions,
    dockEntries: [
      createEntry("apps-first", { order: 10, sectionId: "apps" }),
      explicitBrowser
    ]
  });

  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ["apps-first", "apps-later", "browser"]
  );
  assert.equal(
    findWorkspaceDockLauncherCatalogEntry(catalog, "browser")?.label,
    "Explicit browser"
  );
  assert.equal(catalog.filter((entry) => entry.id === "browser").length, 1);
});

test("launcher catalog leaves Launchpad and Files retention policy untouched", () => {
  const launchpad = createEntry(workspaceLaunchpadDockEntryId, {
    visibility: "always"
  });
  const files = createEntry(workspaceFilesNodeID, { visibility: "always" });

  const catalog = resolveWorkspaceDockLauncherCatalog({
    dockEntries: [launchpad, files]
  });

  assert.equal(catalog[0], launchpad);
  assert.equal(catalog[1], files);
  assert.equal(catalog[0]?.dockRetention, undefined);
  assert.equal(catalog[1]?.dockRetention, undefined);
});

test("launcher catalog retains installed apps and hides uninstalled apps until open", () => {
  const catalog = resolveWorkspaceDockLauncherCatalog({
    dockEntries: [
      createEntry("workspace-app:installed", { visibility: "when-open" }),
      createEntry("workspace-app:uninstalled", { visibility: "always" }),
      createEntry("always-tool", { visibility: "always" }),
      createEntry("transient-tool", { visibility: "when-open" })
    ],
    isWorkspaceAppInstalled(appId) {
      return appId === "installed";
    }
  });

  assert.deepEqual(
    catalog.map((entry) => ({
      id: entry.id,
      retained: entry.dockRetention?.retained,
      visibility: entry.visibility
    })),
    [
      { id: "workspace-app:installed", retained: true, visibility: "always" },
      {
        id: "workspace-app:uninstalled",
        retained: false,
        visibility: "when-open"
      },
      { id: "always-tool", retained: true, visibility: "always" },
      {
        id: "transient-tool",
        retained: false,
        visibility: "when-open"
      }
    ]
  );
});

test("launcher catalog gives user retention overrides precedence and preserves custom actions", () => {
  const catalog = resolveWorkspaceDockLauncherCatalog({
    dockEntries: [
      createEntry("workspace-app:notes", {
        dockRetention: {
          actionId: "notes:set-retained",
          disabled: true,
          pendingLabel: "Updating",
          retained: false
        },
        visibility: "when-open"
      }),
      createEntry("browser", { visibility: "always" })
    ],
    isWorkspaceAppInstalled: () => false,
    retainedByEntryId: {
      browser: false,
      "workspace-app:notes": true
    }
  });

  const notes = findWorkspaceDockLauncherCatalogEntry(
    catalog,
    "workspace-app:notes"
  );
  assert.deepEqual(notes?.dockRetention, {
    actionId: "notes:set-retained",
    disabled: true,
    pendingLabel: "Updating",
    retained: true
  });
  assert.equal(notes?.visibility, "always");
  assert.equal(
    findWorkspaceDockLauncherCatalogEntry(catalog, "browser")?.visibility,
    "when-open"
  );
});

test("launcher catalog retention action ids round-trip entry ids safely", () => {
  const entryId = "workspace-app:notes / daily";
  const actionId = createWorkspaceDockRetentionActionId(entryId);

  assert.equal(readWorkspaceDockRetentionActionEntryId(actionId), entryId);
  assert.equal(readWorkspaceDockRetentionActionEntryId("other:action"), null);
  assert.equal(
    readWorkspaceDockRetentionActionEntryId(
      "temporary-workspace-app-dock-retention:%E0%A4%A"
    ),
    null
  );
});

test("launcher catalog decodes canonical Workspace App entry identity", () => {
  assert.equal(
    readWorkspaceAppIdFromDockEntryId("workspace-app:notes%20daily"),
    "notes daily"
  );
  assert.equal(readWorkspaceAppIdFromDockEntryId("browser"), null);
  assert.equal(
    readWorkspaceAppIdFromDockEntryId("workspace-app:%E0%A4%A"),
    null
  );
});

function createEntry(
  id: string,
  overrides: Partial<WorkbenchHostDockEntry> = {}
): WorkbenchHostDockEntry {
  return {
    icon: null,
    id,
    label: id,
    typeId: id,
    ...overrides
  };
}
