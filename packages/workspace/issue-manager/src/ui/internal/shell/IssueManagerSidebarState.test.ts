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

test("sidebar header search and create controls use task creation chrome", () => {
  assert.match(
    issueManagerSidebarSectionsSource,
    /import \{[\s\S]*Button,[\s\S]*FileCreateIcon,[\s\S]*Input,[\s\S]*\} from "@tutti-os\/ui-system";/
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
  assert.match(
    issueManagerSidebarSectionsSource,
    /<div className="px-4 pb-4">/
  );
  assert.doesNotMatch(issueManagerSidebarSectionsSource, /px-4 py-4/);
  assert.match(issueManagerSidebarSectionsSource, /<Input[\s\S]*type="search"/);
  assert.match(
    issueManagerSidebarSectionsSource,
    /<Button[\s\S]*size="dialog"[\s\S]*variant="secondary"/
  );
  assert.match(issueManagerSidebarSectionsSource, /<FileCreateIcon/);
  assert.doesNotMatch(
    issueManagerSidebarSectionsSource,
    /CreateChatIcon|TaskIcon|issueManagerHeaderControlStyle|!rounded-\[6px\]|bg-clip-border|pr-9|pr-3/
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
    /const issueManagerHeaderTrafficLightClassName =[\s\S]*-m-1[\s\S]*size-5[\s\S]*cursor-pointer[\s\S]*rounded-full[\s\S]*text-\[color-mix\(in_srgb,var\(--text-tertiary\)_72%,transparent\)\][\s\S]*opacity-\[0\.78\][\s\S]*transition-\[color,opacity\]/
  );
  assert.match(
    issueManagerNodeSource,
    /const issueManagerHeaderTrafficLightClassName =[\s\S]*group-hover\/traffic-lights:opacity-100[\s\S]*group-focus-within\/traffic-lights:opacity-100/
  );
  assert.match(
    issueManagerNodeSource,
    /const issueManagerHeaderTrafficLightClassName =[\s\S]*before:inset-1[\s\S]*before:rounded-full[\s\S]*before:transition-colors[\s\S]*before:duration-150/
  );
  assert.match(
    issueManagerNodeSource,
    /tone === "close" &&[\s\S]*"group-hover\/traffic-lights:text-\[#ff5f57\] group-focus-within\/traffic-lights:text-\[#ff5f57\]"[\s\S]*tone === "minimize" &&[\s\S]*"group-hover\/traffic-lights:text-\[#ffbd2e\] group-focus-within\/traffic-lights:text-\[#ffbd2e\]"[\s\S]*tone === "maximize" &&[\s\S]*"group-hover\/traffic-lights:text-\[#28c840\] group-focus-within\/traffic-lights:text-\[#28c840\]"/
  );
  assert.match(
    issueManagerNodeSource,
    /<TooltipProvider delayDuration=\{250\} skipDelayDuration=\{0\}>[\s\S]*<TooltipTrigger asChild>\{button\}<\/TooltipTrigger>[\s\S]*<TooltipContent side="bottom">\{label\}<\/TooltipContent>/
  );
  assert.match(
    issueManagerNodeSource,
    /const iconName =[\s\S]*tone === "maximize" \? \(pressed \? "unfullscreen" : "fullscreen"\) : tone;/
  );
  assert.match(
    issueManagerNodeSource,
    /<WindowTrafficLightIcon[\s\S]*data-issue-manager-traffic-light-icon=\{iconName\}[\s\S]*iconName=\{iconName\}/
  );
  assert.match(
    issueManagerNodeSource,
    /className="group\/traffic-lights flex shrink-0 items-center gap-2"/
  );
  assert.match(
    issueManagerNodeSource,
    /width: effectiveCollapsed[\s\S]*\? "max-content"[\s\S]*var\(--issue-manager-sidebar-width, 280px\)/
  );
  assert.match(
    issueManagerNodeSource,
    /const topicHeaderStyle = \{[\s\S]*left: effectiveCollapsed[\s\S]*\? "50%"[\s\S]*min\(var\(--issue-manager-sidebar-width, 280px\), 100%\)[\s\S]*\} satisfies CSSProperties;/
  );
  assert.match(
    issueManagerNodeSource,
    /className=\{cn\([\s\S]*"relative z-10 flex h-full min-w-0 cursor-grab items-center gap-2 bg-\[var\(--background-panel\)\] pr-3 pl-4 active:cursor-grabbing",[\s\S]*!effectiveCollapsed && "border-r border-\[var\(--border-1\)\]"[\s\S]*\)\}/
  );
  assert.match(
    issueManagerNodeSource,
    /<Button[\s\S]*className=\{cn\([\s\S]*!effectiveCollapsed && "ml-auto",[\s\S]*issueManagerHeaderChromeIconButtonClassName[\s\S]*\)\}/
  );
  assert.match(
    issueManagerNodeSource,
    /data-workbench-custom-header-border="none"/
  );
  assert.doesNotMatch(
    issueManagerNodeSource,
    /pointer-events-none absolute (?:inset-x-0|right-0) bottom-0 z-\[11\] h-px bg-\[var\(--background-panel\)\]/
  );
  assert.match(
    issueManagerNodeSource,
    /<div[\s\S]*className="pointer-events-none absolute inset-y-0 z-10 flex min-w-0 -translate-x-1\/2 items-center justify-center px-3"[\s\S]*style=\{topicHeaderStyle\}[\s\S]*<IssueManagerTopicSelector[\s\S]*className="max-w-\[220px\] text-\[var\(--text-primary\)\]"/
  );
  assert.match(
    issueManagerNodeSource,
    /<PanelIcon className=\{issueManagerHeaderChromeIconClassName\} \/>[\s\S]*\{effectiveCollapsed \? \([\s\S]*<TooltipTrigger asChild>[\s\S]*<Button[\s\S]*aria-label=\{copy\.t\("actions\.createIssue"\)\}[\s\S]*className=\{issueManagerHeaderChromeIconButtonClassName\}[\s\S]*dispatchIssueManagerIssueCreateRequest\(\{[\s\S]*nodeId,[\s\S]*workspaceId[\s\S]*\}\)[\s\S]*<FileCreateIcon aria-hidden="true" \/>/
  );
  assert.match(
    issueManagerNodeSource,
    /<TooltipContent side="bottom">\s*\{copy\.t\("actions\.createIssue"\)\}\s*<\/TooltipContent>/
  );
  assert.doesNotMatch(
    issueManagerNodeSource,
    /pointer-events-auto absolute right-3/
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
