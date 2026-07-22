import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import type { ReferenceSourcePickerProps } from "./ReferenceSourcePicker.tsx";

type JsdomModule = {
  JSDOM: new (html: string) => {
    window: Window & typeof globalThis;
  };
};
type TypeScriptModule = typeof import("typescript");

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;
const ts = require("typescript") as TypeScriptModule;

test("reference source picker renders shared folder icons and content errors", async () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const tempDir = mkdtempSync(join(moduleDir, ".render-test-"));
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousElement = globalThis.Element;
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousView = (globalThis as { __referenceSourcePickerView?: unknown })
    .__referenceSourcePickerView;

  let root: Root | null = null;
  try {
    const componentModuleUrl = buildReferenceSourcePickerRenderModule(tempDir);
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Node = dom.window.Node;
    globalThis.Element = dom.window.Element;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const folderNode = folder("workspace-folder", "Workspace folder");
    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = createFolderOnlyView(folderNode);

    const { ReferenceSourcePicker } = (await import(componentModuleUrl)) as {
      ReferenceSourcePicker: (
        props: ReferenceSourcePickerProps
      ) => React.ReactElement | null;
    };
    const container = dom.window.document.getElementById("root");
    assert.ok(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          onClose() {},
          onConfirm() {},
          open: true,
          workspaceId: "workspace-reference-folder-icon-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    assert.equal(
      dom.window.document.querySelector(
        'img[src*="workspace-folder-fallback"]'
      ),
      null
    );

    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = {
      ...createFolderOnlyView(folderNode),
      contentError: new Error("reference endpoint unavailable"),
      currentEntries: []
    };
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          onClose() {},
          onConfirm() {},
          open: true,
          workspaceId: "workspace-reference-content-error-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    assert.equal(
      dom.window.document.querySelector('[role="alert"]')?.textContent,
      "referencePicker.loadError"
    );

    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = {
      ...createFolderOnlyView(folderNode),
      contentError: new Error("load more failed")
    };
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          onClose() {},
          onConfirm() {},
          open: true,
          workspaceId: "workspace-reference-inline-error-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    assert.match(
      dom.window.document.body.textContent ?? "",
      /Workspace folder/
    );
    assert.equal(
      dom.window.document.querySelector('[role="alert"]')?.textContent,
      "referencePicker.loadError"
    );

    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = {
      ...createFolderOnlyView(folderNode),
      canCreateDirectory: true,
      capabilities: { directoryCreatable: true, filterable: true },
      filterCategories: [
        {
          extensions: ["png"],
          id: "image",
          labelKey: "referencePicker.fileTypeImage"
        }
      ]
    };
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          fileManagerCopy: { t: (key: string) => key },
          onClose() {},
          onConfirm() {},
          open: true,
          purpose: "directory",
          workspaceId: "workspace-directory-purpose-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    const bodyText = dom.window.document.body.textContent ?? "";
    assert.match(bodyText, /directoryPicker\.title/);
    assert.match(bodyText, /createDirectoryLabel/);
    assert.match(bodyText, /directoryPicker\.confirm/);
    assert.doesNotMatch(bodyText, /referencePicker\.fileTypeAll/);
    assert.equal(
      dom.window.document.querySelector("input")?.getAttribute("placeholder"),
      "directoryPicker.searchPlaceholder"
    );

    let pickerCloseCount = 0;
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          fileManagerCopy: { t: (key: string) => key },
          onClose() {
            pickerCloseCount += 1;
          },
          onConfirm() {},
          open: true,
          purpose: "directory",
          workspaceId: "workspace-directory-cancel-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    const createDirectoryButton = Array.from(
      dom.window.document.querySelectorAll("button")
    ).find((button) => button.textContent === "createDirectoryLabel");
    assert.ok(createDirectoryButton);
    await act(async () => {
      createDirectoryButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });

    const cancelCreateDirectoryButton = dom.window.document.querySelector(
      '[data-testid="cancel-create-directory"]'
    );
    assert.ok(cancelCreateDirectoryButton);
    await act(async () => {
      cancelCreateDirectoryButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });

    assert.equal(pickerCloseCount, 0);
    assert.equal(
      dom.window.document.querySelector(
        '[data-testid="create-directory-dialog"]'
      ),
      null
    );

    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = {
      ...createFolderOnlyView(folderNode),
      isConfirming: true
    };
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          onClose() {
            pickerCloseCount += 1;
          },
          onConfirm() {},
          open: true,
          workspaceId: "workspace-reference-confirming-close-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    const pickerBackdrop =
      dom.window.document.querySelector('[role="dialog"]')?.parentElement;
    assert.ok(pickerBackdrop);
    await act(async () => {
      pickerBackdrop.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape"
        })
      );
    });
    assert.equal(pickerCloseCount, 0);
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(
        'button[aria-label="actions.cancel"]'
      )?.disabled,
      true
    );

    const focusedFolderNode = folder("focused-folder", "Focused folder");
    const fileNode = file("workspace-file", "Workspace file");
    const createdDirectoryParents: Array<ReferenceNode | null> = [];
    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = {
      ...createFolderOnlyView(folderNode),
      canCreateDirectory: true,
      capabilities: { directoryCreatable: true, filterable: false },
      currentEntries: [folderNode, fileNode],
      createDirectory: async (parent: ReferenceNode | null) => {
        createdDirectoryParents.push(parent);
        return folderNode;
      },
      focusedNode: focusedFolderNode
    };
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          fileManagerCopy: { t: (key: string) => key },
          onClose() {},
          onConfirm() {},
          open: true,
          purpose: "directory",
          workspaceId: "workspace-directory-context-menu-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    const folderLabel = Array.from(
      dom.window.document.querySelectorAll("[data-autofit-label]")
    ).find((element) => element.textContent === "Workspace folder");
    const folderRow = folderLabel?.closest("div");
    assert.ok(folderRow);
    await act(async () => {
      folderRow.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 48,
          clientY: 64
        })
      );
    });

    const contextCreateDirectoryButton = dom.window.document.querySelector(
      '[data-testid="context-create-directory"]'
    );
    assert.ok(contextCreateDirectoryButton);
    await act(async () => {
      contextCreateDirectoryButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });
    assert.equal(
      dom.window.document.querySelector(
        '[data-testid="reference-context-menu"]'
      ),
      null
    );
    assert.ok(
      dom.window.document.querySelector(
        '[data-testid="create-directory-dialog"]'
      )
    );

    const setDirectoryNameButton = dom.window.document.querySelector(
      '[data-testid="set-directory-name"]'
    );
    assert.ok(setDirectoryNameButton);
    await act(async () => {
      setDirectoryNameButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });
    const confirmCreateDirectoryButton = dom.window.document.querySelector(
      '[data-testid="confirm-create-directory"]'
    );
    assert.ok(confirmCreateDirectoryButton);
    await act(async () => {
      confirmCreateDirectoryButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });
    assert.deepEqual(createdDirectoryParents, [folderNode]);

    const fileLabel = Array.from(
      dom.window.document.querySelectorAll("[data-autofit-label]")
    ).find((element) => element.textContent === "Workspace file");
    const fileRow = fileLabel?.closest("div");
    assert.ok(fileRow);
    await act(async () => {
      fileRow.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", { bubbles: true })
      );
    });
    assert.equal(
      dom.window.document.querySelector(
        '[data-testid="reference-context-menu"]'
      ),
      null
    );

    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = createFolderOnlyView(folderNode);
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          fileManagerCopy: { t: (key: string) => key },
          onClose() {},
          onConfirm() {},
          open: true,
          purpose: "directory",
          workspaceId: "workspace-directory-context-menu-disabled-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });
    const disabledFolderLabel = Array.from(
      dom.window.document.querySelectorAll("[data-autofit-label]")
    ).find((element) => element.textContent === "Workspace folder");
    const disabledFolderRow = disabledFolderLabel?.closest("div");
    assert.ok(disabledFolderRow);
    await act(async () => {
      disabledFolderRow.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", { bubbles: true })
      );
    });
    assert.equal(
      dom.window.document.querySelector(
        '[data-testid="reference-context-menu"]'
      ),
      null
    );

    const opaqueNodeId = "f:L3dvcmtzcGFjZS8xMTEubWQ";
    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = {
      ...createFolderOnlyView(folderNode),
      currentEntries: [],
      isQuery: true,
      searchQuery: "111",
      searchResults: [file(opaqueNodeId, "111.md")]
    };
    await act(async () => {
      root?.render(
        createElement(ReferenceSourcePicker, {
          aggregator: {},
          copy: createCopy(),
          onClose() {},
          onConfirm() {},
          open: true,
          workspaceId: "workspace-reference-opaque-node-id-test"
        } as unknown as ReferenceSourcePickerProps)
      );
    });

    const searchBodyText = dom.window.document.body.textContent ?? "";
    assert.match(searchBodyText, /111\.md/);
    assert.doesNotMatch(searchBodyText, new RegExp(opaqueNodeId));
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.Node = previousNode;
    globalThis.Element = previousElement;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    (
      globalThis as { __referenceSourcePickerView?: unknown }
    ).__referenceSourcePickerView = previousView;
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function buildReferenceSourcePickerRenderModule(tempDir: string): string {
  const uiSystemUrl = writeMock(
    tempDir,
    "ui-system.mjs",
    `
      import { createElement, isValidElement } from "react";
      const h = createElement;
      function cleanProps(props = {}) {
        const {
          asChild,
          children,
          delayDuration,
          defaultLayout,
          defaultSize,
          disableDoubleClick,
          imageAlt,
          imageFrameClassName,
          loadingIndicator,
          loadingMessage,
          messageClassName,
          minSize,
          orientation,
          panelRef,
          renderIcon,
          textClassName,
          textFrameClassName,
          viewportProps,
          withHandle,
          ...rest
        } = props;
        return rest;
      }
      function passthrough(tag) {
        return function MockComponent(props = {}) {
          return h(tag, cleanProps(props), props.children);
        };
      }
      function icon(name) {
        return function MockIcon(props = {}) {
          return h("svg", { ...cleanProps(props), "data-icon": name });
        };
      }
      export function cn(...values) {
        return values.flat().filter(Boolean).join(" ");
      }
      export const Badge = passthrough("span");
      export const Button = passthrough("button");
      export const Card = passthrough("section");
      export const CardContent = passthrough("div");
      export const CardHeader = passthrough("div");
      export const CardTitle = passthrough("h2");
      export function Input(props = {}) {
        return h("input", cleanProps(props));
      }
      export function ResizableHandle(props = {}) {
        return h("div", cleanProps(props));
      }
      export function ResizablePanel(props = {}) {
        if (typeof props.panelRef === "function") {
          props.panelRef({ resize() {} });
        }
        return h("div", cleanProps(props), props.children);
      }
      export const ResizablePanelGroup = passthrough("div");
      export function ScrollArea(props = {}) {
        return h("div", cleanProps(props), h("div", props.viewportProps ?? {}, props.children));
      }
      export const Tooltip = passthrough("span");
      export function TooltipContent(props = {}) {
        return h("span", cleanProps(props), props.children);
      }
      export function TooltipTrigger(props = {}) {
        return props.asChild && isValidElement(props.children)
          ? props.children
          : h("span", cleanProps(props), props.children);
      }
      export const ArrowRightIcon = icon("arrow-right");
      export const CheckIcon = icon("check");
      export const ChevronDownIcon = icon("chevron-down");
      export const CloseIcon = icon("close");
      export const FolderFilledIcon = icon("folder-filled");
      export const IssueIcon = icon("issue");
      export const SearchIcon = icon("search");
      export const Spinner = icon("spinner");
    `
  );
  const iconsUrl = writeMock(
    tempDir,
    "icons.mjs",
    `
      import { createElement } from "react";
      export function AddLinedIcon(props = {}) {
        return createElement("svg", { ...props, "data-icon": "add-lined" });
      }
      export function WarningLinedIcon(props = {}) {
        return createElement("svg", { ...props, "data-icon": "warning-lined" });
      }
    `
  );
  const reactHooksUrl = writeMock(
    tempDir,
    "ui-react-hooks.mjs",
    `
      export function useComposedInputValue({ value }) {
        return {
          value: value ?? "",
          onBlur() {},
          onChange() {},
          onCompositionEnd() {},
          onCompositionStart() {}
        };
      }
    `
  );
  const filePreviewUrl = writeMock(
    tempDir,
    "file-preview.mjs",
    `
      import { createElement } from "react";
      export function WorkspaceFilePreviewSurface({ emptyMessage }) {
        return createElement("div", null, emptyMessage);
      }
    `
  );
  const fileManagerUrl = writeMock(
    tempDir,
    "file-manager.mjs",
    `
      import { createElement } from "react";
      export function WorkspaceFileEntryIcon({ entry, frameClassName }) {
        if (entry.kind === "directory") {
          return createElement(
            "span",
            { className: frameClassName },
            createElement("img", {
              alt: "",
              src: "/assets/workspace-folder-fallback.png"
            })
          );
        }
        return createElement("span", { className: frameClassName });
      }
      export function WorkspaceFileManagerContextMenu({
        contextMenu,
        copy,
        onClose,
        onCreateDirectory,
        showCreateDirectoryAction
      }) {
        if (!contextMenu) {
          return null;
        }
        return createElement(
          "div",
          { "data-testid": "reference-context-menu" },
          showCreateDirectoryAction && contextMenu.entry?.kind === "directory"
            ? createElement(
                "button",
                {
                  "data-testid": "context-create-directory",
                  type: "button",
                  onClick() {
                    onClose();
                    onCreateDirectory();
                  }
                },
                copy.t("createDirectoryLabel")
              )
            : null
        );
      }
      export function WorkspaceFileManagerCreateDialog({
        copy,
        dialog,
        onClose,
        onConfirm,
        onNameChange
      }) {
        if (!dialog) {
          return null;
        }
        return createElement(
          "div",
          { "data-testid": "create-directory-dialog" },
          createElement(
            "button",
            {
              "data-testid": "set-directory-name",
              type: "button",
              onClick() {
                onNameChange("child");
              }
            },
            "set-name"
          ),
          createElement(
            "button",
            {
              "data-testid": "cancel-create-directory",
              type: "button",
              onClick: onClose
            },
            copy.t("cancelLabel")
          ),
          createElement(
            "button",
            {
              "data-testid": "confirm-create-directory",
              type: "button",
              onClick: onConfirm
            },
            copy.t("createActionLabel")
          )
        );
      }
      export function resolveRevealInFolderLabel() {
        return "Reveal in Folder";
      }
      export function useWorkspaceFileEntryIconUrls() {
        return {
          iconUrlByCacheKey: new Map(),
          reportEntryIconViewportEnter() {},
          reportEntryIconViewportLeave() {}
        };
      }
    `
  );
  const coreUrl = writeMock(
    tempDir,
    "core.mjs",
    `
      export function base64UrlDecode(value) {
        return Buffer.from(value, "base64url").toString("utf8");
      }
      export function nodeRefKey(ref) {
        return ref.sourceId + ":" + ref.nodeId;
      }
    `
  );
  const viewUrl = writeMock(
    tempDir,
    "view.mjs",
    `
      export function useReferenceSourcePickerView() {
        return globalThis.__referenceSourcePickerView;
      }
    `
  );
  const presentationUrl = writeMock(
    tempDir,
    "presentation.mjs",
    `
      export function formatReferenceNodePathText(node) {
        return node.ref.nodeId;
      }
      export function formatReferencePreviewDateTime(value) {
        return String(value);
      }
      export function resolveReferencePreviewSizeBytes(node) {
        return node.sizeBytes ?? null;
      }
      export function resolveReferencePreviewTimestampMs(node) {
        return node.mtimeMs ?? node.createdTimeMs ?? null;
      }
    `
  );

  const componentSource = readFileSync(
    new URL("./ReferenceSourcePicker.tsx", import.meta.url),
    "utf8"
  )
    .replace(
      /import \{ useComposedInputValue \} from "@tutti-os\/ui-react-hooks";/,
      `import { useComposedInputValue } from "${reactHooksUrl}";`
    )
    .replace(
      /import \{\s*ArrowRightIcon[\s\S]*?\} from "@tutti-os\/ui-system";/,
      `import {
        ArrowRightIcon,
        Badge,
        Button,
        Card,
        CardContent,
        CardHeader,
        CardTitle,
        CheckIcon,
        ChevronDownIcon,
        CloseIcon,
        FolderFilledIcon,
        Input,
        IssueIcon,
        ResizableHandle,
        ResizablePanel,
        ResizablePanelGroup,
        ScrollArea,
        SearchIcon,
        Spinner,
        Tooltip,
        TooltipContent,
        TooltipTrigger,
        cn
      } from "${uiSystemUrl}";`
    )
    .replace(
      /import \{\s*AddLinedIcon,\s*WarningLinedIcon\s*\} from "@tutti-os\/ui-system\/icons";/,
      `import { AddLinedIcon, WarningLinedIcon } from "${iconsUrl}";`
    )
    .replace(
      /import \{\s*WorkspaceFilePreviewSurface[\s\S]*?\} from "@tutti-os\/workspace-file-preview\/react";/,
      `import { WorkspaceFilePreviewSurface } from "${filePreviewUrl}";`
    )
    .replace(
      /import \{\s*WorkspaceFileEntryIcon[\s\S]*?\} from "@tutti-os\/workspace-file-manager";/,
      `import {
        WorkspaceFileEntryIcon,
        WorkspaceFileManagerCreateDialog,
        WorkspaceFileManagerContextMenu,
        resolveRevealInFolderLabel,
        useWorkspaceFileEntryIconUrls
      } from "${fileManagerUrl}";`
    )
    .replace(
      new RegExp(
        'import \\{\\s*base64UrlDecode[\\s\\S]*?\\} from "../../../core/index\\.ts";'
      ),
      `import { base64UrlDecode, nodeRefKey } from "${coreUrl}";`
    )
    .replace(
      new RegExp(
        'import \\{\\s*useReferenceSourcePickerView[\\s\\S]*?\\} from "../../../react/internal/reference/useReferenceSourcePickerView\\.ts";'
      ),
      `import { useReferenceSourcePickerView } from "${viewUrl}";`
    )
    .replace(
      /import \{\s*formatReferenceNodePathText[\s\S]*?\} from "\.\/referenceSourcePickerPresentation\.ts";/,
      `import {
        formatReferenceNodePathText,
        formatReferencePreviewDateTime,
        resolveReferencePreviewSizeBytes,
        resolveReferencePreviewTimestampMs
      } from "${presentationUrl}";`
    );

  const transpiled = ts.transpileModule(componentSource, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true
    },
    fileName: "ReferenceSourcePicker.tsx"
  }).outputText;
  const modulePath = join(tempDir, "ReferenceSourcePicker.rendered.mjs");
  writeFileSync(modulePath, transpiled);
  return pathToFileURL(modulePath).href;
}

