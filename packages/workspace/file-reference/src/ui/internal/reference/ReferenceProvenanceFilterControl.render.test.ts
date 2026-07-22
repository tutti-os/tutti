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
  const longMemberLabel = "Alice with a very long display name";
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
        {
          id: "codex",
          label: `${longMemberLabel} · Codex`,
          parentMemberId: "member-1"
        },
        { disabled: true, id: "cursor", label: "Cursor" }
      ],
      enabledDimensions: ["agent", "member"],
      labels: {
        agents: "Agents",
        allAgents: "All agents",
        members: "Members",
        allMembers: "All members",
        allSources: "All sources",
        filteredSources: "Filtered sources",
        reset: "Reset"
      },
      memberOptions: [{ id: "member-1", label: longMemberLabel }],
      popoverElevation: "panel",
      onReset() {},
      onToggle(_dimension, id) {
        calls.push(id);
      },
      onToggleAll(dimension) {
        calls.push(`all:${dimension}`);
      },
      value: { agentTargetIds: ["codex"], memberIds: null }
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
    const resetButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button")
    ].find((element) => element.textContent === "Reset");
    const filterTrigger = dom.window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Filtered sources"]'
    );
    assert.ok(resetButton);
    assert.ok(filterTrigger);
    assert.match(filterTrigger.className, /(?:^|\s)border-0(?:\s|$)/);
    assert.doesNotMatch(
      filterTrigger.className,
      /border-\[var\(--border-focus\)\]/
    );
    assert.ok(
      resetButton.compareDocumentPosition(filterTrigger) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING
    );
    const popover = dom.window.document.querySelector<HTMLElement>(".nodrag");
    assert.ok(popover);
    assert.equal(popover.style.zIndex, "var(--z-panel-popover)");

    const allAgentsRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        '[role="menuitemcheckbox"]'
      )
    ].find((element) => element.textContent === "All agents");
    assert.ok(allAgentsRow);
    assert.equal(allAgentsRow.getAttribute("aria-checked"), "mixed");
    await act(async () => {
      allAgentsRow.click();
    });

    const codexRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        '[role="menuitemcheckbox"]'
      )
    ].find((element) => element.textContent === `${longMemberLabel} · Codex`);
    assert.ok(codexRow);
    const agentOwner = codexRow.querySelector<HTMLElement>(
      '[data-slot="reference-provenance-option-owner"]'
    );
    const agentSuffix = codexRow.querySelector<HTMLElement>(
      '[data-slot="reference-provenance-option-agent"]'
    );
    const agentLabel = codexRow.querySelector<HTMLElement>(
      '[data-slot="reference-provenance-option-label"]'
    );
    assert.ok(agentOwner);
    assert.ok(agentSuffix);
    assert.ok(agentLabel);
    assert.match(agentOwner.className, /(?:^|\s)shrink(?:\s|$)/);
    assert.doesNotMatch(agentOwner.className, /(?:^|\s)flex-1(?:\s|$)/);
    assert.match(agentOwner.className, /(?:^|\s)truncate(?:\s|$)/);
    assert.match(agentSuffix.className, /(?:^|\s)shrink-0(?:\s|$)/);
    assert.match(agentSuffix.className, /(?:^|\s)whitespace-pre(?:\s|$)/);
    assert.equal(agentSuffix.textContent, " · Codex");
    assert.equal(agentLabel.title, `${longMemberLabel} · Codex`);
    await act(async () => {
      codexRow.click();
    });

    const membersTab = [
      ...dom.window.document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find((element) => element.textContent === "Members");
    assert.ok(membersTab);
    await act(async () => {
      membersTab.click();
    });

    const allMembersRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        '[role="menuitemcheckbox"]'
      )
    ].find((element) => element.textContent === "All members");
    assert.ok(allMembersRow);
    await act(async () => {
      allMembersRow.click();
    });

    const memberRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        '[role="menuitemcheckbox"]'
      )
    ].find((element) => element.textContent === longMemberLabel);
    assert.ok(memberRow);
    const memberLabel = memberRow.querySelector<HTMLElement>(
      '[data-slot="reference-provenance-option-text"]'
    );
    assert.ok(memberLabel);
    assert.match(memberLabel.className, /(?:^|\s)block(?:\s|$)/);
    assert.match(memberLabel.className, /(?:^|\s)truncate(?:\s|$)/);
    await act(async () => {
      memberRow.click();
    });

    assert.deepEqual(calls, ["all:agent", "codex", "all:member", "member-1"]);

    const agentsTab = [
      ...dom.window.document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find((element) => element.textContent === "Agents");
    assert.ok(agentsTab);
    await act(async () => {
      agentsTab.click();
    });

    await act(async () => {
      root?.render(
        renderControl({
          ...props,
          showDisabledOptions: true
        })
      );
    });

    const cursorRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        '[role="menuitemcheckbox"]'
      )
    ].find((element) => element.textContent === "Cursor");
    assert.ok(cursorRow);
    assert.equal(cursorRow.getAttribute("aria-disabled"), "true");
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
          disabled,
          modal,
          onCheckedChange,
          onSelect,
          onValueChange,
          preventMouseDownDefault,
          side,
          sideOffset,
          size,
          tabs,
          value,
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
      export function ChevronDownIcon(props = {}) {
        return h("svg", cleanProps(props));
      }
      export const DropdownMenu = passthrough("div");
      export const DropdownMenuContent = passthrough("div");
      export const DropdownMenuGroup = passthrough("div");
      export function DropdownMenuTrigger(props = {}) {
        return props.asChild && isValidElement(props.children)
          ? props.children
          : h("span", cleanProps(props), props.children);
      }
      export function DropdownMenuCheckboxItem(props = {}) {
        const { checked, disabled, onCheckedChange } = props;
        return h("div", {
          ...cleanProps(props),
          "aria-checked": checked === "indeterminate" ? "mixed" : checked,
          "aria-disabled": disabled || undefined,
          role: "menuitemcheckbox",
          onClick: disabled ? undefined : () => onCheckedChange?.(!checked)
        }, props.children);
      }
      export function UnderlineTabs(props = {}) {
        return h("div", { role: "tablist" }, props.tabs.map((tab) =>
          h("button", {
            key: tab.value,
            "aria-selected": props.value === tab.value,
            role: "tab",
            type: "button",
            onClick: () => props.onValueChange(tab.value)
          }, tab.label)
        ));
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
        ChevronDownIcon,
        DropdownMenu,
        DropdownMenuCheckboxItem,
        DropdownMenuContent,
        DropdownMenuGroup,
        DropdownMenuTrigger,
        UnderlineTabs,
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
