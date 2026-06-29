import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveIssueManagerSidebarPresentationState } from "./IssueManagerSidebarState.ts";

const issueManagerSidebarSectionsSource = readFileSync(
  new URL("./IssueManagerSidebarSections.tsx", import.meta.url),
  "utf8"
);
const issueManagerNodeSource = readFileSync(
  new URL("../../IssueManagerNode.tsx", import.meta.url),
  "utf8"
);

test("sidebar header search and create controls mirror the conversation rail controls", () => {
  assert.match(
    issueManagerSidebarSectionsSource,
    /import \{[\s\S]*Button,[\s\S]*Input,[\s\S]*\} from "@tutti-os\/ui-system";/
  );
  assert.match(
    issueManagerSidebarSectionsSource,
    /import \{ CreateChatIcon \} from "@tutti-os\/ui-system\/icons";/
  );
  assert.match(
    issueManagerSidebarSectionsSource,
    /issueManagerSidebarHeaderClassName =[\s\S]*grid-cols-\[minmax\(0,1fr\)_max-content\][\s\S]*\[--agent-gui-rail-control-radius:6px\]/
  );
  assert.match(
    issueManagerSidebarSectionsSource,
    /issueManagerSidebarSearchFieldClassName =\s*"room-issue-node__search-field";/
  );
  assert.match(
    issueManagerSidebarSectionsSource,
    /issueManagerSidebarSearchInputClassName =\s*"room-issue-node__search-input";/
  );
  assert.match(
    issueManagerSidebarSectionsSource,
    /issueManagerSidebarCreateButtonClassName =\s*"agent-gui-node__new-conversation-icon-button";/
  );
  assert.match(issueManagerSidebarSectionsSource, /<Input[\s\S]*type="search"/);
  assert.match(
    issueManagerSidebarSectionsSource,
    /<Button[\s\S]*size="dialog"[\s\S]*variant="secondary"/
  );
  assert.match(issueManagerSidebarSectionsSource, /<CreateChatIcon/);
  assert.doesNotMatch(
    issueManagerSidebarSectionsSource,
    /FileCreateIcon|issueManagerHeaderControlStyle|!rounded-\[6px\]|bg-clip-border|pr-9|pr-3/
  );
});

test("sidebar empty state renders body copy without a standalone title", () => {
  assert.match(
    issueManagerSidebarSectionsSource,
    /<IssueManagerSidebarEmptyState[\s\S]*body=\{sidebarViewState\.body\}[\s\S]*isNarrowLayout=\{isNarrowLayout\}[\s\S]*\/>/
  );
  assert.doesNotMatch(
    issueManagerSidebarSectionsSource,
    /<IssueManagerSidebarEmptyState[\s\S]*title=\{sidebarViewState\.title\}/
  );
});

test("node header keeps task center chrome inside the sidebar header", () => {
  assert.match(
    issueManagerNodeSource,
    /const issueManagerHeaderChromeIconButtonClassName =[\s\S]*size-7[\s\S]*text-\[var\(--text-secondary\)\][\s\S]*hover:text-\[var\(--text-primary\)\]/
  );
  assert.match(
    issueManagerNodeSource,
    /const issueManagerHeaderChromeIconClassName = "size-\[18px\]";/
  );
  assert.match(
    issueManagerNodeSource,
    /const issueManagerHeaderTrafficLightClassName =[\s\S]*rounded-full/
  );
  assert.match(
    issueManagerNodeSource,
    /width: effectiveCollapsed[\s\S]*var\(--issue-manager-sidebar-width, 280px\)/
  );
  assert.match(
    issueManagerNodeSource,
    /<IssueManagerTopicSelector[\s\S]*className="max-w-\[150px\] flex-none text-\[var\(--text-primary\)\]"/
  );
  assert.match(
    issueManagerNodeSource,
    /<IssueManagerTrafficLightButton[\s\S]*tone="close"[\s\S]*<IssueManagerTrafficLightButton[\s\S]*tone="minimize"[\s\S]*<IssueManagerTrafficLightButton[\s\S]*tone="maximize"/
  );
  assert.doesNotMatch(
    issueManagerNodeSource,
    /--cove-canvas-control-text|pointer-events-none absolute top-1\/2 left-1\/2/
  );
});

test("sidebar presentation state suppresses standalone content when the shell renders inline", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarPresentationState({
      showStandaloneState: false,
      sidebarViewState: {
        kind: "error",
        retryLabel: "actions.refresh",
        title: "messages.issueRefreshFailed"
      }
    }),
    {
      kind: "none"
    }
  );
});

test("sidebar presentation state keeps retry metadata for standalone errors", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarPresentationState({
      showStandaloneState: true,
      sidebarViewState: {
        kind: "error",
        retryLabel: "actions.refresh",
        title: "messages.issueRefreshFailed"
      }
    }),
    {
      kind: "error",
      retryLabel: "actions.refresh",
      title: "messages.issueRefreshFailed"
    }
  );
});

test("sidebar presentation state keeps empty copy for standalone empty states", () => {
  assert.deepEqual(
    resolveIssueManagerSidebarPresentationState({
      showStandaloneState: true,
      sidebarViewState: {
        body: "messages.noIssuesForFilterBody",
        kind: "empty",
        title: "messages.noIssuesForFilterTitle"
      }
    }),
    {
      body: "messages.noIssuesForFilterBody",
      kind: "empty"
    }
  );
});