function writeMock(tempDir: string, fileName: string, source: string): string {
  const filePath = join(tempDir, fileName);
  writeFileSync(filePath, source);
  return pathToFileURL(filePath).href;
}

function createFolderOnlyView(node: ReferenceNode) {
  return {
    activeFilters: [],
    activeTabLabel: "Workspace",
    breadcrumb: [],
    capabilities: { filterable: false },
    canCreateDirectory: false,
    childrenByKey: {},
    confirm: async () => {},
    contentError: null,
    currentEntries: [node],
    createDirectory: async () => node,
    expandedKeys: {},
    filterCategories: [],
    focusedNode: null,
    getCachedOpenWithApplications: () => null,
    hasMore: false,
    isConfirming: false,
    isLoading: false,
    isLoadingMore: false,
    isLoadingTabs: false,
    isOpeningReference: false,
    isQuery: false,
    isSelectable: () => true,
    isSelected: () => false,
    listOpenWithApplications: async () => [],
    loadMore: () => {},
    loadMoreSidebarGroups: () => {},
    openNode: async () => {},
    openWithApplication: async () => {},
    openWithOtherApplication: async () => {},
    previewState: { status: "empty" },
    revealNode: async () => {},
    searchQuery: "",
    searchResults: [],
    selectGroup: () => {},
    selectedGroupKey: "workspace:root",
    selection: [],
    selectionCount: 0,
    setFilters: () => {},
    setFocusedNode: () => {},
    setSearchQuery: () => {},
    sidebarGroupsBySource: {},
    sidebarHasMoreBySource: {},
    sidebarLoadingMoreBySource: {},
    sortNodes: (nodes: readonly ReferenceNode[]) => nodes,
    tabs: [
      {
        capabilities: { paginated: false, previewable: true, searchable: true },
        label: "Workspace",
        sourceId: "workspace"
      }
    ],
    toggleNode: () => {},
    toggleSelection: () => {},
    toggleSingleSelectionAndExpand: () => {}
  };
}

function createCopy(): ReferenceSourcePickerProps["copy"] {
  return {
    t(key, params) {
      if (key === "referencePicker.selectedCount") {
        return String(params?.count ?? 0);
      }
      return key;
    }
  };
}

function folder(nodeId: string, displayName: string): ReferenceNode {
  return {
    displayName,
    hasChildren: true,
    kind: "folder",
    ref: { nodeId, sourceId: "workspace" }
  };
}

function file(nodeId: string, displayName: string): ReferenceNode {
  return {
    displayName,
    hasChildren: false,
    kind: "file",
    ref: { nodeId, sourceId: "workspace" }
  };
}
