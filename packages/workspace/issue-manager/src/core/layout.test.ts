import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultIssueManagerNodeFrame } from "../workbench/constants.ts";
import {
  clampIssueManagerSidebarWidth,
  issueManagerDefaultNodeFrameWidth,
  issueManagerSidebarDefaultWidth,
  resolveIssueManagerExpandedFrame,
  shouldAutoCollapseIssueManagerSidebar
} from "./layout.ts";

describe("defaultIssueManagerNodeFrame", () => {
  it("opens task center at the compact default size", () => {
    assert.equal(defaultIssueManagerNodeFrame.width, 860);
    assert.equal(defaultIssueManagerNodeFrame.height, 560);
    assert.equal(issueManagerDefaultNodeFrameWidth, 860);
  });
});

describe("resolveIssueManagerExpandedFrame", () => {
  it("widens a collapsed floating issue manager before expanding the sidebar", () => {
    const frame = {
      height: 620,
      width: 760,
      x: 120,
      y: 80
    };

    const expanded = resolveIssueManagerExpandedFrame(frame, 1400);

    assert.ok(expanded.width > frame.width);
    assert.equal(expanded.height, frame.height);
    assert.equal(expanded.y, frame.y);
  });
});

describe("720px embedded task panel layout", () => {
  it("keeps the default list column and leaves room for task details", () => {
    assert.equal(
      clampIssueManagerSidebarWidth(issueManagerSidebarDefaultWidth, 720),
      280
    );
    assert.equal(shouldAutoCollapseIssueManagerSidebar(720), false);
  });
});
