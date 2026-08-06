import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type JsdomModule = {
  JSDOM: new (html: string) => {
    window: Window & typeof globalThis;
  };
};
type TypeScriptModule = typeof import("typescript");

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;
const ts = require("typescript") as TypeScriptModule;

test("reference add control forwards dropdown trigger interactions", async () => {
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
  let root: Root | null = null;

  try {
    const componentModuleUrl = buildReferenceAddControlRenderModule(tempDir);
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Node = dom.window.Node;
    globalThis.Element = dom.window.Element;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const { WorkspaceReferenceAddControl } = (await import(
      componentModuleUrl
    )) as {
      WorkspaceReferenceAddControl: (props: {
        labels: {
          addContent: string;
          browseReferences: string;
          uploadFile: string;
        };
        onBrowseReferences: () => void;
        onUploadFile: () => void;
      }) => React.ReactElement;
    };
    const container = dom.window.document.getElementById("root");
    assert.ok(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(WorkspaceReferenceAddControl, {
          labels: {
            addContent: "Add content",
            browseReferences: "Browse files",
            uploadFile: "Upload file"
          },
          onBrowseReferences() {},
          onUploadFile() {}
        })
      );
    });

    const trigger = dom.window.document.querySelector("button");
    assert.ok(trigger);
    assert.equal(dom.window.document.querySelector('[role="menu"]'), null);

    await act(async () => {
      trigger.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true })
      );
    });

    const menu = dom.window.document.querySelector('[role="menu"]');
    assert.ok(menu);
    assert.match(menu.className, /w-max/);
    assert.match(menu.className, /whitespace-nowrap/);
    assert.match(menu.textContent ?? "", /Upload file/);
    assert.match(menu.textContent ?? "", /Browse files/);
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
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function buildReferenceAddControlRenderModule(tempDir: string): string {
  const uiSystemUrl = writeMock(
    tempDir,
    "ui-system.mjs",
    `
      import {
        cloneElement,
        createContext,
        createElement,
        forwardRef,
        isValidElement,
        useContext,
        useState
      } from "react";
      const h = createElement;
      const MenuContext = createContext(null);
      export const Button = forwardRef(function Button(
        { children, size, variant, ...props },
        ref
      ) {
        return h("button", { ...props, ref }, children);
      });
      export function DropdownMenu({ children }) {
        const [open, setOpen] = useState(false);
        return h(MenuContext.Provider, { value: { open, setOpen } }, children);
      }
      export function DropdownMenuTrigger({ asChild, children }) {
        const menu = useContext(MenuContext);
        if (asChild && isValidElement(children)) {
          return cloneElement(children, {
            "aria-expanded": menu.open,
            onPointerDown() {
              menu.setOpen(true);
            }
          });
        }
        return h("button", null, children);
      }
      export function DropdownMenuContent({ children, className }) {
        const menu = useContext(MenuContext);
        return menu.open
          ? h("div", { className, role: "menu" }, children)
          : null;
      }
      export function DropdownMenuItem({ children, onSelect }) {
        return h("button", { role: "menuitem", onClick: onSelect }, children);
      }
      function icon(name) {
        return function MockIcon(props = {}) {
          return h("svg", { ...props, "data-icon": name });
        };
      }
      export const AddLinedIcon = icon("add");
      export const FolderOpenLinedIcon = icon("folder-open");
      export const UploadIcon = icon("upload");
    `
  );
  const source = readFileSync(
    new URL("./WorkspaceReferenceAddControl.tsx", import.meta.url),
    "utf8"
  ).replace(/from "@tutti-os\/ui-system";/, `from "${uiSystemUrl}";`);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true
    },
    fileName: "WorkspaceReferenceAddControl.tsx"
  }).outputText;
  const modulePath = join(tempDir, "WorkspaceReferenceAddControl.rendered.mjs");
  writeFileSync(modulePath, transpiled);
  return pathToFileURL(modulePath).href;
}

function writeMock(tempDir: string, fileName: string, source: string): string {
  const filePath = join(tempDir, fileName);
  writeFileSync(filePath, source);
  return pathToFileURL(filePath).href;
}
