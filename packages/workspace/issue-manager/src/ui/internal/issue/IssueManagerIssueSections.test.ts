import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const issueSectionsSource = readFileSync(
  new URL("./IssueManagerIssueSections.tsx", import.meta.url),
  "utf8"
);
const subtaskBoardSource = readFileSync(
  new URL("./IssueManagerSubtaskBoard.tsx", import.meta.url),
  "utf8"
);

test("execution outputs render as clickable file rows without trailing open buttons", () => {
  assert.match(issueSectionsSource, /FileIcon/);
  assert.match(issueSectionsSource, /--folder/);
  assert.match(issueSectionsSource, /output\.path/);
  assert.match(issueSectionsSource, /formatIssueManagerTimestamp/);
  assert.match(issueSectionsSource, /void onOpen\(\{/);
  assert.match(
    issueSectionsSource,
    /aria-label=\{copy\.t\("actions\.openReference"\)\}/
  );
  assert.doesNotMatch(issueSectionsSource, /ArrowRightIcon/);
  assert.doesNotMatch(
    issueSectionsSource,
    /copy\.t\("actions\.openReference"\)\}\s*<ArrowRightIcon/
  );
});

test("execution output file icon container is borderless", () => {
  assert.match(
    issueSectionsSource,
    /rounded-md bg-\[color-mix\(in_srgb,var\(--folder\)_12%,transparent\)\] text-\[var\(--folder\)\]/
  );
  assert.doesNotMatch(
    issueSectionsSource,
    /rounded-md border border-\[var\(--line-2\)\] bg-\[color-mix\(in_srgb,var\(--folder\)_12%,transparent\)\]/
  );
});

test("subtask board cards keep stable borderless background", () => {
  const boardColumnStart = subtaskBoardSource.indexOf(
    "function IssueManagerSubtaskBoardColumn"
  );
  const boardColumnEnd = subtaskBoardSource.indexOf(
    "function resolveIssueManagerBoardColumnClassName"
  );
  const boardColumnSource = subtaskBoardSource.slice(
    boardColumnStart,
    boardColumnEnd
  );

  assert.match(boardColumnSource, /bg-\[var\(--background-fronted\)\]/);
  assert.match(boardColumnSource, /rounded-\[8px\]/);
  assert.doesNotMatch(boardColumnSource, /border border-\[var\(--line-2\)\]/);
  assert.doesNotMatch(boardColumnSource, /hover:bg/);
  assert.doesNotMatch(boardColumnSource, /bg-transparency-actived/);
});

test("subtask board accepts dragged review and done tasks into allowed columns", () => {
  assert.match(issueSectionsSource, /onSetTaskStatus=\{onSetTaskStatus\}/);
  assert.match(
    subtaskBoardSource,
    /type IssueManagerSubtaskDragStatus = "completed" \| "pending_acceptance"/
  );
  assert.match(
    subtaskBoardSource,
    /status === "pending_acceptance" \|\| status === "completed"/
  );
  assert.match(
    subtaskBoardSource,
    /targetStatus === "not_started" \|\|[\s\S]*targetStatus === "completed"/
  );
  assert.match(
    subtaskBoardSource,
    /targetStatus === "not_started" \|\|[\s\S]*targetStatus === "pending_acceptance"/
  );
  assert.match(subtaskBoardSource, /draggable=\{Boolean\(dragStatus\)\}/);
  assert.match(subtaskBoardSource, /data-task-status-drop-target/);
  assert.match(
    subtaskBoardSource,
    /void onSetTaskStatus\(taskId, dropTargetStatus\)/
  );
});

test("subtask board shows opaque drag card with soft shadow and colored drop preview", () => {
  assert.match(
    subtaskBoardSource,
    /issueManagerSubtaskDragShadow = "var\(--shadow-soft\)"/
  );
  assert.match(subtaskBoardSource, /boxShadow = issueManagerSubtaskDragShadow/);
  assert.match(subtaskBoardSource, /opacity = "1"/);
  assert.doesNotMatch(subtaskBoardSource, /opacity = "0\.96"/);
  assert.match(subtaskBoardSource, /transition-shadow/);
  assert.doesNotMatch(subtaskBoardSource, /transition-\[box-shadow,opacity\]/);
  assert.match(subtaskBoardSource, /event\.dataTransfer\.setDragImage/);
  assert.match(
    subtaskBoardSource,
    /isDraggingTask && issueManagerSubtaskDragShadowClassName/
  );
  assert.doesNotMatch(subtaskBoardSource, /shadow-panel/);
  assert.match(subtaskBoardSource, /data-task-status-drop-preview/);
  assert.match(
    subtaskBoardSource,
    /function resolveIssueManagerBoardPlaceholderClassName/
  );
});

test("subtask board keeps dropped cards in the target column while status refreshes", () => {
  assert.match(subtaskBoardSource, /type IssueManagerSubtaskOptimisticDrop/);
  assert.match(
    subtaskBoardSource,
    /groupIssueManagerSubtasksByStatus\(tasks, optimisticDrop\)/
  );
  assert.match(subtaskBoardSource, /setOptimisticDrop\(null\)/);
  assert.match(subtaskBoardSource, /onOptimisticDropChange\(\{/);
  assert.match(
    subtaskBoardSource,
    /onSetTaskStatus\(taskId, dropTargetStatus\)\.catch/
  );
});

test("subtask board animates pushed cards with reduced-motion support", () => {
  assert.match(subtaskBoardSource, /useIssueManagerBoardLayoutAnimation/);
  assert.match(
    subtaskBoardSource,
    /issueManagerBoardLayoutAnimationDurationMs = 180/
  );
  assert.match(subtaskBoardSource, /getBoundingClientRect/);
  assert.match(subtaskBoardSource, /element\.animate/);
  assert.match(subtaskBoardSource, /prefers-reduced-motion: reduce/);
  assert.match(subtaskBoardSource, /data-issue-manager-board-layout-item/);
});
