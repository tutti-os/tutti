import assert from "node:assert/strict";
import test from "node:test";
import {
  clearIssueManagerSidebarLayout,
  publishIssueManagerSidebarLayout
} from "./IssueManagerSidebarLayout.ts";

test("issue manager publishes one sidebar layout on the shared workbench scope", () => {
  const workbenchWindow = createElement();
  const layout = createElement(workbenchWindow);

  const scope = publishIssueManagerSidebarLayout(layout, {
    isCollapsed: false,
    isResizing: true,
    width: 412
  });

  assert.equal(scope, workbenchWindow);
  assert.equal(
    workbenchWindow.style.getPropertyValue("--issue-manager-sidebar-width"),
    "412px"
  );
  assert.equal(workbenchWindow.dataset.issueManagerSidebarCollapsed, "false");
  assert.equal(workbenchWindow.dataset.issueManagerSidebarResizing, "true");
  assert.equal(
    layout.style.getPropertyValue("--issue-manager-sidebar-width"),
    ""
  );

  const updatedScope = publishIssueManagerSidebarLayout(layout, {
    isCollapsed: false,
    isResizing: false,
    width: 456
  });
  assert.equal(updatedScope, scope);
  assert.equal(
    workbenchWindow.style.getPropertyValue("--issue-manager-sidebar-width"),
    "456px"
  );
  assert.equal(workbenchWindow.dataset.issueManagerSidebarResizing, "false");

  clearIssueManagerSidebarLayout(scope);
  assert.equal(
    workbenchWindow.style.getPropertyValue("--issue-manager-sidebar-width"),
    ""
  );
  assert.equal(workbenchWindow.dataset.issueManagerSidebarCollapsed, undefined);
  assert.equal(workbenchWindow.dataset.issueManagerSidebarResizing, undefined);
});

test("standalone issue manager owns its sidebar layout variable", () => {
  const layout = createElement();

  const scope = publishIssueManagerSidebarLayout(layout, {
    isCollapsed: true,
    isResizing: false,
    width: 280
  });

  assert.equal(scope, layout);
  assert.equal(
    layout.style.getPropertyValue("--issue-manager-sidebar-width"),
    "280px"
  );
  assert.equal(layout.dataset.issueManagerSidebarCollapsed, "true");
  assert.equal(layout.dataset.issueManagerSidebarResizing, "false");
});

function createElement(workbenchWindow?: HTMLElement): HTMLElement {
  const properties = new Map<string, string>();
  return {
    closest: (selector: string) =>
      selector === ".workbench-window" ? (workbenchWindow ?? null) : null,
    dataset: {},
    style: {
      getPropertyValue: (name: string) => properties.get(name) ?? "",
      removeProperty: (name: string) => {
        const previous = properties.get(name) ?? "";
        properties.delete(name);
        return previous;
      },
      setProperty: (name: string, value: string) => {
        properties.set(name, value);
      }
    }
  } as unknown as HTMLElement;
}
