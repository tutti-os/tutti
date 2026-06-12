import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readComponentSource(fileName: string) {
  const relativePath =
    fileName === "index.ts"
      ? fileName
      : `./${fileName.replace(/\.tsx$/, "")}/${fileName}`;

  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function readStyleSource(fileName: string) {
  return readFileSync(
    new URL(`../styles/${fileName}`, import.meta.url),
    "utf8"
  );
}

function readZIndexToken(source: string, token: string): number {
  const match = new RegExp(`${token}:\\s*(\\d+)`).exec(source);
  assert.ok(match?.[1], `${token} should be defined`);
  return Number.parseInt(match[1], 10);
}

test("button styling stays on the shared semantic token contract", () => {
  const source = readComponentSource("button.tsx");

  assert.match(source, /bg-\[var\(--state-danger\)\]/);
  assert.match(source, /text-\[var\(--white-stationary\)\]/);
  assert.match(source, /rounded-md/);
  assert.doesNotMatch(source, /shadow-soft/);
});

test("bare icon button stays background-free and density-scoped", () => {
  const source = readComponentSource("bare-icon-button.tsx");

  assert.match(source, /data-slot="bare-icon-button"/);
  assert.match(source, /"aria-label": string/);
  assert.match(source, /md: "size-6/);
  assert.match(source, /sm: "size-5/);
  assert.match(source, /text-\[var\(--text-tertiary\)\]/);
  assert.match(source, /hover:bg-transparent/);
  assert.match(source, /active:bg-transparent/);
  assert.match(source, /aria-expanded:bg-transparent/);
  assert.match(source, /focus-visible:bg-transparent/);
  assert.match(source, /hover:text-\[var\(--text-primary\)\]/);
  assert.doesNotMatch(source, /hover:bg-\[var\(--transparency-hover\)\]/);
  assert.doesNotMatch(source, /hover:bg-transparency-hover/);
  assert.doesNotMatch(source, /bg-\[var\(--transparency-block\)\]/);
  assert.doesNotMatch(source, /active:bg-\[var\(--transparency-active\)\]/);
});

test("badge styling stays subtle instead of using primary fills", () => {
  const source = readComponentSource("badge.tsx");

  assert.match(source, /rounded-\[4px\]/);
  assert.match(source, /px-1/);
  assert.match(source, /bg-\[var\(--transparency-block\)\]/);
  assert.match(source, /text-\[var\(--text-secondary\)\]/);
  assert.match(source, /bg-\[var\(--accent-bg\)\]/);
  assert.match(source, /text-\[var\(--accent\)\]/);
  assert.match(
    source,
    /bg-\[color-mix\(in_srgb,var\(--state-success\)_10%,transparent\)\]/
  );
  assert.match(source, /text-\[var\(--state-success\)\]/);
  assert.match(
    source,
    /bg-\[color-mix\(in_srgb,var\(--state-warning\)_12%,transparent\)\]/
  );
  assert.match(source, /text-\[var\(--state-warning\)\]/);
  assert.match(
    source,
    /bg-\[color-mix\(in_srgb,var\(--rich-text-mention-issue\)_12%,transparent\)\]/
  );
  assert.match(source, /text-\[var\(--rich-text-mention-issue\)\]/);
  assert.doesNotMatch(source, /px-2/);
  assert.doesNotMatch(source, /bg-primary text-primary-foreground/);
});

test("field controls use the shared transparency field surface", () => {
  const inputSource = readComponentSource("input.tsx");
  assert.match(inputSource, /bg-\[var\(--transparency-block\)\]/);
  assert.match(inputSource, /rounded-\[6px\]/);
  assert.doesNotMatch(inputSource, /border border-input bg-transparent/);

  const menuSurfaceSource = readComponentSource("menu-surface.tsx");
  assert.match(menuSurfaceSource, /menuItemWithIndicatorClassName/);
  assert.match(menuSurfaceSource, /bg-\[var\(--transparency-hover\)\]/);
  assert.match(menuSurfaceSource, /text-\[var\(--text-primary\)\]/);
  assert.match(
    menuSurfaceSource,
    /menuItemIndicatorClassName[\s\S]*text-\[var\(--tutti-purple\)\]/
  );
  assert.doesNotMatch(
    menuSurfaceSource,
    /menuItemIndicatorClassName[\s\S]*text-\[var\(--accent\)\]/
  );
  assert.doesNotMatch(
    menuSurfaceSource,
    /menuItemIndicatorClassName[\s\S]*text-\[var\(--text-primary\)\]/
  );
  assert.doesNotMatch(menuSurfaceSource, /text-foreground/);
  assert.doesNotMatch(menuSurfaceSource, /text-muted-foreground/);

  const selectSource = readComponentSource("select.tsx");
  assert.match(selectSource, /MenuSurface/);
  assert.match(selectSource, /menuItemWithIndicatorClassName/);
  assert.match(selectSource, /menuItemIndicatorClassName/);
  assert.match(
    selectSource,
    /CheckIcon[\s\S]*className="pointer-events-none text-\[var\(--tutti-purple\)\]"/
  );
  assert.match(selectSource, /rounded-lg/);
  assert.match(selectSource, /bg-\[var\(--transparency-block\)\]/);
  assert.match(selectSource, /hover:bg-\[var\(--transparency-hover\)\]/);
  assert.match(
    selectSource,
    /data-placeholder:text-\[var\(--text-placeholder\)\]/
  );
  assert.match(selectSource, /text-\[var\(--text-primary\)\]/);
  assert.doesNotMatch(selectSource, /data-\[state=checked\]:bg-transparent/);
  assert.doesNotMatch(selectSource, /text-foreground/);
  assert.doesNotMatch(selectSource, /text-muted-foreground/);
  assert.doesNotMatch(selectSource, /rounded-md py-1 pr-9 pl-3/);
  assert.doesNotMatch(selectSource, /dark:bg-input/);
  assert.doesNotMatch(selectSource, /dark:hover:bg-input/);
  assert.doesNotMatch(selectSource, /shadow-soft/);
});

test("Chinese language contexts use the CJK font stack and medium weights", () => {
  const themeSource = readStyleSource("theme.css");
  const baseSource = readStyleSource("base.css");

  assert.match(themeSource, /--font-sans-cjk:/);
  assert.match(themeSource, /"PingFang SC"/);
  assert.match(themeSource, /--font-weight-regular:\s*400/);
  assert.match(themeSource, /--font-weight-regular-cjk:\s*400/);
  assert.match(themeSource, /--font-weight-emphasis-cjk:\s*500/);
  assert.match(themeSource, /--accent-codex:\s*rgb\(65 130 245\)/);
  assert.match(themeSource, /--accent-codex:\s*rgb\(79 143 255\)/);
  assert.match(themeSource, /--accent:\s*var\(--accent-codex\)/);
  assert.match(
    themeSource,
    /--accent-codex-border:\s*color-mix\(\s*in srgb,\s*var\(--accent-codex\) 20%,\s*transparent\s*\)/
  );
  assert.match(themeSource, /--status-running:\s*rgb\(65 130 245\)/);
  assert.match(themeSource, /--status-running:\s*rgb\(79 143 255\)/);
  assert.match(themeSource, /--tutti-purple:\s*rgb\(109 127 245\)/);
  assert.match(themeSource, /--tutti-purple:\s*rgb\(136 152 255\)/);
  assert.match(
    themeSource,
    /:root\s*\{[\s\S]*?--tutti-purple:\s*rgb\(109 127 245\)/
  );
  assert.match(
    themeSource,
    /:root\[data-theme="dark"\]\s*\{[\s\S]*?--tutti-purple:\s*rgb\(136 152 255\)/
  );
  assert.match(
    themeSource,
    /--tutti-purple-border:\s*color-mix\(\s*in srgb,\s*var\(--tutti-purple\) 20%,\s*transparent\s*\)/
  );
  assert.match(
    themeSource,
    /--rich-text-mention-issue:\s*var\(--tutti-purple\)/
  );
  assert.match(themeSource, /--accent-claude:\s*rgb\(251 111 62\)/);
  assert.match(themeSource, /--folder:\s*rgb\(80, 175, 238\)/);
  assert.match(themeSource, /--border-focus:\s*rgb\(65 130 245 \/ 24%\)/);
  assert.match(themeSource, /--border-focus:\s*rgb\(79 143 255 \/ 24%\)/);
  assert.match(themeSource, /--line-focus-window:\s*rgb\(255 255 255 \/ 20%\)/);
  assert.match(
    themeSource,
    /--workbench-window-elevation:\s*0 18px 44px rgb\(0 0 0 \/ 26%\)/
  );
  assert.match(themeSource, /--state-warning:\s*rgb\(234 121 8\)/);
  assert.match(themeSource, /--state-warning:\s*rgb\(251 146 60\)/);
  assert.match(themeSource, /--on-danger:\s*rgb\(220 38 38 \/ 8%\)/);
  assert.match(baseSource, /:lang\(zh\)/);
  assert.match(baseSource, /--font-sans-system:\s*var\(--font-sans-cjk\)/);
  assert.match(baseSource, /--font-sans:\s*var\(--font-sans-cjk\)/);
  assert.match(baseSource, /--font-ui:\s*var\(--font-sans-cjk\)/);
  assert.doesNotMatch(
    baseSource,
    /--font-weight-regular:\s*var\(--font-weight-regular-cjk\)/
  );
  assert.doesNotMatch(
    baseSource,
    /\.font-normal[\s\S]*--font-weight-regular-cjk/
  );
  assert.match(baseSource, /\.font-medium/);
  assert.match(baseSource, /\.font-semibold/);
  assert.match(baseSource, /font-weight:\s*var\(--font-weight-emphasis-cjk\)/);
  assert.match(baseSource, /\[data-slot="button"\]/);
  assert.match(
    baseSource,
    /:where\(:lang\(zh\), \[lang\^="zh"\]\)\[data-slot="button"\]/
  );
  assert.match(
    baseSource,
    /:where\(:lang\(zh\), \[lang\^="zh"\]\) :where\(\[data-slot="button"\]\)/
  );
  assert.match(baseSource, /\[data-slot="dialog-content"\]/);
  assert.match(baseSource, /\[data-slot="dialog-title"\]/);
  assert.match(baseSource, /font-weight:\s*500/);
});

test("global overlay tokens keep toasts above panels and tooltips above dialogs", () => {
  const themeSource = readStyleSource("theme.css");
  const popoverZ = readZIndexToken(themeSource, "--z-popover");
  const toastZ = readZIndexToken(themeSource, "--z-toast");
  const tooltipZ = readZIndexToken(themeSource, "--z-tooltip");
  const panelZ = readZIndexToken(themeSource, "--z-panel");
  const panelPopoverZ = readZIndexToken(themeSource, "--z-panel-popover");
  const dialogOverlayZ = readZIndexToken(themeSource, "--z-dialog-overlay");
  const dialogZ = readZIndexToken(themeSource, "--z-dialog");
  const dialogPopoverZ = readZIndexToken(themeSource, "--z-dialog-popover");

  assert.ok(popoverZ < panelZ);
  assert.ok(panelZ < panelPopoverZ);
  assert.ok(panelPopoverZ < toastZ);
  assert.ok(toastZ < dialogOverlayZ);
  assert.ok(dialogOverlayZ < dialogZ);
  assert.ok(dialogZ < dialogPopoverZ);
  assert.ok(panelPopoverZ < dialogPopoverZ);
  assert.ok(dialogPopoverZ < tooltipZ);
});

test("card, dialog, dropdown, and toast surfaces avoid raw visual drift", () => {
  const cardSource = readComponentSource("card.tsx");
  assert.match(cardSource, /rounded-lg/);
  assert.doesNotMatch(cardSource, /rounded-xl/);
  assert.doesNotMatch(cardSource, /shadow-soft/);

  for (const fileName of [
    "dialog.tsx",
    "confirmation-dialog.tsx",
    "dropdown-menu.tsx",
    "toast.tsx"
  ]) {
    const source = readComponentSource(fileName);

    assert.doesNotMatch(source, /shadow-\[/);
    assert.doesNotMatch(source, /bg-black\/12/);
    if (fileName === "dropdown-menu.tsx") {
      assert.match(
        source,
        /CheckIcon className="text-\[var\(--tutti-purple\)\]"/
      );
    }
  }
});
