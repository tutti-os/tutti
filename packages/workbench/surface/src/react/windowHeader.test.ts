import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import type { WorkbenchNode } from "../core/types.ts";
import {
  resolveWorkbenchWindowChromeMode,
  resolveWorkbenchWindowHeader
} from "./windowHeader.ts";

test("defaults to the built-in system chrome mode", () => {
  const controller = createWorkbenchController<TestNodeData>();
  const node = makeNode("node-system");

  assert.equal(
    resolveWorkbenchWindowChromeMode({
      controller,
      node,
      windowChromeMode: undefined
    }),
    "system"
  );

  const resolvedHeader = resolveWorkbenchWindowHeader({
    controller,
    defaultActions: "default-actions",
    genie: { minimizeNodeToAnchor: () => {} },
    isDragging: false,
    isFocused: false,
    isResizing: false,
    node,
    onDoubleClick: () => {},
    onDragStart: () => {},
    renderRevision: {},
    windowChromeMode: "system"
  });

  assert.equal(resolvedHeader.windowChromeMode, "system");
  assert.equal(resolvedHeader.customHeader, null);
});

test("custom-header mode uses the host header and replaces the shared default header plan", () => {
  const controller = createWorkbenchController<TestNodeData>();
  const node = makeNode("node-custom");
  let receivedDragHandleProps: unknown = null;

  const resolvedMode = resolveWorkbenchWindowChromeMode({
    controller,
    node,
    windowChromeMode: ({ node: currentNode }) =>
      currentNode.id === node.id ? "custom-header" : "system"
  });
  const resolvedHeader = resolveWorkbenchWindowHeader({
    controller,
    defaultActions: "default-actions",
    genie: { minimizeNodeToAnchor: () => {} },
    isDragging: true,
    isFocused: true,
    isResizing: false,
    node,
    onDoubleClick: () => {},
    onDragStart: () => {},
    renderHeader: ({ dragHandleProps }) => {
      receivedDragHandleProps = dragHandleProps;
      return "custom-header";
    },
    renderRevision: {},
    windowChromeMode: resolvedMode
  });

  assert.equal(resolvedHeader.windowChromeMode, "custom-header");
  assert.equal(resolvedHeader.customHeader, "custom-header");
  assert.deepEqual(receivedDragHandleProps, {
    "data-workbench-drag-handle": "true",
    onDoubleClick: resolvedHeader.context.dragHandleProps.onDoubleClick,
    onPointerDown: resolvedHeader.context.dragHandleProps.onPointerDown
  });
  assert.equal(resolvedHeader.context.isDragging, true);
  assert.equal(resolvedHeader.context.isFocused, true);
  assert.equal(resolvedHeader.context.isResizing, false);
});

test("custom headers can reuse the shared default actions bundle", () => {
  const controller = createWorkbenchController<TestNodeData>();
  const node = makeNode("node-actions");
  const defaultActions = "default-actions";
  let receivedActions: unknown = null;
  let receivedDragHandleProps: unknown = null;

  const resolvedHeader = resolveWorkbenchWindowHeader({
    controller,
    defaultActions,
    genie: { minimizeNodeToAnchor: () => {} },
    isDragging: false,
    isFocused: false,
    isResizing: false,
    node,
    onDoubleClick: () => {},
    onDragStart: () => {},
    renderHeader: ({ defaultActions: headerActions, dragHandleProps }) => {
      receivedActions = headerActions;
      receivedDragHandleProps = dragHandleProps;
      return "custom-header";
    },
    renderRevision: {},
    windowChromeMode: "custom-header"
  });

  assert.equal(receivedActions, defaultActions);
  assert.equal(resolvedHeader.customHeader, "custom-header");
  assert.deepEqual(receivedDragHandleProps, {
    "data-workbench-drag-handle": "true",
    onDoubleClick: resolvedHeader.context.dragHandleProps.onDoubleClick,
    onPointerDown: resolvedHeader.context.dragHandleProps.onPointerDown
  });
});

test("custom headers receive the current surface size", () => {
  const controller = createWorkbenchController<TestNodeData>({
    surfaceSize: { width: 1280, height: 720 }
  });
  const node = makeNode("node-surface-size");
  let receivedSurfaceSize: unknown = null;

  resolveWorkbenchWindowHeader({
    controller,
    defaultActions: "default-actions",
    genie: { minimizeNodeToAnchor: () => {} },
    isDragging: false,
    isFocused: false,
    isResizing: true,
    node,
    onDoubleClick: () => {},
    onDragStart: () => {},
    renderHeader: ({ surfaceSize }) => {
      receivedSurfaceSize = surfaceSize;
      return "custom-header";
    },
    renderRevision: {},
    windowChromeMode: "custom-header"
  });

  assert.deepEqual(receivedSurfaceSize, { width: 1280, height: 720 });
});

interface TestNodeData {
  value: string;
}

function makeNode(id: string): WorkbenchNode<TestNodeData> {
  return {
    data: { value: id },
    displayMode: "floating",
    frame: { x: 24, y: 24, width: 320, height: 220 },
    id,
    isMinimized: false,
    kind: "test",
    restoreFrame: null,
    title: `Node ${id}`
  };
}
