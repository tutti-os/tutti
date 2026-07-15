import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ReferenceProvenanceFilterControlProps } from "./ReferenceProvenanceFilterControl.tsx";

type JsdomModule = {
  JSDOM: new (html: string) => {
    window: Window & typeof globalThis;
  };
};
type TypeScriptModule = typeof import("typescript");

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;
const ts = require("typescript") as TypeScriptModule;

test("provenance filter handles row clicks and disabled option visibility", async () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const tempDir = mkdtempSync(join(moduleDir, ".filter-render-test-"));
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
    const componentModuleUrl = buildFilterControlRenderModule(tempDir);
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Node = dom.window.Node;
    globalThis.Element = dom.window.Element;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const calls: string[] = [];
    const { ReferenceProvenanceFilterControl } = (await import(
      componentModuleUrl
    )) as {
      ReferenceProvenanceFilterControl: (
        props: ReferenceProvenanceFilterControlProps
      ) => React.ReactElement | null;
    };
    const container = dom.window.document.getElementById("root");
    assert.ok(container);

    const props: ReferenceProvenanceFilterControlProps = {
      agentOptions: [
        { id: "codex", label: "Codex" },
        { disabled: true, id: "cursor", label: "Cursor" }
      ],
      enabledDimensions: ["agent"],
      labels: {
        agents: "Agents",
        allAgents: "All agents",
        members: "Members",
        allMembers: "All members",
        allSources: "All sources",
        filteredSources: "Filtered sources",
        reset: "Reset"
      },
      memberOptions: [],
      onReset() {},
      onToggle(_dimension, id) {
        calls.push(id);
      },
      onToggleAll(dimension) {
        calls.push(`all:${dimension}`);
      },
      value: { agentTargetIds: null, memberIds: null }
    };
    const renderControl = (nextProps: ReferenceProvenanceFilterControlProps) =>
      createElement(
        "div",
        {
          onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
            if (
              event.target instanceof Element &&
              !event.target.closest(".nodrag")
            ) {
              event.stopPropagation();
            }
          }
        },
        createElement(ReferenceProvenanceFilterControl, nextProps)
      );

    root = createRoot(container);
    await act(async () => {
      root?.render(renderControl(props));
    });

    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Cursor/);
    assert.ok(dom.window.document.querySelector(".nodrag"));

    const allAgentsLabel = [
      ...dom.window.document.querySelectorAll("span")
    ].find((element) => element.textContent === "All agents");
    assert.ok(allAgentsLabel);
    await act(async () => {
      allAgentsLabel.click();
    });

    const codexLabel = [...dom.window.document.querySelectorAll("span")].find(
      (element) => element.textContent === "Codex"
    );
    assert.ok(codexLabel);
    await act(async () => {
      codexLabel.click();
    });

    assert.deepEqual(calls, ["all:agent", "codex"]);

    await act(async () => {
      root?.render(
        renderControl({
          ...props,
          showDisabledOptions: true
        })
      );
    });

    const cursorLabel = [...dom.window.document.querySelectorAll("span")].find(
      (element) => element.textContent === "Cursor"
    );
    assert.ok(cursorLabel);
    assert.equal(
      cursorLabel.closest('[role="checkbox"]')?.getAttribute("aria-disabled"),
      "true"
    );
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

function buildFilterControlRenderModule(tempDir: string): string {
  const uiSystemUrl = writeMock(
    tempDir,
    "ui-system.mjs",
    `
      import { createElement, isValidElement } from "react";
      const h = createElement;
      function cleanProps(props = {}) {
        const {
          align,
          asChild,
          checked,
          children,
          side,
          size,
          variant,
          ...rest
        } = props;
        return rest;
      }
      function passthrough(tag) {
        return function MockComponent(props = {}) {
          return h(tag, cleanProps(props), props.children);
        };
      }
      export function cn(...values) {
        return values.flat().filter(Boolean).join(" ");
      }
      export const Button = passthrough("button");
      export function Checkbox(props = {}) {
        return h("button", {
          ...cleanProps(props),
          "data-checked": String(props.checked)
        });
      }
      export function ChevronDownIcon(props = {}) {
        return h("svg", cleanProps(props));
      }
      export const Popover = passthrough("div");
      export const PopoverContent = passthrough("div");
      export function PopoverTrigger(props = {}) {
        return props.asChild && isValidElement(props.children)
          ? props.children
          : h("span", cleanProps(props), props.children);
      }
    `
  );
  const coreUrl = writeMock(
    tempDir,
    "reference-provenance.mjs",
    `
      export function referenceProvenanceFilterIds(value, dimension) {
        return dimension === "agent" ? value.agentTargetIds : value.memberIds;
      }
      export function referenceProvenanceFilterIsActive(value) {
        return value.agentTargetIds !== null || value.memberIds !== null;
      }
    `
  );

  const componentSource = readFileSync(
    new URL("./ReferenceProvenanceFilterControl.tsx", import.meta.url),
    "utf8"
  )
    .replace(
      /import \{\s*Button,[\s\S]*?\} from "@tutti-os\/ui-system";/,
      `import {
        Button,
        Checkbox,
        ChevronDownIcon,
        Popover,
        PopoverContent,
        PopoverTrigger,
        cn
      } from "${uiSystemUrl}";`
    )
    .replace(
      /import \{\s*referenceProvenanceFilterIds,[\s\S]*?\} from "\.\.\/\.\.\/\.\.\/core\/referenceProvenance\.ts";/,
      `import {
        referenceProvenanceFilterIds,
        referenceProvenanceFilterIsActive
      } from "${coreUrl}";`
    );

  const transpiled = ts.transpileModule(componentSource, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true
    },
    fileName: "ReferenceProvenanceFilterControl.tsx"
  }).outputText;
  const modulePath = join(
    tempDir,
    "ReferenceProvenanceFilterControl.rendered.mjs"
  );
  writeFileSync(modulePath, transpiled);
  return pathToFileURL(modulePath).href;
}

function writeMock(tempDir: string, fileName: string, source: string): string {
  const filePath = join(tempDir, fileName);
  writeFileSync(filePath, source);
  return pathToFileURL(filePath).href;
}
